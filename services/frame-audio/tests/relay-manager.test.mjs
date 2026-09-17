import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { PUBLISHER_MAX_MESSAGE_BYTES, RelayManager } from "../dist/relayManager.js";
import { AudioStreamStore } from "../dist/store.js";

const streamId = "audio-main";
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("startup and drain backpressure preserve every compressed byte in order", async (t) => {
  const { relays, encoders } = await fixture(t);
  const socket = new CaptureSocket();
  const attaching = relays.attachPublisher(streamId, socket);
  assert.equal(socket.isPaused, true);
  socket.emit("message", Buffer.from("head"), true);
  socket.emit("message", [Buffer.from("bo"), Buffer.from("dy")], true);
  await attaching;
  const encoder = encoders[0];
  assert.deepEqual(encoder.chunks.map(String), ["head"]);
  assert.equal(socket.isPaused, true);
  // ws may still deliver frames decoded before its socket was paused.
  socket.emit("message", new Uint8Array([116, 97, 105, 108]).buffer, true);
  socket.emit("message", Buffer.from("ignored text"), false);
  encoder.release();
  await settle();
  assert.deepEqual(encoder.chunks.map(String), ["head", "body"]);
  assert.equal(socket.isPaused, true);
  encoder.release();
  await settle();
  assert.deepEqual(encoder.chunks.map(String), ["head", "body", "tail"]);
  encoder.release();
  await settle();
  assert.equal(socket.isPaused, false);
  assert.equal(encoder.stdin.writableLength, 0);
});

test("startup and stalled stdin share a hard byte limit, including already-decoded messages", async (t) => {
  for (const duringStartup of [true, false]) {
    await t.test(duringStartup ? "startup" : "stdin", async (t) => {
      const { relays, encoders, store } = await fixture(t);
      const socket = new CaptureSocket();
      const attaching = relays.attachPublisher(streamId, socket);
      if (!duringStartup) await attaching;
      socket.emit("message", Buffer.alloc(PUBLISHER_MAX_MESSAGE_BYTES), true);
      socket.emit("message", Buffer.alloc(PUBLISHER_MAX_MESSAGE_BYTES), true);
      assert.equal(socket.closeCode, undefined, "the two buffers together fit the 4 MiB limit");
      socket.emit("message", Buffer.from([1]), true);
      assert.equal(socket.closeCode, 1013);
      assert.equal(socket.isPaused, false);
      assert.equal(socket.listenerCount("message"), 0);
      await attaching;
      assert.equal((await relays.status(store.get(streamId))).publisherActive, false);
      assert.equal(encoders.length, duringStartup ? 0 : 1);
      if (!duringStartup) assert.equal(encoders[0].stdin.listenerCount("drain"), 0);
    });
  }
});

test("publisher message size and pending message count are bounded", async (t) => {
  for (const oversized of [true, false]) {
    await t.test(oversized ? "message bytes" : "message count", async (t) => {
      const { relays } = await fixture(t);
      const socket = new CaptureSocket();
      const attaching = relays.attachPublisher(streamId, socket);
      if (oversized) socket.emit("message", Buffer.alloc(PUBLISHER_MAX_MESSAGE_BYTES + 1), true);
      else for (let index = 0; index < 129; index++) socket.emit("message", Buffer.from([1]), true);
      assert.equal(socket.closeCode, oversized ? 1009 : 1013);
      await attaching;
    });
  }
});

test("a stalled encoder releases the publisher slot and its old drain cannot affect a replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { relays, encoders, store } = await fixture(t);
  const socket = new CaptureSocket();
  await relays.attachPublisher(streamId, socket);
  socket.emit("message", Buffer.from("head"), true);
  assert.equal(socket.isPaused, true);
  t.mock.timers.tick(10_000);
  assert.equal(socket.closeCode, 1013);
  assert.equal((await relays.status(store.get(streamId))).publisherActive, false);
  assert.equal(encoders[0].stdin.listenerCount("drain"), 0);

  const replacement = new CaptureSocket();
  await relays.attachPublisher(streamId, replacement);
  replacement.emit("message", Buffer.from("next"), true);
  encoders[0].release();
  encoders[0].stdin.emit("error", new Error("late EPIPE"));
  await settle();
  assert.equal(replacement.isPaused, true);
  assert.equal(replacement.closeCode, undefined);
  encoders[1].release();
  await settle();
  assert.equal(replacement.isPaused, false);
  t.mock.timers.tick(10_000);
  assert.equal(replacement.closeCode, undefined, "drain must cancel the stall deadline");
});

