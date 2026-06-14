import { timingSafeEqual } from "node:crypto";
import express from "express";
import { loadConfig } from "./config.js";
import { PhotoManagementError, PhotoPipeline, type PhotoManagementAction } from "./pipeline.js";

const config = loadConfig();
const pipeline = new PhotoPipeline(config);
await pipeline.init();
pipeline.start();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.get("/healthz", (_request, response) => {
  response.json({ ok: true, service: "frame-pipeline-photos", ...pipeline.status });
});

app.get("/api/internal/photo-pipeline/status", (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.json({ service: "frame-pipeline-photos", ...pipeline.status });
});

app.get("/api/internal/photo-pipeline/trash", requireServiceToken, async (_request, response, next) => {
  try {
    response.setHeader("Cache-Control", "no-store");
    response.json({ trash: await pipeline.listTrash() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/internal/photo-pipeline/manage", requireServiceToken, async (request, response, next) => {
  try {
    const candidate = typeof request.body?.action === "string" ? request.body.action : "";
    if (![
      "trash-photo", "restore-photo", "purge-photo", "trash-album", "restore-album", "purge-album", "empty-trash",
    ].includes(candidate)) {
      throw new PhotoManagementError("Unknown photo management action.", 400);
    }
    const action = candidate as PhotoManagementAction;
    response.setHeader("Cache-Control", "no-store");
    response.json(await pipeline.managePhotos(action, request.body?.date_folder, request.body?.base));
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const status = error instanceof PhotoManagementError ? error.status : 500;
  if (status === 500) console.error(`[photo-pipeline] management request failed: ${errorMessage(error)}`);
  response.status(status).json({ error: status === 500 ? "Photo management request failed." : errorMessage(error) });
});

const server = app.listen(config.port, () => {
  console.log(`[photo-pipeline] listening on ${config.port}; watching ${pipeline.directories.staging}`);
});

function requireServiceToken(request: express.Request, response: express.Response, next: express.NextFunction): void {
  const expected = process.env.PORTAL_SERVICE_TOKEN?.trim() || "";
  const provided = request.header("x-frame-service-token") || "";
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (expected && left.length === right.length && timingSafeEqual(left, right)) {
    next();
    return;
  }
  response.status(403).json({ error: "Internal service token required." });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    pipeline.stop();
    server.close(() => process.exit(0));
  });
}
