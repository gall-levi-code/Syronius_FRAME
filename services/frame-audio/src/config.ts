import "dotenv/config";
import path from "node:path";

export interface AppConfig {
  port: number;
  dataRoot: string;
  publicBaseUrl: string;
  captureBaseUrl: string;
  ffmpegPath: string;
}

export function loadConfig(): AppConfig {
  const publicBaseUrl = normalizePublicUrl(process.env.PUBLIC_BASE_URL?.trim() || "http://localhost:3734");
  return {
    port: readPort("PORT", 3734),
    dataRoot: path.resolve(process.env.DATA_ROOT?.trim() || "./data"),
    publicBaseUrl,
    captureBaseUrl: normalizePublicUrl(process.env.CAPTURE_BASE_URL?.trim() || publicBaseUrl),
    ffmpegPath: process.env.FFMPEG_PATH?.trim() || "ffmpeg",
  };
}

function readPort(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name]?.trim() || String(fallback), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizePublicUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Public URL settings must start with http:// or https://.");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) url.protocol = "https:";
  url.hash = "";
  return stripTrailingSlash(url.toString());
}
