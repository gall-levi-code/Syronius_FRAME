import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { streamCompletedUpload } from "../dist/handoff.js";
import { UploadProgressTracker } from "../dist/progress.js";

async function internalUploadServer(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-upload-stream-"));
  const tracker = new UploadProgressTracker();
  const app = await createApp({
    dataRoot: root, maxInputBytes: 1024, maxFiles: 10, maxSessions: 1,
    publicDir: path.resolve("public"), auth: { username: "frame", password: "secret", realm: "test" },
    serviceToken: "test-service-token", progressTracker: tracker, ...overrides,
  });
  const server = app.listen(0);
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { root, tracker, base, url: `${base}/api/internal/photo-upload/stage`, headers: { authorization: "Bearer test-service-token" } };
}

async function waitUntil(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Upload did not reach the expected state within one second.");
}

test("internal streaming validates actual size and digest before committing", async (t) => {
  const { root, url, headers } = await internalUploadServer(t, { maxInputBytes: 16 });
  for (const [extra, body, status] of [
    [{}, "", 400],
    [{ "x-frame-file-size": "bad" }, "photo", 400],
    [{ "x-frame-file-size": "17" }, "photo", 413],
    [{ "x-frame-file-size": "4" }, "photo", 400],
    [{ "x-frame-file-size": "6" }, "photo", 400],
    [{ "x-frame-file-sha256": "bad" }, "photo", 400],
    [{ "x-frame-file-sha256": "0".repeat(64) }, "photo", 400],
    [{}, "x".repeat(17), 413],
  ]) {
    // Streamed bodies have no Content-Length: the receiver must count actual bytes.
    const response = await fetch(url, {
      method: "POST", headers: { ...headers, ...extra }, body: body ? Readable.from([body]) : "", duplex: "half",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, status, await response.text());
    assert.deepEqual(await readdir(path.join(root, "staging")), []);
  }
});

test("internal handoffs stream live, share browser admission, and retry idempotently", async (t) => {
  const { root, tracker, url, base, headers } = await internalUploadServer(t);
  const digest = createHash("sha256").update("1234567890").digest("hex");
  const identity = { ...headers, "x-frame-transfer-id": "streamed-transfer", "x-frame-file-size": "10", "x-frame-file-sha256": digest.toUpperCase() };
  const request = http.request(url, { method: "POST", headers: identity });
  t.after(() => request.destroy());
  const responsePromise = once(request, "response");
  request.write("12345");
  await waitUntil(() => tracker.snapshot().transfers[0]?.bytes_received === 5);
  assert.equal(tracker.snapshot().transfers[0].phase, "receiving");
  const entries = await readdir(path.join(root, "staging"));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /\.uploading$/);
  await waitUntil(async () => (await readFile(path.join(root, "staging", entries[0], "source"), "utf8")) === "12345");
  assert.equal((await fetch(`${base}/healthz`).then((r) => r.json())).active_sessions, 1);
  assert.equal((await fetch(url, { method: "POST", headers, body: "another" })).status, 429);
  assert.equal((await fetch(`${base}/photos/api/upload`, {
    method: "POST", headers: { authorization: `Basic ${Buffer.from("frame:secret").toString("base64")}` }, body: new FormData(),
  })).status, 429);
  request.end("67890");
  const [response] = await responsePromise;
  assert.equal(response.statusCode, 202);
  response.resume();
  await once(response, "end");
  const retry = await fetch(url, { method: "POST", headers: identity, body: "1234567890" });
  assert.equal(retry.status, 202);
  assert.equal((await retry.json()).journey_id, "streamed-transfer");
  assert.deepEqual(await readdir(path.join(root, "staging")), ["streamed-transfer.frame-photo"]);
  const envelope = path.join(root, "staging", "streamed-transfer.frame-photo");
  assert.equal(await readFile(path.join(envelope, "source"), "utf8"), "1234567890");
  assert.equal(JSON.parse(await readFile(path.join(envelope, "journey.json"), "utf8")).content_sha256, digest);
});

