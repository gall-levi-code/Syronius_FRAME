import { readFile, statfs } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config";
import type { DockerClient } from "./dockerClient";
import { loadStackConfig } from "./stackConfig";
import type { ServiceSummary, StatusResponse } from "./types";

interface AudioBridgePortalStatus {
  generated_at: string;
  bot_connected: boolean;
  guilds: Array<{
    guildId: string;
    active: boolean;
    channelName: string | null;
    activeProfileCount: number;
    activeProfiles: Array<{ label: string }>;
    speakingUsers: string[];
    engineHealth: { state: "idle" | "ok" | "warn" | "bad" };
    voice_connection: string;
    clients: { audio: number; overlay: number; control: number };
  }>;
}

export class StatusCollector {
  private cachedStatus: StatusResponse | null = null;
  private cachedAt = 0;
  private pendingStatus: Promise<StatusResponse> | null = null;

  constructor(
    private readonly appConfig: AppConfig,
    private readonly dockerClient: DockerClient,
  ) {}

  async collect(): Promise<StatusResponse> {
    const now = Date.now();
    if (this.cachedStatus && now - this.cachedAt <= this.appConfig.statusCacheMs) {
      return this.cachedStatus;
    }
    if (this.pendingStatus) {
      return this.pendingStatus;
    }

    this.pendingStatus = this.collectFresh();
    try {
      this.cachedStatus = await this.pendingStatus;
      this.cachedAt = Date.now();
      return this.cachedStatus;
    } finally {
      this.pendingStatus = null;
    }
  }

  private async collectFresh(): Promise<StatusResponse> {
    const alerts: StatusResponse["alerts"] = [];
    const loadedStackConfig = await loadStackConfig(this.appConfig);
    let services: ServiceSummary[] = [];

    if (loadedStackConfig.source === "fallback") {
      alerts.push({
        level: "warn",
        message: "Portal is using fallback configuration because stack-config.json is unavailable.",
      });
    }

    try {
      services = await this.dockerClient.listFrameServices();
    } catch (error) {
      alerts.push({
        level: "warn",
        message: `Docker service status is unavailable: ${errorMessage(error)}`,
      });
    }

    for (const service of services) {
      if (service.status === "error" || service.health === "unhealthy") {
        alerts.push({ level: "error", message: `${service.name} requires attention.` });
      } else if (service.status !== "running") {
        alerts.push({ level: "warn", message: `${service.name} is ${service.status}.` });
      }
    }

    const disk = await this.readDisk(alerts);
    const audioBridgeService = services.find((service) => service.name === "frame-audio-bridge");
    const discordAudioBridges = await this.readAudioBridgeStatus(audioBridgeService, alerts);
    const lastPhoto = await this.readLastPhoto();

    return {
      generated_at: new Date().toISOString(),
      mode: loadedStackConfig.config.mode,
      services,
      last_photo: lastPhoto,
      last_ingest: null,
      audio_streams: [],
      discord_audio_bridges: discordAudioBridges,
      disk,
      alerts,
    };
  }

  private async readLastPhoto(): Promise<StatusResponse["last_photo"]> {
    try {
      const latest = JSON.parse(
        await readFile(path.join(this.appConfig.dataRoot, "state", "latest.json"), "utf8"),
      ) as { updated_at?: unknown; latest_photo_at?: unknown; latest_base?: unknown };
      const photoAt = typeof latest.latest_photo_at === "string" ? latest.latest_photo_at : latest.updated_at;
      return typeof photoAt === "string" && typeof latest.latest_base === "string"
        ? { at: photoAt, base: latest.latest_base }
        : null;
    } catch {
      return null;
    }
  }

  private async readAudioBridgeStatus(
    service: ServiceSummary | undefined,
    alerts: StatusResponse["alerts"],
  ): Promise<StatusResponse["discord_audio_bridges"]> {
    if (!service || service.status !== "running") {
      return [];
    }

    if (!this.appConfig.audioBridgeStatusUrl || !this.appConfig.audioBridgeStatusToken) {
      alerts.push({
        level: "warn",
        message: "Audio Bridge is running, but authoritative Portal telemetry is not configured.",
      });
      return [];
    }

    try {
      const response = await fetchWithTimeout(
        this.appConfig.audioBridgeStatusUrl,
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.appConfig.audioBridgeStatusToken}`,
          },
        },
        this.appConfig.requestTimeoutMs,
      );
      if (!response.ok) {
        throw new Error(`Audio Bridge telemetry returned ${response.status}`);
      }
      const telemetry = (await response.json()) as AudioBridgePortalStatus;

      if (!telemetry.bot_connected) {
        alerts.push({ level: "error", message: "Audio Bridge is running but its Discord bot is offline." });
      }

      return telemetry.guilds.map((guild) => {
        const voiceReady = guild.voice_connection === "ready";
        if (guild.active && !voiceReady) {
          alerts.push({
            level: "error",
            message: `An Audio Bridge mix is active without a ready Discord voice connection.`,
          });
        }
        return {
          guild_id: guild.guildId,
          status: !telemetry.bot_connected || (guild.active && !voiceReady)
            ? "error"
            : guild.active
              ? "active"
              : "idle",
          channel_name: guild.channelName,
          active_mix_count: guild.activeProfileCount,
          active_streamers: guild.activeProfiles.map((profile) => profile.label),
          speaking_users: guild.speakingUsers,
          bot_connected: telemetry.bot_connected,
          voice_connection: guild.voice_connection,
          clients: guild.clients,
          engine_health: guild.engineHealth.state,
        };
      });
    } catch (error) {
      alerts.push({
        level: "warn",
        message: `Audio Bridge telemetry is unavailable: ${errorMessage(error)}`,
      });
      return [];
    }
  }

  private async readDisk(alerts: StatusResponse["alerts"]): Promise<StatusResponse["disk"]> {
    try {
      const stats = await statfs(this.appConfig.dataRoot);
      const totalBytes = stats.blocks * stats.bsize;
      const availableBytes = stats.bavail * stats.bsize;
      const usedBytes = Math.max(0, totalBytes - availableBytes);
      const percentUsed = totalBytes ? (usedBytes / totalBytes) * 100 : 0;
      const minimumFreeBytes = this.appConfig.diskMinimumFreeGb * 1024 ** 3;

      if (percentUsed >= this.appConfig.diskErrorPercent || availableBytes < minimumFreeBytes) {
        alerts.push({
          level: "error",
          message: `FRAME data disk is ${percentUsed.toFixed(1)}% full with ${formatGiB(availableBytes)} free.`,
        });
      } else if (percentUsed >= this.appConfig.diskWarnPercent) {
        alerts.push({
          level: "warn",
          message: `FRAME data disk is ${percentUsed.toFixed(1)}% full with ${formatGiB(availableBytes)} free.`,
        });
      }

      return {
        used_bytes: usedBytes,
        free_bytes: availableBytes,
        total_bytes: totalBytes,
        percent_used: Number(percentUsed.toFixed(1)),
      };
    } catch (error) {
      alerts.push({
        level: "warn",
        message: `Disk usage is unavailable: ${errorMessage(error)}`,
      });
      return { used_bytes: 0, free_bytes: 0, total_bytes: 0, percent_used: 0 };
    }
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
