import type { AppConfig } from "./config";
import type { PortalLink, PortalLinkGroup, StackConfig } from "./types";

type Fetcher = typeof fetch;
type JsonObject = Record<string, unknown>;

export async function collectToolLinkGroups(
  config: AppConfig,
  stack: StackConfig,
  request: Fetcher = fetch,
): Promise<Record<string, PortalLinkGroup[]>> {
  const enabled = (capability: string) => stack.capabilities[capability] === true;
  const [streams, overlays, audio, belabox] = await Promise.all([
    enabled("frame-video-relay")
      ? safely("Stream Management", () => streamLinks(config, stack.routes, request))
      : [],
    enabled("frame-overlays")
      ? safely("Overlays", () => overlayLinks(config, stack.routes, request))
      : [],
    enabled("frame-audio-relay")
      ? safely("Audio Monitor", () => audioLinks(config, stack.routes, request))
      : [],
    enabled("frame-belabox-manager")
      ? safely("Belabox", () => belaboxLinks(config, stack.routes, request))
      : [],
  ]);
  return { streams, overlays, audio, belabox };
}

async function streamLinks(
  config: AppConfig,
  routes: Record<string, string>,
  request: Fetcher,
): Promise<PortalLinkGroup[]> {
  const managementAuth = basicAuthorization(config.streamsUsername, config.streamsPassword);
  const registryPath = config.streamsApiKey ? "/internal/streams" : "/slsui/api/streams";
  const registryAuth = config.streamsApiKey ? `Bearer ${config.streamsApiKey}` : managementAuth;
  const [result, settings] = await Promise.all([
    getJson(config.streamsApiUrl, registryPath, config.requestTimeoutMs, request, registryAuth),
    optionalJson("Stream connection", () =>
      getJson(config.streamsApiUrl, "/slsui/api/config", config.requestTimeoutMs, request, managementAuth)),
  ]);
  const relayHost = validRelayHost(settings.relay_host);
  const ports = object(settings.ports);
  const statsRoot = validRoute(routes.video_relay_stats, "/stats");

  return array(result.streams).flatMap((value) => {
    const stream = object(value);
    const id = token(stream.id, 3, 128);
    if (!id) return [];
    const links: PortalLink[] = [];
    if (stream.source_type === "sls" && relayHost && ports) {
      const publisher = token(stream.publisher, 3, 128);
      const player = token(stream.player, 3, 128);
      const srtla = port(ports.srtla);
      const sender = port(ports.sender);
      const receiver = port(ports.player);
      if (publisher && srtla) links.push(copyLink("SRTLA publisher", `srtla://${relayHost}:${srtla}?streamid=${publisher}`));
      if (publisher && sender) links.push(copyLink("Direct SRT publisher", `srt://${relayHost}:${sender}?streamid=${publisher}`));
      if (player && receiver) links.push(copyLink("SRT player", `srt://${relayHost}:${receiver}?streamid=${player}`));
    }
    const statsUrl = `${statsRoot}/${encodeURIComponent(id)}`;
    links.push(
      { label: "FRAME statistics", url: statsUrl, openable: true },
      { label: "BBox Receiver statistics", url: `${statsUrl}?output=bbox_receiver`, openable: true },
    );
    return [{ label: cleanLabel(stream.description, id), links }];
  });
}

async function overlayLinks(
  config: AppConfig,
  routes: Record<string, string>,
  request: Fetcher,
): Promise<PortalLinkGroup[]> {
  const result = await getJson(
    config.overlaysApiUrl,
    "/overlays/api/catalog",
    config.requestTimeoutMs,
    request,
    basicAuthorization(config.overlaysUsername, config.overlaysPassword),
  );
  const root = validRoute(routes.overlays_root, "/overlays");
  const enabledPresets = new Set(array(result.presets).flatMap((value) => {
    const preset = object(value);
    const id = token(preset.id, 2, 64);
    return id && preset.enabled === true && (preset.type === "connectivity" || preset.type === "upload_progress") ? [id] : [];
  }));
  return array(result.sources).flatMap((value) => {
    const source = object(value);
    const slug = typeof source.slug === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(source.slug) ? source.slug : "";
    const key = typeof source.source_key === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(source.source_key)
      ? source.source_key
      : "";
    if (!slug || !key || source.enabled !== true || !enabledPresets.has(String(source.preset_id))) return [];
    return [{
      label: cleanLabel(source.display_name, slug),
      links: [{
        label: "OBS browser source",
        url: `${root}/view/${encodeURIComponent(slug)}/${encodeURIComponent(key)}`,
        openable: true,
      }],
    }];
  });
}

