import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import exifReader from "exif-reader";
import { fileTypeFromFile } from "file-type";
import decodeHeic from "heic-decode";
import sharp, { type Metadata } from "sharp";
import type { PipelineConfig, PipelineProcessingSettings } from "./config.js";
import { atomicWrite, atomicWriteJson, hostJoin, sanitizeBase } from "./fsUtils.js";

const RAW_EXTENSIONS = new Set([
  ".3fr", ".arw", ".cr2", ".cr3", ".dng", ".erf", ".kdc", ".mos", ".mrw", ".nef",
  ".nrw", ".orf", ".pef", ".raf", ".raw", ".rw2", ".sr2", ".srf", ".x3f",
]);
const RASTER_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp", ".heic", ".heif"]);
const SETTINGS_FILE = "photo-pipeline-settings.json";
const EXPLORE_FILE = "_explore.json";
const EXPLORE_ID_PATTERN = /^[A-Za-z0-9_-]{1,96}$/;
const MAX_EXPLORE_ROUTES = 20;
const MAX_EXPLORE_SEGMENTS = 2_000;
const MAX_EXPLORE_POINTS = 50_000;
const MAX_EXPLORE_PLACEMENTS = 10_000;

export type ExplorePoint = [number, number, number];

export interface GalleryExplore {
  schema_version: 1;
  updated_at: string;
  time_shift_seconds: number;
  time_adjustment_seconds: number;
  routes: Array<{
    id: string;
    name: string;
    imported_at: string;
    segments: ExplorePoint[][];
  }>;
  placements: Record<string, { lat: number; lon: number; timestamp?: number; updated_at: string }>;
}

export interface PipelineStatus {
  running: boolean;
  queue_depth: number;
  processing: number;
  published: number;
  quarantined: number;
  last_publish_at: string | null;
  last_publish_file: string | null;
  last_quarantine_at: string | null;
  last_quarantine_file: string | null;
  last_error: string | null;
  heic_supported: boolean;
}

interface Claim {
  jobId: string;
  originalName: string;
  directory: string;
  source: string;
  journey: VerifiedPhotoJourney;
  integrityError?: string;
}

interface Publication {
  dateFolder: string;
  base: string;
  journeyId: string;
}

interface JourneyIngest {
  adapter: string;
  transfer_id: string;
  bytes_received: number;
}

interface PhotoJourney {
  schema_version: 1;
  journey_id: string;
  content_sha256?: string;
  original_name: string;
  received_at: string;
  ingest: JourneyIngest;
}

interface VerifiedPhotoJourney extends PhotoJourney {
  content_sha256: string;
}

