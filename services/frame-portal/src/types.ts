export type FrameMode = "LAN" | "HYBRID";
export type ServiceStatus = "running" | "stopped" | "error" | "unknown";
export type ServiceHealth = "healthy" | "unhealthy" | "starting" | "unknown";

export interface StackConfig {
  mode: FrameMode;
  capabilities: Record<string, boolean>;
  routes: Record<string, string>;
  public_route_prefixes: string[];
}

export interface PortalLink {
  label: string;
  url: string;
  openable: boolean;
}

export interface PortalLinkGroup {
  label: string;
  links: PortalLink[];
}

export interface PortalTool {
  id: string;
  name: string;
  description: string;
  route: string;
  enabled: boolean;
  capability?: string;
  access: "public" | "lan-only";
  accessible: boolean;
  readiness: "ready" | "needs-setup" | "offline" | "disabled";
  link_groups: PortalLinkGroup[];
}

export interface ServiceSummary {
  name: string;
  status: ServiceStatus;
  health: ServiceHealth;
  uptime_seconds: number | null;
}

export interface StatusResponse {
  generated_at: string;
  mode: FrameMode;
  services: ServiceSummary[];
  last_photo: { at: string; base: string } | null;
  last_ingest: { at: string; stream_id: string } | null;
  audio_streams: Array<{ stream_id: string; status: "live" | "idle" | "offline"; listener_count: number }>;
  discord_audio_bridges: Array<{
    guild_id: string;
    status: "active" | "idle" | "offline" | "error";
    channel_name: string | null;
    active_mix_count: number;
    active_streamers: string[];
    speaking_users: string[];
    bot_connected: boolean;
    voice_connection: string;
    clients: { audio: number; overlay: number; control: number };
    engine_health: "ok" | "warn" | "bad" | "idle" | "unknown";
  }>;
  disk: {
    used_bytes: number;
    free_bytes: number;
    total_bytes: number;
    percent_used: number;
  };
  alerts: Array<{ level: "warn" | "error"; message: string }>;
}
