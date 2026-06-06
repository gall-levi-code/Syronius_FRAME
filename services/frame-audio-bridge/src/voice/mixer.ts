import type { SessionUser } from "../sessions/guildConfig";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_CHANNEL = (SAMPLE_RATE / 1_000) * FRAME_DURATION_MS;
const SAMPLES_PER_FRAME = SAMPLES_PER_CHANNEL * CHANNELS;
const BYTES_PER_SAMPLE = 2;
const FRAME_BYTES = SAMPLES_PER_FRAME * BYTES_PER_SAMPLE;
const JITTER_TARGET_FRAMES = 4;
const JITTER_MAX_FRAMES_PER_USER = 50;
const STALE_QUEUE_MS = 2_000;
const SOFT_LIMIT_THRESHOLD = 0.85;

export interface PcmAudioFrame {
  discordUserId: string;
  pcm: Buffer;
  sampleRate: typeof SAMPLE_RATE;
  channels: 1 | 2;
  receivedAt: number;
}

export interface MixedAudioChunk {
  pcm: Buffer;
  sampleRate: typeof SAMPLE_RATE;
  channels: typeof CHANNELS;
  createdAt: number;
}

export interface AudioMixerStats {
  receivedFrames: number;
  mixedChunks: number;
  droppedFrames: number;
  underruns: number;
  softLimitedSamples: number;
  queuedFrames: number;
  primedUsers: number;
}

interface UserAudioQueue {
  chunks: Buffer[];
  primed: boolean;
  lastFrameAt: number;
}

function clampSample(value: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}

function softLimitSample(value: number): { sample: number; limited: boolean } {
  const normalized = value / 32_768;
  const magnitude = Math.abs(normalized);

  if (magnitude <= SOFT_LIMIT_THRESHOLD) {
    return {
      sample: clampSample(value),
      limited: false,
    };
  }

  const overshoot = (magnitude - SOFT_LIMIT_THRESHOLD) / (1 - SOFT_LIMIT_THRESHOLD);
  const limitedMagnitude =
    SOFT_LIMIT_THRESHOLD + (1 - SOFT_LIMIT_THRESHOLD) * Math.tanh(overshoot);

  return {
    sample: clampSample(Math.sign(normalized) * limitedMagnitude * 32_767),
    limited: true,
  };
}

function clampVolume(value: number): number {
  return Math.max(0, Math.min(2, value));
}

export class AudioMixer {
  private readonly queuesByUserId = new Map<string, UserAudioQueue>();

  private readonly remaindersByUserId = new Map<string, Buffer>();

  private readonly stats: AudioMixerStats = {
    receivedFrames: 0,
    mixedChunks: 0,
    droppedFrames: 0,
    underruns: 0,
    softLimitedSamples: 0,
    queuedFrames: 0,
    primedUsers: 0,
  };

  public enqueue(frame: PcmAudioFrame): void {
    if (frame.sampleRate !== SAMPLE_RATE) {
      console.warn(
        `[mixer] Dropping ${frame.sampleRate}Hz frame from ${frame.discordUserId}; expected ${SAMPLE_RATE}Hz`,
      );
      this.stats.droppedFrames += 1;
      return;
    }

    const stereoPcm = frame.channels === 1 ? this.monoToStereo(frame.pcm) : frame.pcm;
    const previousRemainder = this.remaindersByUserId.get(frame.discordUserId);
    const pcm = previousRemainder ? Buffer.concat([previousRemainder, stereoPcm]) : stereoPcm;
    const queue = this.getQueue(frame.discordUserId, frame.receivedAt);

    let offset = 0;
    while (offset + FRAME_BYTES <= pcm.length) {
      queue.chunks.push(Buffer.from(pcm.subarray(offset, offset + FRAME_BYTES)));
      queue.lastFrameAt = frame.receivedAt;
      this.stats.receivedFrames += 1;
      offset += FRAME_BYTES;
    }

    if (offset < pcm.length) {
      this.remaindersByUserId.set(frame.discordUserId, Buffer.from(pcm.subarray(offset)));
    } else {
      this.remaindersByUserId.delete(frame.discordUserId);
    }

    if (queue.chunks.length >= JITTER_TARGET_FRAMES) {
      queue.primed = true;
    }

    if (queue.chunks.length > JITTER_MAX_FRAMES_PER_USER) {
      const dropped = queue.chunks.length - JITTER_MAX_FRAMES_PER_USER;
      queue.chunks.splice(0, dropped);
      this.stats.droppedFrames += dropped;
    }
  }

