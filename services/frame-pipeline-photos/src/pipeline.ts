import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import exifReader from "exif-reader";
import { fileTypeFromFile } from "file-type";
import sharp, { type Metadata } from "sharp";
import type { PipelineConfig } from "./config.js";
import { atomicWrite, atomicWriteJson, hostJoin, sanitizeBase } from "./fsUtils.js";

const RAW_EXTENSIONS = new Set([
  ".3fr", ".arw", ".cr2", ".cr3", ".dng", ".erf", ".kdc", ".mos", ".mrw", ".nef",
  ".nrw", ".orf", ".pef", ".raf", ".raw", ".rw2", ".sr2", ".srf", ".x3f",
]);

export interface PipelineStatus {
  running: boolean;
  queue_depth: number;
  processing: number;
  published: number;
  quarantined: number;
  last_publish_at: string | null;
  last_error: string | null;
  heic_supported: boolean;
}

interface Claim {
  jobId: string;
  originalName: string;
  directory: string;
  source: string;
}

interface Publication {
  dateFolder: string;
  base: string;
}

export type PhotoManagementAction =
  | "trash-photo"
  | "restore-photo"
  | "purge-photo"
  | "trash-album"
  | "restore-album"
  | "purge-album"
  | "empty-trash";

export interface TrashedPublication {
  date_folder: string;
  base: string;
  trashed_at: string;
  processed_at: string | null;
  original_name: string | null;
}

export interface PhotoManagementResult {
  ok: true;
  action: PhotoManagementAction;
  affected: number;
  updated_at: string;
  date_folder: string;
  latest_base: string | null;
  count_today: number;
}

interface QuarantineReason {
  code: string;
  reason: string;
  detail: string;
  detectedMime?: string;
  attempts?: number;
}

export class PhotoPipeline {
  readonly directories: Record<string, string>;
  readonly status: PipelineStatus;
  private timer: NodeJS.Timeout | null = null;
  private processing = new Set<string>();
  private scanning = false;
  private publishLock: Promise<void> = Promise.resolve();

  constructor(readonly config: PipelineConfig) {
    this.directories = Object.fromEntries(
      ["staging", "processing", "galleries", "state", "archive", "quarantine"].map((name) => [
        name,
        path.join(config.dataRoot, name),
      ]),
    );
    this.status = {
      running: false,
      queue_depth: 0,
      processing: 0,
      published: 0,
      quarantined: 0,
      last_publish_at: null,
      last_error: null,
      heic_supported: Boolean(sharp.format.heif?.input?.buffer),
    };
  }

  async init(): Promise<void> {
    for (const directory of Object.values(this.directories)) {
      await mkdir(directory, { recursive: true });
    }
    await this.reconcileLatest();
  }

  start(): void {
    if (this.timer) return;
    this.status.running = true;
    void this.processOnce();
    this.timer = setInterval(() => void this.processOnce(), this.config.pollMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.status.running = false;
  }

  async processOnce(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.claimStagedFiles();
      const claims = await this.readClaims();
      this.status.queue_depth = claims.length;
      const available = claims.filter((claim) => !this.processing.has(claim.jobId));
      await runPool(available, this.config.concurrency, async (claim) => {
        this.processing.add(claim.jobId);
        this.status.processing = this.processing.size;
        try {
          await this.processClaim(claim);
        } finally {
          this.processing.delete(claim.jobId);
          this.status.processing = this.processing.size;
        }
      });
      this.status.queue_depth = (await this.readClaims()).length;
    } catch (error) {
      this.status.last_error = errorMessage(error);
      console.error(`[photo-pipeline] scan failed: ${this.status.last_error}`);
    } finally {
      this.scanning = false;
    }
  }

