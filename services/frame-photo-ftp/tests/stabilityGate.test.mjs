import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StabilityGate } from "../dist/stabilityGate.js";

test("moves a file only after its size and mtime remain stable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-ftp-"));
  const inbox = path.join(root, "inbox");
  const staging = path.join(root, "staging");
  await mkdir(inbox, { recursive: true });
  const gate = new StabilityGate(inbox, staging, 3000);
  await gate.init();
  const source = path.join(inbox, "Camera Photo.JPG");
  await writeFile(source, "part");

  await gate.runOnce(0);
  await gate.runOnce(2000);
  assert.deepEqual(await readdir(staging), []);
  await appendFile(source, "more");
  await gate.runOnce(2500);
  await gate.runOnce(5000);
  assert.deepEqual(await readdir(staging), []);
  await gate.runOnce(5500);
  assert.deepEqual(await readdir(staging), ["Camera_Photo.jpg"]);
});

test("ignores explicit uploading files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-ftp-"));
  const gate = new StabilityGate(path.join(root, "inbox"), path.join(root, "staging"), 3000);
  await gate.init();
  await writeFile(path.join(root, "inbox", "photo.jpg.uploading"), "partial");
  await gate.runOnce(0);
  await gate.runOnce(5000);
  assert.deepEqual(await readdir(path.join(root, "staging")), []);
});
