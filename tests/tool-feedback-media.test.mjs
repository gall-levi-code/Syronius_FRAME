import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function functions(file, ...names) {
  const source = await readFile(new URL(`../services/${file}`, import.meta.url), "utf8");
  return names.map((name) => {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\([^]*?^\\}`, "m"));
    assert.ok(match, `Missing ${name}`);
    return match[0];
  }).join("\n");
}

function feedback() {
  const issues = new Map();
  const notices = [];
  return {
    issues, notices,
    issue(key, options) { issues.set(key, options); },
    clearIssue(key, options = {}) { if (issues.delete(key) && options.notify) notices.push(options.notify); },
    notify(message) { notices.push(message); },
  };
}

test("media polling clears only its own failure and keeps action details available", async () => {
  const FrameFeedback = feedback();
  let failed = false;
  const context = vm.createContext({
    window: { FrameFeedback, clearTimeout() {}, setTimeout() {} },
    document: { hidden: false },
    elements: { status: {} }, dashboardConfig: {},
    dashboardRefreshTimer: 0, dashboardRefreshing: false, render() {}, AbortSignal,
    fetch: async () => { if (failed) throw new Error("connection lost"); return { ok: true, json: async () => ({}) }; },
  });
  vm.runInContext(await functions("frame-today/public/dashboard.js", "refresh"), context);
  await vm.runInContext("refresh()", context);
  assert.equal(FrameFeedback.notices.length, 0, "normal first load stays quiet");
  FrameFeedback.issue("stage-copy", { message: "Manual copy link" });
  failed = true;
  await vm.runInContext("refresh()", context);
  assert.equal(FrameFeedback.issues.get("stage-library").summary, "Photo library unavailable. Counts may be out of date.");
  failed = false;
  await vm.runInContext("refresh()", context);
  assert.deepEqual(FrameFeedback.notices, ["Photo library reconnected."]);
  assert.equal(FrameFeedback.issues.has("stage-copy"), true, "polling cannot erase unrelated copy instructions");

  const captureElements = Object.fromEntries([
    "sourcename", "sourceid", "relaystate", "targetbitrate", "inputbitrate", "listenercount", "socketstate",
  ].map((name) => [name, {}]));
  Object.assign(context, {
    elements: captureElements, streamId: "example", initializeSettings() {}, setRemotePublisherActive() {},
    isLocalCaptureActive: () => true, remotePublisherActive: false, logClientEvent() {},
    api: async () => ({ stream: { streamId: "example", bitrateKbps: 192, activeBitrateKbps: 192 } }),
  });
  FrameFeedback.issue("capture-connection", { message: "Publisher disconnected" });
  FrameFeedback.issue("capture-status", { message: "Status failed" });
  vm.runInContext(await functions("frame-audio/public/capture.js", "loadStatus", "showNotice"), context);
  await vm.runInContext("loadStatus()", context);
  assert.equal(FrameFeedback.issues.has("capture-status"), false);
  assert.equal(FrameFeedback.issues.has("capture-connection"), true, "healthy relay polling does not prove the publisher has recovered");
});

test("capture device feedback remains beside a visible control during capture", async () => {
  const FrameFeedback = feedback();
  let active = false;
  const context = vm.createContext({ window: { FrameFeedback }, isLocalCaptureActive: () => active });
  vm.runInContext(await functions("frame-audio/public/capture.js", "showNotice"), context);
  vm.runInContext('showNotice("Missing saved device", "warn", { key: "device", target: ".device-control", summary: "Device unavailable" })', context);
  assert.equal(FrameFeedback.issues.get("device").target, ".device-control");
  active = true;
  vm.runInContext('showNotice("Missing saved device", "warn", { key: "device", target: ".device-control", summary: "Device unavailable" })', context);
  assert.equal(FrameFeedback.issues.get("device").target, ".capture-actions");
});

test("audio form errors keep their details beside the modal actions", async () => {
  const FrameFeedback = feedback();
  const context = vm.createContext({ window: { FrameFeedback } });
  vm.runInContext(await functions("frame-audio/public/admin.js", "showDialogNotice"), context);
  vm.runInContext('showDialogNotice("That stream ID is already in use.")', context);
  assert.equal(FrameFeedback.issues.get("audio-form").target, ".dialog-actions");
  assert.equal(FrameFeedback.issues.get("audio-form").message, "That stream ID is already in use.");
  const html = await readFile(new URL("../services/frame-audio/public/admin.html", import.meta.url), "utf8");
  assert.match(html, /<div hidden id="dialog-notice"/);
});

test("listener retry keeps its error until playback succeeds", async () => {
  const FrameFeedback = feedback();
  const play = Promise.withResolvers();
  const context = vm.createContext({
    window: { FrameFeedback }, playbackError: { classList: { add() {} } }, updatePlaybackButton() {},
    setPlaybackState() {}, ensureVolumePipeline: async () => {}, snapToLiveTail() {}, attachNativeSource() {},
    player: { play: () => play.promise }, hls: null, playlistUrl: "https://example.test/audio.m3u8",
    wantsPlayback: false, userPaused: true, startPending: false, pendingLiveSnap: false,
  });
  vm.runInContext(await functions("frame-audio/public/listen.js", "resumePlayback", "showPlaybackError", "clearPlaybackError"), context);
  vm.runInContext('showPlaybackError("Playback failed")', context);
  const pending = vm.runInContext("resumePlayback()", context);
  await Promise.resolve();
  assert.equal(FrameFeedback.issues.has("listener-playback"), true, "a retry alone does not resolve the failure");
  play.resolve();
  await pending;
  vm.runInContext("clearPlaybackError()", context);
  assert.equal(FrameFeedback.issues.has("listener-playback"), false);
});

test("remote connection reports a transition and stays quiet on ordinary connects", async () => {
  const FrameFeedback = feedback();
  const context = vm.createContext({
    window: { FrameFeedback }, elements: { connection: { setAttribute() {} } },
  });
  vm.runInContext(await functions("frame-today/public/remote.js", "setConnection"), context);
  vm.runInContext('setConnection("Connected", "connected")', context);
  assert.equal(FrameFeedback.notices.length, 0);
  vm.runInContext('setConnection("Reconnecting", "error")', context);
  assert.equal(FrameFeedback.issues.get("stage-connection").target, ".remote-context");
  vm.runInContext('setConnection("Connected", "connected")', context);
  assert.deepEqual(FrameFeedback.notices, ["Photo Stage remote reconnected."]);
  vm.runInContext('setConnection("Connected", "connected")', context);
  assert.equal(FrameFeedback.notices.length, 1);
});
