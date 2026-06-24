export type StatsOutputFormat = "frame" | "bbox_receiver";

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
  uptime: number;
  connected: boolean;
  source_type: string;
  recovery_rate?: number | null;
  recovered_pkts?: number;
  missing_pkts?: number;
}

export const STATS_OUTPUTS: StatsOutputDescriptor[] = [
  {
    id: "frame",
    label: "FRAME native",
    description: "Normalized FRAME telemetry JSON for overlays and diagnostics.",
    query: "",
  },
  {
    id: "bbox_receiver",
    label: "Datagutt BBox Receiver",
    description: "Compatibility JSON for IRL+ Chat and BBox-receiver style stats lookups.",
    query: "output=bbox_receiver",
  },
];

export function parseStatsOutputFormat(value: unknown): StatsOutputFormat {
  if (typeof value !== "string" || !value.trim()) return "frame";
  const normalized = value.trim().toLocaleLowerCase().replace(/[-\s]+/g, "_");
  if (["bbox", "bbox_receiver", "datagutt", "datagutt_bbox_receiver"].includes(normalized)) {
    return "bbox_receiver";
  }
  if (normalized === "frame" || normalized === "native" || normalized === "json") {
    return "frame";
  }
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
        rtt: nullable(stats.rtt),
        msRcvBuf: nullable(stats.buffer),
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
