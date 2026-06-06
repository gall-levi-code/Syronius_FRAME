import {
  type DiscordGatewayAdapterCreator,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import type { Guild, User, VoiceBasedChannel } from "discord.js";
import type { SessionManager } from "../sessions/sessionManager";
import { DelayBuffer } from "./delayBuffer";
import {
  AudioMixer,
  type AudioMixerStats,
  type MixedAudioChunk,
  type PcmAudioFrame,
} from "./mixer";
import { DiscordAudioReceiver } from "./receiver";

const MIX_INTERVAL_MS = 20;
const AUDIO_STATS_INTERVAL_MS = 15_000;
const AUDIO_LEVEL_INTERVAL_MS = 120;
const EMPTY_CHANNEL_CHECK_INTERVAL_MS = 30_000;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface UserIdentity {
  discordUserId: string;
  displayName: string;
  avatarUrl: string;
}

interface ProfileAudioPipeline {
  mixer: AudioMixer;
  delayBuffer: DelayBuffer<MixedAudioChunk>;
  lastDelayMs: number | null;
}

interface GuildAudioPipeline {
  receiver: DiscordAudioReceiver;
  profilePipelinesByBridgeKey: Map<string, ProfileAudioPipeline>;
  timer: NodeJS.Timeout;
  statsTimer: NodeJS.Timeout;
  levelTimer: NodeJS.Timeout;
  levelsByUserId: Map<string, number>;
  lastStats: AudioMixerStats;
  lastStatsAt: number;
}

export class VoiceManager {
  private readonly connectionsByGuildId = new Map<string, VoiceConnection>();

  private readonly audioPipelinesByGuildId = new Map<string, GuildAudioPipeline>();

  private readonly channelIdsByGuildId = new Map<string, string>();

  private readonly guildsByGuildId = new Map<string, Guild>();

  private readonly emptySinceByGuildId = new Map<string, number>();

  private readonly emptyChannelTimer: NodeJS.Timeout;

  public constructor(private readonly sessionManager: SessionManager) {
    this.emptyChannelTimer = setInterval(() => {
      void this.expireEmptyChannels();
    }, EMPTY_CHANNEL_CHECK_INTERVAL_MS);
    this.emptyChannelTimer.unref();
  }

  public async connect(guild: Guild, channel: VoiceBasedChannel): Promise<void> {
    const existing = this.connectionsByGuildId.get(guild.id);
    const existingChannelId = this.channelIdsByGuildId.get(guild.id);
    if (existing && existingChannelId === channel.id) {
      this.guildsByGuildId.set(guild.id, guild);
      try {
        await entersState(existing, VoiceConnectionStatus.Ready, 5_000);
      } catch (error) {
        this.cleanupConnection(guild.id, existing);
        throw new Error(`Existing voice connection was not ready: ${formatError(error)}`);
      }

      await this.syncVoiceChannelMembers(guild.id);
      return;
    }

    if (existing && existingChannelId !== channel.id) {
      throw new Error("Voice connection is already locked to another channel.");
    }

    console.log(`[voice] Joining ${guild.id}/${channel.id}`);
    let connection: VoiceConnection | null = null;
    try {
      connection = joinVoiceChannel({
        guildId: guild.id,
        channelId: channel.id,
        adapterCreator: guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      this.connectionsByGuildId.set(guild.id, connection);
      this.channelIdsByGuildId.set(guild.id, channel.id);
      this.guildsByGuildId.set(guild.id, guild);
      this.emptySinceByGuildId.delete(guild.id);
      this.bindConnectionLogging(guild.id, connection);

      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      this.bindSpeakingEvents(guild, connection);
      this.startAudioPipeline(guild.id, connection);
      console.log(`[voice] Ready in ${guild.id}/${channel.id}`);
      await this.syncVoiceChannelMembers(guild.id);
    } catch (error) {
      this.cleanupConnection(guild.id, connection);
      throw new Error(`Could not join voice channel: ${formatError(error)}`);
    }
  }

  public disconnect(guildId: string): void {
    const existing = this.connectionsByGuildId.get(guildId);
    if (!existing) {
      return;
    }

    console.log(`[voice] Disconnecting from guild ${guildId}`);
    this.stopAudioPipeline(guildId);
    existing.destroy();
    this.connectionsByGuildId.delete(guildId);
    this.channelIdsByGuildId.delete(guildId);
    this.guildsByGuildId.delete(guildId);
    this.emptySinceByGuildId.delete(guildId);
  }

  public disconnectAll(): void {
    clearInterval(this.emptyChannelTimer);
    for (const guildId of this.connectionsByGuildId.keys()) {
      this.disconnect(guildId);
    }
  }

  public async syncVoiceChannelMembers(guildId: string): Promise<void> {
    const guild = this.guildsByGuildId.get(guildId);
    const channelId = this.channelIdsByGuildId.get(guildId);
    if (!guild || !channelId) {
      return;
    }

    const channel = guild.channels.cache.get(channelId) as VoiceBasedChannel | undefined;
    const voiceUserIds = new Set(
      channel?.members.filter((member) => !member.user.bot).map((member) => member.id) ?? [],
    );

    const pipeline = this.audioPipelinesByGuildId.get(guildId);
    if (pipeline) {
      for (const userId of pipeline.levelsByUserId.keys()) {
        if (!voiceUserIds.has(userId)) {
          pipeline.levelsByUserId.delete(userId);
        }
      }
    }

    const removedCount = await this.sessionManager.retainVoiceUsers(guildId, voiceUserIds);
    if (removedCount > 0) {
      console.log(`[voice] Pruned ${removedCount} departed user(s) from guild ${guildId}`);
    }
  }

  private bindConnectionLogging(guildId: string, connection: VoiceConnection): void {
    connection.on("stateChange", (oldState, newState) => {
      console.log(`[voice] ${guildId}: ${oldState.status} -> ${newState.status}`);
    });

    connection.on("error", (error) => {
      console.error(`[voice] Connection error in ${guildId}`, error);
    });
  }

  private bindSpeakingEvents(guild: Guild, connection: VoiceConnection): void {
    connection.receiver.speaking.on("start", (discordUserId) => {
      void this.setSpeaking(guild, discordUserId, true);
    });

    connection.receiver.speaking.on("end", (discordUserId) => {
      void this.setSpeaking(guild, discordUserId, false);
    });
  }

  private startAudioPipeline(guildId: string, connection: VoiceConnection): void {
    this.stopAudioPipeline(guildId);

    const receiver = new DiscordAudioReceiver(connection, (frame) => {
      this.handleAudioFrame(guildId, frame);
    });
    const timer = setInterval(() => {
      void this.flushAudio(guildId);
    }, MIX_INTERVAL_MS);
    const statsTimer = setInterval(() => {
      void this.logAudioStats(guildId);
    }, AUDIO_STATS_INTERVAL_MS);
    const levelTimer = setInterval(() => {
      void this.flushAudioLevels(guildId);
    }, AUDIO_LEVEL_INTERVAL_MS);

    timer.unref();
    statsTimer.unref();
    levelTimer.unref();
    receiver.start();
    this.audioPipelinesByGuildId.set(guildId, {
      receiver,
      profilePipelinesByBridgeKey: new Map(),
      timer,
      statsTimer,
      levelTimer,
      levelsByUserId: new Map(),
      lastStats: this.emptyStats(),
      lastStatsAt: Date.now(),
    });
  }

  private stopAudioPipeline(guildId: string): void {
    const pipeline = this.audioPipelinesByGuildId.get(guildId);
    if (!pipeline) {
      return;
    }

    clearInterval(pipeline.timer);
    clearInterval(pipeline.statsTimer);
    clearInterval(pipeline.levelTimer);
    pipeline.receiver.stop();
    for (const profilePipeline of pipeline.profilePipelinesByBridgeKey.values()) {
      profilePipeline.mixer.clear();
      profilePipeline.delayBuffer.clear();
    }
    pipeline.profilePipelinesByBridgeKey.clear();
    this.audioPipelinesByGuildId.delete(guildId);
  }

  private cleanupConnection(guildId: string, connection: VoiceConnection | null): void {
    this.stopAudioPipeline(guildId);
    if (connection) {
      try {
        connection.destroy();
      } catch {
        // Destroy can throw if the connection already closed while the join was failing.
      }
    }

    this.connectionsByGuildId.delete(guildId);
    this.channelIdsByGuildId.delete(guildId);
    this.guildsByGuildId.delete(guildId);
    this.emptySinceByGuildId.delete(guildId);
  }

  private handleAudioFrame(guildId: string, frame: PcmAudioFrame): void {
    const pipeline = this.audioPipelinesByGuildId.get(guildId);
    if (!pipeline) {
      return;
    }

    for (const bridgeKey of this.sessionManager.getActiveBridgeKeys(guildId)) {
      this.getProfilePipeline(pipeline, bridgeKey).mixer.enqueue(frame);
    }

    const level = this.calculateAudioLevel(frame.pcm);
    const previousLevel = pipeline.levelsByUserId.get(frame.discordUserId) ?? 0;
    pipeline.levelsByUserId.set(frame.discordUserId, Math.max(previousLevel * 0.75, level));
  }

  private async flushAudio(guildId: string): Promise<void> {
    const pipeline = this.audioPipelinesByGuildId.get(guildId);
    if (!pipeline) {
      return;
    }

    const mixInputs = await this.sessionManager.getActiveProfileMixInputs(guildId);
    if (mixInputs.length === 0) {
      for (const profilePipeline of pipeline.profilePipelinesByBridgeKey.values()) {
        profilePipeline.mixer.clear();
        profilePipeline.delayBuffer.clear();
        profilePipeline.lastDelayMs = null;
      }
      return;
    }

    const activeBridgeKeys = new Set(mixInputs.map((input) => input.bridgeKey));
    for (const [bridgeKey, profilePipeline] of pipeline.profilePipelinesByBridgeKey) {
      if (!activeBridgeKeys.has(bridgeKey)) {
        profilePipeline.mixer.clear();
        profilePipeline.delayBuffer.clear();
        pipeline.profilePipelinesByBridgeKey.delete(bridgeKey);
      }
    }

    for (const input of mixInputs) {
      const profilePipeline = this.getProfilePipeline(pipeline, input.bridgeKey);
      if (profilePipeline.lastDelayMs === null) {
        profilePipeline.lastDelayMs = input.delayMs;
      } else if (profilePipeline.lastDelayMs !== input.delayMs) {
        profilePipeline.delayBuffer.clear();
        profilePipeline.lastDelayMs = input.delayMs;
      }

      const mixedChunk = profilePipeline.mixer.mixNextFrame(input.users);
      if (mixedChunk) {
        profilePipeline.delayBuffer.push(mixedChunk, input.delayMs);
      }

      const readyChunk = profilePipeline.delayBuffer.popReady();
      if (readyChunk) {
        this.sessionManager.publishAudioChunk(guildId, input.bridgeKey, readyChunk);
      }
    }
  }

  private async logAudioStats(guildId: string): Promise<void> {
    const pipeline = this.audioPipelinesByGuildId.get(guildId);
    if (!pipeline) {
      return;
    }

    const session = this.sessionManager.getSessionByGuildId(guildId);
    const stats = this.aggregateStats(pipeline);
    const now = Date.now();
    const elapsedSeconds = Math.max((now - pipeline.lastStatsAt) / 1_000, 1);
    const mixedDelta = stats.mixedChunks - pipeline.lastStats.mixedChunks;
    const receivedDelta = stats.receivedFrames - pipeline.lastStats.receivedFrames;
    const droppedDelta = stats.droppedFrames - pipeline.lastStats.droppedFrames;
    const underrunDelta = stats.underruns - pipeline.lastStats.underruns;
    const limitedDelta = stats.softLimitedSamples - pipeline.lastStats.softLimitedSamples;

    if (!session?.active && mixedDelta === 0 && receivedDelta === 0) {
      pipeline.lastStats = stats;
      pipeline.lastStatsAt = now;
      return;
    }

    await this.sessionManager.updateEngineHealth(
      guildId,
      this.classifyEngineHealth({
        active: session?.active ?? false,
        mixedRate: mixedDelta / elapsedSeconds,
        receivedDelta,
        droppedDelta,
        underrunDelta,
        limitedDelta,
        queuedFrames: stats.queuedFrames,
        primedUsers: stats.primedUsers,
      }),
    );

    console.log(
      [
        `[audio] guild=${guildId}`,
        `active=${session?.active ?? false}`,
        `profiles=${session?.activeBridgeKeys.length ?? 0}`,
        `mixed=${(mixedDelta / elapsedSeconds).toFixed(1)}/s`,
        `received=${receivedDelta}`,
        `dropped=${droppedDelta}`,
        `underruns=${underrunDelta}`,
        `limitedSamples=${limitedDelta}`,
        `queued=${stats.queuedFrames}`,
        `primedUsers=${stats.primedUsers}`,
      ].join(" "),
    );

    pipeline.lastStats = stats;
    pipeline.lastStatsAt = now;
  }

  private classifyEngineHealth(input: {
    active: boolean;
    mixedRate: number;
    receivedDelta: number;
    droppedDelta: number;
    underrunDelta: number;
    limitedDelta: number;
    queuedFrames: number;
    primedUsers: number;
  }): { state: "idle" | "ok" | "warn" | "bad"; label: string; details: string } {
    const details = [
      `mixed=${input.mixedRate.toFixed(1)}/s`,
      `received=${input.receivedDelta}`,
      `dropped=${input.droppedDelta}`,
      `underruns=${input.underrunDelta}`,
      `limited=${input.limitedDelta}`,
      `queued=${input.queuedFrames}`,
      `primed=${input.primedUsers}`,
    ].join(" ");

    if (!input.active) {
      return {
        state: "idle",
        label: "Engine idle",
        details,
      };
    }

    if (input.droppedDelta > 20 || input.underrunDelta > 200) {
      return {
        state: "bad",
        label: "Engine trouble",
        details,
      };
    }

    if (input.droppedDelta > 0 || input.underrunDelta > 40 || input.limitedDelta > 25_000) {
      return {
        state: "warn",
        label: "Engine warning",
        details,
      };
    }

    if (input.receivedDelta === 0 && input.mixedRate === 0) {
      return {
        state: "idle",
        label: "Engine waiting",
        details: `${details} no current voice input`,
      };
    }

    return {
      state: "ok",
      label: "Engine good",
      details,
    };
  }

  private async flushAudioLevels(guildId: string): Promise<void> {
    const pipeline = this.audioPipelinesByGuildId.get(guildId);
    if (!pipeline || pipeline.levelsByUserId.size === 0) {
      return;
    }

    const levels = new Map<string, number>();
    for (const [discordUserId, level] of pipeline.levelsByUserId) {
      const nextLevel = level * 0.6;
      if (nextLevel < 0.01) {
        levels.set(discordUserId, 0);
        pipeline.levelsByUserId.delete(discordUserId);
      } else {
        levels.set(discordUserId, level);
        pipeline.levelsByUserId.set(discordUserId, nextLevel);
      }
    }

    await this.sessionManager.updateAudioLevels(guildId, levels);
  }

  private calculateAudioLevel(pcm: Buffer): number {
    if (pcm.length < 2) {
      return 0;
    }

    let sumSquares = 0;
    let sampleCount = 0;
    const stepBytes = 8;

    for (let offset = 0; offset + 1 < pcm.length; offset += stepBytes) {
      const normalized = pcm.readInt16LE(offset) / 32_768;
      sumSquares += normalized * normalized;
      sampleCount += 1;
    }

    if (sampleCount === 0) {
      return 0;
    }

    const rms = Math.sqrt(sumSquares / sampleCount);
    return Math.min(1, rms * 4);
  }

  private async setSpeaking(
    guild: Guild,
    discordUserId: string,
    speaking: boolean,
  ): Promise<void> {
    const identity = await this.getUserIdentity(guild, discordUserId);
    await this.sessionManager.updateSpeaking(guild.id, identity, speaking);
  }

  private async getUserIdentity(guild: Guild, discordUserId: string): Promise<UserIdentity> {
    const member = await guild.members.fetch(discordUserId).catch(() => null);
    if (member) {
      return {
        discordUserId,
        displayName: member.displayName,
        avatarUrl: member.displayAvatarURL({ extension: "png", size: 128 }),
      };
    }

    const user: User | null = await guild.client.users.fetch(discordUserId).catch(() => null);
    return {
      discordUserId,
      displayName: user?.displayName ?? user?.username ?? `User ${discordUserId}`,
      avatarUrl: user?.displayAvatarURL({ extension: "png", size: 128 }) ?? "",
    };
  }

  private getProfilePipeline(
    pipeline: GuildAudioPipeline,
    bridgeKey: string,
  ): ProfileAudioPipeline {
    const existing = pipeline.profilePipelinesByBridgeKey.get(bridgeKey);
    if (existing) {
      return existing;
    }

    const profilePipeline: ProfileAudioPipeline = {
      mixer: new AudioMixer(),
      delayBuffer: new DelayBuffer<MixedAudioChunk>(),
      lastDelayMs: null,
    };
    pipeline.profilePipelinesByBridgeKey.set(bridgeKey, profilePipeline);
    return profilePipeline;
  }

  private emptyStats(): AudioMixerStats {
    return {
      receivedFrames: 0,
      mixedChunks: 0,
      droppedFrames: 0,
      underruns: 0,
      softLimitedSamples: 0,
      queuedFrames: 0,
      primedUsers: 0,
    };
  }

  private aggregateStats(pipeline: GuildAudioPipeline): AudioMixerStats {
    const aggregate = this.emptyStats();
    for (const profilePipeline of pipeline.profilePipelinesByBridgeKey.values()) {
      const stats = profilePipeline.mixer.getStats();
      aggregate.receivedFrames += stats.receivedFrames;
      aggregate.mixedChunks += stats.mixedChunks;
      aggregate.droppedFrames += stats.droppedFrames;
      aggregate.underruns += stats.underruns;
      aggregate.softLimitedSamples += stats.softLimitedSamples;
      aggregate.queuedFrames += stats.queuedFrames;
      aggregate.primedUsers += stats.primedUsers;
    }

    return aggregate;
  }

  private async expireEmptyChannels(): Promise<void> {
    const now = Date.now();

    for (const [guildId, channelId] of this.channelIdsByGuildId) {
      const session = this.sessionManager.getSessionByGuildId(guildId);
      if (!session?.active) {
        this.emptySinceByGuildId.delete(guildId);
        continue;
      }

      const guild = this.guildsByGuildId.get(guildId);
      const channel = guild?.channels.cache.get(channelId) as VoiceBasedChannel | undefined;
      const nonBotMemberCount =
        channel?.members.filter((member) => !member.user.bot).size ?? 0;
      await this.syncVoiceChannelMembers(guildId);
      if (nonBotMemberCount > 0) {
        this.emptySinceByGuildId.delete(guildId);
        continue;
      }

      const emptySince = this.emptySinceByGuildId.get(guildId) ?? now;
      this.emptySinceByGuildId.set(guildId, emptySince);
      const timeoutMinutes = await this.sessionManager.getEmptyChannelTimeoutMinutes(guildId);
      if (now - emptySince >= timeoutMinutes * 60_000) {
        console.log(`[voice] Empty channel timeout in ${guildId}/${channelId}`);
        await this.sessionManager.stopSession(guildId, "empty-channel-timeout");
      }
    }
  }
}