async function audioLinks(
  config: AppConfig,
  routes: Record<string, string>,
  request: Fetcher,
): Promise<PortalLinkGroup[]> {
  const result = await getJson(config.audioApiUrl, "/audio/api/streams", config.requestTimeoutMs, request);
  const root = validRoute(routes.audio_listen, "/audio/listen");
  return array(result.streams).flatMap((value) => {
    const stream = object(value);
    const id = token(stream.streamId, 1, 128);
    if (!id) return [];
    return [{
      label: cleanLabel(stream.name, id),
      links: [{ label: "Listener page", url: `${root}/${encodeURIComponent(id)}`, openable: true }],
    }];
  });
}

async function belaboxLinks(
  config: AppConfig,
  routes: Record<string, string>,
  request: Fetcher,
): Promise<PortalLinkGroup[]> {
  const result = await getJson(config.belaboxApiUrl, "/belabox/api/status", config.requestTimeoutMs, request);
  const remote = object(result.remote_belaui);
  const provisioning = object(result.provisioning);
  if (!provisioning) return [];
  const encoderRemoteEnabled = remote.enabled === true;
  const root = validRoute(routes.belabox_remote, "/belabox/remote");
  const mixerRoot = validRoute(routes.belabox_mixer, "/belabox/mixer");
  const liveDevices = new Map<string, JsonObject>();
  for (const value of array(result.devices)) {
    const device = object(value);
    const id = typeof device.device_id === "string" && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(device.device_id)
      ? device.device_id
      : "";
    if (id) liveDevices.set(id, device);
  }
  return array(provisioning.devices).flatMap((value) => {
    const device = object(value);
    const id = typeof device.device_id === "string" && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(device.device_id)
      ? device.device_id
      : "";
    if (!id) return [];
    const live = object(liveDevices.get(id));
    const mixer = object(object(live.telemetry).video_mixer);
    const links: PortalLink[] = [];
    if (encoderRemoteEnabled) {
      links.push({ label: "Encoder remote", url: `${root}?key=${encodeURIComponent(id)}`, openable: true });
    }
    if (mixer.installed === true && mixer.target === "video_mixer") {
      links.push({ label: "Video Mixer", url: `${mixerRoot}?key=${encodeURIComponent(id)}`, openable: true });
    }
    if (!links.length) return [];
    return [{
      label: cleanLabel(device.display_name, id),
      links,
    }];
  });
}

async function getJson(
  baseUrl: string,
  pathname: string,
  timeoutMs: number,
  request: Fetcher,
  authorization?: string,
): Promise<JsonObject> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers({ Accept: "application/json" });
  if (authorization) headers.set("Authorization", authorization);
  try {
    const response = await request(`${baseUrl}${pathname}`, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`returned ${response.status}`);
    return object(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

async function safely(label: string, load: () => Promise<PortalLinkGroup[]>): Promise<PortalLinkGroup[]> {
  try {
    return await load();
  } catch (error) {
    warnUnavailable(label, error);
    return [];
  }
}

async function optionalJson(label: string, load: () => Promise<JsonObject>): Promise<JsonObject> {
  try {
    return await load();
  } catch (error) {
    warnUnavailable(label, error);
    return {};
  }
}

function warnUnavailable(label: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  const redacted = detail.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
  console.warn(`[portal] ${label} links unavailable: ${redacted}`);
}

function copyLink(label: string, url: string): PortalLink {
  return { label, url, openable: false };
}

function basicAuthorization(username: string | undefined, password: string | undefined): string | undefined {
  return username && password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : undefined;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function token(value: unknown, minimum: number, maximum: number): string {
  return typeof value === "string"
    && value.length >= minimum
    && value.length <= maximum
    && /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : "";
}

function port(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535 ? parsed : null;
}

function validRelayHost(value: unknown): string {
  const host = typeof value === "string" ? value.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!host || host.length > 253 || host.includes("..")) return "";
  return host.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ? host : "";
}

function validRoute(value: unknown, fallback: string): string {
  const route = typeof value === "string" ? value.replace(/\/+$/, "") : "";
  return /^\/[A-Za-z0-9/_-]*$/.test(route) && !route.includes("//") && !route.includes("..") ? route : fallback;
}

function cleanLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || fallback;
}
