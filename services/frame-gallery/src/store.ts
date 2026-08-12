import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import {
  applyBrandingUpdate,
  toBrandingResponse,
  normalizeStoredBranding,
  withLogo,
  type GalleryBranding,
  type GalleryBrandingResponse,
  type GalleryLogo,
} from "./theme.js";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const BASE_PATTERN = /^[A-Za-z0-9_-]+$/;
const LOGO_DATA_URL_PATTERN = /^data:(image\/(?:png|jpe?g|webp|svg\+xml));base64,([a-z0-9+/=\s]+)$/i;
const MAX_LOGO_UPLOAD_BYTES = 1_400_000;
const MAX_LOGO_SOURCE_PIXELS = 16_777_216;
const MAX_LOGO_ASPECT_RATIO = 8;
const MIN_LOGO_EDGE_PX = 24;
const LOGO_BOX = { width: 720, height: 240 };
const SOCIAL_GRAPHIC_SIZE = 320;
const TILE_SIZE = 512;
const TILE_OVERLAP = 1;
const TILE_QUALITY = 90;
const TILE_CACHE_VERSION = `v2-overlap-${TILE_OVERLAP}`;
const MAX_TILE_GENERATORS = 2;
const MAX_QUEUED_TILE_SETS = 32;
const TILE_COMPLETE_FILE = ".complete";

export interface GalleryPhoto {
  base: string;
  date_folder: string;
  thumbnail_url: string;
  width: number | null;
  height: number | null;
  orientation: 0 | 1;
  processed_at: string;
  capture_clock: string | null;
  camera_text: string;
}

export interface GalleryDate {
  date_folder: string;
  count: number;
  first_at: string | null;
  latest_at: string | null;
  duration_ms: number;
  cover_base: string | null;
  cover_fallback_active: boolean;
  cover_is_custom: boolean;
  cover_thumbnail_url: string | null;
  has_explore: boolean;
}

export interface GallerySettings {
  schema_version: 1;
  cover_base: string | null;
  updated_at: string;
}

export interface GalleryTileView {
  date_folder: string;
  base: string;
  width: number;
  height: number;
  tile_size: number;
  overlap: number;
  columns: number;
  rows: number;
  source_mtime_ms: number;
  source_size_bytes: number;
  source_version: string;
}

export interface GalleryExplore {
  schema_version: 1;
  updated_at: string;
  time_shift_seconds: number;
  time_adjustment_seconds: number;
  routes: Array<{
    id: string;
    name: string;
    imported_at: string;
    segments: Array<Array<[number, number, number]>>;
  }>;
  placements: Record<string, { lat: number; lon: number; timestamp?: number; updated_at: string }>;
}

interface PhotoSidecar {
  width?: unknown;
  height?: unknown;
  orientation?: unknown;
  processed_at?: unknown;
  exif?: { Photo?: { DateTimeOriginal?: unknown } };
}

export class GalleryStore {
  readonly galleriesRoot: string;
  readonly cacheRoot: string;
  readonly brandingRoot: string;
  readonly brandingConfigFile: string;
  readonly logoFile: string;
  readonly socialGraphicsRoot: string;
  readonly gallerySettingsRoot: string;
  private thumbnails = new Map<string, Promise<string>>();
  private tiles = new Map<string, Promise<void>>();
  private tileGenerators = 0;
  private tileWaiters: Array<() => void> = [];
  private brandingMutation: Promise<void> = Promise.resolve();
  private gallerySettingsMutation: Promise<void> = Promise.resolve();

  constructor(readonly dataRoot: string, readonly thumbWidth: number, readonly thumbQuality: number) {
    this.galleriesRoot = path.join(dataRoot, "galleries");
    this.cacheRoot = path.join(dataRoot, "gallery-cache");
    this.brandingRoot = path.join(dataRoot, "gallery-branding");
    this.brandingConfigFile = path.join(this.brandingRoot, "config.json");
    this.logoFile = path.join(this.brandingRoot, "logo.webp");
    this.socialGraphicsRoot = path.join(this.brandingRoot, "socials");
    this.gallerySettingsRoot = path.join(this.brandingRoot, "galleries");
  }

