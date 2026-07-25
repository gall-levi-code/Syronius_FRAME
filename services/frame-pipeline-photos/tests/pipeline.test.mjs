import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { atomicWrite } from "../dist/fsUtils.js";
import { PhotoPipeline } from "../dist/pipeline.js";

test("atomic manifest publication never exposes a temporary name containing .ready", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const observed = [];
  const watcher = watch(root, (_event, filename) => observed.push(String(filename)));

  await atomicWrite(path.join(root, "photo.ready"), "complete\n");
  await new Promise((resolve) => setTimeout(resolve, 25));
  watcher.close();

  assert.ok(observed.includes("photo.ready"));
  assert.equal(observed.some((filename) => filename !== "photo.ready" && filename.includes(".ready")), false);
  assert.deepEqual(await readdir(root), ["photo.ready"]);
});

test("publishes a valid staged image with ready last and latest state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await sharp({ create: { width: 320, height: 640, channels: 3, background: "#2cb4fb" } })
    .png()
    .toFile(path.join(root, "staging", "Phone Photo.png"));

  await pipeline.processOnce();

  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const published = await readdir(path.join(root, "galleries", latest.date_folder));
  for (const extension of ["jpg", "json", "txt", "orientation", "ready"]) {
    assert.ok(published.includes(`${latest.latest_base}.${extension}`), `${extension} was not published`);
  }
  assert.equal(await readFile(path.join(root, "galleries", latest.date_folder, `${latest.latest_base}.orientation`), "utf8"), "1\n");
  assert.equal(latest.count_today, 1);
  assert.equal((await readdir(path.join(root, "archive", latest.date_folder))).length, 1);
  assert.equal((await readdir(root)).includes("today"), false);
  const manifest = (await readFile(path.join(root, "galleries", latest.date_folder, `${latest.latest_base}.ready`), "utf8")).trimEnd().split("\n");
  assert.equal(manifest.length, 3);
  assert.equal(path.basename(manifest[0], ".jpg"), latest.latest_base);
  assert.equal(path.basename(manifest[1], ".txt"), latest.latest_base);
  await readFile(manifest[0]);
  await readFile(manifest[1]);
  const sidecar = JSON.parse(await readFile(path.join(root, "galleries", latest.date_folder, `${latest.latest_base}.json`), "utf8"));
  const sidecarSchema = JSON.parse(await readFile(path.resolve("../../docs/schemas/photo-sidecar.schema.json"), "utf8"));
  assert.deepEqual(Object.keys(sidecar).filter((field) => !(field in sidecarSchema.properties)), []);
  assert.deepEqual(sidecarSchema.required.filter((field) => !(field in sidecar)), []);
  assert.match(sidecar.journey_id, /^[A-Za-z0-9_-]{8,96}$/);
  const receipt = JSON.parse(await readFile(path.join(root, "state", "photo-journeys", `${sidecar.journey_id}.json`), "utf8"));
  assert.equal(receipt.state, "published");
  assert.match(receipt.content_sha256, /^[a-f0-9]{64}$/);

  await pipeline.processOnce();
  assert.equal((await readdir(path.join(root, "galleries", latest.date_folder))).filter((name) => name.endsWith(".ready")).length, 1);
});

test("publishes one real HEIC or HEIF fixture through the bundled decoder", async (context) => {
  const fixture = process.env.FRAME_HEIC_FIXTURE;
  if (!fixture) return context.skip("set FRAME_HEIC_FIXTURE to an actual HEIC or HEIF file");
  const extension = path.extname(fixture).toLowerCase();
  assert.match(extension, /^\.hei[cf]$/, "FRAME_HEIC_FIXTURE must have a .heic or .heif extension");
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await writeFile(path.join(root, "staging", `Phone Photo${extension}`), await readFile(fixture));

  await pipeline.processOnce();

  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const output = path.join(root, "galleries", latest.date_folder, `${latest.latest_base}.jpg`);
  assert.equal((await sharp(output).metadata()).format, "jpeg");
});

