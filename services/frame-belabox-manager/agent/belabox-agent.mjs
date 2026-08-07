import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import os from "node:os";
import dns from "node:dns";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

const VERSION = "0.9.1";
const CONTROL_PROTOCOL = "frame-belabox-control-v1";
const CONTROL_MAX_MESSAGE_BYTES = 256 * 1024;
const CONTROL_AUTH_TIMEOUT_MS = 10000;
const CONTROL_HIGH_WATER_BYTES = 1024 * 1024;
const CONTROL_LOW_WATER_BYTES = CONTROL_HIGH_WATER_BYTES / 2;
const PROXY_BINARY_HEADER_BYTES = 17;
const PROXY_BINARY_CHUNK_BYTES = CONTROL_MAX_MESSAGE_BYTES - PROXY_BINARY_HEADER_BYTES;
const PROXY_MAX_STREAMS = 16;
const PROXY_IDLE_TIMEOUT_MS = 30000;
const PROXY_MAX_PENDING_INPUT_BYTES = CONTROL_HIGH_WATER_BYTES;
const VIDEO_MIXER_LOCAL_URL = "http://127.0.0.1:9080";
const DIAGNOSTIC_REQUEST_TIMEOUT_MS = 30000;
const EXTERNAL_SPEEDTEST_BASE_URL = "https://speed.cloudflare.com";
const PROXY_REQUEST_HEADER_BLOCKLIST = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "proxy-connection",
  "authorization",
  "proxy-authorization",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
  "x-frame-authenticated-user",
]);
const PROXY_RESPONSE_HEADER_BLOCKLIST = new Set(["set-cookie", "set-cookie2"]);
const ALLOWED_COMMANDS = new Set([
  "agent_update",
  "agent_restart",
  "agent_status",
  "log_bundle_collect",
  "log_bundle_upload_stub",
  "telemetry_refresh",
  "photo_transfer_mode_set",
  "photo_transport_config_set",
  "photo_processing_config_set",
  "photo_module_status",
  "photo_queue_reset",
  "relay_catalog_sync",
  "network_speed_test",
]);
const selfTestMode = process.argv.includes("--self-test");
const configuredDeviceId = String(process.env.BELABOX_DEVICE_ID || "").trim();
const deviceId = selfTestMode ? "selftest" : sanitizeId(configuredDeviceId);
const controlSecret = String(process.env.BELABOX_CONTROL_SECRET || "");
const publicKeyPem = readPublicKeyPem();
const usedNonces = new Set();
const heartbeatMs = readInt("BELABOX_CONTROL_HEARTBEAT_MS", 10000, 2000, 300000);
const telemetryMs = readInt("BELABOX_TELEMETRY_INTERVAL_MS", 30000, 1000, 600000);
const activePhotoTelemetryMs = readInt("BELABOX_ACTIVE_PHOTO_TELEMETRY_INTERVAL_MS", 500, 200, 5000);
const reconnectMs = readInt("BELABOX_CONTROL_RECONNECT_MS", 5000, 1000, 60000);
const photoConfigPath = process.env.BELABOX_PHOTO_CONFIG_PATH || `${os.homedir()}/.frame-belabox-agent/photo-config.json`;
const egressStatusPath = process.env.BELABOX_EGRESS_STATUS_PATH || `${os.homedir()}/.frame-belabox-agent/egress.json`;
const egressProbeMs = readInt("BELABOX_EGRESS_PROBE_INTERVAL_MS", 1000, 500, 60000);
const relayCatalogPath = process.env.BELABOX_RELAY_CATALOG_PATH || `${os.homedir()}/.frame-belabox-agent/relay-catalog.json`;
const relayProbeMs = readInt("BELABOX_RELAY_PROBE_INTERVAL_MS", 5000, 1000, 60000);
const relayProbeHost = (process.env.BELABOX_RELAY_PROBE_HOST || "").trim();
const relayProbePort = readInt("BELABOX_RELAY_PROBE_PORT", 443, 1, 65535);
const relayProbeTimeoutMs = readInt("BELABOX_RELAY_PROBE_TIMEOUT_MS", 1200, 200, 5000);
const remoteBelaui = {
  enabled: readBool("BELABOX_REMOTE_BELAUI_ENABLED", true),
  localUrl: loopbackHttpUrl(process.env.BELABOX_REMOTE_BELAUI_LOCAL_URL || "http://127.0.0.1"),
  rewriteWebSocket: readBool("BELABOX_REMOTE_BELAUI_REWRITE_WS", true),
};
const agentSessionId = randomBytes(16).toString("hex");
let controlUrl = "";
let diagnosticState = null;
let diagnosticRunning = false;
let remoteBelauiState = remoteBelauiSnapshot(remoteBelaui.enabled ? "unchecked" : "disabled");
let videoMixerState = videoMixerSnapshot("unchecked", videoMixerInstalled());
let egressState = egressSnapshot([]);
let egressRefreshRunning = false;
let relayHealthRunning = false;
let relayHealthState = null;
let photoTelemetryWasActive = false;
let relayCatalogState = initialRelayCatalogState();
let proxyStateRefreshPromise = null;
const proxyStreams = new Map();
let WebSocketClient;
let client = null;
let authenticated = false;
let reconnectTimer = null;
let authTimer = null;

if (selfTestMode) {
  selfTest();
  process.exit(0);
}

