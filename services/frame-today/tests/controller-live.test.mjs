import assert from "node:assert/strict";
import test from "node:test";
import { TodayController, parseCommand } from "../dist/controller.js";

function library() {
  const galleries = new Map();
  let revision = 0;
  let latest = null;
  return {
    galleries,
    async readLatest() { return latest; },
    async listPhotos(date) { return (galleries.get(date) || []).map((photo) => ({ ...photo })); },
    publish(date, bases) {
      galleries.set(date, bases.map((base, index) => ({
        date_folder: date, base, filename: `${base}.jpg`, thumbnail_url: `/thumb/${date}/${base}`,
        processed_at: new Date(Date.UTC(2026, 8, 8, 0, index)).toISOString(),
        width: 1920, height: 1080, orientation: 0, camera_text: base, exif: {},
      })));
      latest = { date_folder: date, latest_base: bases.at(-1) || null, count_today: bases.length, updated_at: String(++revision) };
    },
    touch() { latest = { ...latest, updated_at: String(++revision) }; },
  };
}

test("holding a photo survives uploads, metadata refreshes, date rollover, and deleted photos", async () => {
  const store = library();
  const controller = new TodayController(store, 10_000, 60_000);
  const firstDate = "2026-09-08";
  const nextDate = "2026-09-09";
  try {
    store.publish(firstDate, ["first", "second"]);
    await controller.refresh(true);
    assert.equal(controller.state().following_latest, true);
    assert.equal(controller.state().current_base, "second");
    const held = controller.command({ type: "GOTO_INDEX", index: 0 });
    assert.equal(held.playback_state, "paused");
    assert.equal(held.following_latest, false);

    store.touch();
    await controller.refresh(false);
    assert.equal(controller.state().new_photos_count, 0, "existing photos and metadata changes are not new uploads");
    store.publish(firstDate, ["first", "second", "third"]);
    await controller.refresh(false);
    assert.equal(controller.state().current_base, "first");
    assert.equal(controller.state().new_photos_count, 1);
    store.touch();
    await controller.refresh(false);
    assert.equal(controller.state().new_photos_count, 1, "repeat refreshes must not count the same photo twice");

    store.publish(nextDate, ["first"]);
    await controller.refresh(false);
    assert.equal(controller.state().date_folder, firstDate);
    assert.equal(controller.state().current_photo.date_folder, firstDate);
    assert.equal(controller.state().photos.length, 3);
    assert.equal(controller.state().new_photos_count, 2, "identical bases on different days are different photos");

    store.galleries.set(firstDate, store.galleries.get(firstDate).filter((photo) => photo.base !== "first"));
    store.touch();
    await controller.refresh(false);
    assert.equal(controller.state().current_base, "second", "trashing the held photo safely selects a remaining photo");
    assert.equal(controller.state().date_folder, firstDate);
    assert.equal(controller.state().playback_state, "paused");
    store.galleries.set(firstDate, store.galleries.get(firstDate).filter((photo) => photo.base !== "third"));
    store.touch();
    await controller.refresh(false);
    assert.equal(controller.state().new_photos_count, 1, "trashed new photos leave the available upload count");
    store.galleries.set(firstDate, []);
    store.touch();
    await controller.refresh(false);
    assert.equal(controller.state().current_base, null);
    assert.equal(controller.state().current_index, -1);
    assert.equal(controller.state().date_folder, firstDate, "an empty held gallery must not silently jump days");

    const followed = controller.command(parseCommand({ type: "FOLLOW_LATEST" }));
    assert.equal(followed.date_folder, nextDate);
    assert.equal(followed.current_base, "first");
    assert.equal(followed.following_latest, true);
    assert.equal(followed.playback_state, "stopped");
    assert.equal(followed.new_photos_count, 0);
    controller.command({ type: "PAUSE_SLIDESHOW" });
    assert.equal(controller.state().following_latest, false);
    store.publish(nextDate, ["first", "latest"]);
    await controller.refresh(false);
    assert.equal(controller.state().current_base, "first");
    const stopped = controller.command({ type: "STOP_SLIDESHOW" });
    assert.equal(stopped.following_latest, true, "the existing stop command remains a follow-latest alias");
    assert.equal(stopped.current_base, "latest");
    store.publish(nextDate, ["first", "latest", "newest"]);
    await controller.refresh(false);
    assert.equal(controller.state().current_base, "newest");
    assert.equal(controller.state().new_photos_count, 0);
  } finally {
    controller.close();
  }
});

