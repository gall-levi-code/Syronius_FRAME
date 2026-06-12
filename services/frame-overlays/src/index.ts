import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import express from "express";

type JsonObject = Record<string, unknown>;
interface PresetDocument {
  schema_version: string;
  default_preset_id: string;
  presets: JsonObject[];
}
interface StreamId {
  id?: string;
  publisher?: string;
  player: string;
  description?: string;
  source_type?: "sls" | "custom";
  source_label?: string;
}

const config = {
  port: readPort("PORT", 3733),
  dataRoot: path.resolve(process.env.DATA_ROOT?.trim() || "./data"),
  streamsApiUrl: stripTrailingSlash(process.env.STREAMS_API_URL?.trim() || "http://frame-streams:3732"),
  slsApiKey: required("SLS_API_KEY"),
  publicBaseUrl: stripTrailingSlash(process.env.PUBLIC_BASE_URL?.trim() || "http://localhost:3733"),
  requestTimeoutMs: readPositiveInt("REQUEST_TIMEOUT_MS", 3000),
  username: process.env.OVERLAYS_USERNAME?.trim() || undefined,
  password: process.env.OVERLAYS_PASSWORD?.trim() || undefined,
};

if (Boolean(config.username) !== Boolean(config.password)) {
  throw new Error("OVERLAYS_USERNAME and OVERLAYS_PASSWORD must be configured together");
}

const app = express();
const publicDir = path.resolve(process.cwd(), "public");
const schemaPath = path.resolve(process.cwd(), "config/overlay-presets.schema.json");
const stockPath = path.resolve(process.cwd(), "config/overlay-presets.default.json");
const statePath = path.join(config.dataRoot, "state/overlay-presets.json");
const rendererPath = path.join(publicDir, "renderer.html");
const AjvConstructor = Ajv2020 as unknown as new (options?: object) => {
  compile: (schema: unknown) => {
    (data: unknown): boolean;
    errors?: Array<{ instancePath: string; message?: string }> | null;
  };
};
const addFormatsPlugin = addFormats as unknown as (instance: unknown) => void;
const ajv = new AjvConstructor({ allErrors: true, strict: false });
addFormatsPlugin(ajv);
const validateDocument = ajv.compile(JSON.parse(await readFile(schemaPath, "utf8")));
const stockDocument = JSON.parse(await readFile(stockPath, "utf8")) as PresetDocument;

await ensureState();

app.disable("x-powered-by");
app.use(express.json({ limit: "256kb" }));
app.use("/overlays/assets", express.static(publicDir, { maxAge: 0 }));

app.get("/healthz", async (_request, response) => {
  try {
    const upstream = await streamsFetch("/internal/streams");
    response.status(upstream.ok ? 200 : 503).json({
      ok: upstream.ok,
      service: "frame-overlays",
      telemetry: upstream.ok ? "ready" : "unavailable",
    });
  } catch {
    response.status(503).json({ ok: false, service: "frame-overlays", telemetry: "unavailable" });
  }
});

app.get("/overlays/stats/:player", async (request, response, next) => {
  try {
    const upstream = await streamsFetch(`/internal/streams/${encodeURIComponent(validSlsId(request.params.player))}/stats`);
    response.status(upstream.status).json(await upstream.json());
  } catch (error) {
    next(error);
  }
});

app.get("/overlays/view/:id", async (request, response, next) => {
  try {
    const document = await readState();
    const id = validId(request.params.id);
    const preset = findPreset(document, id);
    if (preset.enabled === false) {
      throw new RequestError(404, "Preset is disabled.");
    }
    if (preset.type !== "connectivity") {
      throw new RequestError(501, `Renderer for ${String(preset.type)} is not implemented yet.`);
    }
    const html = await readFile(rendererPath, "utf8");
    const payload = JSON.stringify(await rendererPayload(id, preset)).replaceAll("<", "\\u003c");
    response.setHeader("Cache-Control", "no-store");
    const title = escapeHtml(cleanText(preset.window_title, 100) || cleanText(preset.name, 80) || "FRAME Overlay");
    response.type("html").send(
      html
        .replace("<title>FRAME Overlay</title>", `<title>${title}</title>`)
        .replace("/*__FRAME_OVERLAY_CONFIG__*/null", payload),
    );
  } catch (error) {
    next(error);
  }
});

app.get("/overlays/view/:id/config", async (request, response, next) => {
  try {
    const id = validId(request.params.id);
    const preset = findPreset(await readState(), id);
    response.setHeader("Cache-Control", "no-store");
    response.json(await rendererPayload(id, preset));
  } catch (error) {
    next(error);
  }
});

app.get("/overlays/view/:id/stats", async (request, response, next) => {
  try {
    const preset = findPreset(await readState(), validId(request.params.id));
    if (preset.enabled === false) {
      throw new RequestError(404, "Preset is disabled.");
    }
    const streamProfileId = readStreamProfileId(preset);
    if (!streamProfileId) {
      throw new RequestError(404, "Preset is not bound to a stream profile.");
    }
    const upstream = await streamsFetch(`/internal/streams/${encodeURIComponent(streamProfileId)}/stats`);
    response.status(upstream.status).json(await upstream.json());
  } catch (error) {
    next(error);
  }
});