test("extracts camera EXIF into the reusable camera information sidecar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await sharp({ create: { width: 320, height: 180, channels: 3, background: "#2cb4fb" } })
    .jpeg()
    .withExif({
      IFD0: { Make: "FRAME", Model: "Test Camera" },
      IFD2: {
        ISOSpeedRatings: "200",
        FNumber: "2.8",
        ExposureTime: "0.008",
        FocalLength: "35",
        LensModel: "Test Lens\0\0",
        DateTimeOriginal: "2026:07:12 20:00:30",
      },
    })
    .toFile(path.join(root, "staging", "Camera Photo.jpg"));

  await pipeline.processOnce();

  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const gallery = path.join(root, "galleries", latest.date_folder);
  const cameraText = await readFile(path.join(gallery, `${latest.latest_base}.txt`), "utf8");
  const sidecar = JSON.parse(await readFile(path.join(gallery, `${latest.latest_base}.json`), "utf8"));
  assert.equal(cameraText, "Shot on Test Camera with the Test Lens @ 35mm\n1/125s • f/2.8 • ISO 200\n");
  assert.equal(JSON.stringify(sidecar.exif).includes("\\u0000"), false);
  assert.equal(sidecar.exif.Photo.DateTimeOriginal, "2026-07-12T20:00:30.000Z");
  assert.ok(Object.keys(sidecar.exif).length > 0);
});

test("quarantines non-images without updating latest state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await writeFile(path.join(root, "staging", "not-a-photo.txt"), "hello");

  await pipeline.processOnce();

  const quarantined = await readdir(path.join(root, "quarantine"));
  const errorName = quarantined.find((name) => name.endsWith(".error.json"));
  assert.ok(errorName);
  const descriptor = JSON.parse(await readFile(path.join(root, "quarantine", errorName), "utf8"));
  assert.equal(descriptor.reason_code, "PPL-01");
  assert.match(descriptor.journey_id, /^[A-Za-z0-9_-]{8,96}$/);
  assert.equal(JSON.parse(await readFile(path.join(root, "state", "photo-journeys", `${descriptor.journey_id}.json`), "utf8")).state, "failed");
  await assert.rejects(readFile(path.join(root, "state", "latest.json")));
});

test("recovers a ready publication without publishing the claimed source twice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const originalName = "Recovered Photo.png";
  const claim = path.join(root, "processing", `job-recovery--${Buffer.from(originalName).toString("base64url")}`);
  const journeyId = "journey-recovery";
  const dateFolder = currentDateFolder();
  const base = "Recovered_Photo_2026-06-13_01_02_03";
  const gallery = path.join(root, "galleries", dateFolder);
  await Promise.all([mkdir(claim, { recursive: true }), mkdir(gallery, { recursive: true })]);
  await sharp({ create: { width: 100, height: 50, channels: 3, background: "#2cb4fb" } }).png().toFile(path.join(claim, "source"));
  const source = await readFile(path.join(claim, "source"));
  const metadata = journey(journeyId, originalName, source);
  await writeFile(path.join(claim, "journey.json"), JSON.stringify(metadata));
  await writeFile(path.join(claim, "publication.json"), JSON.stringify({ dateFolder, base, journeyId }));
  for (const extension of ["jpg", "json", "txt", "orientation", "ready"]) {
    await writeFile(path.join(gallery, `${base}.${extension}`), extension);
  }
  await writeFile(path.join(root, "state", "photo-journeys", `${journeyId}.json`), JSON.stringify({
    ...metadata,
    state: "published",
    updated_at: new Date().toISOString(),
    job_id: "job-recovery",
    date_folder: dateFolder,
    base,
  }));

  await pipeline.processOnce();

  assert.deepEqual((await readdir(gallery)).filter((name) => name.endsWith(".ready")), [`${base}.ready`]);
  assert.equal(JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8")).latest_base, base);
  assert.equal((await readdir(path.join(root, "archive", dateFolder))).length, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, "state", "photo-journeys", `${journeyId}.json`), "utf8")).state, "published");
});

