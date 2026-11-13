import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const functions = ["openLinks", "openStatsOutputs", "statsUrl"]
  .map((name) => source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))[0])
  .join("\n");

test("Stream Management distinguishes unknown uptime from a reported zero", () => {
  const durationSource = source.match(/function formatDuration\([^\n]+/)[0];
  const formatDuration = vm.runInNewContext(`${durationSource}; formatDuration`);
  for (const value of [null, undefined, NaN, Infinity]) assert.equal(formatDuration(value), "--");
  assert.equal(formatDuration(0), "0h 0m");
  assert.equal(formatDuration(125), "0h 2m");
  assert.equal(formatDuration(3661), "1h 1m");
});

function setup(statsOutputs) {
  const nodes = new Map();
  const clicked = [];
  let buttons = [];
  const context = vm.createContext({
    state: {
      streams: [{ id: "play_public", publisher: "live_encoder_key", player: "play_decoder_key", description: "Camera" }],
      config: {
        relay_host: "relay.example", ports: { srtla: 5000, sender: 5001, player: 5002 },
        stats_base_url: "https://frame.example/stats", stats_outputs: statsOutputs,
      },
    },
    document: {
      querySelector(selector) {
        if (!nodes.has(selector)) nodes.set(selector, { innerHTML: "", textContent: "" });
        return nodes.get(selector);
      },
      querySelectorAll() {
        const html = [...nodes.values()].map((node) => node.innerHTML).join("");
        buttons = [...html.matchAll(/data-copy="([^"]+)"/g)].map((match) => ({
          dataset: { copy: match[1] },
          addEventListener(event, listener) { this.click = listener; },
        }));
        return buttons;
      },
    },
    linksDialog: { showModal() {} },
    statsOutputDialog: { showModal() {} },
    OPEN_ICON: "", COPY_ICON: "",
    escapeHtml: (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
    escapeAttr: (value) => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;"),
    copyWithConfirmation: (button) => clicked.push(button.dataset.copy),
  });
  vm.runInContext(functions, context);
  return { context, nodes, clicked, buttons: () => buttons };
}

function values(html) {
  return [...html.matchAll(/value="([^"]*)"/g)].map((match) => match[1]);
}

test("stats URLs use the bare compatibility default and keep explicit formats available", () => {
  const { context } = setup();
  assert.equal(context.statsUrl("play_public"), "https://frame.example/stats/play_public");
  assert.equal(context.statsUrl("play_public", "frame"), "https://frame.example/stats/play_public?output=frame");
  assert.equal(context.statsUrl("play_public", "bbox_receiver"), "https://frame.example/stats/play_public?output=bbox_receiver");
  assert.equal(context.statsUrl("custom feed/1", "frame"), "https://frame.example/stats/custom%20feed%2F1?output=frame");
});

test("Links separates the stats publisher ID from encoder and player connection keys", () => {
  const ui = setup();
  ui.context.openLinks("play_public");
  const html = ui.nodes.get("#links-list").innerHTML;
  assert.deepEqual(values(html), [
    "srtla://relay.example:5000?streamid=live_encoder_key",
    "srt://relay.example:5001?streamid=live_encoder_key",
    "srt://localhost:5002?streamid=play_decoder_key",
    "https://frame.example/stats/play_public",
    "live/stream/play_public",
    "https://frame.example/stats/play_public?output=frame",
  ]);
  assert.match(html, /SLS-compatible statistics/);
  assert.match(html, /Stats publisher ID/);
  assert.match(html, /not your encoder's publisher key/);
  ui.buttons().find((button) => button.dataset.copy === "live/stream/play_public").click();
  assert.deepEqual(ui.clicked, ["live/stream/play_public"]);
});

test("Stats outputs links match the advertised default and offer a copy-only publisher ID", () => {
  const ui = setup([
    { id: "frame", label: "FRAME statistics", query: "output=frame" },
    { id: "bbox_receiver", label: "SLS-compatible statistics", query: "" },
  ]);
  ui.context.openStatsOutputs("play_public");
  const html = ui.nodes.get("#stats-output-list").innerHTML;
  assert.deepEqual(values(html), [
    "https://frame.example/stats/play_public?output=frame",
    "https://frame.example/stats/play_public",
    "live/stream/play_public",
  ]);
  assert.equal(ui.nodes.get("#stats-output-title").textContent, "Stats outputs · Camera");
  assert.equal([...html.matchAll(/<a /g)].length, 2);
  assert.doesNotMatch(html, /href="live\/stream/);
  ui.buttons().find((button) => button.dataset.copy === "live/stream/play_public").click();
  assert.deepEqual(ui.clicked, ["live/stream/play_public"]);
});

test("Stats outputs fallback still provides both formats and the stats publisher ID", () => {
  const ui = setup();
  ui.context.openStatsOutputs("play_public");
  assert.deepEqual(values(ui.nodes.get("#stats-output-list").innerHTML), [
    "https://frame.example/stats/play_public",
    "https://frame.example/stats/play_public?output=bbox_receiver",
    "https://frame.example/stats/play_public?output=belabox",
    "https://frame.example/stats/play_public?output=frame",
    "live/stream/play_public",
  ]);
});
