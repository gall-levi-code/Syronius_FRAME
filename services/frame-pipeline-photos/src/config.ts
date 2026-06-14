import "dotenv/config";
import path from "node:path";

export interface PipelineConfig {
  port: number;
  dataRoot: string;
  hostDataRoot: string;
  timezone: string;
  pollMs: number;
  concurrency: number;
  maxInputBytes: number;
  maxPixels: number;
  conversionAttempts: number;
  archiveOriginals: boolean;
}

export function loadConfig(): PipelineConfig {
  return {
    port: integer("PORT", 3735, 1, 65535),
    dataRoot: path.resolve(process.env.DATA_ROOT?.trim() || "./data"),
    hostDataRoot: process.env.HOST_DATA_ROOT?.trim() || "/data",
    timezone: process.env.TIMEZONE?.trim() || "America/Chicago",
    pollMs: integer("PIPELINE_POLL_MS", 1000, 100, 60000),
    concurrency: integer("PIPELINE_CONCURRENCY", 2, 1, 8),
    maxInputBytes: integer("PHOTO_MAX_INPUT_MB", 50, 1, 2048) * 1024 * 1024,
    maxPixels: integer("PHOTO_MAX_MEGAPIXELS", 80, 1, 1000) * 1_000_000,
    conversionAttempts: integer("PHOTO_CONVERSION_ATTEMPTS", 3, 1, 10),
    archiveOriginals: boolean("PHOTO_ARCHIVE_ORIGINALS", true),
  };
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name]?.trim() || String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}