  async listTrash(): Promise<TrashedPublication[]> {
    const trashed: TrashedPublication[] = [];
    for (const dateFolder of await safeReadDirectories(this.directories.galleries)) {
      if (!isDateFolder(dateFolder)) continue;
      const directory = path.join(this.directories.galleries, dateFolder);
      for (const entry of await readdir(directory)) {
        if (!entry.endsWith(".trashed.json")) continue;
        const base = entry.slice(0, -13);
        if (!isPhotoBase(base)) continue;
        const marker = await readJsonOrNull<Record<string, unknown>>(path.join(directory, entry));
        const sidecar = await readJsonOrNull<Record<string, unknown>>(path.join(directory, `${base}.json`));
        trashed.push({
          date_folder: dateFolder,
          base,
          trashed_at: typeof marker?.trashed_at === "string" ? marker.trashed_at : new Date(0).toISOString(),
          processed_at: typeof sidecar?.processed_at === "string" ? sidecar.processed_at : null,
          original_name: typeof sidecar?.original_name === "string" ? sidecar.original_name : null,
        });
      }
    }
    return trashed.sort((left, right) => right.trashed_at.localeCompare(left.trashed_at));
  }

  async managePhotos(action: PhotoManagementAction, dateFolder?: string, base?: string): Promise<PhotoManagementResult> {
    return this.withPublishLock(async () => {
      const affected = await this.applyManagementAction(action, dateFolder, base);
      const latest = await this.recalculateLatest(new Date().toISOString());
      console.log(`[photo-pipeline] ${action} affected ${affected} publication(s)`);
      return { ok: true, action, affected, ...latest };
    });
  }