main().catch((error) => {
  console.error(`[belabox-agent] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function main() {
  if (!configuredDeviceId) throw new Error("BELABOX_DEVICE_ID is required.");
  if (Buffer.byteLength(controlSecret, "utf8") < 32 || Buffer.byteLength(controlSecret, "utf8") > 512) {
    throw new Error("BELABOX_CONTROL_SECRET must be 32-512 bytes.");
  }
  if (!publicKeyPem) throw new Error("command signing public key is required.");
  controlUrl = normalizeControlUrl(process.env.BELABOX_CONTROL_URL || "");
  const wsModule = await import("ws");
  WebSocketClient = wsModule.WebSocket || wsModule.default || wsModule;

  setInterval(publishHeartbeat, heartbeatMs);
  setInterval(publishActivePhotoTelemetry, activePhotoTelemetryMs);
  setInterval(publishTelemetry, telemetryMs);
  setInterval(() => { void refreshProxyStatesAndPublish(false); }, Math.min(5000, telemetryMs));
  setInterval(() => { void refreshEgressState(); }, egressProbeMs);
  setInterval(() => { void refreshRelayHealth(); }, relayProbeMs);
  void refreshEgressState();
  void refreshRelayHealth();
  connectControl();
}

function connectControl() {
  if (client && (client.readyState === 0 || client.readyState === 1)) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  let socket;
  try {
    socket = new WebSocketClient(controlUrl, {
      handshakeTimeout: CONTROL_AUTH_TIMEOUT_MS,
      maxPayload: CONTROL_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
    });
  } catch (error) {
    console.error(`[belabox-agent] control connection failed: ${error instanceof Error ? error.message : String(error)}`);
    scheduleControlReconnect();
    return;
  }

  client = socket;
  authenticated = false;
  socket.on("open", () => {
    authTimer = setTimeout(() => {
      if (!authenticated && socket.readyState === 1) socket.close(1008, "authentication timeout");
    }, CONTROL_AUTH_TIMEOUT_MS);
    if (typeof authTimer.unref === "function") authTimer.unref();
  });
  socket.on("message", (data, isBinary) => {
    try {
      if (isBinary) handleControlBinary(Buffer.from(data));
      else handleControlMessage(Buffer.from(data).toString("utf8"));
    } catch (error) {
      console.error(`[belabox-agent] invalid control message: ${error instanceof Error ? error.message : String(error)}`);
      if (socket.readyState === 1) socket.close(1008, "invalid control message");
    }
  });
  socket.on("error", (error) => {
    console.error(`[belabox-agent] control error: ${error.message}`);
  });
  socket.on("close", () => {
    if (client !== socket) return;
    client = null;
    authenticated = false;
    clearControlAuthTimer();
    closeAllProxyStreams();
    scheduleControlReconnect();
  });
}

function scheduleControlReconnect() {
  if (reconnectTimer) return;
  const delay = Math.round(reconnectMs * (0.75 + Math.random() * 0.5));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectControl();
  }, delay);
  if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
}

function clearControlAuthTimer() {
  if (!authTimer) return;
  clearTimeout(authTimer);
  authTimer = null;
}

function handleControlMessage(raw) {
  if (Buffer.byteLength(raw, "utf8") > CONTROL_MAX_MESSAGE_BYTES) throw new Error("control message is too large");
  const message = JSON.parse(raw);
  if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
    throw new Error("control message must be an object with a type");
  }

  if (message.type === "challenge") {
    if (authenticated) throw new Error("unexpected authentication challenge");
    const nonce = controlNonce(message.nonce);
    sendJson({
      type: "hello",
      device_id: deviceId,
      agent_version: VERSION,
      nonce,
      proof: controlProof(controlSecret, deviceId, VERSION, nonce),
    }, false);
    return;
  }

  if (message.type === "authenticated") {
    if (authenticated) return;
    authenticated = true;
    clearControlAuthTimer();
    sendFullState();
    return;
  }

  if (!authenticated) throw new Error("control message received before authentication");
  if (message.type === "command") {
    const requestId = controlRequestId(message.request_id);
    if (!message.payload || typeof message.payload !== "object" || Array.isArray(message.payload)) {
      throw new Error("command payload is invalid");
    }
    void handleCommand(message.payload, requestId);
    return;
  }
  if (message.type === "proxy_open") {
    openProxy(message);
    return;
  }
  if (message.type === "proxy_end") {
    endProxyInput(normalizeStreamId(message.stream_id));
    return;
  }
  if (message.type === "proxy_pause") {
    setProxyOutputPaused(normalizeStreamId(message.stream_id), true);
    return;
  }
  if (message.type === "proxy_resume") {
    setProxyOutputPaused(normalizeStreamId(message.stream_id), false);
    return;
  }
  if (message.type === "proxy_cancel") {
    closeProxyStream(normalizeStreamId(message.stream_id), false);
    return;
  }
  if (message.type === "proxy_error") {
    closeProxyStream(normalizeStreamId(message.stream_id), false);
    return;
  }
  if (message.type === "error") {
    console.error(`[belabox-agent] control server error: ${text(message.message || message.error, 200) || "unknown error"}`);
  }
}

function sendFullState() {
  const now = new Date().toISOString();
  sendControl("status", {
    device_id: deviceId,
    state: "online",
    agent_session_id: agentSessionId,
    at: now,
  });
  sendControl("version", { device_id: deviceId, version: VERSION, at: now });
  publishHeartbeat();
  publishTelemetry();
  if (relayHealthState) sendControl("relay_health", relayHealthState);
  void refreshProxyStatesAndPublish(true);
}

function sendControl(type, payload, extra = {}) {
  sendJson({ type, ...extra, payload }, true);
}

function sendJson(message, requireAuthentication = true) {
  if (!client || client.readyState !== 1 || (requireAuthentication && !authenticated)) return false;
  const socket = client;
  const raw = JSON.stringify(message);
  if (Buffer.byteLength(raw, "utf8") > CONTROL_MAX_MESSAGE_BYTES) {
    console.error(`[belabox-agent] ${message.type || "control"} message exceeds ${CONTROL_MAX_MESSAGE_BYTES} bytes`);
    return false;
  }
  if (socket.bufferedAmount > CONTROL_HIGH_WATER_BYTES * 2) {
    socket.terminate();
    return false;
  }
  socket.send(raw, (error) => {
    if (error && client === socket && socket.readyState === 1) socket.terminate();
  });
  return true;
}

function controlProof(secret, id, version, nonce) {
  return createHmac("sha256", secret)
    .update(`${CONTROL_PROTOCOL}\n${id}\n${version}\n${nonce}`)
    .digest("hex");
}

function controlNonce(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/_=-]{16,256}$/.test(value)) {
    throw new Error("control challenge nonce is invalid");
  }
  return value;
}

function controlRequestId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw new Error("control request id is invalid");
  }
  return value;
}

function publishHeartbeat() {
  sendControl("heartbeat", {
    device_id: deviceId,
    agent_session_id: agentSessionId,
    at: new Date().toISOString(),
    uptime_seconds: Math.round(os.uptime()),
    agent_version: VERSION,
  });
}

function publishTelemetry(ftpUpload = readFtpUploadStatus()) {
  if (ftpUpload) photoTelemetryWasActive = photoTransferIsActive(ftpUpload);
  sendControl("telemetry", collectTelemetry(ftpUpload));
}

function publishActivePhotoTelemetry() {
  const ftpUpload = readFtpUploadStatus();
  if (!ftpUpload) return;
  const publish = photoTelemetryNeedsPublish(ftpUpload, photoTelemetryWasActive);
  photoTelemetryWasActive = photoTransferIsActive(ftpUpload);
  if (publish) sendControl("telemetry", collectTelemetry(ftpUpload));
}

async function handleCommand(payload, requestId) {
  const startedAt = new Date().toISOString();
  let commandId = randomId();
  let commandName = "unknown";
  try {
    const command = verifyCommand(payload, publicKeyPem, usedNonces);
    commandId = command.command_id;
    commandName = command.command;
    const result = await runCommand(command);
    publishResponse(requestId, { command_id: commandId, status: "success", started_at: startedAt, result_summary: result });
  } catch (error) {
    publishResponse(requestId, {
      command_id: commandId,
      status: "rejected",
      started_at: startedAt,
      result_summary: `${commandName} rejected`,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runCommand(command) {
  switch (command.command) {
    case "agent_status":
      return `agent ${VERSION} online; uptime ${Math.round(os.uptime())}s`;
    case "telemetry_refresh":
      await refreshProxyStatesAndPublish(true);
      return "telemetry refreshed";
    case "photo_transfer_mode_set":
      writePhotoConfig({ transfer_mode: command.args.mode });
      publishTelemetry();
      return `photo transfer mode set to ${command.args.mode}`;
    case "photo_transport_config_set":
      writePhotoConfig({
        chunk_size_bytes: command.args.chunk_size_bytes,
        chunk_parallel_uploads: command.args.chunk_parallel_uploads,
        chunk_upload_kbps: command.args.chunk_upload_kbps,
        chunk_upload_url: command.args.chunk_upload_url,
      });
      publishTelemetry();
      return "photo transport config updated";
    case "photo_processing_config_set":
      writePhotoConfig({ image_processing: command.args });
      publishTelemetry();
      return "photo processing config saved";
    case "photo_module_status":
      publishTelemetry();
      return `photo module config ${JSON.stringify(readPhotoConfig())}`;
    case "photo_queue_reset": {
      const result = archivePhotoQueue();
      publishTelemetry();
      return `photo queue reset archived ${result.moved} file${result.moved === 1 ? "" : "s"}${result.preserved ? `; preserved ${result.preserved} active` : ""}`;
    }
    case "relay_catalog_sync":
      return await syncRelayCatalog(command.args);
    case "network_speed_test":
      return await runNetworkSpeedTest(command.args);
    case "agent_update":
      return "agent update accepted; update transport is still installer-managed";
    case "agent_restart":
      setTimeout(() => process.exit(0), 250).unref();
      return "agent restart scheduled";
    case "log_bundle_collect": {
      const summary = {
        hostname: os.hostname(),
        uptime_seconds: Math.round(os.uptime()),
        collected_at: new Date().toISOString(),
      };
      sendControl("log", { device_id: deviceId, at: summary.collected_at, message: JSON.stringify(summary) });
      return "log bundle metadata collected";
    }
    case "log_bundle_upload_stub":
      return "log bundle upload stub accepted; no upload target configured";
    default:
      throw new Error("command is not allowlisted");
  }
}

function publishResponse(requestId, { command_id, status, started_at, result_summary, error_message = null }) {
  sendControl("command_result", {
    command_id,
    device_id: deviceId,
    status,
    started_at,
    finished_at: new Date().toISOString(),
    result_summary,
    error_message,
  }, { request_id: requestId });
}

function verifyCommand(command, keyPem, nonceSet) {
  if (!command || typeof command !== "object" || Array.isArray(command)) throw new Error("command payload must be an object");
  const { signature, ...unsigned } = command;
  if (typeof signature !== "string" || !signature) throw new Error("missing command signature");
  if (command.device_id !== deviceId) throw new Error("device_id mismatch");
  if (!ALLOWED_COMMANDS.has(command.command)) throw new Error("command is not allowlisted");
  if (!isIsoFuture(command.expires_at)) throw new Error("command expired");
  if (typeof command.nonce !== "string" || nonceSet.has(command.nonce)) throw new Error("nonce already used");
  validateArgs(command.command, command.args);
  const ok = verifyBytes(null, Buffer.from(canonicalJson(unsigned)), createPublicKey(keyPem), Buffer.from(signature, "base64"));
  if (!ok) throw new Error("invalid command signature");
  nonceSet.add(command.nonce);
  if (nonceSet.size > 200) nonceSet.delete(nonceSet.values().next().value);
  return command;
}

function validateArgs(command, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("args must be an object");
  if (JSON.stringify(args).length > (command === "relay_catalog_sync" ? 65536 : 4096)) throw new Error("args too large");
  if (command === "relay_catalog_sync") validateRelayCatalog(args);
  if (command === "log_bundle_collect" && args.lines !== undefined && (!Number.isInteger(args.lines) || args.lines < 1 || args.lines > 500)) {
    throw new Error("log_bundle_collect lines must be 1-500");
  }
  if (command === "agent_update" && args.version !== undefined && (typeof args.version !== "string" || args.version.length > 100)) {
    throw new Error("agent_update version must be a short string");
  }
  if (command === "photo_transfer_mode_set" && !["direct_ftp", "chunked_https"].includes(args.mode)) {
    throw new Error("photo_transfer_mode_set mode must be direct_ftp or chunked_https");
  }
  if (command === "photo_transport_config_set" && args.chunk_size_bytes !== undefined) {
    if (!Number.isInteger(args.chunk_size_bytes) || args.chunk_size_bytes < 262144 || args.chunk_size_bytes > 67108864) {
      throw new Error("chunk_size_bytes must be 262144-67108864");
    }
  }
  if (command === "photo_transport_config_set" && args.chunk_parallel_uploads !== undefined) {
    if (!Number.isInteger(args.chunk_parallel_uploads) || args.chunk_parallel_uploads < 1 || args.chunk_parallel_uploads > 4) {
      throw new Error("chunk_parallel_uploads must be 1-4");
    }
  }
  if (command === "photo_transport_config_set" && args.chunk_upload_kbps !== undefined) {
    if (!Number.isInteger(args.chunk_upload_kbps) || args.chunk_upload_kbps < 0 || args.chunk_upload_kbps > 1000000) {
      throw new Error("chunk_upload_kbps must be 0-1000000");
    }
  }
  if (command === "photo_transport_config_set" && args.chunk_upload_url !== undefined) {
    if (typeof args.chunk_upload_url !== "string" || !/^https?:\/\/.{1,500}$/.test(args.chunk_upload_url)) {
      throw new Error("chunk_upload_url must be http(s)");
    }
  }
  if (command === "photo_processing_config_set") {
    validatePhotoProcessingArgs(args);
  }
  if (command === "network_speed_test") {
    if (!["http_upload", "interface_speed_test"].includes(args.mode)) throw new Error("network_speed_test mode is invalid");
    if (args.target !== undefined && !["internet", "frame"].includes(args.target)) {
      throw new Error("network_speed_test target must be internet or frame");
    }
    if (args.interface_name !== undefined && (typeof args.interface_name !== "string" || !/^(all|[A-Za-z0-9_.:-]{1,64})$/.test(args.interface_name))) {
      throw new Error("network_speed_test interface_name is invalid");
    }
    if (args.bytes !== undefined && (!Number.isInteger(args.bytes) || args.bytes < 65536 || args.bytes > 67108864)) {
      throw new Error("network_speed_test bytes must be 65536-67108864");
    }
    if (args.parallel !== undefined && (!Number.isInteger(args.parallel) || args.parallel < 1 || args.parallel > 8)) {
      throw new Error("network_speed_test parallel must be 1-8");
    }
  }
}

function validatePhotoProcessingArgs(args) {
  if (args.enabled !== undefined && typeof args.enabled !== "boolean") {
    throw new Error("photo processing enabled must be true or false");
  }
  integerArg(args, "long_edge_px", 0, 12000);
  integerArg(args, "jpeg_quality", 40, 100);
  numberArg(args, "max_output_mb", 0, 500);
}

function integerArg(args, key, minimum, maximum) {
  if (args[key] === undefined) return;
  if (!Number.isInteger(args[key]) || args[key] < minimum || args[key] > maximum) {
    throw new Error(`${key} must be ${minimum}-${maximum}`);
  }
}

function numberArg(args, key, minimum, maximum) {
  if (args[key] === undefined) return;
  if (typeof args[key] !== "number" || !Number.isFinite(args[key]) || args[key] < minimum || args[key] > maximum) {
    throw new Error(`${key} must be ${minimum}-${maximum}`);
  }
}

async function runNetworkSpeedTest(args) {
  if (diagnosticRunning) throw new Error("a network diagnostic is already running");
  diagnosticRunning = true;
  const bytesPerDirection = Number.isInteger(args.bytes) ? args.bytes : 8 * 1024 * 1024;
  const parallel = Number.isInteger(args.parallel) ? args.parallel : 1;
  const targetId = args.target || (args.mode === "http_upload" ? "frame" : "internet");
  const requestedInterface = text(args.interface_name, 64) || "all";
  const testId = randomId();
  const started = Date.now();
  diagnosticState = {
    type: "interface_speed_test",
    test_id: testId,
    state: "preparing",
    target: targetId,
    requested_interface: requestedInterface,
    bytes_per_direction: bytesPerDirection,
    bytes_total: 0,
    bytes_completed: 0,
    bytes_sent: 0,
    parallel,
    current_interface: null,
    current_phase: "route_check",
    results: [],
    started_at: new Date(started).toISOString(),
    updated_at: new Date(started).toISOString(),
  };
  publishTelemetry();
  try {
    const target = await resolveDiagnosticTarget(targetId);
    const lanes = await diagnosticLanes(target, requestedInterface);
    const bytesTotal = bytesPerDirection * 2 * lanes.length;
    const results = [];
    let bytesCompleted = 0;
    let lastPublish = 0;
    diagnosticState = {
      ...diagnosticState,
      state: "running",
      target_name: target.label,
      target_host: target.host,
      target_address: target.address,
      interface_count: lanes.length,
      bytes_total: bytesTotal,
      updated_at: new Date().toISOString(),
    };
    publishTelemetry();

    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
      const lane = lanes[laneIndex];
      const laneStartBytes = laneIndex * bytesPerDirection * 2;
      const result = {
        interface_name: lane.name,
        address: lane.address,
        route_via: lane.route_via || null,
        state: "running",
        latency_ms: null,
        download_mbps: null,
        upload_mbps: null,
        error: null,
      };
      const setPhase = (phase) => {
        diagnosticState = {
          ...diagnosticState,
          current_interface: lane.name,
          current_address: lane.address,
          current_phase: phase,
          results: results.concat(result),
          updated_at: new Date().toISOString(),
        };
        publishTelemetry();
      };
      const onProgress = (count) => {
        bytesCompleted = Math.min(bytesTotal, bytesCompleted + count);
        const now = Date.now();
        diagnosticState = {
          ...diagnosticState,
          bytes_completed: bytesCompleted,
          bytes_sent: bytesCompleted,
          updated_at: new Date(now).toISOString(),
        };
        if (now - lastPublish > 500) {
          lastPublish = now;
          publishTelemetry();
        }
      };

      try {
        setPhase("latency");
        result.latency_ms = await measureDiagnosticLatency(target, lane, testId);
        setPhase("download");
        const download = await runParallelDiagnostic(bytesPerDirection, parallel, (size, streamIndex) =>
          downloadDiagnosticBytes(target, lane, size, testId, streamIndex, onProgress));
        result.download_mbps = mbps(bytesPerDirection, download.elapsed_ms);
        setPhase("upload");
        const upload = await runParallelDiagnostic(bytesPerDirection, parallel, (size, streamIndex) =>
          uploadDiagnosticBytes(target, lane, size, testId, streamIndex, onProgress));
        result.upload_mbps = mbps(bytesPerDirection, upload.elapsed_ms);
        result.state = "complete";
      } catch (error) {
        result.state = "failed";
        result.error = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
      }

      bytesCompleted = Math.max(bytesCompleted, laneStartBytes + bytesPerDirection * 2);
      results.push(result);
      diagnosticState = {
        ...diagnosticState,
        bytes_completed: bytesCompleted,
        bytes_sent: bytesCompleted,
        results: results.slice(),
        updated_at: new Date().toISOString(),
      };
      publishTelemetry();
    }

    const succeeded = results.filter((result) => result.state === "complete").length;
    const elapsedMs = Math.max(1, Date.now() - started);
    diagnosticState = {
      ...diagnosticState,
      state: succeeded === results.length ? "complete" : succeeded > 0 ? "partial" : "failed",
      bytes_completed: bytesTotal,
      bytes_sent: bytesTotal,
      elapsed_ms: elapsedMs,
      current_interface: null,
      current_address: null,
      current_phase: "complete",
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    publishTelemetry();
    if (!succeeded) throw new Error(`No ${target.label} interface test succeeded`);
    return `${target.label} speed test completed on ${succeeded}/${results.length} interface${results.length === 1 ? "" : "s"}`;
  } catch (error) {
    diagnosticState = {
      ...diagnosticState,
      state: "failed",
      error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    publishTelemetry();
    throw error;
  } finally {
    diagnosticRunning = false;
  }
}

function diagnosticUploadUrl() {
  const explicit = process.env.BELABOX_DIAGNOSTIC_UPLOAD_URL || "";
  if (explicit) return explicit;
  const chunkUrl = process.env.BELABOX_CHUNK_UPLOAD_URL || "";
  if (!chunkUrl) return "";
  return chunkUrl.replace(/\/api\/transfers\/?$/, "/api/diagnostics/speed-test");
}

async function resolveDiagnosticTarget(targetId) {
  if (targetId === "internet") {
    const base = externalSpeedtestBaseUrl();
    const downloadUrl = new URL("/__down", base).toString();
    const uploadUrl = new URL("/__up", base).toString();
    const parsed = new URL(downloadUrl);
    const resolved = await lookupIpv4(parsed.hostname);
    return {
      id: "internet",
      label: "External Internet",
      host: parsed.hostname,
      address: resolved.address,
      download_url: downloadUrl,
      upload_url: uploadUrl,
      token: "",
    };
  }

  const frameUrl = diagnosticUploadUrl();
  const token = process.env.BELABOX_CHUNK_UPLOAD_TOKEN || "";
  if (!frameUrl || !token) throw new Error("FRAME diagnostic URL/token is not configured");
  const parsed = new URL(frameUrl);
  const resolved = await lookupIpv4(parsed.hostname);
  return {
    id: "frame",
    label: "FRAME endpoint",
    host: parsed.hostname,
    address: resolved.address,
    download_url: frameUrl,
    upload_url: frameUrl,
    token,
  };
}

function externalSpeedtestBaseUrl() {
  try {
    const parsed = new URL(process.env.BELABOX_EXTERNAL_SPEEDTEST_BASE_URL || EXTERNAL_SPEEDTEST_BASE_URL);
    if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("invalid protocol");
    return parsed.toString();
  } catch {
    return EXTERNAL_SPEEDTEST_BASE_URL;
  }
}

async function diagnosticLanes(target, requestedInterface) {
  const lanes = networkSummary()
    .filter((entry) => entry.family === "IPv4" && usableSourceAddress(entry.address))
    .map((entry) => egressLane(entry, target.address));
  const selected = selectDiagnosticLanes(lanes, requestedInterface);
  if (!selected.length) {
    throw new Error(requestedInterface === "all"
      ? `No interface has a valid route to ${target.label}`
      : `${requestedInterface} has no valid route to ${target.label}`);
  }
  return selected;
}

function selectDiagnosticLanes(lanes, requestedInterface) {
  return lanes.filter((lane) => lane.state === "healthy" && (requestedInterface === "all" || lane.name === requestedInterface));
}

async function measureDiagnosticLatency(target, lane, testId) {
  const parsed = diagnosticRequestUrl(target, "download", 0, testId, "latency-warmup");
  const Agent = parsed.protocol === "https:" ? https.Agent : http.Agent;
  const connectionAgent = new Agent({
    keepAlive: true,
    maxSockets: 1,
    localAddress: lane.address,
    lookup: diagnosticLookup(target),
  });
  const samples = [];
  try {
    await downloadDiagnosticBytes(target, lane, 0, testId, "latency-warmup", () => undefined, connectionAgent);
    for (let index = 0; index < 3; index += 1) {
      const started = Date.now();
      await downloadDiagnosticBytes(target, lane, 0, testId, `latency-${index}`, () => undefined, connectionAgent);
      samples.push(Math.max(1, Date.now() - started));
    }
  } finally {
    connectionAgent.destroy();
  }
  return median(samples);
}

async function runParallelDiagnostic(totalBytes, parallel, worker) {
  const sizes = splitBytes(totalBytes, parallel);
  const started = Date.now();
  await Promise.all(sizes.map((size, index) => worker(size, index)));
  return { elapsed_ms: Math.max(1, Date.now() - started) };
}

function splitBytes(total, parts) {
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_, index) => index === parts - 1 ? total - base * (parts - 1) : base);
}

function downloadDiagnosticBytes(target, lane, byteCount, testId, streamIndex, onProgress, connectionAgent = null) {
  const parsed = diagnosticRequestUrl(target, "download", byteCount, testId, streamIndex);
  const transport = parsed.protocol === "https:" ? https : http;
  const headers = diagnosticRequestHeaders(target, testId, streamIndex, 0);
  return new Promise((resolve, reject) => {
    const request = transport.request(parsed, diagnosticRequestOptions(target, lane, "GET", headers, connectionAgent), (response) => {
      let received = 0;
      response.on("data", (chunk) => {
        received += chunk.length;
        onProgress(chunk.length);
      });
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`diagnostic download HTTP ${response.statusCode || 0}`));
          return;
        }
        if (byteCount > 0 && received !== byteCount) {
          reject(new Error(`diagnostic download expected ${byteCount} bytes, received ${received}`));
          return;
        }
        resolve(received);
      });
    });
    request.on("timeout", () => request.destroy(new Error(`diagnostic download timed out on ${lane.name}`)));
    request.on("error", reject);
    request.end();
  });
}

function uploadDiagnosticBytes(target, lane, byteCount, testId, streamIndex, onProgress) {
  const parsed = diagnosticRequestUrl(target, "upload", byteCount, testId, streamIndex);
  const transport = parsed.protocol === "https:" ? https : http;
  const headers = diagnosticRequestHeaders(target, testId, streamIndex, byteCount);
  return new Promise((resolve, reject) => {
    const request = transport.request(parsed, diagnosticRequestOptions(target, lane, "POST", headers), (response) => {
      response.resume();
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve(byteCount);
        else reject(new Error(`diagnostic upload HTTP ${response.statusCode || 0}`));
      });
    });
    request.on("timeout", () => request.destroy(new Error(`diagnostic upload timed out on ${lane.name}`)));
    request.on("error", reject);
    writeRandomBody(request, byteCount, onProgress);
  });
}

function diagnosticRequestUrl(target, direction, byteCount, testId, streamIndex) {
  const parsed = new URL(direction === "download" ? target.download_url : target.upload_url);
  parsed.searchParams.set("measId", testId);
  parsed.searchParams.set("stream", String(streamIndex));
  if (direction === "download") parsed.searchParams.set("bytes", String(byteCount));
  return parsed;
}

function diagnosticRequestHeaders(target, testId, streamIndex, byteCount) {
  const headers = {
    "content-type": "application/octet-stream",
    "user-agent": `FRAME-Belabox-Agent/${VERSION}`,
  };
  if (byteCount > 0) headers["content-length"] = String(byteCount);
  if (target.id === "frame") {
    headers.authorization = `Bearer ${target.token}`;
    headers["x-belabox-device-id"] = deviceId;
    headers["x-belabox-test-id"] = testId;
    headers["x-belabox-stream"] = String(streamIndex);
  }
  return headers;
}

function diagnosticRequestOptions(target, lane, method, headers, connectionAgent = null) {
  return {
    method,
    headers,
    localAddress: lane.address,
    agent: connectionAgent || false,
    timeout: DIAGNOSTIC_REQUEST_TIMEOUT_MS,
    lookup: diagnosticLookup(target),
  };
}

function diagnosticLookup(target) {
  return (_hostname, options, callback) => {
    if (options && options.all) callback(null, [{ address: target.address, family: 4 }]);
    else callback(null, target.address, 4);
  };
}

function writeRandomBody(request, byteCount, onProgress) {
  let sent = 0;
  const payload = randomBytes(Math.min(64 * 1024, Math.max(1, byteCount)));
  const writeMore = () => {
    while (sent < byteCount) {
      const size = Math.min(payload.length, byteCount - sent);
      sent += size;
      onProgress(size);
      if (!request.write(size === payload.length ? payload : payload.subarray(0, size))) {
        request.once("drain", writeMore);
        return;
      }
    }
    request.end();
  };
  writeMore();
}

function median(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round(((sorted[middle - 1] + sorted[middle]) / 2) * 10) / 10;
}

function mbps(bytes, elapsedMs) {
  return Math.round(((bytes * 8 * 1000) / Math.max(1, elapsedMs) / 1000000) * 10) / 10;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB`;
  return `${Math.round((bytes / 1024) * 10) / 10} KiB`;
}

function openProxy(message) {
  const streamId = normalizeStreamId(message.stream_id);
  if (proxyStreams.has(streamId)) {
    sendProxyError(streamId, "proxy stream already exists");
    return;
  }
  if (proxyStreams.size >= PROXY_MAX_STREAMS) {
    sendProxyError(streamId, "proxy stream limit reached");
    return;
  }
  try {
    if (message.kind === "http") {
      openHttpProxy(streamId, message);
      return;
    }
    if (message.kind === "websocket") {
      openWebSocketProxy(streamId, message);
      return;
    }
    throw new Error("proxy kind is invalid");
  } catch (error) {
    sendProxyError(streamId, error instanceof Error ? error.message : String(error));
  }
}

function openHttpProxy(streamId, message) {
  const proxy = proxyTarget(message);
  const target = localProxyUrl(proxy.localUrl, text(message.path, 2000) || "/");
  const headers = proxyHeaders(message.headers, target, proxy);
  const contentLength = proxyContentLength(message.headers);
  if (contentLength !== null) headers["content-length"] = contentLength;
  const transport = target.protocol === "https:" ? https : http;
  const stream = {
    id: streamId,
    kind: "http",
    destination: null,
    source: null,
    ready: true,
    pendingInput: [],
    pendingInputBytes: 0,
    pendingEnd: false,
    inputBlocked: false,
    inputDrainWaiting: false,
    inputPauseSent: false,
    remoteOutputPaused: false,
    controlOutputPaused: false,
    idleTimer: null,
    connectTimer: null,
    drainTimer: null,
  };
  const request = transport.request(target, {
    method: proxyMethod(message.method),
    headers,
  }, (response) => {
    if (proxyStreams.get(streamId) !== stream) {
      response.destroy();
      return;
    }
    stream.source = response;
    if (stream.remoteOutputPaused || stream.controlOutputPaused) response.pause();
    touchProxyStream(stream);
    sendJson({
      type: "proxy_response",
      stream_id: streamId,
      status: response.statusCode || 502,
      headers: responseHeaders(response.headers, proxy),
    });
    response.on("data", (chunk) => {
      touchProxyStream(stream);
      sendProxyBinary(stream, Buffer.from(chunk), response);
    });
    response.on("end", () => finishProxyStream(stream, true));
    response.on("aborted", () => failProxyStream(stream, "local proxy response aborted"));
    response.on("error", (error) => failProxyStream(stream, error.message));
  });
  stream.destination = request;
  proxyStreams.set(streamId, stream);
  touchProxyStream(stream);
  request.on("error", (error) => failProxyStream(stream, error.message));
}

function openWebSocketProxy(streamId, message) {
  const destination = proxyStreamDestination(message);
  const proxy = destination.proxy;
  const target = destination.target;
  const method = proxyMethod(message.method);
  const httpVersion = proxyHttpVersion(message.http_version);
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const socket = target.protocol === "https:"
    ? tls.connect({ host: target.hostname, port, servername: target.hostname })
    : net.connect(port, target.hostname);
  const stream = {
    id: streamId,
    kind: "websocket",
    destination: socket,
    source: socket,
    ready: false,
    pendingInput: [],
    pendingInputBytes: 0,
    pendingEnd: false,
    inputBlocked: false,
    inputDrainWaiting: false,
    inputPauseSent: false,
    remoteOutputPaused: false,
    controlOutputPaused: false,
    idleTimer: null,
    connectTimer: null,
    drainTimer: null,
  };
  proxyStreams.set(streamId, stream);
  stream.connectTimer = setTimeout(() => failProxyStream(stream, "local proxy connection timed out"), PROXY_IDLE_TIMEOUT_MS);
  if (typeof stream.connectTimer.unref === "function") stream.connectTimer.unref();
  socket.once(target.protocol === "https:" ? "secureConnect" : "connect", () => {
    if (proxyStreams.get(streamId) !== stream) return;
    if (stream.connectTimer) clearTimeout(stream.connectTimer);
    stream.connectTimer = null;
    const headers = proxyHeaders(message.headers, target, proxy);
    headers.connection = "Upgrade";
    let requestHead = `${method} ${target.pathname}${target.search} HTTP/${httpVersion}\r\n`;
    for (const [name, value] of Object.entries(headers)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) requestHead += `${name}: ${item}\r\n`;
    }
    socket.write(`${requestHead}\r\n`);
    stream.ready = true;
    flushPendingProxyInput(stream);
  });
  socket.on("data", (chunk) => {
    sendProxyBinary(stream, Buffer.from(chunk), socket);
  });
  socket.on("end", () => finishProxyStream(stream, true));
  socket.on("close", () => finishProxyStream(stream, true));
  socket.on("error", (error) => failProxyStream(stream, error.message));
}

function handleControlBinary(frame) {
  if (!authenticated) throw new Error("binary control data received before authentication");
  if (frame.length < PROXY_BINARY_HEADER_BYTES || frame.length > CONTROL_MAX_MESSAGE_BYTES || frame[0] !== 1) {
    throw new Error("proxy binary frame is invalid");
  }
  const streamId = streamIdFromBytes(frame.subarray(1, PROXY_BINARY_HEADER_BYTES));
  const stream = proxyStreams.get(streamId);
  if (!stream || !stream.destination || stream.destination.destroyed || stream.destination.writableEnded) return;
  touchProxyStream(stream);
  const data = frame.subarray(PROXY_BINARY_HEADER_BYTES);
  if (!data.length) return;
  if (!stream.ready || stream.inputBlocked) {
    queuePendingProxyInput(stream, data);
    return;
  }
  if (!stream.destination.write(data)) pauseProxyInput(stream);
}

function endProxyInput(streamId) {
  const stream = proxyStreams.get(streamId);
  if (!stream || !stream.destination || stream.destination.destroyed || stream.destination.writableEnded) return;
  touchProxyStream(stream);
  if (!stream.ready || stream.inputBlocked || stream.pendingInput.length) {
    stream.pendingEnd = true;
    return;
  }
  stream.destination.end();
}

function flushPendingProxyInput(stream) {
  if (!stream.ready || stream.inputBlocked) return;
  while (stream.pendingInput.length) {
    const data = stream.pendingInput.shift();
    stream.pendingInputBytes -= data.length;
    if (!stream.destination.write(data)) {
      pauseProxyInput(stream);
      return;
    }
  }
  stream.pendingInputBytes = 0;
  resumeProxyInput(stream);
  if (stream.pendingEnd && !stream.destination.writableEnded) stream.destination.end();
}

function queuePendingProxyInput(stream, data) {
  stream.pendingInputBytes += data.length;
  if (stream.pendingInputBytes > PROXY_MAX_PENDING_INPUT_BYTES) {
    failProxyStream(stream, "proxy client sent too much data while the local service was backpressured");
    return;
  }
  stream.pendingInput.push(Buffer.from(data));
  sendProxyInputPause(stream);
}

function pauseProxyInput(stream) {
  stream.inputBlocked = true;
  sendProxyInputPause(stream);
  if (stream.inputDrainWaiting) return;
  stream.inputDrainWaiting = true;
  stream.destination.once("drain", () => {
    stream.inputDrainWaiting = false;
    if (proxyStreams.get(stream.id) !== stream) return;
    stream.inputBlocked = false;
    flushPendingProxyInput(stream);
  });
}

function sendProxyInputPause(stream) {
  if (stream.inputPauseSent) return;
  stream.inputPauseSent = true;
  sendJson({ type: "proxy_pause", stream_id: stream.id });
}

function resumeProxyInput(stream) {
  if (!stream.inputPauseSent || stream.inputBlocked || !stream.ready || stream.pendingInput.length) return;
  stream.inputPauseSent = false;
  sendJson({ type: "proxy_resume", stream_id: stream.id });
}

function sendProxyBinary(stream, data, source) {
  if (!client || client.readyState !== 1 || !authenticated) {
    closeProxyStream(stream.id, false);
    return;
  }
  const socket = client;
  for (let offset = 0; offset < data.length; offset += PROXY_BINARY_CHUNK_BYTES) {
    const chunk = data.subarray(offset, offset + PROXY_BINARY_CHUNK_BYTES);
    const frame = Buffer.allocUnsafe(PROXY_BINARY_HEADER_BYTES + chunk.length);
    frame[0] = 1;
    streamIdBytes(stream.id).copy(frame, 1);
    chunk.copy(frame, PROXY_BINARY_HEADER_BYTES);
    socket.send(frame, { binary: true }, (error) => {
      if (error && client === socket && socket.readyState === 1) socket.terminate();
    });
  }
  if (socket.bufferedAmount > CONTROL_HIGH_WATER_BYTES && source && typeof source.pause === "function") {
    stream.controlOutputPaused = true;
    source.pause();
    waitForControlDrain(stream);
  }
}

function waitForControlDrain(stream) {
  if (stream.drainTimer) return;
  const check = () => {
    stream.drainTimer = null;
    if (proxyStreams.get(stream.id) !== stream || !client || client.readyState !== 1) return;
    if (client.bufferedAmount <= CONTROL_LOW_WATER_BYTES) {
      stream.controlOutputPaused = false;
      resumeProxySource(stream);
      return;
    }
    stream.drainTimer = setTimeout(check, 10);
    if (typeof stream.drainTimer.unref === "function") stream.drainTimer.unref();
  };
  stream.drainTimer = setTimeout(check, 10);
  if (typeof stream.drainTimer.unref === "function") stream.drainTimer.unref();
}

function setProxyOutputPaused(streamId, paused) {
  const stream = proxyStreams.get(streamId);
  if (!stream) return;
  stream.remoteOutputPaused = paused;
  if (paused) {
    if (stream.source && typeof stream.source.pause === "function") stream.source.pause();
    return;
  }
  resumeProxySource(stream);
}

function resumeProxySource(stream) {
  if (
    stream.remoteOutputPaused
    || stream.controlOutputPaused
    || !stream.source
    || typeof stream.source.resume !== "function"
  ) return;
  stream.source.resume();
}

function touchProxyStream(stream) {
  if (stream.kind === "websocket") return;
  if (stream.idleTimer) clearTimeout(stream.idleTimer);
  stream.idleTimer = setTimeout(() => failProxyStream(stream, "local proxy stream timed out"), PROXY_IDLE_TIMEOUT_MS);
  if (typeof stream.idleTimer.unref === "function") stream.idleTimer.unref();
}

function finishProxyStream(stream, notify) {
  const incompleteHttpRequest = stream.kind === "http"
    && stream.destination
    && stream.destination.writableEnded !== true;
  if (!removeProxyStream(stream, stream.kind === "websocket" || incompleteHttpRequest)) return;
  if (notify) sendJson({ type: "proxy_end", stream_id: stream.id });
}

function failProxyStream(stream, error) {
  if (!removeProxyStream(stream, true)) return;
  sendProxyError(stream.id, error);
}

function sendProxyError(streamId, error) {
  sendJson({
    type: "proxy_error",
    stream_id: streamId,
    error: text(error, 200) || "local proxy failed",
  });
}

function closeProxyStream(streamId, notify) {
  const stream = proxyStreams.get(streamId);
  if (!stream || !removeProxyStream(stream, true)) return;
  if (notify) sendJson({ type: "proxy_end", stream_id: streamId });
}

function closeAllProxyStreams() {
  for (const stream of Array.from(proxyStreams.values())) removeProxyStream(stream, true);
}

function removeProxyStream(stream, destroy) {
  if (proxyStreams.get(stream.id) !== stream) return false;
  proxyStreams.delete(stream.id);
  if (stream.idleTimer) clearTimeout(stream.idleTimer);
  if (stream.connectTimer) clearTimeout(stream.connectTimer);
  if (stream.drainTimer) clearTimeout(stream.drainTimer);
  if (destroy) {
    if (stream.destination && typeof stream.destination.destroy === "function") stream.destination.destroy();
    if (stream.source && stream.source !== stream.destination && typeof stream.source.destroy === "function") stream.source.destroy();
  }
  return true;
}

function proxyContentLength(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = Object.entries(value).find(([name]) => name.toLowerCase() === "content-length");
  if (!entry) return null;
  const raw = Array.isArray(entry[1]) ? entry[1][0] : entry[1];
  const parsed = typeof raw === "string" ? raw.trim() : "";
  return /^\d{1,20}$/.test(parsed) ? parsed : null;
}

function proxyTarget(message) {
  const requested = message.target === undefined ? "belaui" : text(message.target, 32);
  if (requested === "belaui") {
    if (!remoteBelaui.enabled) throw new Error("remote belaUI is disabled");
    return { id: "belaui", label: "remote belaUI", localUrl: remoteBelaui.localUrl };
  }
  if (requested === "video_mixer") {
    return { id: "video_mixer", label: "video mixer", localUrl: VIDEO_MIXER_LOCAL_URL };
  }
  throw new Error("proxy target is not allowed");
}

function proxyStreamDestination(message) {
  const proxy = proxyTarget(message);
  const requestPath = text(message.path, 2000) || "/";
  if (proxy.id === "video_mixer") {
    const rawPath = requestPath.split("?", 1)[0];
    const sourceHeaders = message.headers && typeof message.headers === "object" && !Array.isArray(message.headers)
      ? message.headers
      : {};
    const upgradeEntry = Object.entries(sourceHeaders)
      .find(([name]) => name.toLowerCase() === "upgrade");
    const upgrade = upgradeEntry ? upgradeEntry[1] : "";
    if (
      rawPath !== "/wsenc"
      || proxyMethod(message.method) !== "GET"
      || String(Array.isArray(upgrade) ? upgrade[0] : upgrade || "").toLowerCase() !== "websocket"
    ) {
      throw new Error("video mixer websocket request is not allowed");
    }
    const belaui = proxyTarget({ target: "belaui" });
    return { proxy: belaui, target: localProxyUrl(belaui.localUrl, "/") };
  }
  return { proxy, target: localProxyUrl(proxy.localUrl, requestPath) };
}

function localProxyUrl(localUrl, requestPath) {
  const target = new URL(localUrl);
  const incoming = new URL(requestPath || "/", "http://frame.local");
  const base = target.pathname.replace(/\/+$/, "");
  target.pathname = `${base}${incoming.pathname}`.replace(/\/{2,}/g, "/");
  target.search = incoming.search;
  target.hash = "";
  return target;
}

function proxyHeaders(value, target, proxy) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const headers = {};
  for (const [name, item] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (["cookie", "cookie2"].includes(lower) && proxy.id !== "video_mixer") continue;
    if (PROXY_REQUEST_HEADER_BLOCKLIST.has(lower)) continue;
    const next = typeof item === "string"
      ? item.slice(0, 4096)
      : Array.isArray(item) && item.every((entry) => typeof entry === "string")
        ? item.map((entry) => entry.slice(0, 4096)).slice(0, 16)
        : null;
    if (next === null) continue;
    const entries = Array.isArray(next) ? next : [next];
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(lower)) continue;
    if (entries.some((entry) => !/^[\t\x20-\x7e\x80-\xff]*$/.test(entry))) continue;
    headers[lower] = next;
  }
  headers.host = target.host;
  headers["accept-encoding"] = "identity";
  if (headers.origin) headers.origin = target.origin;
  return headers;
}

