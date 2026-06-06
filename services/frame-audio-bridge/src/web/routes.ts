import type { Express, Request, Response } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config";
import type { SessionManager } from "../sessions/sessionManager";

const ASSET_VERSION = "2026-06-05-control-input-hold";

async function ensureKnownGuild(
  sessionManager: SessionManager,
  guildKey: string,
  response: Response,
): Promise<boolean> {
  const config = await sessionManager.getGuildConfigByKey(guildKey);
  if (!config) {
    response.status(404).send("Unknown FRAME Audio Bridge key.");
    return false;
  }

  return true;
}

export function registerRoutes(
  app: Express,
  sessionManager: SessionManager,
  appConfig: AppConfig,
  publicDir: string,
): void {
  app.get("/healthz", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/", (_request, response) => {
    response.type("text/plain").send("FRAME Audio Bridge is running.");
  });

  app.get("/bridge/:guildKey/audio", async (request: Request, response: Response) => {
    const guildKey = request.params.guildKey;
    const authorized = await sessionManager.validateObsToken(
      guildKey,
      typeof request.query.obsToken === "string" ? request.query.obsToken : null,
    );

    if (!authorized) {
      response.status(403).send("Unauthorized OBS audio source.");
      return;
    }

    await sendHtml(response, path.join(publicDir, "audio.html"));
  });

  app.get("/bridge/:guildKey/overlay", async (request: Request, response: Response) => {
    const guildKey = request.params.guildKey;
    const authorized = await sessionManager.validateObsToken(
      guildKey,
      typeof request.query.obsToken === "string" ? request.query.obsToken : null,
    );

    if (!authorized) {
      response.status(403).send("Unauthorized OBS overlay source.");
      return;
    }

    await sendHtml(response, path.join(publicDir, "overlay.html"));
  });

  app.get("/bridge/:guildKey/control", async (request: Request, response: Response) => {
    const guildKey = request.params.guildKey;
    const token = typeof request.query.token === "string" ? request.query.token : null;
    const authorized = await sessionManager.validateControlToken(guildKey, token);

    if (!authorized) {
      response.status(403).send("Unauthorized control page.");
      return;
    }

    await sendHtml(response, path.join(publicDir, "control.html"));
  });

  app.get("/api/bridge/:guildKey/snapshot", async (request: Request, response: Response) => {
    const guildKey = request.params.guildKey;
    const token = typeof request.query.token === "string" ? request.query.token : null;
    const authorized = await sessionManager.validateControlToken(guildKey, token);

    if (!authorized) {
      response.status(403).json({ error: "Unauthorized" });
      return;
    }

    if (!(await ensureKnownGuild(sessionManager, guildKey, response))) {
      return;
    }

    const snapshot = await sessionManager.getSnapshotByGuildKey(guildKey, true);
    response.json({ snapshot });
  });

}

async function sendHtml(response: Response, filePath: string): Promise<void> {
  const html = await readFile(filePath, "utf8");
  response.type("html");
  response.setHeader("Cache-Control", "no-store");
  response.send(html.replaceAll("__ASSET_VERSION__", ASSET_VERSION));
}
