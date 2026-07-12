import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  chownSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  pbkdf2Sync,
  randomBytes,
  randomUUID,
  sign as signBytes,
  timingSafeEqual,
} from "node:crypto";
import path from "node:path";
import os from "node:os";
import http, { type IncomingMessage } from "node:http";
import net from "node:net";
import { promisify } from "node:util";
import express from "express";
import mqtt, { type MqttClient } from "mqtt";

const execFileAsync = promisify(execFile);

type JsonRecord = Record<string, unknown>;

interface DeviceState {
  device_id: string;
  online: boolean;
  status: JsonRecord | null;
  last_status_at: string | null;
  last_heartbeat_at: string | null;
  last_telemetry_at: string | null;
  agent_version: string | null;
  telemetry: JsonRecord | null;
  relay_health: JsonRecord | null;
  logs: Array<{ at: string; message: string }>;
  command_interface_enabled: false;
}

interface ProvisionedDevice {
  device_id: string;
  display_name?: string;
  mqtt_username: string;
  mqtt_password: string;
  host?: string;
  created_at: string;
  updated_at: string;
}

interface PairInput {
  host: string;
  user: string;
  port: number;
  password: string;
  privateKey: string;
  deviceId: string;
  displayName?: string;
  installDiagnostics: boolean;
  enableSshOnBoot: boolean;
  rememberSsh: boolean;
}

interface SavedSshCredential {
  device_id: string;
  host: string;
  user: string;
  port: number;
  encrypted_secret: string;
  iv: string;
  tag: string;
  created_at: string;
  updated_at: string;
}

interface PairResult {
  paired: true;
  device_id: string;
  host: string;
  user: string;
  agent_status: "installed";
  mqtt_status: "waiting_for_heartbeat" | "heartbeat_seen" | "installed_no_heartbeat_yet";
}

interface PairJob {
  job_id: string;
  device_id: string;
  status: "running" | "success" | "error";
  step: string;
  steps: Array<{ at: string; message: string }>;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
  result: unknown | null;
  error: string | null;
}

interface FtpConnectorInput extends PairInput {
  targetHost: string;
  targetPort: number;
  cameraUsername: string;
  cameraPassword: string;
}

interface FtpConnectorRecord {
  device_id: string;
  camera_username: string;
  camera_password: string;
  target_host?: string;
  target_port?: number;
  created_at: string;
  updated_at: string;
}

interface ChunkManifest {
  transfer_id: string;
  device_id: string;
  filename: string;
  size_bytes: number;
  chunk_size_bytes: number;
  chunk_count: number;
  file_sha256: string;
  chunks: Array<{ index: number; size_bytes: number; sha256: string }>;
  created_at: string;
}

interface CommandAuditEntry {
  at: string;
  type: "issued" | "result" | "rejected";
  device_id: string;
  command_id?: string;
  command?: CommandName;
  status?: string;
  result_summary?: string;
  error_message?: string | null;
}

interface AgentHttpResponse {
  request_id: string;
  status_code: number;
  headers: Record<string, string | string[]>;
  body_b64: string;
  error?: string;
}

type CommandName =
  | "agent_update"
  | "agent_restart"
  | "agent_status"
  | "log_bundle_collect"
  | "log_bundle_upload_stub"
  | "telemetry_refresh"
  | "photo_transfer_mode_set"
  | "photo_transport_config_set"
  | "photo_processing_config_set"
  | "photo_module_status"
  | "photo_queue_reset"
  | "relay_catalog_sync"
  | "network_speed_test";

interface RelayCatalog {
  version: 1;
  revision: string;
  servers: JsonRecord;
  accounts: JsonRecord;
}

const TOPIC_ROOT = "frame/belabox";
const REMOTE_BELAUI_ROUTE_PREFIX = "/belabox/remote";
const REMOTE_BELAUI_HTTP_TIMEOUT_MS = 8000;
const REMOTE_BELAUI_STATUS_TIMEOUT_MS = 1500;
const REMOTE_BELAUI_STATUS_POLL_MS = 500;
const REMOTE_BELAUI_READY_STATUS_POLL_MS = 5000;
const REMOTE_BELAUI_OFFLINE_FAILURES = 4;
const REMOTE_BELAUI_MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
const REMOTE_BELAUI_STREAM_CHUNK_BYTES = 48 * 1024;
const TOPICS = {
  status: "status",
  heartbeat: "heartbeat",
  telemetry: "telemetry",
  relayHealth: "relay/health",
  logs: "logs",
  version: "agent/version",
  cmdRequest: "cmd/request",
  cmdResponse: "cmd/response",
} as const;

const ALLOWED_COMMANDS = new Set<CommandName>([
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
const CONFIRM_COMMANDS = new Set<CommandName>(["agent_update", "agent_restart", "log_bundle_collect", "photo_queue_reset"]);

const config = {
  frameMode: process.env.FRAME_MODE?.trim().toUpperCase() || "LAN",
  port: readPort("PORT", 3741),
  dataRoot: path.resolve(process.env.DATA_ROOT?.trim() || "./data"),
  host: process.env.BELABOX_HOST?.trim() || "",
  user: process.env.BELABOX_USER?.trim() || "user",
  sshPort: readPort("BELABOX_PORT", 22),
  keyPath: process.env.BELABOX_SSH_KEY_PATH?.trim() || "",
  passwordConfigured: Boolean(process.env.BELABOX_PASSWORD?.trim()),
  sshCredentialKey: process.env.BELABOX_SSH_CREDENTIAL_KEY || "",
  agentRemotePath: process.env.BELABOX_AGENT_REMOTE_PATH?.trim() || "/tmp/frame-belabox-agent.sh",
  sshEnabled: readBool("BELABOX_SSH_ENABLED", false),
  commandsEnabled: readBool("BELABOX_AGENT_COMMANDS_ENABLED", false),
  installEnabled: readBool("BELABOX_AGENT_INSTALL_ENABLED", false),
  requestTimeoutMs: readInt("REQUEST_TIMEOUT_MS", 3000, 500, 30000),
  relayCatalog: {
    apiUrl: normalizeUrl(process.env.STREAMS_API_URL?.trim() || "http://frame-streams:3732"),
    apiKey: process.env.SLS_API_KEY || "",
    pollMs: readInt("BELABOX_RELAY_CATALOG_POLL_MS", 2000, 500, 60000),
  },
  mqtt: {
    internalUrl: process.env.BELABOX_MQTT_INTERNAL_URL?.trim() || "mqtt://frame-belabox-broker:1883",
    publicHost: normalizePublicUrl(process.env.BELABOX_MQTT_HOST?.trim() || "http://localhost"),
    wsPath: normalizePath(process.env.BELABOX_MQTT_WS_PATH?.trim() || "/mqtt"),
    username: process.env.BELABOX_MQTT_USERNAME?.trim() || "",
    password: process.env.BELABOX_MQTT_PASSWORD || "",
    clientIdPrefix: safeClientIdPrefix(process.env.BELABOX_MQTT_CLIENT_ID_PREFIX?.trim() || "frame-belabox"),
    reconnectMs: readInt("BELABOX_MQTT_RECONNECT_MS", 5000, 1000, 60000),
    keepalive: readInt("BELABOX_MQTT_KEEPALIVE", 30, 5, 300),
    heartbeatMs: readInt("BELABOX_HEARTBEAT_INTERVAL_MS", 2000, 2000, 300000),
    telemetryMs: readInt("BELABOX_TELEMETRY_INTERVAL_MS", 30000, 1000, 600000),
    activePhotoTelemetryMs: readInt("BELABOX_ACTIVE_PHOTO_TELEMETRY_INTERVAL_MS", 500, 200, 5000),
    brokerDataDir: path.resolve(process.env.BELABOX_BROKER_DATA_DIR?.trim() || "./belabox-broker"),
  },
  ftpConnector: {
    host: safeFtpHost(process.env.BELABOX_FTP_TARGET_HOST?.trim() || process.env.PHOTO_FTP_PASSIVE_HOST?.trim() || ""),
    port: readAnyPort(["BELABOX_FTP_TARGET_PORT", "PHOTO_FTP_PORT"], 2121),
    username: process.env.BELABOX_FTP_TARGET_USERNAME?.trim() || process.env.PHOTO_FTP_USERNAME?.trim() || "",
    password: process.env.BELABOX_FTP_TARGET_PASSWORD || process.env.PHOTO_FTP_PASSWORD || "",
    remoteDir: safeFtpRemoteDir(process.env.BELABOX_FTP_TARGET_DIR?.trim() || "/"),
    cameraUsername: safeFtpUsername(process.env.BELABOX_CAMERA_FTP_USERNAME?.trim() || "framecam"),
    cameraPort: readAnyPort(["BELABOX_CAMERA_FTP_PORT"], 2121),
  },
  chunkUpload: {
    publicUrl: normalizePublicUrl(process.env.BELABOX_CHUNK_UPLOAD_URL?.trim() || `${process.env.BELABOX_MQTT_HOST?.trim() || "http://localhost"}/belabox-chunks/api/transfers`),
    chunkSizeBytes: readInt("BELABOX_CHUNK_SIZE_BYTES", 4 * 1024 * 1024, 256 * 1024, 64 * 1024 * 1024),
    parallelUploads: readInt("BELABOX_CHUNK_PARALLEL_UPLOADS", 1, 1, 4),
    uploadKbps: readInt("BELABOX_CHUNK_UPLOAD_KBPS", 0, 0, 1000000),
    maxFileBytes: readInt("PHOTO_MAX_INPUT_MB", 50, 1, 2048) * 1024 * 1024,
  },
  diagnostics: {
    uploadBytes: readInt("BELABOX_DIAGNOSTIC_UPLOAD_BYTES", 8 * 1024 * 1024, 64 * 1024, 64 * 1024 * 1024),
    maxUploadBytes: readInt("BELABOX_DIAGNOSTIC_MAX_UPLOAD_BYTES", 64 * 1024 * 1024, 64 * 1024, 256 * 1024 * 1024),
    parallel: readInt("BELABOX_DIAGNOSTIC_PARALLEL_STREAMS", 1, 1, 8),
  },
  remoteBelaui: {
    enabled: readBool("BELABOX_REMOTE_BELAUI_ENABLED", true),
    localUrl: normalizeLoopbackHttpUrl(process.env.BELABOX_REMOTE_BELAUI_LOCAL_URL?.trim() || "http://127.0.0.1"),
    rewriteWebSocket: readBool("BELABOX_REMOTE_BELAUI_REWRITE_WS", true),
  },
  photoUpload: {
    apiUrl: normalizeUrl(process.env.PHOTO_UPLOAD_API_URL?.trim() || "http://frame-photo-upload:3736"),
    serviceToken: process.env.PORTAL_SERVICE_TOKEN?.trim() || "",
  },
  photoPipeline: {
    apiUrl: normalizeUrl(process.env.PHOTO_PIPELINE_URL?.trim() || "http://frame-pipeline-photos:3735"),
  },
};

mkdirSync(config.dataRoot, { recursive: true });
mkdirSync(config.mqtt.brokerDataDir, { recursive: true });
mkdirSync(path.join(config.dataRoot, "chunk-uploads"), { recursive: true });

const storePaths = {
  devices: path.join(config.dataRoot, "devices.json"),
  signingKey: path.join(config.dataRoot, "command-signing-key.json"),
  audit: path.join(config.dataRoot, "command-audit.jsonl"),
  ftpConnectors: path.join(config.dataRoot, "ftp-connectors.json"),
  sshCredentials: path.join(config.dataRoot, "ssh-credentials.json"),
  chunkUploads: path.join(config.dataRoot, "chunk-uploads"),
  brokerPasswords: path.join(config.mqtt.brokerDataDir, "passwords"),
  brokerAcl: path.join(config.mqtt.brokerDataDir, "acl"),
};
const provisionedDevices = loadProvisionedDevices();
const ftpConnectors = loadFtpConnectors();
const sshCredentials = loadSshCredentials();
const signingKeys = loadSigningKeys();
const commandAudit = loadAuditLog();
const devices = new Map<string, DeviceState>();
const pairJobs = new Map<string, PairJob>();
const ftpConnectorJobs = new Map<string, PairJob>();
const remoteBelauiHttpWaiters = new Map<string, {
  resolve: (response: AgentHttpResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();
const remoteBelauiStreams = new Map<string, { socket: net.Socket; closed: boolean }>();
const relayCatalogSent = new Map<string, string>();
const relayCatalogSending = new Set<string>();
let currentRelayCatalog: RelayCatalog | null = null;
let relayCatalogPollRunning = false;
let relayCatalogLastError: string | null = null;
let mqttClient: MqttClient | null = null;
const mqttHealth = {
  enabled: Boolean(config.mqtt.username && config.mqtt.password),
  connected: false,
  connecting: false,
  last_connect_at: null as string | null,
  last_disconnect_at: null as string | null,
  last_error_at: null as string | null,
  last_error: null as string | null,
};

const app = express();
const publicDir = path.resolve(process.cwd(), "public");
const bundledAgentVersion = /^const VERSION = "([^"]+)";/m.exec(readFileSync(path.join(process.cwd(), "agent", "belabox-agent.mjs"), "utf8"))?.[1] || null;

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));

syncBrokerAuthFiles();
mqttClient = startMqtt();
setInterval(() => void refreshRelayCatalog(), config.relayCatalog.pollMs).unref();
void refreshRelayCatalog();

app.get("/healthz", (_request, response) => {
  response.json({
    ok: true,
    service: "frame-belabox-manager",
    configured: isConfigured(),
    commands_enabled: commandsAreEnabled(),
    mqtt_enabled: mqttHealth.enabled,
    mqtt_connected: mqttHealth.connected,
    devices: deviceList().length,
  });
});

app.get("/belabox/api/status", async (_request, response) => {
  response.json({ ...statusPayload(), photo_pipeline: await photoPipelineStatus() });
});

app.post("/belabox-chunks/api/transfers", (request, response, next) => {
  try {
    const manifest = parseChunkManifest(request.body);
    authorizeChunkUpload(request, manifest.device_id);
    saveChunkManifest(manifest);
    response.status(201).json({
      accepted: true,
      transfer_id: manifest.transfer_id,
      upload_url: `/belabox-chunks/api/transfers/${encodeURIComponent(manifest.transfer_id)}/chunks/{index}`,
    });
  } catch (error) {
    next(error);
  }
});

app.put("/belabox-chunks/api/transfers/:transferId/chunks/:index", express.raw({ type: "*/*", limit: config.chunkUpload.chunkSizeBytes + 1024 }), (request, response, next) => {
  try {
    const manifest = loadChunkManifest(request.params.transferId);
    authorizeChunkUpload(request, manifest.device_id);
    saveChunk(request.params.transferId, request.params.index, request.body, manifest);
    response.json({ accepted: true, transfer_id: manifest.transfer_id, index: Number(request.params.index) });
  } catch (error) {
    next(error);
  }
});

app.post("/belabox-chunks/api/transfers/:transferId/complete", async (request, response, next) => {
  try {
    const manifest = loadChunkManifest(request.params.transferId);
    authorizeChunkUpload(request, manifest.device_id);
    const staged = await completeChunkTransfer(manifest);
    response.status(202).json({ accepted: true, transfer_id: manifest.transfer_id, staged_name: staged.staged_name });
  } catch (error) {
    next(error);
  }
});

app.get("/belabox-chunks/api/diagnostics/speed-test", (request, response, next) => {
  try {
    const deviceId = sanitizeDeviceId(stringValue(request.header("x-belabox-device-id")) || "");
    authorizeChunkUpload(request, deviceId);
    const bytes = request.query.bytes === undefined
      ? 0
      : safePositiveInt(request.query.bytes, "bytes", 0, config.diagnostics.maxUploadBytes);
    response.status(200);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Content-Length", String(bytes));
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.flushHeaders();
    streamDiagnosticBytes(response, bytes);
  } catch (error) {
    next(error);
  }
});

