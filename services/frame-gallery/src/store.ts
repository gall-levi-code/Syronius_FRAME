import { access, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BASE_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface GalleryPhoto {
  base: string;
  date_folder: string;
  image_url: string;
  thumbnail_url: string;
  width: number | null;
  height: number | null;
  orientation: 0 | 1;
  processed_at: string;
  camera_text: string;
}

export interface GalleryDate {
  date_folder: string;
  count: number;
  first_at: string | null;
  latest_at: string | null;
  duration_ms: number;
  cover_thumbnail_url: string | null;
}

interface PhotoSidecar {
  width?: unknown;
  height?: unknown;
  orientation?: unknown;
  processed_at?: unknown;
}

export class GalleryStore {
  readonly galleriesRoot: string;
  readonly cacheRoot: string;
  private thumbnails = new Map<string, Promise<string>>();

  constructor(readonly dataRoot: string, readonly thumbWidth: number, readonly thumbQuality: number) {
    this.galleriesRoot = path.join(dataRoot, "galleries");
    this.cacheRoot = path.join(dataRoot, "gallery-cache");
  }

  async init(): Promise<void> {
    await Promise.all([
      mkdir(this.galleriesRoot, { recursive: true }),
      mkdir(this.cacheRoot, { recursive: true }),
    ]);
  }

  async listDates(): Promise<GalleryDate[]> {
    const dates: GalleryDate[] = [];
    for (const entry of await readdir(this.galleriesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !DATE_PATTERN.test(entry.name)) continue;
      const photos = await this.listPhotos(entry.name);
      const latest = photos[0] ?? null;
      const first = photos[photos.length - 1] ?? null;
      dates.push({
        date_folder: entry.name,
        count: photos.length,
        first_at: first?.processed_at ?? null,
        latest_at: latest?.processed_at ?? null,
        duration_ms: first && latest
          ? Math.max(0, new Date(latest.processed_at).getTime() - new Date(first.processed_at).getTime())
          : 0,
        cover_thumbnail_url: first?.thumbnail_url ?? null,
      });
    }
    return dates.filter((date) => date.count > 0).sort((left, right) => right.date_folder.localeCompare(left.date_folder));
  }

  async listPhotos(dateFolder: string): Promise<GalleryPhoto[]> {
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
    const bases = entries
      .filter((entry) => entry.endsWith(".ready"))
      .map((entry) => entry.slice(0, -6))
      .filter((base) => !names.has(`${base}.trashed.json`));
    const photos = await Promise.all(bases.map((base) => this.readPhoto(dateFolder, base)));
    return photos.sort((left, right) => right.processed_at.localeCompare(left.processed_at));
  }

  async requireImage(dateFolder: string, base: string): Promise<string> {
    await this.assertPublished(dateFolder, base);
    const image = path.join(this.galleriesRoot, dateFolder, `${base}.jpg`);
    await access(image);
    return image;
  }

  async requireThumbnail(dateFolder: string, base: string): Promise<string> {
    const key = `${dateFolder}/${base}`;
    const pending = this.thumbnails.get(key) ?? this.generateThumbnail(dateFolder, base);
    this.thumbnails.set(key, pending);
    try {
      return await pending;
    } finally {
      this.thumbnails.delete(key);
    }
  }

  async requireAdminThumbnail(dateFolder: string, base: string): Promise<string> {
    const key = `admin/${dateFolder}/${base}`;
    const pending = this.thumbnails.get(key) ?? this.generateThumbnail(dateFolder, base, true);
    this.thumbnails.set(key, pending);
    try {
      return await pending;
    } finally {
      this.thumbnails.delete(key);
    }
  }

  async requireAdminImage(dateFolder: string, base: string): Promise<string> {
    assertDate(dateFolder);
    assertBase(base);
    const directory = path.join(this.galleriesRoot, dateFolder);
    await access(path.join(directory, `${base}.ready`));
    const image = path.join(directory, `${base}.jpg`);
    await access(image);
    return image;
  }

  private async generateThumbnail(dateFolder: string, base: string, allowTrashed = false): Promise<string> {
    const image = allowTrashed
      ? await this.requireAdminImage(dateFolder, base)
      : await this.requireImage(dateFolder, base);
    const cacheDirectory = path.join(this.cacheRoot, dateFolder);
    const thumbnail = path.join(cacheDirectory, `${base}.webp`);
    await mkdir(cacheDirectory, { recursive: true });
    const [imageInfo, thumbnailInfo] = await Promise.all([stat(image), statOrNull(thumbnail)]);
    if (!thumbnailInfo || thumbnailInfo.mtimeMs < imageInfo.mtimeMs) {
      const temporary = `${thumbnail}.tmp`;
      await sharp(image)
        .resize({ width: this.thumbWidth, withoutEnlargement: true })
        .webp({ quality: this.thumbQuality })
        .toFile(temporary);
      await import("node:fs/promises").then(({ rename }) => rename(temporary, thumbnail));
    }
    return thumbnail;
  }

  private async readPhoto(dateFolder: string, base: string): Promise<GalleryPhoto> {
    assertBase(base);
    const directory = path.join(this.galleriesRoot, dateFolder);
    const sidecar = await readJsonOrNull<PhotoSidecar>(path.join(directory, `${base}.json`));
    const readyInfo = await stat(path.join(directory, `${base}.ready`));
    const cameraText = await readTextOrEmpty(path.join(directory, `${base}.txt`));
    return {
      base,
      date_folder: dateFolder,
      image_url: `/gallery/image/${dateFolder}/${base}.jpg`,
      thumbnail_url: `/gallery/thumb/${dateFolder}/${base}.webp`,
      width: integerOrNull(sidecar?.width),
      height: integerOrNull(sidecar?.height),
      orientation: sidecar?.orientation === 1 ? 1 : 0,
      processed_at: typeof sidecar?.processed_at === "string" ? sidecar.processed_at : readyInfo.mtime.toISOString(),
      camera_text: cameraText,
    };
  }

  private async assertPublished(dateFolder: string, base: string): Promise<void> {
    assertDate(dateFolder);
    assertBase(base);
    const directory = path.join(this.galleriesRoot, dateFolder);
    await access(path.join(directory, `${base}.ready`));
    try {
      await access(path.join(directory, `${base}.trashed.json`));
      throw new GalleryRequestError("Photo is in the trash.", 404);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function assertDate(value: string): void {
  if (!DATE_PATTERN.test(value)) throw new GalleryRequestError("Invalid gallery date.", 400);
}

function assertBase(value: string): void {
  if (!BASE_PATTERN.test(value)) throw new GalleryRequestError("Invalid photo base.", 400);
}

export class GalleryRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
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
    return (await readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
}

async function statOrNull(file: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function integerOrNull(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}
