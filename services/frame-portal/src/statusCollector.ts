import { readFile, statfs } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config";
import type { DockerClient } from "./dockerClient";
import { loadStackConfig } from "./stackConfig";
import type { ServiceSummary, StatusResponse } from "./types";

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
    const lastPhoto = await this.readLastPhoto();

    return {
      generated_at: new Date().toISOString(),
      mode: loadedStackConfig.config.mode,
      services,
      last_photo: lastPhoto,
      last_ingest: null,
      audio_streams: [],
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

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
