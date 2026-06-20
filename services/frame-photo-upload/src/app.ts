import Busboy from "busboy";
import express, { type Express } from "express";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { type BasicAuthConfig, requireBasicAuth } from "./auth.js";
import { streamCompletedUpload } from "./handoff.js";

export interface UploadConfig {
  dataRoot: string;
  maxInputBytes: number;
  maxFiles: number;
  maxSessions: number;
  publicDir: string;
  auth: BasicAuthConfig;
}

export async function createApp(config: UploadConfig): Promise<Express> {
  const inbox = path.join(config.dataRoot, "inbox");
  const staging = path.join(config.dataRoot, "staging");
  await Promise.all([mkdir(inbox, { recursive: true }), mkdir(staging, { recursive: true })]);

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

    const uploads: Promise<string>[] = [];
    let limited = false;
    let tooManyFiles = false;
    busboy.on("file", (_field, file, info) => {
      if (uploads.length >= config.maxFiles) {
        tooManyFiles = true;
        file.resume();
        return;
      }
      file.on("limit", () => { limited = true; });
      uploads.push(streamCompletedUpload(file, info.filename || "photo", inbox, staging));
    });
    busboy.on("filesLimit", () => { tooManyFiles = true; });
    busboy.on("finish", async () => {
      let stagedNames: string[] = [];
      try {
        if (!uploads.length) {
          response.status(400).json({ error: "Select at least one photo to upload." });
          return;
        }
        stagedNames = await Promise.all(uploads);
        if (limited || tooManyFiles) {
          await Promise.all(stagedNames.map((name) => rm(path.join(staging, name), { force: true })));
        }
        if (tooManyFiles) {
          response.status(400).json({ error: `Select no more than ${config.maxFiles} photo(s) at once.` });
          return;
        }
        if (limited) {
          response.status(413).json({ error: `Photo exceeds the ${config.maxInputBytes} byte limit.` });
          return;
        }
        response.status(202).json({
          accepted: true,
          staged_names: stagedNames,
          count: stagedNames.length,
        });
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