  async init(): Promise<void> {
    await Promise.all([
      mkdir(this.galleriesRoot, { recursive: true }),
      mkdir(this.cacheRoot, { recursive: true }),
      mkdir(this.brandingRoot, { recursive: true }),
      mkdir(this.socialGraphicsRoot, { recursive: true }),
      mkdir(this.gallerySettingsRoot, { recursive: true }),
    ]);
  }

  async getBranding(): Promise<GalleryBrandingResponse> {
    return toBrandingResponse(await this.readBrandingConfig());
  }

  async updateBranding(input: unknown): Promise<GalleryBrandingResponse> {
    return this.mutateBranding(async () => {
      const current = await this.readBrandingConfig();
      const next = applyBrandingUpdate(current, input, new Date().toISOString());
      await this.writeBrandingConfig(next);
      const nextIds = new Set(next.socials.map((social) => social.id));
      await Promise.all(current.socials
        .filter((social) => !nextIds.has(social.id))
        .map((social) => rm(this.socialGraphicFile(social.id), { force: true })));
      return toBrandingResponse(next);
    });
  }

  async saveLogo(input: unknown): Promise<GalleryBrandingResponse> {
    const upload = parseImageUpload(input, "Logo");
    const image = sharp(upload.buffer, {
      limitInputPixels: MAX_LOGO_SOURCE_PIXELS,
      density: upload.mediaType === "image/svg+xml" ? 192 : undefined,
    });
    const metadata = await image.metadata();
    const width = integerOrNull(metadata.width);
    const height = integerOrNull(metadata.height);
    if (!width || !height) throw new GalleryRequestError("Logo image dimensions could not be read.", 400);
    if (width * height > MAX_LOGO_SOURCE_PIXELS) throw new GalleryRequestError("Logo image is too large.", 413);
    if (Math.min(width, height) < MIN_LOGO_EDGE_PX) throw new GalleryRequestError("Logo image is too small for web display.", 400);
    const aspectRatio = Math.max(width / height, height / width);
    if (aspectRatio > MAX_LOGO_ASPECT_RATIO) {
      throw new GalleryRequestError("Logo image is too wide or tall for the gallery header.", 400);
    }

    const output = await image
      .rotate()
      .resize({ ...LOGO_BOX, fit: "inside", withoutEnlargement: upload.mediaType !== "image/svg+xml" })
      .webp({ quality: 88 })
      .toBuffer();
    const outputMetadata = await sharp(output).metadata();
    const logoWidth = integerOrNull(outputMetadata.width);
    const logoHeight = integerOrNull(outputMetadata.height);
    if (!logoWidth || !logoHeight) throw new GalleryRequestError("Logo image could not be processed.", 400);

    return this.mutateBranding(async () => {
      await mkdir(this.brandingRoot, { recursive: true });
      const temporary = `${this.logoFile}.tmp`;
      await writeFile(temporary, output);
      await rename(temporary, this.logoFile);

      const updatedAt = new Date().toISOString();
      const logo: GalleryLogo = {
        url: `/gallery/branding/logo.webp?v=${encodeURIComponent(updatedAt)}`,
        width: logoWidth,
        height: logoHeight,
        updated_at: updatedAt,
      };
      const next = withLogo(await this.readBrandingConfig(), logo, updatedAt);
      await this.writeBrandingConfig(next);
      return toBrandingResponse(next);
    });
  }

  async deleteLogo(): Promise<GalleryBrandingResponse> {
    return this.mutateBranding(async () => {
      await rm(this.logoFile, { force: true });
      const updatedAt = new Date().toISOString();
      const next = withLogo(await this.readBrandingConfig(), null, updatedAt);
      await this.writeBrandingConfig(next);
      return toBrandingResponse(next);
    });
  }

  async requireLogo(): Promise<string> {
    await access(this.logoFile);
    return this.logoFile;
  }

