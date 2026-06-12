import { execFile } from "node:child_process";
import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { RelayManager } from "./relayManager.js";
import { AudioStreamStore, BITRATE_PRESETS, StoreError, validateStreamInput } from "./store.js";

const execFileAsync = promisify(execFile);
const config = loadConfig();
const store = new AudioStreamStore(config.dataRoot);
await store.init();
const relays = new RelayManager(config, store);
await relays.init();

const app = express();
const server = createServer(app);
const captureSockets = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
const publicDir = path.resolve(process.cwd(), "public");
const hlsDir = path.join(config.dataRoot, "hls");

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

app.get("/healthz", async (_request, response) => {
  try {
    await execFileAsync(config.ffmpegPath, ["-version"], { timeout: 3_000 });
    response.json({ ok: true, service: "frame-audio", streams: store.list().length, ffmpeg: "ready" });
  } catch {
    response.status(503).json({ ok: false, service: "frame-audio", ffmpeg: "unavailable" });
  }
});

app.get("/audio/api/config", (_request, response) => {
  response.json({ public_base_url: config.publicBaseUrl, bitrate_presets: BITRATE_PRESETS });
});

app.get("/audio/api/streams", async (_request, response, next) => {
  try {
    response.json({ streams: await Promise.all(store.list().map((stream) => relays.status(stream))) });
  } catch (error) {
    next(error);
  }
});

app.post("/audio/api/streams", async (request, response, next) => {
  try {
    const input = validateStreamInput(request.body);
    const stream = await store.create(input);
    await relays.reconcile(stream);
    response.status(201).json({ stream: await relays.status(store.get(stream.streamId) ?? stream) });
  } catch (error) {
    next(error);
  }
});

app.put("/audio/api/streams/:streamId", async (request, response, next) => {
  try {
    const streamId = validStreamId(request.params.streamId);
    const input = validateStreamInput({ ...request.body, streamId });
    const stream = await store.update(streamId, input);
    await relays.reconcile(stream);
    response.json({ stream: await relays.status(store.get(streamId) ?? stream) });
  } catch (error) {
    next(error);
  }
});

app.delete("/audio/api/streams/:streamId", async (request, response, next) => {
  try {
    const streamId = validStreamId(request.params.streamId);
    await relays.deleteStream(streamId);
    await store.delete(streamId);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get(["/audio/api/streams/:streamId/status", "/audio/public/streams/:streamId/status"], async (request, response, next) => {
  try {
    const stream = requireStream(request.params.streamId);
    const status = await relays.status(stream);
    response.setHeader("Cache-Control", "no-store");
    if (request.path.startsWith("/audio/public/")) {
      const { captureUrl: _captureUrl, instanceId: _instanceId, inputKbps: _inputKbps, lastError: _lastError, ...publicStatus } = status;
      response.json({ stream: publicStatus });
      return;
    }
    response.json({ stream: status });
  } catch (error) {
    next(error);
  }
});

app.post(["/audio/api/streams/:streamId/listener-heartbeat", "/audio/public/streams/:streamId/listener-heartbeat"], (request, response, next) => {
  try {
    const streamId = validStreamId(request.params.streamId);
    const listenerId = typeof request.body?.listenerId === "string" ? request.body.listenerId.slice(0, 100) : "";
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(listenerId)) throw new StoreError(400, "A valid listener ID is required.");
    response.json({ listenerCount: relays.heartbeat(streamId, listenerId) });
  } catch (error) {
    next(error);
  }
});

app.use("/audio/hls", express.static(hlsDir, {
  fallthrough: false,
  setHeaders: (response) => {
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Access-Control-Allow-Origin", "*");
  },
}));
app.get("/audio/assets/hls.min.js", (_request, response) => {
  response.sendFile(path.resolve(process.cwd(), "node_modules", "hls.js", "dist", "hls.min.js"));
});
app.use("/audio/assets", express.static(publicDir, { maxAge: 0 }));
app.get(["/", "/audio", "/audio/admin"], (_request, response) => response.sendFile(path.join(publicDir, "admin.html")));
app.get("/audio/capture/:streamId", (request, response, next) => {
  try {
    requireStream(request.params.streamId);
    response.sendFile(path.join(publicDir, "capture.html"));
  } catch (error) {
    next(error);
  }
});
app.get("/audio/listen/:streamId", (request, response, next) => {
  try {
    requireStream(request.params.streamId);
    response.sendFile(path.join(publicDir, "listen.html"));
  } catch (error) {
    next(error);
  }
});

app.use((
  error: unknown,
  _request: express.Request,
  response: express.Response,
  _next: express.NextFunction,
) => {
  const reportedStatus = error && typeof error === "object" && "status" in error ? Number(error.status) : 500;
  const status = error instanceof StoreError
    ? error.status
    : Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599
      ? reportedStatus
      : 500;
  if (status >= 500) console.error("[audio]", error);
  response.status(status).json({ error: error instanceof Error ? error.message : String(error) });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  const match = /^\/audio\/ws\/capture\/([a-z0-9-]+)$/.exec(url.pathname);
  if (!match) {
    socket.destroy();
    return;
  }
  const streamId = match[1];
  if (!store.get(streamId)) {
    socket.destroy();
    return;
  }
  captureSockets.handleUpgrade(request, socket, head, (webSocket) => {
    void relays.attachPublisher(streamId, webSocket).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[audio] Publisher rejected for ${streamId}: ${message}`);
      webSocket.close(1008, message.slice(0, 120));
    });
  });
});

server.listen(config.port, () => {
  console.log(`[audio] FRAME Audio Monitor listening on port ${config.port}`);
});

async function shutdown(): Promise<void> {
  await relays.close();
  server.close(() => process.exit(0));
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function validStreamId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{6,63}$/.test(value)) {
    throw new StoreError(400, "Invalid stream ID.");
  }
  return value;
}

function requireStream(value: unknown) {
  const stream = store.get(validStreamId(value));
  if (!stream) throw new StoreError(404, "Audio source not found.");
  return stream;
}
