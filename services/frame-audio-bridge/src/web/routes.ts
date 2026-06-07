import type { Express, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "discord.js";
import type { AppConfig } from "../config";
import type { SessionManager } from "../sessions/sessionManager";
import type { VoiceManager } from "../voice/voiceManager";
import type { BridgeWebSocketServer, ClientCounts } from "./websocket";

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
  voiceManager: VoiceManager,
  discordClient: Client,
  websocketServer: BridgeWebSocketServer,
): void {
  app.get("/healthz", (_request, response) => {
    response.json({ ok: true });
  });

  app.get("/", (_request, response) => {
    response.type("text/plain").send("FRAME Audio Bridge is running.");
  });

  app.get("/api/internal/portal-status", async (request, response) => {
    if (!appConfig.portalServiceToken) {
      response.status(404).json({ error: "Not found" });
      return;
    }

    const suppliedToken = readBearerToken(request);
    if (!suppliedToken || !tokensMatch(suppliedToken, appConfig.portalServiceToken)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const guilds = await sessionManager.getPortalGuildTelemetry();
    response.setHeader("Cache-Control", "no-store");
    response.json({
      generated_at: new Date().toISOString(),
      bot_connected: discordClient.isReady(),
      guilds: guilds.map(({ bridgeKeys, activeProfiles, ...guild }) => {
        return {
          ...guild,
          activeProfiles: activeProfiles.map((profile) => ({ label: profile.label })),
          voice_connection: voiceManager.getConnectionStatus(guild.guildId),
          clients: bridgeKeys.reduce(
            (total, bridgeKey) => addClientCounts(total, websocketServer.getClientCounts(bridgeKey)),
            { audio: 0, overlay: 0, control: 0 },
          ),
        };
      }),
    });
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

function readBearerToken(request: Request): string | null {
  const authorization = request.header("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }
  return authorization.slice("Bearer ".length).trim() || null;
}

function tokensMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function addClientCounts(left: ClientCounts, right: ClientCounts): ClientCounts {
  return {
    audio: left.audio + right.audio,
    overlay: left.overlay + right.overlay,
    control: left.control + right.control,
  };
}

async function sendHtml(response: Response, filePath: string): Promise<void> {
  const html = await readFile(filePath, "utf8");
  response.type("html");
  response.setHeader("Cache-Control", "no-store");
  response.send(html.replaceAll("__ASSET_VERSION__", ASSET_VERSION));
}
