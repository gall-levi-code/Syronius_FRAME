import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const serviceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const uploadToken = "test-upload-token-0123456789abcdef";
const serviceToken = "test-service-token";
const digest = (body) => createHash("sha256").update(body).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("chunk staging streams verified data, coalesces completion and recovers from stalled receipts", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "frame-belabox-chunks-"));
  const stageCalls = new Map();
  const accepted = new Map();
  const behavior = new Map();
  const received = new Map();
  let releaseStage;
  const stageGate = new Promise((resolve) => { releaseStage = resolve; });
  const upstream = http.createServer((request, response) => {
    void (async () => {
      const id = request.headers["x-frame-transfer-id"];
      stageCalls.set(id, (stageCalls.get(id) ?? 0) + 1);
      if (behavior.get(id) === "stall-request") return;
      let size = 0;
      const hash = createHash("sha256");
      for await (const chunk of request) {
        size += chunk.length;
        hash.update(chunk);
      }
      received.set(id, { size, sha256: hash.digest("hex"), headers: request.headers });
      response.setHeader("Content-Type", "application/json");
      if (behavior.get(id) === "reject") {
        response.writeHead(503).end('{"error":"temporarily unavailable"}');
        return;
      }
      const receipt = accepted.get(id) ?? { staged_name: `${id}.jpg`, transfer_id: id, journey_id: id };
      accepted.set(id, receipt);
      if (behavior.get(id) === "gate") await stageGate;
      if (behavior.get(id) === "stall-body") {
        response.write('{"staged_name":');
        return;
      }
      if (behavior.get(id) === "invalid-receipt") {
        response.end("{}");
        return;
      }
      response.end(JSON.stringify(receipt));
    })().catch(() => response.destroy());
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const portProbe = http.createServer();
  portProbe.listen(0, "127.0.0.1");
  await once(portProbe, "listening");
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  await writeFile(path.join(dataRoot, "devices.json"), JSON.stringify([{
    device_id: "chunk-device", display_name: "Chunk Test Device", upload_token: uploadToken,
    control_secret: "test-control-secret-0123456789abcdef", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }]));
  const preload = path.join(dataRoot, "guard-file-io.cjs");
  await writeFile(preload, String.raw`
const fs = require("node:fs");
const bulkFile = (file) => /(?:[/\\]chunks[/\\]|[/\\]assembled\.tmp$)/.test(String(file));
for (const name of ["readFileSync", "writeFileSync", "appendFileSync"]) {
  const original = fs[name];
  fs[name] = (file, ...args) => {
    if (bulkFile(file)) throw new Error("Synchronous chunk/photo IO is forbidden");
    return original(file, ...args);
  };
}
for (const api of [fs, fs.promises]) {
  const original = api.readFile;
  api.readFile = (file, ...args) => {
    if (bulkFile(file)) throw new Error("Whole chunk/photo reads are forbidden");
    return original(file, ...args);
  };
}
`);
  let stderr = "";
  const manager = spawn(process.execPath, ["--require", preload, "dist/index.js"], {
    cwd: serviceRoot,
    env: {
      ...process.env, PORT: String(port), DATA_ROOT: dataRoot, FRAME_MODE: "LAN", SLS_API_KEY: "",
      PORTAL_SERVICE_TOKEN: serviceToken, PHOTO_UPLOAD_API_URL: `http://127.0.0.1:${upstream.address().port}`,
      BELABOX_CHUNK_STAGE_TIMEOUT_MS: "1000", BELABOX_CONTROL_PUBLIC_URL: `ws://127.0.0.1:${port}/belabox/control`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  manager.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  context.after(async () => {
    releaseStage();
    manager.kill();
    await Promise.race([once(manager, "exit"), delay(2000)]).catch(() => undefined);
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dataRoot, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => {
    if (manager.exitCode !== null) throw new Error(`Manager exited: ${stderr}`);
    return fetch(`${base}/healthz`).then((response) => response.ok).catch(() => false);
  });
  const request = (url, method = "POST", body, contentType = "application/json") => fetch(`${base}${url}`, {
    method, headers: { authorization: `Bearer ${uploadToken}`, "content-type": contentType }, body,
    signal: AbortSignal.timeout(5000),
  });
  const pieces = [Buffer.alloc(256 * 1024, 7), Buffer.alloc(256 * 1024, 8), Buffer.alloc(1234, 9)];
  const manifestFor = (id, overrides = {}) => ({
    transfer_id: id, journey_id: id, device_id: "chunk-device", filename: "photo.jpg",
    size_bytes: pieces.reduce((total, chunk) => total + chunk.length, 0), chunk_size_bytes: 256 * 1024,
    chunk_count: pieces.length, file_sha256: digest(Buffer.concat(pieces)),
    chunks: pieces.map((chunk, index) => ({ index, size_bytes: chunk.length, sha256: digest(chunk) })),
    ...overrides,
  });
  const upload = async (id, overrides = {}) => {
    const manifest = manifestFor(id, overrides);
    assert.equal((await request("/belabox-chunks/api/transfers", "POST", JSON.stringify(manifest))).status, 201);
    const replies = await Promise.all(pieces.map((piece, index) => request(`/belabox-chunks/api/transfers/${id}/chunks/${index}`, "PUT", piece, "application/octet-stream")));
    assert.ok(replies.every((response) => response.status === 200));
    return manifest;
  };
  const complete = (id) => request(`/belabox-chunks/api/transfers/${id}/complete`, "POST", "{}");
  const transferPath = (id, ...parts) => path.join(dataRoot, "chunk-uploads", id, ...parts);
  const assertRetryable = async (id) => {
    await assert.rejects(readFile(transferPath(id, "assembled.tmp")), { code: "ENOENT" });
    await assert.rejects(readFile(transferPath(id, "completed.json")), { code: "ENOENT" });
    assert.deepEqual(await readFile(transferPath(id, "chunks", "0.part")), pieces[0]);
  };

  await context.test("concurrent completion verifies both hashes, forwards integrity headers and keeps one receipt", async () => {
    const id = "concurrent-transfer";
    const manifest = await upload(id);
    assert.equal((await request(`/belabox-chunks/api/transfers/${id}/chunks/0`, "PUT", pieces[0], "application/octet-stream")).status, 200);
    behavior.set(id, "gate");
    const first = complete(id);
    await waitFor(() => received.has(id));
    const rest = [complete(id), complete(id)];
    assert.equal((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(500) })).status, 200);
    releaseStage();
    const replies = await Promise.all([first, ...rest]);
    for (const response of replies) {
      assert.equal(response.status, 202, stderr);
      assert.equal((await response.json()).staged_name, `${id}.jpg`);
    }
    assert.equal(stageCalls.get(id), 1);
    const forwarded = received.get(id);
    assert.equal(forwarded.size, manifest.size_bytes);
    assert.equal(forwarded.sha256, manifest.file_sha256);
    assert.equal(forwarded.headers["content-length"], String(manifest.size_bytes));
    assert.equal(forwarded.headers["x-frame-file-size"], String(manifest.size_bytes));
    assert.equal(forwarded.headers["x-frame-file-sha256"], manifest.file_sha256);
    assert.equal(forwarded.headers["x-frame-journey-id"], id);
    assert.equal(forwarded.headers.authorization, `Bearer ${serviceToken}`);
    await assert.rejects(readFile(transferPath(id, "chunks", "0.part")), { code: "ENOENT" });
    await assert.rejects(readFile(transferPath(id, "assembled.tmp")), { code: "ENOENT" });
    assert.equal((await complete(id)).status, 202);
    assert.equal(stageCalls.get(id), 1);
    assert.equal(JSON.parse(await readFile(transferPath(id, "completed.json"))).staged_name, `${id}.jpg`);
  });

  await context.test("missing, changed and truncated chunks and incorrect whole-file hashes never stage", async () => {
    const id = "integrity-transfer";
    await upload(id);
    const target = transferPath(id, "chunks", "1.part");
    await rm(target);
    assert.equal((await complete(id)).status, 409);
    await writeFile(target, Buffer.alloc(pieces[1].length, 0));
    assert.equal((await complete(id)).status, 409);
    await writeFile(target, pieces[1].subarray(1));
    assert.equal((await complete(id)).status, 409);
    assert.equal(stageCalls.has(id), false);
    await assertRetryable(id);
    await writeFile(target, pieces[1]);
    assert.equal((await complete(id)).status, 202);
    await upload("wrong-file-hash", { file_sha256: "0".repeat(64) });
    assert.equal((await complete("wrong-file-hash")).status, 409);
    assert.equal(stageCalls.has("wrong-file-hash"), false);
    await assertRetryable("wrong-file-hash");
  });

  for (const mode of ["stall-request", "stall-body", "reject", "invalid-receipt"]) {
    await context.test(`${mode} releases the pending completion and safely retries the same identity`, async () => {
      const id = `recovery-${mode}`;
      await upload(id);
      behavior.set(id, mode);
      const response = await complete(id);
      assert.equal(response.status, mode.startsWith("stall") ? 504 : 502, await response.text());
      await assertRetryable(id);
      const earlierReceipt = accepted.get(id);
      behavior.delete(id);
      const retry = await complete(id);
      assert.equal(retry.status, 202, await retry.text());
      assert.equal(stageCalls.get(id), 2);
      if (earlierReceipt) assert.equal(accepted.get(id), earlierReceipt, "accepted-but-lost responses retain their original upstream identity");
      assert.equal((await complete(id)).status, 202);
      assert.equal(stageCalls.get(id), 2);
    });
  }
});

async function waitFor(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("Timed out waiting for the manager or staging request");
}
