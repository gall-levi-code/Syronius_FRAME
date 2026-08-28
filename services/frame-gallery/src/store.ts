import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
const CATALOG_SCHEMA_VERSION = 2;
const MAX_PHOTO_PAGE_SIZE = 100;
const CATALOG_FRESH_MS = 1_500;
const CATALOG_DEEP_SCAN_MS = 60_000;

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

export interface GalleryPhotoPage {
  photos: GalleryPhoto[];
  total: number;
  next_cursor: string | null;
  revision: number;
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

interface CatalogGalleryRow {
  date_folder: string;
  directory_mtime_ms: number;
  directory_entry_count: number;
  photo_count: number;
  first_at: string | null;
  latest_at: string | null;
  duration_ms: number;
  automatic_cover_base: string | null;
  has_explore: number;
  revision: number;
}

interface CatalogPhotoRow {
  date_folder: string;
  base: string;
  width: number | null;
  height: number | null;
  orientation: number;
  processed_at: string;
  capture_clock: string | null;
  camera_text: string;
  trashed: number;
}

export class GalleryStore {
  readonly galleriesRoot: string;
  readonly cacheRoot: string;
  readonly brandingRoot: string;
  readonly brandingConfigFile: string;
  readonly logoFile: string;
  readonly socialGraphicsRoot: string;
  readonly gallerySettingsRoot: string;
  readonly catalogFile: string;
  private thumbnails = new Map<string, Promise<string>>();
  private tiles = new Map<string, Promise<boolean>>();
  private tileGenerators = 0;
  private tileWaiters: Array<() => void> = [];
  private brandingMutation: Promise<void> = Promise.resolve();
  private gallerySettingsMutation: Promise<void> = Promise.resolve();
  private initialization: Promise<void> | null = null;
  private catalog: DatabaseSync | null = null;
  private catalogReconciliation: Promise<void> = Promise.resolve();
  private catalogReconciledAt = 0;
  private catalogDateReconciledAt = new Map<string, number>();
  private catalogDateDeepScannedAt = new Map<string, number>();

  constructor(readonly dataRoot: string, readonly thumbWidth: number, readonly thumbQuality: number) {
    this.galleriesRoot = path.join(dataRoot, "galleries");
    this.cacheRoot = path.join(dataRoot, "gallery-cache");
    this.brandingRoot = path.join(dataRoot, "gallery-branding");
    this.brandingConfigFile = path.join(this.brandingRoot, "config.json");
    this.logoFile = path.join(this.brandingRoot, "logo.webp");
    this.socialGraphicsRoot = path.join(this.brandingRoot, "socials");
    this.gallerySettingsRoot = path.join(this.brandingRoot, "galleries");
    this.catalogFile = path.join(this.cacheRoot, "gallery-catalog.sqlite");
  }

  async init(): Promise<void> {
    if (!this.initialization) this.initialization = this.initialize();
    return this.initialization;
  }

