import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
  let progress = gate.progressSnapshot(0);
  assert.equal(progress.transfers.length, 1);
  assert.equal(progress.transfers[0].adapter, "ftp");
  assert.equal(progress.transfers[0].source_adapter, "ftp");
  assert.equal(progress.transfers[0].phase, "receiving");
  assert.equal(progress.transfers[0].filename, "Camera Photo.JPG");
  assert.equal(progress.transfers[0].bytes_received, 4);
  assert.equal(progress.transfers[0].bytes_total, null);
  const journeyId = progress.transfers[0].journey_id;
  assert.match(journeyId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await gate.runOnce(2000);
  assert.equal(gate.progressSnapshot(2000).transfers[0].journey_id, journeyId);
  assert.deepEqual(await readdir(staging), []);
  await appendFile(source, "more");
  await gate.runOnce(2500);
  progress = gate.progressSnapshot(2500);
  assert.equal(progress.transfers[0].journey_id, journeyId);
  assert.equal(progress.transfers[0].phase, "receiving");
  assert.equal(progress.transfers[0].bytes_received, 8);
  assert.equal(progress.transfers[0].speed_bps, 8);
  await gate.runOnce(5000);
  assert.deepEqual(await readdir(staging), []);
  await gate.runOnce(5500);
  assert.deepEqual(await readdir(staging), [`${journeyId}.frame-photo`]);
  assert.equal(await readFile(path.join(staging, `${journeyId}.frame-photo`, "source"), "utf8"), "partmore");
  const journey = JSON.parse(await readFile(path.join(staging, `${journeyId}.frame-photo`, "journey.json"), "utf8"));
  assert.equal(journey.journey_id, journeyId);
  assert.equal(journey.original_name, "Camera Photo.JPG");
  assert.equal(journey.content_sha256, createHash("sha256").update("partmore").digest("hex"));
  assert.deepEqual(journey.ingest, { adapter: "ftp", transfer_id: progress.transfers[0].transfer_id, bytes_received: 8 });
  progress = gate.progressSnapshot(5500);
  assert.equal(progress.transfers[0].phase, "queued");
  assert.equal(progress.transfers[0].bytes_received, 8);
  assert.equal(progress.transfers[0].status_text, "Staged for FRAME processing");

  await writeFile(source, "second");
  await gate.runOnce(6000);
  const secondJourneyId = gate.progressSnapshot(6000).transfers.find((item) => item.phase === "receiving")?.journey_id;
  assert.match(secondJourneyId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(secondJourneyId, journeyId);
  await gate.runOnce(9000);
  assert.deepEqual((await readdir(staging)).sort(), [`${journeyId}.frame-photo`, `${secondJourneyId}.frame-photo`].sort());
});

test("preserves an enveloped Belabox journey while exposing the original filename", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-ftp-"));
  const inbox = path.join(root, "inbox");
  const staging = path.join(root, "staging");
  const gate = new StabilityGate(inbox, staging, 1000);
  await gate.init();
  await writeFile(path.join(inbox, "FRAMEJ1_journey-test-1__Camera Photo.JPG"), "photo");
  await gate.runOnce(0);
  let progress = gate.progressSnapshot(0);
  assert.equal(progress.transfers[0].journey_id, "journey-test-1");
  assert.equal(progress.transfers[0].source_adapter, "belabox_agent");
  assert.equal(progress.transfers[0].filename, "Camera Photo.JPG");
  await gate.runOnce(1000);
  progress = gate.progressSnapshot(1000);
  assert.equal(progress.transfers[0].phase, "queued");
  assert.deepEqual(await readdir(staging), ["journey-test-1.frame-photo"]);
  assert.equal(JSON.parse(await readFile(path.join(staging, "journey-test-1.frame-photo", "journey.json"), "utf8")).ingest.adapter, "belabox_agent");
  await writeFile(path.join(inbox, "FRAMEJ1_journey-test-1__Camera Photo.JPG"), "photo");
  await gate.runOnce(2000);
  await gate.runOnce(3000);
  assert.deepEqual(await readdir(staging), ["journey-test-1.frame-photo"]);

  await writeFile(path.join(inbox, "FRAMEJ1_journey-test-1__Camera Photo.JPG"), "other");
  await writeFile(path.join(inbox, "Another Camera Photo.JPG"), "new photo");
  await gate.runOnce(4000);
  await gate.runOnce(5000);
  assert.match(gate.status.last_error, /conflicts with an existing staged photo/);
  assert.equal(await readFile(path.join(staging, "journey-test-1.frame-photo", "source"), "utf8"), "photo");
  assert.equal(await readFile(path.join(inbox, "FRAMEJ1_journey-test-1__Camera Photo.JPG"), "utf8"), "other");
  assert.equal((await readdir(staging)).length, 2, "a conflicting journey must not block another photo");
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

test("recovers an FTP envelope interrupted after moving its source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-ftp-restart-"));
  const inbox = path.join(root, "inbox");
  const staging = path.join(root, "staging");
  const temporaryName = ".journey-restart.11111111-1111-1111-1111-111111111111.uploading";
  const metadata = {
    schema_version: 1,
    journey_id: "journey-restart",
    original_name: "restart.jpg",
    received_at: "2026-07-21T12:00:00.000Z",
    ingest: { adapter: "ftp", transfer_id: "restart-transfer", bytes_received: 9 },
  };
  const writeInterruptedEnvelope = async (name) => {
    const temporary = path.join(staging, name);
    await mkdir(temporary, { recursive: true });
    await writeFile(path.join(temporary, "journey.json"), `${JSON.stringify(metadata)}\n`);
    await writeFile(path.join(temporary, "source"), "recovered");
  };

  await writeInterruptedEnvelope(temporaryName);
  const malformed = path.join(staging, ".journey-broken.33333333-3333-3333-3333-333333333333.uploading");
  await mkdir(malformed, { recursive: true });
  await writeFile(path.join(malformed, "source"), "preserve me");
  await writeFile(path.join(malformed, "journey.json"), "not-json");
  const gate = new StabilityGate(inbox, staging, 1000);
  await gate.init();
  const target = path.join(staging, "journey-restart.frame-photo");
  assert.deepEqual((await readdir(staging)).sort(), [path.basename(malformed), "journey-restart.frame-photo"]);
  assert.match(gate.status.last_error, /journey-broken/);
  assert.equal(await readFile(path.join(target, "source"), "utf8"), "recovered");
  assert.equal(JSON.parse(await readFile(path.join(target, "journey.json"), "utf8")).content_sha256, createHash("sha256").update("recovered").digest("hex"));

  await writeInterruptedEnvelope(".journey-restart.22222222-2222-2222-2222-222222222222.uploading");
  await gate.init();
  assert.deepEqual((await readdir(staging)).sort(), [path.basename(malformed), "journey-restart.frame-photo"]);
  assert.equal(await readFile(path.join(target, "source"), "utf8"), "recovered");
});
