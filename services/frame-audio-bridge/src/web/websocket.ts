import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { Client } from "discord.js";
import { WebSocket, WebSocketServer } from "ws";
import { startBridgeForProfileOwner, stopBridgeForProfile } from "../bridgeActions";
import type { AppConfig } from "../config";
import type { OverlaySettings } from "../sessions/guildConfig";
import type {
  BridgeAudioChunk,
  BridgeSnapshot,
  SessionManager,
} from "../sessions/sessionManager";
import type { VoiceManager } from "../voice/voiceManager";

type ClientKind = "audio" | "overlay" | "control";
const CLIENT_STATS_INTERVAL_MS = 15_000;

export interface ClientCounts {
  audio: number;
  overlay: number;
  control: number;
}

interface BridgeClient {
  ws: WebSocket;
  guildKey: string;
  kind: ClientKind;
}

interface ClientMessage {
  type?: string;
  delayMs?: number;
  delayEnabled?: boolean;
  overlaySettings?: Partial<OverlaySettings>;
  discordUserId?: string;
  muted?: boolean;
  volume?: number;
  hidden?: boolean;
}

function isClientKind(value: string | null): value is ClientKind {
  return value === "audio" || value === "overlay" || value === "control";
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function redactSnapshot(snapshot: BridgeSnapshot, kind: ClientKind): BridgeSnapshot {
  if (kind === "control") {
    return snapshot;
  }

  return {
    ...snapshot,
    urls: {
      audio: snapshot.urls.audio,
      overlay: snapshot.urls.overlay,
    },
  };
}

export class BridgeWebSocketServer {
  private readonly wss: WebSocketServer;

  private readonly clients = new Set<BridgeClient>();

  private readonly clientStatsTimer: NodeJS.Timeout;

  public constructor(
    server: Server,
    private readonly sessionManager: SessionManager,
    private readonly appConfig: AppConfig,
    private readonly voiceManager: VoiceManager,
    private readonly discordClient: Client,
  ) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws, request) => {
      void this.handleConnection(ws, request);
    });
    this.clientStatsTimer = setInterval(() => {
      this.logClientStats();
    }, CLIENT_STATS_INTERVAL_MS);
    this.clientStatsTimer.unref();

    this.sessionManager.on("snapshot", (snapshot: BridgeSnapshot) => {
      this.broadcastSnapshot(snapshot);
    });

    this.sessionManager.on("audioChunk", (chunk: BridgeAudioChunk) => {
      this.broadcastAudioChunk(chunk);
    });
  }

  public close(): Promise<void> {
    return new Promise((resolve, reject) => {
      clearInterval(this.clientStatsTimer);
      for (const client of this.clients) {
        client.ws.close(1001, "server shutting down");
      }

      this.wss.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  public getClientCounts(guildKey: string): ClientCounts {
    return this.countClients(guildKey);
  }

  private async handleConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    const url = new URL(request.url ?? "/ws", this.appConfig.publicBaseUrl);
    const guildKey = url.searchParams.get("guildKey")?.trim();
    const kindParam = url.searchParams.get("client");

    if (!guildKey || !isClientKind(kindParam)) {
      sendJson(ws, { type: "error", message: "Missing guildKey or invalid client type" });
      ws.close(1008, "invalid websocket parameters");
      return;
    }

    const authorized =
      kindParam === "control"
        ? await this.sessionManager.validateControlToken(
            guildKey,
            url.searchParams.get("token"),
          )
        : await this.sessionManager.validateObsToken(guildKey, url.searchParams.get("obsToken"));

    if (!authorized) {
      sendJson(ws, { type: "error", message: "Unauthorized bridge client" });
      ws.close(1008, "unauthorized");
      return;
    }

    const client: BridgeClient = {
      ws,
      guildKey,
      kind: kindParam,
    };
    this.clients.add(client);
    this.broadcastClientState(client.guildKey);

    console.log(`[websocket] ${client.kind} connected for ${client.guildKey}`);

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        return;
      }

      void this.handleClientMessage(client, raw.toString("utf8"));
    });

    ws.on("close", () => {
      this.clients.delete(client);
      this.broadcastClientState(client.guildKey);
      console.log(`[websocket] ${client.kind} disconnected for ${client.guildKey}`);
    });

    ws.on("error", (error) => {
      console.error(`[websocket] ${client.kind} error for ${client.guildKey}`, error);
    });

    const snapshot = await this.sessionManager.getSnapshotByGuildKey(
      client.guildKey,
      client.kind === "control",
    );

    if (!snapshot) {
      sendJson(ws, { type: "error", message: "Unknown bridge" });
      ws.close(1008, "unknown bridge");
      return;
    }

    this.sendSnapshot(client, snapshot);
    this.sendClientState(client);
  }

  private async handleClientMessage(client: BridgeClient, raw: string): Promise<void> {
    if (client.kind !== "control") {
      return;
    }

    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      sendJson(client.ws, { type: "error", message: "Invalid JSON message" });
      return;
    }

    try {
      if (message.type === "set-delay" && typeof message.delayMs === "number") {
        await this.sessionManager.setDelay(client.guildKey, message.delayMs);
        return;
      }

      if (message.type === "set-delay-enabled" && typeof message.delayEnabled === "boolean") {
        await this.sessionManager.setDelayEnabled(client.guildKey, message.delayEnabled);
        return;
      }

      if (message.type === "set-overlay" && message.overlaySettings) {
        await this.sessionManager.setOverlaySettings(client.guildKey, message.overlaySettings);
        return;
      }

      if (message.type === "set-user" && message.discordUserId) {
        await this.sessionManager.setUserControls(client.guildKey, message.discordUserId, {
          muted: message.muted,
          volume: message.volume,
          hidden: message.hidden,
        });
        return;
      }

      if (message.type === "set-users") {
        await this.sessionManager.setAllUserControls(client.guildKey, {
          muted: message.muted,
          volume: message.volume,
          hidden: message.hidden,
        });
        return;
      }

      if (message.type === "start-bridge") {
        const profile = await this.sessionManager.getProfileByBridgeKey(client.guildKey);
        if (!profile) {
          sendJson(client.ws, {
            type: "bridge-action",
            ok: false,
            state: "retry",
            message: "Unknown bridge profile.",
          });
          return;
        }

        const result = await startBridgeForProfileOwner({
          discordClient: this.discordClient,
          sessionManager: this.sessionManager,
          voiceManager: this.voiceManager,
          profile,
        });
        sendJson(client.ws, {
          type: "bridge-action",
          action: "start",
          ...result,
        });
        return;
      }

      if (message.type === "stop-bridge") {
        const profile = await this.sessionManager.getProfileByBridgeKey(client.guildKey);
        if (!profile) {
          sendJson(client.ws, {
            type: "bridge-action",
            ok: false,
            state: "retry",
            message: "Unknown bridge profile.",
          });
          return;
        }

        const result = await stopBridgeForProfile({
          sessionManager: this.sessionManager,
          profile,
          reason: "control-page",
        });
        sendJson(client.ws, {
          type: "bridge-action",
          action: "stop",
          ...result,
        });
        return;
      }

      if (message.type === "ping") {
        sendJson(client.ws, { type: "pong", now: Date.now() });
      }
    } catch (error) {
      const response = error instanceof Error ? error.message : "Control update failed";
      sendJson(client.ws, { type: "error", message: response });
    }
  }

  private broadcastSnapshot(snapshot: BridgeSnapshot): void {
    for (const client of this.clients) {
      if (client.guildKey !== snapshot.guildKey) {
        continue;
      }

      this.sendSnapshot(client, snapshot);
    }
  }

  private broadcastAudioChunk(chunk: BridgeAudioChunk): void {
    for (const client of this.clients) {
      if (client.kind !== "audio" || client.guildKey !== chunk.guildKey) {
        continue;
      }

      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(chunk.pcm, { binary: true });
      }
    }
  }

  private logClientStats(): void {
    const countsByGuildKey = new Map<string, ClientCounts>();

    for (const client of this.clients) {
      if (client.ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      const counts =
        countsByGuildKey.get(client.guildKey) ??
        {
          audio: 0,
          overlay: 0,
          control: 0,
        };
      counts[client.kind] += 1;
      countsByGuildKey.set(client.guildKey, counts);
    }

    for (const [guildKey, counts] of countsByGuildKey) {
      if (counts.audio === 0 && counts.overlay === 0 && counts.control === 0) {
        continue;
      }

      console.log(
        `[audio] clients guildKey=${guildKey} audio=${counts.audio} overlay=${counts.overlay} control=${counts.control}`,
      );
    }
  }

  private broadcastClientState(guildKey: string): void {
    for (const client of this.clients) {
      if (client.guildKey === guildKey && client.kind === "control") {
        this.sendClientState(client);
      }
    }
  }

  private sendClientState(client: BridgeClient): void {
    if (client.kind !== "control") {
      return;
    }

    sendJson(client.ws, {
      type: "client-state",
      counts: this.countClients(client.guildKey),
    });
  }

  private countClients(guildKey: string): ClientCounts {
    const counts: ClientCounts = {
      audio: 0,
      overlay: 0,
      control: 0,
    };

    for (const client of this.clients) {
      if (client.guildKey !== guildKey || client.ws.readyState !== WebSocket.OPEN) {
        continue;
      }

      counts[client.kind] += 1;
    }

    return counts;
  }

  private sendSnapshot(client: BridgeClient, snapshot: BridgeSnapshot): void {
    if (client.kind === "control") {
      sendJson(client.ws, {
        type: "snapshot",
        snapshot: redactSnapshot(snapshot, client.kind),
      });
      return;
    }

    if (client.kind === "audio") {
      sendJson(client.ws, {
        type: "audio-state",
        active: snapshot.active,
        delayMs: snapshot.delayMs,
      });
      return;
    }

    const delayMs = Math.max(0, snapshot.delayMs);
    setTimeout(() => {
      sendJson(client.ws, {
        type: "overlay-state",
        snapshot: redactSnapshot(snapshot, client.kind),
      });
    }, delayMs);
  }
}
