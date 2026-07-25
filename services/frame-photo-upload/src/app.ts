import Busboy from "busboy";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { type BasicAuthConfig, requireBasicAuth } from "./auth.js";
import { streamCompletedUpload } from "./handoff.js";
import { type PhotoSourceAdapter, UploadProgressTracker } from "./progress.js";

export interface UploadConfig {
  dataRoot: string;
  maxInputBytes: number;
  maxFiles: number;
  maxSessions: number;
  publicDir: string;
  auth: BasicAuthConfig;
  serviceToken: string;
  progressTracker?: UploadProgressTracker;
}

interface CompletedUpload {
  stagedName: string;
  transferId: string;
  journeyId: string;
  created: boolean;
}

export async function createApp(config: UploadConfig): Promise<Express> {
  const inbox = path.join(config.dataRoot, "inbox");
  const staging = path.join(config.dataRoot, "staging");
  await Promise.all([mkdir(inbox, { recursive: true }), mkdir(staging, { recursive: true })]);
  const progress = config.progressTracker ?? new UploadProgressTracker();

  const app = express();
  let activeSessions = 0;
  app.disable("x-powered-by");
  app.get("/healthz", (_request, response) => {
    response.json({
      ok: true,
      service: "frame-photo-upload",
      max_input_bytes: config.maxInputBytes,
      max_files: config.maxFiles,
      max_sessions: config.maxSessions,
      active_sessions: activeSessions,
    });
  });
  app.get("/api/internal/photo-upload/progress", requireServiceToken(config.serviceToken), (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(progress.snapshot());
  });
  app.post("/api/internal/photo-upload/stage", requireServiceToken(config.serviceToken), express.raw({ type: "*/*", limit: config.maxInputBytes }), async (request, response, next) => {
    const filename = safeHeader(request.header("x-frame-filename")) || "belabox-photo.jpg";
    const transferId = validTransferId(request.header("x-frame-transfer-id")) || randomUUID();
    const suppliedJourneyId = request.header("x-frame-journey-id");
    const journeyId = suppliedJourneyId ? validJourneyId(suppliedJourneyId) : journeyIdForTransfer(transferId);
    const suppliedAdapter = request.header("x-frame-ingest-adapter");
    const adapter = suppliedAdapter ? validAdapter(suppliedAdapter) : "belabox_chunked";
    const bytesTotal = validFileSize(request.header("x-frame-file-size"), config.maxInputBytes);
    try {
      if (!journeyId) {
        response.status(400).json({ error: "x-frame-journey-id must be 8-96 letters, numbers, dashes, or underscores and cannot contain '__'." });
        return;
      }
      if (!adapter) {
        response.status(400).json({ error: "x-frame-ingest-adapter must be a lowercase adapter name." });
        return;
      }
      if (!Buffer.isBuffer(request.body) || request.body.length === 0) {
        response.status(400).json({ error: "Completed file body is required." });
        return;
      }
      progress.begin(transferId, journeyId, filename, bytesTotal, adapter);
      const { stagedName } = await streamCompletedUpload(
        Readable.from(request.body),
        filename,
        staging,
        { journeyId, transferId, adapter },
        (bytes) => progress.addBytes(transferId, bytes),
      );
      progress.queued(transferId);
      response.status(202).json({ accepted: true, staged_name: stagedName, transfer_id: transferId, journey_id: journeyId });
    } catch (error) {
      progress.failed(transferId, errorMessage(error));
      next(error);
    }
  });
  app.use("/photos", requireBasicAuth(config.auth));
  app.use("/photos/assets", express.static(config.publicDir, { index: false, maxAge: "1h" }));
  app.get(["/photos/upload", "/photos/upload/"], (_request, response) => {
    response.sendFile(path.join(config.publicDir, "index.html"));
  });
  app.get("/photos/api/config", (_request, response) => {
    response.json({
      max_input_bytes: config.maxInputBytes,
      max_files: config.maxFiles,
      max_sessions: config.maxSessions,
      active_sessions: activeSessions,
    });
  });
  app.post("/photos/api/upload", (request, response, next) => {
    if (activeSessions >= config.maxSessions) {
      response.status(429).json({ error: "Too many active upload sessions. Try again in a moment." });
      return;
    }
    activeSessions += 1;
    let released = false;
    const releaseSession = () => {
      if (released) return;
      released = true;
      activeSessions = Math.max(0, activeSessions - 1);
    };
    response.once("finish", releaseSession);
    response.once("close", releaseSession);

    const requestTransferId = validTransferId(request.header("x-frame-transfer-id")) || randomUUID();
    const bytesTotal = validFileSize(request.header("x-frame-file-size"), config.maxInputBytes);
    const startedTransfers = new Set<string>();
    const activeFiles = new Set<NodeJS.ReadableStream>();

    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: request.headers,
        limits: { files: config.maxFiles, fileSize: config.maxInputBytes, fields: 4 },
      });
    } catch (error) {
      releaseSession();
      response.status(400).json({ error: errorMessage(error) });
      return;
    }

    const uploads: Promise<CompletedUpload>[] = [];
    let limited = false;
    let tooManyFiles = false;
    busboy.on("file", (_field, file, info) => {
      if (uploads.length >= config.maxFiles) {
        tooManyFiles = true;
        file.resume();
        return;
      }
      const transferId = transferIdForFile(requestTransferId, uploads.length);
      const journeyId = journeyIdForTransfer(transferId);
      startedTransfers.add(transferId);
      activeFiles.add(file);
      file.once("close", () => activeFiles.delete(file));
      progress.begin(transferId, journeyId, info.filename || "photo", uploads.length === 0 ? bytesTotal : null);
      file.on("limit", () => {
        limited = true;
        progress.failed(transferId, "File exceeded the configured upload limit.");
      });
      const upload = streamCompletedUpload(
        file,
        info.filename || "photo",
        staging,
        { journeyId, transferId, adapter: "web_upload" },
        (bytes) => progress.addBytes(transferId, bytes),
      ).then(({ stagedName, created }) => ({ stagedName, transferId, journeyId, created }));
      // An aborted request may never emit Busboy's finish event. Attach a
      // rejection observer immediately so pipeline cleanup cannot become an
      // unhandled rejection; the finish path still awaits the same promise.
      void upload.catch(() => undefined);
      uploads.push(upload);
    });
    busboy.on("filesLimit", () => { tooManyFiles = true; });
    busboy.on("finish", async () => {
      let completed: CompletedUpload[] = [];
      try {
        if (!uploads.length) {
          response.status(400).json({ error: "Select at least one photo to upload." });
          return;
        }
        completed = await Promise.all(uploads);
        if (limited || tooManyFiles) {
          await Promise.all(completed.filter(({ created }) => created).map(({ journeyId }) => rm(path.join(staging, `${journeyId}.frame-photo`), { recursive: true, force: true })));
        }
        if (tooManyFiles) {
          failTransfers(startedTransfers, progress, `Select no more than ${config.maxFiles} photo(s) at once.`);
          response.status(400).json({ error: `Select no more than ${config.maxFiles} photo(s) at once.` });
          return;
        }
        if (limited) {
          failTransfers(startedTransfers, progress, "File exceeded the configured upload limit.");
          response.status(413).json({ error: `Photo exceeds the ${config.maxInputBytes} byte limit.` });
          return;
        }
        for (const { transferId } of completed) progress.queued(transferId);
        const stagedNames = completed.map(({ stagedName }) => stagedName);
        const transferIds = completed.map(({ transferId }) => transferId);
        const journeyIds = completed.map(({ journeyId }) => journeyId);
        response.status(202).json({
          accepted: true,
          staged_name: stagedNames[0],
          staged_names: stagedNames,
          transfer_id: transferIds[0],
          transfer_ids: transferIds,
          journey_id: journeyIds[0],
          journey_ids: journeyIds,
          count: stagedNames.length,
        });
      } catch (error) {
        failTransfers(startedTransfers, progress, errorMessage(error));
        next(error);
      }
    });
    busboy.on("error", (error) => {
      failTransfers(startedTransfers, progress, errorMessage(error));
      next(error);
    });
    request.on("aborted", () => {
      failTransfers(startedTransfers, progress, "Upload connection was interrupted.");
      for (const file of activeFiles) {
        if ("destroy" in file && typeof file.destroy === "function") {
          file.destroy(new Error("Upload connection was interrupted."));
        }
      }
    });
    request.pipe(busboy);
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error(`[photo-upload] ${errorMessage(error)}`);
    response.status(500).json({ error: "Upload could not be staged." });
  });
  return app;
}