test("publishes one photo for duplicate journey envelopes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const journeyId = "journey-duplicate";
  const source = await testJpeg("#2cb4fb");
  await stageEnvelope(root, journeyId, "Duplicate Photo.jpg", source);
  await pipeline.processOnce();
  const receiptPath = path.join(root, "state", "photo-journeys", `${journeyId}.json`);
  const publishedReceipt = await readFile(receiptPath, "utf8");
  await stageEnvelope(root, journeyId, "Duplicate Photo.jpg", source);
  await pipeline.processOnce();
  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  assert.equal((await readdir(path.join(root, "galleries", latest.date_folder))).filter((name) => name.endsWith(".ready")).length, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, "galleries", latest.date_folder, `${latest.latest_base}.json`), "utf8")).journey_id, journeyId);
  assert.equal(await readFile(receiptPath, "utf8"), publishedReceipt);
  const receipt = (await pipeline.journeyProgress()).find((item) => item.journey_id === journeyId);
  assert.equal(receipt.state, "published");
  assert.equal(receipt.content_sha256, sha256(source));
  assert.equal((await readdir(path.join(root, "archive", latest.date_folder))).length, 1);
  assert.deepEqual(await readdir(path.join(root, "quarantine")), []);
});

test("retries a failed journey with the same ID and content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const journeyId = "journey-failed-retry";
  const source = await testJpeg("#2cb4fb");
  const constrained = config(root);
  constrained.maxInputBytes = source.length - 1;
  const firstAttempt = new PhotoPipeline(constrained);
  await firstAttempt.init();
  await stageEnvelope(root, journeyId, "Retry Photo.jpg", source);
  await firstAttempt.processOnce();

  const receiptPath = path.join(root, "state", "photo-journeys", `${journeyId}.json`);
  const failedReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(failedReceipt.state, "failed");
  const quarantine = await readdir(path.join(root, "quarantine"));
  const errorName = quarantine.find((name) => name.endsWith(".error.json"));
  assert.ok(errorName);
  const failureAudit = JSON.parse(await readFile(path.join(root, "quarantine", errorName), "utf8"));
  assert.equal(failureAudit.journey_id, journeyId);
  assert.equal(failureAudit.reason_code, "PPL-02");

  const retry = new PhotoPipeline(config(root));
  await retry.init();
  await stageEnvelope(root, journeyId, "Retry Photo.jpg", source);
  await retry.processOnce();

  const publishedReceipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(publishedReceipt.state, "published");
  assert.notEqual(publishedReceipt.job_id, failedReceipt.job_id);
  assert.equal(publishedReceipt.content_sha256, sha256(source));
  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  assert.equal((await readdir(path.join(root, "galleries", latest.date_folder))).filter((name) => name.endsWith(".ready")).length, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, "quarantine", errorName), "utf8")).journey_id, journeyId);
});

test("quarantines a reused journey with different content without changing its terminal receipt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const journeyId = "journey-conflict";
  await stageEnvelope(root, journeyId, "Original.jpg", await testJpeg("#2cb4fb"));
  await pipeline.processOnce();
  const receiptPath = path.join(root, "state", "photo-journeys", `${journeyId}.json`);
  const canonicalReceipt = await readFile(receiptPath, "utf8");

  await stageEnvelope(root, journeyId, "Conflict.jpg", await testJpeg("#ff4d67"));
  await pipeline.processOnce();

  assert.equal(await readFile(receiptPath, "utf8"), canonicalReceipt);
  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  assert.equal((await readdir(path.join(root, "galleries", latest.date_folder))).filter((name) => name.endsWith(".ready")).length, 1);
  assert.equal((await readdir(path.join(root, "archive", latest.date_folder))).length, 1);
  const quarantine = await readdir(path.join(root, "quarantine"));
  assert.equal(quarantine.filter((name) => name.endsWith(".error.json")).length, 1);
  assert.equal(quarantine.filter((name) => !name.endsWith(".error.json")).length, 1);
  assert.match(JSON.parse(await readFile(path.join(root, "quarantine", quarantine.find((name) => name.endsWith(".error.json"))), "utf8")).detail, /reused with different photo content/);
});

