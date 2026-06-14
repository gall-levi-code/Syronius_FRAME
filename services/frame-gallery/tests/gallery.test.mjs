import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { createApp } from "../dist/app.js";
import { GalleryStore } from "../dist/store.js";

test("lists and serves only ready publications", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-gallery-"));
  const date = "2026-06-13";
  const gallery = path.join(root, "galleries", date);
  await mkdir(gallery, { recursive: true });
  await publish(gallery, "visible", true);
  await publish(gallery, "partial", false);
  await publish(gallery, "trashed", true);
  await writeFile(path.join(gallery, "trashed.trashed.json"), JSON.stringify({ trashed_at: new Date().toISOString() }));
  const store = new GalleryStore(root, 320, 80);
  await store.init();

  const dates = await store.listDates();
  assert.deepEqual(dates.map((item) => item.date_folder), [date]);
  assert.equal(dates[0].cover_thumbnail_url, `/gallery/thumb/${date}/visible.webp`);
  assert.equal(dates[0].duration_ms, 0);
  assert.deepEqual((await store.listPhotos(date)).map((photo) => photo.base), ["visible"]);
  const thumbnail = await store.requireThumbnail(date, "visible");
  assert.equal((await sharp(thumbnail).metadata()).format, "webp");
  await assert.rejects(store.requireImage(date, "partial"));
  await assert.rejects(store.requireImage(date, "trashed"));
  assert.match(await store.requireAdminImage(date, "trashed"), /trashed\.jpg$/);
  assert.equal((await sharp(await store.requireAdminThumbnail(date, "trashed")).metadata()).format, "webp");
});

test("gallery HTTP API blocks unpublished media", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-gallery-"));
  const date = "2026-06-13";
  const gallery = path.join(root, "galleries", date);
  await mkdir(gallery, { recursive: true });
  await publish(gallery, "visible", true);
  await publish(gallery, "partial", false);
  const app = await createApp(new GalleryStore(root, 320, 80), path.resolve("public"));
  const server = app.listen(0);
  await once(server, "listening");
  const port = server.address().port;

  const photos = await fetch(`http://127.0.0.1:${port}/gallery/api/photos?date=${date}`).then((response) => response.json());
  assert.deepEqual(photos.photos.map((photo) => photo.base), ["visible"]);
  assert.equal((await fetch(`http://127.0.0.1:${port}/gallery/image/${date}/visible.jpg`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/gallery/image/${date}/partial.jpg`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/gallery/image/not-a-date/visible.jpg`)).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/gallery/thumb/${date}/visible.webp`)).headers.get("content-type"), "image/webp");
  assert.equal((await fetch(`http://127.0.0.1:${port}/today/gallery/${date}/`)).status, 200);
  server.close();
});

test("gallery admin is protected and proxies management through the internal service token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-gallery-"));
  const pipeline = createServer(async (request, response) => {
    assert.equal(request.headers["x-frame-service-token"], "service-secret");
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/internal/photo-pipeline/trash") {
      response.end(JSON.stringify({ trash: [] }));
      return;
    }
    response.end(JSON.stringify({ ok: true, action: "empty-trash", affected: 0 }));
  });
  pipeline.listen(0);
  await once(pipeline, "listening");
  const pipelinePort = pipeline.address().port;
  const app = await createApp(new GalleryStore(root, 320, 80), path.resolve("public"), {
    pipelineUrl: `http://127.0.0.1:${pipelinePort}`,
    serviceToken: "service-secret",
    auth: { username: "frame", password: "secret", realm: "FRAME Test" },
  });
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from("frame:secret").toString("base64")}`;
  try {
    assert.equal((await fetch(`${base}/today/gallery/admin`)).status, 401);
    assert.equal((await fetch(`${base}/today/gallery/admin`, { headers: { authorization } })).status, 200);
    assert.deepEqual(await fetch(`${base}/gallery/admin/api/trash`, { headers: { authorization } }).then((response) => response.json()), { trash: [] });
    const result = await fetch(`${base}/gallery/admin/api/manage`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "empty-trash" }),
    }).then((response) => response.json());
    assert.equal(result.action, "empty-trash");
  } finally {
    await Promise.all([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => pipeline.close(resolve)),
    ]);
  }
});

async function publish(directory, base, ready) {
  await sharp({ create: { width: 120, height: 80, channels: 3, background: "#2cb4fb" } })
    .jpeg()
    .toFile(path.join(directory, `${base}.jpg`));
  await writeFile(path.join(directory, `${base}.json`), JSON.stringify({
    width: 120,
    height: 80,
    orientation: 0,
    processed_at: "2026-06-13T12:00:00.000Z",
  }));
  await writeFile(path.join(directory, `${base}.txt`), "Camera: FRAME Test\n");
  if (ready) await writeFile(path.join(directory, `${base}.ready`), "ready\n");
}
