import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  await writeFile(path.join(gallery, "_explore.json"), JSON.stringify(exploreDocument("visible")));
  const store = new GalleryStore(root, 320, 80);
  await store.init();

  const dates = await store.listDates();
  assert.deepEqual(dates.map((item) => item.date_folder), [date]);
  assert.equal(dates[0].cover_base, "visible");
  assert.equal(dates[0].cover_fallback_active, false);
  assert.equal(dates[0].cover_is_custom, false);
  assert.equal(dates[0].cover_thumbnail_url, `/gallery/thumb/${date}/visible.webp`);
  assert.equal(dates[0].duration_ms, 0);
  assert.equal(dates[0].has_explore, true);
  const photos = await store.listPhotos(date);
  assert.deepEqual(photos.map((photo) => photo.base), ["visible"]);
  assert.equal(photos[0].capture_clock, "2026-06-13T17:00:00.000Z");
  assert.equal(Object.hasOwn(photos[0], "image_url"), false);
  assert.equal((await store.getExplore(date)).routes.length, 1);
  const thumbnail = await store.requireThumbnail(date, "visible");
  assert.equal((await sharp(thumbnail).metadata()).format, "webp");
  const view = await store.createTileView(date, "visible");
  assert.deepEqual(
    { width: view.width, height: view.height, columns: view.columns, rows: view.rows, tile_size: view.tile_size, overlap: view.overlap },
    { width: 120, height: 80, columns: 1, rows: 1, tile_size: 512, overlap: 1 },
  );
  const [tile, duplicateTile] = await Promise.all([
    store.requireTile(view, 0, 0),
    store.requireTile(view, 0, 0),
  ]);
  assert.equal(duplicateTile, tile);
  assert.deepEqual(
    await sharp(tile).metadata().then(({ format, width, height, exif }) => ({ format, width, height, exif })),
    { format: "webp", width: 120, height: 80, exif: undefined },
  );
  await assert.rejects(store.requireTile(view, 1, 0), (error) => error.status === 404);
  await assert.rejects(store.requireImage(date, "partial"));
  await assert.rejects(store.requireImage(date, "trashed"));
  assert.match(await store.requireAdminImage(date, "trashed"), /trashed\.jpg$/);
  assert.equal((await sharp(await store.requireAdminThumbnail(date, "trashed")).metadata()).format, "webp");
});

test("rebuilds incomplete tile caches before serving them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-gallery-"));
  const date = "2026-06-13";
  const gallery = path.join(root, "galleries", date);
  await mkdir(gallery, { recursive: true });
  await publish(gallery, "visible", true, "2026-06-13T12:00:00.000Z", 1025, 513);
  const sourcePixels = Buffer.alloc(1025 * 513 * 3);
  for (let y = 0; y < 513; y += 1) {
    for (let x = 0; x < 1025; x += 1) {
      const offset = (y * 1025 + x) * 3;
      sourcePixels[offset] = x % 256;
      sourcePixels[offset + 1] = y % 256;
      sourcePixels[offset + 2] = (x + y) % 256;
    }
  }
  await sharp(sourcePixels, { raw: { width: 1025, height: 513, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" })
    .toFile(path.join(gallery, "visible.jpg"));
  const store = new GalleryStore(root, 320, 80);
  await store.init();
  const view = await store.createTileView(date, "visible");
  const legacyTileSet = path.join(store.cacheRoot, "tiles", date, "visible", view.source_version);
  await mkdir(legacyTileSet, { recursive: true });
  await writeFile(path.join(legacyTileSet, ".complete"), "complete\n");
  const tileSet = path.join(store.cacheRoot, "tiles", date, "visible", "v2-overlap-1", view.source_version);
  const requestedTile = path.join(tileSet, "photo_files", "0", "0_0.webp");
  await mkdir(path.dirname(requestedTile), { recursive: true });
  await writeFile(requestedTile, "partial");

  const tile = await store.requireTile(view, 0, 0);

  assert.equal(tile, requestedTile);
  const reconstructed = Buffer.alloc(view.width * view.height * 3);
  const encodedSizes = [];
  for (let y = 0; y < view.rows; y += 1) {
    for (let x = 0; x < view.columns; x += 1) {
      const encoded = await sharp(await store.requireTile(view, x, y))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      encodedSizes.push({ width: encoded.info.width, height: encoded.info.height });
      const left = x > 0 ? view.overlap : 0;
      const top = y > 0 ? view.overlap : 0;
      const coreWidth = Math.min(view.tile_size, view.width - x * view.tile_size);
      const coreHeight = Math.min(view.tile_size, view.height - y * view.tile_size);
      for (let row = 0; row < coreHeight; row += 1) {
        const sourceStart = ((top + row) * encoded.info.width + left) * 3;
        const targetStart = ((y * view.tile_size + row) * view.width + x * view.tile_size) * 3;
        encoded.data.copy(reconstructed, targetStart, sourceStart, sourceStart + coreWidth * 3);
      }
    }
  }
  assert.deepEqual(encodedSizes, [
    { width: 513, height: 513 },
    { width: 514, height: 513 },
    { width: 2, height: 513 },
    { width: 513, height: 2 },
    { width: 514, height: 2 },
    { width: 2, height: 2 },
  ]);
  const source = await sharp(path.join(gallery, "visible.jpg")).removeAlpha().raw().toBuffer();
  const reconstructionError = reconstructed.reduce((sum, value, index) => sum + Math.abs(value - source[index]), 0);
  assert.ok(reconstructionError / reconstructed.length < 3);
  assert.match(await readFile(path.join(tileSet, "photo.dzi"), "utf8"), /Overlap="1"/);
  assert.equal(await readFile(path.join(tileSet, ".complete"), "utf8"), "complete\n");
  assert.equal(await readFile(path.join(legacyTileSet, ".complete"), "utf8"), "complete\n");
  assert.equal((await readdir(path.dirname(tileSet))).some((entry) => entry.startsWith(`${view.source_version}.tmp-`)), false);
});

test("rejects excess queued tile-set work with a retryable response", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-gallery-"));
  const date = "2026-06-13";
  const gallery = path.join(root, "galleries", date);
  await mkdir(gallery, { recursive: true });
  await publish(gallery, "visible", true);
  const store = new GalleryStore(root, 320, 80);
  await store.init();
  const view = await store.createTileView(date, "visible");
  store.tileGenerators = 2;
  store.tileWaiters = Array.from({ length: 32 }, () => () => {});

  await assert.rejects(
    store.requireTile(view, 0, 0),
    (error) => error.status === 503 && error.message === "Photo detail is busy. Try again shortly.",
  );
});