function responseHeaders(headers, proxy) {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    const lower = name.toLowerCase();
    if (value === undefined || lower === "set-cookie2" || (proxy.id !== "video_mixer" && PROXY_RESPONSE_HEADER_BLOCKLIST.has(lower))) return [];
    if (Array.isArray(value)) return [[name, value.map(String)]];
    return [[name, String(value)]];
  }));
}

function proxyMethod(value) {
  const method = text(value, 16) || "GET";
  if (!/^[A-Za-z]+$/.test(method)) throw new Error("proxy method is invalid");
  return method.toUpperCase();
}

function proxyHttpVersion(value) {
  const version = text(value, 16) || "1.1";
  if (!["1.0", "1.1"].includes(version)) throw new Error("proxy HTTP version is invalid");
  return version;
}

function collectTelemetry(ftpUpload = readFtpUploadStatus()) {
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const disk = diskUsage("/");
  const telemetry = {
    device_id: deviceId,
    agent_session_id: agentSessionId,
    at: new Date().toISOString(),
    hostname: os.hostname(),
    uptime_seconds: Math.round(os.uptime()),
    cpu_load: os.loadavg(),
    memory: {
      total_bytes: memoryTotal,
      free_bytes: memoryFree,
      used_percent: memoryTotal > 0 ? Math.round(((memoryTotal - memoryFree) / memoryTotal) * 1000) / 10 : null,
    },
    disk,
    temperature_c: readTemperature(),
    active_streaming_services: processRunning("belacoder") ? ["belacoder"] : [],
    network_interfaces: networkSummary(),
    egress: egressState,
    agent_version: VERSION,
    remote_belaui: remoteBelauiState,
    video_mixer: videoMixerState,
    relay_catalog: relayCatalogState,
  };
  if (ftpUpload) telemetry.ftp_upload = ftpUpload;
  if (diagnosticState) telemetry.network_diagnostics = diagnosticState;
  return telemetry;
}