test("internal stalled and interrupted bodies clean partial files and release admission", async (t) => {
  const { root, tracker, url, base, headers } = await internalUploadServer(t, { internalStageTimeoutMs: 150 });
  for (const abort of [false, true]) {
    const transferId = abort ? "interrupted-transfer" : "stalled-transfer";
    const request = http.request(url, { method: "POST", headers: { ...headers, "x-frame-transfer-id": transferId } });
    request.on("error", () => undefined);
    t.after(() => request.destroy());
    const responsePromise = abort ? null : once(request, "response");
    request.write("partial");
    await waitUntil(() => tracker.snapshot().transfers.some((item) => item.transfer_id === transferId && item.bytes_received === 7));
    if (abort) request.destroy();
    else {
      const [response] = await responsePromise;
      assert.equal(response.statusCode, 408);
      response.resume();
      await once(response, "end");
    }
    await waitUntil(() => tracker.snapshot().transfers.find((item) => item.transfer_id === transferId)?.phase === "failed");
    assert.deepEqual(await readdir(path.join(root, "staging")), []);
    assert.equal((await fetch(`${base}/healthz`).then((r) => r.json())).active_sessions, 0);
  }
  assert.equal((await fetch(url, { method: "POST", headers, body: "retry" })).status, 202);
});

test("streams one completed upload into staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-upload-"));
  const app = await createApp({
    dataRoot: root,
    maxInputBytes: 1024,
    maxFiles: 10,
    maxSessions: 10,
    publicDir: path.resolve("public"),
    auth: { username: "frame", password: "secret", realm: "FRAME Test" },
    serviceToken: "test-service-token",
  });
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  const data = new FormData();
  data.append("photo", new Blob(["not validated by input"]), "Phone Photo.jpg");
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/photos/upload`)).status, 401);
  const response = await fetch(`http://127.0.0.1:${address.port}/photos/api/upload`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from("frame:secret").toString("base64")}`,
      "x-frame-transfer-id": "transfer-test-1",
      "x-frame-file-size": "22",
    },
    body: data,
  });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  assert.equal(accepted.transfer_id, "transfer-test-1");
  assert.equal(accepted.journey_id, "transfer-test-1");
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/internal/photo-upload/progress`)).status, 401);
  const progress = await fetch(`http://127.0.0.1:${address.port}/api/internal/photo-upload/progress`, {
    headers: { authorization: "Bearer test-service-token" },
  });
  const snapshot = await progress.json();
  assert.equal(snapshot.transfers[0].phase, "queued");
  assert.equal(snapshot.transfers[0].transfer_id, "transfer-test-1");
  assert.equal(snapshot.transfers[0].journey_id, "transfer-test-1");
  assert.equal(snapshot.transfers[0].source_adapter, "web_upload");
  assert.deepEqual(await readdir(path.join(root, "inbox")), []);
  const envelope = path.join(root, "staging", "transfer-test-1.frame-photo");
  assert.deepEqual(await readdir(path.join(root, "staging")), ["transfer-test-1.frame-photo"]);
  assert.equal(await readFile(path.join(envelope, "source"), "utf8"), "not validated by input");
  const journey = JSON.parse(await readFile(path.join(envelope, "journey.json"), "utf8"));
  assert.equal(journey.journey_id, "transfer-test-1");
  assert.equal(journey.content_sha256, createHash("sha256").update("not validated by input").digest("hex"));
  server.close();
});

test("rejects different same-size content for an existing journey", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-upload-conflict-"));
  const staging = path.join(root, "staging");
  const journey = { journeyId: "journey-conflict", transferId: "transfer-first", adapter: "web_upload" };
  await streamCompletedUpload(Readable.from("first"), "photo.jpg", staging, journey);
  await assert.rejects(
    streamCompletedUpload(Readable.from("other"), "photo.jpg", staging, { ...journey, transferId: "transfer-second" }),
    /different upload content or metadata/,
  );
  assert.equal(await readFile(path.join(staging, "journey-conflict.frame-photo", "source"), "utf8"), "first");
  assert.deepEqual(await readdir(staging), ["journey-conflict.frame-photo"]);
});

