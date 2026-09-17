import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { TodayStore } from "../dist/store.js";

test("dashboard shares scans, caches unchanged publications, and refreshes uploads, trash, restores and moves", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-dashboard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const date = "2026-09-08";
  const previousDate = "2026-09-07";
  const day = path.join(root, "galleries", date);
  await mkdir(path.join(root, "state"), { recursive: true });
  await mkdir(day, { recursive: true });
  const store = new TodayStore(root);
  const calls = [];
  const listPhotos = store.listPhotos.bind(store);
  store.listPhotos = (date) => { calls.push(date); return listPhotos(date); };
  let revision = 0;
  const publishRevision = (count, base) => writeFile(store.latestFile, JSON.stringify({
    updated_at: String(++revision), date_folder: date, count_today: count, latest_base: base,
  }));
  const publish = async (base, minute) => {
    await writeFile(path.join(day, `${base}.json`), JSON.stringify({ processed_at: `2026-09-08T12:0${minute}:00.000Z` }));
    await writeFile(path.join(day, `${base}.txt`), `Camera ${base}`);
    await writeFile(path.join(day, `${base}.ready`), "ready");
  };
  await publish("first", 0);
  await publishRevision(1, "first");
  const pending = store.dashboardSummary();
  assert.equal(store.dashboardSummary(), pending, "concurrent callers share the entire scan");
  const first = await pending;
  assert.equal(first.total_images, 1);
  assert.equal(first.latest_photo.camera_text, "Camera first");
  assert.deepEqual(calls, [date], "the current album is read only once");
  assert.equal(await store.dashboardSummary(), first);
  assert.deepEqual(calls, [date], "unchanged publications do not rescan");

  await publish("second", 1);
  await publishRevision(2, "second");
  assert.equal((await store.dashboardSummary()).total_images, 2);
  await writeFile(path.join(day, "second.trashed.json"), "{}");
  await publishRevision(1, "first");
  const trashed = await store.dashboardSummary();
  assert.equal(trashed.total_images, 1);
  assert.equal(trashed.latest_photo.base, "first");
  await rm(path.join(day, "second.trashed.json"));
  await publishRevision(2, "second");
  assert.equal((await store.dashboardSummary()).total_images, 2);

  const previousDay = path.join(root, "galleries", previousDate);
  await mkdir(previousDay);
  for (const extension of ["json", "txt", "ready"]) {
    await rename(path.join(day, `second.${extension}`), path.join(previousDay, `second.${extension}`));
  }
  await publishRevision(1, "first");
  const moved = await store.dashboardSummary();
  assert.equal(moved.total_albums, 2);
  assert.equal(moved.total_images, 2);
  assert.equal(moved.current_gallery.count, 1);
  assert.equal(moved.latest_photo.base, "first");

  await publishRevision(0, null);
  store.listPhotos = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(store.dashboardSummary(), /disk unavailable/);
  store.listPhotos = listPhotos;
  assert.equal((await store.dashboardSummary()).total_images, 2, "a failed refresh does not stick or poison the cache");
});

test("dashboard reconciles manual edits after one minute even without latest.json", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 8, 8) });
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-dashboard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new TodayStore(root);
  assert.equal((await store.dashboardSummary()).total_images, 0);
  const day = path.join(root, "galleries", "2026-09-08");
  await mkdir(day, { recursive: true });
  await writeFile(path.join(day, "manual.ready"), "ready");
  await writeFile(path.join(day, "manual.txt"), "Original metadata");
  t.mock.timers.tick(59_999);
  assert.equal((await store.dashboardSummary()).total_images, 0);
  t.mock.timers.tick(1);
  assert.equal((await store.dashboardSummary()).latest_photo.camera_text, "Original metadata");
  await writeFile(path.join(day, "manual.txt"), "Edited metadata");
  assert.equal((await store.dashboardSummary()).latest_photo.camera_text, "Original metadata");
  t.mock.timers.tick(60_000);
  assert.equal((await store.dashboardSummary()).latest_photo.camera_text, "Edited metadata");
});

test("dashboard polling never overlaps, pauses when hidden, resumes and recovers after errors", async () => {
  const source = await readFile(new URL("../public/dashboard.js", import.meta.url), "utf8");
  const timers = new Map();
  const listeners = {};
  const pending = [];
  const elements = new Map();
  let timerId = 0;
  const document = {
    hidden: false, documentElement: { dataset: {} },
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, { addEventListener() {}, setAttribute() {} });
      return elements.get(selector);
    },
    addEventListener(name, listener) { listeners[name] = listener; },
  };
  const window = {
    addEventListener() {},
    clearTimeout(id) { timers.delete(id); },
    setTimeout(callback, delay) { timers.set(++timerId, { callback, delay }); return timerId; },
  };
  const context = vm.createContext({
    document, window, AbortSignal, localStorage: { getItem() { return null; } },
    fetch(url) { const deferred = Promise.withResolvers(); pending.push({ url, ...deferred }); return deferred.promise; },
  });
  vm.runInContext(source, context);
  // Rendering is covered separately; exercise the real polling and visibility event wiring here.
  vm.runInContext("render = () => {}; renderPipeline = () => true; renderPipelineUnavailable = () => {};", context);
  assert.equal(pending.length, 2);
  await vm.runInContext("Promise.all([refresh(), refreshPipeline()])", context);
  assert.equal(pending.length, 2, "repeated refresh calls do not overlap pending requests");
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const succeed = (request) => request.resolve({ ok: true, json: async () => ({ available: true }) });
  document.hidden = true;
  listeners.visibilitychange();
  pending.splice(0).forEach(succeed);
  await flush();
  assert.equal(timers.size, 0, "requests completing in the background do not restart timers");
  await vm.runInContext("Promise.all([refresh(), refreshPipeline()])", context);
  assert.equal(pending.length, 0);

  document.hidden = false;
  listeners.visibilitychange();
  listeners.visibilitychange();
  assert.equal(pending.length, 2, "visibility changes cannot duplicate requests");
  pending.splice(0).forEach(succeed);
  await flush();
  assert.deepEqual([...timers.values()].map(({ delay }) => delay).sort(), [1000, 5000]);
  document.hidden = true;
  listeners.visibilitychange();
  assert.equal(timers.size, 0, "hiding clears both scheduled refreshes");
  document.hidden = false;
  listeners.visibilitychange();
  pending.splice(0).forEach(({ reject }) => reject(new Error("offline")));
  await flush();
  assert.deepEqual([...timers.values()].map(({ delay }) => delay), [5000, 5000]);
  assert.equal(elements.get("#dashboard-status").textContent, "Library unavailable");
  for (const { callback } of [...timers.values()]) callback();
  assert.equal(pending.length, 2, "both pollers retry after failure");
  pending.splice(0).forEach(succeed);
  await flush();
  assert.equal(elements.get("#dashboard-status").textContent, "Library connected");
});
