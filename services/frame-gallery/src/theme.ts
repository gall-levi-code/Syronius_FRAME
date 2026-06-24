export type GalleryThemeMode = "system" | "day" | "night";

export interface GalleryPalette {
  background: string;
  topbar: string;
  text: string;
  controlText: string;
  accent: string;
  secondary: string;
  surface: string;
  surfaceStrong: string;
  border: string;
  muted: string;
  danger: string;
  good: string;
  lightboxBackground: string;
  lightboxText: string;
}

export interface GalleryThemeProfile {
  id: string;
  name: string;
  theme_color: string;
  palettes: {
    day: GalleryPalette;
    night: GalleryPalette;
  };
}

export interface GalleryLogo {
  url: string;
  width: number;
  height: number;
  updated_at: string;
}

export interface GalleryBranding {
  brand_name: string;
  gallery_title: string;
  mode: GalleryThemeMode;
  profile_id: string;
  custom_profiles: GalleryThemeProfile[];
  logo: GalleryLogo | null;
  updated_at: string;
}

export interface GalleryBrandingResponse extends GalleryBranding {
  active_profile: GalleryThemeProfile;
  presets: GalleryThemeProfile[];
}

export const CUSTOM_PROFILE_PREFIX = "custom-";
export const DEFAULT_BRAND_NAME = "Syronius FRAME";
export const DEFAULT_GALLERY_TITLE = "Photo Gallery";
const DEFAULT_UPDATED_AT = "1970-01-01T00:00:00.000Z";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const CUSTOM_ID_PATTERN = /^custom-[a-z0-9-]{1,50}$/;
const PALETTE_KEYS = [
  "background",
  "topbar",
  "text",
  "controlText",
  "accent",
  "secondary",
  "surface",
  "surfaceStrong",
  "border",
  "muted",
  "danger",
  "good",
  "lightboxBackground",
  "lightboxText",
] as const satisfies readonly (keyof GalleryPalette)[];

export const PRESET_PROFILES: GalleryThemeProfile[] = [
  buildThemeProfile("frame-blue", "Frame Blue", "#2cb4fb"),
  buildThemeProfile("gallery-gold", "Gallery Gold", "#c8911b"),
  buildThemeProfile("sage-green", "Sage Green", "#4f9f73"),
  buildThemeProfile("rose-coral", "Rose Coral", "#d45d7c"),
  buildThemeProfile("violet-ink", "Violet Ink", "#7c6ff0"),
];

export function createDefaultBranding(): GalleryBranding {
  return {
    brand_name: DEFAULT_BRAND_NAME,
    gallery_title: DEFAULT_GALLERY_TITLE,
    mode: "system",
    profile_id: PRESET_PROFILES[0].id,
    custom_profiles: [],
    logo: null,
    updated_at: DEFAULT_UPDATED_AT,
  };
}

export function normalizeStoredBranding(value: unknown): GalleryBranding {
  const fallback = createDefaultBranding();
  const record = isRecord(value) ? value : {};
  const customProfiles = normalizeCustomProfiles(record.custom_profiles ?? record.custom_profile, fallback.custom_profiles);
  const profileId = normalizeProfileId(record.profile_id, fallback.profile_id, customProfiles);
  return {
    brand_name: cleanText(record.brand_name, fallback.brand_name, 60),
    gallery_title: cleanText(record.gallery_title, fallback.gallery_title, 80),
    mode: normalizeMode(record.mode, fallback.mode),
    profile_id: profileId,
    custom_profiles: customProfiles,
    logo: normalizeLogo(record.logo),
    updated_at: typeof record.updated_at === "string" && record.updated_at ? record.updated_at : fallback.updated_at,
  };
}