async function syncRelayCatalog(value) {
  const catalog = validateRelayCatalog(value);
  if (relayCatalogState.revision === catalog.revision && relayCatalogState.state === "cached") {
    return `relay catalog ${catalog.revision.slice(0, 12)} already cached`;
  }
  writeAtomicJson(relayCatalogPath, catalog);
  relayCatalogState = relayCatalogSnapshot("cached", catalog);
  publishTelemetry();
  void refreshRelayHealth();
  return `relay catalog ${catalog.revision.slice(0, 12)} cached`;
}

async function refreshRelayHealth() {
  if (relayHealthRunning) return;
  relayHealthRunning = true;
  try {
    const catalog = validateRelayCatalog(JSON.parse(fs.readFileSync(relayCatalogPath, "utf8")));
    const [serverId, server] = Object.entries(catalog.servers)[0] || [];
    if (!serverId || !server) throw new Error("relay catalog is empty");
    const probeHost = relayProbeHost || egressTargetHost();
    const target = await lookupIpv4(probeHost);
    const lanes = networkSummary()
      .filter((entry) => entry.family === "IPv4" && usableSourceAddress(entry.address))
      .map((entry) => egressLane(entry, target.address))
      .filter((lane) => lane.state === "healthy");
    const results = await Promise.all(lanes.map(async (lane) => ({
      interface_name: lane.name,
      address: lane.address,
      ...await tcpRelayProbe(target.address, relayProbePort, lane.address),
    })));
    relayHealthState = summarizeRelayHealth(serverId, server, results, probeHost);
    sendControl("relay_health", relayHealthState);
  } catch (error) {
    relayHealthState = {
      state: "error",
      rtt_ms: null,
      reachable_lane_count: 0,
      lane_count: 0,
      error: text(error && error.message, 160) || "relay probe failed",
      updated_at: new Date().toISOString(),
    };
    sendControl("relay_health", relayHealthState);
  } finally {
    relayHealthRunning = false;
  }
}