test("stages a completed internal upload with the service token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-upload-internal-"));
  const app = await createApp({
    dataRoot: root,
    maxInputBytes: 1024,
    maxFiles: 10,
    maxSessions: 10,
    publicDir: path.resolve("public"),
    auth: { username: "frame", password: "secret", realm: "FRAME Test" },
    serviceToken: "test-service-token",
  });
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();

  assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/internal/photo-upload/stage`, {
    method: "POST",
    body: "no token",
  })).status, 401);

  const response = await fetch(`http://127.0.0.1:${address.port}/api/internal/photo-upload/stage`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-service-token",
      "content-type": "application/octet-stream",
      "x-frame-transfer-id": "internal-transfer",
      "x-frame-journey-id": "journey-internal",
      "x-frame-ingest-adapter": "belabox_chunked",
      "x-frame-file-size": "13",
      "x-frame-filename": "Belabox Test.JPG",
    },
    body: "internal file",
  });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  assert.equal(accepted.transfer_id, "internal-transfer");
  assert.equal(accepted.journey_id, "journey-internal");
  const progress = await fetch(`http://127.0.0.1:${address.port}/api/internal/photo-upload/progress`, {
    headers: { authorization: "Bearer test-service-token" },
  }).then((result) => result.json());
  assert.equal(progress.transfers[0].source_adapter, "belabox_chunked");
  const envelope = path.join(root, "staging", "journey-internal.frame-photo");
  assert.deepEqual(await readdir(path.join(root, "staging")), ["journey-internal.frame-photo"]);
  assert.equal(await readFile(path.join(envelope, "source"), "utf8"), "internal file");
  assert.equal(JSON.parse(await readFile(path.join(envelope, "journey.json"), "utf8")).ingest.adapter, "belabox_chunked");

  const invalid = await fetch(`http://127.0.0.1:${address.port}/api/internal/photo-upload/stage`, {
    method: "POST",
    headers: { authorization: "Bearer test-service-token", "content-type": "application/octet-stream", "x-frame-journey-id": "bad id" },
    body: "invalid",
  });
  assert.equal(invalid.status, 400);
  const reservedDelimiter = await fetch(`http://127.0.0.1:${address.port}/api/internal/photo-upload/stage`, {
    method: "POST",
    headers: { authorization: "Bearer test-service-token", "content-type": "application/octet-stream", "x-frame-journey-id": "journey__ambiguous" },
    body: "invalid",
  });
  assert.equal(reservedDelimiter.status, 400);
  const invalidAdapter = await fetch(`http://127.0.0.1:${address.port}/api/internal/photo-upload/stage`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-service-token",
      "content-type": "application/octet-stream",
      "x-frame-journey-id": "journey-valid",
      "x-frame-ingest-adapter": "Bad Adapter",
    },
    body: "invalid",
  });
  assert.equal(invalidAdapter.status, 400);
  server.close();
});

test("reports limits and accepts multiple files in one upload request", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-upload-"));
  const app = await createApp({
    dataRoot: root,
    maxInputBytes: 1024,
    maxFiles: 10,
    maxSessions: 10,
    publicDir: path.resolve("public"),
    auth: { username: "frame", password: "secret", realm: "FRAME Test" },
    serviceToken: "test-service-token",
  });
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  const auth = { authorization: `Basic ${Buffer.from("frame:secret").toString("base64")}` };

  const config = await fetch(`http://127.0.0.1:${address.port}/photos/api/config`, { headers: auth });
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), {
    max_input_bytes: 1024,
    max_files: 10,
    max_sessions: 10,
    active_sessions: 0,
  });

  const data = new FormData();
  data.append("photo", new Blob(["one"]), "First Photo.jpg");
  data.append("photo", new Blob(["two"]), "Second Photo.jpg");
  const response = await fetch(`http://127.0.0.1:${address.port}/photos/api/upload`, {
    method: "POST",
    headers: auth,
    body: data,
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.accepted, true);
  assert.deepEqual(body.staged_names, ["First_Photo.jpg", "Second_Photo.jpg"]);
  assert.equal(body.count, 2);
  assert.equal(body.staged_name, "First_Photo.jpg");
  assert.equal(body.transfer_ids.length, 2);
  assert.deepEqual(body.journey_ids, body.transfer_ids);
  assert.equal((await readdir(path.join(root, "staging"))).every((entry) => entry.endsWith(".frame-photo")), true);
  server.close();
});

