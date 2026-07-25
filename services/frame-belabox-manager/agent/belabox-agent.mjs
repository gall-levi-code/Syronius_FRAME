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
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

const VERSION = "0.8.3";
const REMOTE_BELAUI_HTTP_TIMEOUT_MS = 8000;
const REMOTE_BELAUI_MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const REMOTE_BELAUI_STREAM_CHUNK_BYTES = 48 * 1024;
const DIAGNOSTIC_REQUEST_TIMEOUT_MS = 30000;
const EXTERNAL_SPEEDTEST_BASE_URL = "https://speed.cloudflare.com";
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
const deviceId = selfTestMode ? "selftest" : sanitizeId(process.env.BELABOX_DEVICE_ID || `belabox-${os.hostname()}`);
const username = process.env.BELABOX_MQTT_USERNAME || "";
const password = process.env.BELABOX_MQTT_PASSWORD || "";
const publicKeyPem = readPublicKeyPem();
const usedNonces = new Set();
const heartbeatMs = readInt("BELABOX_HEARTBEAT_INTERVAL_MS", 2000, 2000, 300000);
const telemetryMs = readInt("BELABOX_TELEMETRY_INTERVAL_MS", 30000, 1000, 600000);
const activePhotoTelemetryMs = readInt("BELABOX_ACTIVE_PHOTO_TELEMETRY_INTERVAL_MS", 500, 200, 5000);
const reconnectMs = readInt("BELABOX_MQTT_RECONNECT_MS", 5000, 1000, 60000);
const keepalive = readInt("BELABOX_MQTT_KEEPALIVE", 30, 5, 300);
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
const url = process.env.BELABOX_MQTT_URL || mqttUrlFromHost();
const topics = topicSet(deviceId);
let diagnosticState = null;
let diagnosticRunning = false;
let remoteBelauiState = remoteBelauiSnapshot(remoteBelaui.enabled ? "unchecked" : "disabled");
let egressState = egressSnapshot([]);
let egressRefreshRunning = false;
let relayHealthRunning = false;
let photoTelemetryWasActive = false;
let relayCatalogState = initialRelayCatalogState();
const proxyStreams = new Map();
let client;

if (selfTestMode) {
  selfTest();
  process.exit(0);
}

