import Busboy from "busboy";
import express, { type Express } from "express";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { type BasicAuthConfig, requireBasicAuth } from "./auth.js";
import { streamCompletedUpload } from "./handoff.js";

export interface UploadConfig {
  dataRoot: string;
  maxInputBytes: number;
  publicDir: string;
  auth: BasicAuthConfig;
}

export async function createApp(config: UploadConfig): Promise<Express> {
  const inbox = path.join(config.dataRoot, "inbox");
  const staging = path.join(config.dataRoot, "staging");
  await Promise.all([mkdir(inbox, { recursive: true }), mkdir(staging, { recursive: true })]);

  const app = express();
  app.disable("x-powered-by");
  app.get("/healthz", (_request, response) => {
    response.json({ ok: true, service: "frame-photo-upload", max_input_bytes: config.maxInputBytes });
  });
  app.use("/photos", requireBasicAuth(config.auth));
  app.use("/photos/assets", express.static(config.publicDir, { index: false, maxAge: "1h" }));
  app.get(["/photos/upload", "/photos/upload/"], (_request, response) => {
    response.sendFile(path.join(config.publicDir, "index.html"));
  });
  app.post("/photos/api/upload", (request, response, next) => {
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
    let limited = false;
    busboy.on("file", (_field, file, info) => {
      if (upload) {
        file.resume();
        return;
      }
      file.on("limit", () => { limited = true; });
      upload = streamCompletedUpload(file, info.filename || "photo", inbox, staging);
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
          return;
        }
        response.status(202).json({ accepted: true, staged_name: stagedName });
      } catch (error) {
        next(error);
      }
    });
    busboy.on("error", next);
    request.pipe(busboy);
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    console.error(`[photo-upload] ${errorMessage(error)}`);
    response.status(500).json({ error: "Upload could not be staged." });
  });
  return app;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