test("tracks concurrent files independently and expires terminal transfers", () => {
  let now = new Date("2026-06-21T12:00:00Z");
  const tracker = new UploadProgressTracker(() => now, 1000);
  tracker.begin("transfer-a", "journey-a", "a.jpg", 1000);
  tracker.begin("transfer-b", "journey-b", "b.jpg", null);
  tracker.addBytes("transfer-a", 400);
  tracker.addBytes("transfer-b", 250);
  now = new Date("2026-06-21T12:00:01Z");
  let snapshot = tracker.snapshot();
  assert.equal(snapshot.transfers.length, 2);
  assert.equal(snapshot.transfers[0].speed_bps, 400);
  assert.equal(snapshot.transfers[1].bytes_total, null);
  tracker.queued("transfer-a");
  assert.equal(tracker.snapshot().transfers.find((item) => item.transfer_id === "transfer-a").phase, "queued");
  now = new Date("2026-06-21T12:00:03Z");
  snapshot = tracker.snapshot();
  assert.deepEqual(snapshot.transfers.map((item) => item.transfer_id), ["transfer-b"]);
});

test("exposes live receiving progress while a web upload is still streaming", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-upload-live-"));
  const app = await createApp({
    dataRoot: root,
    maxInputBytes: 4096,
    maxFiles: 10,
    maxSessions: 10,
    publicDir: path.resolve("public"),
    auth: { username: "frame", password: "secret", realm: "FRAME Test" },
    serviceToken: "test-service-token",
  });
  const server = app.listen(0);
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  const boundary = "frame-test-boundary";
  const preamble = `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="slow.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`;
  const ending = `\r\n--${boundary}--\r\n`;
  const responsePromise = new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/photos/api/upload",
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from("frame:secret").toString("base64")}`,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        "x-frame-transfer-id": "slow-transfer",
        "x-frame-file-size": "10",
      },
    }, resolve);
    request.on("error", reject);
    request.write(preamble);
    request.write("12345");
    t.after(() => request.destroy());
    setTimeout(() => {
      request.write("67890");
      request.end(ending);
    }, 80);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const progress = await fetch(`http://127.0.0.1:${port}/api/internal/photo-upload/progress`, {
    headers: { authorization: "Bearer test-service-token" },
  }).then((response) => response.json());
  assert.equal(progress.transfers[0].phase, "receiving");
  assert.equal(progress.transfers[0].bytes_received, 5);
  assert.equal(progress.transfers[0].bytes_total, 10);
  const response = await responsePromise;
  assert.equal(response.statusCode, 202);
  response.resume();
});

test("cleans up an interrupted upload without destabilizing the service", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-upload-abort-"));
  const app = await createApp({
    dataRoot: root,
    maxInputBytes: 4096,
    maxFiles: 10,
    maxSessions: 10,
    publicDir: path.resolve("public"),
    auth: { username: "frame", password: "secret", realm: "FRAME Test" },
    serviceToken: "test-service-token",
  });
  const server = app.listen(0);
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  const boundary = "frame-abort-boundary";
  const request = http.request({
    host: "127.0.0.1",
    port,
    path: "/photos/api/upload",
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from("frame:secret").toString("base64")}`,
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "x-frame-transfer-id": "aborted-transfer",
      "x-frame-file-size": "100",
    },
  });
  request.on("error", () => undefined);
  request.write(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="aborted.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
  request.write("partial");
  await new Promise((resolve) => setTimeout(resolve, 30));
  request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const progress = await fetch(`http://127.0.0.1:${port}/api/internal/photo-upload/progress`, {
    headers: { authorization: "Bearer test-service-token" },
  }).then((response) => response.json());
  assert.equal(progress.transfers.find((item) => item.transfer_id === "aborted-transfer").phase, "failed");
  assert.deepEqual(await readdir(path.join(root, "inbox")), []);
  assert.deepEqual(await readdir(path.join(root, "staging")), []);
  assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
});