function tcpRelayProbe(targetAddress, port, sourceAddress) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: targetAddress, port, family: 4, localAddress: sourceAddress });
    let settled = false;
    const finish = (reachable, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, rtt_ms: reachable ? Math.max(1, Date.now() - started) : null, error });
    };
    socket.setTimeout(relayProbeTimeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false, "timeout"));
    socket.once("error", (error) => finish(false, text(error.code || error.message, 80) || "unreachable"));
  });
}

function summarizeRelayHealth(serverId, server, lanes, probeHost = server.addr) {
  const reachable = lanes.filter((lane) => lane.reachable && Number.isFinite(lane.rtt_ms));
  const rtt = reachable.length ? Math.min(...reachable.map((lane) => lane.rtt_ms)) : null;
  return {
    state: reachable.length === lanes.length && lanes.length ? "online" : reachable.length ? "degraded" : "offline",
    server_id: serverId,
    host: server.addr,
    port: server.port,
    probe_host: probeHost,
    probe_port: relayProbePort,
    rtt_ms: rtt,
    reachable_lane_count: reachable.length,
    lane_count: lanes.length,
    lanes,
    updated_at: new Date().toISOString(),
  };
}

function initialRelayCatalogState() {
  try {
    const catalog = validateRelayCatalog(JSON.parse(fs.readFileSync(relayCatalogPath, "utf8")));
    return relayCatalogSnapshot("cached", catalog);
  } catch {
    return { state: "empty", revision: null, accounts: 0, reason: null, error: null, updated_at: new Date().toISOString() };
  }
}

function relayCatalogSnapshot(state, catalog, reason = null) {
  return {
    state,
    revision: catalog.revision,
    accounts: Object.keys(catalog.accounts).length,
    reason,
    error: null,
    updated_at: new Date().toISOString(),
  };
}

function validateRelayCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)) {
    throw new Error("relay catalog version or revision is invalid");
  }
  const servers = value.servers;
  const accounts = value.accounts;
  if (!servers || typeof servers !== "object" || Array.isArray(servers) || Object.keys(servers).length < 1 || Object.keys(servers).length > 20) {
    throw new Error("relay catalog server count is invalid");
  }
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts) || Object.keys(accounts).length > 500) {
    throw new Error("relay catalog account count is invalid");
  }
  for (const [id, server] of Object.entries(servers)) {
    if (!/^frame-[a-z0-9-]{1,64}$/.test(id) || !server || server.type !== "srtla" || typeof server.name !== "string" || !server.name.trim() || server.name.length > 120 || typeof server.addr !== "string" || !validRelayAddress(server.addr) || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
      throw new Error("relay catalog contains an invalid server");
    }
  }
  for (const [id, account] of Object.entries(accounts)) {
    if (!/^frame-[a-z0-9-]{1,64}$/.test(id) || !account || typeof account.name !== "string" || !account.name.trim() || account.name.length > 120 || typeof account.ingest_key !== "string" || !account.ingest_key || account.ingest_key.length > 500) {
      throw new Error("relay catalog contains an invalid account");
    }
  }
  return { version: 1, revision: value.revision, servers, accounts };
}

function validRelayAddress(value) {
  return value.length <= 253 && !value.includes("://") && !/[\s/:]/.test(value);
}

