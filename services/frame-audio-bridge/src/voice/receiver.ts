import {
  EndBehaviorType,
  type AudioReceiveStream,
  type VoiceConnection,
} from "@discordjs/voice";
import { opus } from "prism-media";
import type { PcmAudioFrame } from "./mixer";

export type AudioFrameHandler = (frame: PcmAudioFrame) => void;

interface UserDecodePipeline {
  opusStream: AudioReceiveStream;
  decoder: opus.Decoder;
}

export class DiscordAudioReceiver {
  private readonly pipelinesByUserId = new Map<string, UserDecodePipeline>();

  private readonly handleSpeakingStart = (discordUserId: string): void => {
    this.subscribeToUser(discordUserId);
  };

  public constructor(
    private readonly connection: VoiceConnection,
    private readonly onFrame: AudioFrameHandler,
  ) {}

  public start(): void {
    this.connection.receiver.speaking.on("start", this.handleSpeakingStart);
  }

  public stop(): void {
    this.connection.receiver.speaking.removeListener("start", this.handleSpeakingStart);

    for (const discordUserId of this.pipelinesByUserId.keys()) {
      this.destroyPipeline(discordUserId);
    }
  }

  private subscribeToUser(discordUserId: string): void {
    if (this.pipelinesByUserId.has(discordUserId)) {
      return;
    }

    let opusStream: AudioReceiveStream;
    let decoder: opus.Decoder;

    try {
      opusStream = this.connection.receiver.subscribe(discordUserId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 500,
        },
      });

      decoder = new opus.Decoder({
        rate: 48_000,
        channels: 2,
        frameSize: 960,
      });
    } catch (error) {
      console.error(`[receiver] Failed to subscribe to ${discordUserId}`, error);
      return;
    }

    const cleanup = (): void => {
      this.destroyPipeline(discordUserId);
    };

    opusStream.on("error", (error) => {
      console.error(`[receiver] Opus stream error for ${discordUserId}`, error);
      cleanup();
    });

    decoder.on("error", (error) => {
      console.error(`[receiver] Decoder error for ${discordUserId}`, error);
      cleanup();
    });

    decoder.on("data", (chunk: Buffer) => {
      this.onFrame({
        discordUserId,
        pcm: Buffer.from(chunk),
        sampleRate: 48_000,
        channels: 2,
        receivedAt: Date.now(),
      });
    });

    opusStream.once("end", cleanup);
    opusStream.once("close", cleanup);
    decoder.once("close", cleanup);

    this.pipelinesByUserId.set(discordUserId, { opusStream, decoder });
    opusStream.pipe(decoder);
  }

  private destroyPipeline(discordUserId: string): void {
    const pipeline = this.pipelinesByUserId.get(discordUserId);
    if (!pipeline) {
      return;
    }

    this.pipelinesByUserId.delete(discordUserId);

    if (!pipeline.opusStream.destroyed) {
      pipeline.opusStream.destroy();
    }

    if (!pipeline.decoder.destroyed) {
      pipeline.decoder.destroy();
    }
  }
}