export function applyBrandingUpdate(previous: GalleryBranding, value: unknown, updatedAt: string): GalleryBranding {
  const record = isRecord(value) ? value : {};
  const customProfiles = normalizeCustomProfiles(
    record.custom_profiles ?? record.custom_profile ?? previous.custom_profiles,
    previous.custom_profiles,
  );
  const profileId = normalizeProfileId(record.profile_id, previous.profile_id, customProfiles);
  return {
    ...previous,
    brand_name: cleanText(record.brand_name, previous.brand_name, 60),
    gallery_title: cleanText(record.gallery_title, previous.gallery_title, 80),
    mode: normalizeMode(record.mode, previous.mode),
    profile_id: profileId,
    custom_profiles: customProfiles,
    updated_at: updatedAt,
  };
}

export function withLogo(previous: GalleryBranding, logo: GalleryLogo | null, updatedAt: string): GalleryBranding {
  return { ...previous, logo, updated_at: updatedAt };
}

export function toBrandingResponse(config: GalleryBranding): GalleryBrandingResponse {
  return {
    ...config,
    active_profile: activeProfile(config),
    presets: [...PRESET_PROFILES, ...config.custom_profiles],
  };
}

export function buildThemeProfile(id: string, name: string, themeColor: string): GalleryThemeProfile {
  const normalized = normalizeHexColor(themeColor, "#2cb4fb");
  return {
    id,
    name: cleanText(name, id.startsWith(CUSTOM_PROFILE_PREFIX) ? "Custom Preset" : "Gallery Style", 40),
    theme_color: normalized,
    palettes: {
      day: buildPalette(normalized, "day"),
      night: buildPalette(normalized, "night"),
    },
  };
}

function activeProfile(config: GalleryBranding): GalleryThemeProfile {
  return [...PRESET_PROFILES, ...config.custom_profiles].find((profile) => profile.id === config.profile_id)
    || PRESET_PROFILES[0];
}

function normalizeCustomProfiles(value: unknown, fallback: GalleryThemeProfile[]): GalleryThemeProfile[] {
  const values = Array.isArray(value) ? value : isRecord(value) ? [value] : fallback;
  const seen = new Set<string>();
  return values
    .map((item, index) => normalizeCustomProfile(item, fallback[index], index))
    .map((profile, index) => ({ ...profile, id: uniqueCustomId(profile.id, profile.name, index, seen) }));
}

function normalizeCustomProfile(value: unknown, fallback: GalleryThemeProfile | undefined, index: number): GalleryThemeProfile {
  const record = isRecord(value) ? value : {};
  const fallbackColor = fallback?.theme_color || PRESET_PROFILES[0].theme_color;
  const color = normalizeHexColor(record.theme_color, fallbackColor);
  const id = customId(record.id, record.name, index);
  const generated = buildThemeProfile(id, cleanText(record.name, fallback?.name || "Custom Preset", 40), color);
  return {
    ...generated,
    palettes: normalizePalettes(record.palettes, generated.palettes),
  };
}

function normalizeProfileId(value: unknown, fallback: string, customProfiles: GalleryThemeProfile[]): string {
  if (value === "custom" && customProfiles[0]) return customProfiles[0].id;
  if (typeof value === "string" && PRESET_PROFILES.some((profile) => profile.id === value)) return value;
  if (typeof value === "string" && customProfiles.some((profile) => profile.id === value)) return value;
  return PRESET_PROFILES.some((profile) => profile.id === fallback)
    || customProfiles.some((profile) => profile.id === fallback)
    ? fallback
    : PRESET_PROFILES[0].id;
}

function normalizeMode(value: unknown, fallback: GalleryThemeMode): GalleryThemeMode {
  return value === "day" || value === "night" || value === "system" ? value : fallback;
}

function normalizeLogo(value: unknown): GalleryLogo | null {
  if (!isRecord(value)) return null;
  const width = integer(value.width);
  const height = integer(value.height);
  if (!width || !height || typeof value.url !== "string" || typeof value.updated_at !== "string") return null;
  return {
    url: value.url,
    width,
    height,
    updated_at: value.updated_at,
  };
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value === "string" && HEX_COLOR.test(value.trim())) return value.trim().toLowerCase();
  return fallback;
}