function processRunning(name) {
  try {
    return fs.readdirSync("/proc", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .some((entry) => {
        try { return fs.readFileSync(`/proc/${entry.name}/comm`, "utf8").trim() === name; } catch { return false; }
      });
  } catch {
    return false;
  }
}

function writeAtomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function refreshRemoteBelauiState() {
  if (!remoteBelaui.enabled) {
    remoteBelauiState = remoteBelauiSnapshot("disabled");
    return;
  }
  const probe = await probeLocalHttp(remoteBelaui.localUrl);
  remoteBelauiState = { ...remoteBelauiSnapshot(probe.state), ...probe };
}

async function refreshVideoMixerState() {
  const installed = videoMixerInstalled();
  if (!installed) {
    videoMixerState = videoMixerSnapshot("unreachable", false);
    return;
  }
  const probe = await probeLocalHttp(VIDEO_MIXER_LOCAL_URL);
  videoMixerState = { ...videoMixerSnapshot(probe.state, true), ...probe };
}

function refreshProxyStatesAndPublish(force = false) {
  if (proxyStateRefreshPromise) return proxyStateRefreshPromise;
  const previous = proxyStateSignature();
  proxyStateRefreshPromise = Promise.all([refreshRemoteBelauiState(), refreshVideoMixerState()])
    .then(() => {
      if (force || proxyStateSignature() !== previous) publishTelemetry();
    })
    .finally(() => {
      proxyStateRefreshPromise = null;
    });
  return proxyStateRefreshPromise;
}

function proxyStateSignature() {
  return JSON.stringify([
    remoteBelauiState.enabled,
    remoteBelauiState.state,
    remoteBelauiState.http_status || 0,
    remoteBelauiState.error || "",
    videoMixerState.installed === true,
    videoMixerState.state,
    videoMixerState.http_status || 0,
    videoMixerState.error || "",
  ]);
}

function probeLocalHttp(localUrl) {
  const parsed = new URL(localUrl);
  const transport = parsed.protocol === "https:" ? https : http;
  return new Promise((resolve) => {
    const request = transport.request(parsed, {
      method: "GET",
      timeout: 1500,
      headers: { "user-agent": `FRAME-Belabox-Agent/${VERSION}` },
    }, (response) => {
      response.resume();
      resolve({
        state: response.statusCode && response.statusCode < 500 ? "reachable" : "error",
        http_status: response.statusCode || 0,
      });
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) => resolve({ state: "unreachable", error: text(error.message, 120) }));
    request.end();
  });
}

function remoteBelauiSnapshot(state) {
  return {
    enabled: remoteBelaui.enabled,
    state,
    local_url: remoteBelaui.localUrl,
    rewrite_websocket: remoteBelaui.rewriteWebSocket,
    transport: "agent-wss-proxy",
    checked_at: new Date().toISOString(),
  };
}

function videoMixerSnapshot(state, installed) {
  return {
    enabled: installed,
    installed,
    target: "video_mixer",
    state,
    local_url: VIDEO_MIXER_LOCAL_URL,
    transport: "agent-wss-proxy",
    checked_at: new Date().toISOString(),
  };
}

function videoMixerInstalled() {
  const unit = "irlplus-video-mixer.service";
  for (const directory of ["/etc/systemd/system", "/lib/systemd/system", "/usr/lib/systemd/system"]) {
    if (fs.existsSync(path.join(directory, unit))) return true;
  }
  try {
    const output = execFileSync("systemctl", ["list-unit-files", unit, "--no-legend", "--no-pager"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.split(/\r?\n/).some((line) => line.trim().split(/\s+/, 1)[0] === unit);
  } catch {
    return false;
  }
}

function photoTransferIsActive(status) {
  return Boolean(status.file)
    || status.queue_count > 0
    || ["queued", "processing", "connecting", "preparing", "uploading", "assembling", "complete", "failed"].includes(status.state);
}

function photoTelemetryNeedsPublish(status, wasActive) {
  return Boolean(status) && (wasActive || photoTransferIsActive(status));
}

function diskUsage(target) {
  if (typeof fs.statfsSync !== "function") return null;
  try {
    const stats = fs.statfsSync(target);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    return {
      mount: target,
      total_bytes: total,
      free_bytes: free,
      used_percent: total > 0 ? Math.round(((total - free) / total) * 1000) / 10 : null,
    };
  } catch {
    return null;
  }
}

function readTemperature() {
  try {
    const zones = fs.readdirSync("/sys/class/thermal").filter((name) => name.startsWith("thermal_zone"));
    for (const zone of zones) {
      const raw = fs.readFileSync(`/sys/class/thermal/${zone}/temp`, "utf8").trim();
      const value = Number.parseInt(raw, 10);
      if (Number.isFinite(value)) return Math.round((value / 1000) * 10) / 10;
    }
  } catch {
    return null;
  }
  return null;
}

function networkSummary() {
  return Object.entries(os.networkInterfaces()).flatMap(([name, entries]) =>
    (entries || [])
      .filter((entry) => !entry.internal)
      .map((entry) => ({
        name,
        family: entry.family,
        address: entry.address,
        mac: entry.mac === "00:00:00:00:00:00" ? null : entry.mac,
      })),
  );
}

async function refreshEgressState() {
  if (egressRefreshRunning) return;
  egressRefreshRunning = true;
  try {
    const target = await egressTargetAddress();
    const lanes = networkSummary()
      .filter((entry) => entry.family === "IPv4" && usableSourceAddress(entry.address))
      .map((entry) => egressLane(entry, target.address));
    egressState = egressSnapshot(lanes, target);
    writeJsonFile(egressStatusPath, egressState);
  } catch (error) {
    egressState = { ...egressSnapshot([]), state: "error", error: text(error.message, 160) };
    writeJsonFile(egressStatusPath, egressState);
  } finally {
    egressRefreshRunning = false;
  }
}

async function egressTargetAddress() {
  const host = egressTargetHost();
  const resolved = await lookupIpv4(host);
  return { host, address: resolved.address };
}

function lookupIpv4(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { family: 4 }, (error, address) => {
      if (error) reject(error);
      else resolve({ address });
    });
  });
}

function egressTargetHost() {
  for (const value of [process.env.BELABOX_CHUNK_UPLOAD_URL, process.env.BELABOX_CONTROL_URL, controlUrl]) {
    try {
      const parsed = new URL(value || "");
      if (parsed.hostname) return parsed.hostname;
    } catch {
      // keep looking
    }
  }
  return "127.0.0.1";
}

function usableSourceAddress(address) {
  return Boolean(address) && !address.startsWith("127.") && !address.startsWith("169.254.");
}

function egressLane(entry, targetAddress) {
  const route = routeForSource(targetAddress, entry.address);
  const healthy = route.ok && (!route.dev || route.dev === entry.name) && (!route.src || route.src === entry.address);
  return {
    name: entry.name,
    family: entry.family,
    address: entry.address,
    mac: entry.mac,
    state: healthy ? "healthy" : route.ok ? "routed_elsewhere" : "unreachable",
    route_dev: route.dev || null,
    route_src: route.src || null,
    route_via: route.via || null,
    route_error: route.error || null,
  };
}

function routeForSource(targetAddress, sourceAddress) {
  try {
    const output = execFileSync("ip", ["route", "get", targetAddress, "from", sourceAddress], {
      encoding: "utf8",
      timeout: 500,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return {
      ok: true,
      dev: firstMatch(output, /\bdev\s+(\S+)/),
      src: firstMatch(output, /\bsrc\s+(\S+)/),
      via: firstMatch(output, /\bvia\s+(\S+)/),
      raw: output.slice(0, 240),
    };
  } catch (error) {
    const stderr = error && error.stderr && typeof error.stderr.toString === "function" ? error.stderr.toString() : "";
    return { ok: false, error: text(stderr || error.message, 160) };
  }
}

function egressSnapshot(lanes, target = null) {
  const healthy = lanes.filter((lane) => lane.state === "healthy");
  return {
    enabled: true,
    state: healthy.length > 0 ? "ready" : "no_healthy_lanes",
    target_host: target && target.host ? target.host : egressTargetHost(),
    target_address: target && target.address ? target.address : null,
    updated_at: new Date().toISOString(),
    lane_count: lanes.length,
    healthy_lane_count: healthy.length,
    lanes,
  };
}

function readFtpUploadStatus() {
  const statusPath = process.env.BELABOX_PHOTO_AGENT_STATUS_PATH
    || process.env.BELABOX_FTP_CONNECTOR_STATUS_PATH
    || `${os.homedir()}/.frame-belabox-agent/photo-agent/status.json`;
  try {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    if (!status || typeof status !== "object" || Array.isArray(status)) return null;
    const photoConfig = readPhotoConfig();
    return {
      enabled: status.enabled === true,
      state: text(status.state, 32) || "unknown",
      status_text: text(status.status_text, 120) || "",
      file: text(status.file || status.filename, 180) || null,
      spool_file: text(status.spool_file, 240) || null,
      journey_id: safeJourneyId(status.journey_id),
      size_bytes: number(status.size_bytes),
      sent_bytes: number(status.sent_bytes),
      percent: number(status.percent),
      elapsed: number(status.elapsed),
      rate_bps: number(status.rate_bps),
      done: status.done === true,
      queue_count: number(status.queue_count),
      processed_count: number(status.processed_count),
      transfer_id: text(status.transfer_id, 120) || null,
      transfer_mode: text(status.transfer_mode, 40) || text(photoConfig.transfer_mode, 40) || null,
      transport: text(status.transport, 40) || text(photoConfig.transfer_mode, 40) || null,
      chunk_size_bytes: number(valueOr(status.chunk_size_bytes, photoConfig.chunk_size_bytes)),
      chunk_count: number(status.chunk_count),
      chunk_parallel_uploads: number(valueOr(status.chunk_parallel_uploads, photoConfig.chunk_parallel_uploads)),
      chunk_upload_kbps: number(valueOr(status.chunk_upload_kbps, photoConfig.chunk_upload_kbps)),
      egress_binding: text(status.egress_binding, 40) || null,
      egress_lane_count: number(status.egress_lane_count),
      egress_lanes: arrayOfObjects(status.egress_lanes, 8),
      active_egress: text(status.active_egress, 120) || null,
      preprocess: preprocessStatus(status.preprocess),
      image_processing: imageProcessing(status.image_processing),
      camera_ftp: cameraFtp(status.camera_ftp),
      spool: spool(status.spool),
      started_at: iso(status.started_at),
      updated_at: iso(status.updated_at) || new Date().toISOString(),
      last_completed_at: iso(status.last_completed_at),
      last_error: text(status.last_error, 160) || null,
      last_result: transferResult(status.last_result),
    };
  } catch {
    return null;
  }
}

function readPhotoConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(photoConfigPath, "utf8"));
    return config && typeof config === "object" && !Array.isArray(config) ? config : {};
  } catch {
    return {};
  }
}

