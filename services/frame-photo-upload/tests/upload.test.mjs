import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { UploadProgressTracker } from "../dist/progress.js";

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
  assert.equal((await response.json()).transfer_id, "transfer-test-1");
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/api/internal/photo-upload/progress`)).status, 401);
  const progress = await fetch(`http://127.0.0.1:${address.port}/api/internal/photo-upload/progress`, {
    headers: { authorization: "Bearer test-service-token" },
  });
  const snapshot = await progress.json();
  assert.equal(snapshot.transfers[0].phase, "queued");
  assert.equal(snapshot.transfers[0].transfer_id, "transfer-test-1");
  assert.deepEqual(await readdir(path.join(root, "inbox")), []);
  assert.deepEqual(await readdir(path.join(root, "staging")), ["Phone_Photo.jpg"]);
  assert.equal(await readFile(path.join(root, "staging", "Phone_Photo.jpg"), "utf8"), "not validated by input");
  server.close();
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
      "x-frame-file-size": "13",
      "x-frame-filename": "Belabox Test.JPG",
    },
    body: "internal file",
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).transfer_id, "internal-transfer");
  assert.deepEqual(await readdir(path.join(root, "staging")), ["Belabox_Test.jpg"]);
  assert.equal(await readFile(path.join(root, "staging", "Belabox_Test.jpg"), "utf8"), "internal file");
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
  assert.deepEqual((await readdir(path.join(root, "staging"))).sort(), ["First_Photo.jpg", "Second_Photo.jpg"]);
  server.close();
});

test("tracks concurrent files independently and expires terminal transfers", () => {
  let now = new Date("2026-06-21T12:00:00Z");
  const tracker = new UploadProgressTracker(() => now, 1000);
  tracker.begin("transfer-a", "a.jpg", 1000);
  tracker.begin("transfer-b", "b.jpg", null);
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
