import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../dist/app.js";
import { TodayController } from "../dist/controller.js";
import { TodayStore } from "../dist/store.js";

test("controller follows latest publications and handles remote commands", async () => {
  const root = await fixture();
  const store = new TodayStore(root);
  const controller = new TodayController(store, 10_000, 60_000);
  await controller.init();
  try {
    assert.equal(controller.state().current_base, "second");
    assert.ok(controller.state().server_time);
    assert.equal(controller.state().current_photo.camera_text.includes("\0"), false);
    assert.equal(controller.command({ type: "PREV" }).current_base, "first");
    assert.equal(controller.command({ type: "SET_INTERVAL_MS", interval_ms: 5_000 }).interval_ms, 5_000);
    assert.equal(controller.command({ type: "SET_SHOW_EXIF", show_exif: false }).show_exif, false);
    assert.equal(controller.command({ type: "SET_SHOW_BACKGROUND", show_background: false }).show_background, false);
    const playing = controller.command({ type: "PLAY_SLIDESHOW" });
    assert.equal(playing.playback_state, "playing");
    assert.ok(playing.interval_started_at);
    assert.ok(playing.next_change_at);
    assert.throws(() => controller.command({ type: "AUTO_SCROLL_IMAGE" }));
    const paused = controller.command({ type: "PAUSE_SLIDESHOW" });
    assert.equal(paused.playback_state, "paused");
    assert.equal(paused.next_change_at, null);
    const scrolling = controller.command({ type: "AUTO_SCROLL_IMAGE" });
    assert.equal(scrolling.presentation_mode, "auto-scroll");
    assert.equal(scrolling.presentation_duration_ms, 7_000);
    assert.equal(controller.command({ type: "STOP_SLIDESHOW" }).current_base, "second");
    assert.equal(controller.state().playback_state, "stopped");
    await writeFile(path.join(root, "galleries", "2026-06-13", "second.trashed.json"), JSON.stringify({ trashed_at: new Date().toISOString() }));
    await writeFile(path.join(root, "state", "latest.json"), JSON.stringify({
      updated_at: "2026-06-13T12:00:00.000Z",
      date_folder: "2026-06-13",
      latest_base: "first",
      count_today: 1,
    }));
    const refreshed = await controller.refresh(false);
    assert.equal(refreshed.current_base, "first");
    assert.equal(refreshed.count_today, 1);
  } finally {
    controller.close();
  }
});