  private async claimStagedFiles(): Promise<void> {
    const entries = await readdir(this.directories.staging, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.startsWith(".") || entry.name.endsWith(".uploading")) continue;
      const jobId = randomUUID();
      const encodedName = Buffer.from(entry.name, "utf8").toString("base64url");
      const directory = path.join(this.directories.processing, `${jobId}--${encodedName}`);
      await mkdir(directory);
      try {
        await rename(path.join(this.directories.staging, entry.name), path.join(directory, "source"));
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async readClaims(): Promise<Claim[]> {
    const entries = await readdir(this.directories.processing, { withFileTypes: true });
    const claims: Claim[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const separator = entry.name.indexOf("--");
      if (separator < 1) continue;
      try {
        const originalName = Buffer.from(entry.name.slice(separator + 2), "base64url").toString("utf8");
        const directory = path.join(this.directories.processing, entry.name);
        await access(path.join(directory, "source"));
        claims.push({ jobId: entry.name.slice(0, separator), originalName, directory, source: path.join(directory, "source") });
      } catch (error) {
        console.warn(`[photo-pipeline] ignored invalid claim ${entry.name}: ${errorMessage(error)}`);
      }
    }
    return claims;
  }

  private async processClaim(claim: Claim): Promise<void> {
    let detectedMime = "application/octet-stream";
    let attempts = 0;
    try {
      if (await this.recoverPublishedClaim(claim)) return;
      const sourceStat = await stat(claim.source);
      if (sourceStat.size > this.config.maxInputBytes) {
        throw failure("PPL-02", "CONVERT_FAILED", `Input exceeds ${this.config.maxInputBytes} bytes.`);
      }
      if (RAW_EXTENSIONS.has(path.extname(claim.originalName).toLowerCase())) {
        throw failure("PPL-03", "RAW_UNSUPPORTED", "Camera RAW files are not supported in V1.");
      }

      const detected = await fileTypeFromFile(claim.source);
      detectedMime = detected?.mime ?? detectedMime;
      if (!detected || !detected.mime.startsWith("image/")) {
        throw failure("PPL-01", "NOT_IMAGE", "Detected file type is not an image.", detectedMime);
      }
      if ((detected.ext === "heic" || detected.ext === "heif") && !this.status.heic_supported) {
        throw failure("PPL-02", "CONVERT_FAILED", "HEIC decoding is unavailable in this runtime.", detectedMime);
      }

      let sourceMetadata: Metadata;
      try {
        sourceMetadata = await sharp(claim.source, { failOn: "error" }).metadata();
      } catch (error) {
        throw failure("PPL-04", "DECODE_FAILED", `Image could not be decoded: ${errorMessage(error)}`, detectedMime);
      }
      const sourcePixels = (sourceMetadata.width ?? 0) * (sourceMetadata.height ?? 0);
      if (!sourcePixels || sourcePixels > this.config.maxPixels) {
        throw failure("PPL-04", "DECODE_FAILED", `Decoded image exceeds ${this.config.maxPixels} pixels.`, detectedMime);
      }

      const publication = await this.getOrCreatePublication(claim);
      const { dateFolder, base } = publication;
      const targetDirectory = path.join(this.directories.galleries, dateFolder);
      const files = outputFiles(targetDirectory, base);
      await cleanupPartialPublication(files);

      let finalMetadata: Metadata | null = null;
      for (attempts = 1; attempts <= this.config.conversionAttempts; attempts += 1) {
        try {
          const temporaryJpg = path.join(claim.directory, "normalized.jpg.tmp");
          await rm(temporaryJpg, { force: true });
          await sharp(claim.source, { failOn: "error" })
            .rotate()
            .jpeg({ quality: 94, mozjpeg: true })
            .withMetadata()
            .toFile(temporaryJpg);
          await rename(temporaryJpg, files.jpg);
          finalMetadata = await sharp(files.jpg).metadata();
          break;
        } catch (error) {
          if (attempts >= this.config.conversionAttempts) {
            throw failure("PPL-02", "CONVERT_FAILED", `Conversion failed: ${errorMessage(error)}`, detectedMime, attempts);
          }
        }
      }
      if (!finalMetadata?.width || !finalMetadata.height) {
        throw failure("PPL-04", "DECODE_FAILED", "Final JPG dimensions are unavailable.", detectedMime, attempts);
      }

      const orientation = finalMetadata.height > finalMetadata.width ? 1 : 0;
      const processedAt = new Date().toISOString();
      const exif = readExif(sourceMetadata.exif);
      const sidecar = {
        schema_version: 1,
        base,
        original_name: claim.originalName,
        detected_mime: detectedMime,
        detected_format: detected.ext,
        width: finalMetadata.width,
        height: finalMetadata.height,
        orientation,
        processed_at: processedAt,
        date_folder: dateFolder,
        exif,
        warnings: Object.keys(exif).length ? [] : ["EXIF metadata was not present or could not be decoded."],
      };
      const cameraText = formatCameraText(exif);

      await atomicWriteJson(files.json, sidecar);
      await atomicWrite(files.txt, `${cameraText}\n`);
      await atomicWrite(files.orientation, `${orientation}\n`);
      await atomicWrite(
        files.ready,
        `${hostJoin(this.config.hostDataRoot, "galleries", dateFolder, `${base}.jpg`)}\n` +
          `${hostJoin(this.config.hostDataRoot, "galleries", dateFolder, `${base}.txt`)}\n${orientation}\n`,
      );
      await this.withPublishLock(async () => {
        await this.recalculateLatest(processedAt);
      });
      await this.finishClaim(claim, dateFolder);
      this.status.published += 1;
      this.status.last_publish_at = processedAt;
      this.status.last_error = null;
      console.log(`[photo-pipeline] published ${claim.originalName} as ${dateFolder}/${base}`);
    } catch (error) {
      if (await this.recoverPublishedClaim(claim)) return;
      const reason = error instanceof PipelineFailure
        ? error.reason
        : failureReason("PPL-07", "PIPELINE_INTERNAL_ERROR", errorMessage(error), detectedMime, attempts);
      const publication = await this.readPublication(claim);
      if (publication) {
        await cleanupPartialPublication(outputFiles(path.join(this.directories.galleries, publication.dateFolder), publication.base));
      }
      await this.quarantine(claim, reason);
      this.status.quarantined += 1;
      this.status.last_error = reason.detail;
      console.error(`[photo-pipeline] quarantined ${claim.originalName}: ${reason.code} ${reason.detail}`);
    }
  }

  private async getOrCreatePublication(claim: Claim): Promise<Publication> {
    const existing = await this.readPublication(claim);
    if (existing) return existing;
    return this.withPublishLock(async () => {
      const rechecked = await this.readPublication(claim);
      if (rechecked) return rechecked;
      const now = new Date();
      const local = localParts(now, this.config.timezone);
      const dateFolder = `${local.year}-${local.month}-${local.day}`;
      const targetDirectory = path.join(this.directories.galleries, dateFolder);
      await mkdir(targetDirectory, { recursive: true });
      const stem = sanitizeBase(path.parse(claim.originalName).name);
      const requestedBase = `${stem}_${dateFolder}_${local.hour}_${local.minute}_${local.second}`;
      const publication = {
        dateFolder,
        base: await allocateBase(targetDirectory, requestedBase, await this.reservedBases(dateFolder)),
      };
      await atomicWriteJson(path.join(claim.directory, "publication.json"), publication);
      return publication;
    });
  }

  private async reservedBases(dateFolder: string): Promise<Set<string>> {
    const reserved = new Set<string>();
    for (const claim of await this.readClaims()) {
      const publication = await this.readPublication(claim);
      if (publication?.dateFolder === dateFolder) reserved.add(publication.base);
    }
    return reserved;
  }

  private async recoverPublishedClaim(claim: Claim): Promise<boolean> {
    const publication = await this.readPublication(claim);
    if (!publication) return false;
    const ready = path.join(this.directories.galleries, publication.dateFolder, `${publication.base}.ready`);
    if (!(await exists(ready))) return false;
    await this.withPublishLock(async () => {
      await this.recalculateLatest(new Date().toISOString());
      await this.finishClaim(claim, publication.dateFolder);
    });
    this.status.published += 1;
    this.status.last_publish_at = new Date().toISOString();
    this.status.last_error = null;
    console.log(`[photo-pipeline] recovered completed publish ${publication.dateFolder}/${publication.base}`);
    return true;
  }

  private async readPublication(claim: Claim): Promise<Publication | null> {
    try {
      const value = JSON.parse(await readFile(path.join(claim.directory, "publication.json"), "utf8")) as Partial<Publication>;
      return typeof value.dateFolder === "string" && typeof value.base === "string"
        ? { dateFolder: value.dateFolder, base: value.base }
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async finishClaim(claim: Claim, dateFolder: string): Promise<void> {
    if (this.config.archiveOriginals) {
      const archiveDirectory = path.join(this.directories.archive, dateFolder);
      await mkdir(archiveDirectory, { recursive: true });
      await rename(claim.source, await availablePath(archiveDirectory, sanitizeFilename(claim.originalName)));
    }
    await rm(claim.directory, { recursive: true, force: true });
  }

  private async quarantine(claim: Claim, reason: QuarantineReason): Promise<void> {
    await mkdir(this.directories.quarantine, { recursive: true });
    const suffix = `${sanitizeBase(path.parse(claim.originalName).name)}_${claim.jobId.slice(0, 8)}`;
    const originalTarget = await availablePath(this.directories.quarantine, `${suffix}${path.extname(claim.originalName)}`);
    try {
      await rename(claim.source, originalTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWriteJson(path.join(this.directories.quarantine, `${suffix}.error.json`), {
      reason_code: reason.code,
      reason: reason.reason,
      detail: reason.detail,
      original_name: claim.originalName,
      detected_mime: reason.detectedMime ?? "application/octet-stream",
      attempts: reason.attempts ?? 0,
      timestamp: new Date().toISOString(),
      log_ref: `frame-pipeline-photos:${new Date().toISOString()}:${claim.jobId.slice(0, 8)}`,
    });
    await rm(claim.directory, { recursive: true, force: true });
  }

  private async writeLatest(dateFolder: string, base: string | null, updatedAt: string, latestPhotoAt?: string | null): Promise<{
    updated_at: string;
    date_folder: string;
    latest_base: string | null;
    count_today: number;
    latest_photo_at: string | null;
  }> {
    const entries = await readdir(path.join(this.directories.galleries, dateFolder));
    const latest = {
      updated_at: updatedAt,
      date_folder: dateFolder,
      latest_base: base,
      count_today: entries.filter((entry) => entry.endsWith(".ready") && !entries.includes(`${entry.slice(0, -6)}.trashed.json`)).length,
      latest_photo_at: latestPhotoAt ?? null,
    };
    await atomicWriteJson(path.join(this.directories.state, "latest.json"), latest);
    return latest;
  }

  private async reconcileLatest(): Promise<void> {
    if (!(await exists(path.join(this.directories.state, "latest.json"))) && !(await this.hasReadyPublications())) return;
    await this.recalculateLatest(new Date().toISOString());
  }

  private async hasReadyPublications(): Promise<boolean> {
    for (const dateFolder of await safeReadDirectories(this.directories.galleries)) {
      if (!isDateFolder(dateFolder)) continue;
      if ((await readdir(path.join(this.directories.galleries, dateFolder))).some((entry) => entry.endsWith(".ready"))) return true;
    }
    return false;
  }

  private async recalculateLatest(updatedAt: string): Promise<{
    updated_at: string;
    date_folder: string;
    latest_base: string | null;
    count_today: number;
    latest_photo_at: string | null;
  }> {
    const revision = await this.nextRevisionTimestamp(updatedAt);
    const candidates: Array<{ dateFolder: string; base: string; mtimeMs: number; updatedAt: string }> = [];
    for (const dateFolder of await safeReadDirectories(this.directories.galleries)) {
      if (!isDateFolder(dateFolder)) continue;
      const directory = path.join(this.directories.galleries, dateFolder);
      const entries = await readdir(directory);
      for (const entry of entries) {
        if (!entry.endsWith(".ready")) continue;
        const base = entry.slice(0, -6);
        if (entries.includes(`${base}.trashed.json`)) continue;
        const info = await stat(path.join(directory, entry));
        candidates.push({ dateFolder, base, mtimeMs: info.mtimeMs, updatedAt: info.mtime.toISOString() });
      }
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const latest = candidates[0];
    if (latest) {
      await this.updateTodayLink(latest.dateFolder);
      return this.writeLatest(latest.dateFolder, latest.base, revision, latest.updatedAt);
    }
    await rm(path.join(this.config.dataRoot, "today"), { recursive: true, force: true });
    const local = localParts(new Date(), this.config.timezone);
    const dateFolder = `${local.year}-${local.month}-${local.day}`;
    await mkdir(path.join(this.directories.galleries, dateFolder), { recursive: true });
    return this.writeLatest(dateFolder, null, revision);
  }

  private async nextRevisionTimestamp(candidate: string): Promise<string> {
    const current = await readJsonOrNull<{ updated_at?: unknown }>(path.join(this.directories.state, "latest.json"));
    const previousMs = typeof current?.updated_at === "string" ? Date.parse(current.updated_at) : Number.NaN;
    const candidateMs = Date.parse(candidate);
    return new Date(Number.isFinite(previousMs)
      ? Math.max(Number.isFinite(candidateMs) ? candidateMs : Date.now(), previousMs + 1)
      : Number.isFinite(candidateMs) ? candidateMs : Date.now()).toISOString();
  }

  private async applyManagementAction(action: PhotoManagementAction, dateFolder?: string, base?: string): Promise<number> {
    if (action === "empty-trash") {
      let affected = 0;
      for (const item of await this.listTrash()) {
        await this.purgePublication(item.date_folder, item.base);
        affected += 1;
      }
      return affected;
    }
    if (!dateFolder || !isDateFolder(dateFolder)) throw new PhotoManagementError("A valid date_folder is required.", 400);
    if (action.endsWith("-photo")) {
      if (!base || !isPhotoBase(base)) throw new PhotoManagementError("A valid photo base is required.", 400);
      if (action === "trash-photo") return this.trashPublication(dateFolder, base);
      if (action === "restore-photo") return this.restorePublication(dateFolder, base);
      return this.purgePublication(dateFolder, base);
    }
    const entries = await safeReadEntries(path.join(this.directories.galleries, dateFolder));
    const bases = action === "trash-album"
      ? visibleBases(entries)
      : trashedBases(entries);
    let affected = 0;
    for (const item of bases) {
      if (action === "trash-album") affected += await this.trashPublication(dateFolder, item);
      if (action === "restore-album") affected += await this.restorePublication(dateFolder, item);
      if (action === "purge-album") affected += await this.purgePublication(dateFolder, item);
    }
    return affected;
  }

  private async trashPublication(dateFolder: string, base: string): Promise<number> {
    const directory = path.join(this.directories.galleries, dateFolder);
    const ready = path.join(directory, `${base}.ready`);
    const marker = path.join(directory, `${base}.trashed.json`);
    if (!(await exists(ready))) throw new PhotoManagementError("Published photo was not found.", 404);
    if (await exists(marker)) return 0;
    await atomicWriteJson(marker, {
      schema_version: 1,
      date_folder: dateFolder,
      base,
      trashed_at: new Date().toISOString(),
    });
    return 1;
  }

  private async restorePublication(dateFolder: string, base: string): Promise<number> {
    const marker = path.join(this.directories.galleries, dateFolder, `${base}.trashed.json`);
    if (!(await exists(marker))) return 0;
    await rm(marker, { force: true });
    return 1;
  }

  private async purgePublication(dateFolder: string, base: string): Promise<number> {
    const directory = path.join(this.directories.galleries, dateFolder);
    const marker = path.join(directory, `${base}.trashed.json`);
    if (!(await exists(marker))) throw new PhotoManagementError("Only trashed photos can be permanently deleted.", 409);
    for (const claim of await this.readClaims()) {
      const publication = await this.readPublication(claim);
      if (publication?.dateFolder === dateFolder && publication.base === base) {
        throw new PhotoManagementError("Photo publishing is still finishing. Try permanent deletion again shortly.", 409);
      }
    }
    await Promise.all(
      ["jpg", "json", "txt", "orientation", "ready", "trashed.json"]
        .map((extension) => rm(path.join(directory, `${base}.${extension}`), { force: true })),
    );
    await this.clearThumbnail(dateFolder, base);
    return 1;
  }

  private async clearThumbnail(dateFolder: string, base: string): Promise<void> {
    await rm(path.join(this.config.dataRoot, "gallery-cache", dateFolder, `${base}.webp`), { force: true });
  }

  private async updateTodayLink(dateFolder: string): Promise<void> {
    const today = path.join(this.config.dataRoot, "today");
    const target = path.join(this.directories.galleries, dateFolder);
    try {
      const current = await readlink(today);
      if (path.resolve(path.dirname(today), current) === path.resolve(target)) return;
    } catch {
      // Missing or non-link paths are replaced below.
    }
    const temporary = `${today}.${randomUUID()}.tmp`;
    await rm(temporary, { recursive: true, force: true });
    await symlink(target, temporary, process.platform === "win32" ? "junction" : "dir");
    try {
      await rename(temporary, today);
    } catch {
      await rm(today, { recursive: true, force: true });
      await rename(temporary, today);
    }
  }

  private async withPublishLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.publishLock;
    let release: () => void = () => undefined;
    this.publishLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

class PipelineFailure extends Error {
  constructor(readonly reason: QuarantineReason) {
    super(reason.detail);
  }
}

export class PhotoManagementError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function failure(code: string, reason: string, detail: string, detectedMime?: string, attempts?: number): PipelineFailure {
  return new PipelineFailure(failureReason(code, reason, detail, detectedMime, attempts));
}

function failureReason(code: string, reason: string, detail: string, detectedMime?: string, attempts?: number): QuarantineReason {
  return { code, reason, detail, detectedMime, attempts };
}

function outputFiles(directory: string, base: string): Record<"jpg" | "json" | "txt" | "orientation" | "ready", string> {
  return Object.fromEntries(["jpg", "json", "txt", "orientation", "ready"].map((extension) => [
    extension,
    path.join(directory, `${base}.${extension}`),
  ])) as Record<"jpg" | "json" | "txt" | "orientation" | "ready", string>;
}

async function allocateBase(directory: string, requested: string, reserved = new Set<string>()): Promise<string> {
  for (let index = 1; index < 10000; index += 1) {
    const candidate = index === 1 ? requested : `${requested}_${index}`;
    if (reserved.has(candidate)) continue;
    try {
      await access(path.join(directory, `${candidate}.jpg`));
    } catch {
      return candidate;
    }
  }
  throw new Error("Unable to allocate a unique photo base.");
}

async function cleanupPartialPublication(files: Record<"jpg" | "json" | "txt" | "orientation" | "ready", string>): Promise<void> {
  if (await exists(files.ready)) return;
  await Promise.all([files.jpg, files.json, files.txt, files.orientation].map((file) => rm(file, { force: true })));
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJsonOrNull<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function safeReadEntries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function visibleBases(entries: string[]): string[] {
  const names = new Set(entries);
  return entries
    .filter((entry) => entry.endsWith(".ready"))
    .map((entry) => entry.slice(0, -6))
    .filter((base) => !names.has(`${base}.trashed.json`));
}

function trashedBases(entries: string[]): string[] {
  return entries
    .filter((entry) => entry.endsWith(".trashed.json"))
    .map((entry) => entry.slice(0, -13))
    .filter(isPhotoBase);
}

function isDateFolder(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isPhotoBase(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

async function availablePath(directory: string, filename: string): Promise<string> {
  const parsed = path.parse(filename);
  for (let index = 1; index < 10000; index += 1) {
    const candidate = index === 1 ? filename : `${parsed.name}_${index}${parsed.ext}`;
    const target = path.join(directory, candidate);
    try {
      await access(target);
    } catch {
      return target;
    }
  }
  throw new Error("Unable to allocate a unique destination.");
}

function sanitizeFilename(filename: string): string {
  const parsed = path.parse(filename);
  return `${sanitizeBase(parsed.name)}${parsed.ext.toLowerCase().replace(/[^.a-z0-9]/g, "")}`;
}

function readExif(buffer: Buffer | undefined): Record<string, unknown> {
  if (!buffer) return {};
  try {
    const parsed = exifReader(buffer) as unknown;
    if (!isRecord(parsed)) return {};
    const image = pickExifFields(childRecord(parsed, "Image"), [
      "Make",
      "Model",
      "Software",
      "DateTime",
      "Orientation",
    ]);
    const photo = pickExifFields(childRecord(parsed, "Photo"), [
      "ExposureTime",
      "FNumber",
      "ISOSpeedRatings",
      "DateTimeOriginal",
      "FocalLength",
      "LensMake",
      "LensModel",
      "ExposureBiasValue",
      "Flash",
      "WhiteBalance",
    ]);
    return {
      ...(Object.keys(image).length ? { Image: image } : {}),
      ...(Object.keys(photo).length ? { Photo: photo } : {}),
    };
  } catch {
    return {};
  }
}

function formatCameraText(exif: Record<string, unknown>): string {
  const image = childRecord(exif, "Image");
  const photo = childRecord(exif, "Photo");
  const make = textValue(image.Make);
  const model = textValue(image.Model);
  const camera = [make, model].filter(Boolean).join(" ") || "(unknown)";
  const lens = textValue(photo.LensModel) || textValue(image.LensModel) || "(unknown)";
  return [
    `Camera: ${camera}`,
    `Lens: ${lens}`,
    `Exposure: ${formatExposure(photo.ExposureTime)}`,
    `Aperture: ${formatAperture(photo.FNumber)}`,
    `ISO: ${numberText(photo.ISOSpeedRatings)}`,
    `Focal length: ${formatFocalLength(photo.FocalLength)}`,
  ].join("\n");
}

function formatExposure(value: unknown): string {
  const exposure = numberValue(value);
  if (!exposure) return "(unknown)";
  if (exposure < 1) return `1/${Math.round(1 / exposure)} sec`;
  return `${trimNumber(exposure)} sec`;
}

function formatAperture(value: unknown): string {
  const aperture = numberValue(value);
  return aperture ? `f/${trimNumber(aperture)}` : "(unknown)";
}

function formatFocalLength(value: unknown): string {
  const focalLength = numberValue(value);
  return focalLength ? `${trimNumber(focalLength)} mm` : "(unknown)";
}

function numberText(value: unknown): string {
  const number = numberValue(value);
  return number ? trimNumber(number) : "(unknown)";
}

function numberValue(value: unknown): number | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? candidate : null;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function childRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  return isRecord(parent[key]) ? parent[key] : {};
}

function pickExifFields(record: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      selected[field] = value;
      continue;
    }
    if (value instanceof Date) {
      selected[field] = value.toISOString();
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "number" || typeof item === "string")) {
      selected[field] = value.slice(0, 8);
    }
  }
  return selected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function localParts(date: Date, timezone: string): Record<"year" | "month" | "day" | "hour" | "minute" | "second", string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])) as Record<
    "year" | "month" | "day" | "hour" | "minute" | "second",
    string
  >;
}

async function safeReadDirectories(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function runPool<T>(items: T[], concurrency: number, operation: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item !== undefined) await operation(item);
    }
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
