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

test("persists branding settings and constrains uploaded logos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-gallery-"));
  const store = new GalleryStore(root, 320, 80);
  await store.init();

  const defaults = await store.getBranding();
  assert.equal(defaults.presets.length, 5);
  assert.deepEqual(defaults.custom_profiles, []);
  assert.equal(defaults.mode, "system");
  assert.equal(defaults.logo, null);
  const fullPalette = {
    day: { ...defaults.active_profile.palettes.day, accent: "#123456", background: "#f7f7f7" },
    night: { ...defaults.active_profile.palettes.night, accent: "#abcdef", background: "#08090a" },
  };

  const updated = await store.updateBranding({
    brand_name: "North Studio",
    gallery_title: "Launch Photos",
    mode: "night",
    profile_id: "custom-midnight-field",
    custom_profiles: [
      { id: "custom-launch-orange", name: "Launch Orange", theme_color: "#ff6600" },
      { id: "custom-midnight-field", name: "Midnight Field", theme_color: "#123456", palettes: fullPalette },
    ],
  });
  assert.equal(updated.brand_name, "North Studio");
  assert.equal(updated.presets.length, 7);
  assert.equal(updated.custom_profiles.length, 2);
  assert.equal(updated.active_profile.id, "custom-midnight-field");
  assert.equal(updated.active_profile.theme_color, "#123456");
  assert.equal(updated.active_profile.palettes.day.accent, "#123456");
  assert.equal(updated.active_profile.palettes.night.accent, "#abcdef");
  assert.notEqual(updated.active_profile.palettes.day.background, updated.active_profile.palettes.night.background);

  const logo = await pngBuffer(900, 260, "#ff6600");
  const branded = await store.saveLogo({ data_url: `data:image/png;base64,${logo.toString("base64")}` });
  assert.equal(branded.logo.width <= 720, true);
  assert.equal(branded.logo.height <= 240, true);
  assert.equal((await sharp(await readFile(await store.requireLogo())).metadata()).format, "webp");

  const svgLogo = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400"><path d="M240 80h720v240H240z" fill="#123456"/><circle cx="600" cy="200" r="96" fill="#ffffff" fill-opacity=".55"/></svg>`);
  const svgBranded = await store.saveLogo({ data_url: `data:image/svg+xml;base64,${svgLogo.toString("base64")}` });
  assert.equal(svgBranded.logo.width <= 720, true);
  assert.equal(svgBranded.logo.height <= 240, true);
  const svgOutput = sharp(await readFile(await store.requireLogo()));
  const svgMetadata = await svgOutput.metadata();
  assert.equal(svgMetadata.format, "webp");
  assert.equal(svgMetadata.hasAlpha, true);
  const { data } = await svgOutput.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(data[3], 0);

  const tooWide = await pngBuffer(1200, 80, "#2cb4fb");
  await assert.rejects(
    store.saveLogo({ data_url: `data:image/png;base64,${tooWide.toString("base64")}` }),
    /too wide or tall/,
  );
  assert.equal((await store.deleteLogo()).logo, null);
  await assert.rejects(store.requireLogo());
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
    assert.equal((await fetch(`${base}/gallery/admin/api/branding`, { method: "PUT" })).status, 401);
    assert.equal((await fetch(`${base}/gallery/api/branding`).then((response) => response.json())).branding.presets.length, 5);
    const branding = await fetch(`${base}/gallery/admin/api/branding`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        brand_name: "North Studio",
        gallery_title: "Launch Photos",
        mode: "day",
        profile_id: "custom-launch-orange",
        custom_profiles: [{ id: "custom-launch-orange", name: "Launch Orange", theme_color: "#ff6600" }],
      }),
    }).then((response) => response.json());
    assert.equal(branding.branding.brand_name, "North Studio");
    assert.equal(branding.branding.active_profile.id, "custom-launch-orange");
    assert.equal(branding.branding.presets.length, 6);
    assert.equal((await fetch(`${base}/gallery/api/branding`).then((response) => response.json())).branding.gallery_title, "Launch Photos");
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

async function pngBuffer(width, height, background) {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}