  close(): void {
    this.catalog?.close();
    this.catalog = null;
    this.initialization = null;
    this.catalogReconciliation = Promise.resolve();
    this.catalogReconciledAt = 0;
    this.catalogDateReconciledAt.clear();
    this.catalogDateDeepScannedAt.clear();
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.galleriesRoot, { recursive: true }),
      mkdir(this.cacheRoot, { recursive: true }),
      mkdir(this.brandingRoot, { recursive: true }),
      mkdir(this.socialGraphicsRoot, { recursive: true }),
      mkdir(this.gallerySettingsRoot, { recursive: true }),
    ]);
    try {
      this.catalog = this.openCatalog();
    } catch (error) {
      await Promise.all([
        rm(this.catalogFile, { force: true }),
        rm(`${this.catalogFile}-shm`, { force: true }),
        rm(`${this.catalogFile}-wal`, { force: true }),
      ]);
      console.warn(`[gallery] rebuilding unreadable catalog: ${errorMessage(error)}`);
      this.catalog = this.openCatalog();
    }
    await this.reconcileCatalogInternal(undefined, true);
    this.catalogReconciledAt = Date.now();
  }

  private openCatalog(): DatabaseSync {
    const database = new DatabaseSync(this.catalogFile);
    try {
      database.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA foreign_keys = ON;
      `);
      const version = Number((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      if (version > CATALOG_SCHEMA_VERSION) throw new Error(`Catalog schema ${version} is newer than this FRAME version.`);
      if (version < 1) database.exec(`
        CREATE TABLE IF NOT EXISTS gallery_catalog (
          date_folder TEXT PRIMARY KEY,
          directory_mtime_ms REAL NOT NULL,
          directory_entry_count INTEGER NOT NULL,
          photo_count INTEGER NOT NULL DEFAULT 0,
          first_at TEXT,
          latest_at TEXT,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          automatic_cover_base TEXT,
          has_explore INTEGER NOT NULL DEFAULT 0,
          revision INTEGER NOT NULL DEFAULT 1,
          indexed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS gallery_photos (
          date_folder TEXT NOT NULL,
          base TEXT NOT NULL,
          width INTEGER,
          height INTEGER,
          orientation INTEGER NOT NULL,
          processed_at TEXT NOT NULL,
          capture_clock TEXT,
          camera_text TEXT NOT NULL,
          trashed INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (date_folder, base),
          FOREIGN KEY (date_folder) REFERENCES gallery_catalog(date_folder) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX IF NOT EXISTS gallery_photos_visible_time
          ON gallery_photos(date_folder, trashed, processed_at DESC, base DESC);
        PRAGMA user_version = ${CATALOG_SCHEMA_VERSION};
      `);
      if (version === 1) database.exec(`
        DELETE FROM gallery_catalog;
        PRAGMA user_version = ${CATALOG_SCHEMA_VERSION};
      `);
      database.prepare(`
        SELECT date_folder, directory_mtime_ms, directory_entry_count, photo_count, first_at, latest_at,
               duration_ms, automatic_cover_base, has_explore, revision
        FROM gallery_catalog LIMIT 0
      `).all();
      database.prepare(`
        SELECT date_folder, base, width, height, orientation, processed_at, capture_clock, camera_text, trashed
        FROM gallery_photos LIMIT 0
      `).all();
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private catalogDb(): DatabaseSync {
    if (!this.catalog) throw new Error("Gallery catalog is not initialized.");
    return this.catalog;
  }

  private async reconcileCatalog(dateFolder?: string): Promise<void> {
    const result = this.catalogReconciliation.then(async () => {
      const now = Date.now();
      const reconciledAt = dateFolder
        ? Math.max(this.catalogReconciledAt, this.catalogDateReconciledAt.get(dateFolder) ?? 0)
        : this.catalogReconciledAt;
      if (now - reconciledAt < CATALOG_FRESH_MS) return;
      await this.reconcileCatalogInternal(dateFolder);
      const completedAt = Date.now();
      if (dateFolder) this.catalogDateReconciledAt.set(dateFolder, completedAt);
      else {
        this.catalogReconciledAt = completedAt;
        this.catalogDateReconciledAt.clear();
      }
    });
    this.catalogReconciliation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async reconcileCatalogInternal(dateFolder?: string, force = false): Promise<void> {
    if (dateFolder) {
      await this.reconcileCatalogDate(
        dateFolder,
        force || Date.now() - (this.catalogDateDeepScannedAt.get(dateFolder) ?? 0) >= CATALOG_DEEP_SCAN_MS,
      );
      return;
    }
    const dates = (await readdir(this.galleriesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && DATE_PATTERN.test(entry.name))
      .map((entry) => entry.name);
    const available = new Set(dates);
    const indexed = this.catalogDb().prepare("SELECT date_folder FROM gallery_catalog").all() as Array<{ date_folder: string }>;
    const removeDate = this.catalogDb().prepare("DELETE FROM gallery_catalog WHERE date_folder = ?");
    for (const row of indexed) {
      if (!available.has(row.date_folder)) {
        removeDate.run(row.date_folder);
        this.catalogDateDeepScannedAt.delete(row.date_folder);
      }
    }
    await Promise.all(dates.map((date) => this.reconcileCatalogDate(
      date,
      force || Date.now() - (this.catalogDateDeepScannedAt.get(date) ?? 0) >= CATALOG_DEEP_SCAN_MS,
    )));
  }

  private async reconcileCatalogDate(dateFolder: string, force: boolean): Promise<void> {
    const directory = path.join(this.galleriesRoot, dateFolder);
    let directoryInfo: Awaited<ReturnType<typeof stat>>;
    try {
      directoryInfo = await stat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.catalogDb().prepare("DELETE FROM gallery_catalog WHERE date_folder = ?").run(dateFolder);
      this.catalogDateDeepScannedAt.delete(dateFolder);
      return;
    }
    const current = this.catalogDb().prepare(`
      SELECT date_folder, directory_mtime_ms, directory_entry_count, photo_count, first_at, latest_at,
             duration_ms, automatic_cover_base, has_explore, revision
      FROM gallery_catalog WHERE date_folder = ?
    `).get(dateFolder) as unknown as CatalogGalleryRow | undefined;
    // ponytail: published sidecars are immutable after .ready; track sidecar mtimes if that contract changes.
    if (!force && current && Number(current.directory_mtime_ms) === directoryInfo.mtimeMs) return;
    const entries = await readdir(directory);

    const names = new Set(entries);
    const readyBases = entries
      .filter((entry) => entry.endsWith(".ready"))
      .map((entry) => entry.slice(0, -6))
      .filter((base) => BASE_PATTERN.test(base));
    const ready = new Set(readyBases);
    const indexed = this.catalogDb().prepare(`
      SELECT date_folder, base, width, height, orientation, processed_at, capture_clock, camera_text, trashed
      FROM gallery_photos WHERE date_folder = ?
    `).all(dateFolder) as unknown as CatalogPhotoRow[];
    const indexedByBase = new Map(indexed.map((photo) => [photo.base, photo]));
    let retryNeeded = false;
    const additions = (await Promise.all(readyBases
      .filter((base) => !indexedByBase.has(base))
      .map(async (base) => {
        try {
          return await this.readPhoto(dateFolder, base);
        } catch {
          retryNeeded = true;
          return null;
        }
      }))).filter((photo): photo is GalleryPhoto => Boolean(photo));
    const removals = indexed.filter((photo) => !ready.has(photo.base));
    const trashChanges = indexed.filter((photo) => photo.trashed !== Number(names.has(`${photo.base}.trashed.json`)));
    const hasExplore = Number(names.has("_explore.json"));
    const changed = !current
      || additions.length > 0
      || removals.length > 0
      || trashChanges.length > 0
      || Number(current.has_explore) !== hasExplore;
    const database = this.catalogDb();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare(`
        INSERT INTO gallery_catalog (
          date_folder, directory_mtime_ms, directory_entry_count, photo_count, first_at, latest_at,
          duration_ms, automatic_cover_base, has_explore, revision, indexed_at
        ) VALUES (?, ?, ?, 0, NULL, NULL, 0, NULL, ?, 1, ?)
        ON CONFLICT(date_folder) DO UPDATE SET
          directory_mtime_ms = excluded.directory_mtime_ms,
          directory_entry_count = excluded.directory_entry_count,
          has_explore = excluded.has_explore,
          indexed_at = excluded.indexed_at
      `).run(
        dateFolder,
        retryNeeded ? -1 : directoryInfo.mtimeMs,
        entries.length,
        hasExplore,
        new Date().toISOString(),
      );
      const removePhoto = database.prepare("DELETE FROM gallery_photos WHERE date_folder = ? AND base = ?");
      for (const photo of removals) removePhoto.run(dateFolder, photo.base);
      const savePhoto = database.prepare(`
        INSERT INTO gallery_photos (
          date_folder, base, width, height, orientation, processed_at, capture_clock, camera_text, trashed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date_folder, base) DO UPDATE SET
          width = excluded.width,
          height = excluded.height,
          orientation = excluded.orientation,
          processed_at = excluded.processed_at,
          capture_clock = excluded.capture_clock,
          camera_text = excluded.camera_text,
          trashed = excluded.trashed
      `);
      for (const photo of additions) {
        savePhoto.run(
          dateFolder,
          photo.base,
          photo.width,
          photo.height,
          photo.orientation,
          photo.processed_at,
          photo.capture_clock,
          photo.camera_text,
          Number(names.has(`${photo.base}.trashed.json`)),
        );
      }
      const updateTrash = database.prepare("UPDATE gallery_photos SET trashed = ? WHERE date_folder = ? AND base = ?");
      for (const photo of trashChanges) {
        updateTrash.run(Number(names.has(`${photo.base}.trashed.json`)), dateFolder, photo.base);
      }
      const summary = database.prepare(`
        SELECT COUNT(*) AS photo_count, MIN(processed_at) AS first_at, MAX(processed_at) AS latest_at
        FROM gallery_photos WHERE date_folder = ? AND trashed = 0
      `).get(dateFolder) as { photo_count: number; first_at: string | null; latest_at: string | null };
      const automaticCover = database.prepare(`
        SELECT base FROM gallery_photos
        WHERE date_folder = ? AND trashed = 0
        ORDER BY processed_at ASC, base ASC LIMIT 1
      `).get(dateFolder) as { base: string } | undefined;
      const firstMs = summary.first_at ? Date.parse(summary.first_at) : Number.NaN;
      const latestMs = summary.latest_at ? Date.parse(summary.latest_at) : Number.NaN;
      const durationMs = Number.isFinite(firstMs) && Number.isFinite(latestMs) ? Math.max(0, latestMs - firstMs) : 0;
      const revision = current ? Number(current.revision) + Number(changed) : 1;
      database.prepare(`
        UPDATE gallery_catalog SET
          photo_count = ?, first_at = ?, latest_at = ?, duration_ms = ?, automatic_cover_base = ?, revision = ?
        WHERE date_folder = ?
      `).run(
        Number(summary.photo_count),
        summary.first_at,
        summary.latest_at,
        durationMs,
        automaticCover?.base ?? null,
        revision,
        dateFolder,
      );
      database.exec("COMMIT");
      this.catalogDateDeepScannedAt.set(dateFolder, Date.now());
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  private catalogPhotoRows(dateFolder: string): CatalogPhotoRow[] {
    return this.catalogDb().prepare(`
      SELECT date_folder, base, width, height, orientation, processed_at, capture_clock, camera_text, trashed
      FROM gallery_photos
      WHERE date_folder = ? AND trashed = 0
      ORDER BY processed_at DESC, base DESC
    `).all(dateFolder) as unknown as CatalogPhotoRow[];
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
    await this.init();
    await this.reconcileCatalog();
    const rows = this.catalogDb().prepare(`
      SELECT date_folder, directory_mtime_ms, directory_entry_count, photo_count, first_at, latest_at,
             duration_ms, automatic_cover_base, has_explore, revision
      FROM gallery_catalog
      WHERE photo_count > 0
      ORDER BY date_folder DESC
    `).all() as unknown as CatalogGalleryRow[];
    return Promise.all(rows.map(async (row) => {
      const settings = await this.readGallerySettings(row.date_folder);
      const custom = settings.cover_base
        ? this.catalogDb().prepare(`
            SELECT trashed FROM gallery_photos WHERE date_folder = ? AND base = ?
          `).get(row.date_folder, settings.cover_base) as { trashed: number } | undefined
        : undefined;
      const customCoverIsRecoverable = Boolean(
        settings.cover_base
        && custom
        && await statOrNull(path.join(this.galleriesRoot, row.date_folder, `${settings.cover_base}.jpg`)),
      );
      const customCoverIsVisible = customCoverIsRecoverable && custom?.trashed === 0;
      const coverBase = customCoverIsVisible ? settings.cover_base : row.automatic_cover_base;
      return {
        date_folder: row.date_folder,
        count: Number(row.photo_count),
        first_at: row.first_at,
        latest_at: row.latest_at,
        duration_ms: Number(row.duration_ms),
        cover_base: coverBase,
        cover_fallback_active: customCoverIsRecoverable && !customCoverIsVisible,
        cover_is_custom: customCoverIsRecoverable,
        cover_thumbnail_url: coverBase ? `/gallery/thumb/${row.date_folder}/${coverBase}.webp` : null,
        has_explore: Boolean(row.has_explore),
      };
    }));
  }

  async listPhotos(dateFolder: string): Promise<GalleryPhoto[]> {
    assertDate(dateFolder);
    await this.init();
    await this.reconcileCatalog(dateFolder);
    return this.catalogPhotoRows(dateFolder).map(toGalleryPhoto);
  }

  async galleryRevision(dateFolder: string): Promise<number> {
    assertDate(dateFolder);
    await this.init();
    await this.reconcileCatalog(dateFolder);
    const row = this.catalogDb().prepare("SELECT revision FROM gallery_catalog WHERE date_folder = ?")
      .get(dateFolder) as { revision: number } | undefined;
    return Number(row?.revision ?? 0);
  }

  async listPhotoPage(dateFolder: string, limit: number, cursor?: string): Promise<GalleryPhotoPage> {
    assertDate(dateFolder);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PHOTO_PAGE_SIZE) {
      throw new GalleryRequestError(`Photo page size must be from 1 to ${MAX_PHOTO_PAGE_SIZE}.`, 400);
    }
    await this.init();
    await this.reconcileCatalog(dateFolder);
    const gallery = this.catalogDb().prepare(`
      SELECT photo_count, revision FROM gallery_catalog WHERE date_folder = ?
    `).get(dateFolder) as { photo_count: number; revision: number } | undefined;
    const position = cursor ? decodePhotoCursor(cursor) : null;
    const rows = (position
      ? this.catalogDb().prepare(`
          SELECT date_folder, base, width, height, orientation, processed_at, capture_clock, camera_text, trashed
          FROM gallery_photos
          WHERE date_folder = ? AND trashed = 0
            AND (processed_at < ? OR (processed_at = ? AND base < ?))
          ORDER BY processed_at DESC, base DESC
          LIMIT ?
        `).all(dateFolder, position.processed_at, position.processed_at, position.base, limit + 1)
      : this.catalogDb().prepare(`
          SELECT date_folder, base, width, height, orientation, processed_at, capture_clock, camera_text, trashed
          FROM gallery_photos
          WHERE date_folder = ? AND trashed = 0
          ORDER BY processed_at DESC, base DESC
          LIMIT ?
        `).all(dateFolder, limit + 1)) as unknown as CatalogPhotoRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      photos: page.map(toGalleryPhoto),
      total: Number(gallery?.photo_count ?? 0),
      next_cursor: hasMore && last ? encodePhotoCursor(last.processed_at, last.base) : null,
      revision: Number(gallery?.revision ?? 0),
    };
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
    // Photo management calls this before its immediate UI refresh; do not serve that refresh from the freshness window.
    await this.catalogReconciliation;
    this.catalogReconciledAt = 0;
    this.catalogDateReconciledAt.clear();
    this.catalogDateDeepScannedAt.clear();
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
      const generated = await pending;
      await this.assertPublished(view.date_folder, view.base);
      const current = await stat(image);
      if (current.mtimeMs !== view.source_mtime_ms || current.size !== view.source_size_bytes) {
        throw new GalleryRequestError("Viewing session expired.", 404);
      }
      await access(tile);
      if (generated) await this.pruneObsoleteTileSets(view, tileSet);
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

  private async generateTileSet(image: string, tileSet: string, requestedTile: string): Promise<boolean> {
    const completeMarker = path.join(tileSet, TILE_COMPLETE_FILE);
    if (await statOrNull(completeMarker) && await statOrNull(requestedTile)) return false;
    return this.withTileGenerator(async () => {
      if (await statOrNull(completeMarker) && await statOrNull(requestedTile)) return false;
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
        return true;
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }

  private async pruneObsoleteTileSets(view: GalleryTileView, currentTileSet: string): Promise<void> {
    const photoRoot = path.join(this.cacheRoot, "tiles", view.date_folder, view.base);
    const currentVersionRoot = path.dirname(currentTileSet);
    const currentSourceMtime = Math.round(view.source_mtime_ms * 1000);
    try {
      for (const entry of await readdir(photoRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const versionRoot = path.join(photoRoot, entry.name);
        if (versionRoot !== currentVersionRoot) {
          await rm(versionRoot, { recursive: true, force: true });
          continue;
        }
        for (const source of await readdir(versionRoot, { withFileTypes: true })) {
          const match = source.isDirectory() ? source.name.match(/^(\d+)-\d+$/) : null;
          const abandonedTemporary = source.isDirectory() && /^\d+-\d+\.tmp-\d+-[a-f0-9]{16}$/.test(source.name);
          if (abandonedTemporary || match && source.name !== view.source_version && Number(match[1]) <= currentSourceMtime) {
            await rm(path.join(versionRoot, source.name), { recursive: true, force: true });
          }
        }
      }
    } catch (error) {
      console.warn(`[gallery] could not prune obsolete tile cache for ${view.date_folder}/${view.base}: ${errorMessage(error)}`);
    }
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
    const processedAt = normalizeTimestamp(sidecar?.processed_at);
    return {
      base,
      date_folder: dateFolder,
      thumbnail_url: `/gallery/thumb/${dateFolder}/${base}.webp`,
      width: integerOrNull(sidecar?.width),
      height: integerOrNull(sidecar?.height),
      orientation: sidecar?.orientation === 1 ? 1 : 0,
      processed_at: processedAt ?? readyInfo.mtime.toISOString(),
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

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const offset = match[7];
  const [offsetHour, offsetMinute] = offset === "Z" ? [0, 0] : offset.slice(1).split(":").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function toGalleryPhoto(row: CatalogPhotoRow): GalleryPhoto {
  return {
    base: row.base,
    date_folder: row.date_folder,
    thumbnail_url: `/gallery/thumb/${row.date_folder}/${row.base}.webp`,
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    orientation: Number(row.orientation) === 1 ? 1 : 0,
    processed_at: row.processed_at,
    capture_clock: row.capture_clock,
    camera_text: row.camera_text,
  };
}

function encodePhotoCursor(processedAt: string, base: string): string {
  return Buffer.from(JSON.stringify([processedAt, base])).toString("base64url");
}

function decodePhotoCursor(cursor: string): { processed_at: string; base: string } {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("invalid encoding");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !Array.isArray(value)
      || value.length !== 2
      || typeof value[0] !== "string"
      || !Number.isFinite(Date.parse(value[0]))
      || typeof value[1] !== "string"
      || !BASE_PATTERN.test(value[1])
    ) throw new Error("invalid cursor");
    return { processed_at: value[0], base: value[1] };
  } catch {
    throw new GalleryRequestError("Photo cursor is invalid.", 400);
  }
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
