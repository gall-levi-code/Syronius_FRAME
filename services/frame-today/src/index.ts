import { createServer } from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { hasValidCredentials, unauthorizedUpgradeResponse, type BasicAuthConfig } from "./auth.js";
import { TodayController, TodayCommandError, parseCommand } from "./controller.js";
import { TodayStore } from "./store.js";

const port = integer("PORT", 3739, 1, 65535);
const dataRoot = path.resolve(process.env.DATA_ROOT?.trim() || "./data");
const controller = new TodayController(
  new TodayStore(dataRoot),
  integer("TODAY_DEFAULT_INTERVAL_MS", 10_000, 1_000, 300_000),
  integer("TODAY_REFRESH_MS", 1_000, 250, 60_000),
);
await controller.init();
const recoveredState = controller.state();
console.log(
  recoveredState.date_folder
    ? `[today] recovered ${recoveredState.count_today} photo(s) from ${recoveredState.date_folder}`
    : `[today] no published photos found under ${dataRoot}`,
);
const store = new TodayStore(dataRoot);
const auth: BasicAuthConfig = {
  username: process.env.PORTAL_USERNAME?.trim() || "",
  password: process.env.PORTAL_PASSWORD?.trim() || "",
  realm: process.env.PORTAL_REALM?.trim() || "FRAME Portal",
};
const app = createApp(controller, store, path.resolve(process.cwd(), "public"), auth);
const server = createServer(app);
const viewerSockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
const controlSockets = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });

const broadcast = (state: ReturnType<TodayController["state"]>) => {
  const message = JSON.stringify(state);
  for (const socket of [...viewerSockets.clients, ...controlSockets.clients]) {
    if (socket.readyState === WebSocket.OPEN) socket.send(message);
  }
};
controller.onState(broadcast);

viewerSockets.on("connection", (socket) => {
  socket.send(JSON.stringify(controller.state()));
});

controlSockets.on("connection", (socket) => {
  socket.send(JSON.stringify(controller.state()));
  socket.on("message", (data) => {
    try {
      controller.command(parseCommand(JSON.parse(data.toString())));
    } catch (error) {
      const message = error instanceof TodayCommandError ? error.message : "Invalid command.";
      socket.send(JSON.stringify({ type: "ERROR", error: message }));
    }
  });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname === "/today/ws/viewer") {
    viewerSockets.handleUpgrade(request, socket, head, (webSocket) => viewerSockets.emit("connection", webSocket, request));
    return;
  }
  if (url.pathname === "/today/ws/control") {
    if (!hasValidCredentials(request.headers.authorization, auth)) {
      socket.write(unauthorizedUpgradeResponse(auth));
      socket.destroy();
      return;
    }
    controlSockets.handleUpgrade(request, socket, head, (webSocket) => controlSockets.emit("connection", webSocket, request));
    return;
  }
  {
    socket.destroy();
  }
});

server.listen(port, () => console.log(`[today] listening on ${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    controller.close();
    viewerSockets.close();
    controlSockets.close();
    server.close(() => process.exit(0));
  });
}

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number.parseInt(process.env[name]?.trim() || String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}