test("HTTP API serves published full images only to the same-origin Photo Stage viewer", async () => {
  const root = await fixture();
  const store = new TodayStore(root);
  const controller = new TodayController(store, 10_000, 60_000);
  await controller.init();
  const app = createApp(controller, store, path.resolve("public"), {
    username: "frame",
    password: "secret",
    realm: "FRAME Test",
  }, "https://frame.example");
  const server = app.listen(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const state = await (await fetch(`${base}/today/api/state`)).json();
    assert.equal(state.count_today, 2);
    assert.equal(Object.hasOwn(state.current_photo, "image_url"), false);
    assert.equal((await fetch(`${base}/today/image/2026-06-13/second.jpg`)).status, 404);
    const imageHeaders = { "sec-fetch-site": "same-origin", "sec-fetch-dest": "image" };
    const image = await fetch(`${base}/today/image/2026-06-13/second.jpg`, { headers: imageHeaders });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/jpeg");
    assert.equal(image.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(await image.text(), "second");
    assert.equal((await fetch(`${base}/today/image/2026-06-13/hidden.jpg`, { headers: imageHeaders })).status, 404);
    assert.equal((await fetch(`${base}/today/assets/remote.js`)).headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}/today/dashboard`)).status, 401);
    assert.equal((await fetch(`${base}/today/api/dashboard`)).status, 401);
    assert.equal((await fetch(`${base}/today/remote`)).status, 401);
    assert.equal((await fetch(`${base}/today/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "GOTO_INDEX", index: 0 }),
    })).status, 401);
    const changed = await (await fetch(`${base}/today/api/command`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from("frame:secret").toString("base64")}`,
      },
      body: JSON.stringify({ type: "GOTO_INDEX", index: 0 }),
    })).json();
    assert.equal(changed.current_base, "first");
    const dashboard = await (await fetch(`${base}/today/api/dashboard`, {
      headers: { authorization: `Basic ${Buffer.from("frame:secret").toString("base64")}` },
    })).json();
    assert.equal(dashboard.total_albums, 1);
    assert.equal(dashboard.total_images, 2);
    assert.equal(dashboard.current_gallery.count, 2);
    assert.equal(dashboard.latest_photo.base, "second");
    assert.equal(Object.hasOwn(dashboard.latest_photo, "image_url"), false);
    assert.equal(dashboard.public_base_url, "https://frame.example");
    await writeFile(path.join(root, "galleries", "2026-06-13", "first.trashed.json"), "{}");
    assert.equal((await fetch(`${base}/today/image/2026-06-13/first.jpg`, { headers: imageHeaders })).status, 404);
  } finally {
    controller.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Photo Stage Viewer displays one full JPEG without gallery tiles", async () => {
  const [appSource, storeSource, viewerHtml, viewerScript] = await Promise.all([
    readFile(new URL("../src/app.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/store.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/viewer.html", import.meta.url), "utf8"),
    readFile(new URL("../public/viewer.js", import.meta.url), "utf8"),
  ]);
  assert.match(appSource, /app\.get\(["']\/today\/image/);
  assert.match(storeSource, /async requireImage/);
  assert.doesNotMatch(storeSource, /image_url/);
  assert.match(viewerScript, /image\.src = `\/today\/image\/\$\{photo\.date_folder\}\/\$\{photo\.base\}\.jpg`/);
  assert.doesNotMatch(viewerScript, /\/gallery\/api\/view-session|\/gallery\/tile|tile-surface|photo-tile/);
  assert.doesNotMatch(viewerScript, /document\.createElement\(["']canvas["']\)/);
  assert.match(viewerScript, /image\.className = ["']photo-image["']/);
  assert.match(viewerScript, /image\.style\.transform = `scale/);
  assert.match(viewerScript, /viewerAnimation = frame\.animate/);
  assert.match(viewerScript, /cancelAnimationFrame\(presentationFrame\)/);
  assert.match(viewerScript, /presentationKey !== key \|\| currentLayer !== layer/);
  assert.match(viewerScript, /layoutLayer\(nextLayer, ["']default["']\)/);
  const renderSource = viewerScript.slice(
    viewerScript.indexOf("function render"),
    viewerScript.indexOf("async function stagePhoto"),
  );
  const stageSource = viewerScript.slice(
    viewerScript.indexOf("async function stagePhoto"),
    viewerScript.indexOf("async function fillLayer"),
  );
  assert.doesNotMatch(renderSource, /setAttribute\(["']aria-label["']/);
  assert.match(stageSource, /layoutLayer\(currentLayer, ["']default["']\)[\s\S]*setAttribute\(["']aria-label["']/);
  assert.match(viewerHtml, /id="photo-current" class="photo-layer current"><\/div>/);
  assert.match(viewerHtml, /today\.css\?v=full-image-viewer-1/);
  assert.match(viewerHtml, /viewer\.js\?v=full-image-viewer-1/);
});

test("Photo Stage Remote keeps controls in one viewport and uses a dismissible thumbnail drawer", async () => {
  const [remoteHtml, remoteScript, styles] = await Promise.all([
    readFile(new URL("../public/remote.html", import.meta.url), "utf8"),
    readFile(new URL("../public/remote.js", import.meta.url), "utf8"),
    readFile(new URL("../public/today.css", import.meta.url), "utf8"),
  ]);
  assert.match(remoteHtml, /id="thumbnails-close"[^>]+aria-label="Close thumbnails"/);
  assert.match(remoteHtml, /id="thumbnail-section"[^>]+role="dialog"/);
  assert.match(remoteHtml, /id="header-collapse"[^>]+aria-label="Collapse header"[^>]+aria-expanded="true"/);
  assert.equal((remoteHtml.match(/class="action-button/g) || []).length, 7);
  assert.match(remoteHtml, /id="interval"[^>]+min="0"[^>]+max="14"[^>]+value="7"/);
  assert.match(remoteScript, /elements\.thumbnailsClose\.addEventListener\("click", \(\) => setThumbnailsVisible\(false\)\)/);
  assert.match(remoteScript, /event\.key === "Escape" && thumbnailsVisible/);
  assert.match(remoteScript, /if \(collapsed && event\.detail > 0\) elements\.headerCollapse\.blur\(\)/);
  assert.match(remoteScript, /document\.body\.classList\.toggle\("header-collapsed", collapsed\)/);
  assert.match(remoteScript, /send\(\{ type: "GOTO_INDEX", index \}\);\s+setThumbnailsVisible\(false\)/);
  assert.match(remoteScript, /const durationSteps = \[1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 45, 60, 90, 120\]/);
  assert.match(remoteScript, /interval_ms: durationSteps\[Number\(elements\.interval\.value\)\] \* 1000/);
  assert.match(styles, /\.action-controls\s*\{[^}]*grid-template-columns:\s*repeat\(7/);
  assert.match(styles, /\.remote-page\s*\{[^}]*height:\s*100dvh[^}]*overflow:\s*hidden/);
  assert.match(styles, /\.header-collapsed \.header-collapse\s*\{[^}]*position:\s*fixed[^}]*opacity:\s*\.35[^}]*1\.5s/);
  assert.match(styles, /\.header-collapsed \.header-collapse:hover[^}]*opacity:\s*1/);
  assert.match(styles, /\.remote-main\s*\{[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.thumbnail-section\s*\{[^}]*position:\s*fixed[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(styles, /\.thumbnail-list\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(styles, /@media \(max-height:\s*560px\)/);
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-today-"));
  const day = path.join(root, "galleries", "2026-06-13");
  await mkdir(path.join(root, "state"), { recursive: true });
  await mkdir(day, { recursive: true });
  await publish(day, "first", "2026-06-13T10:00:00.000Z");
  await publish(day, "second", "2026-06-13T11:00:00.000Z");
  await writeFile(path.join(day, "hidden.jpg"), "hidden");
  await writeFile(path.join(root, "state", "latest.json"), JSON.stringify({
    updated_at: "2026-06-13T11:00:00.000Z",
    date_folder: "2026-06-13",
    latest_base: "second",
    count_today: 2,
  }));
  return root;
}

async function publish(day, base, processedAt) {
  await writeFile(path.join(day, `${base}.jpg`), base);
  await writeFile(path.join(day, `${base}.ready`), `${base}.jpg`);
  await writeFile(path.join(day, `${base}.txt`), "Camera: FRAME\0 Test\nISO: 100\n");
  await writeFile(path.join(day, `${base}.json`), JSON.stringify({
    width: 1920,
    height: 1080,
    orientation: 0,
    processed_at: processedAt,
    exif: { make: "FRAME", model: "Test" },
  }));
  assert.equal((await readFile(path.join(day, `${base}.ready`), "utf8")).length > 0, true);
}
