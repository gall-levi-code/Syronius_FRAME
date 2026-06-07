import { readFile } from "node:fs/promises";
import type { AppConfig } from "./config";
import type { PortalTool, StackConfig } from "./types";
import type { ServiceSummary } from "./types";

export interface LoadedStackConfig {
  config: StackConfig;
  source: "file" | "fallback";
}

const FALLBACK_ROUTES: Record<string, string> = {
  dashboard: "/dashboard",
  status: "/status",
  video_relay_ui: "/streams",
  overlays_root: "/overlays",
  overlays_wizard: "/overlays/wizard",
  photo_gallery: "/gallery",
  today_gallery: "/today/gallery",
  today_viewer: "/today/viewer",
  today_remote: "/today/remote",
  audio_admin: "/audio/admin",
  audio_capture: "/audio/capture",
  audio_listen: "/audio/listen",
  audio_hls: "/audio/hls",
  discord_audio_bridge_root: "/bridge",
};

const TOOL_DEFINITIONS: Array<
  Omit<PortalTool, "route" | "enabled" | "readiness"> & { routeKey: string; serviceName: string }
> = [
  {
    id: "streams",
    name: "Stream Management",
    description: "Manage relay profiles and active IRL streams.",
    routeKey: "video_relay_ui",
    capability: "frame-video-relay",
    serviceName: "frame-streams",
  },
  {
    id: "overlays",
    name: "Overlay Wizard",
    description: "Configure telemetry overlays and OBS browser sources.",
    routeKey: "overlays_wizard",
    capability: "frame-overlays",
    serviceName: "frame-overlays",
  },
  {
    id: "gallery",
    name: "Photo Gallery",
    description: "Browse the published FRAME photo gallery.",
    routeKey: "photo_gallery",
    capability: "frame-photo-gallery",
    serviceName: "frame-gallery",
  },
  {
    id: "today",
    name: "Today Tools",
    description: "Open the viewer and remote controls for today's stream.",
    routeKey: "today_viewer",
    capability: "frame-photo-todaytools",
    serviceName: "frame-today",
  },
  {
    id: "audio",
    name: "Audio Monitor",
    description: "Open the browser-capture audio listener.",
    routeKey: "audio_listen",
    capability: "frame-audio-relay",
    serviceName: "frame-audio",
  },
  {
    id: "audio-bridge",
    name: "Discord Audio Bridge",
    description: "Check the Discord voice-to-OBS bridge service.",
    routeKey: "discord_audio_bridge_root",
    capability: "frame-discord-audio-bridge",
    serviceName: "frame-audio-bridge",
  },
  {
    id: "status",
    name: "System Status",
    description: "Review FRAME service health, alerts, and logs.",
    routeKey: "status",
    serviceName: "frame-portal",
  },
];

export async function loadStackConfig(appConfig: AppConfig): Promise<LoadedStackConfig> {
  try {
    const text = await readFile(appConfig.stackConfigPath, "utf8");
    const parsed = JSON.parse(text) as Partial<StackConfig>;
    return {
      source: "file",
      config: {
        mode: parsed.mode === "HYBRID" ? "HYBRID" : "LAN",
        capabilities: parsed.capabilities ?? {},
        routes: normalizeRoutes(parsed.routes),
        public_route_prefixes: parsed.public_route_prefixes ?? [],
      },
    };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code !== "ENOENT") {
      console.warn(`[portal] Unable to read stack config: ${String(error)}`);
    }
    return {
      source: "fallback",
      config: {
        mode: appConfig.mode,
        capabilities: {
          "frame-discord-audio-bridge": true,
        },
        routes: { ...FALLBACK_ROUTES },
        public_route_prefixes: ["/dashboard", "/status"],
      },
    };
  }
}

export function buildPortalTools(
  loadedStackConfig: LoadedStackConfig,
  services: ServiceSummary[],
): PortalTool[] {
  const { config } = loadedStackConfig;
  const servicesByName = new Map(services.map((service) => [service.name, service]));
  return TOOL_DEFINITIONS.map(({ routeKey, serviceName, ...definition }) => {
    const enabled = definition.capability ? config.capabilities[definition.capability] === true : true;
    const service = servicesByName.get(serviceName);
    return {
      ...definition,
      route:
        definition.id === "audio-bridge"
          ? `${config.routes.status || FALLBACK_ROUTES.status}#services`
          : config.routes[routeKey] || FALLBACK_ROUTES[routeKey],
      enabled,
      readiness: getToolReadiness(loadedStackConfig, definition.id, enabled, service),
    };
  });
}

function getToolReadiness(
  loadedStackConfig: LoadedStackConfig,
  toolId: string,
  enabled: boolean,
  service: ServiceSummary | undefined,
): PortalTool["readiness"] {
  if (!enabled) {
    return "disabled";
  }
  if (
    loadedStackConfig.source === "fallback" &&
    toolId !== "audio-bridge" &&
    toolId !== "status"
  ) {
    return "needs-setup";
  }
  if (service?.status !== "running" || service.health === "unhealthy") {
    return "offline";
  }
  return service.health === "unknown" ? "needs-setup" : "ready";
}

function normalizeRoutes(routes: Partial<Record<string, string>> | undefined): Record<string, string> {
  const normalized = { ...FALLBACK_ROUTES };
  for (const [key, value] of Object.entries(routes ?? {})) {
    if (typeof value === "string" && value.startsWith("/")) {
      normalized[key] = value;
    }
  }
  return normalized;
}