test("persists per-gallery covers with a safe fallback and ignores retired download fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-gallery-"));
  const date = "2026-06-13";
  const otherDate = "2026-06-14";
  const gallery = path.join(root, "galleries", date);
  const otherGallery = path.join(root, "galleries", otherDate);
  await Promise.all([mkdir(gallery, { recursive: true }), mkdir(otherGallery, { recursive: true })]);
  await publish(gallery, "oldest", true, "2026-06-13T12:00:00.000Z");
  await publish(gallery, "newest", true, "2026-06-13T13:00:00.000Z");
  await publish(gallery, "partial", false, "2026-06-13T14:00:00.000Z");
  await publish(otherGallery, "other", true, "2026-06-14T12:00:00.000Z");
  const store = new GalleryStore(root, 320, 80);
  await store.init();

  let dates = await store.listDates();
  let selected = dates.find((item) => item.date_folder === date);
  assert.equal(selected.cover_base, "oldest");
  assert.equal(selected.cover_fallback_active, false);
  assert.equal(selected.cover_is_custom, false);

  await store.updateGallerySettings(date, { cover_base: "newest", show_download_button: true });
  dates = await new GalleryStore(root, 320, 80).listDates();
  selected = dates.find((item) => item.date_folder === date);
  assert.equal(selected.cover_base, "newest");
  assert.equal(selected.cover_fallback_active, false);
  assert.equal(selected.cover_is_custom, true);
  assert.equal(selected.cover_thumbnail_url, `/gallery/thumb/${date}/newest.webp`);
  assert.equal(Object.hasOwn(selected, "show_download_button"), false);

  await writeFile(path.join(gallery, "newest.trashed.json"), JSON.stringify({ trashed_at: new Date().toISOString() }));
  selected = (await store.listDates()).find((item) => item.date_folder === date);
  assert.equal(selected.cover_base, "oldest");
  assert.equal(selected.cover_fallback_active, true);
  assert.equal(selected.cover_is_custom, true);
  await rm(path.join(gallery, "newest.trashed.json"));
  selected = (await store.listDates()).find((item) => item.date_folder === date);
  assert.equal(selected.cover_base, "newest");
  assert.equal(selected.cover_fallback_active, false);
  await Promise.all([
    rm(path.join(gallery, "newest.ready")),
    rm(path.join(gallery, "newest.jpg")),
  ]);
  selected = (await store.listDates()).find((item) => item.date_folder === date);
  assert.equal(selected.cover_base, "oldest");
  assert.equal(selected.cover_fallback_active, false);
  assert.equal(selected.cover_is_custom, false);

  await store.pruneGallerySettings();
  await publish(gallery, "newest", true, "2026-06-13T13:00:00.000Z");
  selected = (await store.listDates()).find((item) => item.date_folder === date);
  assert.equal(selected.cover_base, "oldest");
  assert.equal(selected.cover_is_custom, false);
  await store.updateGallerySettings(date, { cover_base: "newest" });
  await store.updateGallerySettings(date, { cover_base: null });
  selected = (await store.listDates()).find((item) => item.date_folder === date);
  assert.equal(selected.cover_base, "oldest");
  assert.equal(selected.cover_is_custom, false);
  await assert.rejects(store.updateGallerySettings(date, { cover_base: "partial" }), /ENOENT/);
  await assert.rejects(store.updateGallerySettings(date, { show_download_button: false }), (error) => error.status === 400);
  await assert.rejects(store.updateGallerySettings(date, {}), (error) => error.status === 400);
  await assert.rejects(
    store.updateGallerySettings("2026-06-15", { cover_base: null }),
    (error) => error.status === 404,
  );
  await Promise.all([
    rm(path.join(gallery, "oldest.ready")),
    rm(path.join(gallery, "oldest.jpg")),
    rm(path.join(gallery, "newest.ready")),
    rm(path.join(gallery, "newest.jpg")),
  ]);
  await store.pruneGallerySettings();
  await publish(gallery, "reborn", true, "2026-06-13T15:00:00.000Z");
  selected = (await store.listDates()).find((item) => item.date_folder === date);
  assert.equal(selected.cover_base, "reborn");
  assert.equal(selected.cover_is_custom, false);
});

