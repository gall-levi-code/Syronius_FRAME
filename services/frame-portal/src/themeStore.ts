import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ThemeProfile {
  id: string;
  name: string;
  themeColor: string;
  custom?: boolean;
  palettes: Record<"day" | "night", Record<string, string>>;
}

export interface ThemeState {
  mode: "day" | "night";
  profileId: string;
  customProfiles: ThemeProfile[];
  profile: ThemeProfile;
  updated_at: string;
}

const DEFAULT_PROFILE: ThemeProfile = {
  id: "frame-blue",
  name: "Frame Blue",
  themeColor: "#2cb4fb",
  custom: false,
  palettes: {
    day: {
      page: "#eef7fc",
      panel: "#ffffff",
      panelStrong: "#e4f4fc",
      panelMuted: "#f5fbfe",
      border: "#b8d9ea",
      borderSoft: "#8dc4df",
      label: "#526d7e",
      text: "#132634",
      accent: "#087fbd",
      accentStrong: "#087fbd",
      accentSoft: "#d8f1fd",
      accentBorder: "#2cb4fb",
      accentContrast: "#073d5f",
      danger: "#ad2f45",
      warning: "#9d6d0c",
      good: "#20804b",
      toggleNightBg: "#dff4ff",
      toggleNightText: "#087fc0",
      toggleDayBg: "#fff6d5",
      toggleDayText: "#8a5e00",
    },
    night: {
      page: "#07111b",
      panel: "#0d1824",
      panelStrong: "#122235",
      panelMuted: "#101c2a",
      border: "#20364b",
      borderSoft: "#2a4056",
      label: "#91a6bb",
      text: "#f5f7fb",
      accent: "#2cb4fb",
      accentStrong: "#74d1ff",
      accentSoft: "#082f49",
      accentBorder: "#1a85c0",
      accentContrast: "#d9f3ff",
      danger: "#ff7890",
      warning: "#ffd36e",
      good: "#6ee7a4",
      toggleNightBg: "#dff4ff",
      toggleNightText: "#087fc0",
      toggleDayBg: "#fff6d5",
      toggleDayText: "#8a5e00",
    },
  },
};

export function defaultThemeState(): ThemeState {
  return {
    mode: "night",
    profileId: DEFAULT_PROFILE.id,
    customProfiles: [],
    profile: DEFAULT_PROFILE,
    updated_at: new Date(0).toISOString(),
  };
}

export async function readTheme(file: string): Promise<ThemeState> {
  try {
    return normalizeThemeState(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return defaultThemeState();
  }
}

export async function writeTheme(file: string, value: unknown): Promise<ThemeState> {
  const next = normalizeThemeState(value);
  const state = { ...next, updated_at: new Date().toISOString() };
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
  await rename(temporary, file);
  return state;
}

function normalizeThemeState(value: unknown): ThemeState {
  const record = objectValue(value);
  const fallback = defaultThemeState();
  const profile = normalizeProfile(record.profile) || fallback.profile;
  const customProfiles = arrayValue(record.customProfiles).map(normalizeProfile).filter(isThemeProfile);
  const profileId = cleanText(record.profileId, profile.id);
  return {
    mode: record.mode === "day" ? "day" : "night",
    profileId,
    customProfiles,
    profile,
    updated_at: cleanText(record.updated_at, fallback.updated_at),
  };
}

function normalizeProfile(value: unknown): ThemeProfile | null {
  const record = objectValue(value);
  const palettes = normalizePalettes(record.palettes);
  if (!palettes) return null;
  return {
    id: cleanText(record.id, DEFAULT_PROFILE.id),
    name: cleanText(record.name, "Custom Theme"),
    themeColor: cleanText(record.themeColor, DEFAULT_PROFILE.themeColor),
    custom: record.custom === true,
    palettes,
  };
}

function normalizePalettes(value: unknown): ThemeProfile["palettes"] | null {
  const record = objectValue(value);
  const day = colorMap(record.day);
  const night = colorMap(record.night);
  return day && night ? { day, night } : null;
}

function colorMap(value: unknown): Record<string, string> | null {
  const record = objectValue(value);
  const entries = Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && /^#[0-9a-f]{6}$/i.test(entry[1]))
    .slice(0, 64);
  return entries.length ? Object.fromEntries(entries) : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, 40) : [];
}

function cleanText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : fallback;
}

function isThemeProfile(value: ThemeProfile | null): value is ThemeProfile {
  return value !== null;
}
