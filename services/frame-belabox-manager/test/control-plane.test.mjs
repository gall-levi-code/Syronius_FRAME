import assert from "node:assert/strict";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import WebSocket from "ws";

const serviceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const protocol = "frame-belabox-control-v1";
const deviceId = "test-device";
const agentVersion = "0.9.1-test";
const secret = "test-control-secret-0123456789abcdef";

test("authenticated WSS control safely multiplexes HTTP and WebSocket proxy streams", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "frame-belabox-control-"));
  const port = await availablePort();
  const now = new Date().toISOString();
  await writeFile(path.join(dataRoot, "devices.json"), `${JSON.stringify([{
    device_id: deviceId,
    display_name: "Test Device",
    control_secret: secret,
    created_at: now,
    updated_at: now,
  }], null, 2)}\n`);

  let stderr = "";
  const manager = spawn(process.execPath, ["dist/index.js"], {
    cwd: serviceRoot,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_ROOT: dataRoot,
      BELABOX_CONTROL_PUBLIC_URL: `ws://127.0.0.1:${port}/belabox/control`,
      BELABOX_CONTROL_HEARTBEAT_MS: "2000",
      BELABOX_TELEMETRY_INTERVAL_MS: "30000",
      BELABOX_ACTIVE_PHOTO_TELEMETRY_INTERVAL_MS: "500",
      PORTAL_SERVICE_TOKEN: "test-service-token",
      SLS_API_KEY: "",
      PHOTO_PIPELINE_URL: `http://127.0.0.1:${port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  manager.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  context.after(async () => {
    manager.kill();
    await Promise.race([once(manager, "exit"), delay(2000)]).catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
  });
  await waitForHealth(port, manager, () => stderr);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/belabox/control`);
  const inbox = messageInbox(socket);
  await once(socket, "open");
  const challenge = await inbox.json();
  assert.equal(challenge.type, "challenge");
  socket.send(JSON.stringify({
    type: "hello",
    device_id: deviceId,
    agent_version: agentVersion,
    nonce: challenge.nonce,
    proof: controlProof(secret, deviceId, agentVersion, challenge.nonce),
  }));
  assert.equal((await inbox.json()).type, "authenticated");

  const sessionId = randomBytes(16).toString("hex");
  socket.send(JSON.stringify({
    type: "status",
    payload: { state: "online", at: now, agent_session_id: sessionId },
  }));
  socket.send(JSON.stringify({
    type: "heartbeat",
    payload: { at: now, agent_version: agentVersion, agent_session_id: sessionId },
  }));
  socket.send(JSON.stringify({
    type: "telemetry",
    payload: {
      at: now,
      agent_version: agentVersion,
      agent_session_id: sessionId,
      video_mixer: {
        installed: true,
        target: "video_mixer",
        state: "reachable",
        checked_at: now,
      },
    },
  }));

  const connectedStatus = await waitForStatus(port, (status) =>
    status.devices?.[0]?.online === true
    && status.devices[0].telemetry?.video_mixer?.installed === true);
  assert.equal(connectedStatus.control.connected_devices, 1);
  assert.equal(connectedStatus.control.http_request_timeout_ms, 0);
  assert.ok(connectedStatus.control.http_headers_timeout_ms > 0);
  assert.equal(connectedStatus.control.http_idle_timeout_ms, 30000);
  assert.equal(connectedStatus.control.proxy_idle_timeout_ms, 30000);

  const badSocket = new WebSocket(`ws://127.0.0.1:${port}/belabox/control`);
  const badInbox = messageInbox(badSocket);
  await once(badSocket, "open");
  const badChallenge = await badInbox.json();
  const badClose = once(badSocket, "close");
  badSocket.send(JSON.stringify({
    type: "hello",
    device_id: deviceId,
    agent_version: agentVersion,
    nonce: badChallenge.nonce,
    proof: "0".repeat(64),
  }));
  const [badCode] = await badClose;
  assert.equal(badCode, 4003);

  const upload = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a);
  const download = Buffer.alloc(3 * 1024 * 1024 + 29, 0xa5);
  const browserRequest = fetch(`http://127.0.0.1:${port}/belabox/mixer/${deviceId}/api/upload`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: upload,
  });
  const open = await inbox.json();
  assert.equal(open.type, "proxy_open");
  assert.equal(open.kind, "http");
  assert.equal(open.target, "video_mixer");
  assert.equal(open.path, "/api/upload");
  const received = [];
  while (true) {
    const message = await inbox.next();
    if (message.isBinary) {
      const frame = Buffer.from(message.data);
      assert.equal(frame[0], 1);
      assert.equal(uuidFromBytes(frame.subarray(1, 17)), open.stream_id);
      received.push(frame.subarray(17));
      continue;
    }
    const value = JSON.parse(Buffer.from(message.data).toString("utf8"));
    if (value.type === "proxy_end" && value.stream_id === open.stream_id) break;
  }
  const receivedUpload = Buffer.concat(received);
  assert.equal(receivedUpload.length, upload.length);
  assert.equal(hash(receivedUpload), hash(upload));

  socket.send(JSON.stringify({
    type: "proxy_response",
    stream_id: open.stream_id,
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(download.length),
    },
  }));
  const browserResponse = await browserRequest;
  assert.equal(browserResponse.status, 200);
  const receivedDownloadPromise = browserResponse.arrayBuffer();
  for (let offset = 0; offset < download.length; offset += 240 * 1024) {
    const chunk = download.subarray(offset, offset + 240 * 1024);
    await sendBinary(socket, open.stream_id, chunk);
  }
  socket.send(JSON.stringify({ type: "proxy_end", stream_id: open.stream_id }));

  const receivedDownload = Buffer.from(await receivedDownloadPromise);
  assert.equal(receivedDownload.length, download.length);
  assert.equal(hash(receivedDownload), hash(download));

  const scriptRequest = fetch(`http://127.0.0.1:${port}/belabox/mixer/${deviceId}/main.js`);
  const scriptOpen = await nextProxyJson(inbox, "proxy_open");
  assert.equal(scriptOpen.path, "/main.js");
  assert.deepEqual(
    await nextProxyJson(inbox, "proxy_end", scriptOpen.stream_id),
    { type: "proxy_end", stream_id: scriptOpen.stream_id },
  );
  socket.send(JSON.stringify({
    type: "proxy_response",
    stream_id: scriptOpen.stream_id,
    status: 200,
    headers: { "content-type": "application/javascript" },
  }));
  await sendBinary(socket, scriptOpen.stream_id, Buffer.from('const endpoint = "/ap'));
  await sendBinary(socket, scriptOpen.stream_id, Buffer.from('i/status";'));
  socket.send(JSON.stringify({ type: "proxy_end", stream_id: scriptOpen.stream_id }));
  const scriptResponse = await scriptRequest;
  assert.equal(scriptResponse.status, 200);
  assert.equal(
    await scriptResponse.text(),
    `const endpoint = "/belabox/mixer/${deviceId}/api/status";`,
  );

  const earlyResponse = new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: `/belabox/mixer/${deviceId}/api/upload`,
      headers: { "transfer-encoding": "chunked" },
    });
    request.once("error", reject);
    request.once("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve({
        request,
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.flushHeaders();
  });
  const earlyOpen = await nextProxyJson(inbox, "proxy_open");
  socket.send(JSON.stringify({ type: "proxy_pause", stream_id: earlyOpen.stream_id }));
  socket.send(JSON.stringify({
    type: "proxy_response",
    stream_id: earlyOpen.stream_id,
    status: 413,
    headers: {
      "content-type": "text/plain",
      "content-length": "8",
    },
  }));
  await sendBinary(socket, earlyOpen.stream_id, Buffer.from("rejected"));
  socket.send(JSON.stringify({ type: "proxy_end", stream_id: earlyOpen.stream_id }));
  const earlyResult = await earlyResponse;
  assert.equal(earlyResult.status, 413);
  assert.equal(earlyResult.body, "rejected");
  earlyResult.request.end();

  const unknownUpgrade = await rawUpgrade(port, "/not-a-frame-proxy");
  assert.match(unknownUpgrade, /^HTTP\/1\.1 404 Not Found\r\n/);
  const queriedControlUpgrade = await rawUpgrade(port, "/belabox/control?x=1");
  assert.match(queriedControlUpgrade, /^HTTP\/1\.1 404 Not Found\r\n/);

  const browserSocket = net.connect(port, "127.0.0.1");
  browserSocket.on("error", () => undefined);
  await once(browserSocket, "connect");
  browserSocket.cork();
  browserSocket.write([
    `GET /belabox/mixer/${deviceId}/wsenc HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "",
    "",
  ].join("\r\n"));
  browserSocket.write("HEAD");
  browserSocket.uncork();
  const upgradeOpen = await nextProxyJson(inbox, "proxy_open");
  assert.equal(upgradeOpen.kind, "websocket");
  assert.equal(upgradeOpen.path, "/wsenc");
  browserSocket.write("TAIL");
  const upgradeInput = await collectBinary(inbox, upgradeOpen.stream_id, 8);
  assert.equal(upgradeInput.toString("utf8"), "HEADTAIL");
  const browserClose = once(browserSocket, "close");
  socket.send(JSON.stringify({ type: "proxy_end", stream_id: upgradeOpen.stream_id }));
  await browserClose;

  socket.close();
  const offlineStatus = await waitForStatus(port, (status) =>
    status.devices?.[0]?.online === false);
  assert.equal(offlineStatus.devices[0].telemetry.video_mixer.installed, true);
  assert.ok(offlineStatus.control.rejected_connections >= 1);
});

function messageInbox(socket) {
  const queued = [];
  const waiters = [];
  socket.on("message", (data, isBinary) => {
    const message = { data, isBinary };
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else queued.push(message);
  });
  socket.on("error", (error) => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });
  return {
    next() {
      const message = queued.shift();
      if (message) return Promise.resolve(message);
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async json() {
      const message = await this.next();
      assert.equal(message.isBinary, false);
      return JSON.parse(Buffer.from(message.data).toString("utf8"));
    },
  };
}

function controlProof(controlSecret, id, version, nonce) {
  return createHmac("sha256", controlSecret)
    .update(`${protocol}\n${id}\n${version}\n${nonce}`)
    .digest("hex");
}

function binaryFrame(streamId, data) {
  return Buffer.concat([Buffer.from([1]), uuidBytes(streamId), data]);
}

function uuidBytes(value) {
  return Buffer.from(value.replace(/-/g, ""), "hex");
}

function uuidFromBytes(value) {
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function sendBinary(socket, streamId, data) {
  await new Promise((resolve, reject) => {
    socket.send(binaryFrame(streamId, data), { binary: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function collectBinary(inbox, streamId, length) {
  const chunks = [];
  let bytes = 0;
  while (bytes < length) {
    const message = await inbox.next();
    assert.equal(message.isBinary, true);
    const frame = Buffer.from(message.data);
    assert.equal(frame[0], 1);
    assert.equal(uuidFromBytes(frame.subarray(1, 17)), streamId);
    const chunk = frame.subarray(17);
    chunks.push(chunk);
    bytes += chunk.length;
  }
  return Buffer.concat(chunks);
}

async function nextProxyJson(inbox, type, streamId = null) {
  while (true) {
    const message = await inbox.next();
    assert.equal(message.isBinary, false);
    const value = JSON.parse(Buffer.from(message.data).toString("utf8"));
    if (value.type === type && (!streamId || value.stream_id === streamId)) return value;
    assert.ok(
      ["proxy_pause", "proxy_resume"].includes(value.type),
      `unexpected control message while waiting for ${type}: ${JSON.stringify(value)}`,
    );
  }
}

async function rawUpgrade(port, requestPath) {
  const socket = net.connect(port, "127.0.0.1");
  const chunks = [];
  socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  await once(socket, "connect");
  socket.end([
    `GET ${requestPath} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "",
    "",
  ].join("\r\n"));
  await once(socket, "close");
  return Buffer.concat(chunks).toString("utf8");
}

async function availablePort() {
  const server = http.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(port, child, stderr) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`manager exited ${child.exitCode}: ${stderr()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await delay(50);
  }
  throw new Error(`manager did not become healthy: ${stderr()}`);
}

async function waitForStatus(port, predicate) {
  const deadline = Date.now() + 5000;
  let last = null;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${port}/belabox/api/status`);
    last = await response.json();
    if (predicate(last)) return last;
    await delay(50);
  }
  throw new Error(`manager status condition timed out: ${JSON.stringify(last)}`);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
