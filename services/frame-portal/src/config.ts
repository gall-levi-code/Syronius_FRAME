import "dotenv/config";
import path from "node:path";
import type { FrameMode } from "./types";

export interface AppConfig {
  port: number;
  mode: FrameMode;
  dataRoot: string;
  stackConfigPath: string;
  dockerHost?: string;
  dockerSocketPath: string;
  dockerComposeProject?: string;
  serviceNamePrefix: string;
  enableContainerRestarts: boolean;
  statusRefreshMs: number;
  statusCacheMs: number;
  requestTimeoutMs: number;
  audioBridgeStatusUrl?: string;
  audioBridgeStatusToken?: string;
  portalUsername?: string;
  portalPassword?: string;
  portalRealm: string;
  diskWarnPercent: number;
  diskErrorPercent: number;
  diskMinimumFreeGb: number;
}

function readInt(name: string, fallback: number, minimum: number): number {
  const value = process.env[name]?.trim();
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function readBoolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

export function loadConfig(): AppConfig {
  const mode = process.env.FRAME_MODE?.trim().toUpperCase() || "LAN";
  if (mode !== "LAN" && mode !== "HYBRID") {
    throw new Error("FRAME_MODE must be LAN or HYBRID");
  }

  const dataRoot = path.resolve(process.env.DATA_ROOT?.trim() || "./data");
  const portalUsername = process.env.PORTAL_USERNAME?.trim() || undefined;
  const portalPassword = process.env.PORTAL_PASSWORD?.trim() || undefined;
  if (Boolean(portalUsername) !== Boolean(portalPassword)) {
    throw new Error("PORTAL_USERNAME and PORTAL_PASSWORD must be configured together");
  }
  if (mode === "HYBRID" && (!portalUsername || !portalPassword)) {
    throw new Error("Portal authentication is required in HYBRID mode");
  }

  return {
    port: readInt("PORT", 3730, 1),
    mode,
    dataRoot,
    stackConfigPath: path.resolve(
      process.env.STACK_CONFIG_PATH?.trim() || path.join(dataRoot, "state", "stack-config.json"),
    ),
    dockerHost: process.env.DOCKER_HOST?.trim() || undefined,
    dockerSocketPath: process.env.DOCKER_SOCKET_PATH?.trim() || "/var/run/docker.sock",
    dockerComposeProject: process.env.DOCKER_COMPOSE_PROJECT?.trim() || undefined,
    serviceNamePrefix: process.env.SERVICE_NAME_PREFIX?.trim() || "frame-",
    enableContainerRestarts: readBoolean("ENABLE_CONTAINER_RESTARTS", false),
    statusRefreshMs: readInt("STATUS_REFRESH_MS", 5_000, 1_000),
    statusCacheMs: readInt("STATUS_CACHE_MS", 4_000, 0),
    requestTimeoutMs: readInt("REQUEST_TIMEOUT_MS", 3_000, 250),
    audioBridgeStatusUrl: process.env.AUDIO_BRIDGE_STATUS_URL?.trim() || undefined,
    audioBridgeStatusToken: process.env.AUDIO_BRIDGE_STATUS_TOKEN?.trim() || undefined,
    portalUsername,
    portalPassword,
    portalRealm: process.env.PORTAL_REALM?.trim() || "FRAME Portal",
    diskWarnPercent: readInt("DISK_WARN_PERCENT", 85, 1),
    diskErrorPercent: readInt("DISK_ERROR_PERCENT", 95, 1),
    diskMinimumFreeGb: readInt("DISK_MINIMUM_FREE_GB", 20, 0),
  };
}
