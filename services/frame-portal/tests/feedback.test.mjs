import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// Only the DOM operations used by the shared helper; no browser dependency for polling regression checks.
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.events = {};
    this.hidden = false;
    const classes = new Set();
    this.classList = {
      add: (...values) => values.forEach((value) => classes.add(value)),
      remove: (...values) => values.forEach((value) => classes.delete(value)),
      toggle: (value, present) => present ? classes.add(value) : classes.delete(value),
    };
  }
  get isConnected() { return this === this.root || Boolean(this.parentElement?.isConnected); }
  append(...elements) {
    for (const element of elements) {
      element.remove();
      element.parentElement = this;
      this.children.push(element);
    }
  }
  after(element) { this.parentElement.append(element); }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  addEventListener(name, fn) { this.events[name] = fn; }
  getBoundingClientRect() { return { right: 500, bottom: 90, top: 46, height: 120 }; }
  focus() { this.focused = true; }
  contains(target) { return target === this || this.children.some((child) => child.contains(target)); }
}

test("Local feedback deduplicates polls, preserves full details across rerenders, and reports recovery once", async () => {
  const source = await readFile(new URL("../public/frame-feedback.js", import.meta.url), "utf8");
  const body = new Element("body");
  body.root = body;
  const feature = new Element();
  const control = new Element("button");
  feature.append(control);
  body.append(feature);
  const targets = new Map([["#feature", feature], ["#control", control]]);
  const documentEvents = {};
  let reconcile;
  let timer;
  const window = { innerWidth: 390, innerHeight: 640, addEventListener() {} };
  const context = vm.createContext({
    window,
    document: {
      body,
      createElement: (tag) => new Element(tag),
      querySelector: (selector) => targets.get(selector),
      addEventListener: (event, fn) => { documentEvents[event] = fn; },
    },
    MutationObserver: class { constructor(callback) { reconcile = callback; } observe() {} },
    setTimeout: (fn) => { timer = fn; return 1; }, clearTimeout() {},
  });
  vm.runInContext(source, context);
  const feedback = window.FrameFeedback;
  const toast = body.children[1];
  assert.equal(toast.hidden, true, "A healthy initial page must have no notice");
  const message = `Device disconnected.\n${"<script>private URL & details</script> ".repeat(20)}`;
  const marker = feedback.issue("connection", { target: "#feature", message, summary: "Device disconnected" });
  assert.equal(marker.parentElement, feature);
  const [button, hint, bubble] = marker.children;
  assert.equal(bubble.children[2].textContent, message, "Full long error is retained as safe text");
  assert.equal(hint.textContent, "Device disconnected");
  assert.equal(button.attributes["aria-expanded"], "false");
  assert.equal(toast.textContent, "Device disconnected");
  timer();
  feedback.issue("connection", { target: "#feature", message, summary: "Device disconnected" });
  assert.equal(toast.hidden, true, "Repeated failed polls must not repeat the notice");
  assert.equal(feature.children.filter((child) => child === marker).length, 1);
  button.events.click();
  assert.equal(button.attributes["aria-expanded"], "true");
  assert.equal(bubble.hidden, false, "Tapping opens persistent details");
  documentEvents.keydown({ key: "Escape" });
  assert.equal(bubble.hidden, true);
  assert.equal(button.focused, true, "Closing details returns focus to the indicator");
  button.events.click();
  marker.remove();
  reconcile();
  assert.equal(marker.parentElement, feature, "Refresh must restore the feature indicator");
  assert.equal(bubble.hidden, false, "Refresh must keep an opened explanation available");
  targets.delete("#feature");
  reconcile();
  assert.equal(marker.isConnected, false, "Do not put a missing feature's problem elsewhere");
  assert.equal(button.attributes["aria-expanded"], "false");
  targets.set("#feature", feature);
  reconcile();
  assert.equal(marker.parentElement, feature);
  const controlMarker = feedback.issue("action", { target: "#control", message: "Save failed", tone: "error" });
  assert.equal(controlMarker.parentElement, feature, "Never nest buttons inside buttons");
  assert.equal(controlMarker.dataset.tone, "error");
  feedback.clearIssue("connection", { notify: "Reconnected" });
  assert.equal(marker.isConnected, false);
  assert.equal(controlMarker.isConnected, true, "Polling recovery cannot clear an action failure");
  assert.equal(toast.textContent, "Reconnected");
  timer();
  feedback.clearIssue("connection", { notify: "Reconnected" });
  assert.equal(toast.hidden, true, "Healthy polling after recovery must stay quiet");
});
