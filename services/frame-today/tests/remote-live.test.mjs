import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../public/remote.js", import.meta.url), "utf8");
function functions(...names) {
  return names.map((name) => {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"));
    assert.ok(match, `Missing ${name}`);
    return match[0];
  }).join("\n");
}

test("remote reports readiness only for the current photo and clears it on disconnect", () => {
  const elements = { viewerFeedback: { dataset: {} } };
  const render = Function("elements", "WebSocket", `
    let state, viewerStatus, socket;
    ${functions("renderViewerStatus")}
    return (next, report, connected = true) => {
      state = next; viewerStatus = report; socket = { readyState: connected ? 1 : 3 };
      renderViewerStatus(); return elements.viewerFeedback.textContent;
    };
  `)(elements, { OPEN: 1 });
  const state = { date_folder: "2026-09-08", current_base: "photo", current_photo: {} };
  const report = { photo_key: "2026-09-08/photo", viewers: 2, displayed: 2, failed: 0 };
  assert.equal(render(state, report), "Photo displayed on 2 viewers");
  assert.match(render(state, { ...report, displayed: 1 }), /Loading photo.*1\/2 ready/);
  assert.match(render(state, { ...report, displayed: 1, failed: 1 }), /Image unavailable on 1 of 2 viewers/);
  assert.equal(render(state, { ...report, photo_key: "2026-09-08/old" }), "Checking viewer…");
  assert.match(render(state, report, false), /viewer status unavailable/);
  assert.equal(render(state, { ...report, viewers: 0, displayed: 0 }), "No viewer connected");
});

test("wake lock reflects actual acquisition, release, backgrounding, denial and canceled requests", async () => {
  const document = { visibilityState: "visible" };
  const window = { isSecureContext: true };
  const elements = { keepAwake: {}, wakeLockStatus: {} };
  let requests = 0;
  let behavior;
  const navigator = { wakeLock: { request: (type) => { assert.equal(type, "screen"); requests += 1; return behavior(); } } };
  const api = Function("elements", "document", "window", "navigator", `
    let wakeLock = null, wakeLockWanted = false, wakeLockRequest = null, wakeLockError = "";
    ${functions("requestWakeLock", "releaseWakeLock", "renderWakeLock")}
    return {
      wanted(value) { wakeLockWanted = value; wakeLockError = ""; renderWakeLock(); },
      request: requestWakeLock, release: releaseWakeLock, render: renderWakeLock,
    };
  `)(elements, document, window, navigator);
  function sentinel() {
    const listeners = {};
    return {
      released: false,
      addEventListener(name, listener) { listeners[name] = listener; },
      async release() { this.released = true; listeners.release?.(); },
    };
  }
  const first = sentinel();
  behavior = () => Promise.resolve(first);
  api.wanted(true);
  await api.request();
  assert.match(elements.wakeLockStatus.textContent, /^Active/);
  await api.request();
  assert.equal(requests, 1, "an active lock must not be requested again");
  await first.release();
  assert.match(elements.wakeLockStatus.textContent, /^Not active/);
  document.visibilityState = "hidden";
  await api.release();
  await api.request();
  assert.equal(requests, 1);
  assert.match(elements.wakeLockStatus.textContent, /background/);
  document.visibilityState = "visible";
  behavior = () => Promise.reject(new Error("Battery saver"));
  await api.request();
  assert.match(elements.wakeLockStatus.textContent, /battery settings/);
  assert.equal(elements.keepAwake.checked, true, "requested preference is distinct from actual lock status");

  const late = sentinel();
  let finish;
  behavior = () => new Promise((resolve) => { finish = resolve; });
  const pending = api.request();
  assert.match(elements.wakeLockStatus.textContent, /Requesting/);
  api.wanted(false);
  finish(late);
  await pending;
  assert.equal(late.released, true, "turning off during acquisition must release a late lock");
  assert.equal(elements.wakeLockStatus.textContent, "Screen may sleep");
  api.wanted(true);
  const active = sentinel();
  behavior = () => Promise.resolve(active);
  await api.request();
  document.visibilityState = "hidden";
  await api.release();
  assert.equal(active.released, true);
  document.visibilityState = "visible";
  behavior = () => Promise.resolve(sentinel());
  await api.request();
  assert.match(elements.wakeLockStatus.textContent, /^Active/);
  await api.release();
  let resolveRequest;
  let resolveRelease;
  const backgroundLock = sentinel();
  backgroundLock.release = () => new Promise((resolve) => { resolveRelease = resolve; });
  behavior = () => new Promise((resolve) => { resolveRequest = resolve; });
  const backgroundRequest = api.request();
  document.visibilityState = "hidden";
  resolveRequest(backgroundLock);
  await Promise.resolve();
  document.visibilityState = "visible";
  await api.request();
  behavior = () => Promise.resolve(sentinel());
  resolveRelease();
  await backgroundRequest;
  await Promise.resolve();
  assert.match(elements.wakeLockStatus.textContent, /^Active/, "returning while a late hidden lock is released must reacquire");
  await api.release();
  window.isSecureContext = false;
  api.render();
  assert.equal(elements.keepAwake.disabled, true);
  assert.match(elements.wakeLockStatus.textContent, /HTTPS/);
  window.isSecureContext = true;
  delete navigator.wakeLock;
  api.render();
  assert.equal(elements.keepAwake.disabled, true);
  assert.match(elements.wakeLockStatus.textContent, /does not support/);
});