function writePhotoConfig(update) {
  const current = readPhotoConfig();
  const next = cleanObject({ ...current, ...update, updated_at: new Date().toISOString() });
  fs.mkdirSync(pathDir(photoConfigPath), { recursive: true });
  fs.writeFileSync(photoConfigPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

function cleanObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function pathDir(file) {
  return file.slice(0, Math.max(file.lastIndexOf("/"), 0)) || ".";
}

function archivePhotoQueue(base = path.resolve(os.homedir(), ".frame-belabox-agent/photo-spool"), ftp = readFtpUploadStatus() || {}) {
  const active = new Set([
    ftp.spool_file,
    ftp.file,
    ftp.preprocess && ftp.preprocess.spool_file,
    ftp.preprocess && ftp.preprocess.file,
  ].filter(Boolean));
  const archive = path.join(base, "reset-archive", new Date().toISOString().replace(/[^0-9]/g, ""));
  let moved = 0;
  let preserved = 0;
  for (const name of ["incoming", "ready", "processed"]) {
    const directory = path.resolve((ftp.spool && ftp.spool[name]) || path.join(base, name));
    if (!directory.startsWith(`${base}${path.sep}`)) throw new Error("photo queue path is outside the managed spool");
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (active.has(entry.name)) {
        preserved += 1;
        continue;
      }
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(path.join(directory, entry.name), path.join(archive, `${name}-${entry.name}`));
      moved += 1;
    }
  }
  return { moved, preserved, archive: moved ? archive : null };
}

function writeJsonFile(file, payload) {
  fs.mkdirSync(pathDir(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function firstMatch(value, pattern) {
  const match = pattern.exec(value);
  return match ? match[1] : "";
}

function spool(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    incoming: text(value.incoming, 220) || "",
    ready: text(value.ready, 220) || "",
    processed: text(value.processed, 220) || "",
    inflight: text(value.inflight, 220) || "",
  };
}

function cameraFtp(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    host: text(value.host, 64) || "0.0.0.0",
    port: number(value.port),
    username: text(value.username, 64) || "",
    password_configured: value.password_configured === true,
    upload_dir: text(value.upload_dir, 220) || "",
  };
}

function imageProcessing(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    enabled: value.enabled === true,
    long_edge_px: number(value.long_edge_px),
    jpeg_quality: number(value.jpeg_quality),
    max_output_mb: number(value.max_output_mb),
    processor: text(value.processor, 40) || null,
  };
}

function preprocessStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    state: text(value.state, 32) || "unknown",
    file: text(value.file, 180) || null,
    spool_file: text(value.spool_file, 240) || null,
    status_text: text(value.status_text, 120) || "",
    ahead: number(value.ahead),
    size_bytes: number(value.size_bytes),
    warning: text(value.warning, 160) || null,
    error: text(value.error, 160) || null,
    journey_id: safeJourneyId(value.journey_id),
    updated_at: iso(value.updated_at),
  };
}

function transferResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = text(value.status, 16);
  if (status !== "completed" && status !== "failed") return null;
  return {
    status,
    file: text(value.file, 180) || null,
    at: iso(value.at),
    error: text(value.error, 160) || null,
    transfer_id: text(value.transfer_id, 120) || null,
    journey_id: safeJourneyId(value.journey_id),
  };
}

function safeJourneyId(value) {
  const parsed = text(value, 96);
  return parsed && /^[A-Za-z0-9_-]{8,96}$/.test(parsed) && !parsed.includes("__") ? parsed : null;
}

function readPublicKeyPem() {
  if (process.env.BELABOX_COMMAND_SIGNING_PUBLIC_KEY_B64) {
    return Buffer.from(process.env.BELABOX_COMMAND_SIGNING_PUBLIC_KEY_B64, "base64").toString("utf8");
  }
  return (process.env.BELABOX_COMMAND_SIGNING_PUBLIC_KEY || "").replace(/\\n/g, "\n");
}

function text(value, maximum) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function valueOr(value, fallback) {
  return value === undefined || value === null ? fallback : value;
}

function arrayOfObjects(value, maximum) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .slice(0, maximum);
}

