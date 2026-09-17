import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { hasValidCredentials, unauthorizedUpgradeResponse, type BasicAuthConfig } from "./auth.js";
import { TodayCommandError, parseCommand, type TodayController, type TodayState } from "./controller.js";

export function attachTodaySockets(server: Server, controller: TodayController, auth: BasicAuthConfig): () => void {
  const viewers = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const controls = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  const reports = new Map<WebSocket, "loading" | "displayed" | "error" | "empty">();
  const alive = new Set<WebSocket>();
  let currentKey = photoKey(controller.state());
  const send = (socket: WebSocket, message: unknown) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  const status = () => {
    const connected = [...viewers.clients].filter((socket) => socket.readyState === WebSocket.OPEN);
    return {
      type: "VIEWER_STATUS",
      photo_key: currentKey,
      viewers: connected.length,
      displayed: currentKey ? connected.filter((socket) => reports.get(socket) === "displayed").length : 0,
      loading: currentKey ? connected.filter((socket) => !reports.has(socket) || reports.get(socket) === "loading").length : 0,
      failed: currentKey ? connected.filter((socket) => reports.get(socket) === "error").length : 0,
    };
  };
  const broadcastStatus = () => {
    const message = status();
    for (const socket of controls.clients) send(socket, message);
  };
  const unsubscribe = controller.onState((state) => {
    const key = photoKey(state);
    if (key !== currentKey) {
      currentKey = key;
      reports.clear();
    }
    for (const socket of [...viewers.clients, ...controls.clients]) send(socket, state);
    broadcastStatus();
  });

  viewers.on("connection", (socket) => {
    send(socket, controller.state());
    broadcastStatus();
    socket.on("message", (data, binary) => {
      if (binary) return;
      try {
        const report = JSON.parse(data.toString());
        if (!report || typeof report !== "object" || Object.keys(report).length !== 3
          || report.type !== "VIEWER_REPORT" || report.photo_key !== currentKey
          || !["loading", "displayed", "error", "empty"].includes(report.status)
          || (currentKey === null) !== (report.status === "empty")) return;
        reports.set(socket, report.status);
        broadcastStatus();
      } catch { /* Ignore malformed public viewer reports. */ }
    });
    socket.on("close", () => {
      reports.delete(socket);
      broadcastStatus();
    });
  });
  controls.on("connection", (socket) => {
    send(socket, controller.state());
    send(socket, status());
    socket.on("message", (data) => {
      try {
        controller.command(parseCommand(JSON.parse(data.toString())));
      } catch (error) {
        send(socket, { type: "ERROR", error: error instanceof TodayCommandError ? error.message : "Invalid command." });
      }
    });
  });
  for (const sockets of [viewers, controls]) {
    sockets.on("connection", (socket) => {
      alive.add(socket);
      socket.on("pong", () => alive.add(socket));
      socket.on("close", () => alive.delete(socket));
      socket.on("error", () => socket.terminate());
    });
  }
  const heartbeat = setInterval(() => {
    for (const socket of [...viewers.clients, ...controls.clients]) {
      if (!alive.delete(socket)) socket.terminate();
      else socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  server.on("upgrade", (request, socket, head) => {
    let pathname: string;
    try { pathname = new URL(request.url || "/", "http://localhost").pathname; }
    catch { return socket.destroy(); }
    const sockets = pathname === "/today/ws/viewer" ? viewers : pathname === "/today/ws/control" ? controls : null;
    if (!sockets) return socket.destroy();
    if (sockets === controls && !hasValidCredentials(request.headers.authorization, auth)) {
      socket.write(unauthorizedUpgradeResponse(auth));
      return socket.destroy();
    }
    sockets.handleUpgrade(request, socket, head, (webSocket) => sockets.emit("connection", webSocket, request));
  });
  return () => {
    unsubscribe();
    clearInterval(heartbeat);
    for (const sockets of [viewers, controls]) {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    }
  };
}

function photoKey(state: TodayState): string | null {
  return state.current_photo ? `${state.current_photo.date_folder}/${state.current_photo.base}` : null;
}
