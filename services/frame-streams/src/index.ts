import "dotenv/config";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import express from "express";
import path from "node:path";
import {
  STATS_OUTPUTS,
  parseStatsOutputFormat,
  renderStatsOutput,
  type NormalizedStats,
} from "./statsOutput";

type SourceType = "sls" | "custom";

interface StreamId {
  publisher: string;
  player: string;
  description?: string;
}

interface StreamProfile {
  id: string;
  player: string;
  publisher?: string;
  description: string;
  source_type: SourceType;
  source_label: string;
  stats?: PublisherStats | null;
  bound_overlays?: BoundOverlay[];
}

interface BoundOverlay {
  source_id: string;
  display_name: string;
  slug: string;
  preset_name: string;
  enabled: boolean;
}

interface InternalOverlayBinding extends BoundOverlay {
  stream_profile_id: string;
}

interface CustomStream {
  id: string;
  description: string;
  adapter: "belabox";
  statsUrl: string;
  createdAt: string;
  updatedAt: string;
}

interface CustomStreamDocument {
  version: 1;
  streams: CustomStream[];
}

interface PublisherStats extends NormalizedStats {
  bitrate: number;
  buffer: number | null;
  dropped_pkts: number;
  latency: number | null;
  rtt: number | null;
  uptime: number;
  connected: boolean;
  source_type: SourceType;
  recovery_rate?: number | null;
  recovered_pkts?: number;
  missing_pkts?: number;
}

interface RelayCatalog {
  version: 1;
  revision: string;
  servers: Record<string, {
    type: "srtla";
    name: string;
    addr: string;
    port: number;
  }>;
  accounts: Record<string, { name: string; ingest_key: string }>;
}

interface BelaboxStats {
  status?: unknown;
  relayId?: unknown;
  srtlaConnections?: unknown;
  srtConnections?: unknown;
  totalPackets?: unknown;
  missingPackets?: unknown;
  recoveredPackets?: unknown;
  unrecoveredPackets?: unknown;
  recoveryRate?: unknown;
  bitrateMbps?: unknown;
  uptimeSeconds?: unknown;
  publishers?: Record<string, {
    connected?: unknown;
    bitrate?: unknown;
    buffer?: unknown;
    dropped_pkts?: unknown;
    latency?: unknown;
    rtt?: unknown;
    uptime?: unknown;
  }>;
}

const config = {
  port: readInt("PORT", 3732),
  dataRoot: path.resolve(process.env.DATA_ROOT?.trim() || "./data"),
  slsApiUrl: stripTrailingSlash(process.env.SLS_API_URL?.trim() || "http://frame-ingest-video:8080"),
  slsApiKey: required("SLS_API_KEY"),
  relayHost: process.env.PUBLIC_RELAY_HOST?.trim() || "localhost",
  srtlaPort: readInt("SRTLA_PORT", 5000),
  playerPort: readInt("SRT_PLAYER_PORT", 4000),
  senderPort: readInt("SRT_SENDER_PORT", 4001),
  statsPort: readInt("SLS_STATS_PORT", 8080),
  publicBaseUrl: normalizePublicUrl(process.env.STREAMS_PUBLIC_BASE_URL?.trim() || "http://localhost"),
  overlayWizardUrl: process.env.OVERLAY_WIZARD_URL?.trim() || "http://localhost:3733/overlays/setup",
  overlaysApiUrl: stripTrailingSlash(process.env.OVERLAYS_API_URL?.trim() || ""),
  requestTimeoutMs: readInt("REQUEST_TIMEOUT_MS", 3000),
  username: process.env.STREAMS_USERNAME?.trim() || undefined,
  password: process.env.STREAMS_PASSWORD?.trim() || undefined,
};

if (Boolean(config.username) !== Boolean(config.password)) {
  throw new Error("STREAMS_USERNAME and STREAMS_PASSWORD must be configured together");
}

const app = express();
const publicDir = path.resolve(process.cwd(), "public");
const customStatePath = path.join(config.dataRoot, "state/custom-streams.json");
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.get("/healthz", async (_request, response) => {
  try {
    const upstream = await upstreamFetch("/health", {}, false);
    response.json({
      ok: true,
      service: "frame-streams",
      receiver: upstream.ok ? "ready" : "unavailable",
    });
  } catch {
    response.json({ ok: true, service: "frame-streams", receiver: "unavailable" });
  }
});

app.get("/internal/streams", requireInternalAuth, async (_request, response, next) => {
  try {
    response.json({ streams: await readProfiles(false) });
  } catch (error) {
    next(error);
  }
});

