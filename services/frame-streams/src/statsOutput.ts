export type StatsOutputFormat = "frame" | "bbox_receiver" | "belabox";

export interface StatsOutputDescriptor {
  id: StatsOutputFormat;
  label: string;
  description: string;
  query: string;
}

export interface StatsOutputProfile {
  id: string;
  description?: string;
  source_type?: string;
}

export interface NormalizedStats {
  bitrate: number;
  buffer: number | null;
  dropped_pkts: number;
  latency: number | null;
  rtt: number | null;
  uptime: number | null;
  connected: boolean;
  source_type: string;
  recovery_rate?: number | null;
  recovered_pkts?: number;
  missing_pkts?: number;
}

export const STATS_OUTPUTS: StatsOutputDescriptor[] = [
  {
    id: "bbox_receiver",
    label: "SLS-compatible statistics",
    description: "Default public stats for NOALBS, IRL+ Chat and SLS integrations.",
    query: "",
  },
  {
    id: "bbox_receiver",
    label: "BBox receiver statistics",
    description: "Explicit SLS-compatible output for existing BBox receiver integrations.",
    query: "output=bbox_receiver",
  },
  {
    id: "belabox",
    label: "BELABOX-compatible statistics",
    description: "BELABOX-style publisher telemetry. Use publisher ID live if required.",
    query: "output=belabox",
  },
  {
    id: "frame",
    label: "FRAME statistics",
    description: "Normalized FRAME telemetry JSON for overlays and diagnostics.",
    query: "output=frame",
  },
];

export function parseStatsOutputFormat(value: unknown): StatsOutputFormat {
  if (typeof value !== "string" || !value.trim()) return "bbox_receiver";
  const normalized = value.trim().toLocaleLowerCase().replace(/[-\s]+/g, "_");
  if (["bbox", "bbox_receiver", "datagutt", "datagutt_bbox_receiver"].includes(normalized)) {
    return "bbox_receiver";
  }
  if (normalized === "frame" || normalized === "native" || normalized === "json") {
    return "frame";
  }
  if (normalized === "belabox") return "belabox";
  throw new Error(`Unsupported stats output adapter "${value}".`);
}

export function renderStatsOutput(
  format: StatsOutputFormat,
  profile: StatsOutputProfile,
  stats: NormalizedStats | null,
): { statusCode: number; body: Record<string, unknown> } {
  if (format === "bbox_receiver") {
    return { statusCode: 200, body: renderBboxReceiverOutput(profile, stats) };
  }
  if (format === "belabox") {
    const connected = stats?.connected === true;
    return { statusCode: 200, body: { publishers: { live: {
      connected,
      latency: connected ? finite(stats.latency) : 0,
      network: 0,
      bitrate: connected ? Math.round(finite(stats.bitrate)) : 0,
      rtt: connected ? finite(stats.rtt) : 0,
      dropped_pkts: connected ? Math.round(finite(stats.dropped_pkts)) : 0,
    } }, consumers: [] } };
  }
  return { statusCode: stats ? 200 : 404, body: { stats } };
}

function renderBboxReceiverOutput(profile: StatsOutputProfile, stats: NormalizedStats | null): Record<string, unknown> {
  if (!stats || stats.connected === false) {
    return { publishers: {}, status: "ok" };
  }
  return {
    publishers: {
      [publicPublisherName(profile)]: {
        bitrate: Math.round(finite(stats.bitrate)),
        pktRcvDrop: Math.round(finite(stats.dropped_pkts)),
        pktRcvLoss: Math.round(finite(stats.missing_pkts)),
        bytesRcvDrop: 0,
        bytesRcvLoss: 0,
        mbpsRecvRate: mbps(stats.bitrate),
        rtt: finite(stats.rtt),
        msRcvBuf: Math.round(finite(stats.buffer)),
        mbpsBandwidth: mbps(stats.bitrate),
        latency: nullable(stats.latency),
        uptime: Math.round(finite(stats.uptime)),
        connected: true,
      },
    },
    status: "ok",
  };
}

function publicPublisherName(profile: StatsOutputProfile): string {
  return `live/stream/${profile.id}`;
}

function mbps(kbps: unknown): number {
  return Number((finite(kbps) / 1000).toFixed(3));
}

function nullable(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finite(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
