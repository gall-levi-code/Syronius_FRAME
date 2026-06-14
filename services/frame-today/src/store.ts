import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BASE_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface LatestPublication {
  updated_at: string;
  date_folder: string;
  latest_base: string | null;
  count_today: number;
}

export interface TodayPhoto {
  base: string;
  filename: string;
  date_folder: string;
  image_url: string;
  thumbnail_url: string;
  width: number | null;
  height: number | null;
  orientation: 0 | 1;
  processed_at: string;
  camera_text: string;
  exif: Record<string, unknown>;
}

interface PhotoSidecar {
  width?: unknown;
  height?: unknown;
  orientation?: unknown;
  processed_at?: unknown;
  exif?: unknown;
}

export class TodayStore {
  readonly galleriesRoot: string;
  readonly latestFile: string;

  constructor(readonly dataRoot: string) {
    this.galleriesRoot = path.join(dataRoot, "galleries");
    this.latestFile = path.join(dataRoot, "state", "latest.json");
  }

  async readLatest(): Promise<LatestPublication | null> {
    try {
      const parsed = JSON.parse(await readFile(this.latestFile, "utf8")) as Partial<LatestPublication>;
      if (typeof parsed.updated_at !== "string" || typeof parsed.date_folder !== "string") return null;
      assertDate(parsed.date_folder);
      const latestBase = typeof parsed.latest_base === "string" && BASE_PATTERN.test(parsed.latest_base)
        ? parsed.latest_base
        : null;
      return {
        updated_at: parsed.updated_at,
        date_folder: parsed.date_folder,
        latest_base: latestBase,
        count_today: Number.isInteger(parsed.count_today) && Number(parsed.count_today) >= 0
          ? Number(parsed.count_today)
          : 0,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async listPhotos(dateFolder: string): Promise<TodayPhoto[]> {
    assertDate(dateFolder);
    const directory = path.join(this.galleriesRoot, dateFolder);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const names = new Set(entries);
    const photos = await Promise.all(entries
      .filter((entry) => entry.endsWith(".ready"))
      .map((entry) => entry.slice(0, -6))
      .filter((base) => !names.has(`${base}.trashed.json`))
      .map((base) => this.readPhoto(dateFolder, base)));
    return photos.sort((left, right) => left.processed_at.localeCompare(right.processed_at));
  }

  async requireImage(dateFolder: string, base: string): Promise<string> {
    assertDate(dateFolder);
    assertBase(base);
    const directory = path.join(this.galleriesRoot, dateFolder);
    await access(path.join(directory, `${base}.ready`));
    try {
      await access(path.join(directory, `${base}.trashed.json`));
      throw new TodayRequestError("Photo is in the trash.", 404);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const image = path.join(directory, `${base}.jpg`);
    await access(image);
    return image;
  }

  private async readPhoto(dateFolder: string, base: string): Promise<TodayPhoto> {
    assertBase(base);
    const directory = path.join(this.galleriesRoot, dateFolder);
    const sidecar = await readJsonOrNull<PhotoSidecar>(path.join(directory, `${base}.json`));
    const readyInfo = await stat(path.join(directory, `${base}.ready`));
    return {
      base,
      filename: `${base}.jpg`,
      date_folder: dateFolder,
      image_url: `/today/image/${dateFolder}/${base}.jpg`,
      thumbnail_url: `/gallery/thumb/${dateFolder}/${base}.webp`,
      width: positiveIntegerOrNull(sidecar?.width),
      height: positiveIntegerOrNull(sidecar?.height),
      orientation: sidecar?.orientation === 1 ? 1 : 0,
      processed_at: typeof sidecar?.processed_at === "string" ? sidecar.processed_at : readyInfo.mtime.toISOString(),
      camera_text: await readTextOrEmpty(path.join(directory, `${base}.txt`)),
      exif: displayExif(sidecar?.exif),
    };
  }
}

export class TodayRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function assertDate(value: string): void {
  if (!DATE_PATTERN.test(value)) throw new TodayRequestError("Invalid photo date.", 400);
}

function assertBase(value: string): void {
  if (!BASE_PATTERN.test(value)) throw new TodayRequestError("Invalid photo base.", 400);
}

async function readJsonOrNull<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readTextOrEmpty(file: string): Promise<string> {
  try {
    return cleanDisplayText(await readFile(file, "utf8"));
  } catch {
    return "";
  }
}

function cleanDisplayText(value: string): string {
  return value.replaceAll("\0", "").replace(/[ \t]+$/gm, "").trim();
}

function positiveIntegerOrNull(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function displayExif(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const fields = ["Make", "Model", "LensMake", "LensModel", "ExposureTime", "FNumber", "ISOSpeedRatings", "FocalLength"];
  const result: Record<string, unknown> = {};
  for (const group of ["Image", "Photo"]) {
    const groupValue = value[group];
    if (!isRecord(groupValue)) continue;
    const entries: Array<[string, string | number | boolean]> = [];
    for (const field of fields) {
      const candidate = groupValue[field];
      if (typeof candidate === "string") entries.push([field, cleanDisplayText(candidate)]);
      if (typeof candidate === "number" || typeof candidate === "boolean") entries.push([field, candidate]);
    }
    const selected = Object.fromEntries(entries);
    if (Object.keys(selected).length) result[group] = selected;
  }
  return result;
}