test("backfills a missing digest and rejects a mismatched declared digest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const legacySource = await testJpeg("#2cb4fb");
  await stageEnvelope(root, "journey-migration", "Migration.jpg", legacySource, { omitDigest: true });
  await pipeline.processOnce();
  const migrated = JSON.parse(await readFile(path.join(root, "state", "photo-journeys", "journey-migration.json"), "utf8"));
  assert.equal(migrated.content_sha256, sha256(legacySource));

  const invalidSource = await testJpeg("#ff4d67");
  await stageEnvelope(root, "journey-bad-digest", "Bad Digest.jpg", invalidSource, { contentSha256: "0".repeat(64) });
  await pipeline.processOnce();
  const failed = JSON.parse(await readFile(path.join(root, "state", "photo-journeys", "journey-bad-digest.json"), "utf8"));
  assert.equal(failed.state, "failed");
  assert.equal(failed.content_sha256, sha256(invalidSource));
});

test("uses bounded processing paths for long original names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const originalName = `${"L".repeat(176)}.jpg`;
  await stageEnvelope(root, "journey-long-name", originalName, await testJpeg("#2cb4fb"));

  await pipeline.processOnce();

  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const sidecar = JSON.parse(await readFile(path.join(root, "galleries", latest.date_folder, `${latest.latest_base}.json`), "utf8"));
  assert.equal(sidecar.original_name, originalName);
  assert.deepEqual(await readdir(path.join(root, "processing")), []);
});

test("removes a missing-source orphan so a replacement claim can take over", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const journeyId = "journey-orphan";
  const originalName = "Recovered Orphan.jpg";
  const source = await testJpeg("#2cb4fb");
  const digest = sha256(source);
  const orphan = path.join(root, "processing", `job-orphan--${Buffer.from(originalName).toString("base64url")}`);
  await mkdir(orphan, { recursive: true });
  await writeFile(path.join(orphan, "journey.json"), JSON.stringify(journey(journeyId, originalName, source, digest)));
  await writeFile(path.join(root, "state", "photo-journeys", `${journeyId}.json`), JSON.stringify({
    ...journey(journeyId, originalName, source, digest), state: "processing", updated_at: new Date().toISOString(), job_id: "job-orphan",
  }));
  await stageEnvelope(root, journeyId, originalName, source);

  await pipeline.processOnce();

  assert.equal((await pipeline.journeyProgress()).find((item) => item.journey_id === journeyId).state, "published");
  assert.deepEqual(await readdir(path.join(root, "processing")), []);
});

test("quarantines a malformed envelope without blocking the next photo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const malformedId = "journey__ambiguous";
  const malformedSource = await testJpeg("#ff4d67");
  const malformed = path.join(root, "staging", `${malformedId}.frame-photo`);
  await mkdir(malformed, { recursive: true });
  await writeFile(path.join(malformed, "source"), malformedSource);
  await writeFile(path.join(malformed, "journey.json"), JSON.stringify(journey(malformedId, "Malformed.jpg", malformedSource)));
  await stageEnvelope(root, "journey-valid-next", "Valid.jpg", await testJpeg("#2cb4fb"));

  await pipeline.processOnce();

  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  assert.equal((await readdir(path.join(root, "galleries", latest.date_folder))).filter((name) => name.endsWith(".ready")).length, 1);
  const quarantine = await readdir(path.join(root, "quarantine"));
  assert.equal(quarantine.filter((name) => name.endsWith(".error.json")).length, 1);
  assert.equal(quarantine.filter((name) => !name.endsWith(".error.json")).length, 1);
  const descriptor = JSON.parse(await readFile(path.join(root, "quarantine", quarantine.find((name) => name.endsWith(".error.json"))), "utf8"));
  assert.equal(descriptor.journey_id, undefined);
  assert.deepEqual(await readdir(path.join(root, "staging")), []);
});