app.post("/belabox-chunks/api/diagnostics/speed-test", express.raw({ type: "*/*", limit: config.diagnostics.maxUploadBytes + 1024 }), (request, response, next) => {
  try {
    const deviceId = sanitizeDeviceId(stringValue(request.header("x-belabox-device-id")) || "");
    authorizeChunkUpload(request, deviceId);
    if (!Buffer.isBuffer(request.body)) throw new RequestError(400, "Diagnostic body is required.");
    response.json({
      accepted: true,
      device_id: deviceId,
      test_id: stringValue(request.header("x-belabox-test-id")) || null,
      stream: stringValue(request.header("x-belabox-stream")) || null,
      bytes_received: request.body.length,
      received_at: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/belabox/api/devices", (_request, response) => {
  response.json({ devices: deviceList() });
});

app.get("/belabox/api/provisioning", (_request, response) => {
  response.json({
    devices: provisionedDevices.map(redactDevice),
    command_signing_public_key: signingKeys.publicKeyPem,
  });
});

app.post("/belabox/api/provision", (request, response, next) => {
  try {
    const deviceId = sanitizeDeviceId(stringValue(request.body?.device_id) || `belabox-${provisionedDevices.length + 1}`);
    const record = upsertProvisionedDevice(deviceId, request.body?.rotate === true);
    response.json({
      ...redactDevice(record),
      paired: false,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/belabox/api/pair", async (request, response, next) => {
  try {
    const input = parsePairInput(request.body);
    response.json(await pairBelabox(input, () => undefined, false));
  } catch (error) {
    next(error);
  }
});

app.post("/belabox/api/ssh/check", async (request, response, next) => {
  try {
    const input = parsePairInput(request.body);
    const result = await runPairSsh(input, ["printf frame-belabox-ok"], "", 10000);
    if (!result.stdout.includes("frame-belabox-ok")) throw new RequestError(502, "SSH check did not return the expected response.");
    saveSshCredential(input);
    response.json({
      ok: true,
      device_id: input.deviceId,
      host: input.host,
      user: input.user,
      port: input.port,
      saved_ssh: input.rememberSsh && Boolean(config.sshCredentialKey),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/belabox/api/pair/jobs", (request, response, next) => {
  try {
    cleanupPairJobs();
    const input = parsePairJobInput(request.body);
    const existing = [...pairJobs.values()].find((job) => job.device_id === input.deviceId && job.status === "running");
    if (existing) throw new RequestError(409, "Pairing is already running for this device.");
    const now = new Date().toISOString();
    const job: PairJob = {
      job_id: randomUUID(),
      device_id: input.deviceId,
      status: "running",
      step: "Queued",
      steps: [{ at: now, message: "Queued" }],
      started_at: now,
      updated_at: now,
      finished_at: null,
      result: null,
      error: null,
    };
    pairJobs.set(job.job_id, job);
    void runPairJob(job.job_id, input);
    response.status(202).json(pairJobView(job));
  } catch (error) {
    next(error);
  }
});

app.get("/belabox/api/pair/jobs/:jobId", (request, response, next) => {
  try {
    const job = pairJobs.get(request.params.jobId);
    if (!job) throw new RequestError(404, "Pair job was not found.");
    response.json(pairJobView(job));
  } catch (error) {
    next(error);
  }
});

app.post("/belabox/api/ftp-connector/jobs", (request, response, next) => {
  try {
    cleanupPairJobs();
    cleanupJobs(ftpConnectorJobs);
    const input = parseFtpConnectorInput(request.body);
    const existing = [...ftpConnectorJobs.values()].find((job) => job.device_id === input.deviceId && job.status === "running");
    if (existing) throw new RequestError(409, "FTP connector setup is already running for this device.");
    const now = new Date().toISOString();
    const job: PairJob = {
      job_id: randomUUID(),
      device_id: input.deviceId,
      status: "running",
      step: "Queued",
      steps: [{ at: now, message: "Queued" }],
      started_at: now,
      updated_at: now,
      finished_at: null,
      result: null,
      error: null,
    };
    ftpConnectorJobs.set(job.job_id, job);
    void runFtpConnectorJob(job.job_id, input);
    response.status(202).json(pairJobView(job));
  } catch (error) {
    next(error);
  }
});

app.get("/belabox/api/ftp-connector/jobs/:jobId", (request, response, next) => {
  try {
    const job = ftpConnectorJobs.get(request.params.jobId);
    if (!job) throw new RequestError(404, "FTP connector job was not found.");
    response.json(pairJobView(job));
  } catch (error) {
    next(error);
  }
});

app.patch("/belabox/api/devices/:deviceId", (request, response, next) => {
  try {
    const deviceId = sanitizeDeviceId(request.params.deviceId);
    const device = provisionedDevices.find((record) => record.device_id === deviceId);
    if (!device) throw new RequestError(404, "Device was not found.");
    const displayName = safeDisplayName(request.body?.display_name);
    assertUniqueDisplayName(displayName, deviceId);
    device.display_name = displayName;
    device.updated_at = new Date().toISOString();
    saveProvisionedDevices();
    response.json({ device: redactDevice(device) });
  } catch (error) {
    next(error);
  }
});

app.delete("/belabox/api/devices/:deviceId/ssh-credential", (request, response, next) => {
  try {
    const deviceId = sanitizeDeviceId(request.params.deviceId);
    const index = sshCredentials.findIndex((record) => record.device_id === deviceId);
    if (index === -1) throw new RequestError(404, "Saved SSH credential was not found.");
    sshCredentials.splice(index, 1);
    saveSshCredentials();
    response.json({ removed: true, device_id: deviceId });
  } catch (error) {
    next(error);
  }
});

app.delete("/belabox/api/devices/:deviceId", async (request, response, next) => {
  try {
    const deviceId = sanitizeDeviceId(request.params.deviceId);
    const index = provisionedDevices.findIndex((device) => device.device_id === deviceId);
    const cacheRemoved = devices.delete(deviceId);
    if (index === -1 && !cacheRemoved) throw new RequestError(404, "Device was not found.");
    if (index !== -1) {
      provisionedDevices.splice(index, 1);
      saveProvisionedDevices();
      syncBrokerAuthFiles();
    }
    const ftpIndex = ftpConnectors.findIndex((record) => record.device_id === deviceId);
    if (ftpIndex !== -1) {
      ftpConnectors.splice(ftpIndex, 1);
      saveFtpConnectors();
    }
    const sshIndex = sshCredentials.findIndex((record) => record.device_id === deviceId);
    if (sshIndex !== -1) {
      sshCredentials.splice(sshIndex, 1);
      saveSshCredentials();
    }
    await clearRetainedDeviceTopics(deviceId);
    appendAudit({
      at: new Date().toISOString(),
      type: "issued",
      device_id: deviceId,
      status: "removed",
      result_summary: "removed device from FRAME",
    });
    response.json({ removed: true, device_id: deviceId, credentials_removed: index !== -1, cache_removed: cacheRemoved });
  } catch (error) {
    next(error);
  }
});

app.post("/belabox/api/connection/check", async (_request, response, next) => {
  try {
    await assertCommandReady();
    const result = await runSsh(["printf frame-belabox-ok"]);
    response.json({ ok: result.stdout.trim() === "frame-belabox-ok", checked_at: new Date().toISOString() });
  } catch (error) {
    next(error);
  }
});

app.post("/belabox/api/agent/check", async (_request, response, next) => {
  try {
    await assertCommandReady();
    const remotePath = safeRemotePath(config.agentRemotePath);
    const result = await runSsh([`test -f ${remotePath} && printf installed || printf missing`]);
    response.json({
      installed: result.stdout.trim() === "installed",
      remote_path: remotePath,
      checked_at: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/belabox/api/agent/install", (_request, response) => {
  response.status(config.installEnabled ? 501 : 409).json({
    error: config.installEnabled
      ? "Agent install is scaffolded for MQTT but not implemented yet."
      : "Agent install is disabled. Set BELABOX_AGENT_INSTALL_ENABLED=true only after the installer contract is finalized.",
    agent_entrypoint: "agent/belabox-agent.mjs",
    required_env: ["BELABOX_MQTT_URL", "BELABOX_MQTT_USERNAME", "BELABOX_MQTT_PASSWORD", "BELABOX_DEVICE_ID"],
  });
});

app.post("/belabox/api/agent/update", (_request, response) => {
  response.status(501).json({ error: "Agent update is scaffolded but not implemented yet." });
});

app.post("/belabox/api/agent/remove", async (request, response, next) => {
  try {
    const input = parseAgentRemoveInput(request.body);
    const result = await uninstallAgent(input);
    appendAudit({
      at: new Date().toISOString(),
      type: "issued",
      device_id: input.deviceId,
      status: "agent_removed",
      result_summary: stringValue(result.summary) || "agent removed",
    });
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get("/belabox/api/telemetry", (_request, response) => {
  response.json({
    available: devices.size > 0,
    devices: deviceList().map((device) => ({
      device_id: device.device_id,
      online: device.online,
      last_telemetry_at: device.last_telemetry_at,
      telemetry: device.telemetry,
    })),
    placeholders: [
      "hostname",
      "uptime",
      "cpu_load",
      "memory_usage",
      "disk_usage",
      "temperature",
      "streaming_services",
      "network_interfaces",
    ],
  });
});

app.get("/belabox/api/ftp-progress", (_request, response) => {
  response.json({
    transfers: ftpProgressTransfers(),
    target_configured: ftpConnectorTargetReady(),
  });
});

app.get("/belabox/api/devices/:deviceId/ftp-connector", (request, response, next) => {
  try {
    const deviceId = sanitizeDeviceId(request.params.deviceId);
    const record = ftpConnectors.find((connector) => connector.device_id === deviceId);
    if (!record) throw new RequestError(404, "FTP connector is not installed for this device.");
    response.json({
      device_id: deviceId,
      camera_ftp_username: record.camera_username,
      camera_ftp_password: record.camera_password,
      camera_ftp_port: config.ftpConnector.cameraPort,
      target_host: record.target_host || config.ftpConnector.host,
      target_port: record.target_port || config.ftpConnector.port,
      upload_dir: "~/.frame-belabox-agent/photo-spool/incoming",
      ready_dir: "~/.frame-belabox-agent/photo-spool/ready",
      processed_dir: "~/.frame-belabox-agent/photo-spool/processed",
    });
  } catch (error) {
    next(error);
  }
});

app.get("/belabox/api/logs", (_request, response) => {
  response.json({
    available: devices.size > 0,
    logs: deviceList().flatMap((device) =>
      device.logs.map((entry) => `${entry.at} ${device.device_id}: ${entry.message}`),
    ),
  });
});

app.get("/belabox/api/actions", (_request, response) => {
  response.json({
    commands_enabled: mqttHealth.enabled,
    allowed_commands: [...ALLOWED_COMMANDS],
    confirmation_required: [...CONFIRM_COMMANDS],
    mqtt_topics: {
      request: topicFor("{device_id}", TOPICS.cmdRequest),
      response: topicFor("{device_id}", TOPICS.cmdResponse),
    },
    safe_actions: [
      { id: "connection-check", enabled: commandsAreEnabled(), method: "POST", path: "/belabox/api/connection/check" },
      { id: "agent-check", enabled: commandsAreEnabled(), method: "POST", path: "/belabox/api/agent/check" },
      { id: "agent-install", enabled: false, method: "POST", path: "/belabox/api/agent/install" },
      { id: "agent-update", enabled: false, method: "POST", path: "/belabox/api/agent/update" },
      { id: "agent-remove", enabled: true, method: "POST", path: "/belabox/api/agent/remove" },
      { id: "mqtt-command-request", enabled: mqttHealth.enabled, method: "POST", path: "/belabox/api/cmd/request" },
    ],
  });
});

app.get("/belabox/api/commands", (_request, response) => {
  response.json({ commands: commandAudit.slice(-100).reverse() });
});

app.post("/belabox/api/diagnostics/speed-test", async (request, response, next) => {
  try {
    const input = parseSpeedTestInput(request.body);
    const signed = await publishSignedCommand(input.deviceId, "network_speed_test", {
      mode: "interface_speed_test",
      target: input.target,
      interface_name: input.interfaceName,
      bytes: input.bytes,
      parallel: input.parallel,
    });
    response.json({ queued: true, command: signed });
  } catch (error) {
    next(error);
  }
});

app.post("/belabox/api/cmd/request", async (request, response, next) => {
  try {
    const command = parseCommandName(request.body?.command);
    const deviceId = sanitizeDeviceId(stringValue(request.body?.device_id) || "");
    if (CONFIRM_COMMANDS.has(command) && request.body?.confirm !== true) {
      throw new RequestError(400, "This command requires confirm=true.");
    }
    let args = parseCommandArgs(request.body?.args);
    if (command === "photo_transport_config_set") {
      args = { ...args, chunk_upload_url: config.chunkUpload.publicUrl };
    }
    validateCommandArgs(command, args);
    const signed = await publishSignedCommand(deviceId, command, args);
    response.json({ queued: true, command: signed });
  } catch (error) {
    next(error);
  }
});

app.get(`${REMOTE_BELAUI_ROUTE_PREFIX}/status`, async (request, response, next) => {
  try {
    response.setHeader("Cache-Control", "no-store");
    response.json(await remoteBelauiStatusPayload(remoteBelauiKey(request.query.key)));
  } catch (error) {
    next(error);
  }
});

app.get([REMOTE_BELAUI_ROUTE_PREFIX, `${REMOTE_BELAUI_ROUTE_PREFIX}/`], (request, response, next) => {
  try {
    const key = request.query.key;
    if (key !== undefined) {
      response.setHeader("Cache-Control", "no-store");
      response.type("html").send(remoteBelauiShellPage(remoteBelauiKey(key)));
      return;
    }
  } catch (error) {
    next(error);
    return;
  }
  response.setHeader("Cache-Control", "no-store");
  const links = provisionedDevices.map((device) =>
    `<li><a href="${REMOTE_BELAUI_ROUTE_PREFIX}?key=${encodeURIComponent(device.device_id)}">${escapeHtml(device.display_name || device.device_id)}</a></li>`,
  ).join("");
  response.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>FRAME Remote</title></head><body><h1>FRAME Remote</h1><ul>${links || "<li>No Belabox devices paired.</li>"}</ul></body></html>`);
});

app.all([`${REMOTE_BELAUI_ROUTE_PREFIX}/:deviceId`, `${REMOTE_BELAUI_ROUTE_PREFIX}/:deviceId/*`], (request, response, next) => {
  proxyRemoteBelaui(request, response, next);
});

app.use("/belabox/assets", express.static(publicDir, { maxAge: 0 }));
app.get(["/", "/belabox"], (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const status = error instanceof RequestError ? error.status : 500;
  if (status >= 500) console.error("[belabox-manager]", errorMessage(error));
  response.status(status).json({ error: errorMessage(error) });
});

const server = app.listen(config.port, () => {
  console.log(`[belabox-manager] FRAME Belabox Manager listening on port ${config.port}`);
  if (!isConfigured()) console.log("[belabox-manager] Belabox SSH target is not configured; MQTT runtime remains available.");
  if (!mqttHealth.enabled) console.log("[belabox-manager] MQTT credentials are not configured; device cache will stay idle.");
});
server.on("upgrade", handleRemoteBelauiUpgrade);

function proxyRemoteBelaui(request: express.Request, response: express.Response, next: express.NextFunction): void {
  try {
    const deviceId = sanitizeDeviceId(String(request.params.deviceId || ""));
    if (!isProvisionedDevice(deviceId)) throw new RequestError(404, "Belabox device is not provisioned.");
    void proxyRemoteBelauiViaAgent(request, response, next, deviceId, remoteBelauiRequestSuffix(request), remoteBelauiRequestBody(request));
  } catch (error) {
    next(error);
  }
}

async function proxyRemoteBelauiViaAgent(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
  deviceId: string,
  suffix: string,
  body: Buffer | null,
): Promise<void> {
  try {
    const agentResponse = await requestAgentRemoteBelauiHttp(deviceId, {
      method: request.method,
      path: suffix,
      headers: remoteBelauiRequestHeaders(request.headers, new URL(config.remoteBelaui.localUrl)),
      body_b64: body ? body.toString("base64") : undefined,
    });
    if (agentResponse.error) throw new Error(agentResponse.error);
    const bodyBuffer = Buffer.from(agentResponse.body_b64 || "", "base64");
    const contentType = String(agentResponse.headers["content-type"] || "");
    const modified = remoteBelauiTextResponse(contentType);
    response.status(agentResponse.status_code || 502);
    writeAgentRemoteBelauiHeaders(response, agentResponse.headers, deviceId, modified);
    response.send(modified ? rewriteRemoteBelauiText(deviceId, bodyBuffer.toString("utf8")) : bodyBuffer);
  } catch (error) {
    if (!(error instanceof RequestError && error.status === 404) && remoteBelauiOfflinePageAllowed(request)) {
      sendRemoteBelauiOfflinePage(response, deviceId, error);
      return;
    }
    next(new RequestError(503, `Remote belaUI proxy failed: ${errorMessage(error)}`));
  }
}

function handleRemoteBelauiUpgrade(request: IncomingMessage, socket: net.Socket, head: Buffer): void {
  const parsed = parseRemoteBelauiUpgradeUrl(request.url || "");
  if (!parsed) return;
  void handleRemoteBelauiUpgradeViaAgent(parsed, request, socket, head);
}

async function handleRemoteBelauiUpgradeViaAgent(
  parsed: { deviceId: string; path: string; search: string },
  request: IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): Promise<void> {
  try {
    assertAgentRemoteBelauiAvailable(parsed.deviceId);
  } catch {
    socket.destroy();
    return;
  }
  const sessionId = randomUUID();
  const key = remoteBelauiStreamKey(parsed.deviceId, sessionId);
  remoteBelauiStreams.set(key, { socket, closed: false });
  const close = () => {
    const session = remoteBelauiStreams.get(key);
    if (!session || session.closed) return;
    session.closed = true;
    remoteBelauiStreams.delete(key);
    void publishMqtt(remoteBelauiStreamClientTopic(parsed.deviceId, sessionId), { type: "close", session_id: sessionId }).catch(() => undefined);
  };
  socket.on("data", (chunk) => {
    void publishRemoteBelauiStreamData(parsed.deviceId, sessionId, Buffer.from(chunk)).catch(() => socket.destroy());
  });
  socket.on("close", close);
  socket.on("error", close);
  try {
    await publishMqtt(remoteBelauiStreamClientTopic(parsed.deviceId, sessionId), {
      type: "open",
      session_id: sessionId,
      method: request.method || "GET",
      http_version: request.httpVersion || "1.1",
      path: `${parsed.path}${parsed.search}`,
      headers: remoteBelauiRequestHeaders(request.headers, new URL(config.remoteBelaui.localUrl)),
      head_b64: head.length ? head.toString("base64") : "",
    });
  } catch {
    remoteBelauiStreams.delete(key);
    socket.destroy();
  }
}

function remoteBelauiRequestSuffix(request: express.Request): string {
  const suffix = typeof request.params[0] === "string" && request.params[0] ? `/${request.params[0]}` : "/";
  const url = new URL(request.originalUrl, "http://frame.local");
  url.searchParams.delete("frame_embed");
  url.searchParams.delete("key");
  return `${suffix}${url.search}`;
}

function remoteBelauiRequestHeaders(headers: IncomingMessage["headers"], target: URL): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = { ...headers };
  for (const name of ["host", "connection", "content-length", "accept-encoding", "proxy-connection", "cookie", "authorization", "x-frame-authenticated-user"]) delete next[name];
  next.host = target.host;
  next["accept-encoding"] = "identity";
  if (next.origin) next.origin = target.origin;
  return next;
}

function writeAgentRemoteBelauiHeaders(response: express.Response, headers: AgentHttpResponse["headers"], deviceId: string, modified: boolean): void {
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (["connection", "transfer-encoding", "content-encoding"].includes(lower)) continue;
    if (modified && lower === "content-length") continue;
    if (lower === "location") response.setHeader(name, rewriteRemoteBelauiLocation(deviceId, value));
    else response.setHeader(name, value);
  }
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-FRAME-Belabox-Proxy", "agent-wss");
}

function remoteBelauiOfflinePageAllowed(request: express.Request): boolean {
  if (!["GET", "HEAD"].includes(request.method.toUpperCase())) return false;
  const accept = String(request.headers.accept || "");
  return !accept || accept.includes("text/html") || accept.includes("*/*");
}

function sendRemoteBelauiOfflinePage(response: express.Response, deviceId: string, error: unknown): void {
  response.status(200);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Refresh", "2");
  response.setHeader("X-FRAME-Belabox-Proxy", "agent-offline");
  response.type("html").send(remoteBelauiOfflinePage(deviceId, errorMessage(error)));
}

function remoteBelauiKey(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  const key = stringValue(raw);
  if (!key) throw new RequestError(400, "Remote key is required.");
  const deviceId = sanitizeDeviceId(key);
  if (!isProvisionedDevice(deviceId)) throw new RequestError(404, "Belabox device is not provisioned.");
  return deviceId;
}

async function remoteBelauiStatusPayload(deviceId: string): Promise<JsonRecord> {
  const live = devices.get(deviceId);
  const remote = objectValue(live?.telemetry?.remote_belaui) || {};
  const agentOnline = Boolean(live && deviceIsOnline(live));
  const remoteState = stringValue(remote.state) || "unknown";
  if (!agentOnline) return remoteBelauiStatusJson(deviceId, live, false, "offline", remoteState, "Encoder offline.");
  try {
    const target = new URL(config.remoteBelaui.localUrl);
    const probe = await requestAgentRemoteBelauiHttp(deviceId, {
      method: "GET",
      path: "/",
      probe_only: true,
      headers: { host: target.host, "accept-encoding": "identity", accept: "text/html,*/*" },
    }, { requireReachable: false, timeoutMs: REMOTE_BELAUI_STATUS_TIMEOUT_MS });
    if (probe.error) throw new Error(probe.error);
    const status = probe.status_code || 0;
    const ready = status > 0 && status < 500;
    return {
      ...remoteBelauiStatusJson(
        deviceId,
        live,
        ready,
        ready ? "online" : "waiting",
        ready ? "reachable" : remoteState,
        ready ? "Encoder online." : "Reconnecting to encoder...",
      ),
      http_status: status || null,
    };
  } catch (error) {
    return remoteBelauiStatusJson(deviceId, live, false, "waiting", remoteState, "Reconnecting to encoder...");
  }
}

function remoteBelauiStatusJson(
  deviceId: string,
  live: DeviceState | undefined,
  ready: boolean,
  state: string,
  remoteState: string,
  message: string,
): JsonRecord {
  return {
    device_id: deviceId,
    ready,
    state,
    agent_online: Boolean(live && deviceIsOnline(live)),
    remote_belaui_state: remoteState,
    agent_version: live?.agent_version || null,
    relay_health: live?.relay_health || null,
    last_heartbeat_at: live?.last_heartbeat_at || null,
    checked_at: new Date().toISOString(),
    message,
  };
}

function remoteBelauiShellPage(deviceId: string): string {
  const encodedDevice = encodeURIComponent(deviceId);
  const escapedDevice = escapeHtml(deviceId);
  const statusUrl = `${REMOTE_BELAUI_ROUTE_PREFIX}/status?key=${encodedDevice}`;
  const frameUrl = `${REMOTE_BELAUI_ROUTE_PREFIX}/${encodedDevice}/?frame_embed=1`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedDevice} - FRAME Remote</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#071018; color:#edf7ff; }
    body { margin:0; min-height:100vh; background:#071018; }
    iframe { position:fixed; inset:0; width:100%; height:100%; border:0; background:#071018; }
    main { min-height:100vh; display:flex; justify-content:flex-start; align-items:center; box-sizing:border-box; padding:64px 24px 24px; }
    section { width:min(520px, 100%); margin:0 auto; border:1px solid rgba(121, 204, 255, .24); border-radius:8px; background:rgba(8, 18, 28, .86); padding:28px; box-shadow:0 24px 80px rgba(0,0,0,.38); text-align:center; }
    .eyebrow { margin:0 0 10px; color:#79ccff; font-size:12px; font-weight:700; letter-spacing:0; text-transform:uppercase; }
    h1 { margin:0; font-size:36px; line-height:1.05; letter-spacing:0; }
    p { margin:14px 0 0; color:#b8c7d6; font-size:16px; line-height:1.5; }
    .status { margin-top:14px; color:#d9f2ff; font-size:14px; overflow-wrap:anywhere; }
    .status-bar { position:relative; height:12px; margin:22px auto 0; overflow:hidden; border-radius:999px; background:rgba(255,255,255,.1); }
    .status-bar span { display:block; width:38%; height:100%; border-radius:inherit; background:#2cb4fb; animation:frame-remote-scan 1.25s ease-in-out infinite; }
    @keyframes frame-remote-scan { from { transform:translateX(-110%); } to { transform:translateX(300%); } }
    [hidden] { display:none !important; }
  </style>
</head>
<body>
  <iframe id="remote-frame" title="FRAME Remote" hidden></iframe>
  <main id="offline">
    <section>
      <p class="eyebrow">FRAME Remote</p>
      <h1>This encoder is offline.</h1>
      <p>Don't refresh. This page will update automatically if ${escapedDevice} comes online.</p>
      <div class="status-bar" aria-hidden="true"><span></span></div>
      <div class="status" id="status-text">Reconnecting to encoder...</div>
    </section>
  </main>
  <script>
    const statusUrl = ${JSON.stringify(statusUrl)};
    const frameUrl = ${JSON.stringify(frameUrl)};
    const deviceId = ${JSON.stringify(deviceId)};
    const frame = document.getElementById("remote-frame");
    const offline = document.getElementById("offline");
    const statusText = document.getElementById("status-text");
    const offlineFailureThreshold = ${REMOTE_BELAUI_OFFLINE_FAILURES};
    let offlineFailures = 0;
    let frameShown = false;

    function showOffline(message) {
      frame.hidden = true;
      if (frame.getAttribute("src") !== "about:blank") frame.setAttribute("src", "about:blank");
      offline.hidden = false;
      statusText.textContent = message || "Reconnecting to encoder...";
    }

    function noteOffline(message) {
      offlineFailures += 1;
      statusText.textContent = message || "Reconnecting to encoder...";
      if (!frameShown || offlineFailures >= offlineFailureThreshold) showOffline(message);
    }

    function showFrame() {
      offlineFailures = 0;
      frameShown = true;
      if (frame.getAttribute("src") !== frameUrl) frame.setAttribute("src", frameUrl);
      frame.hidden = false;
      offline.hidden = true;
    }

    async function poll() {
      let nextPollMs = ${REMOTE_BELAUI_STATUS_POLL_MS};
      try {
        const response = await fetch(statusUrl, { cache: "no-store" });
        const status = await response.json();
        if (status.ready) {
          showFrame();
          nextPollMs = ${REMOTE_BELAUI_READY_STATUS_POLL_MS};
        } else {
          noteOffline(status.message);
        }
      } catch (error) {
        noteOffline("Reconnecting to encoder...");
      } finally {
        setTimeout(poll, nextPollMs);
      }
    }

    window.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.type === "frame-belabox-remote-offline" && data.device_id === deviceId) {
        noteOffline(data.message);
      }
    });

    poll();
  </script>
</body>
</html>`;
}

function remoteBelauiOfflinePage(deviceId: string, _reason: string): string {
  const escapedDevice = escapeHtml(deviceId);
  const offlineMessage = "Reconnecting to encoder...";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="2">
  <title>${escapedDevice} offline - FRAME Remote</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#071018; color:#edf7ff; }
    body { margin:0; min-height:100vh; display:flex; justify-content:flex-start; align-items:center; box-sizing:border-box; padding:64px 24px 24px; background:#071018; }
    main { width:min(520px, 100%); margin:0 auto; box-sizing:border-box; border:1px solid rgba(121, 204, 255, .24); border-radius:8px; background:rgba(8, 18, 28, .86); padding:28px; box-shadow:0 24px 80px rgba(0,0,0,.38); text-align:center; }
    .eyebrow { margin:0 0 10px; color:#79ccff; font-size:12px; font-weight:700; letter-spacing:0; text-transform:uppercase; }
    h1 { margin:0; font-size:36px; line-height:1.05; letter-spacing:0; }
    p { margin:14px 0 0; color:#b8c7d6; font-size:16px; line-height:1.5; }
    .status { margin-top:14px; color:#d9f2ff; font-size:14px; overflow-wrap:anywhere; }
    .status-bar { position:relative; height:12px; margin:22px auto 0; overflow:hidden; border-radius:999px; background:rgba(255,255,255,.1); }
    .status-bar span { display:block; width:38%; height:100%; border-radius:inherit; background:#2cb4fb; animation:frame-remote-scan 1.25s ease-in-out infinite; }
    @keyframes frame-remote-scan { from { transform:translateX(-110%); } to { transform:translateX(300%); } }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">FRAME Remote</p>
    <h1>This encoder is offline.</h1>
    <p>This page will refresh when ${escapedDevice} is back online.</p>
    <div class="status-bar" aria-hidden="true"><span></span></div>
    <div class="status">${offlineMessage}</div>
  </main>
  <script>
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "frame-belabox-remote-offline", device_id: ${JSON.stringify(deviceId)}, message: ${JSON.stringify(offlineMessage)} }, window.location.origin);
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char] || char);
}

function rewriteRemoteBelauiLocation(deviceId: string, value: string | string[]): string | string[] {
  const route = `${REMOTE_BELAUI_ROUTE_PREFIX}/${encodeURIComponent(deviceId)}`;
  const rewrite = (location: string) => location.startsWith("/") ? `${route}${location}` : location;
  return Array.isArray(value) ? value.map(rewrite) : rewrite(value);
}

function remoteBelauiTextResponse(contentType: string): boolean {
  return /text\/html|javascript|ecmascript|text\/css|application\/json/i.test(contentType);
}

function rewriteRemoteBelauiText(deviceId: string, text: string): string {
  const route = `${REMOTE_BELAUI_ROUTE_PREFIX}/${encodeURIComponent(deviceId)}`;
  const wsExpression = `(window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + "${route}/"`;
  const rewritten = text
    .replace(/\b(href|src|action)=("|')\/(?!\/)/gi, `$1=$2${route}/`)
    .replace(/url\((['"]?)\/(?!\/)/gi, `url($1${route}/`)
    .replace(/new WebSocket\(\s*["']ws:\/\/["']\s*\+\s*window\.location\.host\s*\)/g, `new WebSocket(${wsExpression})`)
    .replace(/new WebSocket\(\s*wsProtocol\s*\+\s*window\.location\.host\s*\)/g, `new WebSocket(${wsExpression})`);
  if (!/<html\b/i.test(rewritten)) return rewritten;
  const bridge = frameRelayBridgeScript(deviceId);
  if (/<base\b/i.test(rewritten)) return rewritten.replace(/<base\b[^>]*>/i, `<base href="${route}/">${bridge}`);
  return rewritten.replace(/(<head[^>]*>)/i, `$1<base href="${route}/">${bridge}`);
}

function frameRelayBridgeScript(deviceId: string): string {
  if (!currentRelayCatalog) return "";
  const catalog = JSON.stringify({
    servers: currentRelayCatalog.servers,
    accounts: currentRelayCatalog.accounts,
  }).replace(/</g, "\\u003c");
  const statusUrl = `${REMOTE_BELAUI_ROUTE_PREFIX}/status?key=${encodeURIComponent(deviceId)}`;
  return `<script>(()=>{const frame=${catalog};const baseNames=Object.fromEntries(Object.entries(frame.servers).map(([id,server])=>[id,server.name]));const decorate=health=>{if(!health||!health.server_id||!frame.servers[health.server_id])return;const rtt=health.rtt_ms===null?NaN:Number(health.rtt_ms);const color=health.state==="offline"||health.state==="error"?"red":rtt<=80?"green":rtt<=150?"yellow":"red";const dots={green:"\\u{1F7E2}",yellow:"\\u{1F7E1}",red:"\\u{1F534}"};const suffix=Number.isFinite(rtt)?" ("+Math.round(rtt)+" ms)":" (offline)";const name=dots[color]+" "+baseNames[health.server_id]+suffix;frame.servers[health.server_id].name=name;for(const option of document.querySelectorAll("#relayServer option")){if(option.value===health.server_id)option.textContent=name}};const poll=()=>fetch(${JSON.stringify(statusUrl)},{cache:"no-store"}).then(response=>response.ok?response.json():null).then(status=>decorate(status&&status.relay_health)).catch(()=>{});setInterval(poll,2000);poll();const merge=r=>({...r,servers:{...(r&&r.servers),...frame.servers},accounts:{...(r&&r.accounts),...frame.accounts}});const mapIncoming=c=>{if(!c)return c;const server=Object.entries(frame.servers).find(([,v])=>v.addr===c.srtla_addr&&Number(v.port)===Number(c.srtla_port));const account=Object.entries(frame.accounts).find(([,v])=>v.ingest_key===c.srt_streamid);if(!server||!account)return c;const next={...c,relay_server:server[0],relay_account:account[0]};delete next.srtla_addr;delete next.srtla_port;delete next.srt_streamid;return next};const add=WebSocket.prototype.addEventListener;WebSocket.prototype.addEventListener=function(type,listener,options){if(type!=="message"||typeof listener!=="function")return add.call(this,type,listener,options);return add.call(this,type,function(event){try{const msg=JSON.parse(event.data);if(msg.relays)msg.relays=merge(msg.relays);if(msg.config)msg.config=mapIncoming(msg.config);event=new MessageEvent("message",{data:JSON.stringify(msg),origin:event.origin,lastEventId:event.lastEventId})}catch{}return listener.call(this,event)},options)};const send=WebSocket.prototype.send;WebSocket.prototype.send=function(data){try{const msg=JSON.parse(data);const start=msg.start;const server=start&&frame.servers[start.relay_server];const account=start&&frame.accounts[start.relay_account];if(server&&account){const next={...start,srtla_addr:server.addr,srtla_port:server.port,srt_streamid:account.ingest_key};delete next.relay_server;delete next.relay_account;msg.start=next;data=JSON.stringify(msg)}}catch{}return send.call(this,data)}})();</script>`;
}

function remoteBelauiRequestBody(request: express.Request): Buffer | null {
  if (Buffer.isBuffer(request.body)) return request.body;
  if (typeof request.body === "string") return Buffer.from(request.body);
  if (request.body && typeof request.body === "object" && Object.keys(request.body).length > 0) return Buffer.from(JSON.stringify(request.body));
  return null;
}

function parseRemoteBelauiUpgradeUrl(value: string): { deviceId: string; path: string; search: string } | null {
  const parsed = new URL(value || "/", "http://frame.local");
  const base = `${REMOTE_BELAUI_ROUTE_PREFIX}/`;
  if (!parsed.pathname.startsWith(base)) return null;
  const rest = parsed.pathname.slice(base.length);
  const [rawDeviceId, ...pathParts] = rest.split("/");
  if (!rawDeviceId) return null;
  try {
    return {
      deviceId: sanitizeDeviceId(decodeURIComponent(rawDeviceId)),
      path: `/${pathParts.join("/")}`,
      search: parsed.search,
    };
  } catch {
    return null;
  }
}

async function requestAgentRemoteBelauiHttp(
  deviceId: string,
  payload: JsonRecord,
  options: { requireReachable?: boolean; timeoutMs?: number } = {},
): Promise<AgentHttpResponse> {
  if (options.requireReachable !== false) assertAgentRemoteBelauiAvailable(deviceId);
  const requestId = randomUUID();
  const key = remoteBelauiHttpKey(deviceId, requestId);
  const promise = new Promise<AgentHttpResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      remoteBelauiHttpWaiters.delete(key);
      reject(new Error("agent remote belaUI timed out"));
    }, options.timeoutMs || REMOTE_BELAUI_HTTP_TIMEOUT_MS);
    remoteBelauiHttpWaiters.set(key, { resolve, reject, timeout });
  });
  try {
    await publishMqtt(remoteBelauiHttpRequestTopic(deviceId, requestId), { ...payload, request_id: requestId });
  } catch (error) {
    const waiter = remoteBelauiHttpWaiters.get(key);
    if (waiter) {
      clearTimeout(waiter.timeout);
      remoteBelauiHttpWaiters.delete(key);
    }
    throw error;
  }
  return promise;
}

function handleAgentRemoteBelauiHttpResponse(deviceId: string, kind: string, payload: Buffer): void {
  const requestId = kind.split("/").pop() || "";
  const key = remoteBelauiHttpKey(deviceId, requestId);
  const waiter = remoteBelauiHttpWaiters.get(key);
  if (!waiter) return;
  clearTimeout(waiter.timeout);
  remoteBelauiHttpWaiters.delete(key);
  const message = parseJsonPayload(payload, REMOTE_BELAUI_MAX_HTTP_BODY_BYTES * 2);
  const response = agentHttpResponse(message, requestId);
  if (response.error) waiter.reject(new Error(response.error));
  else waiter.resolve(response);
}

function handleAgentRemoteBelauiStreamMessage(deviceId: string, kind: string, payload: Buffer): void {
  const match = /^proxy\/stream\/([^/]+)\/server$/.exec(kind);
  if (!match) return;
  const sessionId = match[1];
  const key = remoteBelauiStreamKey(deviceId, sessionId);
  const session = remoteBelauiStreams.get(key);
  if (!session || session.closed) return;
  const message = parseJsonPayload(payload, REMOTE_BELAUI_STREAM_CHUNK_BYTES * 2);
  const type = stringValue(message.type);
  if (type === "data") {
    const data = Buffer.from(stringValue(message.data_b64) || "", "base64");
    if (data.length) session.socket.write(data);
    return;
  }
  if (type === "close" || type === "error") {
    session.closed = true;
    remoteBelauiStreams.delete(key);
    session.socket.destroy();
  }
}

async function publishRemoteBelauiStreamData(deviceId: string, sessionId: string, data: Buffer): Promise<void> {
  for (let offset = 0; offset < data.length; offset += REMOTE_BELAUI_STREAM_CHUNK_BYTES) {
    await publishMqtt(remoteBelauiStreamClientTopic(deviceId, sessionId), {
      type: "data",
      session_id: sessionId,
      data_b64: data.subarray(offset, offset + REMOTE_BELAUI_STREAM_CHUNK_BYTES).toString("base64"),
    });
  }
}

function agentHttpResponse(message: JsonRecord, requestId: string): AgentHttpResponse {
  const statusCode = Number(message.status_code);
  const headers = objectValue(message.headers) || {};
  const cleanHeaders: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") cleanHeaders[name] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) cleanHeaders[name] = value;
  }
  return {
    request_id: stringValue(message.request_id) || requestId,
    status_code: Number.isInteger(statusCode) ? statusCode : 502,
    headers: cleanHeaders,
    body_b64: stringValue(message.body_b64) || "",
    error: stringValue(message.error) || undefined,
  };
}

function assertAgentRemoteBelauiAvailable(deviceId: string): void {
  const live = devices.get(deviceId);
  const remote = objectValue(live?.telemetry?.remote_belaui) || {};
  if (!live || !deviceIsOnline(live)) throw new RequestError(503, "Belabox agent is not online.");
  if (stringValue(remote.state) !== "reachable") throw new RequestError(503, "Agent cannot reach loopback belaUI.");
}

function startMqtt(): MqttClient | null {
  if (!mqttHealth.enabled) return null;
  mqttHealth.connecting = true;
  const client = mqtt.connect(config.mqtt.internalUrl, {
    username: config.mqtt.username,
    password: config.mqtt.password,
    clientId: `${config.mqtt.clientIdPrefix}-manager`,
    reconnectPeriod: config.mqtt.reconnectMs,
    keepalive: config.mqtt.keepalive,
    clean: true,
  });

  client.on("connect", () => {
    mqttHealth.connected = true;
    mqttHealth.connecting = false;
    mqttHealth.last_connect_at = new Date().toISOString();
    mqttHealth.last_error = null;
    client.subscribe([
      `${TOPIC_ROOT}/+/status`,
      `${TOPIC_ROOT}/+/heartbeat`,
      `${TOPIC_ROOT}/+/telemetry`,
      `${TOPIC_ROOT}/+/relay/health`,
      `${TOPIC_ROOT}/+/logs`,
      `${TOPIC_ROOT}/+/agent/version`,
      `${TOPIC_ROOT}/+/cmd/response`,
      `${TOPIC_ROOT}/+/proxy/http/response/+`,
      `${TOPIC_ROOT}/+/proxy/stream/+/server`,
    ]);
    void refreshRelayCatalog();
  });

  client.on("close", () => {
    mqttHealth.connected = false;
    mqttHealth.connecting = true;
    mqttHealth.last_disconnect_at = new Date().toISOString();
  });

  client.on("error", (error) => {
    mqttHealth.connected = false;
    mqttHealth.last_error_at = new Date().toISOString();
    mqttHealth.last_error = error.message.slice(0, 200);
  });

  client.on("message", (topic, payload) => handleMqttMessage(topic, payload));
  return client;
}

async function refreshRelayCatalog(): Promise<void> {
  if (relayCatalogPollRunning || !config.relayCatalog.apiKey) return;
  relayCatalogPollRunning = true;
  try {
    const response = await fetch(`${config.relayCatalog.apiUrl}/internal/belabox-relay-catalog`, {
      headers: { Authorization: `Bearer ${config.relayCatalog.apiKey}` },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`Stream catalog returned HTTP ${response.status}`);
    const catalog = relayCatalogFromValue(await response.json());
    if (catalog.revision !== currentRelayCatalog?.revision) {
      currentRelayCatalog = catalog;
      relayCatalogSent.clear();
      await Promise.all(provisionedDevices.map((device) => sendRelayCatalogToDevice(device.device_id)));
    }
    relayCatalogLastError = null;
  } catch (error) {
    const message = errorMessage(error).slice(0, 200);
    if (message !== relayCatalogLastError) console.warn(`[belabox-manager] Relay catalog unavailable: ${message}`);
    relayCatalogLastError = message;
  } finally {
    relayCatalogPollRunning = false;
  }
}

async function sendRelayCatalogToDevice(deviceId: string): Promise<void> {
  const catalog = currentRelayCatalog;
  const device = devices.get(deviceId);
  if (!catalog || !device || !deviceIsOnline(device) || relayCatalogSent.get(deviceId) === catalog.revision || relayCatalogSending.has(deviceId)) return;
  relayCatalogSending.add(deviceId);
  try {
    await publishSignedCommand(deviceId, "relay_catalog_sync", catalog as unknown as JsonRecord);
    relayCatalogSent.set(deviceId, catalog.revision);
  } catch (error) {
    console.warn(`[belabox-manager] Relay catalog sync failed for ${deviceId}: ${errorMessage(error)}`);
  } finally {
    relayCatalogSending.delete(deviceId);
  }
}

function handleMqttMessage(topic: string, payload: Buffer): void {
  const parsedTopic = parseTopic(topic);
  if (!parsedTopic) return;
  if (!isProvisionedDevice(parsedTopic.deviceId)) return;

  if (parsedTopic.kind.startsWith("proxy/http/response/")) {
    handleAgentRemoteBelauiHttpResponse(parsedTopic.deviceId, parsedTopic.kind, payload);
    return;
  }
  if (parsedTopic.kind.startsWith("proxy/stream/")) {
    handleAgentRemoteBelauiStreamMessage(parsedTopic.deviceId, parsedTopic.kind, payload);
    return;
  }

  const message = parsePayload(payload);
  const device = ensureDevice(parsedTopic.deviceId);
  const now = new Date().toISOString();

  if (parsedTopic.kind === TOPICS.status) {
    device.status = message;
    device.last_status_at = readTimestamp(message) || now;
    const state = typeof message.state === "string" ? message.state.toLowerCase() : "";
    if (state === "offline") device.online = false;
    if (state === "online") {
      device.online = true;
      relayCatalogSent.delete(parsedTopic.deviceId);
      void sendRelayCatalogToDevice(parsedTopic.deviceId);
    }
    return;
  }

  if (parsedTopic.kind === TOPICS.heartbeat) {
    device.last_heartbeat_at = readTimestamp(message) || now;
    device.online = true;
    const version = stringValue(message.agent_version);
    if (version) device.agent_version = version;
    void sendRelayCatalogToDevice(parsedTopic.deviceId);
    return;
  }

  if (parsedTopic.kind === TOPICS.telemetry) {
    device.telemetry = message;
    device.last_telemetry_at = readTimestamp(message) || now;
    device.online = true;
    const version = stringValue(message.agent_version);
    if (version) device.agent_version = version;
    return;
  }

  if (parsedTopic.kind === TOPICS.relayHealth) {
    device.relay_health = message;
    device.online = true;
    return;
  }

  if (parsedTopic.kind === TOPICS.version) {
    device.agent_version = stringValue(message.version) || stringValue(message.agent_version) || device.agent_version;
    return;
  }

  if (parsedTopic.kind === TOPICS.logs || parsedTopic.kind === TOPICS.cmdResponse) {
    const text = stringValue(message.message) || stringValue(message.line) || JSON.stringify(message);
    device.logs.push({ at: readTimestamp(message) || now, message: sanitizeLogLine(text) });
    device.logs = device.logs.slice(-50);
    if (parsedTopic.kind === TOPICS.cmdResponse) auditCommandResult(parsedTopic.deviceId, message);
  }
}

function statusPayload() {
  return {
    service: "frame-belabox-manager",
    frame: {
      mode: config.frameMode,
    },
    configured: isConfigured(),
    commands_enabled: commandsAreEnabled(),
    command_execution: commandsAreEnabled() ? "manual-diagnostics-only" : "disabled",
    mqtt: {
      enabled: mqttHealth.enabled,
      connected: mqttHealth.connected,
      connecting: mqttHealth.connecting,
      last_connect_at: mqttHealth.last_connect_at,
      last_disconnect_at: mqttHealth.last_disconnect_at,
      last_error_at: mqttHealth.last_error_at,
      last_error: mqttHealth.last_error,
      websocket_path: config.mqtt.wsPath,
      public_host: config.mqtt.publicHost,
      username_configured: Boolean(config.mqtt.username),
      password_configured: Boolean(config.mqtt.password),
      client_id_prefix: config.mqtt.clientIdPrefix,
      reconnect_ms: config.mqtt.reconnectMs,
      keepalive_seconds: config.mqtt.keepalive,
      heartbeat_interval_ms: config.mqtt.heartbeatMs,
      telemetry_interval_ms: config.mqtt.telemetryMs,
      active_photo_telemetry_interval_ms: config.mqtt.activePhotoTelemetryMs,
      topics: topicTemplates(),
    },
    relay_catalog: {
      revision: currentRelayCatalog?.revision || null,
      accounts: currentRelayCatalog ? Object.keys(currentRelayCatalog.accounts).length : 0,
      last_error: relayCatalogLastError,
    },
    provisioning: {
      devices: provisionedDevices.map(redactDevice),
      command_signing_public_key_configured: Boolean(signingKeys.publicKeyPem),
    },
    devices: deviceList(),
    device: {
      host: config.host,
      user: config.user,
      port: config.sshPort,
      key_configured: Boolean(config.keyPath),
      password_configured: config.passwordConfigured,
    },
    ssh_credentials: {
      save_enabled: Boolean(config.sshCredentialKey),
      devices: sshCredentials.map(redactSshCredential),
    },
    agent: {
      remote_path: config.agentRemotePath,
      install_enabled: config.installEnabled,
      bundled_version: bundledAgentVersion,
      runtime: "mqtt-over-websockets",
      status: devices.size > 0 ? "mqtt_seen" : "not_seen",
    },
    ftp_connector: {
      target_host: config.ftpConnector.host || "Not set",
      target_port: config.ftpConnector.port,
      target_username: config.ftpConnector.username || "Not set",
      target_password_configured: Boolean(config.ftpConnector.password),
      target_dir: config.ftpConnector.remoteDir,
      camera_username: config.ftpConnector.cameraUsername,
      camera_port: config.ftpConnector.cameraPort,
      managed_upload_dir: "~/.frame-belabox-agent/photo-spool/incoming",
      managed_ready_dir: "~/.frame-belabox-agent/photo-spool/ready",
      managed_processed_dir: "~/.frame-belabox-agent/photo-spool/processed",
      progress_endpoint: "/belabox/api/ftp-progress",
    },
    ftp_connectors: ftpConnectors.map((record) => ({
      device_id: record.device_id,
      camera_username: record.camera_username,
      target_host: record.target_host || config.ftpConnector.host,
      target_port: record.target_port || config.ftpConnector.port,
      created_at: record.created_at,
      updated_at: record.updated_at,
    })),
    chunk_upload: {
      endpoint: "/belabox-chunks/api/transfers",
      diagnostic_endpoint: "/belabox-chunks/api/diagnostics/speed-test",
      public_url_configured: Boolean(config.chunkUpload.publicUrl),
      photo_upload_configured: Boolean(config.photoUpload.apiUrl && config.photoUpload.serviceToken),
      chunk_size_bytes: config.chunkUpload.chunkSizeBytes,
      chunk_parallel_uploads: config.chunkUpload.parallelUploads,
      chunk_upload_kbps: config.chunkUpload.uploadKbps,
    },
    diagnostics: {
      upload_bytes: config.diagnostics.uploadBytes,
      max_upload_bytes: config.diagnostics.maxUploadBytes,
      parallel_streams: config.diagnostics.parallel,
      upload_url_configured: Boolean(diagnosticUploadUrl()),
    },
    remote_belaui: {
      enabled: config.remoteBelaui.enabled,
      route_prefix: REMOTE_BELAUI_ROUTE_PREFIX,
      local_url: config.remoteBelaui.localUrl,
      rewrite_websocket: config.remoteBelaui.rewriteWebSocket,
      proxy_mode: "agent-wss-only",
    },
    issues: configurationIssues(),
  };
}

async function photoPipelineStatus(): Promise<JsonRecord> {
  try {
    const result = await fetch(`${config.photoPipeline.apiUrl}/api/internal/photo-pipeline/status`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!result.ok) throw new Error(`status ${result.status}`);
    return { available: true, ...objectValue(await result.json()) };
  } catch {
    return { available: false, error: "FRAME photo processing is unavailable." };
  }
}

function loadProvisionedDevices(): ProvisionedDevice[] {
  if (!existsSync(storePaths.devices)) return [];
  const parsed = JSON.parse(readFileSync(storePaths.devices, "utf8"));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((device) =>
    device &&
    typeof device.device_id === "string" &&
    typeof device.mqtt_username === "string" &&
    typeof device.mqtt_password === "string",
  );
}

function saveProvisionedDevices(): void {
  writeFileSync(storePaths.devices, `${JSON.stringify(provisionedDevices, null, 2)}\n`, { mode: 0o600 });
}

function loadFtpConnectors(): FtpConnectorRecord[] {
  if (!existsSync(storePaths.ftpConnectors)) return [];
  const parsed = JSON.parse(readFileSync(storePaths.ftpConnectors, "utf8"));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((record) =>
    record &&
    typeof record.device_id === "string" &&
    typeof record.camera_username === "string" &&
    typeof record.camera_password === "string",
  );
}

function saveFtpConnectors(): void {
  writeFileSync(storePaths.ftpConnectors, `${JSON.stringify(ftpConnectors, null, 2)}\n`, { mode: 0o600 });
}

function loadSshCredentials(): SavedSshCredential[] {
  if (!existsSync(storePaths.sshCredentials)) return [];
  const parsed = JSON.parse(readFileSync(storePaths.sshCredentials, "utf8"));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((record) =>
    record &&
    typeof record.device_id === "string" &&
    typeof record.host === "string" &&
    typeof record.user === "string" &&
    typeof record.encrypted_secret === "string" &&
    typeof record.iv === "string" &&
    typeof record.tag === "string",
  ) as SavedSshCredential[];
}

function saveSshCredentials(): void {
  writeFileSync(storePaths.sshCredentials, `${JSON.stringify(sshCredentials, null, 2)}\n`, { mode: 0o600 });
}

function saveSshCredential(input: PairInput): void {
  if (!input.rememberSsh || !config.sshCredentialKey) return;
  const now = new Date().toISOString();
  const encrypted = encryptSshSecret({ password: input.password, privateKey: input.privateKey });
  const existing = sshCredentials.find((record) => record.device_id === input.deviceId);
  const record: SavedSshCredential = {
    device_id: input.deviceId,
    host: input.host,
    user: input.user,
    port: input.port,
    encrypted_secret: encrypted.encrypted_secret,
    iv: encrypted.iv,
    tag: encrypted.tag,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  if (existing) sshCredentials.splice(sshCredentials.indexOf(existing), 1, record);
  else sshCredentials.push(record);
  saveSshCredentials();
}

function savedSshCredential(deviceId: string): PairInput | null {
  if (!config.sshCredentialKey) return null;
  const record = sshCredentials.find((item) => item.device_id === deviceId);
  if (!record) return null;
  const secret = decryptSshSecret(record);
  return {
    host: record.host,
    user: record.user,
    port: record.port,
    password: secret.password,
    privateKey: secret.privateKey,
    deviceId,
    installDiagnostics: false,
    enableSshOnBoot: false,
    rememberSsh: false,
  };
}

function encryptSshSecret(secret: { password: string; privateKey: string }): Pick<SavedSshCredential, "encrypted_secret" | "iv" | "tag"> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sshCredentialKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  return {
    encrypted_secret: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptSshSecret(record: SavedSshCredential): { password: string; privateKey: string } {
  const decipher = createDecipheriv("aes-256-gcm", sshCredentialKey(), Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  const text = Buffer.concat([
    decipher.update(Buffer.from(record.encrypted_secret, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(text) as JsonRecord;
  return {
    password: stringValue(parsed.password) || "",
    privateKey: stringValue(parsed.privateKey) || "",
  };
}

function sshCredentialKey(): Buffer {
  return createHash("sha256").update(config.sshCredentialKey).digest();
}

function redactSshCredential(record: SavedSshCredential): JsonRecord {
  return {
    device_id: record.device_id,
    host: record.host,
    user: record.user,
    port: record.port,
    updated_at: record.updated_at,
  };
}

function upsertFtpConnector(deviceId: string, input?: Pick<FtpConnectorInput, "cameraUsername" | "cameraPassword" | "targetHost" | "targetPort">): FtpConnectorRecord {
  const existing = ftpConnectors.find((record) => record.device_id === deviceId);
  if (existing) {
    if (input?.cameraUsername || input?.cameraPassword || input?.targetHost || input?.targetPort) {
      existing.camera_username = input.cameraUsername || existing.camera_username;
      existing.camera_password = input.cameraPassword || existing.camera_password;
      existing.target_host = input.targetHost || existing.target_host;
      existing.target_port = input.targetPort || existing.target_port;
      existing.updated_at = new Date().toISOString();
      saveFtpConnectors();
    }
    return existing;
  }
  const now = new Date().toISOString();
  const record = {
    device_id: deviceId,
    camera_username: input?.cameraUsername || config.ftpConnector.cameraUsername,
    camera_password: input?.cameraPassword || randomSecret(18),
    target_host: input?.targetHost || config.ftpConnector.host,
    target_port: input?.targetPort || config.ftpConnector.port,
    created_at: now,
    updated_at: now,
  };
  ftpConnectors.push(record);
  saveFtpConnectors();
  return record;
}

function loadSigningKeys(): { privateKeyPem: string; publicKeyPem: string } {
  if (existsSync(storePaths.signingKey)) {
    const parsed = JSON.parse(readFileSync(storePaths.signingKey, "utf8"));
    if (typeof parsed.privateKeyPem === "string" && typeof parsed.publicKeyPem === "string") return parsed;
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keys = {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
  writeFileSync(storePaths.signingKey, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  return keys;
}

function upsertProvisionedDevice(deviceId: string, rotate: boolean, reuseExisting = false, host = "", displayName = ""): ProvisionedDevice {
  const existing = provisionedDevices.find((device) => device.device_id === deviceId);
  const duplicateHost = host && provisionedDevices.find((device) => device.host === host && device.device_id !== deviceId);
  if (duplicateHost) throw new RequestError(409, `Belabox host/IP is already assigned to ${duplicateHost.device_id}.`);
  if (displayName) assertUniqueDisplayName(displayName, deviceId);
  if (existing && !rotate) {
    if (reuseExisting) {
      let changed = false;
      if (host && existing.host !== host) {
        existing.host = host;
        changed = true;
      }
      if (displayName && existing.display_name !== displayName) {
        existing.display_name = displayName;
        changed = true;
      }
      if (changed) {
        existing.updated_at = new Date().toISOString();
        saveProvisionedDevices();
      }
      return existing;
    }
    throw new RequestError(409, "Device already exists.");
  }
  const now = new Date().toISOString();
  const record: ProvisionedDevice = {
    device_id: deviceId,
    display_name: displayName || existing?.display_name || deviceId,
    mqtt_username: `belabox-${deviceId}`,
    mqtt_password: randomSecret(32),
    host: host || existing?.host,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  if (existing) provisionedDevices.splice(provisionedDevices.indexOf(existing), 1, record);
  else provisionedDevices.push(record);
  saveProvisionedDevices();
  syncBrokerAuthFiles();
  return record;
}

async function pairBelabox(input: PairInput, progress: (message: string) => void, waitForMqtt: boolean): Promise<PairResult> {
  const snapshot = provisionedDevices.map((device) => ({ ...device }));
  try {
    progress("Validating SSH access");
    await runPairSsh(input, ["printf frame-belabox-ok"], "", 10000);
    progress("Preparing device credentials");
    const record = upsertProvisionedDevice(input.deviceId, false, true, input.host, input.displayName);
    progress("Installing agent and boot service");
    await installAgent(input, record);
    const installedAt = Date.now();
    saveSshCredential(input);
    let heartbeatSeen = false;
    if (waitForMqtt) {
      progress("Waiting for MQTT heartbeat");
      heartbeatSeen = await waitForFreshHeartbeat(record.device_id, installedAt, 60000);
    }
    appendAudit({
      at: new Date().toISOString(),
      type: "issued",
      device_id: record.device_id,
      status: "paired",
      result_summary: `paired ${input.host}`,
    });
    return {
      paired: true,
      device_id: record.device_id,
      host: input.host,
      user: input.user,
      agent_status: "installed",
      mqtt_status: heartbeatSeen ? "heartbeat_seen" : waitForMqtt ? "installed_no_heartbeat_yet" : "waiting_for_heartbeat",
    };
  } catch (error) {
    provisionedDevices.splice(0, provisionedDevices.length, ...snapshot);
    saveProvisionedDevices();
    syncBrokerAuthFiles();
    throw error;
  }
}

async function runPairJob(jobId: string, input: PairInput): Promise<void> {
  const job = pairJobs.get(jobId);
  if (!job) return;
  try {
    const result = await pairBelabox(input, (message) => updatePairJob(job, message), true);
    job.status = "success";
    job.result = result;
    updatePairJob(job, result.mqtt_status === "heartbeat_seen" ? "Belabox online" : "Installed; heartbeat still pending");
  } catch (error) {
    job.status = "error";
    job.error = errorMessage(error);
    updatePairJob(job, "Pairing failed");
  } finally {
    job.finished_at = new Date().toISOString();
    job.updated_at = job.finished_at;
  }
}

function updatePairJob(job: PairJob, message: string): void {
  const now = new Date().toISOString();
  job.step = message;
  job.updated_at = now;
  job.steps.push({ at: now, message });
  job.steps = job.steps.slice(-30);
}

function pairJobView(job: PairJob): JsonRecord {
  return {
    job_id: job.job_id,
    device_id: job.device_id,
    status: job.status,
    step: job.step,
    steps: job.steps,
    started_at: job.started_at,
    updated_at: job.updated_at,
    finished_at: job.finished_at,
    result: job.result,
    error: job.error,
  };
}

function cleanupPairJobs(): void {
  cleanupJobs(pairJobs);
}

function cleanupJobs(jobs: Map<string, PairJob>): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [jobId, job] of jobs) {
    if (job.status !== "running" && Date.parse(job.updated_at) < cutoff) jobs.delete(jobId);
  }
}

async function waitForFreshHeartbeat(deviceId: string, startedAt: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const heartbeatAt = devices.get(deviceId)?.last_heartbeat_at;
    if (heartbeatAt && Date.parse(heartbeatAt) >= startedAt) return true;
    await delay(2000);
  }
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ftpProgressTransfers(): JsonRecord[] {
  return deviceList().flatMap((device) => {
    const ftp = objectValue(device.telemetry?.ftp_upload);
    if (!ftp) return [];
    const transfers: JsonRecord[] = [];
    const filename = stringValue(ftp.file) || stringValue(ftp.filename);
    const state = (stringValue(ftp.state) || "").toLowerCase();
    const phase = ftpPhase(state, ftp.done === true);
    const updatedAt = readTimestamp(ftp) || device.last_telemetry_at || new Date().toISOString();
    const startedAt = stringValue(ftp.started_at) && Number.isFinite(Date.parse(String(ftp.started_at)))
      ? new Date(Date.parse(String(ftp.started_at))).toISOString()
      : updatedAt;
    const size = numberValue(ftp.size_bytes);
    const sent = numberValue(ftp.sent_bytes);
    const elapsed = numberValue(ftp.elapsed);
    const adapter = stringValue(ftp.transport) === "chunked_https" ? "belabox_chunked" : "belabox_agent";
    if (filename || phase === "failed") {
      transfers.push({
        transfer_id: stringValue(ftp.transfer_id) || `${device.device_id}:${filename || "ftp"}:${startedAt}`,
        adapter,
        phase,
        filename,
        bytes_received: sent,
        bytes_total: size > 0 ? size : null,
        speed_bps: numberOrNull(ftp.rate_bps),
        elapsed_ms: elapsed > 0 ? Math.round(elapsed * 1000) : null,
        started_at: startedAt,
        updated_at: updatedAt,
        status_text: stringValue(ftp.status_text) || undefined,
        transport: stringValue(ftp.transport) || stringValue(ftp.transfer_mode) || "direct_ftp",
        ...(phase === "failed" ? { error: stringValue(ftp.last_error) || "FTP upload failed" } : {}),
      });
    }
    const result = objectValue(ftp.last_result) || {};
    const completedAt = stringValue(result.at);
    if (stringValue(result.status) === "completed" && completedAt && Number.isFinite(Date.parse(completedAt))) {
      const timestamp = new Date(Date.parse(completedAt)).toISOString();
      transfers.push({
        transfer_id: `${device.device_id}:completed:${timestamp}`,
        adapter,
        phase: "published",
        filename: stringValue(result.file) || null,
        bytes_received: 0,
        bytes_total: null,
        speed_bps: null,
        elapsed_ms: null,
        started_at: timestamp,
        updated_at: timestamp,
        status_text: "Transfer complete",
      });
    }
    return transfers;
  });
}

function ftpPhase(state: string, done: boolean): "receiving" | "queued" | "processing" | "published" | "failed" {
  if (done || state === "complete" || state === "published") return "published";
  if (state === "failed" || state === "error") return "failed";
  if (state === "queued" || state === "idle") return "queued";
  if (state === "connecting" || state === "preparing" || state === "assembling") return "processing";
  return "receiving";
}

function parseChunkManifest(body: unknown): ChunkManifest {
  const data = body && typeof body === "object" ? body as JsonRecord : {};
  const deviceId = sanitizeDeviceId(stringValue(data.device_id) || "");
  const transferId = safeTransferId(stringValue(data.transfer_id) || randomUUID());
  const sizeBytes = safePositiveInt(data.size_bytes, "size_bytes", 1, config.chunkUpload.maxFileBytes);
  const chunkSizeBytes = safePositiveInt(data.chunk_size_bytes, "chunk_size_bytes", 256 * 1024, 64 * 1024 * 1024);
  const chunkCount = safePositiveInt(data.chunk_count, "chunk_count", 1, 10000);
  const chunks = Array.isArray(data.chunks) ? data.chunks.map((chunk, index) => {
    const item = chunk && typeof chunk === "object" ? chunk as JsonRecord : {};
    return {
      index: safePositiveInt(item.index, "chunk index", 0, chunkCount - 1),
      size_bytes: safePositiveInt(item.size_bytes, "chunk size", 1, chunkSizeBytes),
      sha256: safeSha256(stringValue(item.sha256) || ""),
    };
  }) : [];
  if (chunks.length !== chunkCount) throw new RequestError(400, "Chunk manifest count does not match chunks.");
  if (new Set(chunks.map((chunk) => chunk.index)).size !== chunks.length) throw new RequestError(400, "Chunk manifest contains duplicate chunk indexes.");
  if (chunks.reduce((total, chunk) => total + chunk.size_bytes, 0) !== sizeBytes) throw new RequestError(400, "Chunk sizes do not add up to file size.");
  return {
    transfer_id: transferId,
    device_id: deviceId,
    filename: safePhotoFilename(stringValue(data.filename) || "belabox-photo.jpg"),
    size_bytes: sizeBytes,
    chunk_size_bytes: chunkSizeBytes,
    chunk_count: chunkCount,
    file_sha256: safeSha256(stringValue(data.file_sha256) || ""),
    chunks: chunks.sort((left, right) => left.index - right.index),
    created_at: new Date().toISOString(),
  };
}

function authorizeChunkUpload(request: express.Request, deviceId: string): void {
  const device = provisionedDevices.find((record) => record.device_id === deviceId);
  const supplied = request.header("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!device || !constantTimeEqual(supplied, device.mqtt_password)) {
    throw new RequestError(401, "Belabox chunk upload token is invalid.");
  }
}

function saveChunkManifest(manifest: ChunkManifest): void {
  const directory = chunkTransferDir(manifest.transfer_id);
  mkdirSync(path.join(directory, "chunks"), { recursive: true });
  writeFileSync(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function loadChunkManifest(transferId: string): ChunkManifest {
  const safeId = safeTransferId(transferId);
  const file = path.join(chunkTransferDir(safeId), "manifest.json");
  if (!existsSync(file)) throw new RequestError(404, "Chunk transfer was not found.");
  return JSON.parse(readFileSync(file, "utf8")) as ChunkManifest;
}

function saveChunk(transferId: string, indexValue: string, body: unknown, manifest: ChunkManifest): void {
  const index = safePositiveInt(indexValue, "chunk index", 0, manifest.chunk_count - 1);
  const expected = manifest.chunks.find((chunk) => chunk.index === index);
  if (!expected) throw new RequestError(404, "Chunk index is not in the manifest.");
  if (!Buffer.isBuffer(body)) throw new RequestError(400, "Chunk body is required.");
  if (body.length !== expected.size_bytes) throw new RequestError(400, "Chunk size does not match manifest.");
  if (sha256(body) !== expected.sha256) throw new RequestError(400, "Chunk hash does not match manifest.");
  writeFileSync(path.join(chunkTransferDir(transferId), "chunks", `${index}.part`), body, { mode: 0o600 });
}

async function completeChunkTransfer(manifest: ChunkManifest): Promise<{ staged_name: string }> {
  if (!config.photoUpload.serviceToken) throw new RequestError(503, "PORTAL_SERVICE_TOKEN is required to stage chunked photos.");
  const directory = chunkTransferDir(manifest.transfer_id);
  const assembled = path.join(directory, "assembled.tmp");
  const hash = createHash("sha256");
  let total = 0;
  writeFileSync(assembled, "");
  for (const chunk of manifest.chunks) {
    const chunkFile = path.join(directory, "chunks", `${chunk.index}.part`);
    if (!existsSync(chunkFile)) throw new RequestError(409, `Chunk ${chunk.index} is missing.`);
    const body = readFileSync(chunkFile);
    if (body.length !== chunk.size_bytes || sha256(body) !== chunk.sha256) throw new RequestError(409, `Chunk ${chunk.index} failed verification.`);
    total += body.length;
    hash.update(body);
    appendFileSync(assembled, body);
  }
  if (total !== manifest.size_bytes || hash.digest("hex") !== manifest.file_sha256) {
    throw new RequestError(409, "Assembled file failed verification.");
  }
  const response = await fetch(`${config.photoUpload.apiUrl.replace(/\/+$/, "")}/api/internal/photo-upload/stage`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.photoUpload.serviceToken}`,
      "content-type": "application/octet-stream",
      "x-frame-filename": manifest.filename,
      "x-frame-transfer-id": manifest.transfer_id,
      "x-frame-file-size": String(manifest.size_bytes),
    },
    body: readFileSync(assembled),
  });
  const payload = await response.json().catch(() => ({})) as JsonRecord;
  if (!response.ok) throw new RequestError(502, stringValue(payload.error) || "Photo Upload rejected the assembled file.");
  rmSync(directory, { recursive: true, force: true });
  return { staged_name: stringValue(payload.staged_name) || manifest.filename };
}

function chunkTransferDir(transferId: string): string {
  return path.join(storePaths.chunkUploads, safeTransferId(transferId));
}

function safePositiveInt(value: unknown, label: string, minimum: number, maximum: number): number {
  const text = String(value ?? "");
  if (!/^\d+$/.test(text)) throw new RequestError(400, `${label} must be an integer.`);
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RequestError(400, `${label} must be from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function safeNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  const text = String(value ?? "");
  if (!/^\d+(\.\d+)?$/.test(text)) throw new RequestError(400, `${label} must be a number.`);
  const parsed = Number.parseFloat(text);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new RequestError(400, `${label} must be from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function safeTransferId(value: string): string {
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(value)) throw new RequestError(400, "transfer_id must be 8-96 letters, numbers, dashes, or underscores.");
  return value;
}

function safeSha256(value: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new RequestError(400, "SHA256 values must be 64 hex characters.");
  return value.toLowerCase();
}

function safePhotoFilename(value: string): string {
  const parsed = path.parse(path.basename(value));
  const stem = parsed.name
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 96) || "photo";
  const extension = parsed.ext.toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 12) || ".jpg";
  return `${stem}${extension}`;
}

function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function ftpConnectorTargetReady(input?: Pick<FtpConnectorInput, "targetHost" | "targetPort">): boolean {
  return Boolean((input?.targetHost || config.ftpConnector.host) && (input?.targetPort || config.ftpConnector.port) && config.ftpConnector.username && config.ftpConnector.password);
}

function safeDisplayName(value: unknown): string {
  const displayName = stringValue(value);
  if (!displayName || displayName.length > 64 || /[\r\n]/.test(displayName)) {
    throw new RequestError(400, "Device name must be between 1 and 64 characters on one line.");
  }
  return displayName;
}

function assertUniqueDisplayName(displayName: string, deviceId: string): void {
  const normalized = displayName.toLocaleLowerCase();
  const duplicate = provisionedDevices.find((record) => record.device_id !== deviceId && (
    record.device_id.toLocaleLowerCase() === normalized
    || (record.display_name || record.device_id).toLocaleLowerCase() === normalized
  ));
  if (duplicate) throw new RequestError(409, `Device name is already assigned to ${duplicate.device_id}.`);
}

function parsePairInput(body: unknown): PairInput {
  const data = body && typeof body === "object" ? body as JsonRecord : {};
  const host = safeHost(requiredString(data.host, "Belabox host"));
  const user = safeUser(requiredString(data.user, "SSH username"));
  const port = bodyPort(data.port);
  const password = stringValue(data.password) || "";
  if (!password) throw new RequestError(400, "SSH password is required.");
  const deviceId = sanitizeDeviceId(stringValue(data.device_id) || `belabox-${host.replace(/[^A-Za-z0-9]+/g, "-")}`);
  const displayName = stringValue(data.display_name) ? safeDisplayName(data.display_name) : undefined;
  if (displayName) assertUniqueDisplayName(displayName, deviceId);
  return {
    host,
    user,
    port,
    password,
    privateKey: "",
    deviceId,
    displayName,
    installDiagnostics: data.install_diagnostics === true,
    enableSshOnBoot: data.enable_ssh_on_boot === true,
    rememberSsh: data.remember_ssh === true,
  };
}

function parsePairJobInput(body: unknown): PairInput {
  const data = body && typeof body === "object" ? body as JsonRecord : {};
  if (stringValue(data.password)) return parsePairInput(body);
  const requestedDeviceId = sanitizeDeviceId(stringValue(data.device_id) || "");
  if (!requestedDeviceId || !provisionedDevices.some((device) => device.device_id === requestedDeviceId)) {
    return parsePairInput(body);
  }
  let saved: PairInput | null = null;
  try {
    saved = savedSshCredential(requestedDeviceId);
  } catch {
    throw new RequestError(400, "Saved SSH credential could not be decrypted. Enter SSH credentials in SSH Maintenance and save again.");
  }
  if (!saved) throw new RequestError(400, "Saved SSH credential is not available. Enter the SSH password in SSH Maintenance and save it again.");
  return {
    ...saved,
    installDiagnostics: data.install_diagnostics === true,
    enableSshOnBoot: data.enable_ssh_on_boot === true,
    rememberSsh: false,
  };
}

function parseSpeedTestInput(body: unknown): { deviceId: string; bytes: number; parallel: number; target: "internet" | "frame"; interfaceName: string } {
  const data = body && typeof body === "object" ? body as JsonRecord : {};
  const deviceId = sanitizeDeviceId(stringValue(data.device_id) || "");
  if (!provisionedDevices.some((device) => device.device_id === deviceId)) throw new RequestError(404, "Device is not provisioned.");
  const live = deviceList().find((device) => device.device_id === deviceId);
  if (!live?.online) throw new RequestError(409, "Belabox agent must be online before running diagnostics.");
  const target = stringValue(data.target) || "internet";
  if (target !== "internet" && target !== "frame") throw new RequestError(400, "target must be internet or frame.");
  const interfaceName = stringValue(data.interface_name) || "all";
  if (!/^(all|[A-Za-z0-9_.:-]{1,64})$/.test(interfaceName)) throw new RequestError(400, "interface_name is invalid.");
  return {
    deviceId,
    bytes: data.bytes === undefined ? config.diagnostics.uploadBytes : safePositiveInt(data.bytes, "bytes", 64 * 1024, config.diagnostics.maxUploadBytes),
    parallel: data.parallel === undefined ? config.diagnostics.parallel : safePositiveInt(data.parallel, "parallel", 1, 8),
    target,
    interfaceName,
  };
}

function sshInputForMaintenance(body: unknown): PairInput {
  const data = body && typeof body === "object" ? body as JsonRecord : {};
  const requestedDeviceId = sanitizeDeviceId(stringValue(data.device_id) || "");
  const hasInlineSsh = Boolean(stringValue(data.host) && stringValue(data.user) && stringValue(data.password));
  let sshInput: PairInput | null = null;
  if (hasInlineSsh) {
    sshInput = parsePairInput(body);
  } else if (requestedDeviceId) {
    try {
      sshInput = savedSshCredential(requestedDeviceId);
    } catch {
      throw new RequestError(400, "Saved SSH credential could not be decrypted. Enter SSH credentials in SSH Maintenance and save again.");
    }
  }
  if (!sshInput) throw new RequestError(400, "SSH credentials are required. Open SSH Maintenance, enter local IP and SSH login, then retry.");
  return sshInput;
}

function parseFtpConnectorInput(body: unknown): FtpConnectorInput {
  const data = body && typeof body === "object" ? body as JsonRecord : {};
  const targetHost = safeFtpHost(stringValue(data.target_host) || config.ftpConnector.host);
  if (!targetHost) throw new RequestError(400, "FRAME Photo FTP external host/IP is required.");
  const sshInput = sshInputForMaintenance(body);
  return {
    ...sshInput,
    targetHost,
    targetPort: requestPort(data.target_port ?? config.ftpConnector.port, "FRAME Photo FTP port"),
    cameraUsername: data.camera_username === undefined ? "" : safeFtpUsername(requiredString(data.camera_username, "Camera FTP username")),
    cameraPassword: safeFtpPassword(stringValue(data.camera_password) || ""),
  };
}

function parseAgentRemoveInput(body: unknown): PairInput & { purge: boolean } {
  const data = body && typeof body === "object" ? body as JsonRecord : {};
  return {
    ...sshInputForMaintenance(body),
    purge: data.purge === true,
  };
}

async function installAgent(input: PairInput, device: ProvisionedDevice): Promise<void> {
  const dir = "$HOME/.frame-belabox-agent";
  const agent = readFileSync(path.join(process.cwd(), "agent", "belabox-agent.mjs"), "utf8");
  const sudoPasswordB64 = input.password ? Buffer.from(input.password, "utf8").toString("base64") : "";
  const relayProbeUrl = new URL(config.mqtt.publicHost);
  const envFile = [
    `BELABOX_DEVICE_ID=${device.device_id}`,
    `BELABOX_MQTT_USERNAME=${device.mqtt_username}`,
    `BELABOX_MQTT_PASSWORD=${device.mqtt_password}`,
    `BELABOX_MQTT_URL=${websocketUrl()}`,
    `BELABOX_COMMAND_SIGNING_PUBLIC_KEY_B64=${Buffer.from(signingKeys.publicKeyPem, "utf8").toString("base64")}`,
    `BELABOX_HEARTBEAT_INTERVAL_MS=${config.mqtt.heartbeatMs}`,
    `BELABOX_TELEMETRY_INTERVAL_MS=${config.mqtt.telemetryMs}`,
    `BELABOX_ACTIVE_PHOTO_TELEMETRY_INTERVAL_MS=${config.mqtt.activePhotoTelemetryMs}`,
    `BELABOX_MQTT_RECONNECT_MS=${config.mqtt.reconnectMs}`,
    `BELABOX_MQTT_KEEPALIVE=${config.mqtt.keepalive}`,
    `BELABOX_RELAY_PROBE_HOST=${relayProbeUrl.hostname}`,
    `BELABOX_RELAY_PROBE_PORT=${relayProbeUrl.port || (relayProbeUrl.protocol === "https:" ? "443" : "80")}`,
    `BELABOX_CHUNK_UPLOAD_URL=${config.chunkUpload.publicUrl}`,
    `BELABOX_CHUNK_UPLOAD_TOKEN=${device.mqtt_password}`,
    `BELABOX_DIAGNOSTIC_UPLOAD_URL=${diagnosticUploadUrl()}`,
    `BELABOX_REMOTE_BELAUI_ENABLED=${config.remoteBelaui.enabled ? "true" : "false"}`,
    `BELABOX_REMOTE_BELAUI_LOCAL_URL=${config.remoteBelaui.localUrl}`,
    `BELABOX_REMOTE_BELAUI_REWRITE_WS=${config.remoteBelaui.rewriteWebSocket ? "true" : "false"}`,
    "BELABOX_PHOTO_AGENT_STATUS_PATH=$HOME/.frame-belabox-agent/photo-agent/status.json",
    "BELABOX_FTP_CONNECTOR_STATUS_PATH=$HOME/.frame-belabox-agent/photo-agent/status.json",
    "BELABOX_EGRESS_STATUS_PATH=$HOME/.frame-belabox-agent/egress.json",
    "BELABOX_PHOTO_CONFIG_PATH=$HOME/.frame-belabox-agent/photo-config.json",
    "BELABOX_RELAY_CATALOG_PATH=$HOME/.frame-belabox-agent/relay-catalog.json",
  ].join("\n");
  const pkg = JSON.stringify({ type: "module", dependencies: { mqtt: "^4.3.8" } }, null, 2);
  const script = `set -eu
umask 077
sudo_password_b64='${sudoPasswordB64}'
agent_user="$(id -un)"
home_dir="$(cd "$HOME" && pwd)"
agent_dir="${dir}"
mkdir -p "$agent_dir"
cat > "$agent_dir/belabox-agent.mjs" <<'FRAME_AGENT_EOF'
${agent}
FRAME_AGENT_EOF
cat > "$agent_dir/agent.env" <<'FRAME_ENV_EOF'
${envFile}
FRAME_ENV_EOF
cat > "$agent_dir/package.json" <<'FRAME_PACKAGE_EOF'
${pkg}
FRAME_PACKAGE_EOF
chmod 700 "$agent_dir"
chmod 600 "$agent_dir/agent.env"
chmod 700 "$agent_dir/belabox-agent.mjs"
sudo_run() {
  if ! command -v sudo >/dev/null 2>&1; then return 1; fi
  if sudo -n true 2>/dev/null; then sudo "$@"; return $?; fi
  if [ -n "$sudo_password_b64" ] && command -v base64 >/dev/null 2>&1; then
    printf %s "$sudo_password_b64" | base64 -d | sudo -S -p '' "$@"
    return $?
  fi
  return 1
}
node_bin="$(command -v node || command -v nodejs || true)"
npm_bin="$(command -v npm || true)"
if { [ -z "$node_bin" ] || [ -z "$npm_bin" ]; } && command -v apt-get >/dev/null 2>&1; then
  sudo_run apt-get update >/dev/null && sudo_run apt-get install -y nodejs npm >/dev/null || true
  node_bin="$(command -v node || command -v nodejs || true)"
  npm_bin="$(command -v npm || true)"
fi
if [ -z "$node_bin" ] || [ -z "$npm_bin" ]; then echo "node_and_npm_required" >&2; exit 42; fi
if [ "${input.installDiagnostics ? "1" : "0"}" = "1" ] && command -v apt-get >/dev/null 2>&1; then
  sudo_run apt-get update >/dev/null && sudo_run apt-get install -y iperf3 >/dev/null || true
fi
enable_ssh_on_boot() {
  if ! command -v systemctl >/dev/null 2>&1; then return 1; fi
  sudo_run systemctl enable --now ssh.service >/dev/null 2>&1 || sudo_run systemctl enable --now ssh >/dev/null 2>&1
}
if [ "${input.enableSshOnBoot ? "1" : "0"}" = "1" ] && ! enable_ssh_on_boot; then
  echo "ssh_enable_on_boot_failed" >&2
  exit 45
fi
"$npm_bin" --prefix "$agent_dir" install --omit=dev --no-audit --no-fund >/dev/null
if ! "$node_bin" --check "$agent_dir/belabox-agent.mjs" >/dev/null; then
  echo "agent_runtime_syntax_check_failed" >&2
  exit 46
fi
start_agent_background() {
  ( cd "$agent_dir"; set -a; . "$agent_dir/agent.env"; set +a; nohup "$node_bin" "$agent_dir/belabox-agent.mjs" >> "$agent_dir/agent.log" 2>&1 & echo $! > "$agent_dir/agent.pid" )
}
install_crontab_fallback() {
  if command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -v 'frame-belabox-agent'; printf '@reboot cd %s && set -a && . %s/agent.env && set +a && %s %s/belabox-agent.mjs >> %s/agent.log 2>&1\\n' "$agent_dir" "$agent_dir" "$node_bin" "$agent_dir" "$agent_dir") | crontab - || true
  fi
}
install_system_service() {
  service_file="$(mktemp)"
  cat > "$service_file" <<FRAME_SYSTEM_SERVICE_EOF
[Unit]
Description=FRAME Belabox Agent
After=network-online.target

[Service]
Type=forking
User=$agent_user
WorkingDirectory=$agent_dir
PIDFile=$agent_dir/agent.pid
ExecStart=/bin/sh -lc 'set -a && . ./agent.env && set +a && nohup $node_bin ./belabox-agent.mjs >> ./agent.log 2>&1 & echo \\$! > ./agent.pid'
ExecStop=/bin/sh -lc 'test -f $agent_dir/agent.pid && kill \\$(cat $agent_dir/agent.pid) 2>/dev/null || true'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
FRAME_SYSTEM_SERVICE_EOF
  if sudo_run install -m 0644 "$service_file" /etc/systemd/system/frame-belabox-agent.service; then
    sudo_run systemctl daemon-reload
    sudo_run systemctl enable frame-belabox-agent.service >/dev/null
    sudo_run systemctl restart frame-belabox-agent.service
    rm -f "$service_file"
    return 0
  fi
  rm -f "$service_file"
  return 1
}
sudo_run systemctl stop frame-belabox-agent.service >/dev/null 2>&1 || true
if command -v systemctl >/dev/null 2>&1; then systemctl --user stop frame-belabox-agent.service >/dev/null 2>&1 || true; fi
pkill -f "$agent_dir/belabox-agent.mjs" 2>/dev/null || true
if install_system_service; then
  :
elif command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
  sudo_run loginctl enable-linger "$agent_user" >/dev/null 2>&1 || true
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/frame-belabox-agent.service" <<FRAME_SERVICE_EOF
[Unit]
Description=FRAME Belabox Agent
After=network-online.target

[Service]
Type=forking
WorkingDirectory=%h/.frame-belabox-agent
PIDFile=%h/.frame-belabox-agent/agent.pid
ExecStart=/bin/sh -lc 'set -a && . ./agent.env && set +a && nohup $node_bin ./belabox-agent.mjs >> ./agent.log 2>&1 & echo \\$! > ./agent.pid'
ExecStop=/bin/sh -lc 'test -f %h/.frame-belabox-agent/agent.pid && kill \\$(cat %h/.frame-belabox-agent/agent.pid) 2>/dev/null || true'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
FRAME_SERVICE_EOF
  systemctl --user daemon-reload
  systemctl --user enable frame-belabox-agent.service >/dev/null
  install_crontab_fallback
  start_agent_background
else
  install_crontab_fallback
  start_agent_background
fi
printf frame-belabox-agent-installed
`;
  const result = await runPairSsh(input, ["sh", "-s"], script, 300000);
  if (!result.stdout.includes("frame-belabox-agent-installed")) throw new RequestError(502, "Agent install did not complete.");
}

async function uninstallAgent(input: PairInput & { purge: boolean }): Promise<JsonRecord> {
  const sudoPasswordB64 = input.password ? Buffer.from(input.password, "utf8").toString("base64") : "";
  const script = `set -eu
sudo_password_b64='${sudoPasswordB64}'
agent_dir="$HOME/.frame-belabox-agent"
purge="${input.purge ? "1" : "0"}"
sudo_run() {
  if ! command -v sudo >/dev/null 2>&1; then return 1; fi
  if sudo -n true 2>/dev/null; then sudo "$@"; return $?; fi
  if [ -n "$sudo_password_b64" ] && command -v base64 >/dev/null 2>&1; then
    printf %s "$sudo_password_b64" | base64 -d | sudo -S -p '' "$@"
    return $?
  fi
  return 1
}
remove_system_unit() {
  unit="$1"
  sudo_run systemctl disable --now "$unit" >/dev/null 2>&1 || true
  if [ -f "/etc/systemd/system/$unit" ]; then
    sudo_run rm -f "/etc/systemd/system/$unit" || { echo "failed_to_remove_system_unit:$unit" >&2; exit 46; }
  fi
}
remove_user_unit() {
  unit="$1"
  if command -v systemctl >/dev/null 2>&1; then systemctl --user disable --now "$unit" >/dev/null 2>&1 || true; fi
  rm -f "$HOME/.config/systemd/user/$unit"
}
remove_system_unit frame-belabox-ftp-connector.service
remove_system_unit frame-belabox-photo-agent.service
remove_system_unit frame-belabox-agent.service
if command -v systemctl >/dev/null 2>&1; then sudo_run systemctl daemon-reload >/dev/null 2>&1 || true; fi
remove_user_unit frame-belabox-ftp-connector.service
remove_user_unit frame-belabox-photo-agent.service
remove_user_unit frame-belabox-agent.service
if command -v systemctl >/dev/null 2>&1; then systemctl --user daemon-reload >/dev/null 2>&1 || true; fi
if command -v crontab >/dev/null 2>&1; then
  crontab -l 2>/dev/null | grep -v 'frame-belabox-agent\\|frame-belabox-ftp-connector\\|frame-belabox-photo-agent' | crontab - || true
fi
pkill -f "$agent_dir/ftp-connector/ftp-connector.py" 2>/dev/null || true
pkill -f "$agent_dir/photo-agent/photo-agent.py" 2>/dev/null || true
pkill -f "$agent_dir/belabox-agent.mjs" 2>/dev/null || true
if [ -x /usr/local/sbin/frame-belabox-relay-sync ]; then sudo_run /usr/local/sbin/frame-belabox-relay-sync --remove >/dev/null 2>&1 || true; fi
sudo_run rm -f /etc/sudoers.d/frame-belabox-relay-sync /etc/frame-belabox-relay-sync.json /usr/local/sbin/frame-belabox-relay-sync >/dev/null 2>&1 || true
sudo_run rm -rf /usr/local/lib/frame-belabox /var/lib/frame-belabox-relay-sync >/dev/null 2>&1 || true
if [ "$purge" = "1" ]; then
  rm -rf "$agent_dir"
  printf 'frame-belabox-agent-removed purge'
elif [ -d "$agent_dir" ]; then
  archive="$HOME/.frame-belabox-agent.removed-$(date +%Y%m%d%H%M%S)"
  mv "$agent_dir" "$archive"
  printf 'frame-belabox-agent-removed archive=%s' "$archive"
else
  printf 'frame-belabox-agent-removed missing'
fi
`;
  const result = await runPairSsh(input, ["sh", "-s"], script, 120000);
  if (!result.stdout.includes("frame-belabox-agent-removed")) throw new RequestError(502, "Agent uninstall did not complete.");
  const summary = result.stdout.trim().slice(0, 300);
  return {
    removed: true,
    device_id: input.deviceId,
    purge: input.purge,
    summary,
  };
}

async function runFtpConnectorJob(jobId: string, input: FtpConnectorInput): Promise<void> {
  const job = ftpConnectorJobs.get(jobId);
  if (!job) return;
  try {
    updatePairJob(job, "Validating SSH access");
    await runPairSsh(input, ["printf frame-belabox-ok"], "", 10000);
    updatePairJob(job, "Refreshing Belabox agent");
    const record = upsertProvisionedDevice(input.deviceId, false, true, input.host);
    await installAgent(input, record);
    updatePairJob(job, "Installing Photo Agent");
    const result = await installFtpConnector(input);
    job.status = "success";
    job.result = result;
    updatePairJob(job, "Photo Agent installed");
  } catch (error) {
    job.status = "error";
    job.error = friendlyFtpConnectorError(errorMessage(error), input);
    updatePairJob(job, "Photo Agent setup failed");
  } finally {
    job.finished_at = new Date().toISOString();
    job.updated_at = job.finished_at;
  }
}

async function installFtpConnector(input: FtpConnectorInput): Promise<JsonRecord> {
  if (!ftpConnectorTargetReady(input)) {
    throw new RequestError(400, "FRAME Photo FTP target is not configured. Check PHOTO_FTP_PASSIVE_HOST, PHOTO_FTP_USERNAME, and PHOTO_FTP_PASSWORD.");
  }
  const device = provisionedDevices.find((record) => record.device_id === input.deviceId) || upsertProvisionedDevice(input.deviceId, false, true, input.host);
  const record = upsertFtpConnector(input.deviceId, input);
  const connector = readFileSync(path.join(process.cwd(), "agent", "photo-agent.py"), "utf8");
  const sudoPasswordB64 = input.password ? Buffer.from(input.password, "utf8").toString("base64") : "";
  const script = `set -eu
umask 077
sudo_password_b64='${sudoPasswordB64}'
agent_user="$(id -un)"
home_dir="$(cd "$HOME" && pwd)"
agent_dir="$HOME/.frame-belabox-agent"
connector_dir="$agent_dir/photo-agent"
spool_dir="$agent_dir/photo-spool"
upload_dir="$spool_dir/incoming"
ready_dir="$spool_dir/ready"
processed_dir="$spool_dir/processed"
inflight_dir="$spool_dir/inflight"
mkdir -p "$connector_dir" "$upload_dir" "$ready_dir" "$processed_dir" "$inflight_dir" "$spool_dir/done" "$spool_dir/failed"
decode() { printf %s "$1" | base64 -d; }
cat > "$connector_dir/photo-agent.py" <<'FRAME_PHOTO_AGENT_EOF'
${connector}
FRAME_PHOTO_AGENT_EOF
{
  printf 'BELABOX_DEVICE_ID=%s\\n' "$(decode '${b64(input.deviceId)}')"
  printf 'FRAME_FTP_HOST=%s\\n' "$(decode '${b64(input.targetHost)}')"
  printf 'FRAME_FTP_PORT=%s\\n' '${input.targetPort}'
  printf 'FRAME_FTP_USERNAME=%s\\n' "$(decode '${b64(config.ftpConnector.username)}')"
  printf 'FRAME_FTP_PASSWORD=%s\\n' "$(decode '${b64(config.ftpConnector.password)}')"
  printf 'FRAME_FTP_REMOTE_DIR=%s\\n' "$(decode '${b64(config.ftpConnector.remoteDir)}')"
  printf 'FRAME_FTP_UPLOAD_DIR=%s\\n' "$upload_dir"
  printf 'FRAME_FTP_READY_DIR=%s\\n' "$ready_dir"
  printf 'FRAME_FTP_PROCESSED_DIR=%s\\n' "$processed_dir"
  printf 'FRAME_FTP_INFLIGHT_DIR=%s\\n' "$inflight_dir"
  printf 'FRAME_PHOTO_AGENT_STATUS_PATH=%s\\n' "$connector_dir/status.json"
  printf 'FRAME_FTP_STATUS_PATH=%s\\n' "$connector_dir/status.json"
  printf 'FRAME_PHOTO_CONFIG_PATH=%s\\n' "$agent_dir/photo-config.json"
  printf 'FRAME_EGRESS_STATUS_PATH=%s\\n' "$agent_dir/egress.json"
  printf 'FRAME_PHOTO_TRANSFER_MODE=direct_ftp\\n'
  printf 'FRAME_CHUNK_UPLOAD_URL=%s\\n' "$(decode '${b64(config.chunkUpload.publicUrl)}')"
  printf 'FRAME_CHUNK_UPLOAD_TOKEN=%s\\n' "$(decode '${b64(device.mqtt_password)}')"
  printf 'FRAME_CHUNK_SIZE_BYTES=%s\\n' '${config.chunkUpload.chunkSizeBytes}'
  printf 'FRAME_CHUNK_PARALLEL_UPLOADS=%s\\n' '${config.chunkUpload.parallelUploads}'
  printf 'FRAME_CHUNK_UPLOAD_KBPS=%s\\n' '${config.chunkUpload.uploadKbps}'
  printf 'FRAME_CAMERA_FTP_USERNAME=%s\\n' "$(decode '${b64(record.camera_username)}')"
  printf 'FRAME_CAMERA_FTP_PASSWORD=%s\\n' "$(decode '${b64(record.camera_password)}')"
  printf 'FRAME_CAMERA_FTP_HOST=0.0.0.0\\n'
  printf 'FRAME_CAMERA_FTP_PORT=%s\\n' '${config.ftpConnector.cameraPort}'
} > "$connector_dir/photo-agent.env"
chmod 700 "$connector_dir" "$connector_dir/photo-agent.py"
chmod 600 "$connector_dir/photo-agent.env"
sudo_run() {
  if ! command -v sudo >/dev/null 2>&1; then return 1; fi
  if sudo -n true 2>/dev/null; then sudo "$@"; return $?; fi
  if [ -n "$sudo_password_b64" ] && command -v base64 >/dev/null 2>&1; then
    printf %s "$sudo_password_b64" | base64 -d | sudo -S -p '' "$@"
    return $?
  fi
  return 1
}
python_bin="$(command -v python3 || true)"
if [ -z "$python_bin" ] && command -v apt-get >/dev/null 2>&1; then
  sudo_run apt-get update >/dev/null && sudo_run apt-get install -y python3 >/dev/null || true
  python_bin="$(command -v python3 || true)"
fi
if [ -z "$python_bin" ]; then echo "python3_required" >&2; exit 42; fi
ensure_pyftpdlib() {
  if "$python_bin" - <<'PY' >/dev/null 2>&1
import pyftpdlib
PY
  then return 0; fi
  if command -v apt-get >/dev/null 2>&1 && sudo_run apt-get update >/dev/null && sudo_run apt-get install -y python3-pyftpdlib >/dev/null; then return 0; fi
  if ! "$python_bin" -m pip --version >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then sudo_run apt-get install -y python3-pip >/dev/null || true; fi
  "$python_bin" -m pip install --user pyftpdlib >/dev/null
}
ensure_imagemagick() {
  if command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1; then return 0; fi
  if command -v apt-get >/dev/null 2>&1; then sudo_run apt-get update >/dev/null && sudo_run apt-get install -y imagemagick >/dev/null || true; fi
  return 0
}
ensure_image_processor() {
  if "$python_bin" - <<'PY' >/dev/null 2>&1
from PIL import Image
PY
  then return 0; fi
  if command -v apt-get >/dev/null 2>&1; then
    sudo_run apt-get update >/dev/null && sudo_run apt-get install -y python3-pil >/dev/null || true
  fi
  if "$python_bin" - <<'PY' >/dev/null 2>&1
from PIL import Image
PY
  then return 0; fi
  ensure_imagemagick
}
test_frame_ftp() {
  set -a; . "$connector_dir/photo-agent.env"; set +a
  "$python_bin" - <<'PY'
import ftplib, io, os, time
name = f".frame-belabox-connector-test-{int(time.time())}.tmp"
with ftplib.FTP() as ftp:
    ftp.connect(os.environ["FRAME_FTP_HOST"], int(os.environ["FRAME_FTP_PORT"]), timeout=20)
    ftp.login(os.environ["FRAME_FTP_USERNAME"], os.environ["FRAME_FTP_PASSWORD"])
    ftp.set_pasv(True)
    remote_dir = os.environ.get("FRAME_FTP_REMOTE_DIR", "/")
    if remote_dir and remote_dir != "/":
        ftp.cwd(remote_dir)
    ftp.storbinary(f"STOR {name}", io.BytesIO(b"frame-belabox-connector-test"))
    try:
        ftp.delete(name)
    except Exception:
        pass
PY
}
test_local_ftp() {
  set -a; . "$connector_dir/photo-agent.env"; set +a
  for _ in $(seq 1 30); do
    if "$python_bin" - <<'PY' >/dev/null 2>&1
import ftplib, io, os, time
name = f".frame-belabox-local-test-{int(time.time())}.tmp"
with ftplib.FTP() as ftp:
    ftp.connect("127.0.0.1", int(os.environ["FRAME_CAMERA_FTP_PORT"]), timeout=3)
    ftp.login(os.environ["FRAME_CAMERA_FTP_USERNAME"], os.environ["FRAME_CAMERA_FTP_PASSWORD"])
    ftp.storbinary(f"STOR {name}", io.BytesIO(b"frame-belabox-local-test"))
    try:
        ftp.delete(name)
    except Exception:
        pass
PY
    then return 0; fi
    sleep 1
  done
  return 1
}
start_connector_background() {
  ( cd "$connector_dir"; set -a; . "$connector_dir/photo-agent.env"; set +a; nohup "$python_bin" "$connector_dir/photo-agent.py" >> "$connector_dir/photo-agent.log" 2>&1 & echo $! > "$connector_dir/photo-agent.pid" )
}
install_crontab_fallback() {
  if command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -v 'frame-belabox-ftp-connector\\|frame-belabox-photo-agent'; printf '@reboot cd %s && set -a && . %s/photo-agent.env && set +a && %s %s/photo-agent.py >> %s/photo-agent.log 2>&1\\n' "$connector_dir" "$connector_dir" "$python_bin" "$connector_dir" "$connector_dir") | crontab - || true
  fi
}
install_system_service() {
  service_file="$(mktemp)"
  cat > "$service_file" <<FRAME_PHOTO_AGENT_SERVICE_EOF
[Unit]
Description=FRAME Belabox Photo Agent
After=network-online.target frame-belabox-agent.service
Wants=network-online.target

[Service]
Type=simple
User=$agent_user
WorkingDirectory=$connector_dir
Environment=HOME=$home_dir
EnvironmentFile=$connector_dir/photo-agent.env
ExecStart=$python_bin $connector_dir/photo-agent.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
FRAME_PHOTO_AGENT_SERVICE_EOF
  if sudo_run install -m 0644 "$service_file" /etc/systemd/system/frame-belabox-photo-agent.service; then
    sudo_run systemctl daemon-reload
    sudo_run systemctl enable frame-belabox-photo-agent.service >/dev/null
    sudo_run systemctl restart frame-belabox-photo-agent.service
    rm -f "$service_file"
    return 0
  fi
  rm -f "$service_file"
  return 1
}
sudo_run systemctl disable --now frame-belabox-ftp-connector.service >/dev/null 2>&1 || true
sudo_run systemctl stop frame-belabox-photo-agent.service >/dev/null 2>&1 || true
sudo_run rm -f /etc/systemd/system/frame-belabox-ftp-connector.service >/dev/null 2>&1 || true
if command -v systemctl >/dev/null 2>&1; then systemctl --user disable --now frame-belabox-ftp-connector.service >/dev/null 2>&1 || true; fi
if command -v systemctl >/dev/null 2>&1; then systemctl --user stop frame-belabox-photo-agent.service >/dev/null 2>&1 || true; fi
rm -f "$HOME/.config/systemd/user/frame-belabox-ftp-connector.service"
pkill -f "$agent_dir/ftp-connector/ftp-connector.py" 2>/dev/null || true
pkill -f "$connector_dir/photo-agent.py" 2>/dev/null || true
if [ -d "$agent_dir/ftp-connector" ]; then mv "$agent_dir/ftp-connector" "$agent_dir/ftp-connector.removed-$(date +%Y%m%d%H%M%S)" 2>/dev/null || true; fi
ensure_pyftpdlib || { echo "pyftpdlib_install_failed" >&2; exit 43; }
ensure_image_processor
test_frame_ftp || { echo "frame_ftp_test_failed" >&2; exit 44; }
if install_system_service; then
  :
elif command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
  sudo_run loginctl enable-linger "$agent_user" >/dev/null 2>&1 || true
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/frame-belabox-photo-agent.service" <<FRAME_PHOTO_AGENT_USER_SERVICE_EOF
[Unit]
Description=FRAME Belabox Photo Agent
After=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/.frame-belabox-agent/photo-agent
EnvironmentFile=%h/.frame-belabox-agent/photo-agent/photo-agent.env
ExecStart=$python_bin %h/.frame-belabox-agent/photo-agent/photo-agent.py
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
FRAME_PHOTO_AGENT_USER_SERVICE_EOF
  systemctl --user daemon-reload
  systemctl --user enable frame-belabox-photo-agent.service >/dev/null
  install_crontab_fallback
  start_connector_background
else
  install_crontab_fallback
  start_connector_background
fi
test_local_ftp || { echo "camera_ftp_test_failed" >&2; exit 45; }
printf frame-belabox-photo-agent-installed
`;
  const result = await runPairSsh(input, ["sh", "-s"], script, 300000);
  if (!result.stdout.includes("frame-belabox-photo-agent-installed")) throw new RequestError(502, "Photo Agent install did not complete.");
  return {
    installed: true,
    camera_ftp_username: record.camera_username,
    camera_ftp_password: record.camera_password,
    camera_ftp_port: config.ftpConnector.cameraPort,
    upload_dir: "~/.frame-belabox-agent/photo-spool/incoming",
    ready_dir: "~/.frame-belabox-agent/photo-spool/ready",
    processed_dir: "~/.frame-belabox-agent/photo-spool/processed",
    target_host: input.targetHost,
    target_port: input.targetPort,
    chunk_upload_url: config.chunkUpload.publicUrl,
  };
}

async function runPairSsh(input: PairInput, remoteCommand: string[], stdin = "", timeoutMs = config.requestTimeoutMs) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "frame-belabox-"));
  try {
    const sshArgs = [
      "-p",
      String(input.port),
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `ConnectTimeout=${Math.max(1, Math.ceil(config.requestTimeoutMs / 1000))}`,
    ];
    if (input.privateKey) {
      const keyPath = path.join(tempDir, "key");
      writeFileSync(keyPath, input.privateKey.endsWith("\n") ? input.privateKey : `${input.privateKey}\n`, { mode: 0o600 });
      sshArgs.push("-i", keyPath, "-o", "BatchMode=yes");
    }
    sshArgs.push("--", `${input.user}@${input.host}`, ...remoteCommand);
    if (!input.privateKey && input.password) {
      const passwordPath = path.join(tempDir, "password");
      writeFileSync(passwordPath, input.password, { mode: 0o600 });
      return await runProcess("sshpass", ["-f", passwordPath, "ssh", ...sshArgs], stdin, timeoutMs);
    }
    return await runProcess("ssh", sshArgs, stdin, timeoutMs);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runProcess(file: string, args: string[], stdin: string, timeoutMs: number) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new RequestError(504, "SSH operation timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8").slice(0, 128 * 1024); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8").slice(0, 128 * 1024); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new RequestError(502, `SSH operation failed: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new RequestError(502, sanitizeLogLine(stderr || stdout || `SSH exited with code ${code}`).slice(0, 500)));
    });
    child.stdin.end(stdin);
  });
}

function syncBrokerAuthFiles(): void {
  const passwordLines = [
    `${config.mqtt.username}:${hashMosquittoPassword(config.mqtt.password || randomSecret(32))}`,
    ...provisionedDevices.map((device) => `${device.mqtt_username}:${hashMosquittoPassword(device.mqtt_password)}`),
  ];
  writeFileSync(storePaths.brokerPasswords, `${passwordLines.join("\n")}\n`, { mode: 0o640 });
  writeFileSync(storePaths.brokerAcl, `${brokerAcl()}\n`, { mode: 0o640 });
  hardenBrokerAuthFile(storePaths.brokerPasswords);
  hardenBrokerAuthFile(storePaths.brokerAcl);
}

function hardenBrokerAuthFile(filePath: string): void {
  try {
    chownSync(filePath, 1883, 1883);
  } catch {
    // Best effort for local development where the broker UID may not exist.
  }
  chmodSync(filePath, 0o640);
}

function brokerAcl(): string {
  const manager = [
    `user ${config.mqtt.username}`,
    "topic read frame/belabox/+/status",
    "topic write frame/belabox/+/status",
    "topic read frame/belabox/+/heartbeat",
    "topic read frame/belabox/+/telemetry",
    "topic read frame/belabox/+/relay/health",
    "topic read frame/belabox/+/logs",
    "topic read frame/belabox/+/agent/version",
    "topic write frame/belabox/+/agent/version",
    "topic write frame/belabox/+/cmd/request",
    "topic read frame/belabox/+/cmd/response",
    "topic write frame/belabox/+/proxy/http/request/+",
    "topic read frame/belabox/+/proxy/http/response/+",
    "topic write frame/belabox/+/proxy/stream/+/client",
    "topic read frame/belabox/+/proxy/stream/+/server",
  ];
  const deviceRules = provisionedDevices.flatMap((device) => [
    "",
    `user ${device.mqtt_username}`,
    `topic write ${topicFor(device.device_id, TOPICS.status)}`,
    `topic write ${topicFor(device.device_id, TOPICS.heartbeat)}`,
    `topic write ${topicFor(device.device_id, TOPICS.telemetry)}`,
    `topic write ${topicFor(device.device_id, TOPICS.relayHealth)}`,
    `topic write ${topicFor(device.device_id, TOPICS.logs)}`,
    `topic write ${topicFor(device.device_id, TOPICS.version)}`,
    `topic read ${topicFor(device.device_id, TOPICS.cmdRequest)}`,
    `topic write ${topicFor(device.device_id, TOPICS.cmdResponse)}`,
    `topic read ${topicFor(device.device_id, "proxy/http/request/+")}`,
    `topic write ${topicFor(device.device_id, "proxy/http/response/+")}`,
    `topic read ${topicFor(device.device_id, "proxy/stream/+/client")}`,
    `topic write ${topicFor(device.device_id, "proxy/stream/+/server")}`,
  ]);
  return [...manager, ...deviceRules].join("\n");
}

function hashMosquittoPassword(password: string): string {
  const salt = randomBytes(64);
  const hash = pbkdf2Sync(password, salt, 1000, 64, "sha512");
  return `$7$1000$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function signCommand(input: { device_id: string; command: CommandName; args: JsonRecord }) {
  const now = Date.now();
  const unsigned = {
    command_id: randomUUID(),
    device_id: input.device_id,
    command: input.command,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    nonce: randomSecret(16),
    args: input.args,
  };
  const signature = signBytes(null, Buffer.from(canonicalJson(unsigned)), createPrivateKey(signingKeys.privateKeyPem)).toString("base64");
  return { ...unsigned, signature };
}

async function publishSignedCommand(deviceId: string, command: CommandName, args: JsonRecord) {
  const record = provisionedDevices.find((device) => device.device_id === deviceId);
  if (!record) throw new RequestError(404, "Device is not provisioned.");
  validateCommandArgs(command, args);
  const signed = signCommand({ device_id: deviceId, command, args });
  await publishMqtt(topicFor(deviceId, TOPICS.cmdRequest), signed);
  appendAudit({
    at: new Date().toISOString(),
    type: "issued",
    device_id: deviceId,
    command_id: signed.command_id,
    command,
    status: "sent",
  });
  return signed;
}

async function publishMqtt(topic: string, payload: unknown): Promise<void> {
  if (!mqttClient?.connected) throw new RequestError(503, "MQTT manager client is not connected.");
  await new Promise<void>((resolve, reject) => {
    mqttClient?.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function clearRetainedDeviceTopics(deviceId: string): Promise<void> {
  if (!mqttClient?.connected) return;
  await Promise.all([TOPICS.status, TOPICS.version].map((kind) =>
    new Promise<void>((resolve) => {
      mqttClient?.publish(topicFor(deviceId, kind), "", { qos: 1, retain: true }, () => resolve());
    }),
  ));
}

function parseCommandName(value: unknown): CommandName {
  if (typeof value !== "string" || !ALLOWED_COMMANDS.has(value as CommandName)) {
    throw new RequestError(400, "Command is not allowlisted.");
  }
  return value as CommandName;
}

function parseCommandArgs(value: unknown): JsonRecord {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new RequestError(400, "Command args must be an object.");
  const text = JSON.stringify(value);
  if (text.length > 65536) throw new RequestError(400, "Command args are too large.");
  return value as JsonRecord;
}

function validateCommandArgs(command: CommandName, args: JsonRecord): void {
  if (command === "relay_catalog_sync") relayCatalogFromValue(args);
  if (command === "photo_transfer_mode_set" && !["direct_ftp", "chunked_https"].includes(String(args.mode || ""))) {
    throw new RequestError(400, "photo_transfer_mode_set mode must be direct_ftp or chunked_https.");
  }
  if (command === "photo_transport_config_set" && args.chunk_size_bytes !== undefined) {
    safePositiveInt(args.chunk_size_bytes, "chunk_size_bytes", 256 * 1024, 64 * 1024 * 1024);
  }
  if (command === "photo_transport_config_set" && args.chunk_parallel_uploads !== undefined) {
    safePositiveInt(args.chunk_parallel_uploads, "chunk_parallel_uploads", 1, 4);
  }
  if (command === "photo_transport_config_set" && args.chunk_upload_kbps !== undefined) {
    safePositiveInt(args.chunk_upload_kbps, "chunk_upload_kbps", 0, 1000000);
  }
  if (command === "photo_transport_config_set" && args.chunk_upload_url !== undefined) {
    normalizeUrl(stringValue(args.chunk_upload_url) || "");
  }
  if (command === "photo_processing_config_set") {
    if (args.enabled !== undefined && typeof args.enabled !== "boolean") {
      throw new RequestError(400, "photo_processing_config_set enabled must be true or false.");
    }
    if (args.long_edge_px !== undefined) safePositiveInt(args.long_edge_px, "long_edge_px", 0, 12000);
    if (args.jpeg_quality !== undefined) safePositiveInt(args.jpeg_quality, "jpeg_quality", 40, 100);
    if (args.max_output_mb !== undefined) safeNumber(args.max_output_mb, "max_output_mb", 0, 500);
  }
  if (command === "network_speed_test") {
    if (args.mode !== "http_upload" && args.mode !== "interface_speed_test") throw new RequestError(400, "network_speed_test mode is invalid.");
    if (args.target !== undefined && args.target !== "internet" && args.target !== "frame") {
      throw new RequestError(400, "network_speed_test target must be internet or frame.");
    }
    if (args.interface_name !== undefined && (typeof args.interface_name !== "string" || !/^(all|[A-Za-z0-9_.:-]{1,64})$/.test(args.interface_name))) {
      throw new RequestError(400, "network_speed_test interface_name is invalid.");
    }
    if (args.bytes !== undefined) safePositiveInt(args.bytes, "bytes", 64 * 1024, config.diagnostics.maxUploadBytes);
    if (args.parallel !== undefined) safePositiveInt(args.parallel, "parallel", 1, 8);
  }
}

function auditCommandResult(deviceId: string, message: JsonRecord): void {
  appendAudit({
    at: new Date().toISOString(),
    type: "result",
    device_id: deviceId,
    command_id: stringValue(message.command_id) || undefined,
    status: stringValue(message.status) || "unknown",
    result_summary: sanitizeLogLine(stringValue(message.result_summary) || ""),
    error_message: stringValue(message.error_message),
  });
}

function appendAudit(entry: CommandAuditEntry): void {
  commandAudit.push(entry);
  if (commandAudit.length > 200) commandAudit.splice(0, commandAudit.length - 200);
  appendFileSync(storePaths.audit, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function loadAuditLog(): CommandAuditEntry[] {
  if (!existsSync(storePaths.audit)) return [];
  return readFileSync(storePaths.audit, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-200)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CommandAuditEntry];
      } catch {
        return [];
      }
    });
}

function redactDevice(device: ProvisionedDevice) {
  return {
    device_id: device.device_id,
    display_name: device.display_name || device.device_id,
    host: device.host || null,
    mqtt_username: device.mqtt_username,
    password_configured: Boolean(device.mqtt_password),
    created_at: device.created_at,
    updated_at: device.updated_at,
  };
}

function websocketUrl(): string {
  const parsed = new URL(config.mqtt.publicHost);
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  parsed.pathname = config.mqtt.wsPath;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function diagnosticUploadUrl(): string {
  return config.chunkUpload.publicUrl.replace(/\/api\/transfers\/?$/, "/api/diagnostics/speed-test");
}

function relayCatalogFromValue(value: unknown): RelayCatalog {
  const catalog = objectValue(value);
  const servers = objectValue(catalog?.servers);
  const accounts = objectValue(catalog?.accounts);
  if (!catalog || catalog.version !== 1 || typeof catalog.revision !== "string" || !/^[a-f0-9]{64}$/.test(catalog.revision)) {
    throw new RequestError(400, "Relay catalog version or revision is invalid.");
  }
  if (!servers || Object.keys(servers).length < 1 || Object.keys(servers).length > 20 || !accounts || Object.keys(accounts).length > 500) {
    throw new RequestError(400, "Relay catalog server or account count is invalid.");
  }
  for (const [id, value] of Object.entries(servers)) {
    const server = objectValue(value);
    if (!/^frame-[a-z0-9-]{1,64}$/.test(id) || server?.type !== "srtla" || !stringValue(server.name) || !stringValue(server.addr)) {
      throw new RequestError(400, "Relay catalog contains an invalid server.");
    }
    safePositiveInt(server.port, "relay server port", 1, 65535);
  }
  for (const [id, value] of Object.entries(accounts)) {
    const account = objectValue(value);
    if (!/^frame-[a-z0-9-]{1,64}$/.test(id) || !stringValue(account?.name) || !stringValue(account?.ingest_key)) {
      throw new RequestError(400, "Relay catalog contains an invalid account.");
    }
  }
  if (JSON.stringify(catalog).length > 65536) throw new RequestError(400, "Relay catalog is too large.");
  return catalog as unknown as RelayCatalog;
}

function streamDiagnosticBytes(response: express.Response, totalBytes: number): void {
  if (totalBytes <= 0) {
    response.end();
    return;
  }
  const payload = randomBytes(Math.min(64 * 1024, totalBytes));
  let sent = 0;
  const writeMore = (): void => {
    while (sent < totalBytes) {
      const size = Math.min(payload.length, totalBytes - sent);
      sent += size;
      if (!response.write(size === payload.length ? payload : payload.subarray(0, size))) {
        response.once("drain", writeMore);
        return;
      }
    }
    response.end();
  };
  writeMore();
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as JsonRecord).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as JsonRecord)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function deviceList(): DeviceState[] {
  const allowedDeviceIds = new Set(provisionedDevices.map((device) => device.device_id));
  return [...devices.values()].filter((device) => allowedDeviceIds.has(device.device_id)).map((device) => ({
    ...device,
    online: deviceIsOnline(device),
  }));
}

function isProvisionedDevice(deviceId: string): boolean {
  return provisionedDevices.some((device) => device.device_id === deviceId);
}

function deviceIsOnline(device: DeviceState): boolean {
  if (!device.last_heartbeat_at) return false;
  if (heartbeatIsStale(device)) return false;

  const heartbeatAt = Date.parse(device.last_heartbeat_at);
  if (!Number.isFinite(heartbeatAt)) return false;
  const statusAt = device.last_status_at ? Date.parse(device.last_status_at) : 0;
  const state = typeof device.status?.state === "string" ? device.status.state.toLowerCase() : "";
  if (state === "offline" && Number.isFinite(statusAt) && statusAt > heartbeatAt) return false;
  return true;
}

function heartbeatIsStale(device: DeviceState): boolean {
  if (!device.last_heartbeat_at) return false;
  const age = Date.now() - Date.parse(device.last_heartbeat_at);
  return Number.isFinite(age) && age > Math.max(config.mqtt.heartbeatMs * 3, 30000);
}

function ensureDevice(deviceId: string): DeviceState {
  const existing = devices.get(deviceId);
  if (existing) return existing;
  const created: DeviceState = {
    device_id: deviceId,
    online: false,
    status: null,
    last_status_at: null,
    last_heartbeat_at: null,
    last_telemetry_at: null,
    agent_version: null,
    telemetry: null,
    relay_health: null,
    logs: [],
    command_interface_enabled: false,
  };
  devices.set(deviceId, created);
  return created;
}

function parseTopic(topic: string): { deviceId: string; kind: string } | null {
  const match = /^frame\/belabox\/([^/]+)\/(.+)$/.exec(topic);
  if (!match) return null;
  return { deviceId: match[1], kind: match[2] };
}

function parsePayload(payload: Buffer): JsonRecord {
  return parseJsonPayload(payload, 16 * 1024);
}

function parseJsonPayload(payload: Buffer, maxBytes: number): JsonRecord {
  const text = payload.toString("utf8").slice(0, maxBytes);
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonRecord : { value: parsed };
  } catch {
    return { message: text };
  }
}

function topicTemplates() {
  return {
    status: topicFor("{device_id}", TOPICS.status),
    heartbeat: topicFor("{device_id}", TOPICS.heartbeat),
    telemetry: topicFor("{device_id}", TOPICS.telemetry),
    relay_health: topicFor("{device_id}", TOPICS.relayHealth),
    logs: topicFor("{device_id}", TOPICS.logs),
    version: topicFor("{device_id}", TOPICS.version),
    cmd_request: topicFor("{device_id}", TOPICS.cmdRequest),
    cmd_response: topicFor("{device_id}", TOPICS.cmdResponse),
    remote_belaui_http_request: remoteBelauiHttpRequestTopic("{device_id}", "{request_id}"),
    remote_belaui_http_response: remoteBelauiHttpResponseTopic("{device_id}", "{request_id}"),
    remote_belaui_stream_client: remoteBelauiStreamClientTopic("{device_id}", "{session_id}"),
    remote_belaui_stream_server: remoteBelauiStreamServerTopic("{device_id}", "{session_id}"),
  };
}

function topicFor(deviceId: string, suffix: string): string {
  return `${TOPIC_ROOT}/${deviceId}/${suffix}`;
}

function remoteBelauiHttpRequestTopic(deviceId: string, requestId: string): string {
  return topicFor(deviceId, `proxy/http/request/${requestId}`);
}

function remoteBelauiHttpResponseTopic(deviceId: string, requestId: string): string {
  return topicFor(deviceId, `proxy/http/response/${requestId}`);
}

function remoteBelauiStreamClientTopic(deviceId: string, sessionId: string): string {
  return topicFor(deviceId, `proxy/stream/${sessionId}/client`);
}

function remoteBelauiStreamServerTopic(deviceId: string, sessionId: string): string {
  return topicFor(deviceId, `proxy/stream/${sessionId}/server`);
}

function remoteBelauiHttpKey(deviceId: string, requestId: string): string {
  return `${deviceId}:${requestId}`;
}

function remoteBelauiStreamKey(deviceId: string, sessionId: string): string {
  return `${deviceId}:${sessionId}`;
}

function configurationIssues(): string[] {
  const issues = [];
  if (!config.mqtt.username || !config.mqtt.password) {
    issues.push("BELABOX_MQTT_USERNAME and BELABOX_MQTT_PASSWORD are required for MQTT clients.");
  }
  if (!config.host) issues.push("BELABOX_HOST is not set; SSH install/diagnostic checks are unavailable.");
  if (!config.user) issues.push("BELABOX_USER is not set.");
  if (config.passwordConfigured && !config.keyPath) {
    issues.push("BELABOX_PASSWORD is stored as a placeholder only; key-based SSH is required for checks right now.");
  }
  if (!config.photoUpload.serviceToken) {
    issues.push("PORTAL_SERVICE_TOKEN is required before chunked photo uploads can be assembled.");
  }
  return issues;
}

async function assertCommandReady(): Promise<void> {
  if (!commandsAreEnabled()) throw new RequestError(409, "SSH command execution is disabled.");
  if (!isConfigured()) throw new RequestError(400, "BELABOX_HOST and BELABOX_USER are required for SSH checks.");
  if (config.passwordConfigured && !config.keyPath) {
    throw new RequestError(400, "Password SSH is scaffolded only. Configure BELABOX_SSH_KEY_PATH for command checks.");
  }
}

async function runSsh(remoteCommand: string[]) {
  const args = [
    "-p",
    String(config.sshPort),
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `ConnectTimeout=${Math.max(1, Math.ceil(config.requestTimeoutMs / 1000))}`,
  ];
  if (config.keyPath) args.push("-i", config.keyPath);
  args.push("--", `${safeUser(config.user)}@${safeHost(config.host)}`, ...remoteCommand);

  try {
    return await execFileAsync("ssh", args, { timeout: config.requestTimeoutMs, maxBuffer: 64 * 1024 });
  } catch (error) {
    throw new RequestError(502, `SSH check failed: ${errorMessage(error).slice(0, 300)}`);
  }
}

function isConfigured(): boolean {
  return Boolean(config.host && config.user);
}

function commandsAreEnabled(): boolean {
  return config.sshEnabled && config.commandsEnabled;
}

function safeHost(value: string): string {
  if (!/^[A-Za-z0-9._:-]{1,255}$/.test(value) || value.startsWith("-")) {
    throw new RequestError(400, "BELABOX_HOST contains unsupported characters.");
  }
  return value;
}

function safeFtpHost(value: string): string {
  if (!value) return "";
  if (!/^[A-Za-z0-9._:-]{1,255}$/.test(value) || value.startsWith("-")) {
    throw new Error("BELABOX_FTP_TARGET_HOST/PHOTO_FTP_PASSIVE_HOST contains unsupported characters.");
  }
  return value;
}

function safeUser(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value) || value.startsWith("-")) {
    throw new RequestError(400, "BELABOX_USER contains unsupported characters.");
  }
  return value;
}

function safeFtpUsername(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(value) || value.startsWith("-")) {
    throw new Error("BELABOX_CAMERA_FTP_USERNAME contains unsupported characters.");
  }
  return value;
}

function safeFtpPassword(value: string): string {
  if (!value) return "";
  if (value.length < 5 || value.length > 128 || /[\r\n\0]/.test(value)) {
    throw new RequestError(400, "Camera FTP password must be 5-128 characters without line breaks.");
  }
  return value;
}

function safeRemotePath(value: string): string {
  if (!/^\/[A-Za-z0-9._/@+-]{1,200}$/.test(value)) {
    throw new RequestError(400, "BELABOX_AGENT_REMOTE_PATH must be an absolute path without spaces.");
  }
  return value;
}

function safeFtpRemoteDir(value: string): string {
  if (!/^\/[A-Za-z0-9._/@+-]{0,220}$/.test(value)) {
    throw new Error("BELABOX_FTP_TARGET_DIR must be an absolute FTP path without spaces.");
  }
  return value || "/";
}

function normalizePath(value: string): string {
  if (!/^\/[A-Za-z0-9/_-]{1,80}$/.test(value)) throw new Error("BELABOX_MQTT_WS_PATH must be a URL path.");
  return value;
}

function normalizeUrl(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL settings must start with http:// or https://.");
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizePublicUrl(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Public URL settings must start with http:// or https://.");
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) parsed.protocol = "https:";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeLoopbackHttpUrl(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("BELABOX_REMOTE_BELAUI_LOCAL_URL must start with http:// or https://.");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("BELABOX_REMOTE_BELAUI_LOCAL_URL must point at loopback belaUI.");
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function safeClientIdPrefix(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(value)) throw new Error("BELABOX_MQTT_CLIENT_ID_PREFIX contains unsupported characters.");
  return value;
}

function sanitizeDeviceId(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(cleaned)) throw new RequestError(400, "Device ID must be 2-64 letters, numbers, dashes, or underscores.");
  return cleaned;
}

function randomSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

function readPort(name: string, fallback: number): number {
  return readInt(name, fallback, 1, 65535);
}

function readAnyPort(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (!raw) continue;
    const value = Number.parseInt(raw, 10);
    if (!Number.isInteger(value) || String(value) !== raw || value < 1 || value > 65535) {
      throw new Error(`${name} must be an integer from 1 to 65535`);
    }
    return value;
  }
  return fallback;
}

function readInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isInteger(value) || String(value) !== String(raw || fallback) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function readTimestamp(message: JsonRecord): string | null {
  const value = stringValue(message.at) || stringValue(message.timestamp) || stringValue(message.updated_at);
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function requiredString(value: unknown, label: string): string {
  const text = stringValue(value);
  if (!text) throw new RequestError(400, `${label} is required.`);
  return text;
}

function bodyPort(value: unknown): number {
  return requestPort(value, "SSH port");
}

function requestPort(value: unknown, label: string): number {
  if (value === undefined || value === null || value === "") return 22;
  const text = String(value);
  const port = Number.parseInt(text, 10);
  if (!Number.isInteger(port) || String(port) !== text || port < 1 || port > 65535) {
    throw new RequestError(400, `${label} must be an integer from 1 to 65535.`);
  }
  return port;
}

function sanitizeLogLine(value: string): string {
  return value
    .replace(/(password|secret|token|key)=\S+/gi, "$1=[redacted]")
    .slice(0, 1000);
}

function friendlyFtpConnectorError(message: string, input?: Pick<FtpConnectorInput, "targetHost" | "targetPort">): string {
  const text = sanitizeLogLine(message);
  if (/530 Login authentication failed|frame_ftp_auth_failed/i.test(text)) {
    return "FRAME Photo FTP rejected the configured username/password. Recreate frame-photo-ftp after .env credential changes or verify PHOTO_FTP_USERNAME and PHOTO_FTP_PASSWORD.";
  }
  if (/frame_ftp_test_failed|Connection refused|timed out|No route to host|Network is unreachable/i.test(text)) {
    return `Belabox could not complete the FRAME Photo FTP test. Check that ${input?.targetHost || config.ftpConnector.host || "the configured host"}:${input?.targetPort || config.ftpConnector.port} is reachable from the Belabox and that Photo FTP is healthy.`;
  }
  if (/node_and_npm_required/i.test(text)) {
    return "Belabox needs node and npm for the MQTT agent. Install them manually or provide sudo-capable SSH credentials so setup can install nodejs/npm.";
  }
  if (/python3_required/i.test(text)) {
    return "Belabox needs python3 for the Photo Agent. Install it manually or provide sudo-capable SSH credentials so setup can install python3.";
  }
  if (/pyftpdlib_install_failed|No module named ['\"]?pyftpdlib|pyftpdlib/i.test(text)) {
    return "Belabox needs pyftpdlib for the local camera FTP receiver. Setup tried apt/pip install and failed; check internet access and sudo permissions on the Belabox.";
  }
  if (/camera_ftp_test_failed|Address already in use|Errno 98/i.test(text)) {
    return `Belabox could not start or log into the local camera FTP receiver on port ${config.ftpConnector.cameraPort}. Check for another FTP service already using that port.`;
  }
  return text.slice(0, 500);
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