test("persists branding settings and constrains uploaded logos", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-gallery-"));
  const store = new GalleryStore(root, 320, 80);
  await store.init();

  const defaults = await store.getBranding();
  assert.equal(defaults.presets.length, 5);
  assert.deepEqual(defaults.custom_profiles, []);
  assert.deepEqual(defaults.socials, []);
  assert.deepEqual(defaults.supports, []);
  assert.equal(defaults.show_download_button, false);
  assert.equal(defaults.mode, "system");
  assert.equal(defaults.logo, null);
  const fullPalette = {
    day: { ...defaults.active_profile.palettes.day, accent: "#123456", background: "#f7f7f7" },
    night: { ...defaults.active_profile.palettes.night, accent: "#abcdef", background: "#08090a" },
  };

  const updated = await store.updateBranding({
    brand_name: "North Studio",
    gallery_title: "Launch Photos",
    show_download_button: true,
    mode: "night",
    profile_id: "custom-midnight-field",
    custom_profiles: [
      { id: "custom-launch-orange", name: "Launch Orange", theme_color: "#ff6600" },
      { id: "custom-midnight-field", name: "Midnight Field", theme_color: "#123456", palettes: fullPalette },
    ],
    socials: [
      { id: "instagram-main", platform: "instagram", label: " North Studio ", url: "HTTPS://Instagram.COM/northstudio" },
      { id: "portfolio", platform: "website", url: "https://photos.example.com" },
    ],
    supports: [
      { id: "paypal-main", platform: "paypal", label: " Support North Studio ", url: "HTTPS://PAYPAL.ME/northstudio" },
    ],
  });
  assert.equal(updated.brand_name, "North Studio");
  assert.equal(updated.show_download_button, true);
  assert.equal(updated.presets.length, 7);
  assert.equal(updated.custom_profiles.length, 2);
  assert.equal(updated.active_profile.id, "custom-midnight-field");
  assert.equal(updated.active_profile.theme_color, "#123456");
  assert.equal(updated.active_profile.palettes.day.accent, "#123456");
  assert.equal(updated.active_profile.palettes.night.accent, "#abcdef");
  assert.notEqual(updated.active_profile.palettes.day.background, updated.active_profile.palettes.night.background);
  assert.deepEqual(updated.socials, [
    { id: "instagram-main", platform: "instagram", label: "North Studio", url: "https://instagram.com/northstudio" },
    { id: "portfolio", platform: "website", url: "https://photos.example.com/" },
  ]);
  assert.deepEqual(updated.supports, [
    { id: "paypal-main", platform: "paypal", label: "Support North Studio", url: "https://paypal.me/northstudio" },
  ]);
  assert.deepEqual((await new GalleryStore(root, 320, 80).getBranding()).socials, updated.socials);
  await assert.rejects(
    store.updateBranding({ socials: [{ id: "bad", platform: "website", url: "javascript:alert(1)" }] }),
    (error) => error.status === 400 && /http or https/.test(error.message),
  );
  await assert.rejects(
    store.updateBranding({ show_download_button: "yes" }),
    (error) => error.status === 400 && /true or false/.test(error.message),
  );

  const socialSource = await pngBuffer(640, 360, "#123456");
  const withGraphic = await store.saveSocialGraphic("instagram-main", {
    data_url: `data:image/png;base64,${socialSource.toString("base64")}`,
  });
  assert.equal(withGraphic.socials[0].graphic.width, 320);
  assert.equal(withGraphic.socials[0].graphic.height, 320);
  const socialGraphicFile = await store.requireSocialGraphic("instagram-main");
  assert.deepEqual(
    await sharp(await readFile(socialGraphicFile)).metadata().then(({ format, width, height }) => ({ format, width, height })),
    { format: "webp", width: 320, height: 320 },
  );
  const reordered = await store.updateBranding({
    socials: [
      { id: "portfolio", platform: "website", url: "https://photos.example.com", graphic: { url: "https://example.com/spoof.webp", width: 320, height: 320, updated_at: "now" } },
      { id: "instagram-main", platform: "instagram", label: "North Studio", url: "https://instagram.com/northstudio" },
    ],
  });
  assert.equal(reordered.socials[0].graphic, undefined);
  assert.equal(reordered.socials[1].graphic.url, withGraphic.socials[0].graphic.url);
  await store.updateBranding({ socials: [reordered.socials[0]] });
  await assert.rejects(store.requireSocialGraphic("instagram-main"), (error) => error.status === 404);
  await assert.rejects(readFile(socialGraphicFile), (error) => error.code === "ENOENT");

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

test("gallery HTTP API switches between protected tiles and the globally enabled inline image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-gallery-"));
  const date = "2026-06-13";
  const gallery = path.join(root, "galleries", date);
  await mkdir(gallery, { recursive: true });
  await publish(gallery, "visible", true, "2026-06-13T12:00:00.000Z", 1025, 513);
  await publish(gallery, "partial", false);
  await publish(gallery, "hidden", true);
  await writeFile(path.join(gallery, "hidden.trashed.json"), JSON.stringify({ trashed_at: new Date().toISOString() }));
  const storedExplore = exploreDocument("visible");
  storedExplore.placements.hidden = { lat: 40.5, lon: -86.5, updated_at: "2026-06-13T18:00:00.000Z" };
  await writeFile(path.join(gallery, "_explore.json"), JSON.stringify(storedExplore));
  const store = new GalleryStore(root, 320, 80);
  const app = await createApp(store, path.resolve("public"));
  const server = app.listen(0);
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessionHeaders = {
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
    "sec-fetch-dest": "empty",
    "cf-visitor": JSON.stringify({ scheme: "https" }),
  };
  const sessionBody = JSON.stringify({ date_folder: date, base: "visible" });
  const imageUrl = `${origin}/gallery/image/${date}/visible.jpg`;
  const imageHeaders = { "sec-fetch-site": "same-origin", "sec-fetch-dest": "image" };
  try {
    const photos = await fetch(`${origin}/gallery/api/photos?date=${date}`).then((response) => response.json());
    assert.deepEqual(photos.photos.map((photo) => photo.base), ["visible"]);
    assert.equal(photos.photos[0].capture_clock, "2026-06-13T17:00:00.000Z");
    assert.equal(photos.photos[0].thumbnail_url, `/gallery/thumb/${date}/visible.webp`);
    assert.equal(Object.hasOwn(photos.photos[0], "image_url"), false);
    const disabledImage = await fetch(imageUrl, { headers: imageHeaders });
    assert.equal(disabledImage.status, 404);
    assert.equal(disabledImage.headers.get("cache-control"), "private, no-cache");
    assert.equal(disabledImage.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(disabledImage.headers.get("x-content-type-options"), "nosniff");

    const rejectedSession = await fetch(`${origin}/gallery/api/view-session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sessionBody,
    });
    assert.equal(rejectedSession.status, 404);
    assert.equal(rejectedSession.headers.get("cache-control"), "private, no-store");
    assert.equal((await fetch(`${origin}/gallery/api/view-session`, {
      method: "POST",
      headers: { ...sessionHeaders, "sec-fetch-site": "cross-site" },
      body: sessionBody,
    })).status, 404);
    assert.equal((await fetch(`${origin}/gallery/api/view-session`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ date_folder: date, base: "partial" }),
    })).status, 404);
    assert.equal((await fetch(`${origin}/gallery/api/view-session`, {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ date_folder: date, base: "hidden" }),
    })).status, 404);

    const manifestResponse = await fetch(`${origin}/gallery/api/view-session`, {
      method: "POST",
      headers: sessionHeaders,
      body: sessionBody,
    });
    assert.equal(manifestResponse.status, 200);
    assert.equal(manifestResponse.headers.get("cache-control"), "private, no-store");
    const setCookie = manifestResponse.headers.get("set-cookie");
    assert.match(setCookie, /^frame_gallery_view=[A-Za-z0-9_-]+;/);
    assert.match(setCookie, /Max-Age=300/);
    assert.match(setCookie, /Path=\/gallery/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Secure/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(";", 1)[0];
    const { view } = await manifestResponse.json();
    assert.deepEqual(
      { width: view.width, height: view.height, tile_size: view.tile_size, overlap: view.overlap, columns: view.columns, rows: view.rows },
      { width: 1025, height: 513, tile_size: 512, overlap: 1, columns: 3, rows: 2 },
    );
    assert.equal(view.tiles.length, 6);
    assert.deepEqual(
      view.tiles.map(({ x, y, width, height }) => ({ x, y, width, height })),
      [
        { x: 0, y: 0, width: 512, height: 512 },
        { x: 1, y: 0, width: 512, height: 512 },
        { x: 2, y: 0, width: 1, height: 512 },
        { x: 0, y: 1, width: 512, height: 1 },
        { x: 1, y: 1, width: 512, height: 1 },
        { x: 2, y: 1, width: 1, height: 1 },
      ],
    );
    assert.doesNotMatch(view.tiles[0].url, /visible|2026-06-13/);

    const isolatedManifestResponse = await fetch(`${origin}/gallery/api/view-session`, {
      method: "POST",
      headers: sessionHeaders,
      body: sessionBody,
    });
    assert.equal(isolatedManifestResponse.status, 200);
    const isolatedCookie = isolatedManifestResponse.headers.get("set-cookie").split(";", 1)[0];
    const isolatedView = (await isolatedManifestResponse.json()).view;
    assert.notEqual(isolatedView.handle, view.handle);

    const tileHeaders = { cookie, "sec-fetch-site": "same-origin", "sec-fetch-dest": "image" };
    assert.equal((await fetch(`${origin}${view.tiles[0].url}`, {
      headers: { ...tileHeaders, cookie: isolatedCookie },
    })).status, 404);
    const rejectedTile = await fetch(`${origin}${view.tiles[0].url}`, { headers: { cookie } });
    assert.equal(rejectedTile.status, 404);
    assert.equal(rejectedTile.headers.get("cache-control"), "private, no-store");
    assert.equal(rejectedTile.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(rejectedTile.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await fetch(`${origin}${view.tiles[0].url}`, {
      headers: { ...tileHeaders, "sec-fetch-site": "cross-site" },
    })).status, 404);
    assert.equal((await fetch(`${origin}/gallery/tile/${view.handle}/3/0.webp`, { headers: tileHeaders })).status, 404);
    const tileResponse = await fetch(`${origin}${view.tiles[0].url}`, { headers: tileHeaders });
    assert.equal(tileResponse.status, 200);
    assert.equal(tileResponse.headers.get("content-type"), "image/webp");
    assert.equal(tileResponse.headers.get("cache-control"), "private, no-store");
    assert.equal(tileResponse.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(tileResponse.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(
      await sharp(Buffer.from(await tileResponse.arrayBuffer())).metadata()
        .then(({ format, width, height, exif }) => ({ format, width, height, exif })),
      { format: "webp", width: 513, height: 513, exif: undefined },
    );

    const rejectedDownload = await fetch(`${origin}/gallery/download/${date}/visible.jpg`);
    assert.equal(rejectedDownload.status, 404);
    assert.equal(rejectedDownload.headers.get("cache-control"), "private, no-store");
    assert.equal(rejectedDownload.headers.get("x-content-type-options"), "nosniff");
    await store.updateBranding({ show_download_button: true });

    assert.equal((await fetch(imageUrl)).status, 404);
    assert.equal((await fetch(imageUrl, {
      headers: { ...imageHeaders, "sec-fetch-site": "cross-site" },
    })).status, 404);
    assert.equal((await fetch(imageUrl, {
      headers: { ...imageHeaders, "sec-fetch-dest": "document" },
    })).status, 404);

    const imageResponse = await fetch(imageUrl, { headers: imageHeaders });
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get("content-type"), /^image\/jpeg/);
    assert.match(imageResponse.headers.get("content-disposition"), /^inline;/);
    assert.equal(imageResponse.headers.get("cache-control"), "private, no-cache");
    assert.equal(imageResponse.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(imageResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(imageResponse.headers.get("accept-ranges"), "bytes");
    const imageEtag = imageResponse.headers.get("etag");
    assert.ok(imageEtag);
    const sourceImage = await readFile(path.join(gallery, "visible.jpg"));
    const inlineImage = Buffer.from(await imageResponse.arrayBuffer());
    assert.deepEqual(inlineImage, sourceImage);
    assert.deepEqual(
      await sharp(inlineImage).metadata().then(({ format, width, height }) => ({ format, width, height })),
      { format: "jpeg", width: 1025, height: 513 },
    );

    const rangedImage = await fetch(imageUrl, {
      headers: { ...imageHeaders, range: "bytes=0-31" },
    });
    assert.equal(rangedImage.status, 206);
    assert.equal(rangedImage.headers.get("content-range"), `bytes 0-31/${sourceImage.length}`);
    assert.equal(rangedImage.headers.get("content-length"), "32");
    assert.deepEqual(Buffer.from(await rangedImage.arrayBuffer()), sourceImage.subarray(0, 32));

    const download = await fetch(`${origin}/gallery/download/${date}/visible.jpg`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-type"), /^image\/jpeg/);
    assert.match(download.headers.get("content-disposition"), /^attachment;/);
    assert.equal(download.headers.get("cache-control"), "private, no-store");

    await store.updateBranding({ show_download_button: false });
    assert.equal((await fetch(imageUrl, {
      headers: { ...imageHeaders, "if-none-match": imageEtag },
    })).status, 404);
    await store.updateBranding({ show_download_button: true });

    const exploreResponse = await fetch(`${origin}/gallery/api/explore?date=${date}`);
    assert.match(exploreResponse.headers.get("cache-control"), /private, no-cache/);
    assert.ok(exploreResponse.headers.get("etag"));
    const publicExplore = (await exploreResponse.json()).explore;
    assert.equal(publicExplore.routes.length, 1);
    assert.ok(publicExplore.placements.visible);
    assert.equal(publicExplore.placements.hidden, undefined);
    const thumbnailResponse = await fetch(`${origin}/gallery/thumb/${date}/visible.webp`);
    assert.equal(thumbnailResponse.headers.get("content-type"), "image/webp");
    assert.equal(thumbnailResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");

    await writeFile(path.join(gallery, "visible.trashed.json"), JSON.stringify({ trashed_at: new Date().toISOString() }));
    assert.equal((await fetch(`${origin}${view.tiles[0].url}`, { headers: tileHeaders })).status, 404);
    assert.equal((await fetch(imageUrl, { headers: imageHeaders })).status, 404);
    assert.equal((await fetch(`${origin}/gallery/download/${date}/visible.jpg`)).status, 404);
    assert.equal((await fetch(`${origin}/today/gallery/${date}/`)).status, 200);
  } finally {
    await closeServer(server);
  }
});

test("gallery admin is protected and proxies management through the internal service token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-gallery-"));
  const date = "2026-06-13";
  const gallery = path.join(root, "galleries", date);
  await mkdir(gallery, { recursive: true });
  await publish(gallery, "hidden", true);
  await writeFile(path.join(gallery, "hidden.trashed.json"), JSON.stringify({ trashed_at: new Date().toISOString() }));
  await writeFile(path.join(gallery, "_explore.json"), JSON.stringify(exploreDocument("hidden")));
  const pipeline = createServer(async (request, response) => {
    assert.equal(request.headers["x-frame-service-token"], "service-secret");
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/internal/photo-pipeline/trash") {
      response.end(JSON.stringify({ trash: [] }));
      return;
    }
    if (request.url === "/api/internal/photo-pipeline/explore?date=2026-06-13") {
      if (request.method === "PUT") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        response.end(JSON.stringify({ date_folder: "2026-06-13", explore: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
        return;
      }
      assert.equal(request.method, "DELETE");
      response.end(JSON.stringify({ date_folder: "2026-06-13", explore: null }));
      return;
    }
    response.end(JSON.stringify({ ok: true, action: "empty-trash", affected: 0 }));
  });
  let server = null;
  try {
    pipeline.listen(0);
    await once(pipeline, "listening");
    const pipelinePort = pipeline.address().port;
    const app = await createApp(new GalleryStore(root, 320, 80), path.resolve("public"), {
      pipelineUrl: `http://127.0.0.1:${pipelinePort}`,
      serviceToken: "service-secret",
      auth: { username: "frame", password: "secret", realm: "FRAME Test" },
    });
    server = app.listen(0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const authorization = `Basic ${Buffer.from("frame:secret").toString("base64")}`;
    assert.equal((await fetch(`${base}/today/gallery/admin`)).status, 401);
    assert.equal((await fetch(`${base}/today/gallery/admin`, { headers: { authorization } })).status, 200);
    assert.deepEqual(await fetch(`${base}/gallery/admin/api/trash`, { headers: { authorization } }).then((response) => response.json()), { trash: [] });
    assert.equal((await fetch(`${base}/gallery/admin/api/branding`, { method: "PUT" })).status, 401);
    const defaultBranding = (await fetch(`${base}/gallery/api/branding`).then((response) => response.json())).branding;
    assert.equal(defaultBranding.presets.length, 5);
    assert.equal(defaultBranding.show_download_button, false);
    const branding = await fetch(`${base}/gallery/admin/api/branding`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        brand_name: "North Studio",
        gallery_title: "Launch Photos",
        show_download_button: true,
        mode: "day",
        profile_id: "custom-launch-orange",
        custom_profiles: [{ id: "custom-launch-orange", name: "Launch Orange", theme_color: "#ff6600" }],
        socials: [{ id: "flickr-main", platform: "flickr", label: "Event photos", url: "https://www.flickr.com/photos/frame" }],
        supports: [{ id: "kofi-main", platform: "kofi", label: "Support FRAME", url: "https://ko-fi.com/frame" }],
      }),
    }).then((response) => response.json());
    assert.equal(branding.branding.brand_name, "North Studio");
    assert.equal(branding.branding.show_download_button, true);
    assert.equal(branding.branding.active_profile.id, "custom-launch-orange");
    assert.equal(branding.branding.presets.length, 6);
    const publicBranding = (await fetch(`${base}/gallery/api/branding`).then((response) => response.json())).branding;
    assert.equal(publicBranding.gallery_title, "Launch Photos");
    assert.equal(publicBranding.show_download_button, true);
    assert.equal(publicBranding.socials[0].platform, "flickr");
    assert.equal(publicBranding.supports[0].platform, "kofi");
    const graphicDataUrl = `data:image/png;base64,${(await pngBuffer(500, 240, "#ff6600")).toString("base64")}`;
    assert.equal((await fetch(`${base}/gallery/admin/api/branding/socials/flickr-main/graphic`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data_url: graphicDataUrl }),
    })).status, 401);
    const graphicBranding = await fetch(`${base}/gallery/admin/api/branding/socials/flickr-main/graphic`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ data_url: graphicDataUrl }),
    }).then((response) => response.json());
    assert.equal(graphicBranding.branding.socials[0].graphic.width, 320);
    const publicGraphic = await fetch(`${base}/gallery/branding/socials/flickr-main/graphic.webp`);
    assert.equal(publicGraphic.status, 200);
    assert.match(publicGraphic.headers.get("content-type"), /^image\/webp/);
    const preserved = await fetch(`${base}/gallery/admin/api/branding`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        socials: [{
          id: "flickr-main",
          platform: "flickr",
          url: "https://www.flickr.com/photos/frame",
          graphic: { url: "https://example.com/spoof.webp", width: 320, height: 320, updated_at: "now" },
        }],
      }),
    }).then((response) => response.json());
    assert.equal(preserved.branding.socials[0].graphic.url, graphicBranding.branding.socials[0].graphic.url);
    const deletedGraphic = await fetch(`${base}/gallery/admin/api/branding/socials/flickr-main/graphic`, {
      method: "DELETE",
      headers: { authorization },
    }).then((response) => response.json());
    assert.equal(deletedGraphic.branding.socials[0].graphic, undefined);
    assert.equal((await fetch(`${base}/gallery/branding/socials/flickr-main/graphic.webp`)).status, 404);
    assert.equal((await fetch(`${base}/gallery/admin/api/branding`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ socials: [{ id: "unsafe", platform: "website", url: "file:///etc/passwd" }] }),
    })).status, 400);
    assert.equal((await fetch(`${base}/gallery/api/explore?date=${date}`).then((response) => response.json())).explore, null);
    assert.equal((await fetch(`${base}/gallery/admin/api/explore?date=${date}`)).status, 401);
    const storedExplore = await fetch(`${base}/gallery/admin/api/explore?date=${date}`, { headers: { authorization } })
      .then((response) => response.json());
    assert.equal(storedExplore.explore.routes[0].id, "walk");
    const explore = exploreDocument("visible");
    assert.equal((await fetch(`${base}/gallery/admin/api/explore?date=2026-06-13`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify(explore),
    }).then((response) => response.json())).explore.routes[0].id, "walk");
    assert.equal((await fetch(`${base}/gallery/admin/api/explore?date=2026-06-13`, {
      method: "DELETE",
      headers: { authorization },
    }).then((response) => response.json())).explore, null);
    await publish(gallery, "hero", true, "2026-06-13T19:00:00.000Z");
    const settingsUrl = `${base}/gallery/admin/api/galleries/${date}/settings`;
    assert.equal((await fetch(settingsUrl, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cover_base: "hero" }),
    })).status, 401);
    const settings = await fetch(settingsUrl, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ cover_base: "hero", show_download_button: false }),
    }).then((response) => response.json());
    assert.equal(settings.settings.cover_base, "hero");
    assert.equal(Object.hasOwn(settings.settings, "show_download_button"), false);
    const dateSettings = (await fetch(`${base}/gallery/api/dates`).then((response) => response.json())).dates
      .find((item) => item.date_folder === date);
    assert.equal(dateSettings.cover_base, "hero");
    assert.equal(dateSettings.cover_fallback_active, false);
    assert.equal(dateSettings.cover_is_custom, true);
    assert.equal(Object.hasOwn(dateSettings, "show_download_button"), false);
    assert.equal((await fetch(`${base}/gallery/admin/image/${date}/hero.jpg`)).status, 401);
    const adminImage = await fetch(`${base}/gallery/admin/image/${date}/hero.jpg`, { headers: { authorization } });
    assert.equal(adminImage.status, 200);
    assert.equal(adminImage.headers.get("cache-control"), "private, no-store");
    assert.equal((await fetch(`${base}/gallery/download/${date}/hero.jpg`)).status, 200);
    const downloadsDisabled = await fetch(`${base}/gallery/admin/api/branding`, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ show_download_button: false }),
    }).then((response) => response.json());
    assert.equal(downloadsDisabled.branding.show_download_button, false);
    assert.equal((await fetch(`${base}/gallery/download/${date}/hero.jpg`)).status, 404);
    assert.equal((await fetch(settingsUrl, {
      method: "PUT",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ cover_base: "missing" }),
    })).status, 404);
    const result = await fetch(`${base}/gallery/admin/api/manage`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "empty-trash" }),
    }).then((response) => response.json());
    assert.equal(result.action, "empty-trash");
  } finally {
    await Promise.all([
      closeServer(server),
      closeServer(pipeline),
    ]);
  }
});