function requireServiceToken(expected: string): express.RequestHandler {
  return (request, response, next) => {
    const supplied = request.header("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const expectedBytes = Buffer.from(expected);
    const suppliedBytes = Buffer.from(supplied);
    if (!expected || expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
      response.status(401).json({ error: "Internal service token required." });
      return;
    }
    next();
  };
}

function transferIdForFile(requestTransferId: string, index: number): string {
  if (index === 0) return requestTransferId;
  const suffix = `-${index + 1}`;
  return `${requestTransferId.slice(0, 96 - suffix.length)}${suffix}`;
}

function failTransfers(transfers: Iterable<string>, progress: UploadProgressTracker, message: string): void {
  for (const transferId of transfers) progress.failed(transferId, message);
}

function validTransferId(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{8,96}$/.test(value) ? value : null;
}

function validJourneyId(value: string | undefined): string | null {
  const parsed = validTransferId(value);
  return parsed && !parsed.includes("__") ? parsed : null;
}

function journeyIdForTransfer(transferId: string): string {
  return validJourneyId(transferId)
    ?? `legacy-${createHash("sha256").update(transferId).digest("hex").slice(0, 32)}`;
}

function validAdapter(value: string | undefined): PhotoSourceAdapter | null {
  return value === "web_upload" || value === "ftp" || value === "belabox_chunked" || value === "belabox_agent" ? value : null;
}

function validFileSize(value: string | undefined, maximum: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 && size <= maximum ? size : null;
}

function safeHeader(value: string | undefined): string {
  return value?.replace(/[^\x20-\x7E]/g, "").slice(0, 180).trim() || "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
