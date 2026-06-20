import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../dist/app.js";

test("streams one completed upload into staging", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-upload-"));
  const app = await createApp({
    dataRoot: root,
    maxInputBytes: 1024,
    maxFiles: 10,
    maxSessions: 10,
    publicDir: path.resolve("public"),
    auth: { username: "frame", password: "secret", realm: "FRAME Test" },
  });
  const server = app.listen(0);
  await once(server, "listening");
  const address = server.address();
  const data = new FormData();
  data.append("photo", new Blob(["not validated by input"]), "Phone Photo.jpg");
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/photos/upload`)).status, 401);
  const response = await fetch(`http://127.0.0.1:${address.port}/photos/api/upload`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from("frame:secret").toString("base64")}` },
    body: data,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await readdir(path.join(root, "inbox")), []);
  assert.deepEqual(await readdir(path.join(root, "staging")), ["Phone_Photo.jpg"]);
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
  assert.deepEqual(await response.json(), {
    accepted: true,
    staged_names: ["First_Photo.jpg", "Second_Photo.jpg"],
    count: 2,
  });
  assert.deepEqual((await readdir(path.join(root, "staging"))).sort(), ["First_Photo.jpg", "Second_Photo.jpg"]);
  server.close();
});