function normalizePalettes(value: unknown, fallback: GalleryThemeProfile["palettes"]): GalleryThemeProfile["palettes"] {
  const record = isRecord(value) ? value : {};
  return {
    day: normalizePalette(record.day, fallback.day),
    night: normalizePalette(record.night, fallback.night),
  };
}

function normalizePalette(value: unknown, fallback: GalleryPalette): GalleryPalette {
  const record = isRecord(value) ? value : {};
  return Object.fromEntries(PALETTE_KEYS.map((key) => [key, normalizeHexColor(record[key], fallback[key])])) as unknown as GalleryPalette;
}

function cleanText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : fallback;
}

function integer(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function customId(value: unknown, name: unknown, index: number): string {
  if (typeof value === "string" && CUSTOM_ID_PATTERN.test(value)) return value;
  return `custom-${slug(typeof name === "string" ? name : "") || `preset-${index + 1}`}`;
}

function uniqueCustomId(value: string, name: string, index: number, seen: Set<string>): string {
  let candidate = CUSTOM_ID_PATTERN.test(value) ? value : customId(value, name, index);
  let suffix = 2;
  while (seen.has(candidate) || PRESET_PROFILES.some((profile) => profile.id === candidate)) {
    candidate = `${value}-${suffix}`;
    suffix += 1;
  }
  seen.add(candidate);
  return candidate;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42);
}

function buildPalette(themeColor: string, mode: "day" | "night"): GalleryPalette {
  const base = hexToHsl(themeColor);
  const vivid = clamp(base.s + 14, 58, 86);
  if (mode === "day") {
    return {
      background: hslToHex(base.h, 30, 97),
      topbar: hslToHex(base.h, 30, 99),
      text: hslToHex(base.h, 32, 13),
      controlText: hslToHex(base.h, 32, 13),
      accent: hslToHex(base.h, vivid, 38),
      secondary: hslToHex(base.h + 180, Math.min(vivid, 78), 41),
      surface: "#ffffff",
      surfaceStrong: hslToHex(base.h, 34, 92),
      border: hslToHex(base.h, 24, 76),
      muted: hslToHex(base.h, 16, 38),
      danger: hslToHex(350, 70, 40),
      good: hslToHex(145, 46, 34),
      lightboxBackground: "#05070a",
      lightboxText: "#f5fbff",
    };
  }
  return {
    background: hslToHex(base.h, 36, 8),
    topbar: hslToHex(base.h, 36, 10),
    text: hslToHex(base.h, 28, 94),
    controlText: hslToHex(base.h, 28, 94),
    accent: hslToHex(base.h, vivid, 62),
    secondary: hslToHex(base.h + 180, Math.min(vivid, 78), 64),
    surface: hslToHex(base.h, 34, 13),
    surfaceStrong: hslToHex(base.h, 32, 18),
    border: hslToHex(base.h, 30, 28),
    muted: hslToHex(base.h, 19, 72),
    danger: hslToHex(350, 78, 70),
    good: hslToHex(145, 60, 70),
    lightboxBackground: "#02080c",
    lightboxText: "#e9f8ff",
  };
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const red = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const green = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: lightness * 100 };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue: number;
  if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  return { h: hue * 60, s: saturation * 100, l: lightness * 100 };
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const h = wrapHue(hue) / 360;
  const s = clamp(saturation, 0, 100) / 100;
  const l = clamp(lightness, 0, 100) / 100;
  if (s === 0) return rgbToHex(l, l, l);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return rgbToHex(hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3));
}

function hueToRgb(p: number, q: number, t: number): number {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => Math.round(clamp(channel, 0, 1) * 255).toString(16).padStart(2, "0")).join("")}`;
}

function wrapHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
