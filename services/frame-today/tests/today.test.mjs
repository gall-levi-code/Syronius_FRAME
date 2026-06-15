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

test("HTTP API serves published media and rejects unpublished media", async () => {
  const root = await fixture();
  const store = new TodayStore(root);
  const controller = new TodayController(store, 10_000, 60_000);
  await controller.init();
  const app = createApp(controller, store, path.resolve("public"), {
    username: "frame",
    password: "secret",
    realm: "FRAME Test",
  });
  const server = app.listen(0);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const state = await (await fetch(`${base}/today/api/state`)).json();
    assert.equal(state.count_today, 2);
    assert.equal((await fetch(`${base}/today/image/2026-06-13/second.jpg`)).status, 200);
    assert.equal((await fetch(`${base}/today/image/2026-06-13/hidden.jpg`)).status, 404);
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
  } finally {
    controller.close();
    await new Promise((resolve) => server.close(resolve));
  }
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