app.get("/internal/belabox-relay-catalog", requireInternalAuth, async (_request, response, next) => {
  try {
    const catalog = await buildBelaboxRelayCatalog();
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("ETag", `"${catalog.revision}"`);
    response.json(catalog);
  } catch (error) {
    next(error);
  }
});

app.get("/internal/streams/:id/stats", requireInternalAuth, async (request, response, next) => {
  try {
    const stats = await readStats(validateId(request.params.id, "stream profile ID"));
    response.status(stats ? 200 : 404).json(stats ? { publisher: stats } : { error: "No active stream statistics." });
  } catch (error) {
    next(error);
  }
});

app.get("/stats", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ service: "frame-streams", outputs: STATS_OUTPUTS });
});

app.get("/stats/:id", async (request, response, next) => {
  try {
    const id = validateId(request.params.id, "stream profile ID");
    const [profile, stats] = await Promise.all([readProfile(id), readStats(id)]);
    const format = safeStatsOutputFormat(request.query.output);
    const output = renderStatsOutput(
      format,
      profile ?? fallbackProfile(id, stats),
      stats,
    );
    response.setHeader("Cache-Control", "no-store");
    response.status(output.statusCode).json(output.body);
  } catch (error) {
    next(error);
  }
});

app.use((request, response, next) => {
  if (!config.username || !config.password) {
    next();
    return;
  }
  const credentials = readBasicCredentials(request.header("authorization"));
  if (
    credentials &&
    safeEqual(credentials.username, config.username) &&
    safeEqual(credentials.password, config.password)
  ) {
    next();
    return;
  }
  response.setHeader("WWW-Authenticate", 'Basic realm="FRAME Streams", charset="UTF-8"');
  response.status(401).send("Authentication required.");
});

app.get("/slsui/api/config", (_request, response) => {
  response.json({
    relay_host: config.relayHost,
    ports: {
      srtla: config.srtlaPort,
      player: config.playerPort,
      sender: config.senderPort,
      stats: config.statsPort,
    },
    overlay_wizard_url: config.overlayWizardUrl,
    stats_base_url: `${config.publicBaseUrl}/stats`,
    stats_outputs: STATS_OUTPUTS,
  });
});