function iso(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function randomId() {
  return randomBytes(16).toString("hex");
}

function isIsoFuture(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function selfTest() {
  const keys = generateKeyPairSync("ed25519");
  const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const makeCommand = (overrides = {}) => {
    const unsigned = {
      command_id: randomId(),
      device_id: "selftest",
      command: "agent_status",
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
      nonce: randomId(),
      args: {},
      ...overrides,
    };
    return {
      ...unsigned,
      signature: signBytes(null, Buffer.from(canonicalJson(unsigned)), createPrivateKey(privatePem)).toString("base64"),
    };
  };
  const seen = new Set();
  const good = makeCommand();
  verifyCommand(good, publicPem, seen);
  assertReject(() => verifyCommand(good, publicPem, seen), "replay");
  assertReject(() => verifyCommand(makeCommand({ expires_at: new Date(Date.now() - 1000).toISOString() }), publicPem, new Set()), "expired");
  assertReject(() => verifyCommand(makeCommand({ device_id: "other" }), publicPem, new Set()), "mismatch");
  assertReject(() => verifyCommand(makeCommand({ command: "shell" }), publicPem, new Set()), "unknown");
  assertReject(() => verifyCommand({ ...makeCommand(), signature: "bad" }, publicPem, new Set()), "signature");
  assertEqual(photoTransferIsActive({ file: "a.jpg", queue_count: 0, state: "uploading" }), true, "active upload");
  assertEqual(photoTransferIsActive({ file: "a.jpg", queue_count: 0, state: "processing" }), true, "processing upload");
  assertEqual(photoTransferIsActive({ file: null, queue_count: 1, state: "idle" }), true, "queued upload");
  assertEqual(photoTransferIsActive({ file: null, queue_count: 0, state: "idle" }), false, "idle upload");
  assertEqual(photoTelemetryNeedsPublish({ file: null, queue_count: 0, state: "idle" }, true), true, "publish terminal idle");
  assertEqual(photoTelemetryNeedsPublish({ file: null, queue_count: 0, state: "idle" }, false), false, "skip repeated idle");
  const transfer = transferResult({ status: "completed", file: "photo.jpg", at: new Date().toISOString(), journey_id: "journey-test-1" });
  assertEqual(transfer.file, "photo.jpg", "transfer result");
  assertEqual(transfer.journey_id, "journey-test-1", "transfer journey");
  assertEqual(transferResult({ status: "pending" }), null, "invalid transfer result");
  validateArgs("network_speed_test", { mode: "interface_speed_test", target: "internet", interface_name: "eth0", bytes: 65536, parallel: 2 });
  validateArgs("network_speed_test", { mode: "http_upload", target: "frame", interface_name: "all", bytes: 65536, parallel: 1 });
  assertReject(() => validateArgs("network_speed_test", { mode: "iperf3_tcp" }), "speed mode");
  assertReject(() => validateArgs("network_speed_test", { mode: "interface_speed_test", target: "other" }), "speed target");
  assertReject(() => validateArgs("network_speed_test", { mode: "interface_speed_test", interface_name: "bad interface" }), "speed interface");
  assertEqual(selectDiagnosticLanes([
    { name: "eth0", state: "healthy" },
    { name: "wlan0", state: "unreachable" },
  ], "all").length, 1, "healthy diagnostic lanes");
  assertEqual(selectDiagnosticLanes([{ name: "eth0", state: "healthy" }], "wlan0").length, 0, "selected diagnostic lane");
  assertEqual(median([30, 10, 20]), 20, "diagnostic latency median");
  validateArgs("photo_transport_config_set", { chunk_size_bytes: 4194304, chunk_parallel_uploads: 4, chunk_upload_kbps: 2500, chunk_upload_url: "https://example.test/chunks" });
  assertReject(() => validateArgs("photo_transport_config_set", { chunk_parallel_uploads: 5 }), "chunk parallel");
  assertReject(() => validateArgs("photo_transport_config_set", { chunk_upload_kbps: -1 }), "chunk cap");
  assertReject(() => validateArgs("photo_transport_config_set", { chunk_upload_url: "ftp://example.test/chunks" }), "chunk url");
  validateArgs("photo_processing_config_set", { enabled: true, long_edge_px: 1600, jpeg_quality: 85, max_output_mb: 2.5 });
  assertReject(() => validateArgs("photo_processing_config_set", { jpeg_quality: 20 }), "jpeg quality");
  validateArgs("photo_queue_reset", {});
  const relayCatalog = {
    version: 1,
    revision: createHash("sha256").update("selftest").digest("hex"),
    servers: { "frame-primary": { type: "srtla", name: "FRAME", addr: "relay.example.test", port: 5000 } },
    accounts: { "frame-test": { name: "Test", ingest_key: "publisher" } },
  };
  assertEqual(validateRelayCatalog(relayCatalog).revision, relayCatalog.revision, "relay catalog");
  assertReject(() => validateRelayCatalog({ ...relayCatalog, servers: {} }), "empty relay servers");
  const relayHealth = summarizeRelayHealth("frame-primary", relayCatalog.servers["frame-primary"], [
    { reachable: true, rtt_ms: 120 },
    { reachable: true, rtt_ms: 40 },
    { reachable: false, rtt_ms: null },
  ], "health.example.test");
  assertEqual(relayHealth.state, "degraded", "relay health state");
  assertEqual(relayHealth.rtt_ms, 40, "relay health RTT");
  assertEqual(relayHealth.probe_host, "health.example.test", "relay health target");
  const queueRoot = fs.mkdtempSync(path.join(os.tmpdir(), "frame-photo-queue-"));
  try {
    for (const directory of ["incoming", "ready", "processed"]) fs.mkdirSync(path.join(queueRoot, directory));
    fs.writeFileSync(path.join(queueRoot, "ready", "pending.jpg"), "pending");
    fs.writeFileSync(path.join(queueRoot, "processed", "active.jpg"), "active");
    fs.writeFileSync(path.join(queueRoot, "ready", "FRAMEJ1_journey-test-1__preprocessing.jpg"), "processing");
    const reset = archivePhotoQueue(queueRoot, {
      file: "active.jpg",
      state: "uploading",
      preprocess: { file: "preprocessing.jpg", spool_file: "FRAMEJ1_journey-test-1__preprocessing.jpg" },
    });
    assertEqual(reset.moved, 1, "queue reset moved");
    assertEqual(reset.preserved, 2, "queue reset preserved active and preprocessing");
  } finally {
    fs.rmSync(queueRoot, { recursive: true, force: true });
  }
  assertEqual(proxyTarget({}).id, "belaui", "legacy proxy target");
  assertEqual(proxyTarget({ target: "video_mixer" }).localUrl, VIDEO_MIXER_LOCAL_URL, "video mixer proxy target");
  assertEqual(localProxyUrl(VIDEO_MIXER_LOCAL_URL, "/api/status?full=1").toString(), `${VIDEO_MIXER_LOCAL_URL}/api/status?full=1`, "video mixer proxy URL");
  assertReject(() => proxyTarget({ target: "http://127.0.0.1:1234" }), "arbitrary proxy target");
  assertReject(() => proxyTarget({ target: null }), "non-string proxy target");
  const belauiProxy = proxyTarget({});
  const mixerProxy = proxyTarget({ target: "video_mixer" });
  const safeProxyHeaders = proxyHeaders({
    authorization: "Bearer frame-secret",
    cookie: "frame_session=secret",
    origin: "https://frame.example.test",
    upgrade: "websocket",
    "x-forwarded-for": "203.0.113.10",
    "x-safe-header": "safe",
    "x-invalid-header": "bad\r\ninjected: true",
  }, new URL(remoteBelaui.localUrl), belauiProxy);
  assertEqual(safeProxyHeaders.authorization, undefined, "proxy authorization removal");
  assertEqual(safeProxyHeaders.cookie, undefined, "proxy cookie removal");
  assertEqual(safeProxyHeaders["x-forwarded-for"], undefined, "proxy forwarding header removal");
  assertEqual(safeProxyHeaders.origin, new URL(remoteBelaui.localUrl).origin, "proxy origin rewrite");
  assertEqual(safeProxyHeaders.upgrade, "websocket", "proxy WebSocket upgrade header");
  assertEqual(safeProxyHeaders["x-safe-header"], "safe", "proxy safe header");
  assertEqual(safeProxyHeaders["x-invalid-header"], undefined, "proxy invalid header removal");
  const mixerProxyHeaders = proxyHeaders({
    authorization: "Bearer frame-secret",
    cookie: "mixer_session=allowed",
  }, new URL(VIDEO_MIXER_LOCAL_URL), mixerProxy);
  assertEqual(mixerProxyHeaders.authorization, undefined, "mixer authorization removal");
  assertEqual(mixerProxyHeaders.cookie, "mixer_session=allowed", "mixer cookie forwarding");
  const mixerBridge = proxyStreamDestination({
    target: "video_mixer",
    method: "GET",
    path: "/wsenc?port=65535",
    headers: { upgrade: "websocket" },
  });
  const expectedBelauiRoot = localProxyUrl(remoteBelaui.localUrl, "/");
  assertEqual(mixerBridge.proxy.id, "belaui", "mixer encoder bridge target");
  assertEqual(mixerBridge.target.toString(), expectedBelauiRoot.toString(), "mixer encoder bridge ignores port query");
  assertEqual(proxyHeaders({ cookie: "mixer_session=secret" }, mixerBridge.target, mixerBridge.proxy).cookie, undefined, "mixer encoder bridge cookie isolation");
  const mixerUpgrade = { method: "GET", headers: { upgrade: "websocket" } };
  assertReject(() => proxyStreamDestination({ target: "video_mixer", path: "/ws?port=65535", ...mixerUpgrade }), "other mixer websocket path");
  assertReject(() => proxyStreamDestination({ target: "video_mixer", path: "/wsenc/", ...mixerUpgrade }), "trailing-slash mixer websocket path");
  assertReject(() => proxyStreamDestination({ target: "video_mixer", path: "//anything/wsenc", ...mixerUpgrade }), "authority-like mixer websocket path");
  assertReject(() => proxyStreamDestination({ target: "video_mixer", path: "/foo/../wsenc", ...mixerUpgrade }), "normalized mixer websocket path");
  assertReject(() => proxyStreamDestination({ target: "video_mixer", method: "POST", path: "/wsenc", headers: { upgrade: "websocket" } }), "non-GET mixer websocket request");
  assertReject(() => proxyStreamDestination({ target: "video_mixer", method: "GET", path: "/wsenc", headers: {} }), "missing mixer websocket upgrade");
  const cookieResponseHeaders = { "set-cookie": ["mixer_session=allowed; Path=/; HttpOnly"], "content-type": "text/html" };
  assertEqual(responseHeaders(cookieResponseHeaders, belauiProxy)["set-cookie"], undefined, "belaUI response cookie removal");
  assertEqual(responseHeaders(cookieResponseHeaders, mixerProxy)["set-cookie"][0], cookieResponseHeaders["set-cookie"][0], "mixer response cookie forwarding");
  const streamId = "00112233-4455-6677-8899-aabbccddeeff";
  assertEqual(streamIdFromBytes(streamIdBytes(streamId)), streamId, "binary stream id round trip");
  assertEqual(normalizeStreamId("00112233445566778899AABBCCDDEEFF"), streamId, "compact stream id");
  assertReject(() => normalizeStreamId("not-a-uuid"), "invalid stream id");
  const previousClient = client;
  const previousAuthenticated = authenticated;
  let sentBinary = null;
  const sentJson = [];
  client = {
    readyState: 1,
    bufferedAmount: 0,
    send(value, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = undefined;
      }
      if (options && options.binary) sentBinary = Buffer.from(value);
      else sentJson.push(JSON.parse(String(value)));
      if (callback) callback();
    },
  };
  authenticated = true;
  sendProxyBinary({ id: streamId, drainTimer: null, controlOutputPaused: false }, Buffer.from("streamed"), null);
  assertEqual(sentBinary.length, PROXY_BINARY_HEADER_BYTES + 8, "binary frame length");
  assertEqual(sentBinary.subarray(PROXY_BINARY_HEADER_BYTES).toString("utf8"), "streamed", "binary frame body");
  let receivedBinary = "";
  const incomingStream = {
    id: streamId,
    kind: "http",
    ready: true,
    destination: {
      destroyed: false,
      write(value) {
        receivedBinary += Buffer.from(value).toString("utf8");
        return true;
      },
      destroy() {},
    },
    source: null,
    inputBlocked: false,
    pendingInput: [],
    pendingInputBytes: 0,
    inputPauseSent: false,
    idleTimer: null,
    drainTimer: null,
  };
  proxyStreams.set(streamId, incomingStream);
  handleControlBinary(sentBinary);
  assertEqual(receivedBinary, "streamed", "binary frame delivery");
  removeProxyStream(incomingStream, true);
  let flushedInput = "";
  const pendingStream = {
    id: "10213243-5465-7687-98a9-bacbdcedfe0f",
    ready: true,
    destination: {
      writableEnded: false,
      write(value) {
        flushedInput += Buffer.from(value).toString("utf8");
        return true;
      },
      end() {},
    },
    pendingInput: [Buffer.from("head"), Buffer.from("body")],
    pendingInputBytes: 8,
    pendingEnd: false,
    inputBlocked: false,
    inputDrainWaiting: false,
    inputPauseSent: true,
  };
  flushPendingProxyInput(pendingStream);
  assertEqual(flushedInput, "headbody", "pre-connect websocket input ordering");
  assertEqual(pendingStream.pendingInputBytes, 0, "pre-connect websocket buffer release");
  assertEqual(sentJson[sentJson.length - 1].type, "proxy_resume", "pre-connect websocket input resume");
  let backpressuredInput = "";
  let drainInput = null;
  const backpressuredStream = {
    id: "11223344-5566-7788-99aa-bbccddeeff00",
    ready: true,
    destination: {
      writableEnded: false,
      write(value) {
        backpressuredInput += Buffer.from(value).toString("utf8");
        return backpressuredInput !== "first";
      },
      once(event, callback) {
        if (event === "drain") drainInput = callback;
      },
      destroy() {},
    },
    source: null,
    pendingInput: [Buffer.from("first"), Buffer.from("second")],
    pendingInputBytes: 11,
    pendingEnd: false,
    inputBlocked: false,
    inputDrainWaiting: false,
    inputPauseSent: false,
    idleTimer: null,
    connectTimer: null,
    drainTimer: null,
  };
  proxyStreams.set(backpressuredStream.id, backpressuredStream);
  flushPendingProxyInput(backpressuredStream);
  assertEqual(backpressuredInput, "first", "queued proxy input stops at first backpressure");
  assertEqual(backpressuredStream.pendingInput.length, 1, "backpressured proxy input remains queued");
  assertEqual(sentJson[sentJson.length - 1].type, "proxy_pause", "backpressured proxy input pause");
  drainInput();
  assertEqual(backpressuredInput, "firstsecond", "queued proxy input resumes after drain");
  assertEqual(sentJson[sentJson.length - 1].type, "proxy_resume", "backpressured proxy input resume");
  removeProxyStream(backpressuredStream, true);
  const websocketTimer = { kind: "websocket", idleTimer: null };
  touchProxyStream(websocketTimer);
  assertEqual(websocketTimer.idleTimer, null, "websocket proxy has no idle timer");
  let firstPauses = 0;
  let firstResumes = 0;
  let secondPauses = 0;
  const firstFlowStream = {
    id: "22334455-6677-8899-aabb-ccddeeff0011",
    destination: { destroy() {} },
    source: {
      pause() { firstPauses += 1; },
      resume() { firstResumes += 1; },
      destroy() {},
    },
    remoteOutputPaused: false,
    controlOutputPaused: false,
    idleTimer: null,
    connectTimer: null,
    drainTimer: null,
  };
  const secondFlowStream = {
    id: "33445566-7788-99aa-bbcc-ddeeff001122",
    destination: { destroy() {} },
    source: {
      pause() { secondPauses += 1; },
      resume() {},
      destroy() {},
    },
    remoteOutputPaused: false,
    controlOutputPaused: false,
    idleTimer: null,
    connectTimer: null,
    drainTimer: null,
  };
  proxyStreams.set(firstFlowStream.id, firstFlowStream);
  proxyStreams.set(secondFlowStream.id, secondFlowStream);
  setProxyOutputPaused(firstFlowStream.id, true);
  assertEqual(firstPauses, 1, "per-stream output pause");
  assertEqual(secondPauses, 0, "output pause does not block another stream");
  firstFlowStream.controlOutputPaused = true;
  setProxyOutputPaused(firstFlowStream.id, false);
  assertEqual(firstResumes, 0, "control-buffer pause survives remote resume");
  firstFlowStream.controlOutputPaused = false;
  resumeProxySource(firstFlowStream);
  assertEqual(firstResumes, 1, "per-stream output resumes after all pause reasons clear");
  removeProxyStream(firstFlowStream, true);
  removeProxyStream(secondFlowStream, true);
  client = previousClient;
  authenticated = previousAuthenticated;
  assertEqual(normalizeControlUrl("https://frame.example.test/belabox/control"), "wss://frame.example.test/belabox/control", "HTTPS control URL");
  assertEqual(normalizeControlUrl("wss://frame.example.test/belabox/control"), "wss://frame.example.test/belabox/control", "WSS control URL");
  assertReject(() => normalizeControlUrl("ws://frame.example.test/belabox/control"), "plaintext control URL");
  assertEqual(
    controlProof("01234567890123456789012345678901", "selftest", VERSION, "abcdefghijklmnop"),
    "83c63fb823b4ab63aa4541db893c624b516dbf0c27b62e08b45ac932a807aec9",
    "control authentication proof",
  );
  assertReject(() => controlNonce("short"), "short challenge nonce");
  assertEqual(proxyContentLength({ "Content-Length": "4294967296" }), "4294967296", "streamed content length");
  assertEqual(proxyContentLength({ "content-length": "invalid" }), null, "invalid content length");
  assertEqual(loopbackHttpUrl("http://127.0.0.1:3741/"), "http://127.0.0.1:3741", "loopback URL");
  assertEqual(readBool("FRAME_SELFTEST_MISSING_BOOL", true), true, "bool fallback");
}

function assertReject(fn, label) {
  try {
    fn();
    throw new Error(`${label} did not reject`);
  } catch (error) {
    if (String(error.message).includes("did not reject")) throw error;
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} expected ${expected} but got ${actual}`);
}

function normalizeControlUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "wss:") throw new Error("BELABOX_CONTROL_URL must use https or wss");
  if (parsed.username || parsed.password) throw new Error("BELABOX_CONTROL_URL must not contain credentials");
  parsed.hash = "";
  return parsed.toString();
}

function normalizeStreamId(value) {
  if (typeof value !== "string") throw new Error("proxy stream id is invalid");
  const compact = value.replace(/-/g, "").toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(compact)) throw new Error("proxy stream id is invalid");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function streamIdBytes(value) {
  return Buffer.from(normalizeStreamId(value).replace(/-/g, ""), "hex");
}

function streamIdFromBytes(value) {
  if (!Buffer.isBuffer(value) || value.length !== 16) throw new Error("proxy binary stream id is invalid");
  return normalizeStreamId(value.toString("hex"));
}

function sanitizeId(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "belabox-1";
}

function readInt(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) return fallback;
  return value;
}

function readBool(name, fallback) {
  const raw = String(process.env[name] || "").trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
}

function loopbackHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return "http://127.0.0.1";
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return "http://127.0.0.1";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return "http://127.0.0.1";
  }
}