app.post("/internal/streams/:player/unbind", requireInternalAuth, async (request, response, next) => {
  try {
    const player = validSlsId(request.params.player);
    const document = await readState();
    const unboundPresets: string[] = [];
    for (const preset of document.presets) {
      if (readStreamProfileId(preset) !== player) {
        continue;
      }
      (preset.config as JsonObject).stream_profile_id = null;
      preset.updated_at = new Date().toISOString();
      unboundPresets.push(String(preset.id));
    }
    if (unboundPresets.length) {
      await writeState(document);
    }
    response.json({ unbound_presets: unboundPresets });
  } catch (error) {
    next(error);
  }
});

app.use(["/overlays/api", "/overlays/setup", "/overlays"], requireManagementAuth);

app.get("/overlays/api/config", (_request, response) => {
  response.json({
    public_base_url: config.publicBaseUrl,
    stock_preset_ids: stockDocument.presets.map((preset) => preset.id),
  });
});

app.get("/overlays/api/streams", async (_request, response, next) => {
  try {
    const result = await streamsJson<{ streams?: StreamId[] }>("/internal/streams");
    response.json({ streams: result.streams ?? [] });
  } catch (error) {
    next(error);
  }
});

app.get("/overlays/api/presets", async (_request, response, next) => {
  try {
    response.json(await readState());
  } catch (error) {
    next(error);
  }
});

app.put("/overlays/api/presets/:id", async (request, response, next) => {
  try {
    const id = validId(request.params.id);
    const document = await readState();
    const index = document.presets.findIndex((preset) => preset.id === id);
    if (index < 0) {
      throw new RequestError(404, "Preset not found.");
    }
    const now = new Date().toISOString();
    document.presets[index] = {
      ...request.body,
      id,
      created_at: document.presets[index].created_at ?? now,
      updated_at: now,
    };
    await writeState(document);
    response.json({ preset: document.presets[index] });
  } catch (error) {
    next(error);
  }
});

app.post("/overlays/api/presets/:id/duplicate", async (request, response, next) => {
  try {
    const document = await readState();
    const source = findPreset(document, validId(request.params.id));
    const id = validId(request.body?.id);
    if (document.presets.some((preset) => preset.id === id)) {
      throw new RequestError(409, "A preset with that ID already exists.");
    }
    const now = new Date().toISOString();
    const preset = JSON.parse(JSON.stringify({
      ...source,
      id,
      name: cleanText(request.body?.name, 80) || `${String(source.name)} Copy`,
      created_at: now,
      updated_at: now,
    })) as JsonObject;
    document.presets.push(preset);
    await writeState(document);
    response.status(201).json({ preset });
  } catch (error) {
    next(error);
  }
});

app.post("/overlays/api/presets/:id/restore", async (request, response, next) => {
  try {
    const id = validId(request.params.id);
    const stock = findPreset(stockDocument, id);
    const document = await readState();
    const index = document.presets.findIndex((preset) => preset.id === id);
    const restored = JSON.parse(JSON.stringify({ ...stock, updated_at: new Date().toISOString() })) as JsonObject;
    if (index < 0) document.presets.push(restored);
    else document.presets[index] = restored;
    await writeState(document);
    response.json({ preset: restored });
  } catch (error) {
    next(error);
  }
});

