import assert from "node:assert/strict";
import test from "node:test";
import { observeCoverGallery, planJustifiedRows } from "../public/justified-rows.js";

test("packs justified rows without losing order or leaving full-row gaps", () => {
  const ratios = [1.5, 2 / 3, 1.2, 1.8, 0.75, 4 / 3, 2.1, 0.6, 1.4];
  for (const width of [320, 390, 768, 1440, 2560]) {
    const rows = planJustifiedRows(ratios, width, 300, 5);
    assert.deepEqual(rows.flatMap((row) => row.items.map((item) => item.index)), ratios.map((_, index) => index));
    for (const row of rows) {
      const used = row.items.reduce((sum, item) => sum + item.ratio * row.height, 0) + 5 * Math.max(0, row.items.length - 1);
      if (row.partial) assert.ok(used < width);
      else assert.ok(Math.abs(used - width) < 0.001, `row at ${width}px leaves ${width - used}px`);
    }
  }
});

test("keeps a final photo with its neighbor and caps a sparse final row", () => {
  const rows = planJustifiedRows([2, 2, 2, 0.5], 1000, 200, 5);
  assert.deepEqual(rows.map((row) => row.items.map((item) => item.index)), [[0, 1], [2, 3]]);
  assert.equal(rows.at(-1).partial, true);
  assert.equal(rows.at(-1).height, 200);
});

test("cover galleries batch image and resize reflows, preserve native ratios, and recover after being hidden", (t) => {
  const savedGlobals = new Map(["requestAnimationFrame", "ResizeObserver", "window"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => savedGlobals.forEach((descriptor, key) => descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete globalThis[key]));
  const frames = [];
  const events = {};
  let resize;
  let layouts = 0;
  const cards = [[700, 1100], [1600, 500], [0, 0]].map(([naturalWidth, naturalHeight], index) => ({
    dataset: {}, style: {}, classList: { contains: () => false }, image: { src: `/cover-${index}.webp`, naturalWidth, naturalHeight }, contains: () => false,
    querySelector() { return this.image; },
  }));
  const container = {
    clientWidth: 0,
    ownerDocument: { activeElement: null, createElement() {
      const row = { children: [], append(item) { this.children.push(item); } };
      row.classList = { contains: (name) => row.className.split(/\s+/).includes(name) };
      return row;
    } },
    querySelectorAll: () => cards,
    addEventListener(name, handler, capture) { events[name] = handler; assert.equal(capture, true); },
    replaceChildren(...rows) { layouts += 1; this.rows = rows; this.firstElementChild = rows[0]; },
  };
  globalThis.requestAnimationFrame = (callback) => { frames.push(callback); return 1; };
  globalThis.ResizeObserver = class {
    constructor(callback) { resize = (width) => callback([{ contentRect: { width } }]); }
    observe(observed) { assert.equal(observed, container); }
  };
  globalThis.window = { innerHeight: 800, addEventListener(name, handler) { events[name] = handler; } };
  const schedule = observeCoverGallery(container);
  schedule();
  schedule();
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(layouts, 0, "hidden galleries must not be measured");

  container.clientWidth = 900;
  resize(900);
  events.load();
  events.resize();
  assert.equal(frames.length, 1, "resize and image load events must share one animation frame");
  frames.shift()();
  assert.equal(layouts, 1);
  assert.deepEqual(cards.map((card) => Number(card.dataset.ratio)), [700 / 1100, 3.2, 4 / 3]);
  assert.deepEqual(container.rows.flatMap((row) => row.children), cards);
  assert.ok(container.rows.every((row) => row.className.startsWith("gallery-cover-row")));
  resize(900.2);
  assert.equal(frames.length, 0, "subpixel or height-only observer updates must not cause a reflow loop");

  cards[2].image = { ...cards[2].image, naturalWidth: 1200, naturalHeight: 900 };
  cards[0].image = { ...cards[0].image, naturalWidth: 900, naturalHeight: 1200 };
  events.load();
  frames.shift()();
  assert.equal(layouts, 2);
  assert.equal(cards[0].style.aspectRatio, "0.75");
  container.clientWidth = 0;
  resize(0);
  frames.shift()();
  assert.equal(layouts, 2);
  cards[0] = { ...cards[0], dataset: {}, style: {}, image: { src: cards[0].image.src, naturalWidth: 0, naturalHeight: 0 } };
  container.clientWidth = 390;
  resize(390);
  frames.shift()();
  assert.equal(layouts, 3, "showing a gallery again must restore its rows at the new width");
  assert.equal(cards[0].style.aspectRatio, "0.75", "recreated covers must keep their measured ratio before the cached image loads again");
  assert.deepEqual(container.rows.flatMap((row) => row.children), cards);
  const renderedRow = container.firstElementChild;
  events.load();
  events.resize();
  frames.shift()();
  assert.equal(layouts, 3, "identical image and viewport events must leave the existing rows in place");
  assert.equal(container.firstElementChild, renderedRow);
  cards[0] = { ...cards[0], dataset: {}, style: {} };
  container.firstElementChild = cards[0];
  schedule();
  frames.shift()();
  assert.equal(layouts, 4, "fresh cards must be laid out even when their source images and ratios match");
  assert.equal(cards[0].style.aspectRatio, "0.75");
});