  public mixNextFrame(users: SessionUser[]): MixedAudioChunk | null {
    return this.mixNext(users);
  }

  public clear(): void {
    this.queuesByUserId.clear();
    this.remaindersByUserId.clear();
  }

  public getStats(): AudioMixerStats {
    let queuedFrames = 0;
    let primedUsers = 0;

    for (const queue of this.queuesByUserId.values()) {
      queuedFrames += queue.chunks.length;
      if (queue.primed) {
        primedUsers += 1;
      }
    }

    return {
      ...this.stats,
      queuedFrames,
      primedUsers,
    };
  }

  private mixNext(users: SessionUser[]): MixedAudioChunk | null {
    this.pruneStaleQueues();

    const userControls = new Map(users.map((user) => [user.discordUserId, user]));
    const queuedUserIds = [...this.queuesByUserId.entries()]
      .filter(([, queue]) => queue.primed && queue.chunks.length > 0)
      .map(([discordUserId]) => discordUserId);

    if (queuedUserIds.length === 0) {
      return null;
    }

    const mix = new Int32Array(SAMPLES_PER_FRAME);
    let hasAudibleSamples = false;

    for (const discordUserId of queuedUserIds) {
      const queue = this.queuesByUserId.get(discordUserId);
      const pcm = queue?.chunks.shift();
      if (!queue || !pcm) {
        this.stats.underruns += 1;
        continue;
      }

      if (queue.chunks.length === 0) {
        queue.primed = false;
      }

      const controls = userControls.get(discordUserId);
      const muted = controls?.muted ?? false;
      const volume = clampVolume(controls?.volume ?? 1);

      if (muted || volume === 0) {
        continue;
      }

      hasAudibleSamples = true;
      for (let sampleIndex = 0; sampleIndex < SAMPLES_PER_FRAME; sampleIndex += 1) {
        mix[sampleIndex] += pcm.readInt16LE(sampleIndex * BYTES_PER_SAMPLE) * volume;
      }
    }

    if (!hasAudibleSamples) {
      return null;
    }

    const output = Buffer.allocUnsafe(FRAME_BYTES);
    for (let sampleIndex = 0; sampleIndex < SAMPLES_PER_FRAME; sampleIndex += 1) {
      const limited = softLimitSample(mix[sampleIndex]);
      if (limited.limited) {
        this.stats.softLimitedSamples += 1;
      }

      output.writeInt16LE(limited.sample, sampleIndex * BYTES_PER_SAMPLE);
    }

    this.stats.mixedChunks += 1;

    return {
      pcm: output,
      sampleRate: SAMPLE_RATE,
      channels: CHANNELS,
      createdAt: Date.now(),
    };
  }

  private getQueue(discordUserId: string, now: number): UserAudioQueue {
    const existing = this.queuesByUserId.get(discordUserId);
    if (existing) {
      return existing;
    }

    const queue: UserAudioQueue = {
      chunks: [],
      primed: false,
      lastFrameAt: now,
    };
    this.queuesByUserId.set(discordUserId, queue);
    return queue;
  }

  private pruneStaleQueues(now = Date.now()): void {
    for (const [discordUserId, queue] of this.queuesByUserId) {
      if (queue.chunks.length === 0 && now - queue.lastFrameAt >= STALE_QUEUE_MS) {
        this.queuesByUserId.delete(discordUserId);
        this.remaindersByUserId.delete(discordUserId);
      }
    }
  }

  private monoToStereo(pcm: Buffer): Buffer {
    const output = Buffer.allocUnsafe(pcm.length * 2);
    const sampleCount = Math.floor(pcm.length / BYTES_PER_SAMPLE);

    for (let inputIndex = 0; inputIndex < sampleCount; inputIndex += 1) {
      const sample = pcm.readInt16LE(inputIndex * BYTES_PER_SAMPLE);
      const outputOffset = inputIndex * CHANNELS * BYTES_PER_SAMPLE;
      output.writeInt16LE(sample, outputOffset);
      output.writeInt16LE(sample, outputOffset + BYTES_PER_SAMPLE);
    }

    return output;
  }
}
