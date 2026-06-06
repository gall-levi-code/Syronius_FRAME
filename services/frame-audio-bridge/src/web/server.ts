import express from "express";
import type { Client } from "discord.js";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { AppConfig } from "../config";
import type { SessionManager } from "../sessions/sessionManager";
import type { VoiceManager } from "../voice/voiceManager";
import { registerRoutes } from "./routes";
import { BridgeWebSocketServer } from "./websocket";

export interface WebServerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createWebServer(
  appConfig: AppConfig,
  sessionManager: SessionManager,
  voiceManager: VoiceManager,
  discordClient: Client,
): WebServerHandle {
  const app = express();
  const server = createServer(app);
  const publicDir = path.resolve(process.cwd(), "public");

  app.disable("x-powered-by");
  app.use(express.json({ limit: "128kb" }));
  app.use((request, _response, next) => {
    console.log(`[web] ${request.method} ${request.path}`);
    next();
  });

  app.use(
    "/assets",
    (_request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      next();
    },
    express.static(publicDir),
  );
  registerRoutes(app, sessionManager, appConfig, publicDir);

  const websocketServer = new BridgeWebSocketServer(
    server,
    sessionManager,
    appConfig,
    voiceManager,
    discordClient,
  );

  return {
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(appConfig.port, () => {
          console.log(`[web] Listening on ${appConfig.publicBaseUrl} (port ${appConfig.port})`);
          resolve();
        });
      }),
    stop: async () => {
      await websocketServer.close();
      await closeServer(server);
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