main().catch((error) => {
  console.error(`[belabox-agent] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

async function main() {
  if (!username || !password) throw new Error("MQTT credentials are required.");
  if (!publicKeyPem) throw new Error("command signing public key is required.");

  const mqtt = await import("mqtt").then((module) => module.default || module);
  client = mqtt.connect(url, {
    username,
    password,
    clientId: `${process.env.BELABOX_MQTT_CLIENT_ID_PREFIX || "frame-belabox-agent"}-${deviceId}`,
    reconnectPeriod: reconnectMs,
    keepalive,
    clean: true,
    will: {
      topic: topics.status,
      payload: JSON.stringify({ device_id: deviceId, state: "offline", reason: "lwt", at: new Date().toISOString() }),
      qos: 1,
      retain: true,
    },
  });

  client.on("connect", () => {
    publishJson(topics.status, { device_id: deviceId, state: "online", at: new Date().toISOString() }, true);
    publishJson(topics.version, { device_id: deviceId, version: VERSION, at: new Date().toISOString() }, true);
    client.subscribe([topics.cmdRequest, topics.proxyHttpRequest, topics.proxyStreamClient], { qos: 1 });
    publishHeartbeat();
    publishTelemetry();
  });

  client.on("message", (topic, payload) => {
    if (topic === topics.cmdRequest) {
      void handleCommand(payload);
      return;
    }
    const httpRequestId = proxyHttpRequestId(topic);
    if (httpRequestId) {
      void handleProxyHttpRequest(httpRequestId, payload);
      return;
    }
    const stream = proxyStreamClientId(topic);
    if (stream) {
      handleProxyStreamMessage(stream, payload);
    }
  });

  client.on("error", (error) => {
    console.error(`[belabox-agent] MQTT error: ${error.message}`);
  });

  setInterval(publishHeartbeat, heartbeatMs);
  setInterval(publishTelemetry, telemetryMs);
  setInterval(publishActivePhotoTelemetry, activePhotoTelemetryMs);
  setInterval(refreshRemoteBelauiState, telemetryMs);
  setInterval(() => { void refreshEgressState(); }, egressProbeMs);
  setInterval(() => { void refreshRelayHealth(); }, relayProbeMs);
  refreshRemoteBelauiState();
  void refreshEgressState();
  void refreshRelayHealth();
}

function publishHeartbeat() {
  publishJson(topics.heartbeat, {
    device_id: deviceId,
    at: new Date().toISOString(),
    uptime_seconds: Math.round(os.uptime()),
    agent_version: VERSION,
  });
}

function publishTelemetry(ftpUpload = readFtpUploadStatus()) {
  if (ftpUpload) photoTelemetryWasActive = photoTransferIsActive(ftpUpload);
  publishJson(topics.telemetry, collectTelemetry(ftpUpload));
}

function publishActivePhotoTelemetry() {
  const ftpUpload = readFtpUploadStatus();
  if (!ftpUpload) return;
  const publish = photoTelemetryNeedsPublish(ftpUpload, photoTelemetryWasActive);
  photoTelemetryWasActive = photoTransferIsActive(ftpUpload);
  if (publish) publishJson(topics.telemetry, collectTelemetry(ftpUpload));
}

async function handleCommand(payload) {
  const startedAt = new Date().toISOString();
  let commandId = randomId();
  let commandName = "unknown";
  try {
    const command = verifyCommand(JSON.parse(payload.toString("utf8")), publicKeyPem, usedNonces);
    commandId = command.command_id;
    commandName = command.command;
    const result = await runCommand(command);
    publishResponse({ command_id: commandId, status: "success", started_at: startedAt, result_summary: result });
  } catch (error) {
    publishResponse({
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
      publishTelemetry();
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
      publishJson(topics.logs, { device_id: deviceId, at: summary.collected_at, message: JSON.stringify(summary) });
      return "log bundle metadata collected";
    }
    case "log_bundle_upload_stub":
      return "log bundle upload stub accepted; no upload target configured";
    default:
      throw new Error("command is not allowlisted");
  }
}

function publishResponse({ command_id, status, started_at, result_summary, error_message = null }) {
  publishJson(topics.cmdResponse, {
    command_id,
    device_id: deviceId,
    status,
    started_at,
    finished_at: new Date().toISOString(),
    result_summary,
    error_message,
  });
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

async function handleProxyHttpRequest(requestId, payload) {
  let message = {};
  try {
    message = parseJsonPayload(payload, 512 * 1024);
    const response = await localBelauiHttpRequest(message);
    publishJson(topics.proxyHttpResponse(requestId), { request_id: requestId, ...response });
  } catch (error) {
    publishJson(topics.proxyHttpResponse(requestId), {
      request_id: requestId,
      status_code: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body_b64: "",
      error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
  }
}

function localBelauiHttpRequest(message) {
  if (!remoteBelaui.enabled) throw new Error("remote belaUI is disabled");
  const target = localBelauiUrl(text(message.path, 2000) || "/");
  const method = text(message.method, 16) || "GET";
  const probeOnly = message.probe_only === true;
  const body = Buffer.from(text(message.body_b64, REMOTE_BELAUI_MAX_HTTP_BODY_BYTES * 2) || "", "base64");
  if (body.length > REMOTE_BELAUI_MAX_HTTP_BODY_BYTES) throw new Error("proxy body too large");
  const headers = proxyHeaders(message.headers, target);
  if (body.length) headers["content-length"] = String(body.length);
  const transport = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(target, { method, headers, timeout: REMOTE_BELAUI_HTTP_TIMEOUT_MS }, (response) => {
      if (probeOnly) {
        response.resume();
        response.on("end", () => resolve({
          status_code: response.statusCode || 502,
          headers: responseHeaders(response.headers),
          body_b64: "",
        }));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > REMOTE_BELAUI_MAX_HTTP_BODY_BYTES) {
          request.destroy(new Error("proxy response too large"));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on("end", () => resolve({
        status_code: response.statusCode || 502,
        headers: responseHeaders(response.headers),
        body_b64: Buffer.concat(chunks).toString("base64"),
      }));
    });
    request.on("timeout", () => request.destroy(new Error("remote belaUI timed out")));
    request.on("error", reject);
    request.end(body);
  });
}

function handleProxyStreamMessage({ sessionId }, payload) {
  let message;
  try {
    message = parseJsonPayload(payload, REMOTE_BELAUI_STREAM_CHUNK_BYTES * 2);
  } catch {
    return;
  }
  const type = text(message.type, 16);
  if (type === "open") {
    openProxyStream(sessionId, message);
    return;
  }
  const stream = proxyStreams.get(sessionId);
  if (!stream) return;
  if (type === "data") {
    const data = Buffer.from(text(message.data_b64, REMOTE_BELAUI_STREAM_CHUNK_BYTES * 2) || "", "base64");
    if (data.length) stream.socket.write(data);
    return;
  }
  if (type === "close") closeProxyStream(sessionId);
}

function openProxyStream(sessionId, message) {
  if (proxyStreams.has(sessionId)) return;
  const target = localBelauiUrl(text(message.path, 2000) || "/");
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  const socket = target.protocol === "https:"
    ? tls.connect({ host: target.hostname, port, servername: target.hostname })
    : net.connect(port, target.hostname);
  proxyStreams.set(sessionId, { socket });
  const close = (type = "close", error = "") => {
    if (!proxyStreams.has(sessionId)) return;
    proxyStreams.delete(sessionId);
    publishJson(topics.proxyStreamServer(sessionId), { type, session_id: sessionId, error });
    socket.destroy();
  };
  socket.once(target.protocol === "https:" ? "secureConnect" : "connect", () => {
    socket.write(`${text(message.method, 16) || "GET"} ${target.pathname}${target.search} HTTP/${text(message.http_version, 16) || "1.1"}\r\n`);
    const headers = proxyHeaders(message.headers, target);
    headers.connection = "Upgrade";
    for (const [name, value] of Object.entries(headers)) {
      const values = Array.isArray(value) ? value : [value];
      for (const item of values) socket.write(`${name}: ${item}\r\n`);
    }
    socket.write("\r\n");
    const head = Buffer.from(text(message.head_b64, REMOTE_BELAUI_STREAM_CHUNK_BYTES * 2) || "", "base64");
    if (head.length) socket.write(head);
  });
  socket.on("data", (chunk) => publishProxyStreamData(sessionId, Buffer.from(chunk)));
  socket.on("close", () => close("close"));
  socket.on("error", (error) => close("error", error.message.slice(0, 160)));
}

function closeProxyStream(sessionId) {
  const stream = proxyStreams.get(sessionId);
  if (!stream) return;
  proxyStreams.delete(sessionId);
  stream.socket.destroy();
}

function publishProxyStreamData(sessionId, data) {
  for (let offset = 0; offset < data.length; offset += REMOTE_BELAUI_STREAM_CHUNK_BYTES) {
    publishJson(topics.proxyStreamServer(sessionId), {
      type: "data",
      session_id: sessionId,
      data_b64: data.subarray(offset, offset + REMOTE_BELAUI_STREAM_CHUNK_BYTES).toString("base64"),
    });
  }
}

function localBelauiUrl(path) {
  const target = new URL(remoteBelaui.localUrl);
  const incoming = new URL(path || "/", "http://frame.local");
  const base = target.pathname.replace(/\/+$/, "");
  target.pathname = `${base}${incoming.pathname}`.replace(/\/{2,}/g, "/");
  target.search = incoming.search;
  target.hash = "";
  return target;
}

function proxyHeaders(value, target) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const headers = {};
  for (const [name, item] of Object.entries(source)) {
    const lower = name.toLowerCase();
    if (["host", "connection", "content-length", "accept-encoding", "proxy-connection", "cookie", "authorization", "x-frame-authenticated-user"].includes(lower)) continue;
    if (typeof item === "string") headers[lower] = item.slice(0, 4096);
    else if (Array.isArray(item) && item.every((entry) => typeof entry === "string")) headers[lower] = item.map((entry) => entry.slice(0, 4096)).slice(0, 16);
  }
  headers.host = target.host;
  headers["accept-encoding"] = "identity";
  return headers;
}

function responseHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    if (Array.isArray(value)) return [[name, value.map(String)]];
    return [[name, String(value)]];
  }));
}

function collectTelemetry(ftpUpload = readFtpUploadStatus()) {
  const memoryTotal = os.totalmem();
  const memoryFree = os.freemem();
  const disk = diskUsage("/");
  const telemetry = {
    device_id: deviceId,
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
    publishJson(topics.relayHealth, summarizeRelayHealth(serverId, server, results, probeHost));
  } catch (error) {
    publishJson(topics.relayHealth, {
      state: "error",
      rtt_ms: null,
      reachable_lane_count: 0,
      lane_count: 0,
      error: text(error && error.message, 160) || "relay probe failed",
      updated_at: new Date().toISOString(),
    });
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

function refreshRemoteBelauiState() {
  if (!remoteBelaui.enabled) {
    remoteBelauiState = remoteBelauiSnapshot("disabled");
    return;
  }
  const parsed = new URL(remoteBelaui.localUrl);
  const transport = parsed.protocol === "https:" ? https : http;
  const request = transport.request(parsed, {
    method: "GET",
    timeout: 1500,
    headers: { "user-agent": `FRAME-Belabox-Agent/${VERSION}` },
  }, (response) => {
    response.resume();
    remoteBelauiState = {
      ...remoteBelauiSnapshot(response.statusCode && response.statusCode < 500 ? "reachable" : "error"),
      http_status: response.statusCode || 0,
    };
  });
  request.on("timeout", () => request.destroy(new Error("timeout")));
  request.on("error", (error) => {
    remoteBelauiState = { ...remoteBelauiSnapshot("unreachable"), error: text(error.message, 120) };
  });
  request.end();
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
  for (const value of [process.env.BELABOX_CHUNK_UPLOAD_URL, process.env.BELABOX_MQTT_URL, url]) {
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

function publishJson(topic, payload, retain = false) {
  if (!client || !client.connected) return;
  client.publish(topic, JSON.stringify(payload), { qos: 1, retain });
}

function parseJsonPayload(payload, maxBytes) {
  const textValue = payload.toString("utf8").slice(0, maxBytes);
  const parsed = JSON.parse(textValue);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("proxy payload must be an object");
  return parsed;
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

function topicSet(id) {
  const root = `frame/belabox/${id}`;
  return {
    root,
    status: `${root}/status`,
    heartbeat: `${root}/heartbeat`,
    telemetry: `${root}/telemetry`,
    relayHealth: `${root}/relay/health`,
    logs: `${root}/logs`,
    version: `${root}/agent/version`,
    cmdRequest: `${root}/cmd/request`,
    cmdResponse: `${root}/cmd/response`,
    proxyHttpRequest: `${root}/proxy/http/request/+`,
    proxyStreamClient: `${root}/proxy/stream/+/client`,
    proxyHttpResponse: (requestId) => `${root}/proxy/http/response/${requestId}`,
    proxyStreamServer: (sessionId) => `${root}/proxy/stream/${sessionId}/server`,
  };
}

function proxyHttpRequestId(topic) {
  const prefix = `${topics.root}/proxy/http/request/`;
  const requestId = topic.startsWith(prefix) ? topic.slice(prefix.length) : "";
  return /^[A-Za-z0-9_-]{8,80}$/.test(requestId) ? requestId : "";
}

function proxyStreamClientId(topic) {
  const prefix = `${topics.root}/proxy/stream/`;
  if (!topic.startsWith(prefix) || !topic.endsWith("/client")) return null;
  const sessionId = topic.slice(prefix.length, -"/client".length);
  return /^[A-Za-z0-9_-]{8,80}$/.test(sessionId) ? { sessionId } : null;
}

function mqttUrlFromHost() {
  const host = process.env.BELABOX_MQTT_HOST || "wss://localhost";
  const path = process.env.BELABOX_MQTT_WS_PATH || "/mqtt";
  const parsed = new URL(host);
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  parsed.pathname = path;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
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