export interface JourneyProgress extends PhotoJourney {
  state: "received" | "processing" | "published" | "failed";
  updated_at: string;
  job_id: string;
  date_folder?: string;
  base?: string;
  error?: string;
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
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
  private heicLock: Promise<void> = Promise.resolve();
  private recentJourneyReceipts = new Map<string, JourneyProgress>();
  private settings: PipelineProcessingSettings;

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
      last_publish_file: null,
      last_quarantine_at: null,
      last_quarantine_file: null,
      last_error: null,
      heic_supported: true,
    };
    this.settings = normalizeSettings(config.defaultSettings, config.defaultSettings);
  }

  async init(): Promise<void> {
    for (const directory of Object.values(this.directories)) {
      await mkdir(directory, { recursive: true });
    }
    await mkdir(this.journeyReceiptDirectory(), { recursive: true });
    await this.loadJourneyReceipts();
    await this.loadSettings();
    await this.ensureCurrentGallery();
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
      await this.ensureCurrentGallery();
      await this.claimStagedFiles();
      const claims = await this.readClaims();
      for (const claim of claims) {
        if (!claim.integrityError) await this.recordJourneyReceived(claim);
      }
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

  getSettings(): PipelineProcessingSettings {
    return { ...this.settings };
  }

  async updateSettings(candidate: unknown): Promise<PipelineProcessingSettings> {
    this.settings = normalizeSettings(candidate, this.config.defaultSettings);
    await atomicWriteJson(path.join(this.directories.state, SETTINGS_FILE), this.settings);
    return this.getSettings();
  }

  async saveExplore(dateFolder: string, candidate: unknown): Promise<GalleryExplore> {
    return this.withPublishLock(async () => {
      await this.requireGallery(dateFolder);
      const explore = normalizeExplore(candidate, new Date().toISOString());
      const directory = path.join(this.directories.galleries, dateFolder);
      const readyBases = new Set((await readdir(directory))
        .filter((entry) => entry.endsWith(".ready"))
        .map((entry) => entry.slice(0, -6)));
      explore.placements = Object.fromEntries(
        Object.entries(explore.placements).filter(([base]) => readyBases.has(base)),
      );
      await atomicWriteJson(path.join(directory, EXPLORE_FILE), explore);
      return explore;
    });
  }

  async deleteExplore(dateFolder: string): Promise<void> {
    await this.withPublishLock(async () => {
      await this.requireGallery(dateFolder);
      await rm(path.join(this.directories.galleries, dateFolder, EXPLORE_FILE), { force: true });
    });
  }

  async journeyProgress(limit = 100): Promise<JourneyProgress[]> {
    return [...this.recentJourneyReceipts.values()]
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, Math.max(0, Math.min(100, Math.floor(limit))));
  }

  private async loadJourneyReceipts(): Promise<void> {
    for (const entry of await readdir(this.journeyReceiptDirectory())) {
      if (!entry.endsWith(".json")) continue;
      try {
        const receipt = await readJsonOrNull<JourneyProgress>(path.join(this.journeyReceiptDirectory(), entry));
        if (receipt?.journey_id && receipt.updated_at) this.rememberJourneyReceipt(receipt);
      } catch (error) {
        console.warn(`[photo-pipeline] ignored invalid journey receipt ${entry}: ${errorMessage(error)}`);
      }
    }
  }

  private rememberJourneyReceipt(receipt: JourneyProgress): void {
    this.recentJourneyReceipts.set(receipt.journey_id, receipt);
    if (this.recentJourneyReceipts.size <= 100) return;
    const oldest = [...this.recentJourneyReceipts.values()]
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at))[0];
    if (oldest) this.recentJourneyReceipts.delete(oldest.journey_id);
  }

  private async loadSettings(): Promise<void> {
    this.settings = normalizeSettings(
      await readJsonOrNull(path.join(this.directories.state, SETTINGS_FILE)),
      this.config.defaultSettings,
    );
  }

  private async claimStagedFiles(): Promise<void> {
    const entries = await readdir(this.directories.staging, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name.endsWith(".uploading")) continue;
      const jobId = randomUUID();
      if (entry.isDirectory()) {
        if (!entry.name.endsWith(".frame-photo")) continue;
        const staged = path.join(this.directories.staging, entry.name);
        let journey: PhotoJourney | null = null;
        try {
          journey = await requireJourney(path.join(staged, "journey.json"));
          if (entry.name !== `${journey.journey_id}.frame-photo`) {
            throw new Error(`Staged journey directory ${entry.name} does not match journey ${journey.journey_id}.`);
          }
          await rename(staged, path.join(this.directories.processing, jobId));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          await this.quarantineUnreadableClaim(
            staged,
            path.join(staged, "source"),
            journey?.original_name ?? `${entry.name.slice(0, -12)}.bin`,
            jobId,
            errorMessage(error),
            journey?.journey_id,
          );
        }
        continue;
      }
      if (!entry.isFile()) continue;
      const staged = path.join(this.directories.staging, entry.name);
      const directory = path.join(this.directories.processing, jobId);
      await mkdir(directory);
      try {
        const info = await stat(staged);
        await atomicWriteJson(path.join(directory, "journey.json"), {
          schema_version: 1,
          journey_id: randomUUID(),
          original_name: entry.name,
          received_at: info.mtime.toISOString(),
          ingest: { adapter: "legacy_staging", transfer_id: jobId, bytes_received: info.size },
        });
        await rename(staged, path.join(directory, "source"));
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
      const jobId = separator > 0 ? entry.name.slice(0, separator) : entry.name;
      const legacyOriginalName = separator > 0
        ? Buffer.from(entry.name.slice(separator + 2), "base64url").toString("utf8")
        : "";
      const directory = path.join(this.directories.processing, entry.name);
      const source = path.join(directory, "source");
      try {
        if (!(await exists(source))) {
          await rm(directory, { recursive: true, force: true });
          console.warn(`[photo-pipeline] removed orphan claim ${entry.name} without a source file`);
          continue;
        }
        const { journey, integrityError } = await this.readOrCreateJourney(directory, source, legacyOriginalName, jobId);
        claims.push({ jobId, originalName: journey.original_name, directory, source, journey, integrityError });
      } catch (error) {
        console.warn(`[photo-pipeline] quarantined invalid claim ${entry.name}: ${errorMessage(error)}`);
        await this.quarantineUnreadableClaim(
          directory,
          source,
          legacyOriginalName || `${entry.name}.bin`,
          jobId,
          errorMessage(error),
        );
      }
    }
    return claims;
  }

  private async readOrCreateJourney(directory: string, source: string, originalName: string, jobId: string): Promise<{
    journey: VerifiedPhotoJourney;
    integrityError?: string;
  }> {
    const file = path.join(directory, "journey.json");
    const sourceInfo = await stat(source);
    const contentSha256 = await sha256File(source);
    const existing = await readJsonOrNull<unknown>(file);
    if (existing !== null) {
      const parsed = parseJourney(existing);
      const journey = { ...parsed, content_sha256: contentSha256 };
      if (!parsed.content_sha256) await atomicWriteJson(file, journey);
      return {
        journey,
        ...(parsed.ingest.bytes_received !== sourceInfo.size
          ? { integrityError: `Declared byte count does not match the staged source for journey ${parsed.journey_id}.` }
          : parsed.content_sha256 && parsed.content_sha256 !== contentSha256
            ? { integrityError: `Declared content_sha256 does not match the staged source for journey ${parsed.journey_id}.` }
            : {}),
      };
    }
    if (!originalName) throw new Error("Processing claim is missing journey metadata.");
    const journey: VerifiedPhotoJourney = {
      schema_version: 1,
      journey_id: randomUUID(),
      content_sha256: contentSha256,
      original_name: originalName,
      received_at: sourceInfo.mtime.toISOString(),
      ingest: { adapter: "legacy_staging", transfer_id: jobId, bytes_received: sourceInfo.size },
    };
    await atomicWriteJson(file, journey);
    return { journey };
  }

  private journeyReceiptDirectory(): string {
    return path.join(this.directories.state, "photo-journeys");
  }

  private journeyReceiptPath(journeyId: string): string {
    return path.join(this.journeyReceiptDirectory(), `${journeyId}.json`);
  }

  private async readJourneyReceipt(journeyId: string): Promise<JourneyProgress | null> {
    const cached = this.recentJourneyReceipts.get(journeyId);
    if (cached) return cached;
    const receipt = await readJsonOrNull<JourneyProgress>(this.journeyReceiptPath(journeyId));
    if (receipt) this.rememberJourneyReceipt(receipt);
    return receipt;
  }

  private async writeJourneyReceipt(receipt: JourneyProgress): Promise<void> {
    await atomicWriteJson(this.journeyReceiptPath(receipt.journey_id), receipt);
    this.rememberJourneyReceipt(receipt);
  }

  private receiptForClaim(claim: Claim, state: JourneyProgress["state"], updatedAt = new Date().toISOString()): JourneyProgress {
    return {
      ...claim.journey,
      state,
      updated_at: updatedAt,
      job_id: claim.jobId,
    };
  }

  private async recordJourneyReceived(claim: Claim): Promise<void> {
    await this.withPublishLock(async () => {
      const existing = await this.readJourneyReceipt(claim.journey.journey_id);
      if (existing) {
        if (!validContentSha256(existing.content_sha256) && existing.job_id === claim.jobId) {
          await this.writeJourneyReceipt({
            ...existing,
            content_sha256: claim.journey.content_sha256,
          });
        }
        return;
      }
      await this.writeJourneyReceipt(this.receiptForClaim(claim, "received"));
    });
  }

  private async beginJourney(claim: Claim): Promise<"wait" | "duplicate" | "conflict" | null> {
    return this.withPublishLock(async () => {
      const existing = await this.readJourneyReceipt(claim.journey.journey_id);
      if (existing && existing.content_sha256 !== claim.journey.content_sha256) return "conflict";
      if (existing?.state === "published") return "duplicate";
      if (existing && existing.job_id !== claim.jobId && await this.processingClaimExists(existing.job_id)) return "wait";
      await this.writeJourneyReceipt(this.receiptForClaim(claim, "processing"));
      return null;
    });
  }

  private async processingClaimExists(jobId: string): Promise<boolean> {
    for (const entry of await readdir(this.directories.processing, { withFileTypes: true })) {
      if (!entry.isDirectory() || (entry.name !== jobId && !entry.name.startsWith(`${jobId}--`))) continue;
      const directory = path.join(this.directories.processing, entry.name);
      if (await exists(path.join(directory, "source"))) return true;
      await rm(directory, { recursive: true, force: true });
      console.warn(`[photo-pipeline] removed orphan claim ${entry.name} without a source file`);
    }
    return false;
  }

  private async markJourneyPublished(claim: Claim, publication: Publication, updatedAt: string): Promise<void> {
    await this.writeJourneyReceipt({
      ...this.receiptForClaim(claim, "published", updatedAt),
      date_folder: publication.dateFolder,
      base: publication.base,
    });
  }

  private async markJourneyFailed(claim: Claim, error: string): Promise<void> {
    await this.withPublishLock(async () => {
      await this.writeJourneyReceipt({
        ...this.receiptForClaim(claim, "failed"),
        error,
      });
    });
  }

  private async processClaim(claim: Claim): Promise<void> {
    let detectedMime = "application/octet-stream";
    let attempts = 0;
    let releaseHeic: (() => void) | null = null;
    try {
      if (claim.integrityError) {
        const preserveReceipt = Boolean(await this.readJourneyReceipt(claim.journey.journey_id));
        await this.quarantine(
          claim,
          failureReason("PPL-06", "FILE_ACCESS_ERROR", claim.integrityError),
          !preserveReceipt,
        );
        this.status.quarantined += 1;
        this.status.last_quarantine_at = new Date().toISOString();
        this.status.last_quarantine_file = claim.originalName;
        this.status.last_error = claim.integrityError;
        return;
      }
      if (await this.recoverPublishedClaim(claim)) return;
      const journeyDisposition = await this.beginJourney(claim);
      if (journeyDisposition === "wait") return;
      if (journeyDisposition === "duplicate") {
        await rm(claim.directory, { recursive: true, force: true });
        return;
      }
      if (journeyDisposition === "conflict") {
        const detail = `Journey ${claim.journey.journey_id} was reused with different photo content.`;
        await this.quarantine(claim, failureReason("PPL-06", "FILE_ACCESS_ERROR", detail), false);
        this.status.quarantined += 1;
        this.status.last_quarantine_at = new Date().toISOString();
        this.status.last_quarantine_file = claim.originalName;
        this.status.last_error = detail;
        return;
      }
      const sourceStat = await stat(claim.source);
      if (sourceStat.size > this.config.maxInputBytes) {
        throw failure("PPL-02", "CONVERT_FAILED", `Input exceeds ${this.config.maxInputBytes} bytes.`);
      }
      if (RAW_EXTENSIONS.has(path.extname(claim.originalName).toLowerCase())) {
        throw failure("PPL-03", "RAW_UNSUPPORTED", "Camera RAW files are not supported in V1.");
      }

      const sourceExtension = path.extname(claim.originalName).toLowerCase();
      const allowedRasterExtension = RASTER_EXTENSIONS.has(sourceExtension);
      const detected = await fileTypeFromFile(claim.source);
      detectedMime = detected?.mime ?? detectedMime;
      if ((!detected || !detected.mime.startsWith("image/")) && !allowedRasterExtension) {
        throw failure("PPL-01", "NOT_IMAGE", "Detected file type is not an image.", detectedMime);
      }
      const isHeic = detected?.ext === "heic" || detected?.ext === "heif" || sourceExtension === ".heic" || sourceExtension === ".heif";

      let sourceMetadata: Metadata;
      let imageSource: string | RawImage = claim.source;
      try {
        if (isHeic) {
          releaseHeic = await this.acquireHeicLock();
          const images = await decodeHeic.all({ buffer: await readFile(claim.source) });
          try {
            const primary = images[0];
            if (!primary) throw new Error("HEIC contains no images.");
            if (primary.width * primary.height > this.config.maxPixels) {
              throw new Error(`Decoded image exceeds ${this.config.maxPixels} pixels.`);
            }
            const decoded = await primary.decode();
            imageSource = {
              data: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
              width: decoded.width,
              height: decoded.height,
            };
          } finally {
            images.dispose();
          }
          sourceMetadata = await sharp(imageSource.data, {
            raw: { width: imageSource.width, height: imageSource.height, channels: 4 },
          }).metadata();
        } else {
          sourceMetadata = await sharp(claim.source, { failOn: "error" }).metadata();
        }
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
      let outputQuality = this.settings.jpeg_quality;
      let outputSizeBytes = 0;
      for (attempts = 1; attempts <= this.config.conversionAttempts; attempts += 1) {
        try {
          const temporaryJpg = path.join(claim.directory, "normalized.jpg.tmp");
          await rm(temporaryJpg, { force: true });
          const result = await writeNormalizedJpg(imageSource, temporaryJpg, this.settings, sourceMetadata, sourceStat.size);
          outputQuality = result.quality;
          outputSizeBytes = result.sizeBytes;
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
        journey_id: claim.journey.journey_id,
        base,
        original_name: claim.originalName,
        detected_mime: detectedMime,
        detected_format: detected?.ext ?? sourceExtension.replace(/^\./, ""),
        width: finalMetadata.width,
        height: finalMetadata.height,
        orientation,
        output_size_bytes: outputSizeBytes,
        jpeg_quality: outputQuality,
        long_edge_px: this.settings.long_edge_px,
        max_output_mb: this.settings.max_output_mb,
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
        await this.markJourneyPublished(claim, publication, processedAt);
      });
      await this.finishClaim(claim, dateFolder);
      this.status.published += 1;
      this.status.last_publish_at = processedAt;
      this.status.last_publish_file = claim.originalName;
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
      this.status.last_quarantine_at = new Date().toISOString();
      this.status.last_quarantine_file = claim.originalName;
      this.status.last_error = reason.detail;
      console.error(`[photo-pipeline] quarantined ${claim.originalName}: ${reason.code} ${reason.detail}`);
    } finally {
      releaseHeic?.();
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
        journeyId: claim.journey.journey_id,
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
      await this.markJourneyPublished(claim, publication, new Date().toISOString());
      await this.finishClaim(claim, publication.dateFolder);
    });
    this.status.published += 1;
    this.status.last_publish_at = new Date().toISOString();
    this.status.last_publish_file = claim.originalName;
    this.status.last_error = null;
    console.log(`[photo-pipeline] recovered completed publish ${publication.dateFolder}/${publication.base}`);
    return true;
  }

  private async readPublication(claim: Claim): Promise<Publication | null> {
    try {
      const value = JSON.parse(await readFile(path.join(claim.directory, "publication.json"), "utf8")) as Partial<Publication>;
      return typeof value.dateFolder === "string" && typeof value.base === "string"
        ? { dateFolder: value.dateFolder, base: value.base, journeyId: typeof value.journeyId === "string" ? value.journeyId : claim.journey.journey_id }
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

  private async quarantine(claim: Claim, reason: QuarantineReason, writeReceipt = true): Promise<void> {
    await mkdir(this.directories.quarantine, { recursive: true });
    const suffix = `${sanitizeBase(path.parse(claim.originalName).name)}_${claim.jobId.slice(0, 8)}`;
    const originalTarget = await availablePath(this.directories.quarantine, `${suffix}${path.extname(claim.originalName)}`);
    try {
      await rename(claim.source, originalTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWriteJson(path.join(this.directories.quarantine, `${suffix}.error.json`), {
      journey_id: claim.journey.journey_id,
      reason_code: reason.code,
      reason: reason.reason,
      detail: reason.detail,
      original_name: claim.originalName,
      detected_mime: reason.detectedMime ?? "application/octet-stream",
      attempts: reason.attempts ?? 0,
      timestamp: new Date().toISOString(),
      log_ref: `frame-pipeline-photos:${new Date().toISOString()}:${claim.jobId.slice(0, 8)}`,
    });
    if (writeReceipt) await this.markJourneyFailed(claim, reason.detail);
    await rm(claim.directory, { recursive: true, force: true });
  }

  private async quarantineUnreadableClaim(
    directory: string,
    source: string,
    originalName: string,
    jobId: string,
    detail: string,
    journeyId?: string,
  ): Promise<void> {
    await mkdir(this.directories.quarantine, { recursive: true });
    const suffix = `${sanitizeBase(path.parse(originalName).name)}_${jobId.slice(0, 8)}`;
    const originalTarget = await availablePath(this.directories.quarantine, `${suffix}${path.extname(sanitizeFilename(originalName)) || ".bin"}`);
    try {
      await rename(source, originalTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWriteJson(path.join(this.directories.quarantine, `${suffix}.error.json`), {
      ...(journeyId ? { journey_id: journeyId } : {}),
      reason_code: "PPL-06",
      reason: "FILE_ACCESS_ERROR",
      detail,
      original_name: originalName,
      detected_mime: "application/octet-stream",
      attempts: 0,
      timestamp: new Date().toISOString(),
      log_ref: `frame-pipeline-photos:${new Date().toISOString()}:${jobId.slice(0, 8)}`,
    });
    await rm(directory, { recursive: true, force: true });
    this.status.quarantined += 1;
    this.status.last_quarantine_at = new Date().toISOString();
    this.status.last_quarantine_file = originalName;
    this.status.last_error = detail;
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
    const dateFolder = await this.ensureCurrentGallery();
    const directory = path.join(this.directories.galleries, dateFolder);
    const candidates: Array<{ dateFolder: string; base: string; mtimeMs: number; updatedAt: string }> = [];
    const entries = await readdir(directory);
    for (const entry of entries) {
      if (!entry.endsWith(".ready")) continue;
      const base = entry.slice(0, -6);
      if (entries.includes(`${base}.trashed.json`)) continue;
      const info = await stat(path.join(directory, entry));
      candidates.push({ dateFolder, base, mtimeMs: info.mtimeMs, updatedAt: info.mtime.toISOString() });
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const latest = candidates[0];
    if (latest) {
      return this.writeLatest(dateFolder, latest.base, revision, latest.updatedAt);
    }
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
      ["jpg", "json", "txt", "orientation", "ready"]
        .map((extension) => rm(path.join(directory, `${base}.${extension}`), { force: true })),
    );
    await this.removeExplorePlacement(dateFolder, base);
    await this.clearThumbnail(dateFolder, base);
    await rm(marker, { force: true });
    return 1;
  }

  private async removeExplorePlacement(dateFolder: string, base: string): Promise<void> {
    const file = path.join(this.directories.galleries, dateFolder, EXPLORE_FILE);
    const stored = await readJsonOrNull<unknown>(file);
    if (!stored) return;
    const explore = normalizeExplore(stored, new Date().toISOString());
    if (!Object.hasOwn(explore.placements, base)) return;
    delete explore.placements[base];
    await atomicWriteJson(file, explore);
  }

  private async requireGallery(dateFolder: string): Promise<void> {
    if (!isDateFolder(dateFolder)) throw new PhotoManagementError("A valid date_folder is required.", 400);
    try {
      await access(path.join(this.directories.galleries, dateFolder));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new PhotoManagementError("Gallery was not found.", 404);
      }
      throw error;
    }
  }

  private async clearThumbnail(dateFolder: string, base: string): Promise<void> {
    await Promise.all([
      rm(path.join(this.config.dataRoot, "gallery-cache", dateFolder, `${base}.webp`), { force: true }),
      rm(path.join(this.config.dataRoot, "gallery-cache", "tiles", dateFolder, base), { recursive: true, force: true }),
    ]);
  }

  private async ensureCurrentGallery(): Promise<string> {
    const local = localParts(new Date(), this.config.timezone);
    const dateFolder = `${local.year}-${local.month}-${local.day}`;
    await mkdir(path.join(this.directories.galleries, dateFolder), { recursive: true });
    return dateFolder;
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

  private async acquireHeicLock(): Promise<() => void> {
    const previous = this.heicLock;
    let release: () => void = () => undefined;
    this.heicLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
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

function normalizeSettings(candidate: unknown, fallback: PipelineProcessingSettings): PipelineProcessingSettings {
  const source = isRecord(candidate) ? candidate : {};
  return {
    long_edge_px: boundedInteger(source.long_edge_px, fallback.long_edge_px, 0, 12000),
    jpeg_quality: boundedInteger(source.jpeg_quality, fallback.jpeg_quality, 40, 100),
    max_output_mb: boundedNumber(source.max_output_mb, fallback.max_output_mb, 0, 500),
  };
}

function normalizeExplore(candidate: unknown, updatedAt: string): GalleryExplore {
  if (!isRecord(candidate) || candidate.schema_version !== 1) {
    throw new PhotoManagementError("Explore data must use schema_version 1.", 400);
  }
  if (!Array.isArray(candidate.routes) || candidate.routes.length < 1 || candidate.routes.length > MAX_EXPLORE_ROUTES) {
    throw new PhotoManagementError(`Explore data must contain 1 to ${MAX_EXPLORE_ROUTES} routes.`, 400);
  }

  let segmentCount = 0;
  let pointCount = 0;
  const routeIds = new Set<string>();
  const routes = candidate.routes.map((rawRoute, routeIndex) => {
    if (!isRecord(rawRoute)) throw new PhotoManagementError(`Explore route ${routeIndex + 1} is invalid.`, 400);
    const id = requiredText(rawRoute.id, 96, "Explore route id");
    if (!EXPLORE_ID_PATTERN.test(id) || routeIds.has(id)) {
      throw new PhotoManagementError("Explore route ids must be unique and contain only letters, numbers, underscores, or hyphens.", 400);
    }
    routeIds.add(id);
    const name = requiredText(rawRoute.name, 240, "Explore route name");
    const importedAt = requiredIsoDate(rawRoute.imported_at, "Explore route imported_at");
    if (!Array.isArray(rawRoute.segments) || rawRoute.segments.length < 1) {
      throw new PhotoManagementError(`Explore route ${name} must contain at least one segment.`, 400);
    }
    segmentCount += rawRoute.segments.length;
    if (segmentCount > MAX_EXPLORE_SEGMENTS) {
      throw new PhotoManagementError(`Explore data cannot exceed ${MAX_EXPLORE_SEGMENTS} segments.`, 413);
    }
    const segments = rawRoute.segments.map((rawSegment, segmentIndex) => {
      if (!Array.isArray(rawSegment) || rawSegment.length < 2) {
        throw new PhotoManagementError(`Explore route ${name}, segment ${segmentIndex + 1} must contain at least two points.`, 400);
      }
      pointCount += rawSegment.length;
      if (pointCount > MAX_EXPLORE_POINTS) {
        throw new PhotoManagementError(`Explore data cannot exceed ${MAX_EXPLORE_POINTS} points.`, 413);
      }
      let previousTime = -1;
      return rawSegment.map((rawPoint, pointIndex): ExplorePoint => {
        if (!Array.isArray(rawPoint) || rawPoint.length !== 3) {
          throw new PhotoManagementError(`Explore point ${pointIndex + 1} in ${name} is invalid.`, 400);
        }
        const [time, lat, lon] = rawPoint;
        if (!Number.isInteger(time) || time < 0 || time > 8_640_000_000_000_000 || time <= previousTime) {
          throw new PhotoManagementError(`Explore point times in ${name} must be valid and strictly increasing.`, 400);
        }
        if (!finiteCoordinate(lat, -90, 90) || !finiteCoordinate(lon, -180, 180)) {
          throw new PhotoManagementError(`Explore coordinates in ${name} are invalid.`, 400);
        }
        previousTime = time;
        return [time, lat, lon];
      });
    });
    return { id, name, imported_at: importedAt, segments };
  });

  if (!isRecord(candidate.placements)) throw new PhotoManagementError("Explore placements must be an object.", 400);
  const placementEntries = Object.entries(candidate.placements);
  if (placementEntries.length > MAX_EXPLORE_PLACEMENTS) {
    throw new PhotoManagementError(`Explore data cannot exceed ${MAX_EXPLORE_PLACEMENTS} manual placements.`, 413);
  }
  const placements = Object.fromEntries(placementEntries.map(([base, rawPlacement]) => {
    if (!isPhotoBase(base) || !isRecord(rawPlacement)) throw new PhotoManagementError("Explore placement is invalid.", 400);
    const lat = rawPlacement.lat;
    const lon = rawPlacement.lon;
    if (!finiteCoordinate(lat, -90, 90) || !finiteCoordinate(lon, -180, 180)) {
      throw new PhotoManagementError(`Explore placement for ${base} has invalid coordinates.`, 400);
    }
    const timestamp = rawPlacement.timestamp;
    if (timestamp !== undefined && (!Number.isInteger(timestamp) || Math.abs(Number(timestamp)) > 8_640_000_000_000_000)) {
      throw new PhotoManagementError(`Explore placement for ${base} has an invalid timestamp.`, 400);
    }
    return [base, {
      lat,
      lon,
      ...(timestamp === undefined ? {} : { timestamp: Number(timestamp) }),
      updated_at: requiredIsoDate(rawPlacement.updated_at, `Explore placement ${base} updated_at`),
    }];
  }));

  return {
    schema_version: 1,
    updated_at: updatedAt,
    time_shift_seconds: finiteNumberInRange(candidate.time_shift_seconds, -86_400, 86_400, "time_shift_seconds"),
    time_adjustment_seconds: finiteNumberInRange(candidate.time_adjustment_seconds, -86_400, 86_400, "time_adjustment_seconds"),
    routes,
    placements,
  };
}

function requiredText(value: unknown, maxLength: number, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength) throw new PhotoManagementError(`${label} is required and must be ${maxLength} characters or fewer.`, 400);
  return text;
}

function requiredIsoDate(value: unknown, label: string): string {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestamp)) throw new PhotoManagementError(`${label} must be a valid timestamp.`, 400);
  return new Date(timestamp).toISOString();
}

function finiteCoordinate(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function finiteNumberInRange(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new PhotoManagementError(`Explore ${label} must be a number from ${minimum} to ${maximum}.`, 400);
  }
  return value;
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new PhotoManagementError(`Value must be an integer from ${minimum} to ${maximum}.`, 400);
  }
  return parsed;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseFloat(String(value ?? fallback));
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new PhotoManagementError(`Value must be a number from ${minimum} to ${maximum}.`, 400);
  }
  return Math.round(parsed * 1000) / 1000;
}

async function writeNormalizedJpg(
  source: string | RawImage,
  target: string,
  settings: PipelineProcessingSettings,
  sourceMetadata?: Metadata,
  sourceSizeBytes?: number,
): Promise<{ quality: number; sizeBytes: number }> {
  if (typeof source === "string" && sourceMetadata && sourceSizeBytes !== undefined && canReuseJpg(sourceMetadata, sourceSizeBytes, settings)) {
    await rm(target, { force: true });
    await copyFile(source, target);
    return { quality: settings.jpeg_quality, sizeBytes: sourceSizeBytes };
  }
  const maxBytes = settings.max_output_mb > 0 ? Math.floor(settings.max_output_mb * 1024 * 1024) : 0;
  for (let quality = settings.jpeg_quality; quality >= 40; quality = Math.max(quality - 5, quality === 40 ? -1 : 40)) {
    await rm(target, { force: true });
    let image = (typeof source === "string"
      ? sharp(source, { failOn: "error" })
      : sharp(source.data, { raw: { width: source.width, height: source.height, channels: 4 } }))
      .rotate()
      .flatten({ background: "#ffffff" });
    if (settings.long_edge_px > 0) {
      image = image.resize({
        width: settings.long_edge_px,
        height: settings.long_edge_px,
        fit: "inside",
        withoutEnlargement: true,
      });
    }
    await image
      .jpeg({ quality, mozjpeg: true })
      .withMetadata()
      .toFile(target);
    const sizeBytes = (await stat(target)).size;
    if (!maxBytes || sizeBytes <= maxBytes || quality === 40) {
      if (maxBytes && sizeBytes > maxBytes) {
        throw new Error(`Output exceeds ${settings.max_output_mb} MB at minimum quality.`);
      }
      return { quality, sizeBytes };
    }
  }
  throw new Error("Unable to write compressed JPG.");
}

function canReuseJpg(metadata: Metadata, sizeBytes: number, settings: PipelineProcessingSettings): boolean {
  if (metadata.format !== "jpeg" || metadata.space !== "srgb") return false;
  if (metadata.pages && metadata.pages > 1) return false;
  if (metadata.orientation && metadata.orientation !== 1) return false;
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) return false;
  if (settings.long_edge_px > 0 && Math.max(width, height) > settings.long_edge_px) return false;
  const maxBytes = settings.max_output_mb > 0 ? Math.floor(settings.max_output_mb * 1024 * 1024) : 0;
  return !maxBytes || sizeBytes <= maxBytes;
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

async function requireJourney(file: string): Promise<PhotoJourney> {
  const value = await readJsonOrNull<unknown>(file);
  if (value === null) throw new Error(`Staged photo envelope is missing ${path.basename(file)}.`);
  return parseJourney(value);
}

function parseJourney(value: unknown): PhotoJourney {
  if (!isRecord(value) || value.schema_version !== 1 || !validJourneyId(value.journey_id)) {
    throw new Error("Staged photo journey metadata is invalid.");
  }
  if (value.content_sha256 !== undefined && !validContentSha256(value.content_sha256)) {
    throw new Error("Staged photo content_sha256 is invalid.");
  }
  if (typeof value.original_name !== "string" || !value.original_name.trim() || value.original_name.length > 255) {
    throw new Error("Staged photo original_name is invalid.");
  }
  if (typeof value.received_at !== "string" || !Number.isFinite(Date.parse(value.received_at))) {
    throw new Error("Staged photo received_at is invalid.");
  }
  if (!isRecord(value.ingest)
    || typeof value.ingest.adapter !== "string"
    || !/^[a-z][a-z0-9_]{0,31}$/.test(value.ingest.adapter)
    || typeof value.ingest.transfer_id !== "string"
    || !/^[A-Za-z0-9:_-]{1,120}$/.test(value.ingest.transfer_id)
    || !Number.isSafeInteger(value.ingest.bytes_received)
    || Number(value.ingest.bytes_received) < 0) {
    throw new Error("Staged photo ingest metadata is invalid.");
  }
  return {
    schema_version: 1,
    journey_id: value.journey_id,
    ...(value.content_sha256 ? { content_sha256: value.content_sha256 } : {}),
    original_name: value.original_name,
    received_at: value.received_at,
    ingest: {
      adapter: value.ingest.adapter,
      transfer_id: value.ingest.transfer_id,
      bytes_received: Number(value.ingest.bytes_received),
    },
  };
}

function validJourneyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,96}$/.test(value) && !value.includes("__");
}

function validContentSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(file);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
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
  return `${sanitizeBase(parsed.name)}${parsed.ext.toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 16)}`;
}

function readExif(buffer: Buffer | undefined): Record<string, unknown> {
  if (!buffer) return {};
  try {
    const parsed = exifReader(buffer) as unknown;
    if (!isRecord(parsed)) return {};
    const image = pickExifFields(childRecord(parsed, "Image"), [
      "Make",
      "Model",
      "CameraModelName",
      "Software",
      "DateTime",
      "Orientation",
    ]);
    const photo = pickExifFields(childRecord(parsed, "Photo"), [
      "ExposureTime",
      "ShutterSpeed",
      "ShutterSpeedValue",
      "FNumber",
      "Aperture",
      "ApertureValue",
      "ISO",
      "ISOSpeedRatings",
      "DateTimeOriginal",
      "FocalLength",
      "FocalLength35efl",
      "FocalLengthIn35mmFormat",
      "LensMake",
      "LensModel",
      "Lens",
      "LensID",
      "LensType",
      "LensSpec",
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
  let model = firstText(image.Model, image.CameraModelName) || "Unknown Camera";
  const make = firstText(image.Make);
  const lens = firstText(photo.LensModel, photo.Lens, photo.LensID, photo.LensType, photo.LensSpec) || "Unknown Lens";
  const focal = formatMm(firstText(photo.FocalLength, photo.FocalLength35efl, photo.FocalLengthIn35mmFormat));
  const exposure = formatStreamerExposure(firstText(photo.ExposureTime, photo.ShutterSpeed, photo.ShutterSpeedValue));
  const aperture = formatStreamerAperture(firstText(photo.FNumber, photo.Aperture, photo.ApertureValue));
  const iso = firstText(photo.ISO, photo.ISOSpeedRatings);

  if (model === "Unknown Camera" && make) model = make;
  const line1 = focal
    ? `Shot on ${model} with the ${lens} @ ${focal}`
    : `Shot on ${model} with the ${lens}`;
  const line2 = [exposure, aperture, iso ? `ISO ${iso}` : ""].filter(Boolean).join(" • ");
  return [line1, line2].filter(Boolean).join("\n");
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = valueText(value);
    if (text) return text;
  }
  return "";
}

function valueText(value: unknown): string {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  if (typeof candidate === "string") return candidate.trim();
  return "";
}

function formatMm(value: string): string {
  const match = value.match(/([\d.]+)/);
  if (!match) return value;
  const parsed = Number.parseFloat(match[1]);
  if (!Number.isFinite(parsed)) return value;
  return `${trimNumber(parsed)}mm`;
}

function formatStreamerExposure(value: string): string {
  if (!value) return "";
  if (value.endsWith("s")) return value;
  if (value.includes("/")) return `${value}s`;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const parsed = Number.parseFloat(value);
    if (parsed > 0 && parsed < 1) return `1/${Math.round(1 / parsed)}s`;
    if (Number.isFinite(parsed)) return `${trimNumber(parsed)}s`;
  }
  return value;
}

function formatStreamerAperture(value: string): string {
  return value && !value.startsWith("f/") ? `f/${value}` : value;
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
    if (typeof value === "string") {
      selected[field] = value.replaceAll("\0", "").trim();
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      selected[field] = value;
      continue;
    }
    if (value instanceof Date) {
      selected[field] = value.toISOString();
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "number" || typeof item === "string")) {
      selected[field] = value.slice(0, 8).map((item) => typeof item === "string" ? item.replaceAll("\0", "").trim() : item);
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
