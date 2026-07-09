import "dotenv/config";
import path from "node:path";

export interface AppConfig {
  discordToken: string;
  discordClientId: string;
  publicBaseUrl: string;
  port: number;
  sessionSecret: string;
  defaultAudioDelayMs: number;
  maxAudioDelayMs: number;
  sessionIdleTimeoutMinutes: number;
  dataDir: string;
  readonlyObsToken?: string;
  portalServiceToken?: string;
  nodeEnv: string;
}

function readInt(name: string, fallback: number, min = 0): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }

  return parsed;
}

function readRequired(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePublicUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("PUBLIC_BASE_URL must start with http:// or https://.");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) url.protocol = "https:";
  url.hash = "";
  return trimTrailingSlash(url.toString());
}

export function loadConfig(): AppConfig {
  const port = readInt("PORT", 3728, 1);
  const maxAudioDelayMs = readInt("MAX_AUDIO_DELAY_MS", 10_000, 0);
  const defaultAudioDelayMs = Math.min(
    readInt("DEFAULT_AUDIO_DELAY_MS", 2_000, 0),
    maxAudioDelayMs,
  );

  const publicBaseUrl = normalizePublicUrl(
    process.env.PUBLIC_BASE_URL?.trim() || `http://localhost:${port}`,
  );

  return {
    discordToken: readRequired("DISCORD_TOKEN"),
    discordClientId: readRequired("DISCORD_CLIENT_ID"),
    publicBaseUrl,
    port,
    sessionSecret: process.env.SESSION_SECRET?.trim() || "dev-only-change-me",
    defaultAudioDelayMs,
    maxAudioDelayMs,
    sessionIdleTimeoutMinutes: readInt("SESSION_IDLE_TIMEOUT_MINUTES", 30, 1),
    dataDir: path.resolve(process.env.DATA_DIR?.trim() || "./data"),
    readonlyObsToken: process.env.READONLY_OBS_TOKEN?.trim() || undefined,
    portalServiceToken: process.env.PORTAL_SERVICE_TOKEN?.trim() || undefined,
    nodeEnv: process.env.NODE_ENV?.trim() || "development",
  };
}
