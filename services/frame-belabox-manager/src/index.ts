import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
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
import WebSocket, { WebSocketServer } from "ws";

const execFileAsync = promisify(execFile);

type JsonRecord = Record<string, unknown>;
type RemoteProxyTarget = "belaui" | "video_mixer";

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
  control_secret: string;
  upload_token: string;
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
  control_status: "waiting_for_connection" | "connected" | "installed_not_connected_yet";
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
  journey_id: string;
  device_id: string;
  filename: string;
  size_bytes: number;
  chunk_size_bytes: number;
  chunk_count: number;
  file_sha256: string;
  chunks: Array<{ index: number; size_bytes: number; sha256: string }>;
  created_at: string;
}

interface ChunkCompletionReceipt {
  transfer_id: string;
  journey_id: string;
  staged_name: string;
  completed_at: string;
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

interface ControlConnection {
  device_id: string;
  socket: WebSocket;
  authenticated_at: string;
  last_message_at: string;
  streams: Set<string>;
}

interface ProxyStream {
  device_id: string;
  stream_id: string;
  kind: "http" | "websocket";
  target: RemoteProxyTarget;
  request?: express.Request;
  response?: express.Response;
  socket?: net.Socket;
  response_started: boolean;
  modified_text: boolean;
  content_type: string;
  text_chunks: Buffer[];
  text_bytes: number;
  input_chain: Promise<void>;
  input_paused: boolean;
  input_wait?: Promise<void>;
  resume_input?: () => void;
  output_paused: boolean;
  closed: boolean;
  idle_timer?: NodeJS.Timeout;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
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

const CONTROL_ROUTE = "/belabox/control";
const REMOTE_BELAUI_ROUTE_PREFIX = "/belabox/remote";
const VIDEO_MIXER_ROUTE_PREFIX = "/belabox/mixer";
const VIDEO_MIXER_LOCAL_URL = "http://127.0.0.1:9080";
const REMOTE_BELAUI_STATUS_POLL_MS = 500;
const REMOTE_BELAUI_READY_STATUS_POLL_MS = 5000;
const REMOTE_BELAUI_OFFLINE_FAILURES = 4;
const CONTROL_AUTH_TIMEOUT_MS = 10_000;
const CONTROL_IDLE_TIMEOUT_MS = 30_000;
const CONTROL_MAX_MESSAGE_BYTES = 256 * 1024;
const CONTROL_BINARY_CHUNK_BYTES = 240 * 1024;
const CONTROL_SEND_HIGH_WATER_BYTES = 1024 * 1024;
const CONTROL_MAX_STREAMS_PER_DEVICE = 16;
const CONTROL_MAX_PENDING_AUTHENTICATIONS = 64;
const CONTROL_MAX_PENDING_AUTHENTICATIONS_PER_IP = 8;
const CONTROL_MAX_REWRITE_BODY_BYTES = 4 * 1024 * 1024;
const CONTROL_HMAC_CONTEXT = "frame-belabox-control-v1";

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
  control: {
    publicUrl: normalizeControlUrl(process.env.BELABOX_CONTROL_PUBLIC_URL?.trim() || "ws://localhost/belabox/control"),
    reconnectMs: readInt("BELABOX_CONTROL_RECONNECT_MS", 5000, 1000, 60000),
    heartbeatMs: readInt("BELABOX_CONTROL_HEARTBEAT_MS", 10000, 2000, 300000),
    telemetryMs: readInt("BELABOX_TELEMETRY_INTERVAL_MS", 30000, 1000, 600000),
    activePhotoTelemetryMs: readInt("BELABOX_ACTIVE_PHOTO_TELEMETRY_INTERVAL_MS", 500, 200, 5000),
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
    publicUrl: normalizePublicUrl(process.env.BELABOX_CHUNK_UPLOAD_URL?.trim() || `${controlPublicHttpOrigin(process.env.BELABOX_CONTROL_PUBLIC_URL?.trim() || "ws://localhost/belabox/control")}/belabox-chunks/api/transfers`),
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
mkdirSync(path.join(config.dataRoot, "chunk-uploads"), { recursive: true });

const storePaths = {
  devices: path.join(config.dataRoot, "devices.json"),
  signingKey: path.join(config.dataRoot, "command-signing-key.json"),
  audit: path.join(config.dataRoot, "command-audit.jsonl"),
  ftpConnectors: path.join(config.dataRoot, "ftp-connectors.json"),
  sshCredentials: path.join(config.dataRoot, "ssh-credentials.json"),
  chunkUploads: path.join(config.dataRoot, "chunk-uploads"),
};
const provisionedDevices = loadProvisionedDevices();
saveProvisionedDevices();
const ftpConnectors = loadFtpConnectors();
const sshCredentials = loadSshCredentials();
const signingKeys = loadSigningKeys();
const commandAudit = loadAuditLog();
const devices = new Map<string, DeviceState>();
const pairJobs = new Map<string, PairJob>();
const ftpConnectorJobs = new Map<string, PairJob>();
const controlConnections = new Map<string, ControlConnection>();
const proxyStreams = new Map<string, ProxyStream>();
let pendingControlAuthentications = 0;
const pendingControlAuthenticationsByIp = new Map<string, number>();
const completingChunkTransfers = new Map<string, Promise<{ staged_name: string }>>();
const relayCatalogSent = new Map<string, string>();
const relayCatalogSending = new Set<string>();
let currentRelayCatalog: RelayCatalog | null = null;
let relayCatalogPollRunning = false;
let relayCatalogLastError: string | null = null;
const controlHealth = {
  accepted_connections: 0,
  rejected_connections: 0,
  last_connect_at: null as string | null,
  last_disconnect_at: null as string | null,
  last_error_at: null as string | null,
  last_error: null as string | null,
};

const app = express();
const publicDir = path.resolve(process.cwd(), "public");
const bundledAgentVersion = /^const VERSION = "([^"]+)";/m.exec(readFileSync(path.join(process.cwd(), "agent", "belabox-agent.mjs"), "utf8"))?.[1] || null;

app.disable("x-powered-by");
const jsonBodyParser = express.json({ limit: "64kb" });
app.use((request, response, next) => {
  if (remoteProxyRoute(request.path)) {
    next();
    return;
  }
  jsonBodyParser(request, response, next);
});

setInterval(() => void refreshRelayCatalog(), config.relayCatalog.pollMs).unref();
void refreshRelayCatalog();

app.get("/healthz", (_request, response) => {
  response.json({
    ok: true,
    service: "frame-belabox-manager",
    configured: isConfigured(),
    commands_enabled: commandsAreEnabled(),
    control_enabled: true,
    connected_devices: controlConnections.size,
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
      journey_id: manifest.journey_id,
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
    response.json({ accepted: true, transfer_id: manifest.transfer_id, journey_id: manifest.journey_id, index: Number(request.params.index) });
  } catch (error) {
    next(error);
  }
});

app.post("/belabox-chunks/api/transfers/:transferId/complete", async (request, response, next) => {
  try {
    const manifest = loadChunkManifest(request.params.transferId);
    authorizeChunkUpload(request, manifest.device_id);
    const staged = await completeChunkTransfer(manifest);
    response.status(202).json({ accepted: true, transfer_id: manifest.transfer_id, journey_id: manifest.journey_id, staged_name: staged.staged_name });
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
    assertAgentInstallReady();
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
    assertAgentInstallReady();
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
    assertAgentInstallReady();
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
    disconnectDevice(deviceId, 4001, "device removed");
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
      ? "Agent install is available through the device pairing workflow."
      : "Agent install is disabled. Set BELABOX_AGENT_INSTALL_ENABLED=true only after the installer contract is finalized.",
    agent_entrypoint: "agent/belabox-agent.mjs",
    required_env: ["BELABOX_CONTROL_URL", "BELABOX_CONTROL_SECRET", "BELABOX_DEVICE_ID"],
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
    commands_enabled: true,
    allowed_commands: [...ALLOWED_COMMANDS],
    confirmation_required: [...CONFIRM_COMMANDS],
    control_endpoint: CONTROL_ROUTE,
    safe_actions: [
      { id: "connection-check", enabled: commandsAreEnabled(), method: "POST", path: "/belabox/api/connection/check" },
      { id: "agent-check", enabled: commandsAreEnabled(), method: "POST", path: "/belabox/api/agent/check" },
      { id: "agent-install", enabled: false, method: "POST", path: "/belabox/api/agent/install" },
      { id: "agent-update", enabled: false, method: "POST", path: "/belabox/api/agent/update" },
      { id: "agent-remove", enabled: true, method: "POST", path: "/belabox/api/agent/remove" },
      { id: "device-command-request", enabled: true, method: "POST", path: "/belabox/api/cmd/request" },
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

app.all(
  [`${REMOTE_BELAUI_ROUTE_PREFIX}/:deviceId`, `${REMOTE_BELAUI_ROUTE_PREFIX}/:deviceId/*`],
  (request, response, next) => {
    proxyRemoteBelaui(request, response, next, "belaui");
  },
);

app.get(`${VIDEO_MIXER_ROUTE_PREFIX}/status`, async (request, response, next) => {
  try {
    response.setHeader("Cache-Control", "no-store");
    response.json(await videoMixerStatusPayload(remoteBelauiKey(request.query.key)));
  } catch (error) {
    next(error);
  }
});

app.get([VIDEO_MIXER_ROUTE_PREFIX, `${VIDEO_MIXER_ROUTE_PREFIX}/`], (request, response, next) => {
  try {
    const key = request.query.key;
    if (key !== undefined) {
      response.setHeader("Cache-Control", "no-store");
      response.type("html").send(videoMixerShellPage(remoteBelauiKey(key)));
      return;
    }
  } catch (error) {
    next(error);
    return;
  }
  response.setHeader("Cache-Control", "no-store");
  const links = provisionedDevices.map((device) =>
    `<li><a href="${VIDEO_MIXER_ROUTE_PREFIX}?key=${encodeURIComponent(device.device_id)}">${escapeHtml(device.display_name || device.device_id)}</a></li>`,
  ).join("");
  response.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>FRAME Video Mixer</title></head><body><h1>FRAME Video Mixer</h1><ul>${links || "<li>No Belabox devices paired.</li>"}</ul></body></html>`);
});

app.all(
  [`${VIDEO_MIXER_ROUTE_PREFIX}/:deviceId`, `${VIDEO_MIXER_ROUTE_PREFIX}/:deviceId/*`],
  (request, response, next) => {
    proxyRemoteBelaui(request, response, next, "video_mixer");
  },
);

app.use("/belabox/assets", express.static(publicDir, { maxAge: 0 }));
app.get(["/", "/belabox"], (_request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.sendFile(path.join(publicDir, "index.html"));
});

app.use((error: unknown, request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const reportedStatus = Number(objectValue(error)?.status);
  const status = error instanceof RequestError
    ? error.status
    : Number.isInteger(reportedStatus) && reportedStatus >= 400 && reportedStatus <= 599 ? reportedStatus : 500;
  if (status >= 500) console.error("[belabox-manager]", errorMessage(error));
  response.status(status).json({ error: errorMessage(error) });
});

const server = app.listen(config.port, () => {
  console.log(`[belabox-manager] FRAME Belabox Manager listening on port ${config.port}`);
  if (!isConfigured()) console.log("[belabox-manager] Belabox SSH target is not configured; outbound device control remains available.");
});
// Active proxy uploads use the per-stream inactivity timer below; Node's default
// five-minute absolute request deadline would otherwise terminate healthy transfers.
server.requestTimeout = 0;
server.setTimeout(CONTROL_IDLE_TIMEOUT_MS);
const controlServer = new WebSocketServer({
  noServer: true,
  maxPayload: CONTROL_MAX_MESSAGE_BYTES,
  perMessageDeflate: false,
});
controlServer.on("connection", beginControlAuthentication);
server.on("upgrade", (request, socket, head) => {
  if (controlRequest(request.url || "")) {
    controlServer.handleUpgrade(request, socket, head, (websocket) => {
      controlServer.emit("connection", websocket, request);
    });
    return;
  }
  handleRemoteBelauiUpgrade(request, socket as net.Socket, head);
});
setInterval(pingControlConnections, config.control.heartbeatMs).unref();

function proxyRemoteBelaui(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
  target: RemoteProxyTarget,
): void {
  try {
    const deviceId = sanitizeDeviceId(String(request.params.deviceId || ""));
    if (!isProvisionedDevice(deviceId)) throw new RequestError(404, "Belabox device is not provisioned.");
    void proxyRemoteBelauiViaAgent(request, response, next, deviceId, target, remoteBelauiRequestSuffix(request));
  } catch (error) {
    next(error);
  }
}

async function proxyRemoteBelauiViaAgent(
  request: express.Request,
  response: express.Response,
  next: express.NextFunction,
  deviceId: string,
  target: RemoteProxyTarget,
  suffix: string,
): Promise<void> {
  try {
    assertAgentRemoteProxySupported(deviceId, target);
    if (target === "belaui") assertAgentRemoteBelauiAvailable(deviceId, target);
    const targetUrl = remoteProxyLocalUrl(target);
    const stream = createProxyStream(deviceId, "http", target, { request, response });
    sendControlJson(deviceId, {
      type: "proxy_open",
      stream_id: stream.stream_id,
      kind: "http",
      target,
      method: request.method,
      path: suffix,
      headers: remoteBelauiRequestHeaders(request.headers, targetUrl, target, deviceId),
    });
    request.once("aborted", () => cancelProxyStream(stream, "browser request aborted"));
    response.once("close", () => {
      if (!response.writableEnded) cancelProxyStream(stream, "browser response closed");
    });
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      if (stream.closed) {
        request.resume();
        break;
      }
      await waitProxyInput(stream);
      if (stream.closed) {
        request.resume();
        break;
      }
      resetProxyIdle(stream);
      await sendControlBinary(deviceId, stream.stream_id, Buffer.from(chunk));
    }
    if (!stream.closed) sendControlJson(deviceId, { type: "proxy_end", stream_id: stream.stream_id });
    await proxyStreamCompletion(stream);
  } catch (error) {
    if (response.writableEnded) return;
    if (!(error instanceof RequestError && error.status === 404) && remoteBelauiOfflinePageAllowed(request)) {
      sendRemoteBelauiOfflinePage(response, deviceId, target, error);
      return;
    }
    if (!response.headersSent) next(new RequestError(503, `${remoteProxyLabel(target)} proxy failed: ${errorMessage(error)}`));
    else response.destroy(error instanceof Error ? error : new Error(errorMessage(error)));
  }
}

function handleRemoteBelauiUpgrade(request: IncomingMessage, socket: net.Socket, head: Buffer): void {
  const parsed = parseRemoteBelauiUpgradeUrl(request.url || "");
  if (!parsed) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  void handleRemoteBelauiUpgradeViaAgent(parsed, request, socket, head);
}

async function handleRemoteBelauiUpgradeViaAgent(
  parsed: { deviceId: string; path: string; search: string; target: RemoteProxyTarget },
  request: IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): Promise<void> {
  try {
    assertAgentRemoteBelauiAvailable(parsed.deviceId, parsed.target);
    const upgrade = Array.isArray(request.headers.upgrade)
      ? request.headers.upgrade[0]
      : request.headers.upgrade;
    if (
      parsed.target === "video_mixer"
      && (
        parsed.path !== "/wsenc"
        || request.method !== "GET"
        || String(upgrade || "").toLowerCase() !== "websocket"
      )
    ) {
      throw new RequestError(404, "Video Mixer WebSocket request is not allowed.");
    }
  } catch {
    socket.destroy();
    return;
  }
  socket.setTimeout(0);
  let stream: ProxyStream;
  try {
    stream = createProxyStream(parsed.deviceId, "websocket", parsed.target, { socket });
  } catch {
    socket.destroy();
    return;
  }
  socket.pause();
  const close = () => cancelProxyStream(stream, "browser websocket closed");
  socket.on("data", (chunk) => {
    socket.pause();
    void queueProxyInput(stream, Buffer.from(chunk))
      .then(() => {
        if (!stream.closed && !stream.input_paused) socket.resume();
      })
      .catch(() => socket.destroy());
  });
  socket.on("close", close);
  socket.on("error", close);
  try {
    sendControlJson(parsed.deviceId, {
      type: "proxy_open",
      stream_id: stream.stream_id,
      kind: "websocket",
      method: request.method || "GET",
      path: `${parsed.path}${parsed.search}`,
      target: parsed.target,
      headers: remoteBelauiRequestHeaders(request.headers, remoteProxyLocalUrl(parsed.target), parsed.target, parsed.deviceId),
    });
    if (head.length) await queueProxyInput(stream, head);
    if (!stream.closed && !stream.input_paused) socket.resume();
  } catch {
    closeProxyStream(stream, new Error("device control connection closed"));
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

function remoteBelauiRequestHeaders(
  headers: IncomingMessage["headers"],
  target: URL,
  proxyTarget: RemoteProxyTarget,
  deviceId: string,
): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = { ...headers };
  for (const name of [
    "host",
    "connection",
    "accept-encoding",
    "proxy-connection",
    "cookie",
    "cookie2",
    "authorization",
    "proxy-authorization",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-real-ip",
    "x-frame-authenticated-user",
  ]) delete next[name];
  if (proxyTarget === "video_mixer") {
    const cookie = videoMixerUpstreamCookie(deviceId, headers.cookie);
    if (cookie) next.cookie = cookie;
  }
  next.host = target.host;
  next["accept-encoding"] = "identity";
  if (next.origin) next.origin = target.origin;
  return next;
}

function writeAgentRemoteBelauiHeaders(
  response: express.Response,
  headers: Record<string, string | string[]>,
  deviceId: string,
  target: RemoteProxyTarget,
  modified: boolean,
): void {
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if ([
      "connection",
      "proxy-connection",
      "keep-alive",
      "transfer-encoding",
      "content-encoding",
      "upgrade",
      "te",
      "trailer",
      "set-cookie2",
    ].includes(lower)) continue;
    if (modified && lower === "content-length") continue;
    if (lower === "location") response.setHeader(name, rewriteRemoteBelauiLocation(deviceId, target, value));
    else if (lower === "set-cookie") {
      const cookies = target === "video_mixer" ? rewriteVideoMixerSetCookie(deviceId, value) : [];
      if (cookies.length) response.setHeader(name, cookies);
    }
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

function sendRemoteBelauiOfflinePage(
  response: express.Response,
  deviceId: string,
  target: RemoteProxyTarget,
  error: unknown,
): void {
  response.status(200);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Refresh", "2");
  response.setHeader("X-FRAME-Belabox-Proxy", "agent-offline");
  response.type("html").send(remoteBelauiOfflinePage(deviceId, target, errorMessage(error)));
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
  return remoteProxyStatusPayload(deviceId, "belaui");
}

async function videoMixerStatusPayload(deviceId: string): Promise<JsonRecord> {
  return remoteProxyStatusPayload(deviceId, "video_mixer");
}

async function remoteProxyStatusPayload(deviceId: string, target: RemoteProxyTarget): Promise<JsonRecord> {
  const live = devices.get(deviceId);
  const remote = remoteProxyTelemetry(live, target);
  const agentOnline = Boolean(live && deviceIsOnline(live));
  const remoteState = stringValue(remote.state) || "unknown";
  const mixer = target === "video_mixer";
  if (!agentOnline) {
    return remoteBelauiStatusJson(
      deviceId,
      live,
      target,
      false,
      "offline",
      remoteState,
      mixer ? "Mixer unavailable." : "Encoder offline.",
    );
  }
  if (mixer && !videoMixerInstalled(live)) {
    return remoteBelauiStatusJson(
      deviceId,
      live,
      target,
      false,
      "unsupported",
      "unsupported",
      "Video Mixer is not installed.",
    );
  }
  const ready = remoteState === "reachable";
  return remoteBelauiStatusJson(
    deviceId,
    live,
    target,
    ready,
    ready ? "online" : "waiting",
    remoteState,
    ready ? (mixer ? "Video Mixer online." : "Encoder online.") : (mixer ? "Mixer unavailable." : "Reconnecting to encoder..."),
  );
}

function remoteBelauiStatusJson(
  deviceId: string,
  live: DeviceState | undefined,
  target: RemoteProxyTarget,
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
    [target === "video_mixer" ? "video_mixer_state" : "remote_belaui_state"]: remoteState,
    agent_version: live?.agent_version || null,
    relay_health: live?.relay_health || null,
    last_heartbeat_at: live?.last_heartbeat_at || null,
    checked_at: new Date().toISOString(),
    message,
  };
}

function remoteBelauiShellPage(deviceId: string): string {
  return remoteToolShellPage(deviceId, "belaui");
}

function videoMixerShellPage(deviceId: string): string {
  return remoteToolShellPage(deviceId, "video_mixer");
}

function remoteToolShellPage(deviceId: string, target: RemoteProxyTarget): string {
  const encodedDevice = encodeURIComponent(deviceId);
  const escapedDevice = escapeHtml(deviceId);
  const route = remoteProxyRoutePrefix(target);
  const mixer = target === "video_mixer";
  const pageTitle = mixer ? "FRAME Video Mixer" : "FRAME Remote";
  const unavailableHeading = mixer ? "Mixer unavailable." : "This encoder is offline.";
  const unavailableDetail = mixer
    ? `Video Mixer will open automatically when it is running on ${escapedDevice}.`
    : `Don't refresh. This page will update automatically if ${escapedDevice} comes online.`;
  const fallbackMessage = mixer ? "Mixer unavailable." : "Reconnecting to encoder...";
  const statusUrl = `${route}/status?key=${encodedDevice}`;
  const frameUrl = `${route}/${encodedDevice}/?frame_embed=1`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedDevice} - ${pageTitle}</title>
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
  <iframe id="remote-frame" title="${pageTitle}" hidden></iframe>
  <main id="offline">
    <section>
      <p class="eyebrow">${pageTitle}</p>
      <h1>${unavailableHeading}</h1>
      <p>${unavailableDetail}</p>
      <div class="status-bar" aria-hidden="true"><span></span></div>
      <div class="status" id="status-text">${fallbackMessage}</div>
    </section>
  </main>
  <script>
    const statusUrl = ${JSON.stringify(statusUrl)};
    const frameUrl = ${JSON.stringify(frameUrl)};
    const deviceId = ${JSON.stringify(deviceId)};
    const frame = document.getElementById("remote-frame");
    const offline = document.getElementById("offline");
    const statusText = document.getElementById("status-text");
    const fallbackMessage = ${JSON.stringify(fallbackMessage)};
    const offlineFailureThreshold = ${REMOTE_BELAUI_OFFLINE_FAILURES};
    let offlineFailures = 0;
    let frameShown = false;

    function showOffline(message) {
      frame.hidden = true;
      if (frame.getAttribute("src") !== "about:blank") frame.setAttribute("src", "about:blank");
      offline.hidden = false;
      statusText.textContent = message || fallbackMessage;
    }

    function noteOffline(message) {
      offlineFailures += 1;
      statusText.textContent = message || fallbackMessage;
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
        noteOffline(fallbackMessage);
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

function remoteBelauiOfflinePage(deviceId: string, target: RemoteProxyTarget, _reason: string): string {
  const escapedDevice = escapeHtml(deviceId);
  const mixer = target === "video_mixer";
  const pageTitle = mixer ? "FRAME Video Mixer" : "FRAME Remote";
  const offlineMessage = mixer ? "Mixer unavailable." : "Reconnecting to encoder...";
  const heading = mixer ? "Mixer unavailable." : "This encoder is offline.";
  const detail = mixer
    ? `This page will refresh when Video Mixer is running on ${escapedDevice}.`
    : `This page will refresh when ${escapedDevice} is back online.`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="2">
  <title>${escapedDevice} unavailable - ${pageTitle}</title>
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
    <p class="eyebrow">${pageTitle}</p>
    <h1>${heading}</h1>
    <p>${detail}</p>
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rewriteRemoteBelauiLocation(
  deviceId: string,
  target: RemoteProxyTarget,
  value: string | string[],
): string | string[] {
  const route = remoteProxyDeviceRoute(deviceId, target);
  const localOrigin = remoteProxyLocalUrl(target).origin;
  const rewrite = (location: string) => {
    if (location.startsWith("/")) return `${route}${location}`;
    try {
      const parsed = new URL(location);
      return parsed.origin === localOrigin ? `${route}${parsed.pathname}${parsed.search}${parsed.hash}` : location;
    } catch {
      return location;
    }
  };
  return Array.isArray(value) ? value.map(rewrite) : rewrite(value);
}

function remoteBelauiTextResponse(contentType: string): boolean {
  return /text\/html|javascript|ecmascript|text\/css|application\/json/i.test(contentType);
}

function rewriteRemoteBelauiText(deviceId: string, target: RemoteProxyTarget, text: string): string {
  const route = remoteProxyDeviceRoute(deviceId, target);
  if (target === "video_mixer") return rewriteVideoMixerText(route, text);
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

function rewriteVideoMixerText(route: string, text: string): string {
  const rewritten = text
    .replace(/\b(href|src|action)=("|')\/(?!\/)/gi, `$1=$2${route}/`)
    .replace(/url\((['"]?)\/(?!\/)/gi, `url($1${route}/`)
    .replace(/(["'`])\/(api|media|wsenc)(?=[/?#"'`])/g, `$1${route}/$2`)
    .replace(
      new RegExp(`<a href=(["'])${escapeRegExp(route)}/_relay/leave\\1`, "gi"),
      (_match, quote: string) => `<a href=${quote}/belabox${quote} target="_top"`,
    )
    .replace(
      /location\.protocol === "https:"/g,
      `(location.protocol === "https:" || location.pathname.startsWith("${route}/"))`,
    );
  if (!/<html\b/i.test(rewritten)) return rewritten;
  if (/<base\b/i.test(rewritten)) return rewritten.replace(/<base\b[^>]*>/i, `<base href="${route}/">`);
  return rewritten.replace(/(<head[^>]*>)/i, `$1<base href="${route}/">`);
}

function videoMixerUpstreamCookie(deviceId: string, value: string | string[] | undefined): string {
  const prefix = videoMixerCookiePrefix(deviceId);
  const cookies = (Array.isArray(value) ? value.join(";") : value || "").split(";");
  return cookies.flatMap((cookie) => {
    const pair = cookie.trim();
    const separator = pair.indexOf("=");
    if (separator < 1) return [];
    const name = pair.slice(0, separator);
    if (!name.startsWith(prefix)) return [];
    const upstreamName = name.slice(prefix.length);
    if (!validCookieName(upstreamName)) return [];
    return [`${upstreamName}=${pair.slice(separator + 1)}`];
  }).join("; ");
}

function rewriteVideoMixerSetCookie(deviceId: string, value: string | string[]): string[] {
  const values = Array.isArray(value) ? value : [value];
  const prefix = videoMixerCookiePrefix(deviceId);
  const cookiePath = `${remoteProxyDeviceRoute(deviceId, "video_mixer")}/`;
  return values.flatMap((cookie) => {
    const parts = cookie.split(";").map((part) => part.trim()).filter(Boolean);
    const pair = parts.shift() || "";
    const separator = pair.indexOf("=");
    if (separator < 1) return [];
    const name = pair.slice(0, separator);
    if (!validCookieName(name)) return [];
    const attributes = parts.filter((part) => !/^(domain|path)=/i.test(part));
    return [`${prefix}${name}=${pair.slice(separator + 1)}; Path=${cookiePath}${attributes.length ? `; ${attributes.join("; ")}` : ""}`];
  });
}

function videoMixerCookiePrefix(deviceId: string): string {
  return `frame_mixer_${createHash("sha256").update(deviceId).digest("hex").slice(0, 12)}_`;
}

function validCookieName(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
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

function parseRemoteBelauiUpgradeUrl(
  value: string,
): { deviceId: string; path: string; search: string; target: RemoteProxyTarget } | null {
  const parsed = new URL(value || "/", "http://frame.local");
  const target = parsed.pathname.startsWith(`${REMOTE_BELAUI_ROUTE_PREFIX}/`)
    ? "belaui"
    : parsed.pathname.startsWith(`${VIDEO_MIXER_ROUTE_PREFIX}/`) ? "video_mixer" : null;
  if (!target) return null;
  const base = `${remoteProxyRoutePrefix(target)}/`;
  const rest = parsed.pathname.slice(base.length);
  const [rawDeviceId, ...pathParts] = rest.split("/");
  if (!rawDeviceId) return null;
  try {
    return {
      deviceId: sanitizeDeviceId(decodeURIComponent(rawDeviceId)),
      path: `/${pathParts.join("/")}`,
      search: parsed.search,
      target,
    };
  } catch {
    return null;
  }
}

function controlRequest(value: string): boolean {
  try {
    const parsed = new URL(value || "/", "http://frame.local");
    return parsed.pathname === CONTROL_ROUTE && !parsed.search;
  } catch {
    return false;
  }
}

function controlClientIp(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const candidates = [
    Array.isArray(request.headers["cf-connecting-ip"]) ? request.headers["cf-connecting-ip"][0] : request.headers["cf-connecting-ip"],
    Array.isArray(request.headers["x-real-ip"]) ? request.headers["x-real-ip"].at(-1) : request.headers["x-real-ip"],
    forwardedValue?.split(",")[0],
    request.socket.remoteAddress,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeClientIp(candidate);
    if (normalized) return normalized;
  }
  return "unknown";
}

function normalizeClientIp(value: string | undefined): string {
  const candidate = (value || "").trim().replace(/^\[|\]$/g, "");
  if (candidate.startsWith("::ffff:") && net.isIP(candidate.slice(7)) === 4) return candidate.slice(7);
  return net.isIP(candidate) ? candidate : "";
}

function beginControlAuthentication(socket: WebSocket, request: IncomingMessage): void {
  const clientIp = controlClientIp(request);
  const pendingForIp = pendingControlAuthenticationsByIp.get(clientIp) || 0;
  if (
    pendingControlAuthentications >= CONTROL_MAX_PENDING_AUTHENTICATIONS
    || pendingForIp >= CONTROL_MAX_PENDING_AUTHENTICATIONS_PER_IP
  ) {
    controlHealth.rejected_connections += 1;
    rejectControlSocket(socket, "control service busy", 1013);
    return;
  }
  pendingControlAuthentications += 1;
  pendingControlAuthenticationsByIp.set(clientIp, pendingForIp + 1);
  let authenticationPending = true;
  const releasePendingAuthentication = () => {
    if (!authenticationPending) return;
    authenticationPending = false;
    pendingControlAuthentications = Math.max(0, pendingControlAuthentications - 1);
    const remainingForIp = (pendingControlAuthenticationsByIp.get(clientIp) || 1) - 1;
    if (remainingForIp > 0) pendingControlAuthenticationsByIp.set(clientIp, remainingForIp);
    else pendingControlAuthenticationsByIp.delete(clientIp);
  };
  const nonce = randomBytes(32).toString("hex");
  let connection: ControlConnection | null = null;
  let alive = true;
  const authTimer = setTimeout(() => {
    if (!connection) {
      releasePendingAuthentication();
      controlHealth.rejected_connections += 1;
      controlHealth.last_error_at = new Date().toISOString();
      controlHealth.last_error = "authentication timeout";
      socket.terminate();
    }
  }, CONTROL_AUTH_TIMEOUT_MS);
  try {
    socket.send(JSON.stringify({ type: "challenge", nonce }));
  } catch (error) {
    clearTimeout(authTimer);
    releasePendingAuthentication();
    controlHealth.rejected_connections += 1;
    controlHealth.last_error_at = new Date().toISOString();
    controlHealth.last_error = errorMessage(error).slice(0, 200);
    socket.terminate();
    return;
  }
  socket.on("pong", () => {
    alive = true;
    if (connection) connection.last_message_at = new Date().toISOString();
  });
  socket.on("message", (data, isBinary) => {
    try {
      if (!connection) {
        if (!authenticationPending) {
          socket.terminate();
          return;
        }
        if (isBinary) throw new Error("authentication must use JSON");
        connection = authenticateControlSocket(socket, nonce, parseControlJson(data));
        clearTimeout(authTimer);
        releasePendingAuthentication();
        alive = true;
        return;
      }
      connection.last_message_at = new Date().toISOString();
      alive = true;
      handleControlMessage(connection, data, isBinary);
    } catch (error) {
      controlHealth.last_error_at = new Date().toISOString();
      controlHealth.last_error = errorMessage(error).slice(0, 200);
      if (!connection) {
        clearTimeout(authTimer);
        releasePendingAuthentication();
        controlHealth.rejected_connections += 1;
        rejectControlSocket(socket, "authentication failed");
      } else {
        disconnectControlConnection(connection, errorMessage(error));
      }
    }
  });
  socket.on("close", () => {
    clearTimeout(authTimer);
    releasePendingAuthentication();
    if (connection && controlConnections.get(connection.device_id)?.socket === socket) {
      controlConnections.delete(connection.device_id);
      markDeviceDisconnected(connection.device_id);
      closeDeviceProxyStreams(connection.device_id, new Error("Belabox control connection closed."));
      controlHealth.last_disconnect_at = new Date().toISOString();
    }
  });
  socket.on("error", (error) => {
    if (!connection) {
      clearTimeout(authTimer);
      releasePendingAuthentication();
      socket.terminate();
    }
    controlHealth.last_error_at = new Date().toISOString();
    controlHealth.last_error = error.message.slice(0, 200);
  });
  Object.defineProperty(socket, "__frameAlive", {
    get: () => alive,
    set: (value: boolean) => { alive = value; },
    configurable: true,
  });
}

function authenticateControlSocket(socket: WebSocket, nonce: string, message: JsonRecord): ControlConnection {
  if (stringValue(message.type) !== "hello") throw new Error("expected hello");
  if (stringValue(message.nonce) !== nonce) throw new Error("challenge nonce mismatch");
  const deviceId = sanitizeDeviceId(stringValue(message.device_id) || "");
  const agentVersion = (stringValue(message.agent_version) || "").slice(0, 40);
  const proof = stringValue(message.proof) || "";
  const provisioned = provisionedDevices.find((device) => device.device_id === deviceId);
  if (!provisioned || !agentVersion || !/^[a-f0-9]{64}$/.test(proof)) throw new Error("invalid device credentials");
  const expected = controlProof(provisioned.control_secret, deviceId, agentVersion, nonce);
  if (!constantTimeEqual(proof, expected)) throw new Error("invalid device credentials");

  const previous = controlConnections.get(deviceId);
  if (previous) disconnectControlConnection(previous, "replaced by a newer device connection", 4001);
  const connection: ControlConnection = {
    device_id: deviceId,
    socket,
    authenticated_at: new Date().toISOString(),
    last_message_at: new Date().toISOString(),
    streams: new Set(),
  };
  controlConnections.set(deviceId, connection);
  const device = ensureDevice(deviceId);
  device.online = true;
  device.agent_version = agentVersion;
  device.last_heartbeat_at = connection.authenticated_at;
  controlHealth.accepted_connections += 1;
  controlHealth.last_connect_at = connection.authenticated_at;
  controlHealth.last_error = null;
  socket.send(JSON.stringify({
    type: "authenticated",
    device_id: deviceId,
    heartbeat_interval_ms: config.control.heartbeatMs,
    max_streams: CONTROL_MAX_STREAMS_PER_DEVICE,
    max_binary_chunk_bytes: CONTROL_BINARY_CHUNK_BYTES,
  }));
  relayCatalogSent.delete(deviceId);
  void sendRelayCatalogToDevice(deviceId);
  return connection;
}

function handleControlMessage(
  connection: ControlConnection,
  data: WebSocket.RawData,
  isBinary: boolean,
): void {
  if (isBinary) {
    const frame = controlDataBuffer(data);
    if (frame.length < 17 || frame[0] !== 1) throw new Error("invalid binary control frame");
    const streamId = bytesToUuid(frame.subarray(1, 17));
    const stream = proxyStreams.get(proxyStreamKey(connection.device_id, streamId));
    if (!stream || stream.closed) return;
    handleProxyData(connection, stream, frame.subarray(17));
    return;
  }
  const message = parseControlJson(data);
  const type = stringValue(message.type) || "";
  if (["status", "heartbeat", "telemetry", "relay_health", "version", "log", "command_result"].includes(type)) {
    handleDeviceControlPayload(connection.device_id, type, objectValue(message.payload) || {});
    return;
  }
  const streamId = stringValue(message.stream_id);
  if (["proxy_response", "proxy_end", "proxy_error", "proxy_pause", "proxy_resume"].includes(type) && streamId) {
    const stream = proxyStreams.get(proxyStreamKey(connection.device_id, streamId));
    if (!stream || stream.closed) return;
    resetProxyIdle(stream);
    if (type === "proxy_response") handleProxyResponse(stream, message);
    else if (type === "proxy_end") finishProxyStream(stream);
    else if (type === "proxy_pause") pauseProxyInput(stream);
    else if (type === "proxy_resume") resumeProxyInput(stream);
    else failProxyStream(stream, stringValue(message.error) || "device proxy failed");
    return;
  }
  throw new Error(`unsupported control message: ${type || "missing type"}`);
}

function handleDeviceControlPayload(deviceId: string, type: string, payload: JsonRecord): void {
  const device = ensureDevice(deviceId);
  const now = new Date().toISOString();
  device.online = true;
  if (type === "status") {
    device.status = payload;
    device.last_status_at = readTimestamp(payload) || now;
    return;
  }
  if (type === "heartbeat") {
    device.last_heartbeat_at = readTimestamp(payload) || now;
    const version = stringValue(payload.agent_version);
    if (version) device.agent_version = version;
    void sendRelayCatalogToDevice(deviceId);
    return;
  }
  if (type === "telemetry") {
    device.telemetry = payload;
    device.last_telemetry_at = readTimestamp(payload) || now;
    const version = stringValue(payload.agent_version);
    if (version) device.agent_version = version;
    return;
  }
  if (type === "relay_health") {
    device.relay_health = payload;
    return;
  }
  if (type === "version") {
    device.agent_version = stringValue(payload.version) || stringValue(payload.agent_version) || device.agent_version;
    return;
  }
  const text = stringValue(payload.message) || stringValue(payload.line) || JSON.stringify(payload);
  device.logs.push({ at: readTimestamp(payload) || now, message: sanitizeLogLine(text) });
  device.logs = device.logs.slice(-50);
  if (type === "command_result") auditCommandResult(deviceId, payload);
}

function createProxyStream(
  deviceId: string,
  kind: ProxyStream["kind"],
  target: RemoteProxyTarget,
  endpoint: { request?: express.Request; response?: express.Response; socket?: net.Socket },
): ProxyStream {
  const connection = controlConnection(deviceId);
  if (connection.streams.size >= CONTROL_MAX_STREAMS_PER_DEVICE) {
    throw new RequestError(429, "Belabox proxy is busy. Try again shortly.");
  }
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};
  const completion = new Promise<void>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  const stream: ProxyStream = {
    device_id: deviceId,
    stream_id: randomUUID(),
    kind,
    target,
    request: endpoint.request,
    response: endpoint.response,
    socket: endpoint.socket,
    response_started: false,
    modified_text: false,
    content_type: "",
    text_chunks: [],
    text_bytes: 0,
    input_chain: Promise.resolve(),
    input_paused: false,
    output_paused: false,
    closed: false,
    completion,
    resolve,
    reject,
  };
  if (kind === "websocket") void completion.catch(() => undefined);
  proxyStreams.set(proxyStreamKey(deviceId, stream.stream_id), stream);
  connection.streams.add(stream.stream_id);
  resetProxyIdle(stream);
  return stream;
}

function handleProxyResponse(stream: ProxyStream, message: JsonRecord): void {
  if (stream.kind !== "http" || !stream.response || stream.response_started) {
    throw new Error("unexpected proxy response metadata");
  }
  const status = Number(message.status);
  const headers = cleanProxyHeaders(objectValue(message.headers) || {});
  stream.response_started = true;
  stream.content_type = String(headers["content-type"] || "");
  stream.modified_text = remoteBelauiTextResponse(stream.content_type);
  const contentLengthHeader = headers["content-length"];
  const contentLength = Number(Array.isArray(contentLengthHeader) ? contentLengthHeader[0] : contentLengthHeader);
  if (stream.modified_text && Number.isFinite(contentLength) && contentLength > CONTROL_MAX_REWRITE_BODY_BYTES) {
    cancelProxyStream(stream, "rewriteable proxy response is too large");
    return;
  }
  stream.response.status(Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502);
  writeAgentRemoteBelauiHeaders(stream.response, headers, stream.device_id, stream.target, stream.modified_text);
  if (!stream.modified_text) stream.response.flushHeaders();
}

function handleProxyData(_connection: ControlConnection, stream: ProxyStream, data: Buffer): void {
  resetProxyIdle(stream);
  if (!data.length) return;
  if (stream.kind === "websocket" && stream.socket) {
    if (!stream.socket.write(data)) pauseProxyOutput(stream, stream.socket);
    return;
  }
  if (!stream.response || !stream.response_started) throw new Error("proxy body arrived before response metadata");
  if (stream.modified_text) {
    stream.text_bytes += data.length;
    if (stream.text_bytes > CONTROL_MAX_REWRITE_BODY_BYTES) {
      cancelProxyStream(stream, "rewriteable proxy response is too large");
      return;
    }
    stream.text_chunks.push(Buffer.from(data));
  } else if (!stream.response.write(data)) {
    pauseProxyOutput(stream, stream.response);
  }
}

function finishProxyStream(stream: ProxyStream): void {
  if (stream.closed) return;
  if (stream.kind === "http" && stream.response) {
    if (stream.modified_text) {
      stream.response.end(rewriteRemoteBelauiText(
        stream.device_id,
        stream.target,
        Buffer.concat(stream.text_chunks, stream.text_bytes).toString("utf8"),
      ));
    } else {
      stream.response.end();
    }
  } else {
    stream.socket?.end();
  }
  closeProxyStream(stream);
}

function failProxyStream(stream: ProxyStream, message: string): void {
  closeProxyStream(stream, new Error(message.slice(0, 300)));
}

function cancelProxyStream(stream: ProxyStream, reason: string): void {
  if (stream.closed) return;
  try {
    sendControlJson(stream.device_id, { type: "proxy_cancel", stream_id: stream.stream_id, reason });
  } catch {
    // The connection may already be gone.
  }
  closeProxyStream(stream, new Error(reason));
}

function closeProxyStream(stream: ProxyStream, error?: Error): void {
  if (stream.closed) return;
  stream.closed = true;
  if (stream.idle_timer) clearTimeout(stream.idle_timer);
  stream.input_paused = false;
  stream.resume_input?.();
  stream.input_wait = undefined;
  stream.resume_input = undefined;
  if (stream.kind === "http" && stream.request && !stream.request.readableEnded && !stream.request.destroyed) {
    stream.request.resume();
  }
  proxyStreams.delete(proxyStreamKey(stream.device_id, stream.stream_id));
  controlConnections.get(stream.device_id)?.streams.delete(stream.stream_id);
  if (error) {
    if (stream.kind === "websocket") stream.socket?.destroy();
    else if (stream.response?.headersSent) stream.response.destroy(error);
    stream.reject(error);
  } else {
    stream.resolve();
  }
}

function proxyStreamCompletion(stream: ProxyStream): Promise<void> {
  return stream.completion;
}

function resetProxyIdle(stream: ProxyStream): void {
  if (stream.kind === "websocket") return;
  if (stream.idle_timer) clearTimeout(stream.idle_timer);
  stream.idle_timer = setTimeout(() => cancelProxyStream(stream, "proxy stream idle timeout"), CONTROL_IDLE_TIMEOUT_MS);
  stream.idle_timer.unref();
}

function pauseProxyInput(stream: ProxyStream): void {
  if (stream.input_paused || stream.closed) return;
  stream.input_paused = true;
  stream.input_wait = new Promise<void>((resolve) => {
    stream.resume_input = resolve;
  });
  stream.request?.pause();
  stream.socket?.pause();
}

function resumeProxyInput(stream: ProxyStream): void {
  if (!stream.input_paused || stream.closed) return;
  stream.input_paused = false;
  const resume = stream.resume_input;
  stream.input_wait = undefined;
  stream.resume_input = undefined;
  resume?.();
  if (stream.kind === "websocket") {
    void stream.input_chain.finally(() => {
      if (!stream.closed && !stream.input_paused) stream.socket?.resume();
    });
  } else {
    stream.request?.resume();
  }
}

async function waitProxyInput(stream: ProxyStream): Promise<void> {
  if (stream.input_wait) await stream.input_wait;
}

function queueProxyInput(stream: ProxyStream, data: Buffer): Promise<void> {
  const send = stream.input_chain.then(async () => {
    if (stream.closed) return;
    await waitProxyInput(stream);
    if (stream.closed) return;
    resetProxyIdle(stream);
    await sendControlBinary(stream.device_id, stream.stream_id, data);
  });
  stream.input_chain = send.catch(() => undefined);
  return send;
}

function closeDeviceProxyStreams(deviceId: string, error: Error): void {
  for (const stream of proxyStreams.values()) {
    if (stream.device_id === deviceId) closeProxyStream(stream, error);
  }
}

function cleanProxyHeaders(value: JsonRecord): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item === "string") headers[name.toLowerCase()] = item.slice(0, 8192);
    else if (Array.isArray(item) && item.length <= 32 && item.every((entry) => typeof entry === "string")) {
      headers[name.toLowerCase()] = item.map((entry) => entry.slice(0, 8192));
    }
  }
  return headers;
}

function pauseProxyOutput(stream: ProxyStream, destination: NodeJS.EventEmitter): void {
  if (stream.output_paused || stream.closed) return;
  stream.output_paused = true;
  sendControlJson(stream.device_id, { type: "proxy_pause", stream_id: stream.stream_id });
  const resume = () => {
    destination.removeListener("drain", resume);
    destination.removeListener("close", resume);
    destination.removeListener("error", resume);
    if (stream.closed) return;
    stream.output_paused = false;
    sendControlJson(stream.device_id, { type: "proxy_resume", stream_id: stream.stream_id });
  };
  destination.once("drain", resume);
  destination.once("close", resume);
  destination.once("error", resume);
}

function parseControlJson(data: WebSocket.RawData): JsonRecord {
  const body = controlDataBuffer(data);
  if (body.length > CONTROL_MAX_MESSAGE_BYTES) throw new Error("control message too large");
  const parsed = JSON.parse(body.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("control message must be an object");
  return parsed as JsonRecord;
}

function controlDataBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function sendControlJson(deviceId: string, payload: JsonRecord): void {
  const connection = controlConnection(deviceId);
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > CONTROL_MAX_MESSAGE_BYTES) throw new Error("control message too large");
  connection.socket.send(body);
}

async function sendControlBinary(deviceId: string, streamId: string, data: Buffer): Promise<void> {
  const connection = controlConnection(deviceId);
  const id = uuidToBytes(streamId);
  for (let offset = 0; offset < data.length; offset += CONTROL_BINARY_CHUNK_BYTES) {
    await waitControlWritable(connection.socket);
    const chunk = data.subarray(offset, offset + CONTROL_BINARY_CHUNK_BYTES);
    await new Promise<void>((resolve, reject) => {
      connection.socket.send(Buffer.concat([Buffer.from([1]), id, chunk]), { binary: true }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

async function waitControlWritable(socket: WebSocket): Promise<void> {
  const deadline = Date.now() + CONTROL_IDLE_TIMEOUT_MS;
  while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > CONTROL_SEND_HIGH_WATER_BYTES) {
    if (Date.now() >= deadline) throw new Error("control connection backpressure timeout");
    await delay(10);
  }
  if (socket.readyState !== WebSocket.OPEN) throw new Error("Belabox control connection is not open.");
}

function controlConnection(deviceId: string): ControlConnection {
  const connection = controlConnections.get(deviceId);
  if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
    throw new RequestError(503, "Belabox agent is not online.");
  }
  return connection;
}

function proxyStreamKey(deviceId: string, streamId: string): string {
  return `${deviceId}:${streamId}`;
}

function uuidToBytes(value: string): Buffer {
  const hex = value.replace(/-/g, "");
  if (!/^[a-f0-9]{32}$/i.test(hex)) throw new Error("invalid stream id");
  return Buffer.from(hex, "hex");
}

function bytesToUuid(value: Buffer): string {
  if (value.length !== 16) throw new Error("invalid stream id");
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function controlProof(secret: string, deviceId: string, agentVersion: string, nonce: string): string {
  return createHmac("sha256", secret)
    .update(`${CONTROL_HMAC_CONTEXT}\n${deviceId}\n${agentVersion}\n${nonce}`)
    .digest("hex");
}

function rejectControlSocket(socket: WebSocket, reason: string, code = 4003): void {
  try {
    socket.close(code, reason.slice(0, 100));
  } catch {
    socket.terminate();
  }
}

function disconnectControlConnection(connection: ControlConnection, reason: string, code = 1011): void {
  if (controlConnections.get(connection.device_id)?.socket === connection.socket) {
    controlConnections.delete(connection.device_id);
    markDeviceDisconnected(connection.device_id);
    closeDeviceProxyStreams(connection.device_id, new Error(reason));
  }
  try {
    connection.socket.close(code, reason.slice(0, 100));
  } catch {
    connection.socket.terminate();
  }
}

function disconnectDevice(deviceId: string, code: number, reason: string): void {
  const connection = controlConnections.get(deviceId);
  if (connection) disconnectControlConnection(connection, reason, code);
}

function markDeviceDisconnected(deviceId: string): void {
  const device = devices.get(deviceId);
  if (device) device.online = false;
  relayCatalogSent.delete(deviceId);
}

function pingControlConnections(): void {
  for (const connection of controlConnections.values()) {
    const socket = connection.socket as WebSocket & { __frameAlive?: boolean; __framePaused?: boolean };
    if (socket.__framePaused) {
      socket.__frameAlive = true;
      continue;
    }
    if (socket.__frameAlive === false) {
      const lastMessageAge = Date.now() - Date.parse(connection.last_message_at);
      if (!Number.isFinite(lastMessageAge) || lastMessageAge > config.control.heartbeatMs * 3) {
        disconnectControlConnection(connection, "heartbeat timeout", 4000);
        continue;
      }
    }
    socket.__frameAlive = false;
    try {
      socket.ping();
    } catch {
      disconnectControlConnection(connection, "heartbeat failed", 1011);
    }
  }
}

function remoteProxyRoute(value: string): boolean {
  return [REMOTE_BELAUI_ROUTE_PREFIX, VIDEO_MIXER_ROUTE_PREFIX]
    .some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

function remoteProxyRoutePrefix(target: RemoteProxyTarget): string {
  return target === "video_mixer" ? VIDEO_MIXER_ROUTE_PREFIX : REMOTE_BELAUI_ROUTE_PREFIX;
}

function remoteProxyDeviceRoute(deviceId: string, target: RemoteProxyTarget): string {
  return `${remoteProxyRoutePrefix(target)}/${encodeURIComponent(deviceId)}`;
}

function remoteProxyLocalUrl(target: RemoteProxyTarget): URL {
  return new URL(target === "video_mixer" ? VIDEO_MIXER_LOCAL_URL : config.remoteBelaui.localUrl);
}

function remoteProxyLabel(target: RemoteProxyTarget): string {
  return target === "video_mixer" ? "Video Mixer" : "Remote belaUI";
}

function remoteProxyTelemetry(live: DeviceState | undefined, target: RemoteProxyTarget): JsonRecord {
  return objectValue(live?.telemetry?.[target === "video_mixer" ? "video_mixer" : "remote_belaui"]) || {};
}

function videoMixerInstalled(live: DeviceState | undefined): boolean {
  const mixer = objectValue(live?.telemetry?.video_mixer);
  return mixer?.installed === true && stringValue(mixer.target) === "video_mixer";
}

function assertAgentRemoteProxySupported(deviceId: string, target: RemoteProxyTarget): DeviceState {
  const live = devices.get(deviceId);
  if (!live || !deviceIsOnline(live)) throw new RequestError(503, "Belabox agent is not online.");
  if (target === "video_mixer" && !videoMixerInstalled(live)) {
    throw new RequestError(409, "Video Mixer is not installed.");
  }
  return live;
}

function assertAgentRemoteBelauiAvailable(deviceId: string, target: RemoteProxyTarget): void {
  const live = assertAgentRemoteProxySupported(deviceId, target);
  if (target === "belaui" && stringValue(remoteProxyTelemetry(live, target).state) !== "reachable") {
    throw new RequestError(503, "Agent cannot reach loopback belaUI.");
  }
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

function statusPayload() {
  return {
    service: "frame-belabox-manager",
    frame: {
      mode: config.frameMode,
    },
    configured: isConfigured(),
    commands_enabled: commandsAreEnabled(),
    command_execution: commandsAreEnabled() ? "manual-diagnostics-only" : "disabled",
    control: {
      enabled: true,
      endpoint: CONTROL_ROUTE,
      public_url: config.control.publicUrl,
      connected_devices: controlConnections.size,
      accepted_connections: controlHealth.accepted_connections,
      rejected_connections: controlHealth.rejected_connections,
      last_connect_at: controlHealth.last_connect_at,
      last_disconnect_at: controlHealth.last_disconnect_at,
      last_error_at: controlHealth.last_error_at,
      last_error: controlHealth.last_error,
      reconnect_ms: config.control.reconnectMs,
      heartbeat_interval_ms: config.control.heartbeatMs,
      telemetry_interval_ms: config.control.telemetryMs,
      active_photo_telemetry_interval_ms: config.control.activePhotoTelemetryMs,
      max_streams_per_device: CONTROL_MAX_STREAMS_PER_DEVICE,
      pending_authentications: pendingControlAuthentications,
      max_pending_authentications: CONTROL_MAX_PENDING_AUTHENTICATIONS,
      max_pending_authentications_per_ip: CONTROL_MAX_PENDING_AUTHENTICATIONS_PER_IP,
      http_request_timeout_ms: server.requestTimeout,
      http_headers_timeout_ms: server.headersTimeout,
      http_idle_timeout_ms: server.timeout,
      proxy_idle_timeout_ms: CONTROL_IDLE_TIMEOUT_MS,
      agent_install_ready: agentInstallReady(),
      agent_install_requirement: "FRAME Hybrid mode with a public wss:// control URL",
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
      runtime: "outbound-wss",
      status: controlConnections.size > 0 ? "connected" : "not_connected",
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
    video_mixer: {
      enabled: true,
      route_prefix: VIDEO_MIXER_ROUTE_PREFIX,
      target: "video_mixer",
      local_url: VIDEO_MIXER_LOCAL_URL,
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
  return parsed.flatMap((value) => {
    const device = objectValue(value);
    if (!device || typeof device.device_id !== "string") return [];
    const legacySecret = typeof device.mqtt_password === "string" ? device.mqtt_password : "";
    const controlSecret = typeof device.control_secret === "string" ? device.control_secret : legacySecret;
    if (controlSecret.length < 32) return [];
    const uploadToken = typeof device.upload_token === "string"
      && device.upload_token.length >= 32
      && device.upload_token !== controlSecret
      ? device.upload_token
      : randomSecret(32);
    return [{
      device_id: sanitizeDeviceId(device.device_id),
      display_name: typeof device.display_name === "string" ? device.display_name : device.device_id,
      control_secret: controlSecret,
      upload_token: uploadToken,
      host: typeof device.host === "string" ? device.host : undefined,
      created_at: typeof device.created_at === "string" ? device.created_at : new Date().toISOString(),
      updated_at: typeof device.updated_at === "string" ? device.updated_at : new Date().toISOString(),
    }];
  });
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
    control_secret: randomSecret(32),
    upload_token: randomSecret(32),
    host: host || existing?.host,
    created_at: existing?.created_at || now,
    updated_at: now,
  };
  if (existing) provisionedDevices.splice(provisionedDevices.indexOf(existing), 1, record);
  else provisionedDevices.push(record);
  saveProvisionedDevices();
  return record;
}

async function pairBelabox(input: PairInput, progress: (message: string) => void, waitForControl: boolean): Promise<PairResult> {
  assertAgentInstallReady();
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
    let connected = false;
    if (waitForControl) {
      progress("Waiting for device connection");
      connected = await waitForFreshHeartbeat(record.device_id, installedAt, 60000);
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
      control_status: connected ? "connected" : waitForControl ? "installed_not_connected_yet" : "waiting_for_connection",
    };
  } catch (error) {
    provisionedDevices.splice(0, provisionedDevices.length, ...snapshot);
    saveProvisionedDevices();
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
    updatePairJob(job, result.control_status === "connected" ? "Belabox online" : "Installed; connection still pending");
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
    const transferId = stringValue(ftp.transfer_id);
    const journeyId = safeOptionalJourneyId(stringValue(ftp.journey_id))
      || (adapter === "belabox_chunked" && transferId ? fallbackJourneyId(transferId) : null);
    if (filename || phase === "failed") {
      transfers.push({
        transfer_id: transferId || `${device.device_id}:${filename || "ftp"}:${startedAt}`,
        journey_id: journeyId,
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
    const completedFile = stringValue(result.file);
    const completedTransferId = stringValue(result.transfer_id);
    const completedJourneyId = safeOptionalJourneyId(stringValue(result.journey_id))
      || (adapter === "belabox_chunked" && completedTransferId ? fallbackJourneyId(completedTransferId) : null);
    const duplicatesCurrent = phase === "published" && completedJourneyId && completedJourneyId === journeyId;
    if (
      !duplicatesCurrent
      && completedJourneyId
      && stringValue(result.status) === "completed"
      && completedAt
      && Number.isFinite(Date.parse(completedAt))
    ) {
      const timestamp = new Date(Date.parse(completedAt)).toISOString();
      transfers.push({
        transfer_id: completedTransferId || `${device.device_id}:completed:${timestamp}`,
        journey_id: completedJourneyId,
        adapter,
        phase: "published",
        filename: completedFile || null,
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
  const suppliedJourneyId = stringValue(data.journey_id);
  const journeyId = suppliedJourneyId ? safeJourneyId(suppliedJourneyId) : fallbackJourneyId(transferId);
  const sizeBytes = safePositiveInt(data.size_bytes, "size_bytes", 1, config.chunkUpload.maxFileBytes);
  const chunkSizeBytes = safePositiveInt(data.chunk_size_bytes, "chunk_size_bytes", 256 * 1024, config.chunkUpload.chunkSizeBytes);
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
    journey_id: journeyId,
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
  if (!device || !constantTimeEqual(supplied, device.upload_token)) {
    throw new RequestError(401, "Belabox chunk upload token is invalid.");
  }
}

function saveChunkManifest(manifest: ChunkManifest): void {
  const directory = chunkTransferDir(manifest.transfer_id);
  const file = path.join(directory, "manifest.json");
  if (existsSync(file)) {
    const existing = JSON.parse(readFileSync(file, "utf8")) as ChunkManifest;
    if (chunkManifestFingerprint(existing) !== chunkManifestFingerprint(manifest)) {
      throw new RequestError(409, "transfer_id is already assigned to a different chunk manifest.");
    }
    return;
  }
  mkdirSync(path.join(directory, "chunks"), { recursive: true });
  writeJsonAtomic(file, manifest);
}

function loadChunkManifest(transferId: string): ChunkManifest {
  const safeId = safeTransferId(transferId);
  const file = path.join(chunkTransferDir(safeId), "manifest.json");
  if (!existsSync(file)) throw new RequestError(404, "Chunk transfer was not found.");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as ChunkManifest;
  return { ...manifest, journey_id: manifest.journey_id || fallbackJourneyId(manifest.transfer_id) };
}

function saveChunk(transferId: string, indexValue: string, body: unknown, manifest: ChunkManifest): void {
  if (loadChunkReceipt(transferId)) {
    cleanupCompletedChunkPayload(transferId);
    return;
  }
  const index = safePositiveInt(indexValue, "chunk index", 0, manifest.chunk_count - 1);
  const expected = manifest.chunks.find((chunk) => chunk.index === index);
  if (!expected) throw new RequestError(404, "Chunk index is not in the manifest.");
  if (!Buffer.isBuffer(body)) throw new RequestError(400, "Chunk body is required.");
  if (body.length !== expected.size_bytes) throw new RequestError(400, "Chunk size does not match manifest.");
  if (sha256(body) !== expected.sha256) throw new RequestError(400, "Chunk hash does not match manifest.");
  const target = path.join(chunkTransferDir(transferId), "chunks", `${index}.part`);
  if (existsSync(target)) {
    const existing = readFileSync(target);
    if (existing.length === expected.size_bytes && sha256(existing) === expected.sha256) return;
    throw new RequestError(409, "Chunk index is already stored with different content.");
  }
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, body, { mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    if (existsSync(target)) {
      const existing = readFileSync(target);
      if (existing.length === expected.size_bytes && sha256(existing) === expected.sha256) return;
    }
    throw error;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function completeChunkTransfer(manifest: ChunkManifest): Promise<{ staged_name: string }> {
  const active = completingChunkTransfers.get(manifest.transfer_id);
  if (active) return active;
  const pending = completeChunkTransferOnce(manifest).finally(() => completingChunkTransfers.delete(manifest.transfer_id));
  completingChunkTransfers.set(manifest.transfer_id, pending);
  return pending;
}

async function completeChunkTransferOnce(manifest: ChunkManifest): Promise<{ staged_name: string }> {
  const existing = loadChunkReceipt(manifest.transfer_id);
  if (existing) {
    cleanupCompletedChunkPayload(manifest.transfer_id);
    return { staged_name: existing.staged_name };
  }
  if (!config.photoUpload.serviceToken) throw new RequestError(503, "PORTAL_SERVICE_TOKEN is required to stage chunked photos.");
  const directory = chunkTransferDir(manifest.transfer_id);
  const assembled = path.join(directory, "assembled.tmp");
  try {
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
        "x-frame-journey-id": manifest.journey_id,
        "x-frame-ingest-adapter": "belabox_chunked",
        "x-frame-file-size": String(manifest.size_bytes),
      },
      body: readFileSync(assembled),
    });
    const payload = await response.json().catch(() => ({})) as JsonRecord;
    if (!response.ok) throw new RequestError(502, stringValue(payload.error) || "Photo Upload rejected the assembled file.");
    const receipt: ChunkCompletionReceipt = {
      transfer_id: manifest.transfer_id,
      journey_id: manifest.journey_id,
      staged_name: stringValue(payload.staged_name) || manifest.filename,
      completed_at: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(directory, "completed.json"), receipt);
    cleanupCompletedChunkPayload(manifest.transfer_id);
    return { staged_name: receipt.staged_name };
  } finally {
    rmSync(assembled, { force: true });
  }
}

function cleanupCompletedChunkPayload(transferId: string): void {
  const directory = chunkTransferDir(transferId);
  rmSync(path.join(directory, "chunks"), { recursive: true, force: true });
  rmSync(path.join(directory, "assembled.tmp"), { force: true });
}

function loadChunkReceipt(transferId: string): ChunkCompletionReceipt | null {
  const file = path.join(chunkTransferDir(transferId), "completed.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as ChunkCompletionReceipt : null;
}

function chunkManifestFingerprint(manifest: ChunkManifest): string {
  return sha256(Buffer.from(JSON.stringify({
    transfer_id: manifest.transfer_id,
    journey_id: manifest.journey_id || fallbackJourneyId(manifest.transfer_id),
    device_id: manifest.device_id,
    filename: manifest.filename,
    size_bytes: manifest.size_bytes,
    chunk_size_bytes: manifest.chunk_size_bytes,
    chunk_count: manifest.chunk_count,
    file_sha256: manifest.file_sha256,
    chunks: manifest.chunks
      .map((chunk) => ({ index: chunk.index, size_bytes: chunk.size_bytes, sha256: chunk.sha256 }))
      .sort((left, right) => left.index - right.index),
  })));
}

function writeJsonAtomic(file: string, value: unknown): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
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

function safeJourneyId(value: string): string {
  const parsed = safeTransferId(value);
  if (parsed.includes("__")) throw new RequestError(400, "journey_id cannot contain the reserved '__' delimiter.");
  return parsed;
}

function fallbackJourneyId(transferId: string): string {
  return /^[A-Za-z0-9_-]{8,96}$/.test(transferId) && !transferId.includes("__")
    ? transferId
    : `legacy-${sha256(Buffer.from(transferId)).slice(0, 32)}`;
}

function safeOptionalJourneyId(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{8,96}$/.test(value) && !value.includes("__") ? value : null;
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
  assertAgentInstallReady();
  const dir = "$HOME/.frame-belabox-agent";
  const agent = readFileSync(path.join(process.cwd(), "agent", "belabox-agent.mjs"), "utf8");
  const sudoPasswordB64 = input.password ? Buffer.from(input.password, "utf8").toString("base64") : "";
  const relayProbeUrl = new URL(controlPublicHttpOrigin(config.control.publicUrl));
  const envFile = [
    `BELABOX_DEVICE_ID=${device.device_id}`,
    `BELABOX_CONTROL_SECRET=${device.control_secret}`,
    `BELABOX_CONTROL_URL=${config.control.publicUrl}`,
    `BELABOX_COMMAND_SIGNING_PUBLIC_KEY_B64=${Buffer.from(signingKeys.publicKeyPem, "utf8").toString("base64")}`,
    `BELABOX_CONTROL_HEARTBEAT_MS=${config.control.heartbeatMs}`,
    `BELABOX_TELEMETRY_INTERVAL_MS=${config.control.telemetryMs}`,
    `BELABOX_ACTIVE_PHOTO_TELEMETRY_INTERVAL_MS=${config.control.activePhotoTelemetryMs}`,
    `BELABOX_CONTROL_RECONNECT_MS=${config.control.reconnectMs}`,
    `BELABOX_RELAY_PROBE_HOST=${relayProbeUrl.hostname}`,
    `BELABOX_RELAY_PROBE_PORT=${relayProbeUrl.port || (relayProbeUrl.protocol === "https:" ? "443" : "80")}`,
    `BELABOX_CHUNK_UPLOAD_URL=${config.chunkUpload.publicUrl}`,
    `BELABOX_CHUNK_UPLOAD_TOKEN=${device.upload_token}`,
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
  const pkg = JSON.stringify({ type: "module", dependencies: { ws: "8.21.1" } }, null, 2);
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
photo_agent_credentials_refreshed=0
refresh_photo_agent_upload_credentials() {
  photo_env="$agent_dir/photo-agent/photo-agent.env"
  if [ ! -f "$photo_env" ]; then return 0; fi
  if ! photo_upload_url="$(printf %s '${b64(config.chunkUpload.publicUrl)}' | base64 -d)"; then return 1; fi
  if ! photo_upload_token="$(printf %s '${b64(device.upload_token)}' | base64 -d)"; then return 1; fi
  if [ -z "$photo_upload_url" ] || [ -z "$photo_upload_token" ]; then return 1; fi
  photo_env_tmp="$(mktemp "$agent_dir/photo-agent/.photo-agent.env.XXXXXX")"
  if ! awk '$0 !~ /^FRAME_CHUNK_UPLOAD_URL=/ && $0 !~ /^FRAME_CHUNK_UPLOAD_TOKEN=/' "$photo_env" > "$photo_env_tmp"; then
    rm -f "$photo_env_tmp"
    return 1
  fi
  if ! {
    printf 'FRAME_CHUNK_UPLOAD_URL=%s\\n' "$photo_upload_url"
    printf 'FRAME_CHUNK_UPLOAD_TOKEN=%s\\n' "$photo_upload_token"
  } >> "$photo_env_tmp"; then
    rm -f "$photo_env_tmp"
    return 1
  fi
  chmod 600 "$photo_env_tmp"
  mv -f "$photo_env_tmp" "$photo_env"
  photo_agent_credentials_refreshed=1
}
restart_existing_photo_agent() {
  if [ "$photo_agent_credentials_refreshed" != "1" ]; then return 0; fi
  photo_dir="$agent_dir/photo-agent"
  if command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/frame-belabox-photo-agent.service ]; then
    sudo_run systemctl restart frame-belabox-photo-agent.service
    return $?
  fi
  if command -v systemctl >/dev/null 2>&1 && [ -f "$HOME/.config/systemd/user/frame-belabox-photo-agent.service" ]; then
    systemctl --user restart frame-belabox-photo-agent.service
    return $?
  fi
  if [ ! -f "$photo_dir/photo-agent.py" ]; then return 0; fi
  python_bin="$(command -v python3 || true)"
  if [ -z "$python_bin" ]; then return 1; fi
  if [ -f "$photo_dir/photo-agent.pid" ]; then
    kill "$(cat "$photo_dir/photo-agent.pid")" 2>/dev/null || true
  fi
  pkill -f "$photo_dir/photo-agent.py" 2>/dev/null || true
  ( cd "$photo_dir"; set -a; . "$photo_dir/photo-agent.env"; set +a; nohup "$python_bin" "$photo_dir/photo-agent.py" >> "$photo_dir/photo-agent.log" 2>&1 & echo $! > "$photo_dir/photo-agent.pid" )
}
refresh_photo_agent_upload_credentials
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
if ! restart_existing_photo_agent; then
  echo "photo_agent_credential_restart_failed" >&2
  exit 47
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
    assertAgentInstallReady();
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
  printf 'FRAME_CHUNK_UPLOAD_TOKEN=%s\\n' "$(decode '${b64(device.upload_token)}')"
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
  sendControlJson(deviceId, {
    type: "command",
    request_id: signed.command_id,
    payload: signed,
  });
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
    safePositiveInt(args.chunk_size_bytes, "chunk_size_bytes", 256 * 1024, config.chunkUpload.chunkSizeBytes);
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
    control_secret_configured: Boolean(device.control_secret),
    upload_token_configured: Boolean(device.upload_token),
    password_configured: Boolean(device.control_secret),
    created_at: device.created_at,
    updated_at: device.updated_at,
  };
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
  return controlConnections.get(device.device_id)?.socket.readyState === WebSocket.OPEN;
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

function agentInstallReady(): boolean {
  if (config.frameMode !== "HYBRID") return false;
  try {
    const controlUrl = new URL(config.control.publicUrl);
    return controlUrl.protocol === "wss:" && isPublicControlHost(controlUrl.hostname);
  } catch {
    return false;
  }
}

function assertAgentInstallReady(): void {
  if (agentInstallReady()) return;
  throw new RequestError(
    409,
    "Belabox agent install and repair require FRAME Hybrid mode with a public wss:// control URL.",
  );
}

function configurationIssues(): string[] {
  const issues = [];
  if (!agentInstallReady()) {
    issues.push("Belabox agent install and repair require FRAME Hybrid mode with a public wss:// control URL.");
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

function normalizeUrl(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("URL settings must start with http:// or https://.");
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizePublicUrl(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Public URL settings must start with http:// or https://.");
  if (!isLoopbackHost(parsed.hostname)) parsed.protocol = "https:";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function normalizeControlUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (!["ws:", "wss:"].includes(parsed.protocol)) {
    throw new Error("BELABOX_CONTROL_PUBLIC_URL must start with ws://, wss://, http://, or https://.");
  }
  if (!isLoopbackHost(parsed.hostname)) parsed.protocol = "wss:";
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("BELABOX_CONTROL_PUBLIC_URL cannot include credentials, a query, or a fragment.");
  }
  parsed.pathname = CONTROL_ROUTE;
  return parsed.toString();
}

function controlPublicHttpOrigin(value: string): string {
  const parsed = new URL(normalizeControlUrl(value));
  parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  parsed.pathname = "/";
  return parsed.origin;
}

function normalizeLoopbackHttpUrl(value: string): string {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("BELABOX_REMOTE_BELAUI_LOCAL_URL must start with http:// or https://.");
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error("BELABOX_REMOTE_BELAUI_LOCAL_URL must point at loopback belaUI.");
  }
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname.toLowerCase());
}

function isPublicControlHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized.length <= 253
    && normalized.includes(".")
    && !normalized.endsWith(".local")
    && !normalized.endsWith(".localhost")
    && net.isIP(normalized.replace(/^\[|\]$/g, "")) === 0
    && normalized.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
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
    return "Belabox needs node and npm for the FRAME agent. Install them manually or provide sudo-capable SSH credentials so setup can install nodejs/npm.";
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