  async saveSocialGraphic(id: string, input: unknown): Promise<GalleryBrandingResponse> {
    const upload = parseImageUpload(input, "Social graphic");
    const image = sharp(upload.buffer, {
      limitInputPixels: MAX_LOGO_SOURCE_PIXELS,
      density: upload.mediaType === "image/svg+xml" ? 192 : undefined,
    });
    const metadata = await image.metadata();
    const width = integerOrNull(metadata.width);
    const height = integerOrNull(metadata.height);
    if (!width || !height) throw new GalleryRequestError("Social graphic dimensions could not be read.", 400);
    if (width * height > MAX_LOGO_SOURCE_PIXELS) throw new GalleryRequestError("Social graphic is too large.", 413);
    if (Math.min(width, height) < MIN_LOGO_EDGE_PX) {
      throw new GalleryRequestError("Social graphic is too small for web display.", 400);
    }

    const output = await image
      .rotate()
      .resize({ width: SOCIAL_GRAPHIC_SIZE, height: SOCIAL_GRAPHIC_SIZE, fit: "cover" })
      .webp({ quality: 88 })
      .toBuffer();
    const outputMetadata = await sharp(output).metadata();
    const graphicWidth = integerOrNull(outputMetadata.width);
    const graphicHeight = integerOrNull(outputMetadata.height);
    if (graphicWidth !== SOCIAL_GRAPHIC_SIZE || graphicHeight !== SOCIAL_GRAPHIC_SIZE) {
      throw new GalleryRequestError("Social graphic could not be processed.", 400);
    }

    return this.mutateBranding(async () => {
      const current = await this.readBrandingConfig();
      if (!current.socials.some((social) => social.id === id)) {
        throw new GalleryRequestError("Social link was not found.", 404);
      }
      await mkdir(this.socialGraphicsRoot, { recursive: true });
      const graphicFile = this.socialGraphicFile(id);
      const temporary = `${graphicFile}.tmp`;
      await writeFile(temporary, output);
      await rename(temporary, graphicFile);

      const updatedAt = new Date().toISOString();
      const graphic: GalleryLogo = {
        url: `/gallery/branding/socials/${encodeURIComponent(id)}/graphic.webp?v=${encodeURIComponent(updatedAt)}`,
        width: graphicWidth,
        height: graphicHeight,
        updated_at: updatedAt,
      };
      const next = setSocialGraphic(current, id, graphic, updatedAt);
      await this.writeBrandingConfig(next);
      return toBrandingResponse(next);
    });
  }

  async deleteSocialGraphic(id: string): Promise<GalleryBrandingResponse> {
    return this.mutateBranding(async () => {
      const current = await this.readBrandingConfig();
      const social = current.socials.find((item) => item.id === id);
      if (!social) throw new GalleryRequestError("Social link was not found.", 404);
      if (!social.graphic) {
        await rm(this.socialGraphicFile(id), { force: true });
        return toBrandingResponse(current);
      }
      const updatedAt = new Date().toISOString();
      const next = setSocialGraphic(current, id, null, updatedAt);
      await this.writeBrandingConfig(next);
      await rm(this.socialGraphicFile(id), { force: true });
      return toBrandingResponse(next);
    });
  }

  async requireSocialGraphic(id: string): Promise<string> {
    const social = (await this.readBrandingConfig()).socials.find((item) => item.id === id);
    if (!social?.graphic) throw new GalleryRequestError("Social graphic was not found.", 404);
    const file = this.socialGraphicFile(social.id);
    await access(file);
    return file;
  }

