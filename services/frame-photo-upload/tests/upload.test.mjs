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