app.get("/slsui/api/streams", async (_request, response, next) => {
  try {
    const [streams, overlayBindings] = await Promise.all([readProfiles(true), readOverlayBindings()]);
    response.json({
      streams: streams.map((stream) => ({
        ...stream,
        bound_overlays: overlayBindings.bindings.get(stream.id) ?? [],
      })),
      overlay_bindings_available: overlayBindings.available,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/slsui/api/streams", async (request, response, next) => {
  try {
    const profiles = await readProfiles(false);
    if (request.body?.source_type === "custom") {
      const stream = validateCustomStream(request.body);
      assertUniqueCustomStream(stream, profiles, (await readCustomState()).streams);
      const document = await readCustomState();
      document.streams.push(stream);
      await writeCustomState(document);
      response.status(201).json({ stream: publicCustomProfile(stream) });
      return;
    }

    const stream = validateSlsStream(request.body);
    assertUniqueSlsStream(stream, profiles);
    const upstream = await upstreamFetch("/api/stream-ids", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(stream),
    });
    response.status(upstream.status).json(await upstream.json());
  } catch (error) {
    next(error);
  }
});

app.delete("/slsui/api/streams/:id", async (request, response, next) => {
  try {
    const id = validateId(request.params.id, "stream profile ID");
    const customDocument = await readCustomState();
    const customIndex = customDocument.streams.findIndex((stream) => stream.id === id);
    if (customIndex >= 0) {
      customDocument.streams.splice(customIndex, 1);
      await writeCustomState(customDocument);
      response.json(await withOverlayCleanup(id, { deleted: true }));
      return;
    }

    const upstream = await upstreamFetch(`/api/stream-ids/${encodeURIComponent(id)}`, { method: "DELETE" });
    const result = await responseJson(upstream);
    if (!upstream.ok) {
      response.status(upstream.status).json(result);
      return;
    }
    response.status(upstream.status).json(await withOverlayCleanup(id, result));
  } catch (error) {
    next(error);
  }
});

app.get("/slsui/api/stats/:id", async (request, response, next) => {
  try {
    const id = validateId(request.params.id, "stream profile ID");
    const stats = await readStats(id);
    const output = renderStatsOutput("frame", fallbackProfile(id, stats), stats);
    response.setHeader("Cache-Control", "no-store");
    response.status(output.statusCode).json(output.body);
  } catch (error) {
    next(error);
  }
});

app.use("/slsui/assets", express.static(publicDir, { maxAge: 0 }));
app.get(["/", "/streams", "/slsui"], (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction,
  ) => {
    const status = error instanceof RequestError ? error.status : 500;
    if (status >= 500) {
      console.error("[streams]", error);
    }
    response.status(status).json({ error: errorMessage(error) });
  },
);

void start().catch((error) => {
  console.error("[streams] Startup failed:", error);
  process.exitCode = 1;
});

async function start(): Promise<void> {
  await ensureCustomState();
  app.listen(config.port, () => {
    console.log(`[streams] FRAME Stream Management listening on port ${config.port}`);
  });
}

async function readProfiles(includeStats: boolean): Promise<StreamProfile[]> {
  const [slsStreams, customDocument] = await Promise.all([readSlsProfiles(), readCustomState()]);
  const profiles = [
    ...slsStreams.map(publicSlsProfile),
    ...customDocument.streams.map(publicCustomProfile),
  ];
  if (!includeStats) {
    return profiles;
  }
  return await Promise.all(profiles.map(async (profile) => ({ ...profile, stats: await readStats(profile.id) })));
}

async function buildBelaboxRelayCatalog(): Promise<RelayCatalog> {
  const accounts = Object.fromEntries((await readProfiles(false))
    .filter((profile) => profile.source_type === "sls" && profile.publisher)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((profile) => [
      `frame-${createHash("sha256").update(profile.id).digest("hex").slice(0, 16)}`,
      { name: profile.description, ingest_key: profile.publisher as string },
    ]));
  const content = {
    version: 1 as const,
    servers: {
      "frame-primary": {
        type: "srtla" as const,
        name: `FRAME (${config.relayHost})`,
        addr: config.relayHost,
        port: config.srtlaPort,
      },
    },
    accounts,
  };
  return {
    ...content,
    revision: createHash("sha256").update(JSON.stringify(content)).digest("hex"),
  };
}

async function readProfile(id: string): Promise<StreamProfile | null> {
  return (await readProfiles(false)).find((profile) => profile.id === id) ?? null;
}

async function readSlsProfiles(): Promise<StreamId[]> {
  try {
    const result = await upstreamJson<{ data?: StreamId[] }>("/api/stream-ids");
    return result.data ?? [];
  } catch {
    return [];
  }
}

async function readStats(id: string): Promise<PublisherStats | null> {
  const custom = (await readCustomState()).streams.find((stream) => stream.id === id);
  return custom ? await readBelaboxStats(custom) : await readSlsStats(id);
}

async function readSlsStats(player: string): Promise<PublisherStats | null> {
  const response = await upstreamFetch(`/stats/${encodeURIComponent(player)}`, {}, false);
  if (!response.ok) {
    return null;
  }
  const result = (await response.json()) as { publisher?: Partial<PublisherStats> };
  if (!result.publisher) {
    return null;
  }
  return {
    bitrate: finiteNumber(result.publisher.bitrate),
    buffer: nullableNumber(result.publisher.buffer),
    dropped_pkts: finiteNumber(result.publisher.dropped_pkts),
    latency: nullableNumber(result.publisher.latency),
    rtt: nullableNumber(result.publisher.rtt),
    uptime: finiteNumber(result.publisher.uptime),
    connected: true,
    source_type: "sls",
  };
}

async function readBelaboxStats(stream: CustomStream): Promise<PublisherStats | null> {
  const response = await externalFetch(stream.statsUrl);
  if (!response.ok) {
    return null;
  }
  const result = (await response.json()) as BelaboxStats;
  const publisher = result.publishers
    ? Object.values(result.publishers).find((candidate) => candidate.connected === true)
      ?? Object.values(result.publishers)[0]
    : undefined;
  if (publisher) {
    return {
      bitrate: finiteNumber(publisher.bitrate),
      buffer: nullableNumber(publisher.buffer),
      dropped_pkts: finiteNumber(publisher.dropped_pkts),
      latency: nullableNumber(publisher.latency),
      rtt: nullableNumber(publisher.rtt),
      uptime: finiteNumber(publisher.uptime),
      connected: publisher.connected === true,
      source_type: "custom",
    };
  }
  const connected = finiteNumber(result.srtlaConnections) > 0 || finiteNumber(result.srtConnections) > 0;
  return {
    bitrate: finiteNumber(result.bitrateMbps) * 1000,
    buffer: null,
    dropped_pkts: finiteNumber(result.unrecoveredPackets),
    latency: null,
    rtt: null,
    uptime: finiteNumber(result.uptimeSeconds),
    connected,
    source_type: "custom",
    recovery_rate: parseRecoveryRate(result.recoveryRate),
    recovered_pkts: finiteNumber(result.recoveredPackets),
    missing_pkts: finiteNumber(result.missingPackets),
  };
}

async function externalFetch(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    return await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "FRAME-Stream-Management/0.1" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureCustomState(): Promise<void> {
  await mkdir(path.dirname(customStatePath), { recursive: true });
  try {
    await readFile(customStatePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeCustomState({ version: 1, streams: [] });
    console.log("[streams] Seeded custom telemetry stream registry.");
  }
  await readCustomState();
}

async function readCustomState(): Promise<CustomStreamDocument> {
  const document = JSON.parse(await readFile(customStatePath, "utf8")) as CustomStreamDocument;
  if (document.version !== 1 || !Array.isArray(document.streams)) {
    throw new Error("Custom stream registry is invalid.");
  }
  return document;
}

async function writeCustomState(document: CustomStreamDocument): Promise<void> {
  await mkdir(path.dirname(customStatePath), { recursive: true });
  const temporary = `${customStatePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  await rename(temporary, customStatePath);
}

function publicSlsProfile(stream: StreamId): StreamProfile {
  return {
    id: stream.player,
    player: stream.player,
    publisher: stream.publisher,
    description: stream.description || stream.player,
    source_type: "sls",
    source_label: "FRAME SRTLA",
  };
}

function publicCustomProfile(stream: CustomStream): StreamProfile {
  return {
    id: stream.id,
    player: stream.id,
    description: stream.description,
    source_type: "custom",
    source_label: "BELABOX telemetry",
  };
}

function fallbackProfile(id: string, stats: PublisherStats | null): StreamProfile {
  return {
    id,
    player: id,
    description: id,
    source_type: stats?.source_type ?? "sls",
    source_label: stats?.source_type === "custom" ? "Custom telemetry" : "FRAME SRTLA",
  };
}

async function withOverlayCleanup(id: string, result: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    const unboundOverlays = await unbindOverlays(id);
    return { ...result, unbound_overlays: unboundOverlays };
  } catch (error) {
    console.warn(`[streams] Stream ${id} was deleted, but overlay cleanup failed: ${errorMessage(error)}`);
    return {
      ...result,
      unbound_overlays: [],
      overlay_cleanup_warning: "The stream was deleted, but overlay presets could not be unbound automatically.",
    };
  }
}

async function upstreamJson<T>(route: string): Promise<T> {
  const response = await upstreamFetch(route);
  if (!response.ok) {
    throw new RequestError(response.status, `Receiver returned ${response.status}`);
  }
  return (await response.json()) as T;
}

async function upstreamFetch(
  route: string,
  init: RequestInit = {},
  authenticated = true,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (authenticated) {
    headers.set("Authorization", `Bearer ${config.slsApiKey}`);
  }
  try {
    return await fetch(`${config.slsApiUrl}${route}`, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function unbindOverlays(id: string): Promise<string[]> {
  if (!config.overlaysApiUrl) {
    return [];
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.overlaysApiUrl}/internal/streams/${encodeURIComponent(id)}/unbind`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.slsApiKey}`,
      },
      signal: controller.signal,
    });
    const result = await responseJson(response);
    if (!response.ok) {
      throw new Error(`Overlay service returned ${response.status}`);
    }
    const unbound = result.unbound_sources ?? result.unbound_presets;
    return Array.isArray(unbound)
      ? unbound.filter((value): value is string => typeof value === "string")
      : [];
  } finally {
    clearTimeout(timer);
  }
}

async function readOverlayBindings(): Promise<{ available: boolean; bindings: Map<string, BoundOverlay[]> }> {
  const bindings = new Map<string, BoundOverlay[]>();
  if (!config.overlaysApiUrl) return { available: false, bindings };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.overlaysApiUrl}/internal/streams/overlay-bindings`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.slsApiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) return { available: false, bindings };
    const result = await response.json() as { bindings?: InternalOverlayBinding[] };
    for (const binding of result.bindings ?? []) {
      if (!isInternalOverlayBinding(binding)) continue;
      const existing = bindings.get(binding.stream_profile_id) ?? [];
      existing.push({
        source_id: binding.source_id,
        display_name: binding.display_name,
        slug: binding.slug,
        preset_name: binding.preset_name,
        enabled: binding.enabled,
      });
      bindings.set(binding.stream_profile_id, existing);
    }
    return { available: true, bindings };
  } catch {
    return { available: false, bindings };
  } finally {
    clearTimeout(timer);
  }
}

function isInternalOverlayBinding(value: unknown): value is InternalOverlayBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Partial<InternalOverlayBinding>;
  return typeof binding.stream_profile_id === "string"
    && typeof binding.source_id === "string"
    && typeof binding.display_name === "string"
    && typeof binding.slug === "string"
    && typeof binding.preset_name === "string"
    && typeof binding.enabled === "boolean";
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

function validateSlsStream(value: unknown): StreamId {
  if (!value || typeof value !== "object") {
    throw new RequestError(400, "Stream body must be an object.");
  }
  const body = value as Record<string, unknown>;
  const publisher = validateId(body.publisher, "publisher");
  const player = validateId(body.player, "player");
  if (publisher === player) {
    throw new RequestError(400, "Publisher and player IDs must be different.");
  }
  const description = validateStreamName(body.description);
  return { publisher, player, description };
}

function validateCustomStream(value: unknown): CustomStream {
  if (!value || typeof value !== "object") {
    throw new RequestError(400, "Stream body must be an object.");
  }
  const body = value as Record<string, unknown>;
  const now = new Date().toISOString();
  return {
    id: `custom_${randomUUID().replaceAll("-", "")}`,
    description: validateStreamName(body.description),
    adapter: "belabox",
    statsUrl: canonicalBelaboxUrl(body.stats_url),
    createdAt: now,
    updatedAt: now,
  };
}

function canonicalBelaboxUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestError(400, "BELABOX relay stats URL or relay ID is required.");
  }
  const input = value.trim();
  const candidate = input.includes("://") ? input : `https://stats.srt.belabox.net/${input}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new RequestError(400, "Enter a valid BELABOX relay stats URL or relay ID.");
  }
  const relayId = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLocaleLowerCase() !== "stats.srt.belabox.net" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    relayId.length !== 1 ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(relayId[0])
  ) {
    throw new RequestError(400, "Only HTTPS stats.srt.belabox.net relay URLs or BELABOX relay IDs are supported.");
  }
  return `https://stats.srt.belabox.net/${relayId[0]}`;
}

