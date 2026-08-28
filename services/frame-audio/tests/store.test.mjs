import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AudioStreamStore, StoreError } from "../dist/store.js";

const baseStream = {
  streamId: "audio-main",
  name: "Main Mix",
  bitrateKbps: 320,
  listenerLimit: 10,
  alwaysOn: true,
};

test("audio stream storage persists and reloads streams", async (context) => {
  const directory = await temporaryDirectory(context);
  const store = new AudioStreamStore(directory);
  await store.init();
  const created = await store.create(baseStream);

  const reloaded = new AudioStreamStore(directory);
  await reloaded.init();
  assert.deepEqual(reloaded.get(created.streamId), created);

  const document = JSON.parse(
    await readFile(path.join(directory, "state", "audio-streams.json"), "utf8"),
  );
  assert.equal(document.streams.length, 1);
});

test("audio stream IDs and normalized names remain unique", async (context) => {
  const directory = await temporaryDirectory(context);
  const store = new AudioStreamStore(directory);
  await store.init();
  await store.create(baseStream);

  await assert.rejects(
    store.create({ ...baseStream, name: "Secondary Mix" }),
    (error) => error instanceof StoreError && error.status === 409,
  );
  await assert.rejects(
    store.create({ ...baseStream, streamId: "audio-other", name: "  MAIN MIX  " }),
    (error) => error instanceof StoreError && error.status === 409,
  );
});

test("deleting and recreating a stream produces a fresh instance identity", async (context) => {
  const directory = await temporaryDirectory(context);
  const store = new AudioStreamStore(directory);
  await store.init();
  const original = await store.create(baseStream);
  await store.delete(baseStream.streamId);
  const recreated = await store.create(baseStream);

  assert.notEqual(recreated.instanceId, original.instanceId);
  assert.equal(recreated.generation, 0);
});

test("admin URL copying requires browser-confirmed clipboard success", async () => {
  const script = await readFile(new URL("../public/admin.js", import.meta.url), "utf8");
  assert.match(script, /navigator\.clipboard\?\.writeText/);
  assert.match(script, /clipboardData\.setData\("text\/plain", text\)/);
  assert.match(script, /document\.execCommand\("copy"\) && copied/);
  assert.match(script, /Automatic copy was blocked\. Press and hold this URL to copy it:/);
});

async function temporaryDirectory(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "frame-audio-store-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
