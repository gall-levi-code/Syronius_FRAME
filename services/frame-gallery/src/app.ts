import express, { type Express } from "express";
import { createHmac, randomBytes } from "node:crypto";
import path from "node:path";
import { type BasicAuthConfig, requireBasicAuth } from "./auth.js";
import { GalleryRequestError, GalleryStore, type GalleryTileView } from "./store.js";

const VIEW_COOKIE = "frame_gallery_view";
const VIEW_SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_VIEW_SESSIONS = 4096;
const MAX_SESSION_PHOTOS = 32;
const MAX_PHOTO_PAGE_SIZE = 100;

interface TileSession {
  id: string;
  expires_at: number;
  photos: Map<string, GalleryTileView>;
}

export interface GalleryManagementConfig {
  pipelineUrl: string;
  serviceToken: string;
  auth: BasicAuthConfig;
}

export async function createApp(store: GalleryStore, publicDir: string, management?: GalleryManagementConfig): Promise<Express> {
  await store.init();
  const app = express();
  const tileSessions = new Map<string, TileSession>();
  const tileSecret = randomBytes(32);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "5mb" }));

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
  app.get("/gallery/api/branding", async (_request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json({ branding: await store.getBranding() });
    } catch (error) {
      next(error);
    }
  });
  app.get("/gallery/branding/logo.webp", async (_request, response, next) => {
    try {
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.type("image/webp").sendFile(await store.requireLogo());
    } catch (error) {
      next(error);
    }
  });
  app.get("/gallery/branding/socials/:id/graphic.webp", async (request, response, next) => {
    try {
      response.setHeader("Cache-Control", "public, max-age=3600");
      response.type("image/webp").sendFile(await store.requireSocialGraphic(request.params.id));
    } catch (error) {
      next(error);
    }
  });
  if (management) {
    const protect = requireBasicAuth(management.auth);
    app.get(["/gallery/admin", "/gallery/admin/", "/today/gallery/admin", "/today/gallery/admin/"], protect, (_request, response) => {
      response.sendFile(path.join(publicDir, "admin.html"));
    });
    app.get(["/gallery/admin/explore", "/today/gallery/admin/explore"], protect, (_request, response) => {
      response.sendFile(path.join(publicDir, "explore-admin.html"));
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
        const result = await pipelineRequest(management, "/api/internal/photo-pipeline/manage", "POST", request.body);
        try {
          await store.pruneGallerySettings();
        } catch (error) {
          console.error(`[gallery] settings cleanup failed after photo management: ${errorMessage(error)}`);
        }
        response.json(result);
      } catch (error) {
        next(error);
      }
    });
    app.get(["/gallery/admin/api/explore", "/today/gallery/admin/api/explore"], protect, async (request, response, next) => {
      try {
        const date = typeof request.query.date === "string" ? request.query.date : "";
        response.setHeader("Cache-Control", "no-store");
        response.json({ date_folder: date, explore: await store.getExplore(date) });
      } catch (error) {
        next(error);
      }
    });
    app.put(["/gallery/admin/api/explore", "/today/gallery/admin/api/explore"], protect, async (request, response, next) => {
      try {
        const date = typeof request.query.date === "string" ? request.query.date : "";
        response.setHeader("Cache-Control", "no-store");
        response.json(await pipelineRequest(
          management,
          `/api/internal/photo-pipeline/explore?date=${encodeURIComponent(date)}`,
          "PUT",
          request.body,
        ));
      } catch (error) {
        next(error);
      }
    });
    app.delete(["/gallery/admin/api/explore", "/today/gallery/admin/api/explore"], protect, async (request, response, next) => {
      try {
        const date = typeof request.query.date === "string" ? request.query.date : "";
        response.setHeader("Cache-Control", "no-store");
        response.json(await pipelineRequest(
          management,
          `/api/internal/photo-pipeline/explore?date=${encodeURIComponent(date)}`,
          "DELETE",
        ));
      } catch (error) {
        next(error);
      }
    });
    app.get(["/gallery/admin/api/branding", "/today/gallery/admin/api/branding"], protect, async (_request, response, next) => {
      try {
        response.setHeader("Cache-Control", "no-store");
        response.json({ branding: await store.getBranding() });
      } catch (error) {
        next(error);
      }
    });
    app.put(["/gallery/admin/api/branding", "/today/gallery/admin/api/branding"], protect, async (request, response, next) => {
      try {
        response.setHeader("Cache-Control", "no-store");
        response.json({ branding: await store.updateBranding(request.body) });
      } catch (error) {
        next(error);
      }
    });
    app.post(["/gallery/admin/api/branding/logo", "/today/gallery/admin/api/branding/logo"], protect, async (request, response, next) => {
      try {
        response.setHeader("Cache-Control", "no-store");
        response.json({ branding: await store.saveLogo(request.body) });
      } catch (error) {
        next(error);
      }
    });
    app.delete(["/gallery/admin/api/branding/logo", "/today/gallery/admin/api/branding/logo"], protect, async (_request, response, next) => {
      try {
        response.setHeader("Cache-Control", "no-store");
        response.json({ branding: await store.deleteLogo() });
      } catch (error) {
        next(error);
      }
    });
    app.post([
      "/gallery/admin/api/branding/socials/:id/graphic",
      "/today/gallery/admin/api/branding/socials/:id/graphic",
    ], protect, async (request, response, next) => {
      try {
        response.setHeader("Cache-Control", "no-store");
        response.json({ branding: await store.saveSocialGraphic(request.params.id, request.body) });
      } catch (error) {
        next(error);
      }
    });
    app.delete([
      "/gallery/admin/api/branding/socials/:id/graphic",
      "/today/gallery/admin/api/branding/socials/:id/graphic",
    ], protect, async (request, response, next) => {
      try {
        response.setHeader("Cache-Control", "no-store");
        response.json({ branding: await store.deleteSocialGraphic(request.params.id) });
      } catch (error) {
        next(error);
      }
    });
    app.put([
      "/gallery/admin/api/galleries/:date/settings",
      "/today/gallery/admin/api/galleries/:date/settings",
    ], protect, async (request, response, next) => {
      try {
        response.setHeader("Cache-Control", "no-store");
        response.json({ settings: await store.updateGallerySettings(request.params.date, request.body) });
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
      response.setHeader("Cache-Control", "private, no-cache");
      response.json({ dates: await store.listDates() });
    } catch (error) {
      next(error);
    }
  });
  app.get("/gallery/api/photos", async (request, response, next) => {
    try {
      const date = typeof request.query.date === "string" ? request.query.date : "";
      response.setHeader("Cache-Control", "private, no-cache");
      if (request.query.limit === undefined) {
        if (request.query.cursor !== undefined) throw new GalleryRequestError("Photo cursor requires a page size.", 400);
        const photos = await store.listPhotos(date);
        response.json({
          date_folder: date,
          photos,
          total: photos.length,
          next_cursor: null,
          revision: await store.galleryRevision(date),
        });
        return;
      }
      const limit = photoPageLimit(request.query.limit);
      const cursor = request.query.cursor === undefined
        ? undefined
        : typeof request.query.cursor === "string" ? request.query.cursor : null;
      if (cursor === null) throw new GalleryRequestError("Photo cursor is invalid.", 400);
      response.json({ date_folder: date, ...await store.listPhotoPage(date, limit, cursor) });
    } catch (error) {
      next(error);
    }
  });
  app.post("/gallery/api/view-session", async (request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    try {
      requireSameOriginBrowserRequest(request, "empty");
      if (!isRecord(request.body) || typeof request.body.date_folder !== "string" || typeof request.body.base !== "string") {
        throw new GalleryRequestError("A gallery date and photo are required.", 400);
      }
      const view = await store.createTileView(request.body.date_folder, request.body.base);
      const session = requireOrCreateTileSession(request, tileSessions);
      const handle = createHmac("sha256", tileSecret)
        .update(`${session.id}\0${view.date_folder}\0${view.base}\0${view.source_version}`)
        .digest("base64url");
      session.photos.delete(handle);
      session.photos.set(handle, view);
      while (session.photos.size > MAX_SESSION_PHOTOS) session.photos.delete(session.photos.keys().next().value!);
      response.cookie(VIEW_COOKIE, session.id, {
        httpOnly: true,
        sameSite: "strict",
        secure: requestIsSecure(request),
        path: "/gallery",
        maxAge: VIEW_SESSION_TTL_MS,
      });
      response.json({
        view: {
          handle,
          width: view.width,
          height: view.height,
          tile_size: view.tile_size,
          overlap: view.overlap,
          columns: view.columns,
          rows: view.rows,
          tiles: tileEntries(handle, view),
        },
      });
    } catch (error) {
      next(error);
    }
  });
  app.get("/gallery/tile/:handle/:x/:file", async (request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      requireSameOriginBrowserRequest(request, "image");
      const session = findTileSession(request, tileSessions);
      const view = session?.photos.get(request.params.handle);
      if (!view) throw new GalleryRequestError("Tile was not found.", 404);
      const x = tileCoordinate(request.params.x);
      const y = tileCoordinate(stripExtension(request.params.file, ".webp"));
      const tile = await store.requireTile(view, x, y);
      response.type("image/webp").sendFile(tile);
    } catch (error) {
      next(error);
    }
  });
  app.get("/gallery/image/:date/:file", async (request, response, next) => {
    response.setHeader("Cache-Control", "private, no-cache");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      requireSameOriginBrowserRequest(request, "image");
      if (!(await store.getBranding()).show_download_button) {
        throw new GalleryRequestError("Gallery image was not found.", 404);
      }
      const base = stripExtension(request.params.file, ".jpg");
      const image = await store.requireImage(request.params.date, base);
      response.setHeader("Content-Disposition", `inline; filename="${base}.jpg"`);
      response.type("image/jpeg").sendFile(image);
    } catch (error) {
      next(error);
    }
  });
  app.get("/gallery/download/:date/:file", async (request, response, next) => {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const base = stripExtension(request.params.file, ".jpg");
      if (!(await store.getBranding()).show_download_button) {
        throw new GalleryRequestError("Photo download was not found.", 404);
      }
      const image = await store.requireImage(request.params.date, base);
      response.attachment(`${base}.jpg`).sendFile(image);
    } catch (error) {
      next(error);
    }
  });
  app.get("/gallery/api/explore", async (request, response, next) => {
    try {
      const date = typeof request.query.date === "string" ? request.query.date : "";
      response.setHeader("Cache-Control", "private, no-cache");
      response.json({
        date_folder: date,
        explore: await store.getPublicExplore(date),
      });
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
    const candidateStatus = (error as { status?: unknown })?.status;
    const status = error instanceof GalleryRequestError
      ? error.status
      : typeof candidateStatus === "number" && candidateStatus >= 400 && candidateStatus < 600 ? candidateStatus
      : (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
    if (status === 500) console.error(`[gallery] ${errorMessage(error)}`);
    response.status(status).json({ error: status === 500 ? "Gallery request failed." : errorMessage(error) });
  });
  return app;
}

async function pipelineRequest(
  config: GalleryManagementConfig,
  pathname: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(`${config.pipelineUrl.replace(/\/+$/, "")}${pathname}`, {
    method,
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

function photoPageLimit(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new GalleryRequestError("Photo page size must be a positive integer.", 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new GalleryRequestError("Photo page size is invalid.", 400);
  return Math.min(parsed, MAX_PHOTO_PAGE_SIZE);
}

function requireOrCreateTileSession(request: express.Request, sessions: Map<string, TileSession>): TileSession {
  const now = Date.now();
  pruneTileSessions(sessions, now);
  const existingId = readCookie(request, VIEW_COOKIE);
  const existing = existingId ? sessions.get(existingId) : undefined;
  if (existing) {
    existing.expires_at = now + VIEW_SESSION_TTL_MS;
    sessions.delete(existing.id);
    sessions.set(existing.id, existing);
    return existing;
  }
  while (sessions.size >= MAX_VIEW_SESSIONS) sessions.delete(sessions.keys().next().value!);
  const session: TileSession = {
    id: randomBytes(32).toString("base64url"),
    expires_at: now + VIEW_SESSION_TTL_MS,
    photos: new Map(),
  };
  sessions.set(session.id, session);
  return session;
}

function findTileSession(request: express.Request, sessions: Map<string, TileSession>): TileSession | null {
  pruneTileSessions(sessions, Date.now());
  const id = readCookie(request, VIEW_COOKIE);
  return id ? sessions.get(id) ?? null : null;
}

function pruneTileSessions(sessions: Map<string, TileSession>, now: number): void {
  for (const [id, session] of sessions) {
    if (session.expires_at <= now) sessions.delete(id);
  }
}

function readCookie(request: express.Request, name: string): string | null {
  for (const part of (request.get("cookie") || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

function requireSameOriginBrowserRequest(request: express.Request, destination: "empty" | "image"): void {
  if (request.get("sec-fetch-site") !== "same-origin" || request.get("sec-fetch-dest") !== destination) {
    throw new GalleryRequestError("Gallery media was not found.", 404);
  }
}

function requestIsSecure(request: express.Request): boolean {
  if (request.secure || (request.get("x-forwarded-proto") || "").split(",", 1)[0].trim().toLowerCase() === "https") {
    return true;
  }
  try {
    return JSON.parse(request.get("cf-visitor") || "null")?.scheme === "https";
  } catch {
    return false;
  }
}

function tileCoordinate(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new GalleryRequestError("Tile was not found.", 404);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new GalleryRequestError("Tile was not found.", 404);
  return parsed;
}

function tileEntries(handle: string, view: GalleryTileView): Array<{
  x: number;
  y: number;
  width: number;
  height: number;
  url: string;
}> {
  const tiles = [];
  for (let y = 0; y < view.rows; y += 1) {
    for (let x = 0; x < view.columns; x += 1) {
      tiles.push({
        x,
        y,
        width: Math.min(view.tile_size, view.width - x * view.tile_size),
        height: Math.min(view.tile_size, view.height - y * view.tile_size),
        url: `/gallery/tile/${handle}/${x}/${y}.webp`,
      });
    }
  }
  return tiles;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
