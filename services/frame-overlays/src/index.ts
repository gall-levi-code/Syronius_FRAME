import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createFrameOverlaysApp } from "./app.js";
import type { OverlayDocumentV2 } from "./model.js";
import { OverlayStore } from "./store.js";

const AjvConstructor = Ajv2020 as unknown as new (options?: object) => {
  compile: (schema: unknown) => {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};
const addFormatsPlugin = addFormats as unknown as (instance: unknown) => void;

const config = {
  port: readPort("PORT", 3733),
  dataRoot: path.resolve(process.env.DATA_ROOT?.trim() || "./data"),
  streamsApiUrl: stripTrailingSlash(process.env.STREAMS_API_URL?.trim() || "http://frame-streams:3732"),
  photoUploadApiUrl: stripTrailingSlash(process.env.PHOTO_UPLOAD_API_URL?.trim() || "http://frame-photo-upload:3736"),
  photoFtpApiUrl: stripTrailingSlash(process.env.PHOTO_FTP_API_URL?.trim() || "http://frame-photo-ftp:3737"),
  belaboxManagerApiUrl: stripTrailingSlash(process.env.BELABOX_MANAGER_API_URL?.trim() || "http://frame-belabox-manager:3741"),
  slsApiKey: required("SLS_API_KEY"),
  ingestApiToken: required("PORTAL_SERVICE_TOKEN"),
  publicBaseUrl: stripTrailingSlash(process.env.PUBLIC_BASE_URL?.trim() || "http://localhost:3733"),
  requestTimeoutMs: readPositiveInt("REQUEST_TIMEOUT_MS", 3000),
  username: process.env.OVERLAYS_USERNAME?.trim() || undefined,
  password: process.env.OVERLAYS_PASSWORD?.trim() || undefined,
};

if (Boolean(config.username) !== Boolean(config.password)) {
  throw new Error("OVERLAYS_USERNAME and OVERLAYS_PASSWORD must be configured together");
}

const publicDir = path.resolve(process.cwd(), "public");
const schemaPath = path.resolve(process.cwd(), "config/overlay-presets.schema.json");
const stockPath = path.resolve(process.cwd(), "config/overlay-presets.default.json");
const statePath = path.join(config.dataRoot, "state/overlay-presets.json");
const ajv = new AjvConstructor({ allErrors: true, strict: false });
addFormatsPlugin(ajv);
const validateDocument = ajv.compile(JSON.parse(await readFile(schemaPath, "utf8")));
const stockDocument = JSON.parse(await readFile(stockPath, "utf8")) as OverlayDocumentV2;
const store = new OverlayStore({
  statePath,
  stockDocument,
  validate: (document) => validateDocument(document),
  validationErrors: () => validateDocument.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") || "unknown validation error",
});

const streamsFetch = async (route: string, init: RequestInit = {}): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${config.slsApiKey}`);
  try {
    return await fetch(`${config.streamsApiUrl}${route}`, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const photoUploadFetch = async (route: string, init: RequestInit = {}): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${config.ingestApiToken}`);
  try {
    return await fetch(`${config.photoUploadApiUrl}${route}`, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const photoFtpFetch = async (route: string, init: RequestInit = {}): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${config.ingestApiToken}`);
  try {
    return await fetch(`${config.photoFtpApiUrl}${route}`, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const belaboxManagerFetch = async (route: string, init: RequestInit = {}): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  try {
    return await fetch(`${config.belaboxManagerApiUrl}${route}`, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const runtime = await createFrameOverlaysApp({ config, store, publicDir, streamsFetch, photoUploadFetch, photoFtpFetch, belaboxManagerFetch });
const server = runtime.app.listen(config.port, () => {
  console.log(`[overlays] FRAME Overlays v2 listening on port ${config.port}`);
});

const shutdown = () => {
  runtime.close();
  server.close();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

function readPort(name: string, fallback: number): number {
  const value = readPositiveInt(name, fallback);
  if (value > 65535) throw new Error(`${name} must be at most 65535`);
  return value;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
