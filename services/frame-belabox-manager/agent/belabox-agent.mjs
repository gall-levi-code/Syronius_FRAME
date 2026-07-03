import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import mqtt from "mqtt";

const VERSION = "0.5.3";
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
  "network_speed_test",
]);
const selfTestMode = process.argv.includes("--self-test");
const deviceId = selfTestMode ? "selftest" : sanitizeId(process.env.BELABOX_DEVICE_ID || `belabox-${os.hostname()}`);
const username = process.env.BELABOX_MQTT_USERNAME || "";
const password = process.env.BELABOX_MQTT_PASSWORD || "";
const publicKeyPem = readPublicKeyPem();
const usedNonces = new Set();
const heartbeatMs = readInt("BELABOX_HEARTBEAT_INTERVAL_MS", 10000, 5000, 300000);
const telemetryMs = readInt("BELABOX_TELEMETRY_INTERVAL_MS", 30000, 1000, 600000);
const activePhotoTelemetryMs = readInt("BELABOX_ACTIVE_PHOTO_TELEMETRY_INTERVAL_MS", 500, 200, 5000);
const reconnectMs = readInt("BELABOX_MQTT_RECONNECT_MS", 5000, 1000, 60000);
const keepalive = readInt("BELABOX_MQTT_KEEPALIVE", 30, 5, 300);
const photoConfigPath = process.env.BELABOX_PHOTO_CONFIG_PATH || `${os.homedir()}/.frame-belabox-agent/photo-config.json`;
const url = process.env.BELABOX_MQTT_URL || mqttUrlFromHost();
const topics = topicSet(deviceId);
let diagnosticState = null;

if (selfTestMode) {
  selfTest();
  process.exit(0);
}

if (!username || !password) {
  console.error("[belabox-agent] MQTT credentials are required.");
  process.exit(1);
}
if (!publicKeyPem) {
  console.error("[belabox-agent] command signing public key is required.");
  process.exit(1);
}

const client = mqtt.connect(url, {
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
  client.subscribe(topics.cmdRequest, { qos: 1 });
  publishHeartbeat();
  publishTelemetry();
});

client.on("message", (_topic, payload) => {
  void handleCommand(payload);
});

client.on("error", (error) => {
  console.error(`[belabox-agent] MQTT error: ${error.message}`);
});

setInterval(publishHeartbeat, heartbeatMs);
setInterval(publishTelemetry, telemetryMs);
setInterval(publishActivePhotoTelemetry, activePhotoTelemetryMs);

function publishHeartbeat() {
  publishJson(topics.heartbeat, {
    device_id: deviceId,
    at: new Date().toISOString(),
    uptime_seconds: Math.round(os.uptime()),
    agent_version: VERSION,
  });
}

function publishTelemetry(ftpUpload = undefined) {
  publishJson(topics.telemetry, collectTelemetry(ftpUpload));
}

function publishActivePhotoTelemetry() {
  const ftpUpload = readFtpUploadStatus();
  if (ftpUpload && photoTransferIsActive(ftpUpload)) publishTelemetry(ftpUpload);
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
      writePhotoConfig({ chunk_size_bytes: command.args.chunk_size_bytes });
      publishTelemetry();
      return "photo transport config updated";
    case "photo_processing_config_set":
      writePhotoConfig({ image_processing: command.args });
      publishTelemetry();
      return "photo processing config saved; processing is not active in Phase 4A";
    case "photo_module_status":
      publishTelemetry();
      return `photo module config ${JSON.stringify(readPhotoConfig())}`;
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
  if (JSON.stringify(args).length > 4096) throw new Error("args too large");
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
  if (command === "photo_processing_config_set" && args.enabled !== undefined && typeof args.enabled !== "boolean") {
    throw new Error("photo processing enabled must be true or false");
  }
  if (command === "network_speed_test") {
    if (args.mode !== "http_upload") throw new Error("network_speed_test mode must be http_upload");
    if (args.bytes !== undefined && (!Number.isInteger(args.bytes) || args.bytes < 65536 || args.bytes > 67108864)) {
      throw new Error("network_speed_test bytes must be 65536-67108864");
    }
    if (args.parallel !== undefined && (!Number.isInteger(args.parallel) || args.parallel < 1 || args.parallel > 8)) {
      throw new Error("network_speed_test parallel must be 1-8");
    }
  }
}

async function runNetworkSpeedTest(args) {
  const bytesTotal = Number.isInteger(args.bytes) ? args.bytes : 8 * 1024 * 1024;
  const parallel = Number.isInteger(args.parallel) ? args.parallel : 1;
  const uploadUrl = diagnosticUploadUrl();
  const token = process.env.BELABOX_CHUNK_UPLOAD_TOKEN || "";
  if (!uploadUrl || !token) throw new Error("diagnostic upload URL/token is not configured");
  let bytesSent = 0;
  let lastPublish = 0;
  const testId = randomId();
  const started = Date.now();
  diagnosticState = {
    type: "http_upload",
    test_id: testId,
    state: "running",
    bytes_total: bytesTotal,
    bytes_sent: 0,
    parallel,
    mbps: 0,
    started_at: new Date(started).toISOString(),
    updated_at: new Date(started).toISOString(),
  };
  publishTelemetry();
  const onProgress = (count) => {
    bytesSent += count;
    const now = Date.now();
    diagnosticState = {
      ...diagnosticState,
      bytes_sent: Math.min(bytesSent, bytesTotal),
      mbps: mbps(bytesSent, now - started),
      updated_at: new Date(now).toISOString(),
    };
    if (now - lastPublish > 500) {
      lastPublish = now;
      publishTelemetry();
    }
  };
  try {
    const sizes = splitBytes(bytesTotal, parallel);
    await Promise.all(sizes.map((size, index) => postDiagnosticBytes(uploadUrl, token, size, testId, index, onProgress)));
    const elapsedMs = Math.max(1, Date.now() - started);
    diagnosticState = {
      ...diagnosticState,
      state: "complete",
      bytes_sent: bytesTotal,
      elapsed_ms: elapsedMs,
      mbps: mbps(bytesTotal, elapsedMs),
      updated_at: new Date().toISOString(),
    };
    publishTelemetry();
    return `HTTP upload ${formatBytes(bytesTotal)} in ${(elapsedMs / 1000).toFixed(1)}s (${diagnosticState.mbps} Mbps, ${parallel} stream${parallel === 1 ? "" : "s"})`;
  } catch (error) {
    diagnosticState = {
      ...diagnosticState,
      state: "failed",
      error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
      updated_at: new Date().toISOString(),
    };
    publishTelemetry();
    throw error;
  }
}

