import express, { type Express } from "express";
import path from "node:path";
import { type BasicAuthConfig, requireBasicAuth } from "./auth.js";
import { TodayCommandError, TodayController, parseCommand } from "./controller.js";
import { TodayRequestError, TodayStore } from "./store.js";

export function createApp(
  controller: TodayController,
  store: TodayStore,
  publicDir: string,
  auth: BasicAuthConfig,
): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));

  app.get("/healthz", (_request, response) => {
    const state = controller.state();
    response.json({
      ok: true,
      service: "frame-today",
      published_photos: state.count_today,
      viewers_ready: true,
      slideshow_running: state.slideshow_running,
      playback_state: state.playback_state,
    });
  });
  app.use("/today/assets", (_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  }, express.static(publicDir, { index: false, etag: false, lastModified: false }));
  app.get(["/today", "/today/"], (_request, response) => {
    const state = controller.state();
    response.redirect(state.date_folder && state.current_base ? `/today/gallery/${state.date_folder}/` : "/today/gallery");
  });
  app.get("/today/viewer", (_request, response) => response.sendFile(path.join(publicDir, "viewer.html")));
  app.get(["/today/dashboard", "/today/dashboard/"], requireBasicAuth(auth), (_request, response) => {
    response.sendFile(path.join(publicDir, "dashboard.html"));
  });
  app.get("/today/remote", requireBasicAuth(auth), (_request, response) => response.sendFile(path.join(publicDir, "remote.html")));
  app.get("/today/api/state", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json(controller.state());
  });
  app.get("/today/api/dashboard", requireBasicAuth(auth), async (_request, response, next) => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.json(await store.dashboardSummary());
    } catch (error) {
      next(error);
    }
  });
  app.post("/today/api/command", requireBasicAuth(auth), (request, response, next) => {
    try {
      response.json(controller.command(parseCommand(request.body)));
    } catch (error) {
      next(error);
    }
  });
  app.get("/today/image/:date/:file", async (request, response, next) => {
    try {
      const base = stripExtension(request.params.file, ".jpg");
      response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      response.sendFile(await store.requireImage(request.params.date, base));
    } catch (error) {
      next(error);
    }
  });
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    const status = error instanceof TodayCommandError || error instanceof TodayRequestError
      ? error instanceof TodayRequestError ? error.status : 400
      : (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
    if (status === 500) console.error(`[today] ${errorMessage(error)}`);
    response.status(status).json({ error: status === 500 ? "Today request failed." : errorMessage(error) });
  });
  return app;
}

function stripExtension(value: string, extension: string): string {
  if (!value.endsWith(extension)) throw new TodayRequestError("Invalid media path.", 400);
  return value.slice(0, -extension.length);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
