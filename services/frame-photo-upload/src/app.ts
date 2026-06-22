import Busboy from "busboy";
import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type Express } from "express";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { type BasicAuthConfig, requireBasicAuth } from "./auth.js";
import { streamCompletedUpload } from "./handoff.js";
import { UploadProgressTracker } from "./progress.js";

export interface UploadConfig {
  dataRoot: string;
  maxInputBytes: number;
  publicDir: string;
  auth: BasicAuthConfig;
  serviceToken: string;
  progressTracker?: UploadProgressTracker;
}

export async function createApp(config: UploadConfig): Promise<Express> {
  const inbox = path.join(config.dataRoot, "inbox");
  const staging = path.join(config.dataRoot, "staging");
  await Promise.all([mkdir(inbox, { recursive: true }), mkdir(staging, { recursive: true })]);
  const progress = config.progressTracker ?? new UploadProgressTracker();

  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_request, response) => {
    response.json({ ok: true, service: "frame-photo-upload", max_input_bytes: config.maxInputBytes });
  });
  app.get("/api/internal/photo-upload/progress", requireServiceToken(config.serviceToken), (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(progress.snapshot());
  });
  app.use("/photos", requireBasicAuth(config.auth));
  app.use("/photos/assets", express.static(config.publicDir, { index: false, maxAge: "1h" }));
  app.get(["/photos/upload", "/photos/upload/"], (_request, response) => {
    response.sendFile(path.join(config.publicDir, "index.html"));
  });
  app.post("/photos/api/upload", (request, response, next) => {
    const transferId = validTransferId(request.header("x-frame-transfer-id")) || randomUUID();
    const bytesTotal = validFileSize(request.header("x-frame-file-size"), config.maxInputBytes);
    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: request.headers,
        limits: { files: 1, fileSize: config.maxInputBytes, fields: 4 },
      });
    } catch (error) {
      response.status(400).json({ error: errorMessage(error) });
      return;
    }

    let upload: Promise<string> | null = null;
    let activeFile: NodeJS.ReadableStream | null = null;
    let limited = false;
    busboy.on("file", (_field, file, info) => {
      if (upload) {
        file.resume();
        return;
      }
      activeFile = file;
      progress.begin(transferId, info.filename || "photo", bytesTotal);
      file.on("limit", () => { limited = true; });
      upload = streamCompletedUpload(
        file,
        info.filename || "photo",
        inbox,
        staging,
        (bytes) => progress.addBytes(transferId, bytes),
      );
      // An aborted request may never emit Busboy's finish event. Attach a
      // rejection observer immediately so pipeline cleanup cannot become an
      // unhandled rejection; the finish path still awaits the same promise.
      void upload.catch(() => undefined);
    });
    busboy.on("finish", async () => {
      try {
        if (!upload) {
          response.status(400).json({ error: "Select one photo to upload." });
          return;
        }
        const stagedName = await upload;
        if (limited) {
          await rm(path.join(staging, stagedName), { force: true });
          response.status(413).json({ error: `Photo exceeds the ${config.maxInputBytes} byte limit.` });
          progress.failed(transferId, "File exceeded the configured upload limit.");
          return;
        }
        progress.queued(transferId);
        response.status(202).json({ accepted: true, staged_name: stagedName, transfer_id: transferId });
      } catch (error) {
        progress.failed(transferId, errorMessage(error));
        next(error);
      }
    });
    busboy.on("error", (error) => { progress.failed(transferId, errorMessage(error)); next(error); });
    request.on("aborted", () => {
      progress.failed(transferId, "Upload connection was interrupted.");
      if (activeFile && "destroy" in activeFile && typeof activeFile.destroy === "function") activeFile.destroy(new Error("Upload connection was interrupted."));
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

function validTransferId(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{8,96}$/.test(value) ? value : null;
}

function validFileSize(value: string | undefined, maximum: number): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 && size <= maximum ? size : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
