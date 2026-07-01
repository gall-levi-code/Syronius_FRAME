import { randomBytes } from "node:crypto";

export const SCHEMA_VERSION = "2.0" as const;

export type OverlayType = "connectivity" | "upload_progress" | "latest_photo";
export type IngestAdapterId = "web_upload" | "ftp" | "belabox_agent";
export type DockPosition = "tl" | "t" | "tr" | "l" | "c" | "r" | "bl" | "b" | "br";

export interface OverlayLayout {
  dock: DockPosition;
  pad: number;
  growth_x?: "left" | "right" | "center";
  growth_y?: "up" | "down" | "center";
  scale?: number;
  width_px?: number;
  height_px?: number;
}

export interface OverlayTheme {
  text_color?: string;
  muted_color?: string;
  good_color?: string;
  warn_color?: string;
  bad_color?: string;
  plot_primary?: string;
  plot_secondary?: string;
  panel_bg_color?: string;
  panel_border_color?: string;
  panel_glow_color?: string;
  block_bg_color?: string;
  block_border_color?: string;
  panel_bg_alpha?: number;
  block_bg_alpha?: number;
  bg_opacity_good?: number;
  bg_opacity_warn?: number;
  bg_opacity_bad?: number;
  border_radius_px?: number;
  backdrop_blur_px?: number;
  panel_padding_px?: number;
  block_padding_px?: number;
  block_gap_px?: number;
  panel_border_width_px?: number;
  block_border_width_px?: number;
  glow_blur_px?: number;
  glow_spread_px?: number;
  glow_offset_x_px?: number;
  glow_offset_y_px?: number;
  font_size_base_px?: number;
  font_family?: string;
  font_weight?: number;
  subheader_font_family?: string;
  subheader_font_size_px?: number;
  subheader_font_weight?: number;
}

export interface ConnectivityConfig {
  poll_ms?: number;
  bitrate_good_min?: number;
  bitrate_warn_min?: number;
  rtt_warn_max?: number;
  rtt_bad_max?: number;
  bitrate_meter_max?: number;
  bitrate_meter_height_px?: number;
  bitrate_meter_radius_px?: number;
  chart_bitrate_max?: number;
  chart_rtt_max?: number;
  chart_bitrate_line_width_px?: number;
  chart_rtt_line_width_px?: number;
  chart_warn_line_width_px?: number;
  chart_bitrate_line_style?: "solid" | "dashed" | "dotted";
  chart_rtt_line_style?: "solid" | "dashed" | "dotted";
  chart_warn_line_style?: "solid" | "dashed" | "dotted";
  history_len?: number;
  bitrate_streak_warn?: number;
  bitrate_streak_bad?: number;
  rtt_streak_warn?: number;
  rtt_streak_bad?: number;
  use_rtt_in_good?: boolean;
  compact_when_good?: boolean;
  show_name?: boolean;
  show_status?: boolean;
  show_bitrate?: boolean;
  show_bitrate_in_good?: boolean;
  show_rtt?: boolean;
  show_latency?: boolean;
  show_buffer?: boolean;
  show_chart?: boolean;
  show_chart_legend?: boolean;
  show_meter?: boolean;
  show_server?: boolean;
  show_dropped?: boolean;
  show_uptime?: boolean;
  show_recovery?: boolean;
  telemetry_order?: string[];
  telemetry_columns?: "auto" | "all" | number;
  telemetry_block_width_px?: number;
  telemetry_block_height_px?: number;
  no_signal_behavior?: "show_offline" | "hide";
  no_signal_label?: string;
  label_style?: "svg" | "text";
  transition_ms?: number;
}

export interface UploadProgressConfig {
  active_poll_ms?: number;
  idle_poll_ms?: number;
  complete_poll_ms?: number;
  complete_hide_ms?: number;
  fetch_timeout_ms?: number;
  show_speed?: boolean;
  show_elapsed?: boolean;
  show_sent?: boolean;
  width_px?: number;
  idle_behavior?: "show_idle" | "hide";
  idle_label?: string;
}

export interface LatestPhotoConfig {
  poll_ms?: number;
  show_count?: boolean;
  show_filename?: boolean;
  show_thumbnail?: boolean;
  thumbnail_size_px?: number;
  no_photos_behavior?: "show_empty" | "hide";
  no_photos_label?: string;
}

interface DesignBase {
  name: string;
  description?: string;
  tags?: string[];
  enabled: boolean;
  window_title?: string;
  layout: OverlayLayout;
  theme?: OverlayTheme;
}

export interface ConnectivityDesign extends DesignBase {
  type: "connectivity";
  config: ConnectivityConfig;
}

export interface UploadProgressDesign extends DesignBase {
  type: "upload_progress";
  config: UploadProgressConfig;
}

export interface LatestPhotoDesign extends DesignBase {
  type: "latest_photo";
  config: LatestPhotoConfig;
}

export type OverlayDesign = ConnectivityDesign | UploadProgressDesign | LatestPhotoDesign;

export type BuiltinTemplate = OverlayDesign & {
  id: string;
  builtin: true;
  readonly: true;
};

export type UserPreset = OverlayDesign & {
  id: string;
  template_id: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type OverlayDataSource =
  | { kind: "stream"; stream_profile_id: string | null }
  | { kind: "upload_progress"; adapters: IngestAdapterId[] }
  | { kind: "latest_photo" }
  | { kind: "none" };

export interface OverlaySource {
  id: string;
  slug: string;
  source_key: string;
  display_name: string;
  preset_id: string;
  enabled: boolean;
  data_source: OverlayDataSource;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface OverlayDocumentV2 {
  schema_version: typeof SCHEMA_VERSION;
  revision: number;
  default_template_id: string;
  default_template_ids: Partial<Record<OverlayType, string>>;
  templates: BuiltinTemplate[];
  presets: UserPreset[];
  sources: OverlaySource[];
  legacy_aliases: Record<string, string>;
}

export interface LegacyPresetDocument {
  schema_version: string;
  default_preset_id: string;
  presets: Array<Record<string, unknown>>;
}

export function createSourceKey(): string {
  return randomBytes(18).toString("base64url");
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function isOverlayDocumentV2(value: unknown): value is OverlayDocumentV2 {
  return Boolean(value && typeof value === "object" && (value as { schema_version?: unknown }).schema_version === SCHEMA_VERSION);
}

export function isLegacyPresetDocument(value: unknown): value is LegacyPresetDocument {
  const candidate = value as LegacyPresetDocument | null;
  return Boolean(candidate && typeof candidate === "object" && Array.isArray(candidate.presets) && candidate.schema_version !== SCHEMA_VERSION);
}

export function dataSourceForType(type: OverlayType, streamProfileId: string | null = null): OverlayDataSource {
  if (type === "connectivity") return { kind: "stream", stream_profile_id: streamProfileId };
  if (type === "upload_progress") return { kind: "upload_progress", adapters: ["web_upload"] };
  return { kind: "latest_photo" };
}