app.delete("/overlays/api/presets/:id", async (request, response, next) => {
  try {
    const id = validId(request.params.id);
    const document = await readState();
    if (document.default_preset_id === id) {
      throw new RequestError(409, "The default preset cannot be deleted.");
    }
    const next = document.presets.filter((preset) => preset.id !== id);
    if (next.length === document.presets.length) {
      throw new RequestError(404, "Preset not found.");
    }
    document.presets = next;
    await writeState(document);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/overlays/api/default/:id", async (request, response, next) => {
  try {
    const document = await readState();
    const id = validId(request.params.id);
    findPreset(document, id);
    document.default_preset_id = id;
    await writeState(document);
    response.json({ default_preset_id: id });
  } catch (error) {
    next(error);
  }
});

app.get(["/overlays", "/overlays/setup"], (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use((
  error: unknown,
  _request: express.Request,
  response: express.Response,
  _next: express.NextFunction,
) => {
  const status = error instanceof RequestError ? error.status : 500;
  if (status >= 500) {
    console.error("[overlays]", error);
  }
  response.status(status).json({ error: errorMessage(error) });
});

app.listen(config.port, () => {
  console.log(`[overlays] FRAME Overlays listening on port ${config.port}`);
});

async function ensureState(): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  try {
    await readFile(statePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await atomicWrite(statePath, `${JSON.stringify(stockDocument, null, 2)}\n`);
    console.log("[overlays] Seeded stock overlay preset.");
  }
  await readState();
}

async function readState(): Promise<PresetDocument> {
  const document = JSON.parse(await readFile(statePath, "utf8")) as PresetDocument;
  assertValid(document);
  return document;
}

async function writeState(document: PresetDocument): Promise<void> {
  assertValid(document);
  await atomicWrite(statePath, `${JSON.stringify(document, null, 2)}\n`);
}

function assertValid(document: PresetDocument): void {
  if (!validateDocument(document)) {
    const message = validateDocument.errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ");
    throw new RequestError(400, `Preset document is invalid: ${message}`);
  }
  if (!document.presets.some((preset) => preset.id === document.default_preset_id)) {
    throw new RequestError(400, "default_preset_id must reference an existing preset.");
  }
  for (const preset of document.presets) {
    const presetConfig = preset.config;
    if (!presetConfig || typeof presetConfig !== "object" || Array.isArray(presetConfig)) {
      continue;
    }
    const warn = Number((presetConfig as JsonObject).rtt_warn_max);
    const bad = Number((presetConfig as JsonObject).rtt_bad_max);
    if (Number.isFinite(warn) && Number.isFinite(bad) && warn >= bad) {
      throw new RequestError(400, `Preset ${String(preset.id)} must keep RTT good max below RTT bad threshold.`);
    }
  }
}

function findPreset(document: PresetDocument, id: string): JsonObject {
  const preset = document.presets.find((candidate) => candidate.id === id);
  if (!preset) throw new RequestError(404, "Preset not found.");
  return preset;
}

function publicPreset(preset: JsonObject): JsonObject {
  const clone = JSON.parse(JSON.stringify(preset)) as JsonObject;
  if (clone.config && typeof clone.config === "object" && !Array.isArray(clone.config)) {
    delete (clone.config as JsonObject).stream_profile_id;
  }
  return clone;
}

async function rendererPayload(id: string, preset: JsonObject): Promise<JsonObject> {
  const streamProfileId = readStreamProfileId(preset);
  return {
    preset: publicPreset(preset),
    revision: cleanText(preset.updated_at, 100) || cleanText(preset.created_at, 100) || "stock",
    server_name: new URL(config.publicBaseUrl).hostname,
    settings_url: `/overlays/view/${encodeURIComponent(id)}/config`,
    stats_url: streamProfileId ? `/overlays/view/${encodeURIComponent(id)}/stats` : null,
    stream_display_name: await resolveStreamDisplayName(streamProfileId, preset),
  };
}

function readStreamProfileId(preset: JsonObject): string | null {
  const presetConfig = preset.config;
  if (!presetConfig || typeof presetConfig !== "object" || Array.isArray(presetConfig)) {
    return null;
  }
  const value = (presetConfig as JsonObject).stream_profile_id;
  return typeof value === "string" && value ? value : null;
}

async function resolveStreamDisplayName(streamProfileId: string | null, preset: JsonObject): Promise<string> {
  if (streamProfileId) {
    try {
      const result = await streamsJson<{ streams?: StreamId[] }>("/internal/streams");
      const stream = result.streams?.find((candidate) => candidate.player === streamProfileId);
      const description = cleanText(stream?.description, 80);
      if (description) {
        return description;
      }
    } catch {
      // The overlay remains usable when receiver profile metadata is temporarily unavailable.
    }
  }
  return cleanText(preset.name, 80) || "FRAME Stream";
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, file);
}

async function streamsJson<T>(route: string): Promise<T> {
  const response = await streamsFetch(route);
  if (!response.ok) throw new RequestError(response.status, `Stream Management returned ${response.status}`);
  return (await response.json()) as T;
}

async function streamsFetch(route: string, init: RequestInit = {}): Promise<Response> {
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
}

function requireManagementAuth(request: express.Request, response: express.Response, next: express.NextFunction): void {
  if (!config.username || !config.password) {
    next();
    return;
  }
  const credentials = readBasicCredentials(request.header("authorization"));
  if (credentials && safeEqual(credentials.username, config.username) && safeEqual(credentials.password, config.password)) {
    next();
    return;
  }
  response.setHeader("WWW-Authenticate", 'Basic realm="FRAME Overlays", charset="UTF-8"');
  response.status(401).send("Authentication required.");
}

function requireInternalAuth(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const authorization = request.header("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (token && safeEqual(token, config.slsApiKey)) {
    next();
    return;
  }
  response.status(401).json({ error: "Internal service authentication required." });
}

function validId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value) || value.length > 64) {
    throw new RequestError(400, "Preset and player IDs must use 2-64 lowercase letters, numbers, or hyphens.");
  }
  return value;
}

function validSlsId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new RequestError(400, "Stream profile IDs must use letters, numbers, underscores, or hyphens.");
  }
  return value;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBasicCredentials(authorization: string | undefined): { username: string; password: string } | null {
  if (!authorization?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator < 0 ? null : { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
