import express, { type Express } from "express";
import path from "node:path";
import { type BasicAuthConfig, requireBasicAuth } from "./auth.js";
import { GalleryRequestError, GalleryStore } from "./store.js";

export interface GalleryManagementConfig {
  pipelineUrl: string;
  serviceToken: string;
  auth: BasicAuthConfig;
}

export async function createApp(store: GalleryStore, publicDir: string, management?: GalleryManagementConfig): Promise<Express> {
  await store.init();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/healthz", async (_request, response, next) => {
    try {
      const dates = await store.listDates();
      response.json({
        ok: true,
        service: "frame-gallery",
        published_days: dates.length,
        published_photos: dates.reduce((total, date) => total + date.count, 0),
      });
    } catch (error) {
      next(error);
    }
  });
  app.use("/gallery/assets", express.static(publicDir, { index: false, maxAge: "1h" }));
  app.use("/today/gallery/assets", express.static(publicDir, { index: false, maxAge: "1h" }));
  if (management) {
    const protect = requireBasicAuth(management.auth);
    app.get(["/gallery/admin", "/gallery/admin/", "/today/gallery/admin", "/today/gallery/admin/"], protect, (_request, response) => {
      response.sendFile(path.join(publicDir, "admin.html"));
    });
    app.get(["/gallery/admin/api/trash", "/today/gallery/admin/api/trash"], protect, async (_request, response, next) => {
      try {
        response.setHeader("Cache-Control", "no-store");
        response.json(await pipelineRequest(management, "/api/internal/photo-pipeline/trash"));
      } catch (error) {
        next(error);
      }
    });
    app.post(["/gallery/admin/api/manage", "/today/gallery/admin/api/manage"], protect, async (request, response, next) => {
      try {
        response.setHeader("Cache-Control", "no-store");
        response.json(await pipelineRequest(management, "/api/internal/photo-pipeline/manage", request.body));
      } catch (error) {
        next(error);
      }
    });
    app.get(["/gallery/admin/image/:date/:file", "/today/gallery/admin/image/:date/:file"], protect, async (request, response, next) => {
      try {
        const base = stripExtension(request.params.file, ".jpg");
        response.setHeader("Cache-Control", "private, no-store");
        response.sendFile(await store.requireAdminImage(request.params.date, base));
      } catch (error) {
        next(error);
      }
    });
    app.get(["/gallery/admin/thumb/:date/:file", "/today/gallery/admin/thumb/:date/:file"], protect, async (request, response, next) => {
      try {
        const base = stripExtension(request.params.file, ".webp");
        response.setHeader("Cache-Control", "private, no-store");
        response.type("image/webp").sendFile(await store.requireAdminThumbnail(request.params.date, base));
      } catch (error) {
        next(error);
      }
    });
  }
  app.get(["/gallery", "/gallery/", "/today/gallery", "/today/gallery/"], (_request, response) => {
    response.sendFile(path.join(publicDir, "index.html"));
  });
  app.get(["/gallery/:date", "/gallery/:date/", "/today/gallery/:date", "/today/gallery/:date/"], (request, response, next) => {
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(request.params.date)) throw new GalleryRequestError("Invalid gallery date.", 400);
      response.sendFile(path.join(publicDir, "index.html"));
    } catch (error) {
      next(error);
    }
  });
  app.get("/gallery/api/dates", async (_request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json({ dates: await store.listDates() });
    } catch (error) {
      next(error);
    }
  });
  app.get("/gallery/api/photos", async (request, response, next) => {
    try {
      const date = typeof request.query.date === "string" ? request.query.date : "";
      response.setHeader("Cache-Control", "no-store");
      response.json({ date_folder: date, photos: await store.listPhotos(date) });
    } catch (error) {
      next(error);
    }
  });
  app.get("/gallery/image/:date/:file", async (request, response, next) => {
    try {
      const base = stripExtension(request.params.file, ".jpg");
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      response.sendFile(await store.requireImage(request.params.date, base));
    } catch (error) {
      next(error);
    }
  });
  app.get("/gallery/thumb/:date/:file", async (request, response, next) => {
    try {
      const base = stripExtension(request.params.file, ".webp");
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      response.type("image/webp").sendFile(await store.requireThumbnail(request.params.date, base));
    } catch (error) {
      next(error);
    }
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = error instanceof GalleryRequestError
      ? error.status
      : (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
    if (status === 500) console.error(`[gallery] ${errorMessage(error)}`);
    response.status(status).json({ error: status === 500 ? "Gallery request failed." : errorMessage(error) });
  });
  return app;
}

async function pipelineRequest(config: GalleryManagementConfig, pathname: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${config.pipelineUrl.replace(/\/+$/, "")}${pathname}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-frame-service-token": config.serviceToken,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({ error: `Pipeline request failed (${response.status}).` })) as { error?: unknown };
  if (!response.ok) {
    throw new GalleryRequestError(typeof result.error === "string" ? result.error : `Pipeline request failed (${response.status}).`, response.status);
  }
  return result;
}

function stripExtension(value: string, extension: string): string {
  if (!value.endsWith(extension)) throw new GalleryRequestError("Invalid media path.", 400);
  return value.slice(0, -extension.length);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