test("journey progress polling uses the bounded in-memory receipt view", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await stageEnvelope(root, "journey-progress-cache", "Cached.jpg", await testJpeg("#2cb4fb"));
  await pipeline.processOnce();
  await writeFile(path.join(root, "state", "photo-journeys", "unrelated-history.json"), "not-json");

  for (let index = 0; index < 2; index += 1) {
    const progress = await pipeline.journeyProgress(1000);
    assert.equal(progress.length, 1);
    assert.equal(progress[0].journey_id, "journey-progress-cache");
  }
});

test("concurrent claims reserve distinct publication bases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const originalName = "Same Name.png";
  for (const job of ["job-one", "job-two"]) {
    const claim = path.join(root, "processing", `${job}--${Buffer.from(originalName).toString("base64url")}`);
    await mkdir(claim, { recursive: true });
    await sharp({ create: { width: 80, height: 40, channels: 3, background: "#2cb4fb" } }).png().toFile(path.join(claim, "source"));
  }

  await pipeline.processOnce();

  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const ready = (await readdir(path.join(root, "galleries", latest.date_folder))).filter((name) => name.endsWith(".ready"));
  assert.equal(ready.length, 2);
  assert.equal(new Set(ready).size, 2);
});

test("pipeline settings resize output and enforce maximum published size", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await pipeline.updateSettings({ long_edge_px: 300, jpeg_quality: 85, max_output_mb: 0.05 });
  await sharp(randomBytes(900 * 600 * 3), { raw: { width: 900, height: 600, channels: 3 } })
    .png()
    .toFile(path.join(root, "staging", "Noisy Photo.bmp"));

  await pipeline.processOnce();

  const persisted = JSON.parse(await readFile(path.join(root, "state", "photo-pipeline-settings.json"), "utf8"));
  assert.equal(persisted.long_edge_px, 300);
  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const gallery = path.join(root, "galleries", latest.date_folder);
  const metadata = await sharp(path.join(gallery, `${latest.latest_base}.jpg`)).metadata();
  const sidecar = JSON.parse(await readFile(path.join(gallery, `${latest.latest_base}.json`), "utf8"));
  assert.equal(Math.max(metadata.width, metadata.height), 300);
  assert.ok(sidecar.output_size_bytes <= 0.05 * 1024 * 1024);
  assert.ok(sidecar.jpeg_quality <= 85);
});

test("pipeline reuses JPEGs that already fit published constraints", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await pipeline.updateSettings({ long_edge_px: 300, jpeg_quality: 85, max_output_mb: 1 });
  const source = path.join(root, "staging", "Ready Photo.jpg");
  await sharp({ create: { width: 240, height: 160, channels: 3, background: "#2cb4fb" } })
    .jpeg({ quality: 95 })
    .toFile(source);
  const original = await readFile(source);

  await pipeline.processOnce();

  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const output = await readFile(path.join(root, "galleries", latest.date_folder, `${latest.latest_base}.jpg`));
  assert.deepEqual(output, original);
});

test("pipeline still resizes oversized JPEGs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await pipeline.updateSettings({ long_edge_px: 300, jpeg_quality: 85, max_output_mb: 1 });
  const source = path.join(root, "staging", "Large Photo.jpg");
  await sharp({ create: { width: 900, height: 600, channels: 3, background: "#2cb4fb" } })
    .jpeg({ quality: 95 })
    .toFile(source);
  const original = await readFile(source);

  await pipeline.processOnce();

  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const outputPath = path.join(root, "galleries", latest.date_folder, `${latest.latest_base}.jpg`);
  const metadata = await sharp(outputPath).metadata();
  assert.equal(Math.max(metadata.width, metadata.height), 300);
  assert.notDeepEqual(await readFile(outputPath), original);
});