  async listDates(): Promise<GalleryDate[]> {
    const dates: GalleryDate[] = [];
    for (const entry of await readdir(this.galleriesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !DATE_PATTERN.test(entry.name)) continue;
      const photos = await this.listPhotos(entry.name);
      const latest = photos[0] ?? null;
      const first = photos[photos.length - 1] ?? null;
      const settings = await this.readGallerySettings(entry.name);
      const customCover = settings.cover_base
        ? photos.find((photo) => photo.base === settings.cover_base) ?? null
        : null;
      const customCoverIsRecoverable = settings.cover_base
        ? Boolean(
            await statOrNull(path.join(this.galleriesRoot, entry.name, `${settings.cover_base}.ready`))
            && await statOrNull(path.join(this.galleriesRoot, entry.name, `${settings.cover_base}.jpg`)),
          )
        : false;
      const cover = customCover || first;
      dates.push({
        date_folder: entry.name,
        count: photos.length,
        first_at: first?.processed_at ?? null,
        latest_at: latest?.processed_at ?? null,
        duration_ms: first && latest
          ? Math.max(0, new Date(latest.processed_at).getTime() - new Date(first.processed_at).getTime())
          : 0,
        cover_base: cover?.base ?? null,
        cover_fallback_active: customCoverIsRecoverable && !customCover,
        cover_is_custom: customCoverIsRecoverable,
        cover_thumbnail_url: cover?.thumbnail_url ?? null,
        has_explore: Boolean(await statOrNull(path.join(this.galleriesRoot, entry.name, "_explore.json"))),
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
    const bases = visibleBases(entries);
    const photos = await Promise.all(bases.map((base) => this.readPhoto(dateFolder, base)));
    return photos.sort((left, right) => right.processed_at.localeCompare(left.processed_at));
  }

  async updateGallerySettings(dateFolder: string, input: unknown): Promise<GallerySettings> {
    assertDate(dateFolder);
    if (!isRecord(input)) throw new GalleryRequestError("Gallery settings must be an object.", 400);
    const updatesCover = Object.hasOwn(input, "cover_base");
    if (!updatesCover) throw new GalleryRequestError("No gallery settings were supplied.", 400);

    return this.mutateGallerySettings(async () => {
      if (!(await this.listPhotos(dateFolder)).length) throw new GalleryRequestError("Gallery was not found.", 404);
      const current = await this.readGallerySettings(dateFolder);
      let coverBase = current.cover_base;
      const value = input.cover_base;
      if (value !== null && typeof value !== "string") {
        throw new GalleryRequestError("Gallery cover must identify a photo or use automatic selection.", 400);
      }
      if (typeof value === "string") await this.requireImage(dateFolder, value);
      coverBase = value;
      const next: GallerySettings = {
        schema_version: 1,
        cover_base: coverBase,
        updated_at: new Date().toISOString(),
      };
      await this.writeGallerySettings(dateFolder, next);
      return next;
    });
  }

  async pruneGallerySettings(): Promise<void> {
    await this.mutateGallerySettings(async () => {
      for (const entry of await readdir(this.gallerySettingsRoot, { withFileTypes: true })) {
        const match = entry.isFile() ? entry.name.match(/^(\d{4}-\d{2}-\d{2})\.json$/) : null;
        if (!match) continue;
        const dateFolder = match[1];
        const galleryEntries = await readEntriesOrEmpty(path.join(this.galleriesRoot, dateFolder));
        const published = new Set(galleryEntries
          .filter((name) => name.endsWith(".ready"))
          .map((name) => name.slice(0, -6))
          .filter((base) => BASE_PATTERN.test(base)));
        if (!published.size) {
          await rm(this.gallerySettingsFile(dateFolder), { force: true });
          continue;
        }
        const current = await this.readGallerySettings(dateFolder);
        if (!current.cover_base || published.has(current.cover_base)) continue;
        await this.writeGallerySettings(dateFolder, {
          ...current,
          cover_base: null,
          updated_at: new Date().toISOString(),
        });
      }
    });
  }

  async getExplore(dateFolder: string): Promise<GalleryExplore | null> {
    assertDate(dateFolder);
    const explore = await readJsonOrNull<GalleryExplore>(path.join(this.galleriesRoot, dateFolder, "_explore.json"));
    return explore?.schema_version === 1 && Array.isArray(explore.routes) && explore.routes.length > 0 ? explore : null;
  }

  async getPublicExplore(dateFolder: string): Promise<GalleryExplore | null> {
    const explore = await this.getExplore(dateFolder);
    if (!explore) return null;
    const entries = await readdir(path.join(this.galleriesRoot, dateFolder));
    const visible = new Set(visibleBases(entries));
    if (!visible.size) return null;
    return {
      ...explore,
      placements: Object.fromEntries(
        Object.entries(explore.placements).filter(([base]) => visible.has(base)),
      ),
    };
  }

  async requireImage(dateFolder: string, base: string): Promise<string> {
    await this.assertPublished(dateFolder, base);
    const image = path.join(this.galleriesRoot, dateFolder, `${base}.jpg`);
    await access(image);
    return image;
  }

  async createTileView(dateFolder: string, base: string): Promise<GalleryTileView> {
    const image = await this.requireImage(dateFolder, base);
    const [metadata, source] = await Promise.all([sharp(image).metadata(), stat(image)]);
    const width = integerOrNull(metadata.width);
    const height = integerOrNull(metadata.height);
    if (!width || !height) throw new GalleryRequestError("Photo dimensions could not be read.", 500);
    return {
      date_folder: dateFolder,
      base,
      width,
      height,
      tile_size: TILE_SIZE,
      overlap: TILE_OVERLAP,
      columns: Math.ceil(width / TILE_SIZE),
      rows: Math.ceil(height / TILE_SIZE),
      source_mtime_ms: source.mtimeMs,
      source_size_bytes: source.size,
      source_version: `${Math.round(source.mtimeMs * 1000)}-${source.size}`,
    };
  }

  async requireTile(view: GalleryTileView, x: number, y: number): Promise<string> {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= view.columns || y >= view.rows) {
      throw new GalleryRequestError("Tile was not found.", 404);
    }
    const image = await this.requireImage(view.date_folder, view.base);
    const source = await stat(image);
    if (source.mtimeMs !== view.source_mtime_ms || source.size !== view.source_size_bytes) {
      throw new GalleryRequestError("Viewing session expired.", 404);
    }
    const tileSet = path.join(
      this.cacheRoot,
      "tiles",
      view.date_folder,
      view.base,
      TILE_CACHE_VERSION,
      view.source_version,
    );
    const tile = path.join(tileSet, "photo_files", "0", `${x}_${y}.webp`);
    const key = tileSet;
    const pending = this.tiles.get(key) ?? this.generateTileSet(image, tileSet, tile);
    this.tiles.set(key, pending);
    try {
      await pending;
      await this.assertPublished(view.date_folder, view.base);
      const current = await stat(image);
      if (current.mtimeMs !== view.source_mtime_ms || current.size !== view.source_size_bytes) {
        throw new GalleryRequestError("Viewing session expired.", 404);
      }
      await access(tile);
      return tile;
    } finally {
      if (this.tiles.get(key) === pending) this.tiles.delete(key);
    }
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

  private async generateTileSet(image: string, tileSet: string, requestedTile: string): Promise<void> {
    const completeMarker = path.join(tileSet, TILE_COMPLETE_FILE);
    if (await statOrNull(completeMarker) && await statOrNull(requestedTile)) return;
    return this.withTileGenerator(async () => {
      if (await statOrNull(completeMarker) && await statOrNull(requestedTile)) return;
      const temporary = `${tileSet}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
      await mkdir(path.dirname(tileSet), { recursive: true });
      try {
        await mkdir(temporary, { recursive: true });
        await sharp(image, { failOn: "error" })
          .webp({ quality: TILE_QUALITY })
          .tile({ size: TILE_SIZE, overlap: TILE_OVERLAP, depth: "one", layout: "dz", container: "fs" })
          .toFile(path.join(temporary, "photo.dz"));
        await access(path.join(temporary, path.relative(tileSet, requestedTile)));
        await writeFile(path.join(temporary, TILE_COMPLETE_FILE), "complete\n");
        await rm(tileSet, { recursive: true, force: true });
        await rename(temporary, tileSet);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }

  private async withTileGenerator<T>(operation: () => Promise<T>): Promise<T> {
    if (this.tileGenerators < MAX_TILE_GENERATORS) this.tileGenerators += 1;
    else {
      if (this.tileWaiters.length >= MAX_QUEUED_TILE_SETS) {
        throw new GalleryRequestError("Photo detail is busy. Try again shortly.", 503);
      }
      await new Promise<void>((resolve) => this.tileWaiters.push(resolve));
    }
    try {
      return await operation();
    } finally {
      const next = this.tileWaiters.shift();
      if (next) next();
      else this.tileGenerators -= 1;
    }
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
      thumbnail_url: `/gallery/thumb/${dateFolder}/${base}.webp`,
      width: integerOrNull(sidecar?.width),
      height: integerOrNull(sidecar?.height),
      orientation: sidecar?.orientation === 1 ? 1 : 0,
      processed_at: typeof sidecar?.processed_at === "string" ? sidecar.processed_at : readyInfo.mtime.toISOString(),
      capture_clock: typeof sidecar?.exif?.Photo?.DateTimeOriginal === "string"
        ? sidecar.exif.Photo.DateTimeOriginal
        : null,
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

  private async readBrandingConfig(): Promise<GalleryBranding> {
    return normalizeStoredBranding(await readJsonOrNull<unknown>(this.brandingConfigFile));
  }

  private async readGallerySettings(dateFolder: string): Promise<GallerySettings> {
    const value = await readJsonOrNull<unknown>(this.gallerySettingsFile(dateFolder));
    if (!isRecord(value) || value.schema_version !== 1) return defaultGallerySettings();
    return {
      schema_version: 1,
      cover_base: typeof value.cover_base === "string" && BASE_PATTERN.test(value.cover_base) ? value.cover_base : null,
      updated_at: typeof value.updated_at === "string" && value.updated_at ? value.updated_at : defaultGallerySettings().updated_at,
    };
  }

  private async writeGallerySettings(dateFolder: string, settings: GallerySettings): Promise<void> {
    await mkdir(this.gallerySettingsRoot, { recursive: true });
    const file = this.gallerySettingsFile(dateFolder);
    const temporary = `${file}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
    await rename(temporary, file);
  }

  private async writeBrandingConfig(config: GalleryBranding): Promise<void> {
    await mkdir(path.dirname(this.brandingConfigFile), { recursive: true });
    const temporary = `${this.brandingConfigFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`);
    await rename(temporary, this.brandingConfigFile);
  }

  private socialGraphicFile(id: string): string {
    return path.join(this.socialGraphicsRoot, `${id}.webp`);
  }

  private gallerySettingsFile(dateFolder: string): string {
    assertDate(dateFolder);
    return path.join(this.gallerySettingsRoot, `${dateFolder}.json`);
  }

  private mutateBranding<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.brandingMutation.then(operation, operation);
    this.brandingMutation = result.then(() => undefined, () => undefined);
    return result;
  }

  private mutateGallerySettings<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.gallerySettingsMutation.then(operation, operation);
    this.gallerySettingsMutation = result.then(() => undefined, () => undefined);
    return result;
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

async function readEntriesOrEmpty(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function defaultGallerySettings(): GallerySettings {
  return {
    schema_version: 1,
    cover_base: null,
    updated_at: "1970-01-01T00:00:00.000Z",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visibleBases(entries: string[]): string[] {
  const names = new Set(entries);
  return entries
    .filter((entry) => entry.endsWith(".ready"))
    .map((entry) => entry.slice(0, -6))
    .filter((base) => !names.has(`${base}.trashed.json`));
}

function parseImageUpload(input: unknown, subject: string): { buffer: Buffer; mediaType: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GalleryRequestError(`${subject} upload must include an image data URL.`, 400);
  }
  const dataUrl = (input as { data_url?: unknown }).data_url;
  if (typeof dataUrl !== "string") throw new GalleryRequestError(`${subject} upload must include an image data URL.`, 400);
  const match = dataUrl.match(LOGO_DATA_URL_PATTERN);
  if (!match) throw new GalleryRequestError(`${subject} must be a PNG, JPEG, WebP, or SVG image.`, 400);
  const buffer = Buffer.from(match[2].replace(/\s/g, ""), "base64");
  if (!buffer.length) throw new GalleryRequestError(`${subject} upload was empty.`, 400);
  if (buffer.length > MAX_LOGO_UPLOAD_BYTES) throw new GalleryRequestError(`Processed ${subject.toLowerCase()} image is too large.`, 413);
  return { buffer, mediaType: match[1].toLowerCase() };
}

function setSocialGraphic(
  config: GalleryBranding,
  id: string,
  graphic: GalleryLogo | null,
  updatedAt: string,
): GalleryBranding {
  return {
    ...config,
    socials: config.socials.map((social) => {
      if (social.id !== id) return social;
      const next = { ...social };
      if (graphic) next.graphic = graphic;
      else delete next.graphic;
      return next;
    }),
    updated_at: updatedAt,
  };
}