function diagnosticUploadUrl() {
  const explicit = process.env.BELABOX_DIAGNOSTIC_UPLOAD_URL || "";
  if (explicit) return explicit;
  const chunkUrl = process.env.BELABOX_CHUNK_UPLOAD_URL || "";
  if (!chunkUrl) return "";
  return chunkUrl.replace(/\/api\/transfers\/?$/, "/api/diagnostics/speed-test");
}

function splitBytes(total, parts) {
  const base = Math.floor(total / parts);
  return Array.from({ length: parts }, (_, index) => index === parts - 1 ? total - base * (parts - 1) : base);
}

function postDiagnosticBytes(uploadUrl, token, byteCount, testId, streamIndex, onProgress) {
  const parsed = new URL(uploadUrl);
  const transport = parsed.protocol === "https:" ? https : http;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/octet-stream",
    "content-length": String(byteCount),
    "x-belabox-device-id": deviceId,
    "x-belabox-test-id": testId,
    "x-belabox-stream": String(streamIndex),
  };
  return new Promise((resolve, reject) => {
    const request = transport.request(parsed, { method: "POST", headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve(body);
        else reject(new Error(`diagnostic upload HTTP ${response.statusCode || 0}`));
      });
    });
    request.on("error", reject);
    writeRandomBody(request, byteCount, onProgress);
  });
}

function writeRandomBody(request, byteCount, onProgress) {
  let sent = 0;
  const writeMore = () => {
    while (sent < byteCount) {
      const size = Math.min(64 * 1024, byteCount - sent);
      sent += size;
      onProgress(size);
      if (!request.write(randomBytes(size))) {
        request.once("drain", writeMore);
        return;
      }
    }
    request.end();
  };
  writeMore();
}

function mbps(bytes, elapsedMs) {
  return Math.round(((bytes * 8 * 1000) / Math.max(1, elapsedMs) / 1000000) * 10) / 10;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MiB`;
  return `${Math.round((bytes / 1024) * 10) / 10} KiB`;
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
    active_streaming_services: [],
    network_interfaces: networkSummary(),
    agent_version: VERSION,
  };
  if (ftpUpload) telemetry.ftp_upload = ftpUpload;
  if (diagnosticState) telemetry.network_diagnostics = diagnosticState;
  return telemetry;
}

function photoTransferIsActive(status) {
  return Boolean(status.file)
    || status.queue_count > 0
    || ["queued", "connecting", "preparing", "uploading", "assembling", "complete", "failed"].includes(status.state);
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

function readFtpUploadStatus() {
  const statusPath = process.env.BELABOX_FTP_CONNECTOR_STATUS_PATH || `${os.homedir()}/.frame-belabox-agent/ftp-connector/status.json`;
  try {
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    if (!status || typeof status !== "object" || Array.isArray(status)) return null;
    return {
      enabled: status.enabled === true,
      state: text(status.state, 32) || "unknown",
      status_text: text(status.status_text, 120) || "",
      file: text(status.file || status.filename, 180) || null,
      size_bytes: number(status.size_bytes),
      sent_bytes: number(status.sent_bytes),
      percent: number(status.percent),
      elapsed: number(status.elapsed),
      rate_bps: number(status.rate_bps),
      done: status.done === true,
      queue_count: number(status.queue_count),
      transfer_id: text(status.transfer_id, 120) || null,
      transfer_mode: text(status.transfer_mode, 40) || null,
      transport: text(status.transport, 40) || null,
      chunk_size_bytes: number(status.chunk_size_bytes),
      chunk_count: number(status.chunk_count),
      camera_ftp: cameraFtp(status.camera_ftp),
      spool: spool(status.spool),
      started_at: iso(status.started_at),
      updated_at: iso(status.updated_at) || new Date().toISOString(),
      last_completed_at: iso(status.last_completed_at),
      last_error: text(status.last_error, 160) || null,
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

function spool(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    incoming: text(value.incoming, 220) || "",
    ready: text(value.ready, 220) || "",
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

function publishJson(topic, payload, retain = false) {
  if (!client.connected) return;
  client.publish(topic, JSON.stringify(payload), { qos: 1, retain });
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
  assertEqual(photoTransferIsActive({ file: null, queue_count: 1, state: "idle" }), true, "queued upload");
  assertEqual(photoTransferIsActive({ file: null, queue_count: 0, state: "idle" }), false, "idle upload");
  validateArgs("network_speed_test", { mode: "http_upload", bytes: 65536, parallel: 2 });
  assertReject(() => validateArgs("network_speed_test", { mode: "iperf3_tcp" }), "speed mode");
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
    status: `${root}/status`,
    heartbeat: `${root}/heartbeat`,
    telemetry: `${root}/telemetry`,
    logs: `${root}/logs`,
    version: `${root}/agent/version`,
    cmdRequest: `${root}/cmd/request`,
    cmdResponse: `${root}/cmd/response`,
  };
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