test("a timed-out startup cannot spawn over a later publisher", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { relays, encoders, store } = await fixture(t);
  const nextGeneration = store.nextGeneration.bind(store);
  let releaseStartup;
  store.nextGeneration = async (id) => {
    await new Promise((resolve) => { releaseStartup = resolve; });
    return nextGeneration(id);
  };
  const oldSocket = new CaptureSocket();
  const oldAttach = relays.attachPublisher(streamId, oldSocket);
  t.mock.timers.tick(10_000);
  assert.equal(oldSocket.closeCode, 1013);
  store.nextGeneration = nextGeneration;
  const currentSocket = new CaptureSocket();
  await relays.attachPublisher(streamId, currentSocket);
  releaseStartup();
  await oldAttach;
  assert.equal(encoders.length, 1);
  assert.equal(currentSocket.closeCode, undefined);
  currentSocket.emit("message", Buffer.from("good"), true);
  assert.deepEqual(encoders[0].chunks.map(String), ["good"]);
});

test("disconnect, transport failure, encoder failure, deletion and shutdown clean up a paused publisher", async (t) => {
  for (const action of ["close", "socket-error", "stdin-error", "spawn-error", "exit", "delete", "shutdown"]) {
    await t.test(action, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { relays, encoders } = await fixture(t);
      const socket = new CaptureSocket();
      await relays.attachPublisher(streamId, socket);
      const encoder = encoders[0];
      socket.emit("message", Buffer.from("head"), true);
      if (action === "close") socket.close(1000, "Capture stopped");
      else if (action === "socket-error") socket.emit("error", new Error("Connection failed"));
      else if (action === "stdin-error") encoder.stdin.emit("error", new Error("EPIPE"));
      else if (action === "spawn-error") encoder.emit("error", new Error("ENOENT"));
      else if (action === "exit") encoder.emit("exit", 1, null);
      else if (action === "delete") await relays.deleteStream(streamId);
      else await relays.close();
      await settle();
      assert.equal(socket.isPaused, false);
      assert.equal(socket.listenerCount("message"), 0);
      assert.equal(socket.listenerCount("error"), 0);
      assert.equal(socket.listenerCount("close"), 0);
      assert.equal(encoder.stdin.listenerCount("drain"), 0);
      const closes = socket.closes;
      encoder.release();
      t.mock.timers.tick(20_000);
      await settle();
      assert.equal(socket.closes, closes, "cleanup must cancel the stall deadline");
    });
  }
});

test("real FFmpeg converts a complete WebM capture into an HLS playlist", async (t) => {
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  if (spawnSync(ffmpegPath, ["-version"], { timeout: 3000, windowsHide: true }).status !== 0) {
    t.skip("FFmpeg is not installed on this test host");
    return;
  }
  const sample = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
    "-t", "10", "-c:a", "libopus", "-f", "webm", "pipe:1",
  ], { timeout: 10_000, maxBuffer: PUBLISHER_MAX_MESSAGE_BYTES, windowsHide: true });
  assert.equal(sample.status, 0, sample.stderr?.toString());
  const { relays, store, directory } = await fixture(t, { real: true, ffmpegPath });
  const socket = new CaptureSocket();
  await relays.attachPublisher(streamId, socket);
  socket.emit("message", sample.stdout, true);
  const deadline = Date.now() + 8000;
  let status;
  do {
    status = await relays.status(store.get(streamId));
    if (status.playlistReady) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(status.playlistReady, true, status.lastError || "FFmpeg did not produce a playlist");
  const playlist = await readFile(path.join(directory, "hls", streamId, String(status.generation), "index.m3u8"), "utf8");
  assert.match(playlist, /#EXTM3U/);
  assert.match(playlist, /segment-\d+\.ts/);
  assert.equal(socket.closeCode, undefined);
});

async function fixture(t, { real = false, ffmpegPath = "ffmpeg" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "frame-audio-relay-"));
  const store = new AudioStreamStore(directory);
  await store.init();
  await store.create({ streamId, name: "Main Mix", bitrateKbps: 128, listenerLimit: 10, alwaysOn: false });
  const encoders = [];
  const relays = new RelayManager({ dataRoot: directory, ffmpegPath, port: 3734, publicBaseUrl: "http://localhost", captureBaseUrl: "http://localhost" }, store, real ? undefined : () => {
    const encoder = new Encoder();
    encoders.push(encoder);
    return encoder;
  });
  t.after(async () => {
    await relays.deleteStream(streamId);
    await relays.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store, relays, encoders };
}

class CaptureSocket extends EventEmitter {
  readyState = 1;
  isPaused = false;
  closes = 0;
  pause() { this.isPaused = true; }
  resume() { this.isPaused = false; }
  close(code, reason) {
    this.closes++;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close");
  }
}

class Encoder extends EventEmitter {
  chunks = [];
  callbacks = [];
  exitCode = null;
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new Writable({
    highWaterMark: 4,
    write: (chunk, _encoding, callback) => {
      this.chunks.push(Buffer.from(chunk));
      this.callbacks.push(callback);
    },
  });
  release() { this.callbacks.shift()?.(); }
  kill(signal) {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}