function validateStreamName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RequestError(400, "Stream name is required.");
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length > 160) {
    throw new RequestError(400, "Stream name must be 160 characters or fewer.");
  }
  return name;
}

function assertUniqueSlsStream(stream: StreamId, existing: StreamProfile[]): void {
  assertUniqueName(stream.description ?? "", existing);
  const keys = new Set(existing.flatMap((candidate) => [candidate.publisher, candidate.player]).filter(Boolean));
  if (keys.has(stream.publisher) || keys.has(stream.player)) {
    throw new RequestError(409, "A stream already uses one of those private routing keys. Regenerate the keys and try again.");
  }
}

function assertUniqueCustomStream(stream: CustomStream, existing: StreamProfile[], customStreams: CustomStream[]): void {
  assertUniqueName(stream.description, existing);
  if (customStreams.some((candidate) => candidate.statsUrl === stream.statsUrl)) {
    throw new RequestError(409, "That BELABOX relay is already connected to a stream profile.");
  }
}

function assertUniqueName(name: string, existing: StreamProfile[]): void {
  const normalized = normalizeStreamName(name);
  if (existing.some((candidate) => normalizeStreamName(candidate.description) === normalized)) {
    throw new RequestError(409, `A stream named "${name}" already exists.`);
  }
}

function normalizeStreamName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function validateId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{3,128}$/.test(value)) {
    throw new RequestError(400, `${label} must use 3-128 letters, numbers, underscores, or hyphens.`);
  }
  return value;
}

function finiteNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseRecoveryRate(value: unknown): number | null {
  if (typeof value === "string" && value.trim().toLocaleUpperCase() === "N/A") {
    return null;
  }
  return nullableNumber(value);
}

function safeStatsOutputFormat(value: unknown) {
  try {
    return parseStatsOutputFormat(value);
  } catch (error) {
    throw new RequestError(400, errorMessage(error));
  }
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

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function readInt(name: string, fallback: number): number {
  const value = process.env[name]?.trim();
  const parsed = value ? Number.parseInt(value, 10) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return parsed;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBasicCredentials(authorization: string | undefined): {
  username: string;
  password: string;
} | null {
  if (!authorization?.startsWith("Basic ")) {
    return null;
  }
  try {
    const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator < 0
      ? null
      : { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