test("uploads preserve slideshow timing while manual navigation holds the chosen photo", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 8, 8) });
  const store = library();
  const controller = new TodayController(store, 10_000, 60_000);
  try {
    store.publish("2026-09-08", ["first", "second"]);
    await controller.refresh(true);
    controller.command({ type: "GOTO_INDEX", index: 0 });
    const playing = controller.command({ type: "PLAY_SLIDESHOW" });
    assert.equal(playing.following_latest, false);
    context.mock.timers.tick(4_000);
    store.publish("2026-09-08", ["first", "second", "third"]);
    await controller.refresh(false);
    assert.equal(controller.state().current_base, "first");
    assert.equal(controller.state().interval_started_at, playing.interval_started_at);
    assert.equal(controller.state().next_change_at, playing.next_change_at);
    assert.equal(controller.state().new_photos_count, 1);
    store.publish("2026-09-09", ["fourth"]);
    await controller.refresh(false);
    assert.equal(controller.state().next_change_at, playing.next_change_at);
    assert.equal(controller.state().date_folder, "2026-09-08");
    context.mock.timers.tick(6_000);
    assert.equal(controller.state().current_base, "second");
    assert.equal(controller.state().playback_state, "playing", "timer advancement must not act like manual navigation");

    for (const command of [{ type: "NEXT" }, { type: "PREV" }, { type: "GOTO_INDEX", index: 0 }]) {
      controller.command({ type: "PLAY_SLIDESHOW" });
      const selected = controller.command(command);
      assert.equal(selected.playback_state, "paused");
      assert.equal(selected.following_latest, false);
      assert.equal(selected.next_change_at, null);
      context.mock.timers.tick(20_000);
      assert.equal(controller.state().current_base, selected.current_base);
    }
    controller.command({ type: "AUTO_SCROLL_IMAGE" });
    const presentation = controller.state().presentation_started_at;
    context.mock.timers.tick(1_000);
    store.touch();
    await controller.refresh(false);
    assert.equal(controller.state().presentation_started_at, presentation, "metadata refreshes must not restart image presentation");
  } finally {
    controller.close();
  }
});

test("overlay commands validate inputs and preserve the visible mode for legacy EXIF controls", () => {
  const controller = new TodayController(library(), 10_000, 60_000);
  assert.equal(controller.state().overlay_mode, "full");
  assert.equal(controller.state().overlay_corner, "bottom-left");
  assert.equal(controller.state().overlay_auto_hide, false);
  assert.equal(controller.state().clean_output, false);
  const overlay = { type: "SET_OVERLAY", mode: "compact", corner: "top-right", auto_hide: true };
  controller.command(parseCommand(overlay));
  assert.equal(controller.state().overlay_mode, "compact");
  assert.equal(controller.state().overlay_corner, "top-right");
  assert.equal(controller.state().overlay_auto_hide, true);
  controller.command({ type: "SET_SHOW_EXIF", show_exif: false });
  assert.equal(controller.state().overlay_mode, "hidden");
  controller.command({ type: "SET_SHOW_EXIF", show_exif: true });
  assert.equal(controller.state().overlay_mode, "compact");
  controller.command(parseCommand({ ...overlay, mode: "hidden" }));
  assert.equal(controller.state().show_exif, false);
  controller.command(parseCommand({ type: "SET_CLEAN_OUTPUT", clean_output: true }));
  assert.equal(controller.state().clean_output, true);
  for (const invalid of [
    { ...overlay, mode: "large" }, { ...overlay, corner: "center" }, { ...overlay, auto_hide: "true" },
    { type: "SET_OVERLAY", mode: "full" }, { type: "SET_CLEAN_OUTPUT", clean_output: 1 },
  ]) {
    assert.throws(() => parseCommand(invalid));
    assert.throws(() => controller.command(invalid));
  }
  assert.equal(controller.state().overlay_mode, "hidden", "invalid commands must not partially apply settings");
});

test("an in-flight gallery refresh honors newer remote commands and retries failed reads", async () => {
  const store = library();
  const controller = new TodayController(store, 10_000, 60_000);
  const listPhotos = store.listPhotos.bind(store);
  store.publish("2026-09-08", ["old-first", "old-second"]);
  await controller.refresh(true);
  controller.command({ type: "PAUSE_SLIDESHOW" });
  store.publish("2026-09-09", ["middle"]);
  await controller.refresh(false);
  store.publish("2026-09-10", ["newest"]);
  let entered;
  let release;
  const reading = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  store.listPhotos = async (date) => { entered(); await gate; return listPhotos(date); };
  const pending = controller.refresh(false);
  await reading;
  assert.equal(controller.refresh(false), pending, "overlapping poll requests share the same refresh");
  controller.command({ type: "FOLLOW_LATEST" });
  controller.command({ type: "PAUSE_SLIDESHOW" });
  release();
  await pending;
  assert.equal(controller.state().date_folder, "2026-09-09");
  assert.equal(controller.state().current_base, "middle");
  assert.equal(controller.state().new_photos_count, 1, "the abandoned older gallery is not a new upload");
  const revision = controller.state().revision;
  store.touch();
  store.listPhotos = async () => { throw new Error("temporarily unavailable"); };
  await assert.rejects(controller.refresh(false), /temporarily unavailable/);
  assert.equal(controller.state().revision, revision);
  store.listPhotos = listPhotos;
  await controller.refresh(false);
  assert.ok(controller.state().revision > revision);
  assert.equal(controller.state().current_base, "middle");
  controller.close();
});