test("persists multiple validated Explore routes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const date = currentDateFolder();
  const candidate = exploreCandidate("manual-photo");

  const saved = await pipeline.saveExplore(date, candidate);

  assert.equal(saved.routes.length, 2);
  assert.equal(saved.time_adjustment_seconds, -14.5);
  assert.deepEqual(saved.placements, {});
  assert.notEqual(saved.updated_at, candidate.updated_at);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "galleries", date, "_explore.json"), "utf8")), saved);

  await writeFile(path.join(root, "galleries", date, "manual-photo.ready"), "ready\n");
  assert.equal((await pipeline.saveExplore(date, candidate)).placements["manual-photo"].timestamp, 1_500);

  const invalidTimestamp = structuredClone(candidate);
  invalidTimestamp.placements["manual-photo"].timestamp = 1.5;
  await assert.rejects(pipeline.saveExplore(date, invalidTimestamp), /timestamp/);

  const invalid = structuredClone(candidate);
  invalid.routes[0].segments[0][1][2] = 181;
  await assert.rejects(pipeline.saveExplore(date, invalid), /coordinates/);
  await pipeline.deleteExplore(date);
  await assert.rejects(readFile(path.join(root, "galleries", date, "_explore.json"), "utf8"));
});

test("trash and restore preserve ready while every management change advances latest state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await sharp({ create: { width: 160, height: 90, channels: 3, background: "#2cb4fb" } })
    .jpeg()
    .toFile(path.join(root, "staging", "Managed Photo.jpg"));
  await pipeline.processOnce();

  const published = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const gallery = path.join(root, "galleries", published.date_folder);
  const ready = path.join(gallery, `${published.latest_base}.ready`);
  await pipeline.saveExplore(published.date_folder, exploreCandidate(published.latest_base));
  const trashed = await pipeline.managePhotos("trash-photo", published.date_folder, published.latest_base);
  assert.equal(trashed.latest_base, null);
  assert.equal(trashed.count_today, 0);
  assert.notEqual(trashed.updated_at, published.updated_at);
  assert.equal((await readFile(ready, "utf8")).length > 0, true);
  assert.equal(JSON.parse(await readFile(path.join(gallery, `${published.latest_base}.trashed.json`), "utf8")).base, published.latest_base);
  assert.ok(JSON.parse(await readFile(path.join(gallery, "_explore.json"), "utf8")).placements[published.latest_base]);
  assert.ok((await pipeline.saveExplore(published.date_folder, exploreCandidate(published.latest_base))).placements[published.latest_base]);

  const restored = await pipeline.managePhotos("restore-photo", published.date_folder, published.latest_base);
  assert.equal(restored.latest_base, published.latest_base);
  assert.equal(restored.count_today, 1);
  assert.notEqual(restored.updated_at, trashed.updated_at);
  await assert.rejects(readFile(path.join(gallery, `${published.latest_base}.trashed.json`), "utf8"));

  await pipeline.managePhotos("trash-photo", published.date_folder, published.latest_base);
  const purged = await pipeline.managePhotos("purge-photo", published.date_folder, published.latest_base);
  assert.equal(purged.latest_base, null);
  await assert.rejects(readFile(ready, "utf8"));
  assert.equal(JSON.parse(await readFile(path.join(gallery, "_explore.json"), "utf8")).placements[published.latest_base], undefined);
  assert.equal((await pipeline.saveExplore(published.date_folder, exploreCandidate(published.latest_base))).placements[published.latest_base], undefined);
  assert.equal((await readdir(root)).includes("today"), false);
});

test("failed permanent deletion keeps its trash marker and Explore placement for retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await sharp({ create: { width: 160, height: 90, channels: 3, background: "#2cb4fb" } })
    .jpeg()
    .toFile(path.join(root, "staging", "Retry Photo.jpg"));
  await pipeline.processOnce();

  const published = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const gallery = path.join(root, "galleries", published.date_folder);
  const image = path.join(gallery, `${published.latest_base}.jpg`);
  const marker = path.join(gallery, `${published.latest_base}.trashed.json`);
  await pipeline.saveExplore(published.date_folder, exploreCandidate(published.latest_base));
  await pipeline.managePhotos("trash-photo", published.date_folder, published.latest_base);
  await rm(image);
  await mkdir(image);
  await writeFile(path.join(image, "locked"), "retry\n");

  await assert.rejects(pipeline.managePhotos("purge-photo", published.date_folder, published.latest_base));
  await readFile(marker, "utf8");
  assert.ok(JSON.parse(await readFile(path.join(gallery, "_explore.json"), "utf8")).placements[published.latest_base]);

  await rm(image, { recursive: true, force: true });
  assert.equal((await pipeline.managePhotos("purge-photo", published.date_folder, published.latest_base)).affected, 1);
  await assert.rejects(readFile(marker, "utf8"));
  assert.equal(JSON.parse(await readFile(path.join(gallery, "_explore.json"), "utf8")).placements[published.latest_base], undefined);
});

