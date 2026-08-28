import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import WebSocket from "ws";

const serviceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const protocol = "frame-belabox-control-v1";
const deviceId = "security-test-device";
const agentVersion = "0.9.0-security-test";

test("manager URL copying requires browser-confirmed clipboard success", async () => {
  const script = await readFile(path.join(serviceRoot, "public", "app.js"), "utf8");
  assert.match(script, /navigator\.clipboard\?\.writeText/);
  assert.match(script, /clipboardData\.setData\("text\/plain", text\)/);
  assert.match(script, /document\.execCommand\("copy"\) && copied/);
  assert.match(script, /Automatic copy was blocked\. Press and hold this URL to copy it:/);
});
const legacySecret = "legacy-control-secret-0123456789abcdef";

test("migrates upload credentials, bounds pending authentication per IP, and blocks LAN installs", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "frame-belabox-security-"));
  const port = await availablePort();
  const now = new Date().toISOString();
  await writeFile(path.join(dataRoot, "devices.json"), `${JSON.stringify([{
    device_id: deviceId,
    display_name: "Security Test Device",
    mqtt_password: legacySecret,
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
      FRAME_MODE: "LAN",
      BELABOX_CONTROL_PUBLIC_URL: `ws://127.0.0.1:${port}/belabox/control`,
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

  const migrated = JSON.parse(await readFile(path.join(dataRoot, "devices.json"), "utf8"));
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].control_secret, legacySecret);
  assert.equal(typeof migrated[0].upload_token, "string");
  assert.ok(migrated[0].upload_token.length >= 32);
  assert.notEqual(migrated[0].upload_token, legacySecret);
  assert.equal("mqtt_password" in migrated[0], false);

  const controlSocket = new WebSocket(`ws://127.0.0.1:${port}/belabox/control`);
  const controlInbox = messageInbox(controlSocket);
  await once(controlSocket, "open");
  const challenge = await controlInbox.json();
  controlSocket.send(JSON.stringify({
    type: "hello",
    device_id: deviceId,
    agent_version: agentVersion,
    nonce: challenge.nonce,
    proof: controlProof(legacySecret, deviceId, agentVersion, challenge.nonce),
  }));
  assert.equal((await controlInbox.json()).type, "authenticated");
  controlSocket.close();

  const rejectedUpload = await fetch(`http://127.0.0.1:${port}/belabox-chunks/api/diagnostics/speed-test?bytes=0`, {
    headers: {
      authorization: `Bearer ${legacySecret}`,
      "x-belabox-device-id": deviceId,
    },
  });
  assert.equal(rejectedUpload.status, 401);
  const acceptedUpload = await fetch(`http://127.0.0.1:${port}/belabox-chunks/api/diagnostics/speed-test?bytes=0`, {
    headers: {
      authorization: `Bearer ${migrated[0].upload_token}`,
      "x-belabox-device-id": deviceId,
    },
  });
  assert.equal(acceptedUpload.status, 200);

  const installResponse = await fetch(`http://127.0.0.1:${port}/belabox/api/pair/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(installResponse.status, 409);
  assert.match((await installResponse.json()).error, /Hybrid mode.+wss:\/\//i);

  const status = await statusPayload(port);
  assert.equal(status.control.agent_install_ready, false);
  assert.equal(status.control.max_pending_authentications, 64);
  const perIpLimit = status.control.max_pending_authentications_per_ip;
  assert.equal(perIpLimit, 8);

  const pendingSockets = [];
  for (let index = 0; index < perIpLimit; index += 1) {
    const pending = new WebSocket(`ws://127.0.0.1:${port}/belabox/control`);
    const inbox = messageInbox(pending);
    await once(pending, "open");
    assert.equal((await inbox.json()).type, "challenge");
    pendingSockets.push(pending);
  }
  await waitForStatus(port, (value) => value.control.pending_authentications === perIpLimit);

  const overflow = new WebSocket(`ws://127.0.0.1:${port}/belabox/control`);
  const overflowClose = once(overflow, "close");
  await once(overflow, "open");
  const [overflowCode] = await overflowClose;
  assert.equal(overflowCode, 1013);

  const released = pendingSockets.pop();
  const releasedClose = once(released, "close");
  released.terminate();
  await releasedClose;
  await waitForStatus(port, (value) => value.control.pending_authentications === perIpLimit - 1);

  const replacement = new WebSocket(`ws://127.0.0.1:${port}/belabox/control`);
  const replacementInbox = messageInbox(replacement);
  await once(replacement, "open");
  assert.equal((await replacementInbox.json()).type, "challenge");
  replacement.terminate();
  for (const pending of pendingSockets) pending.terminate();
  await waitForStatus(port, (value) => value.control.pending_authentications === 0);
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

async function statusPayload(port) {
  const response = await fetch(`http://127.0.0.1:${port}/belabox/api/status`);
  assert.equal(response.status, 200);
  return response.json();
}

async function waitForStatus(port, predicate) {
  const deadline = Date.now() + 5000;
  let last = null;
  while (Date.now() < deadline) {
    last = await statusPayload(port);
    if (predicate(last)) return last;
    await delay(25);
  }
  throw new Error(`manager status condition timed out: ${JSON.stringify(last)}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
