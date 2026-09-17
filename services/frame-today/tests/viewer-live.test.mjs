import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("viewer commits decoded photos and metadata together, reuses one preload, and ignores replaced loads", async () => {
  const viewer = await createViewer();
  const photos = ["first", "second", "third", "fourth"].map((base) => ({
    base, date_folder: "2026-09-08", processed_at: "2026-09-08T12:00:00Z", width: 1600, height: 900,
    camera_text: `Camera: ${base}\nISO: 100`,
  }));
  const state = (index, extra = {}) => ({
    current_photo: photos[index] || null, current_index: index, current_base: photos[index]?.base || null,
    date_folder: "2026-09-08", count_today: photos.length, photos, slideshow_running: true,
    show_exif: true, show_background: true, presentation_mode: "default", ...extra,
  });
  viewer.render(state(0));
  assert.equal(viewer.report().status, "loading");
  const first = viewer.images[0];
  await viewer.load(first);
  assert.equal(viewer.elements["photo-name"].textContent, "");
  assert.equal(viewer.report().status, "loading", "decoding and the transition must finish before reporting displayed");
  viewer.advance(440);
  assert.equal(viewer.elements["photo-name"].textContent, "first");
  assert.equal(viewer.elements["camera-text"].textContent, "Camera: first\nISO: 100");
  assert.equal(viewer.report().status, "displayed");
  assert.equal(viewer.images.length, 2, "only the next slideshow image is preloaded");

  const second = viewer.images[1];
  viewer.render(state(1));
  assert.equal(viewer.images.length, 2, "selecting the preload must reuse its image and request");
  second.onload();
  await viewer.flush();
  assert.equal(viewer.elements["photo-name"].textContent, "first", "incoming state must not replace the visible photo's caption");
  viewer.render(state(2));
  const third = viewer.images[2];
  assert.equal(second.src, "", "a superseded load is canceled");
  await viewer.load(third);
  viewer.advance(440);
  assert.equal(viewer.elements["photo-name"].textContent, "third");
  assert.equal(viewer.visibleImage(), third);
  second.finishDecode();
  await viewer.flush();
  viewer.advance(440);
  assert.equal(viewer.visibleImage(), third, "a slow replaced decode must never mutate a live layer");
  assert.equal(viewer.elements["photo-name"].textContent, "third");

  const fourth = viewer.images[3];
  fourth.onerror();
  await viewer.flush();
  viewer.render(state(3));
  await viewer.flush();
  assert.equal(viewer.report().status, "error");
  assert.equal(viewer.visibleImage(), third, "failed selections retain the last good photo");
  assert.equal(viewer.elements["photo-name"].textContent, "third");
  viewer.advance(1200);
  assert.equal(viewer.images.length, 5, "failed preload uses the existing retry path with a fresh image");
  const retry = viewer.images[4];
  viewer.openSocket();
  assert.equal(viewer.report().status, "loading", "reconnect must report the pending load, not the last displayed photo");
  await viewer.load(retry);
  viewer.advance(440);
  assert.equal(viewer.visibleImage(), retry);
  assert.equal(viewer.report().photo_key, "2026-09-08/fourth");
  assert.equal(viewer.report().status, "displayed");

  viewer.render(state(3, { overlay_auto_hide: true }));
  viewer.advance(4000);
  viewer.render(state(3, { overlay_auto_hide: true, show_background: false }));
  viewer.advance(999);
  assert.equal(viewer.elements["exif-panel"].classList.contains("faded"), false);
  viewer.advance(1);
  assert.equal(viewer.elements["exif-panel"].classList.contains("faded"), true, "unrelated state updates must not extend the five-second deadline");
  viewer.render(state(3, { overlay_mode: "compact", overlay_corner: "top-right" }));
  assert.equal(viewer.elements["exif-panel"].dataset.corner, "top-right");
  assert.equal(viewer.elements["exif-panel"].dataset.mode, "compact");
  assert.equal(viewer.elements["camera-text"].textContent, "ISO: 100");
  assert.equal(viewer.elements["exif-panel"].classList.contains("faded"), false);
  viewer.render(state(0));
  await viewer.load(viewer.images[5]);
  assert.equal(viewer.elements["exif-panel"].hidden, true, "captions stay hidden while two photos crossfade");
  viewer.render(state(3));
  viewer.advance(440);
  assert.equal(viewer.visibleImage(), retry, "returning to the visible photo cancels an in-progress crossfade");
  assert.equal(viewer.elements["exif-panel"].hidden, false);
  assert.equal(viewer.elements["photo-name"].textContent, "fourth");
  viewer.render(state(3, { overlay_mode: "hidden", clean_output: true }));
  assert.equal(viewer.elements["exif-panel"].hidden, true);
  assert.equal(viewer.elements["viewer-status"].hidden, true);
  viewer.render(state(-1, { clean_output: true }));
  assert.equal(viewer.elements["viewer-empty"].hidden, true);
  assert.equal(viewer.elements["photo-stage"].hidden, true);
  assert.equal(viewer.report().status, "empty");
  assert.equal(viewer.report().photo_key, null);
});

async function createViewer() {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const elements = {};
  const images = [];
  const reports = [];
  const sockets = [];
  class Element {
    constructor() {
      const classes = new Set();
      this.classList = {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        contains: (name) => classes.has(name),
        toggle(name, active) { if (active) classes.add(name); else classes.delete(name); },
      };
      this.dataset = {};
      this.style = {};
      this.attributes = {};
      this.children = [];
      this.className = "";
      this.textContent = "";
      this.clientWidth = 1280;
      this.clientHeight = 720;
    }
    append(element) { this.children.push(element); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    querySelector(selector) {
      for (const child of this.children) {
        if (child.className.split(" ").includes(selector.slice(1))) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
  }
  class MockImage extends Element {
    constructor() {
      super();
      this.naturalWidth = 1600;
      this.naturalHeight = 900;
      this.src = "";
      this.decoded = new Promise((resolve) => { this.finishDecode = resolve; });
      images.push(this);
    }
    decode() { return this.decoded; }
    removeAttribute(name) { if (name === "src") this.src = ""; }
  }
  class MockSocket {
    static OPEN = 1;
    constructor() { this.readyState = 1; this.listeners = {}; sockets.push(this); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    send(message) { reports.push(JSON.parse(message)); }
    close() { this.readyState = 3; }
  }
  const context = vm.createContext({
    document: {
      querySelector: (selector) => elements[selector.slice(1)] ||= new Element(),
      createElement: () => new Element(), documentElement: new Element(), body: new Element(),
    },
    window: { addEventListener() {}, innerWidth: 1280, innerHeight: 720 },
    Image: MockImage, WebSocket: MockSocket, location: { protocol: "http:", host: "localhost" },
    performance: { now: () => now },
    setTimeout(callback, delay) { timers.set(++timerId, { at: now + delay, callback }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame() { throw new Error("Unexpected animation"); }, cancelAnimationFrame() {},
  });
  vm.runInContext(await readFile(new URL("../public/viewer.js", import.meta.url), "utf8"), context);
  const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
  return {
    elements, images, render: context.render, report: () => reports.at(-1), flush,
    openSocket: () => sockets.at(-1).listeners.open(),
    async load(image) { image.onload(); await flush(); image.finishDecode(); await flush(); },
    visibleImage: () => vm.runInContext('currentLayer.querySelector(".photo-image")', context),
    advance(duration) {
      const end = now + duration;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].callback();
      }
      now = end;
    },
  };
}