test("trashing the latest photo recalculates latest_base to the newest visible publication", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await sharp({ create: { width: 160, height: 90, channels: 3, background: "#2cb4fb" } })
    .jpeg()
    .toFile(path.join(root, "staging", "First Photo.jpg"));
  await pipeline.processOnce();
  const first = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await sharp({ create: { width: 160, height: 90, channels: 3, background: "#75ffb1" } })
    .jpeg()
    .toFile(path.join(root, "staging", "Second Photo.jpg"));
  await pipeline.processOnce();
  const second = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  assert.notEqual(second.latest_base, first.latest_base);

  const trashed = await pipeline.managePhotos("trash-photo", second.date_folder, second.latest_base);
  assert.equal(trashed.latest_base, first.latest_base);
  assert.equal(trashed.count_today, 1);
  const restored = await pipeline.managePhotos("restore-photo", second.date_folder, second.latest_base);
  assert.equal(restored.latest_base, second.latest_base);
  assert.equal(restored.count_today, 2);
});

function config(dataRoot) {
  return {
    port: 0,
    dataRoot,
    hostDataRoot: dataRoot,
    timezone: "America/Chicago",
    pollMs: 1000,
    concurrency: 2,
    maxInputBytes: 50 * 1024 * 1024,
    maxPixels: 80_000_000,
    conversionAttempts: 3,
    archiveOriginals: true,
    defaultSettings: {
      long_edge_px: 0,
      jpeg_quality: 92,
      max_output_mb: 0,
    },
  };
}

async function stageEnvelope(root, journeyId, originalName, source, options = {}) {
  const envelope = path.join(root, "staging", `${journeyId}.frame-photo`);
  await mkdir(envelope, { recursive: true });
  const contents = source ?? await testJpeg("#2cb4fb");
  await writeFile(path.join(envelope, "source"), contents);
  await writeFile(path.join(envelope, "journey.json"), JSON.stringify(journey(
    journeyId,
    originalName,
    contents,
    options.omitDigest ? undefined : options.contentSha256 ?? sha256(contents),
  )));
}

function journey(journeyId, originalName, source, contentSha256 = sha256(source)) {
  return {
    schema_version: 1,
    journey_id: journeyId,
    ...(contentSha256 ? { content_sha256: contentSha256 } : {}),
    original_name: originalName,
    received_at: new Date().toISOString(),
    ingest: { adapter: "web_upload", transfer_id: journeyId, bytes_received: source.length },
  };
}

async function testJpeg(background) {
  return sharp({ create: { width: 100, height: 50, channels: 3, background } }).jpeg().toBuffer();
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function currentDateFolder() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function exploreCandidate(base) {
  const importedAt = "2026-07-13T01:00:00.000Z";
  return {
    schema_version: 1,
    updated_at: "2000-01-01T00:00:00.000Z",
    time_shift_seconds: 18_000,
    time_adjustment_seconds: -14.5,
    routes: [
      { id: "round-one", name: "Round one.gpx", imported_at: importedAt, segments: [[[1_000, 41, -87], [2_000, 41.1, -87.1]]] },
      { id: "round-two", name: "Round two.gpx", imported_at: importedAt, segments: [[[3_000, 41.2, -87.2], [4_000, 41.3, -87.3]]] },
    ],
    placements: { [base]: { lat: 41.05, lon: -87.05, timestamp: 1_500, updated_at: importedAt } },
  };
}