test("wires cover selection, global downloads, flowing photos, and viewer modes into the owner and visitor interfaces", async () => {
  const [adminHtml, adminScript, adminStyles, galleryHtml, galleryScript, galleryStyles, justifiedScript] = await Promise.all([
    readFile(path.resolve("public/admin.html"), "utf8"),
    readFile(path.resolve("public/admin.js"), "utf8"),
    readFile(path.resolve("public/admin.css"), "utf8"),
    readFile(path.resolve("public/index.html"), "utf8"),
    readFile(path.resolve("public/gallery.js"), "utf8"),
    readFile(path.resolve("public/styles.css"), "utf8"),
    readFile(path.resolve("public/justified-rows.js"), "utf8"),
  ]);
  assert.match(adminHtml, /id="cover-action"/);
  assert.match(adminHtml, /id="cover-picker"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(adminHtml, /id="cancel-cover-picker"/);
  assert.doesNotMatch(adminHtml, /id="confirm-filename"/);
  assert.match(adminHtml, /id="downloads-disabled"[^>]+aria-pressed="true"/);
  assert.match(adminHtml, /id="downloads-enabled"[^>]+aria-pressed="false"/);
  assert.match(adminHtml, /id="settings-action-bar"[^>]+hidden/);
  assert.equal((adminHtml.match(/d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6"/g) || []).length, 4);
  assert.doesNotMatch(adminHtml, /<span class="trash-icon"/);
  assert.match(adminHtml, /class="photo-details">\s*<span><strong><\/strong><small><\/small><\/span>\s*<button class="trash-photo-button icon-danger-button"/);
  assert.doesNotMatch(adminHtml, /class="photo-actions"/);
  assert.match(adminHtml, /class="cover-star"[^>]+role="img"[^>]+aria-label="Current gallery cover"[^>]*>\s*<svg[^>]+viewBox="0 0 24 24"/);
  assert.match(adminHtml, /admin\.css\?v=gallery-owner-settings-10/);
  assert.match(adminHtml, /admin\.js\?v=gallery-owner-settings-11/);
  assert.match(adminHtml, /id="support-tab"[^>]+aria-controls="support-view"/);
  assert.match(adminHtml, /FRAME will usually identify it automatically/);
  assert.match(adminScript, /cover_base: photo\.base/);
  assert.match(adminScript, /card\.querySelector\("img"\)\.alt = ""/);
  assert.match(adminScript, /trash: `<svg class="trash-icon"[^>]+><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6"\/><\/svg>`/);
  assert.match(adminScript, /class="icon-danger-button social-remove"[^>]+aria-label="Remove social link"[^>]*>\$\{icons\.trash\}<\/button>/);
  assert.match(adminScript, /querySelectorAll\("\.cover-picker-photo"\)/);
  assert.match(adminScript, /import \{ layoutJustifiedRows \} from "\.\/justified-rows\.js\?v=gallery-justified-1"/);
  assert.match(adminScript, /layoutJustifiedRows\(elements\.cover_picker_grid, items/);
  assert.match(justifiedScript, /export function planJustifiedRows/);
  assert.match(justifiedScript, /container\.replaceChildren\(\.\.\.rowElements\)/);
  assert.match(justifiedScript, /activeElement\?\.isConnected/);
  assert.match(justifiedScript, /focus\(\{ preventScroll: true \}\)/);
  assert.match(adminScript, /classList\.toggle\("has-media", Boolean\(imageUrl\)\)/);
  assert.match(adminStyles, /\.confirm-dialog\.has-media\s*\{[^}]*width:\s*fit-content[^}]*overflow:\s*hidden/);
  assert.match(adminStyles, /\.confirm-media img\s*\{[^}]*object-fit:\s*contain/);
  assert.match(adminStyles, /\.dialog-actions > button\s*\{[^}]*flex:\s*1/);
  assert.match(adminStyles, /\.cover-picker-row\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.doesNotMatch(adminStyles, /\.cover-picker-grid\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(adminStyles, /\.photo-details\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 42px[^}]*align-items:\s*center/);
  assert.match(adminStyles, /\.branding-layout\s*\{[^}]*grid-template-columns:\s*minmax\(280px, 360px\) minmax\(0, 1fr\)/);
  assert.match(adminStyles, /\.logo-preview-button img\s*\{[^}]*width:\s*min\(100%, 320px\)[^}]*height:\s*200px/);
  assert.match(adminStyles, /@media \(max-width:\s*900px\)\s*\{[\s\S]*?\.logo-editor\s*\{[^}]*width:\s*min\(100%, 420px\)[^}]*justify-self:\s*center/);
  assert.match(adminStyles, /\.trash-icon\s*\{[^}]*width:\s*18px[^}]*height:\s*18px[^}]*fill:\s*none[^}]*stroke:\s*currentColor/);
  assert.doesNotMatch(adminStyles, /\.trash-icon::(?:before|after)/);
  assert.match(adminStyles, /\.cover-star svg\s*\{[^}]*width:\s*18px[^}]*height:\s*18px[^}]*display:\s*block/);
  assert.match(adminScript, /show_download_button: shown/);
  assert.match(galleryHtml, /id="lightbox-download"[^>]+hidden/);
  assert.match(galleryHtml, /id="lightbox-full"[^>]+aria-hidden="true"/);
  assert.match(galleryHtml, /id="lightbox-tiles"[^>]+aria-hidden="true"/);
  assert.match(galleryScript, /removeAttribute\("href"\)/);
  assert.match(galleryScript, /state\.branding\?\.show_download_button === true/);
  assert.match(galleryScript, /const identity = document\.createElement\("a"\)/);
  assert.match(galleryScript, /identity\.target = "_blank"/);
  assert.match(galleryScript, /identity\.rel = "noopener noreferrer"/);
  assert.match(galleryScript, /identity\.setAttribute\("aria-label", `Open \$\{title\.textContent\} in a new window`\)/);
  assert.match(galleryScript, /actions\.append\(copyButton, qrButton\)/);
  assert.doesNotMatch(galleryScript, /actions\.append\(open,|icons\.open/);
  assert.match(galleryScript, /layoutJustifiedRows\(elements\.photoGallery, items/);
  assert.match(galleryScript, /function schedulePhotoGalleryLayout\(\)/);
  assert.match(galleryScript, /photoGalleryLayoutKey === layoutKey/);
  assert.match(galleryScript, /card\.dataset\.ratio = String/);
  assert.match(galleryScript, /openButton\.setAttribute\("aria-label", `Open \$\{photoName\}`\)/);
  assert.match(galleryScript, /openButton\.setAttribute\("aria-describedby", time\.id\)/);
  assert.match(galleryHtml, /id="photo-gallery"[^>]+aria-label="Gallery photos"/);
  assert.doesNotMatch(galleryHtml, /id="photo-gallery"[^>]+aria-live/);
  assert.match(galleryHtml, /class="photo-overlay"/);
  assert.match(galleryHtml, /class="photo-meta"><strong><\/strong><time><\/time>/);
  assert.match(galleryHtml, /class="card-action photo-map-jump"/);
  assert.match(galleryHtml, /class="card-action photo-share"/);
  assert.doesNotMatch(galleryHtml, /photo-download/);
  assert.match(galleryStyles, /\.gallery-photo-row\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(galleryStyles, /\.photo-open img\s*\{[^}]*object-fit:\s*contain/);
  assert.match(galleryStyles, /\.photo-card:focus-within \.photo-overlay\s*\{[^}]*opacity:\s*1/);
  assert.match(galleryStyles, /\.photo-card:focus-within::after\s*\{[^}]*opacity:\s*1/);
  assert.match(galleryStyles, /@media \(hover: none\), \(pointer: coarse\)[\s\S]*?\.photo-card:focus-within \.photo-overlay \.card-action\s*\{[^}]*pointer-events:\s*none/);
  assert.match(galleryStyles, /\.is-photo-grid main\s*\{[^}]*width:\s*100%/);
  assert.match(galleryScript, /\/gallery\/download\/\$\{encodeURIComponent\(route\.date\)\}/);
  assert.match(galleryScript, /\/gallery\/image\/\$\{encodeURIComponent\(route\.date\)\}/);
  assert.match(galleryScript, /return state\.branding\?\.show_download_button === true \? "image" : "tiles"/);
  assert.match(galleryScript, /state\.lightboxMediaMode === "image"[\s\S]*?loadLightboxFullImage\(photo,[\s\S]*?loadLightboxTiles\(photo/);
  assert.match(galleryScript, /state\.lightboxMediaMode = "tiles"[\s\S]*?state\.lightboxFullRetryAt = Date\.now\(\) \+ state\.lightboxFullRetryDelay/);
  assert.match(galleryScript, /retryFullImage = preferredMediaMode === "image"[\s\S]*?Date\.now\(\) >= state\.lightboxFullRetryAt/);
  assert.match(galleryScript, /requestJson\("\/gallery\/api\/view-session"/);
  assert.match(galleryScript, /tileSize !== 512/);
  assert.match(galleryScript, /positiveInteger\(view\?\.overlap\)/);
  assert.match(galleryScript, /gridTemplateColumns = Array\.from\(/);
  assert.match(galleryScript, /`\$\{Math\.min\(view\.tileSize, view\.width - x \* view\.tileSize\)\}px`/);
  assert.match(galleryScript, /`\$\{Math\.min\(view\.tileSize, view\.height - y \* view\.tileSize\)\}px`/);
  assert.match(galleryScript, /clip\.className = "lightbox-tile-clip"/);
  assert.match(galleryScript, /image\.style\.left = `\$\{-sourceX\}px`/);
  assert.match(galleryScript, /syncLightboxTileScale\(view\)/);
  assert.match(galleryScript, /image\.naturalWidth !== expectedWidth/);
  assert.match(galleryScript, /image\.src = tile\.url/);
  assert.match(galleryStyles, /\.lightbox-tiles\s*\{[^}]*display:\s*grid[^}]*transform-origin:\s*0 0/);
  assert.match(galleryStyles, /\.lightbox-full\s*\{[^}]*position:\s*absolute[^}]*object-fit:\s*fill[^}]*opacity:\s*0/);
  assert.match(galleryStyles, /\.lightbox-full\.is-ready\s*\{[^}]*opacity:\s*1/);
  assert.match(galleryStyles, /\.lightbox-tile-clip\s*\{[^}]*overflow:\s*hidden/);
  assert.match(galleryStyles, /\.lightbox-tile-image\s*\{[^}]*position:\s*absolute/);
  assert.doesNotMatch(galleryScript, /createElement\("canvas"\)|drawImage\(/);
  assert.doesNotMatch(galleryStyles, /scale\(1\.002\)/);
  assert.doesNotMatch(galleryStyles, /\.lightbox-tile-image\s*\{[^}]*(?:opacity|transform):/);
  assert.match(galleryHtml, /Select a platform or link name to open it, or use the buttons to copy or scan it\./);
  assert.match(galleryStyles, /\.social-link-identity\s*\{[^}]*color:\s*inherit[^}]*text-decoration:\s*none/);
  assert.match(galleryStyles, /\.social-link-identity:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  assert.match(galleryHtml, /id="socials-button"[^>]*aria-label="Socials — Connect with me"[^>]*aria-haspopup="dialog"[^>]*aria-controls="socials-dialog"/);
  assert.match(galleryHtml, /id="support-button"[^>]*aria-label="Support — Support this creator"[^>]*aria-haspopup="dialog"[^>]*aria-controls="support-dialog"/);
  assert.match(galleryHtml, /class="socials-reel" aria-hidden="true"[^>]*>[\s\S]*Socials[\s\S]*Connect with me!/);
  assert.match(galleryStyles, /\.socials-button\s*\{[^}]*width:\s*82px[^}]*height:\s*38px[^}]*animation:\s*socials-bounce 8s/);
  assert.match(galleryStyles, /\.support-button\s*\{[^}]*width:\s*88px[^}]*background:\s*var\(--secondary\)[^}]*animation:\s*socials-bounce 8s ease-in-out 1\.4s/);
  assert.match(galleryStyles, /\.support-label-default\s*\{[^}]*animation:\s*socials-default-label 8s ease-in-out 1\.4s/);
  assert.match(galleryStyles, /\.socials-reel\s*\{[^}]*overflow:\s*hidden/);
  assert.match(galleryStyles, /\.socials-label-invite\s*\{[^}]*left:\s*100%[^}]*width:\s*max-content/);
  assert.match(galleryStyles, /@keyframes socials-default-label/);
  assert.match(galleryStyles, /@keyframes socials-invite-label/);
  assert.doesNotMatch(galleryStyles, /socials-glow/);
  assert.match(galleryStyles, /\.socials-button:hover, \.socials-button:focus-visible\s*\{\s*animation:\s*none/);
  assert.match(galleryStyles, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.socials-label-invite\s*\{\s*display:\s*none/);
  assert.match(galleryStyles, /html, body\s*\{[^}]*overflow-x:\s*clip/);
  assert.match(galleryStyles, /\.topbar\s*\{[^}]*position:\s*sticky[^}]*z-index:\s*1100[^}]*top:\s*0/);
  assert.match(galleryHtml, /styles\.css\?v=gallery-support-2/);
  assert.match(galleryHtml, /gallery\.js\?v=gallery-support-1/);
  assert.doesNotMatch(galleryScript, /photo\.image_url/);
  assert.match(galleryScript, /openPhotoBase/);
  assert.match(galleryScript, /options\.lightboxBase/);
});

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  });
}

