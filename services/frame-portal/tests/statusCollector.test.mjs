import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { StatusCollector } from "../dist/statusCollector.js";

test("Portal collects FRAME activity without polling the independent Discord bridge", async (t) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "frame-portal-status-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const state = path.join(dataRoot, "state");
  await mkdir(state);
  const stackConfigPath = path.join(state, "stack-config.json");
  await writeFile(stackConfigPath, JSON.stringify({ mode: "LAN", capabilities: {}, routes: {}, public_route_prefixes: [] }));
  await writeFile(path.join(state, "latest.json"), JSON.stringify({ latest_photo_at: "2026-09-22T12:00:00Z", latest_base: "latest-photo" }));
  const priorFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => { requests += 1; throw new Error("Unexpected telemetry request"); };
  t.after(() => { global.fetch = priorFetch; });
  const collector = new StatusCollector({ dataRoot, stackConfigPath, statusCacheMs: 0,
    diskWarnPercent: 100, diskErrorPercent: 101, diskMinimumFreeGb: 0,
    audioBridgeStatusUrl: "https://retired.example.test", audioBridgeStatusToken: "legacy-token" }, {
    async listFrameServices() { return [{ name: "frame-audio-bridge", status: "running", health: "healthy", uptime_seconds: 2 }]; },
  });
  const status = await collector.collect();
  assert.equal(requests, 0);
  assert.equal(Object.hasOwn(status, "discord_audio_bridges"), false);
  assert.deepEqual(status.last_photo, { at: "2026-09-22T12:00:00Z", base: "latest-photo" });
  assert.deepEqual(status.audio_streams, []);
  assert.deepEqual(status.alerts, []);
});

test("Portal activity renders photos and Audio Monitor without a bridge display", async () => {
  const source = await readFile(new URL("../public/portal.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="discord-bridges"/);
  const elements = { lastIngest: {}, lastPhoto: {}, audioStreams: {} };
  const context = vm.createContext({ elements, formatRelative: () => "just now" });
  vm.runInContext(source.slice(source.indexOf("function renderActivity("), source.indexOf("async function restartService(")), context);
  context.renderActivity({ last_photo: { base: "latest-photo", at: "2026-09-22T12:00:00Z" }, audio_streams: [
    { status: "live", listener_count: 3 }, { status: "live", listener_count: 2 }, { status: "idle", listener_count: 4 },
  ] });
  assert.equal(elements.lastPhoto.textContent, "latest-photo - just now");
  assert.equal(elements.audioStreams.textContent, "2 live - 5 listeners");
  context.renderActivity({});
  assert.equal(elements.lastIngest.textContent, "No ingest reported");
  assert.equal(elements.lastPhoto.textContent, "No photo reported");
  assert.equal(elements.audioStreams.textContent, "None active");
});