async function publish(
  directory,
  base,
  ready,
  processedAt = "2026-06-13T12:00:00.000Z",
  width = 120,
  height = 80,
) {
  await sharp({ create: { width, height, channels: 3, background: "#2cb4fb" } })
    .jpeg()
    .toFile(path.join(directory, `${base}.jpg`));
  await writeFile(path.join(directory, `${base}.json`), JSON.stringify({
    width,
    height,
    orientation: 0,
    processed_at: processedAt,
    exif: { Photo: { DateTimeOriginal: "2026-06-13T17:00:00.000Z" } },
  }));
  await writeFile(path.join(directory, `${base}.txt`), "Camera: FRAME Test\n");
  if (ready) await writeFile(path.join(directory, `${base}.ready`), "ready\n");
}

async function pngBuffer(width, height, background) {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

function exploreDocument(base) {
  return {
    schema_version: 1,
    updated_at: "2026-06-13T18:00:00.000Z",
    time_shift_seconds: 18_000,
    time_adjustment_seconds: -15,
    routes: [{
      id: "walk",
      name: "Walk.gpx",
      imported_at: "2026-06-13T18:00:00.000Z",
      segments: [[[1_000, 41, -87], [2_000, 41.1, -87.1]]],
    }],
    placements: { [base]: { lat: 41.05, lon: -87.05, updated_at: "2026-06-13T18:00:00.000Z" } },
  };
}
