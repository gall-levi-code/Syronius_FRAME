import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { watch } from "node:fs";
import fsPromises, { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { atomicWrite } from "../dist/fsUtils.js";
import { PhotoPipeline } from "../dist/pipeline.js";
import { loadConfig } from "../dist/config.js";

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
  const recalculateLatest = pipeline.recalculateLatest.bind(pipeline);
  let fullRecalculations = 0;
  pipeline.recalculateLatest = async (...args) => {
    fullRecalculations += 1;
    return recalculateLatest(...args);
  };
  const writeLatest = pipeline.writeLatest.bind(pipeline);
  const knownCounts = [];
  pipeline.writeLatest = async (...args) => {
    knownCounts.push(args[4]);
    return writeLatest(...args);
  };
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
  assert.ok(Number.isFinite(Date.parse(latest.latest_photo_at)));
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
  assert.equal(fullRecalculations, 0);
  assert.deepEqual(knownCounts, [1]);

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
        OffsetTimeOriginal: "-05:00",
        SubSecTimeOriginal: "123",
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
  assert.equal(sidecar.exif.Photo.OffsetTimeOriginal, "-05:00");
  assert.equal(sidecar.exif.Photo.SubSecTimeOriginal, "123");
  assert.equal(sidecar.capture_clock, "2026-07-12T20:00:30.123");
  assert.equal(sidecar.captured_at, "2026-07-13T01:00:30.123Z");
  assert.ok(Object.keys(sidecar.exif).length > 0);
});

test("does not promote a malformed EXIF camera date into capture ordering metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await sharp({ create: { width: 320, height: 180, channels: 3, background: "#2cb4fb" } })
    .jpeg()
    .withExif({ IFD2: { DateTimeOriginal: "2026:02:30 20:00:30", OffsetTimeOriginal: "-05:00" } })
    .toFile(path.join(root, "staging", "Bad Camera Clock.jpg"));

  await pipeline.processOnce();

  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const sidecar = JSON.parse(await readFile(
    path.join(root, "galleries", latest.date_folder, `${latest.latest_base}.json`),
    "utf8",
  ));
  assert.equal(sidecar.exif.Photo?.DateTimeOriginal, undefined);
  assert.equal(sidecar.capture_clock, undefined);
  assert.equal(sidecar.captured_at, undefined);
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
  const recalculateLatest = pipeline.recalculateLatest.bind(pipeline);
  let fullRecalculations = 0;
  pipeline.recalculateLatest = async (...args) => {
    fullRecalculations += 1;
    return recalculateLatest(...args);
  };

  await pipeline.processOnce();

  assert.deepEqual((await readdir(gallery)).filter((name) => name.endsWith(".ready")), [`${base}.ready`]);
  assert.equal(JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8")).latest_base, base);
  assert.equal((await readdir(path.join(root, "archive", dateFolder))).length, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, "state", "photo-journeys", `${journeyId}.json`), "utf8")).state, "published");
  assert.equal(fullRecalculations, 1);
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
  assert.equal(failed.integrity_verified, false);
  assert.equal(failed.integrity_expected_sha256, "0".repeat(64));

  const receiptPath = path.join(root, "state", "photo-journeys", "journey-bad-digest.json");
  const canonicalFailure = await readFile(receiptPath, "utf8");
  const restarted = new PhotoPipeline(config(root));
  await restarted.init();
  await stageEnvelope(root, "journey-bad-digest", "Different.jpg", await testJpeg("#75ffb1"));
  await restarted.processOnce();
  assert.equal(await readFile(receiptPath, "utf8"), canonicalFailure);
});

test("an unverified retry cannot poison a concurrently valid journey", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-integrity-race-"));
  const pipeline = new PhotoPipeline({ ...config(root), concurrency: 2 });
  await pipeline.init();
  const journeyId = "journey-integrity-race";
  const validSource = await testJpeg("#2cb4fb");
  const declaredDigest = sha256(validSource);
  for (const [jobId, source] of [["job-valid", validSource], ["job-bad", Buffer.from("bad")]]) {
    const directory = path.join(root, "processing", jobId);
    await mkdir(directory);
    await writeFile(path.join(directory, "source"), source);
    const metadata = journey(
      journeyId,
      `${jobId}.jpg`,
      source,
      sha256(source),
    );
    if (jobId === "job-bad") metadata.ingest.bytes_received += 1;
    await writeFile(path.join(directory, "journey.json"), JSON.stringify(metadata));
  }
  const verify = pipeline.readOrCreateJourney.bind(pipeline);
  pipeline.readOrCreateJourney = async (directory, ...args) => {
    if (path.basename(directory) === "job-valid") await new Promise((resolve) => setTimeout(resolve, 50));
    return verify(directory, ...args);
  };

  await pipeline.processOnce();

  const receipt = JSON.parse(await readFile(path.join(root, "state", "photo-journeys", `${journeyId}.json`), "utf8"));
  assert.equal(receipt.state, "published");
  assert.equal(receipt.content_sha256, declaredDigest);
  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  assert.equal((await readdir(path.join(root, "galleries", latest.date_folder))).filter((name) => name.endsWith(".ready")).length, 1);
  assert.equal((await readdir(path.join(root, "quarantine"))).filter((name) => name.endsWith(".error.json")).length, 1);
  assert.equal(pipeline.statusSnapshot().last_batch.published, 1);
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
  const status = pipeline.statusSnapshot();
  assert.equal(status.last_batch.total, 2);
  assert.equal(status.last_batch.completed, 2);
  assert.equal(status.last_batch.published, 1);
  assert.equal(status.last_batch.quarantined, 1);
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
  const readClaims = pipeline.readClaims.bind(pipeline);
  let claimReads = 0;
  pipeline.readClaims = async (...args) => {
    claimReads += 1;
    return readClaims(...args);
  };
  const writeLatest = pipeline.writeLatest.bind(pipeline);
  const knownCounts = [];
  pipeline.writeLatest = async (...args) => {
    knownCounts.push(args[4]);
    return writeLatest(...args);
  };
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
  assert.equal(latest.count_today, 2);
  assert.equal(claimReads, 2);
  assert.deepEqual(knownCounts, [1, 2]);
  const gallery = path.join(root, "galleries", latest.date_folder);
  const latestMtime = (await stat(path.join(gallery, `${latest.latest_base}.ready`))).mtimeMs;
  assert.ok((await Promise.all(ready.map((name) => stat(path.join(gallery, name))))).every((info) => info.mtimeMs <= latestMtime));
});

test("an incompatible latest count falls back to an authoritative gallery scan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-latest-fallback-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await writeFile(path.join(root, "state", "latest.json"), JSON.stringify({
    updated_at: new Date().toISOString(),
    date_folder: currentDateFolder(),
    latest_base: null,
    count_today: "invalid",
  }));
  let fullRecalculations = 0;
  const recalculateLatest = pipeline.recalculateLatest.bind(pipeline);
  pipeline.recalculateLatest = async (...args) => {
    fullRecalculations += 1;
    return recalculateLatest(...args);
  };
  await stageEnvelope(root, "journey-latest-fallback", "Fallback.jpg", await testJpeg("#2cb4fb"));

  await pipeline.processOnce();

  assert.equal(fullRecalculations, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8")).count_today, 1);
});

test("status snapshot exposes worker stages, a true pending queue, rolling performance, and the drained batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-telemetry-"));
  const configured = { ...config(root), concurrency: 1 };
  const pipeline = new PhotoPipeline(configured);
  await pipeline.init();
  await stageEnvelope(root, "journey-telemetry-one", "Telemetry One.jpg", await testJpeg("#2cb4fb"));
  await stageEnvelope(root, "journey-telemetry-two", "Telemetry Two.jpg", await testJpeg("#75ffb1"));

  const verify = pipeline.readOrCreateJourney.bind(pipeline);
  let releaseIntegrity;
  let reportIntegrity;
  const integrityStarted = new Promise((resolve) => { reportIntegrity = resolve; });
  const integrityBlocked = new Promise((resolve) => { releaseIntegrity = resolve; });
  let blockFirst = true;
  pipeline.readOrCreateJourney = async (...args) => {
    if (blockFirst) {
      blockFirst = false;
      reportIntegrity();
      await integrityBlocked;
    }
    return verify(...args);
  };

  const processing = pipeline.processOnce();
  await integrityStarted;
  const active = pipeline.statusSnapshot();
  assert.deepEqual(active.workers, { active: 1, configured: 1 });
  assert.equal(active.processing, 1);
  assert.equal(active.queue_depth, 1);
  assert.equal(active.active_jobs.length, 1);
  assert.equal(active.active_jobs[0].stage, "integrity");
  assert.ok(["Telemetry One.jpg", "Telemetry Two.jpg"].includes(active.active_jobs[0].filename));
  assert.ok(active.active_jobs[0].size_bytes > 0);
  assert.ok(active.active_jobs[0].elapsed_ms >= 0);
  assert.ok(active.active_jobs[0].stage_elapsed_ms >= 0);
  assert.ok(active.current_batch);
  assert.equal(active.current_batch.total, 2);

  releaseIntegrity();
  await processing;

  const completed = pipeline.statusSnapshot();
  assert.deepEqual(completed.workers, { active: 0, configured: 1 });
  assert.equal(completed.queue_depth, 0);
  assert.deepEqual(completed.active_jobs, []);
  assert.equal(completed.current_batch, null);
  assert.equal(completed.last_batch.total, 2);
  assert.equal(completed.last_batch.completed, 2);
  assert.equal(completed.last_batch.published, 2);
  assert.equal(completed.last_batch.quarantined, 0);
  assert.ok(completed.last_batch.bytes > 0);
  assert.ok(completed.last_batch.last_ingest_at);
  assert.equal(completed.rolling.window_seconds, 60);
  assert.equal(completed.rolling.completed, 2);
  assert.ok(completed.rolling.images_per_second > 0);
  assert.ok(completed.rolling.mib_per_second > 0);
  assert.equal(completed.performance.sample_size, 2);
  assert.ok(completed.performance.stages.integrity.avg_ms >= 0);
  assert.ok(completed.performance.stages.publish.p95_ms >= 0);
  assert.ok(completed.performance.publish_lock_hold_ms.avg_ms >= 0);
});

test("an overlapping scan refreshes queue depth for newly staged work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-live-queue-"));
  const pipeline = new PhotoPipeline({ ...config(root), concurrency: 1 });
  await pipeline.init();
  await stageEnvelope(root, "journey-live-queue-one", "First.jpg", await testJpeg("#2cb4fb"));

  const verify = pipeline.readOrCreateJourney.bind(pipeline);
  let releaseIntegrity;
  let reportIntegrity;
  const integrityStarted = new Promise((resolve) => { reportIntegrity = resolve; });
  const integrityBlocked = new Promise((resolve) => { releaseIntegrity = resolve; });
  pipeline.readOrCreateJourney = async (...args) => {
    reportIntegrity();
    await integrityBlocked;
    return verify(...args);
  };
  const running = pipeline.processOnce();
  await integrityStarted;
  await stageEnvelope(root, "journey-live-queue-two", "Second.jpg", await testJpeg("#75ffb1"));

  await pipeline.processOnce();
  const queuedDuringFirstJob = pipeline.statusSnapshot().queue_depth;
  releaseIntegrity();
  await running;
  assert.equal(queuedDuringFirstJob, 1);
  pipeline.readOrCreateJourney = verify;
  await pipeline.processOnce();
  assert.equal(pipeline.statusSnapshot().queue_depth, 0);
});

test("structured DEBUG logs are gated by PIPELINE_LOG_LEVEL", async () => {
  const captured = [];
  const originalLog = console.log;
  console.log = (line) => captured.push(String(line));
  try {
    const info = new PhotoPipeline(config("info-log-root"));
    info.log("info", "visible_info", { value: 1 });
    await info.withPublishLock(async () => undefined);

    const debug = new PhotoPipeline({ ...config("debug-log-root"), logLevel: "debug" });
    await debug.withPublishLock(async () => undefined);
  } finally {
    console.log = originalLog;
  }

  const entries = captured.map((line) => JSON.parse(line));
  assert.equal(entries.find((entry) => entry.event === "visible_info").level, "INFO");
  assert.equal(entries.filter((entry) => entry.level === "DEBUG").length, 1);
  assert.equal(entries.find((entry) => entry.level === "DEBUG").event, "publish_lock");
});

test("a sustained batch retains IDs only for unfinished jobs", () => {
  const pipeline = new PhotoPipeline(config("batch-memory-root"));
  const claims = Array.from({ length: 20 }, (_, index) => ({
    jobId: `job-${index}`,
    receivedAt: null,
  }));
  pipeline.registerBatchClaims(claims);
  for (const claim of claims.slice(0, -1)) {
    pipeline.recordBatchSize(claim.jobId, 10);
    pipeline.recordBatchCompletion(claim.jobId, "published");
  }

  const status = pipeline.statusSnapshot();
  assert.equal(status.current_batch.total, 20);
  assert.equal(status.current_batch.completed, 19);
  assert.equal(pipeline.currentBatch.jobs.size, 1);
  assert.equal(pipeline.currentBatch.sizedJobs.size, 0);
});

test("invalid claim telemetry retains its source bytes in the drained batch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-invalid-telemetry-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const source = Buffer.from("invalid claim source");
  const claim = path.join(root, "staging", "invalid-telemetry.frame-photo");
  await mkdir(claim);
  await writeFile(path.join(claim, "source"), source);
  await writeFile(path.join(claim, "journey.json"), "{");

  await pipeline.processOnce();

  const status = pipeline.statusSnapshot();
  assert.equal(status.last_batch.quarantined, 1);
  assert.equal(status.last_batch.bytes, source.length);
  assert.equal(status.rolling.completed, 1);
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

  const legacyThumbnail = path.join(root, "gallery-cache", published.date_folder, `${published.latest_base}.webp`);
  const tileDirectory = path.join(root, "gallery-cache", "tiles", published.date_folder, published.latest_base);
  const cachedTile = path.join(tileDirectory, "0-0.webp");
  await mkdir(path.dirname(legacyThumbnail), { recursive: true });
  await mkdir(tileDirectory, { recursive: true });
  await writeFile(legacyThumbnail, "legacy thumbnail\n");
  await writeFile(cachedTile, "cached tile\n");
  await pipeline.managePhotos("trash-photo", published.date_folder, published.latest_base);
  await readFile(legacyThumbnail);
  await readFile(cachedTile);
  const purged = await pipeline.managePhotos("purge-photo", published.date_folder, published.latest_base);
  assert.equal(purged.latest_base, null);
  await assert.rejects(readFile(ready, "utf8"));
  await assert.rejects(readFile(legacyThumbnail), { code: "ENOENT" });
  await assert.rejects(readdir(tileDirectory), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(path.join(gallery, "_explore.json"), "utf8")).placements[published.latest_base], undefined);
  assert.equal((await pipeline.saveExplore(published.date_folder, exploreCandidate(published.latest_base))).placements[published.latest_base], undefined);
  assert.equal((await readdir(root)).includes("today"), false);
});

test("batch trash preserves unselected photos, publication files and originals and supports restore and retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-batch-trash-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  for (const name of ["First.jpg", "Second.jpg", "Third.jpg"]) {
    await writeFile(path.join(root, "staging", name), await testJpeg("#2cb4fb"));
  }
  await pipeline.processOnce();
  const before = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const gallery = path.join(root, "galleries", before.date_folder);
  const bases = (await readdir(gallery)).filter((name) => name.endsWith(".ready")).map((name) => name.slice(0, -6));
  const keep = bases.find((base) => base !== before.latest_base);
  const selected = bases.filter((base) => base !== keep);
  await pipeline.saveExplore(before.date_folder, exploreCandidate(selected[0]));
  const originals = new Map(await Promise.all((await readdir(gallery)).map(async (name) => [name, await readFile(path.join(gallery, name))])));
  const readyTimes = await Promise.all(bases.map(async (base) => (await stat(path.join(gallery, `${base}.ready`))).mtimeMs));
  const recalculateLatest = pipeline.recalculateLatest.bind(pipeline);
  let recalculations = 0;
  pipeline.recalculateLatest = async (...args) => {
    recalculations += 1;
    return recalculateLatest(...args);
  };

  const result = await pipeline.managePhotos("trash-photos", before.date_folder, undefined, undefined, [...selected, selected[0]]);
  assert.equal(result.action, "trash-photos");
  assert.equal(result.affected, 2);
  assert.equal(result.count_today, 1);
  assert.equal(result.latest_base, keep);
  assert.ok(result.updated_at > before.updated_at);
  assert.equal(recalculations, 1, "the complete batch recalculates latest once");
  assert.deepEqual((await pipeline.listTrash()).map((photo) => photo.base).sort(), [...selected].sort());
  await assert.rejects(readFile(path.join(gallery, `${keep}.trashed.json`)), { code: "ENOENT" });
  const markers = await Promise.all(selected.map((base) => readFile(path.join(gallery, `${base}.trashed.json`), "utf8")));
  assert.equal((await pipeline.managePhotos("trash-photos", before.date_folder, undefined, undefined, selected)).affected, 0);
  assert.deepEqual(await Promise.all(selected.map((base) => readFile(path.join(gallery, `${base}.trashed.json`), "utf8"))), markers);

  const restored = await pipeline.managePhotos("restore-album", before.date_folder);
  assert.equal(restored.affected, 2);
  assert.equal(restored.count_today, 3);
  assert.equal(restored.latest_base, before.latest_base);
  assert.deepEqual(await pipeline.listTrash(), []);
  assert.deepEqual((await readdir(gallery)).sort(), [...originals.keys()].sort());
  for (const [name, contents] of originals) assert.deepEqual(await readFile(path.join(gallery, name)), contents);
  for (const [index, base] of bases.entries()) {
    assert.equal((await stat(path.join(gallery, `${base}.ready`))).mtimeMs, readyTimes[index]);
    const sidecar = JSON.parse(originals.get(`${base}.json`).toString());
    assert.ok(await pipeline.verifiedTrackedArchive(before.date_folder, sidecar.journey_id, base));
  }
});

test("batch trash rejects invalid or missing selections before writing any marker or latest state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-batch-trash-validation-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const date = currentDateFolder();
  const gallery = path.join(root, "galleries", date);
  await writeFile(path.join(gallery, "present.ready"), "keep receipt\n");
  await pipeline.recalculateLatest(new Date().toISOString());
  const latest = await readFile(path.join(root, "state", "latest.json"));
  const trash = (selection, dateFolder = date) => pipeline.managePhotos("trash-photos", dateFolder, undefined, undefined, selection);
  for (const selection of [undefined, null, "present", {}, [], [""], [null], [42], ["present", "../outside"], ["x".repeat(201)], Array(1001).fill("present")]) {
    await assert.rejects(trash(selection), { status: 400 });
  }
  for (const dateFolder of [null, [date], "../archive", ""]) await assert.rejects(trash(["present"], dateFolder), { status: 400 });
  await assert.rejects(trash(["present", "missing"]), { status: 404 });
  assert.deepEqual(await readdir(gallery), ["present.ready"]);
  assert.equal(await readFile(path.join(gallery, "present.ready"), "utf8"), "keep receipt\n");
  assert.deepEqual(await readFile(path.join(root, "state", "latest.json")), latest);
});

test("partially failed batch trash refreshes visible latest state and can be safely retried", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-batch-trash-retry-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  for (const name of ["First.jpg", "Second.jpg", "Keep.jpg"]) {
    await writeFile(path.join(root, "staging", name), await testJpeg("#2cb4fb"));
  }
  await pipeline.processOnce();
  const before = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const gallery = path.join(root, "galleries", before.date_folder);
  const bases = (await readdir(gallery)).filter((name) => name.endsWith(".ready")).map((name) => name.slice(0, -6));
  const selected = [before.latest_base, bases.find((base) => base !== before.latest_base)];
  const keep = bases.find((base) => !selected.includes(base));
  const trashPublication = pipeline.trashPublication.bind(pipeline);
  pipeline.trashPublication = async (date, base) => {
    if (base === selected[1]) throw new Error("injected trash marker write failure");
    return trashPublication(date, base);
  };
  await assert.rejects(pipeline.managePhotos("trash-photos", before.date_folder, undefined, undefined, selected), /injected trash marker write failure/);
  const partial = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  assert.equal(partial.count_today, 2);
  assert.notEqual(partial.latest_base, before.latest_base);
  const firstMarker = await readFile(path.join(gallery, `${selected[0]}.trashed.json`), "utf8");
  await assert.rejects(readFile(path.join(gallery, `${selected[1]}.trashed.json`)), { code: "ENOENT" });
  pipeline.trashPublication = trashPublication;
  const retried = await pipeline.managePhotos("trash-photos", before.date_folder, undefined, undefined, selected);
  assert.equal(retried.affected, 1);
  assert.equal(retried.count_today, 1);
  assert.equal(retried.latest_base, keep);
  assert.equal(await readFile(path.join(gallery, `${selected[0]}.trashed.json`), "utf8"), firstMarker);
  for (const base of bases) await readFile(path.join(gallery, `${base}.ready`));
  assert.equal((await pipeline.managePhotos("restore-album", before.date_folder)).affected, 2);
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

test("bulk gallery moves preserve photos, timestamps, journeys, originals and destination map placements", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-move-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  for (const name of ["Move One.jpg", "Move Two.jpg", "Leave Here.jpg"]) {
    await writeFile(path.join(root, "staging", name), await testJpeg("#2cb4fb"));
  }
  await pipeline.processOnce();
  const before = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const source = path.join(root, "galleries", before.date_folder);
  const bases = (await readdir(source)).filter((name) => name.startsWith("Move_") && name.endsWith(".ready")).map((name) => name.slice(0, -6));
  assert.equal(bases.length, 2);
  const targetDate = "1999-12-31";
  const target = path.join(root, "galleries", targetDate);
  await mkdir(target);
  await writeFile(path.join(target, "existing.ready"), "existing\n");
  const targetExplore = exploreCandidate("existing");
  targetExplore.routes[0].name = "Destination route.gpx";
  await pipeline.saveExplore(targetDate, targetExplore);
  await pipeline.saveExplore(before.date_folder, exploreCandidate(bases[0]));
  const originals = await Promise.all(bases.map(async (base) => ({
    jpg: await readFile(path.join(source, `${base}.jpg`)),
    jpgInfo: await stat(path.join(source, `${base}.jpg`)),
    sidecar: JSON.parse(await readFile(path.join(source, `${base}.json`), "utf8")),
    readyInfo: await stat(path.join(source, `${base}.ready`)),
  })));
  const thumbnail = path.join(root, "gallery-cache", before.date_folder, `${bases[0]}.webp`);
  const targetThumbnail = path.join(root, "gallery-cache", targetDate, `${bases[0]}.webp`);
  for (const file of [thumbnail, targetThumbnail]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "stale thumbnail");
  }

  const progress = [];
  let unlock;
  const lock = pipeline.withPublishLock(() => new Promise((resolve) => { unlock = resolve; }));
  await new Promise(setImmediate);
  const moving = pipeline.managePhotos("move-photos", before.date_folder, undefined, targetDate, [...bases, bases[0]], (event) => progress.push(event));
  assert.deepEqual(progress, [{ phase: "waiting", completed: 0, total: 2 }]);
  unlock();
  await lock;
  const result = await moving;

  assert.deepEqual([...new Set(progress.map((event) => event.phase))], ["waiting", "checking", "preparing", "moving", "finalizing", "cleanup"]);
  for (const phase of ["checking", "preparing", "moving", "cleanup"]) {
    assert.deepEqual(progress.filter((event) => event.phase === phase).map((event) => event.completed), [0, 1, 2]);
  }
  assert.ok(progress.every((event) => event.total === 2));

  assert.equal(result.affected, 2);
  assert.equal(result.target_date_folder, targetDate);
  assert.equal(result.count_today, 1);
  assert.ok(result.updated_at > before.updated_at);
  for (const [index, base] of bases.entries()) {
    assert.equal((await readdir(source)).some((entry) => entry.startsWith(`${base}.`)), false);
    assert.deepEqual(await readFile(path.join(target, `${base}.jpg`)), originals[index].jpg);
    const movedInfo = await stat(path.join(target, `${base}.jpg`));
    assert.equal(`${movedInfo.dev}:${movedInfo.ino}`, `${originals[index].jpgInfo.dev}:${originals[index].jpgInfo.ino}`, "moving reuses image bytes without a full JPEG copy");
    const movedSidecar = JSON.parse(await readFile(path.join(target, `${base}.json`), "utf8"));
    assert.deepEqual(movedSidecar, { ...originals[index].sidecar, date_folder: targetDate });
    assert.ok(Math.abs((await stat(path.join(target, `${base}.ready`))).mtimeMs - originals[index].readyInfo.mtimeMs) < 1);
    const manifest = (await readFile(path.join(target, `${base}.ready`), "utf8")).trimEnd().split("\n");
    assert.deepEqual(manifest, [path.join(target, `${base}.jpg`), path.join(target, `${base}.txt`), "0"]);
    const receipt = JSON.parse(await readFile(path.join(root, "state", "photo-journeys", `${movedSidecar.journey_id}.json`), "utf8"));
    assert.equal(receipt.date_folder, targetDate);
    assert.equal((await pipeline.journeyProgress()).find((item) => item.journey_id === receipt.journey_id).date_folder, targetDate);
    assert.ok(await pipeline.verifiedTrackedArchive(targetDate, receipt.journey_id, base));
    await assert.rejects(readdir(path.join(root, "archive", before.date_folder, receipt.journey_id)), { code: "ENOENT" });
  }
  const movedExplore = JSON.parse(await readFile(path.join(target, "_explore.json"), "utf8"));
  assert.equal(movedExplore.routes[0].name, "Destination route.gpx");
  assert.ok(movedExplore.placements.existing);
  assert.ok(movedExplore.placements[bases[0]]);
  assert.equal(JSON.parse(await readFile(path.join(source, "_explore.json"), "utf8")).placements[bases[0]], undefined);
  for (const file of [thumbnail, targetThumbnail]) await assert.rejects(readFile(file), { code: "ENOENT" });

  const returned = await pipeline.managePhotos("move-photos", targetDate, undefined, before.date_folder, bases, () => { throw new Error("observer disconnected"); });
  assert.equal(returned.affected, 2, "progress callback failures do not roll back accepted work");
});

test("management streams progress before completion, safe terminal errors, and finishes after disconnect", { timeout: 20000 }, async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-move-stream-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await writeFile(path.join(root, "staging", "Stream Move.jpg"), await testJpeg("#2cb4fb"));
  await pipeline.processOnce();
  const before = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from 'node:net';
    import { PhotoPipeline } from './dist/pipeline.js';
    const listener = createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    process.env.PORT = String(listener.address().port);
    await new Promise(resolve => listener.close(resolve));
    const move = PhotoPipeline.prototype.movePublications;
    PhotoPipeline.prototype.movePublications = async function (...args) {
      await new Promise(resolve => setTimeout(resolve, 150));
      if (args[1] === '1999-12-29') throw new Error('secret internal path');
      return move.apply(this, args);
    };
    await import('./dist/index.js');
  `], {
    cwd: path.resolve("."),
    env: { ...process.env, DATA_ROOT: root, HOST_DATA_ROOT: root, PORTAL_SERVICE_TOKEN: "test-move-stream-token",
      PIPELINE_POLL_MS: "60000", PHOTO_ARCHIVE_RETENTION_DAYS: "0", PHOTO_TRASH_RETENTION_DAYS: "0", DISK_MINIMUM_FREE_GB: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill());
  let logs = "";
  const port = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => reject(new Error(`Management server exited ${code}: ${logs}`)));
    child.stderr.on("data", (chunk) => { logs += chunk; });
    child.stdout.on("data", (chunk) => {
      logs += chunk;
      const listening = logs.match(/listening on (\d+)/);
      if (listening) resolve(Number(listening[1]));
    });
  });
  const manage = (source, target, stream = true) => fetch(`http://127.0.0.1:${port}/api/internal/photo-pipeline/manage`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-frame-service-token": "test-move-stream-token",
      Accept: stream ? "application/x-ndjson" : "application/json" },
    body: JSON.stringify({ action: "move-photos", date_folder: source, target_date_folder: target, bases: [before.latest_base] }),
  });
  const response = await manage(before.date_folder, "1999-12-31");
  assert.match(response.headers.get("content-type"), /application\/x-ndjson/);
  const reader = response.body.getReader();
  const first = await reader.read();
  let body = new TextDecoder().decode(first.value);
  assert.equal(JSON.parse(body.trim().split("\n")[0]).phase, "waiting");
  assert.ok(!body.includes('"type":"result"'), "feedback arrives while the move is still running");
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += new TextDecoder().decode(chunk.value);
  }
  const records = body.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.at(-1).type, "result");
  assert.equal(records.at(-1).result.affected, 1);
  assert.ok(records.some((record) => record.phase === "cleanup" && record.completed === 1));

  const invalid = await manage("1999-12-31", "1999-12-31");
  const invalidRecords = (await invalid.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(invalidRecords.at(-1), { type: "error", error: "Choose a different destination gallery." });
  const internal = await manage("1999-12-31", "1999-12-29");
  assert.deepEqual(JSON.parse((await internal.text()).trim().split("\n").at(-1)), { type: "error", error: "Photo management request failed." });

  const returning = await manage("1999-12-31", before.date_folder);
  const disconnect = returning.body.getReader();
  assert.ok((await disconnect.read()).value.length);
  await disconnect.cancel();
  let published = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    published = await stat(path.join(root, "galleries", before.date_folder, `${before.latest_base}.ready`)).then(() => true, () => false);
    if (published) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(published, true, "the accepted move finishes after the browser disconnects");
  const legacy = await manage(before.date_folder, "1999-12-31", false);
  assert.match(legacy.headers.get("content-type"), /application\/json/);
  assert.equal((await legacy.json()).affected, 1);
  for (const [bases, status] of [[[], 400], [[before.latest_base], 200]]) {
    const trash = await fetch(`http://127.0.0.1:${port}/api/internal/photo-pipeline/manage`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-frame-service-token": "test-move-stream-token" },
      body: JSON.stringify({ action: "trash-photos", date_folder: "1999-12-31", bases }),
    });
    assert.equal(trash.status, status);
    const body = await trash.json();
    if (status === 200) {
      assert.equal(body.action, "trash-photos");
      assert.equal(body.affected, 1);
    }
  }
});

test("moves reject invalid requests, collisions, trash and in-flight publications before changing any photo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-move-validation-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  for (const name of ["First.jpg", "Second.jpg"]) await writeFile(path.join(root, "staging", name), await testJpeg("#2cb4fb"));
  await pipeline.processOnce();
  const sourceDate = currentDateFolder();
  const source = path.join(root, "galleries", sourceDate);
  const bases = (await readdir(source)).filter((name) => name.endsWith(".ready")).map((name) => name.slice(0, -6));
  const targetDate = "1999-12-31";
  const move = (target = targetDate, selection = bases) => pipeline.managePhotos("move-photos", sourceDate, undefined, target, selection);
  for (const date of [sourceDate, "2026-02-30", "../archive", null]) await assert.rejects(move(date), { status: 400 });
  for (const selection of [[], ["../outside"], [null], [bases[0].repeat(20)]]) await assert.rejects(move(targetDate, selection), { status: 400 });
  await assert.rejects(move(targetDate, [bases[0], "missing"]), { status: 404 });
  const target = path.join(root, "galleries", targetDate);
  await mkdir(target);
  const collision = path.join(target, `${bases[1]}.txt`);
  await writeFile(collision, "keep destination bytes");
  await assert.rejects(move(), { status: 409 });
  assert.equal(await readFile(collision, "utf8"), "keep destination bytes");
  assert.deepEqual(await readdir(target), [`${bases[1]}.txt`]);
  await rm(collision);
  await pipeline.managePhotos("trash-photo", sourceDate, bases[1]);
  await assert.rejects(move(), { status: 409 });
  await pipeline.managePhotos("restore-photo", sourceDate, bases[1]);
  const readClaims = pipeline.readClaims.bind(pipeline);
  const readPublication = pipeline.readPublication.bind(pipeline);
  pipeline.readClaims = async () => [{}];
  for (const dateFolder of [sourceDate, targetDate]) {
    pipeline.readPublication = async () => ({ dateFolder, base: bases[1] });
    await assert.rejects(move(), { status: 409 });
  }
  pipeline.readClaims = readClaims;
  pipeline.readPublication = readPublication;
  assert.deepEqual(await readdir(target), []);
  await pipeline.saveExplore(sourceDate, exploreCandidate(bases[0]));
  const fullMap = exploreCandidate("placeholder");
  fullMap.placements = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`placed-${index}`, fullMap.placements.placeholder]));
  await writeFile(path.join(target, "_explore.json"), JSON.stringify(fullMap));
  await assert.rejects(move(), { status: 409 });
  assert.equal(Object.keys(JSON.parse(await readFile(path.join(target, "_explore.json"), "utf8")).placements).length, 10_000);
  for (const base of bases) await readFile(path.join(source, `${base}.ready`));
});

test("failed bulk moves roll back files, ready markers, receipts and originals for retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-move-retry-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await writeFile(path.join(root, "staging", "Retry Move.jpg"), await testJpeg("#2cb4fb"));
  await pipeline.processOnce();
  const before = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const base = before.latest_base;
  const source = path.join(root, "galleries", before.date_folder);
  const sidecar = JSON.parse(await readFile(path.join(source, `${base}.json`), "utf8"));
  const originalManifest = await readFile(path.join(source, `${base}.ready`), "utf8");
  await pipeline.saveExplore(before.date_folder, exploreCandidate(base));
  const originalExplore = JSON.parse(await readFile(path.join(source, "_explore.json"), "utf8"));
  const targetDate = "1999-12-31";
  const target = path.join(root, "galleries", targetDate);
  const recalculate = pipeline.recalculateLatest.bind(pipeline);
  pipeline.recalculateLatest = async () => { throw new Error("injected latest failure"); };

  const progress = [];
  await assert.rejects(pipeline.managePhotos("move-photos", before.date_folder, undefined, targetDate, [base], (event) => progress.push(event)), /injected latest failure/);
  assert.deepEqual(progress.at(-1), { phase: "recovering", completed: 0, total: 1 });

  assert.deepEqual(await readdir(target), []);
  assert.equal(await readFile(path.join(source, `${base}.ready`), "utf8"), originalManifest);
  assert.deepEqual(JSON.parse(await readFile(path.join(source, `${base}.json`), "utf8")), sidecar);
  assert.equal((await pipeline.journeyProgress()).find((item) => item.journey_id === sidecar.journey_id).date_folder, before.date_folder);
  assert.ok(await pipeline.verifiedTrackedArchive(before.date_folder, sidecar.journey_id, base));
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8")), before);
  pipeline.recalculateLatest = recalculate;
  assert.equal((await pipeline.managePhotos("move-photos", before.date_folder, undefined, targetDate, [base])).affected, 1);
  assert.deepEqual(JSON.parse(await readFile(path.join(source, "_explore.json"), "utf8")), originalExplore);
  await assert.rejects(readFile(path.join(target, "_explore.json")), { code: "ENOENT" });
  assert.equal((await pipeline.managePhotos("move-photos", targetDate, undefined, before.date_folder, [base])).affected, 1);
  assert.ok(JSON.parse(await readFile(path.join(source, "_explore.json"), "utf8")).placements[base]);
});

test("restart rolls back interrupted gallery moves and resumes committed cleanup without replacing foreign files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-move-restart-"));
  let pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await writeFile(path.join(root, "staging", "Restart Move.jpg"), await testJpeg("#2cb4fb"));
  await pipeline.processOnce();
  const before = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const base = before.latest_base;
  const source = path.join(root, "galleries", before.date_folder);
  const targetDate = "1999-12-31";
  const target = path.join(root, "galleries", targetDate);
  const sidecar = JSON.parse(await readFile(path.join(source, `${base}.json`), "utf8"));
  const journals = path.join(root, "state", "photo-moves");
  const writeReceipt = pipeline.writeJourneyReceipt.bind(pipeline);
  pipeline.writeJourneyReceipt = async (receipt) => {
    await writeReceipt(receipt);
    if (receipt.date_folder === targetDate) throw new Error("simulated termination after receipt relocation");
  };
  // Leave the exact persisted crash state by suppressing only the in-process recovery attempt.
  pipeline.recoverPhotoMove = async () => undefined;
  await assert.rejects(pipeline.managePhotos("move-photos", before.date_folder, undefined, targetDate, [base]), /simulated termination/);
  assert.equal(JSON.parse(await readFile(path.join(root, "state", "photo-journeys", `${sidecar.journey_id}.json`), "utf8")).date_folder, targetDate);
  await assert.rejects(readFile(path.join(target, `${base}.ready`)), { code: "ENOENT" });
  await assert.rejects(readdir(path.join(root, "archive", before.date_folder, sidecar.journey_id)), { code: "ENOENT" });

  pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  assert.deepEqual(await readdir(journals), []);
  assert.deepEqual(await readdir(target), []);
  assert.ok(await pipeline.verifiedTrackedArchive(before.date_folder, sidecar.journey_id, base));
  await readFile(path.join(source, `${base}.ready`));
  assert.equal((await pipeline.journeyProgress()).find((receipt) => receipt.journey_id === sidecar.journey_id).date_folder, before.date_folder);

  // Crash after destination publication and source marker removal; preserve a foreign replacement.
  const recalculateLatest = pipeline.recalculateLatest.bind(pipeline);
  pipeline.recalculateLatest = async () => {
    await recalculateLatest(new Date().toISOString());
    throw new Error("simulated termination before commit");
  };
  pipeline.recoverPhotoMove = async () => undefined;
  await assert.rejects(pipeline.managePhotos("move-photos", before.date_folder, undefined, targetDate, [base]), /simulated termination/);
  await assert.rejects(readFile(path.join(source, `${base}.ready`)), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8")).count_today, 0);
  const foreign = path.join(target, `${base}.txt`);
  await rm(foreign);
  await writeFile(foreign, "unrelated destination file");
  const sourceCollision = path.join(source, `${base}.ready`);
  await writeFile(sourceCollision, "unrelated source marker");
  await assert.rejects(new PhotoPipeline(config(root)).init(), /preserves a conflicting source file/);
  assert.equal(await readFile(sourceCollision, "utf8"), "unrelated source marker");
  await readFile(path.join(target, `${base}.ready`));
  await rm(sourceCollision);
  pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await readFile(path.join(source, `${base}.ready`));
  const restoredLatest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  assert.equal(restoredLatest.latest_base, base);
  assert.equal(restoredLatest.count_today, 1);
  assert.ok(await pipeline.verifiedTrackedArchive(before.date_folder, sidecar.journey_id, base));
  assert.equal(await readFile(foreign, "utf8"), "unrelated destination file");
  assert.deepEqual(await readdir(target), [`${base}.txt`]);
  await rm(foreign);

  // Commit is durable before source-byte cleanup; restart finishes partially completed cleanup.
  pipeline.recoverPhotoMove = async () => { throw new Error("simulated termination during committed cleanup"); };
  assert.equal((await pipeline.managePhotos("move-photos", before.date_folder, undefined, targetDate, [base])).affected, 1);
  const [moveId] = await readdir(journals);
  assert.equal(JSON.parse(await readFile(path.join(journals, moveId, "move.json"), "utf8")).committed, true);
  await rm(path.join(source, `${base}.jpg`));
  const orphan = path.join(journals, "00000000-0000-4000-8000-000000000000", "originals");
  await mkdir(orphan, { recursive: true });
  await writeFile(path.join(orphan, "partial-cleanup"), "record already removed");
  pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  assert.equal((await readdir(source)).some((entry) => entry.startsWith(`${base}.`)), false);
  await readFile(path.join(target, `${base}.ready`));
  assert.ok(await pipeline.verifiedTrackedArchive(targetDate, sidecar.journey_id, base));
  assert.deepEqual(await readdir(journals), []);
  assert.equal((await pipeline.managePhotos("move-photos", targetDate, undefined, before.date_folder, [base])).affected, 1);
});

test("archive retention configuration defaults to 14 days and ignores legacy trash expiry", () => {
  const names = ["PHOTO_ARCHIVE_RETENTION_DAYS", "PHOTO_TRASH_RETENTION_DAYS"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    delete process.env.PHOTO_ARCHIVE_RETENTION_DAYS;
    process.env.PHOTO_TRASH_RETENTION_DAYS = "1";
    assert.equal(loadConfig().defaultSettings.archive_retention_days, 14);
    assert.equal("trashRetentionDays" in loadConfig(), false);
    for (const value of ["30", "0"]) {
      process.env.PHOTO_ARCHIVE_RETENTION_DAYS = value;
      assert.equal(loadConfig().defaultSettings.archive_retention_days, Number(value));
    }
    process.env.PHOTO_ARCHIVE_RETENTION_DAYS = "14.5";
    assert.throws(() => loadConfig(), /must be an integer/);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("archive settings validate, preserve older clients, and only change after durable persistence", async (t) => {
  const pipeline = await archiveFixture(t);
  assert.equal(pipeline.getSettings().archive_retention_days, 14);
  pipeline.nextRetentionSweepAt = Number.MAX_SAFE_INTEGER;
  await pipeline.updateSettings({ archive_retention_days: 30 });
  assert.equal(pipeline.nextRetentionSweepAt, 0);
  await pipeline.updateSettings({ jpeg_quality: 90 });
  assert.equal(pipeline.getSettings().archive_retention_days, 30);
  const restarted = new PhotoPipeline(config(pipeline.config.dataRoot));
  await restarted.init();
  assert.equal(restarted.getSettings().archive_retention_days, 30);
  for (const value of [-1, 14.5, 36501, "14", null, false]) {
    await assert.rejects(pipeline.updateSettings({ archive_retention_days: value }), { status: 400 });
  }
  const settingsPath = path.join(pipeline.directories.state, "photo-pipeline-settings.json");
  const saved = await readFile(settingsPath);
  await rm(settingsPath);
  await mkdir(settingsPath);
  await assert.rejects(pipeline.updateSettings({ archive_retention_days: 90 }));
  assert.equal(pipeline.getSettings().archive_retention_days, 30);
  await rm(settingsPath, { recursive: true });
  await writeFile(settingsPath, saved);
  await pipeline.updateSettings({ archive_retention_days: 0 });
  assert.equal(pipeline.getSettings().archive_retention_days, 0);
});

test("archive expiry observes the 14-day creation boundary and never changes gallery or trash", async (t) => {
  const pipeline = await archiveFixture(t);
  const first = await publishArchive(pipeline, "Original One.jpg");
  const second = await publishArchive(pipeline, "Original Two.jpg");
  await pipeline.managePhotos("trash-photo", second.date, second.base);
  await writeFile(path.join(pipeline.directories.galleries, second.date, second.base + ".trashed.json"), "{");
  const gallery = path.join(pipeline.directories.galleries, first.date);
  const names = await readdir(gallery);
  const contents = await Promise.all(names.map((name) => readFile(path.join(gallery, name))));
  const latest = await readFile(path.join(pipeline.directories.state, "latest.json"));
  const expiredAt = Math.max(first.createdAt, second.createdAt) + 14 * 86_400_000;

  // init and ingest checks never perform retention work, even with already-expired backups.
  await pipeline.maintainStorage(expiredAt);
  await readFile(first.file);
  await sweepArchives(pipeline, Math.min(first.createdAt, second.createdAt) + 14 * 86_400_000 - 1);
  await readFile(first.file);
  await readFile(second.file);
  await sweepArchives(pipeline, expiredAt);
  await assert.rejects(readFile(first.file), { code: "ENOENT" });
  await assert.rejects(readFile(second.file), { code: "ENOENT" });
  assert.deepEqual(await readdir(gallery), names);
  assert.deepEqual(await Promise.all(names.map((name) => readFile(path.join(gallery, name)))), contents);
  assert.deepEqual(await readFile(path.join(pipeline.directories.state, "latest.json")), latest);
  assert.equal(pipeline.status.archives_pruned, 2);
  assert.equal(pipeline.status.trash_purged, 0);
});

test("archive creation survives gallery moves, receipt updates, and owner-purged galleries", async (t) => {
  const pipeline = await archiveFixture(t);
  await pipeline.updateSettings({ archive_retention_days: 30 });
  const moved = await publishArchive(pipeline, "Moved Original.jpg");
  const removed = await publishArchive(pipeline, "Purged Original.jpg");
  const targetDate = "2001-02-03";
  await pipeline.managePhotos("move-photos", moved.date, undefined, targetDate, [moved.base]);
  const movedDirectory = path.join(pipeline.directories.archive, targetDate, moved.journey);
  assert.deepEqual(JSON.parse(await readFile(path.join(movedDirectory, ".frame-archive.json"), "utf8")), moved.metadata);
  const receipt = await pipeline.readJourneyReceipt(moved.journey);
  await pipeline.writeJourneyReceipt({ ...receipt, updated_at: "2099-01-01T00:00:00.000Z" });
  await pipeline.managePhotos("trash-photo", removed.date, removed.base);
  await pipeline.managePhotos("purge-photo", removed.date, removed.base);
  const movedFile = path.join(movedDirectory, path.basename(moved.file));
  await sweepArchives(pipeline, Math.max(moved.createdAt, removed.createdAt) + 14 * 86_400_000);
  await readFile(movedFile);
  await readFile(removed.file);
  await sweepArchives(pipeline, Math.max(moved.createdAt, removed.createdAt) + 30 * 86_400_000);
  await assert.rejects(readFile(movedFile), { code: "ENOENT" });
  await assert.rejects(readFile(removed.file), { code: "ENOENT" });
  await readFile(path.join(pipeline.directories.galleries, targetDate, moved.base + ".jpg"));
});

test("legacy archive expiry uses birthtime then mtime and preserves unknown files and symlinks", async (t) => {
  const pipeline = await archiveFixture(t);
  const tracked = await publishArchive(pipeline, "Older Tracked.jpg");
  await rm(path.join(path.dirname(tracked.file), ".frame-archive.json"));
  const legacy = path.join(pipeline.directories.archive, tracked.date, "legacy-original.jpg");
  await writeFile(legacy, await testJpeg("#75ffb1"));
  const oldTime = new Date("2000-01-01T00:00:00.000Z");
  await utimes(legacy, oldTime, oldTime);
  const legacyInfo = await stat(legacy);
  const preserved = [
    path.join(path.dirname(tracked.file), "unrelated.jpg"),
    path.join(path.dirname(tracked.file), "owner-notes.txt"),
    path.join(pipeline.directories.archive, tracked.date, "not-a-photo.jpg"),
    path.join(pipeline.directories.archive, tracked.date, "owner.bin"),
    path.join(pipeline.directories.archive, "root-original.jpg"),
  ];
  for (const file of preserved) await writeFile(file, "owner data");
  const unknownDirectory = path.join(pipeline.directories.archive, tracked.date, "unknown-empty-folder");
  await mkdir(unknownDirectory);
  const external = path.join(pipeline.config.dataRoot, "external");
  await mkdir(external);
  const externalPhoto = path.join(external, "original.jpg");
  await writeFile(externalPhoto, await testJpeg("#2cb4fb"));
  const linkedDate = path.join(pipeline.directories.archive, "1990-01-01");
  const linkedJourney = path.join(pipeline.directories.archive, tracked.date, "linked-journey");
  await symlink(external, linkedDate, process.platform === "win32" ? "junction" : "dir");
  await symlink(external, linkedJourney, process.platform === "win32" ? "junction" : "dir");
  const linkedFile = path.join(pipeline.directories.archive, tracked.date, "linked.jpg");
  try {
    await symlink(externalPhoto, linkedFile, "file");
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    t.diagnostic("Windows file symlink privilege unavailable; directory junction protections are still tested.");
  }

  await sweepArchives(pipeline, legacyInfo.birthtimeMs + 86_400_000);
  if (legacyInfo.birthtimeMs > 0) await readFile(legacy);
  // Simulate filesystems such as Windows Docker bind mounts which report no birthtime.
  const originalLstat = fsPromises.lstat;
  const mockedLstat = t.mock.method(fsPromises, "lstat", async (...args) => {
    const info = await originalLstat(...args);
    if (args[0] === legacy) info.birthtimeMs = 0;
    return info;
  });
  syncBuiltinESMExports();
  try {
    await sweepArchives(pipeline, Math.max(Date.now(), tracked.createdAt) + 14 * 86_400_000 + 1_000);
  } finally {
    mockedLstat.mock.restore();
    syncBuiltinESMExports();
  }
  await assert.rejects(readFile(legacy), { code: "ENOENT" });
  await assert.rejects(readFile(tracked.file), { code: "ENOENT" });
  for (const file of preserved) assert.equal(await readFile(file, "utf8"), "owner data");
  assert.deepEqual(await readdir(unknownDirectory), []);
  await readFile(externalPhoto);
  assert.equal((await lstat(linkedDate)).isSymbolicLink(), true);
  assert.equal((await lstat(linkedJourney)).isSymbolicLink(), true);
  if (await lstat(linkedFile).catch(() => null)) assert.equal((await lstat(linkedFile)).isSymbolicLink(), true);
});

test("tracked archive metadata protects unknown originals and malformed metadata", async (t) => {
  const pipeline = await archiveFixture(t);
  const owned = await publishArchive(pipeline, "Owned Original.jpg");
  const malformed = await publishArchive(pipeline, "Malformed Metadata.jpg");
  const unknown = path.join(path.dirname(owned.file), path.parse(owned.file).name + "_2.jpg");
  await writeFile(unknown, await testJpeg("#75ffb1"));
  await writeFile(path.join(path.dirname(malformed.file), ".frame-archive.json"), "{");
  await sweepArchives(pipeline, Math.max(owned.createdAt, malformed.createdAt) + 14 * 86_400_000);
  await assert.rejects(readFile(owned.file), { code: "ENOENT" });
  await readFile(unknown);
  await readFile(malformed.file);
  await sweepArchives(pipeline, Math.max(owned.createdAt, malformed.createdAt) + 30 * 86_400_000);
  await readFile(unknown);
  assert.equal(pipeline.status.archives_pruned, 1);
});

test("a completed settings change stops expiry already waiting on archive ownership checks", async (t) => {
  const pipeline = await archiveFixture(t);
  const photo = await publishArchive(pipeline, "Changing Policy.jpg");
  await rm(path.join(path.dirname(photo.file), ".frame-archive.json"));
  const readReceipt = pipeline.readJourneyReceipt.bind(pipeline);
  for (const days of [0, 90]) {
    await pipeline.updateSettings({ archive_retention_days: 14 });
    let entered, release;
    const paused = new Promise((resolve) => { entered = resolve; });
    const resume = new Promise((resolve) => { release = resolve; });
    pipeline.readJourneyReceipt = async (...args) => {
      const receipt = await readReceipt(...args);
      entered();
      await resume;
      return receipt;
    };
    const pending = pipeline.expireArchiveCandidate({
      dateFolder: photo.date, journeyId: photo.journey, fileName: path.basename(photo.file),
    }, photo.createdAt + 20 * 86_400_000);
    await paused;
    await pipeline.updateSettings({ archive_retention_days: days });
    release();
    assert.equal(await pending, false);
    await readFile(photo.file);
  }
  pipeline.readJourneyReceipt = readReceipt;
  await pipeline.updateSettings({ archive_retention_days: 0 });
  await sweepArchives(pipeline, photo.createdAt + 100 * 86_400_000);
  await readFile(photo.file);
});

test("a shorter retention setting restarts a sweep that is just finishing", async (t) => {
  const pipeline = await archiveFixture(t);
  await pipeline.updateSettings({ archive_retention_days: 30 });
  await pipeline.resetArchiveIterator();
  let entered, release;
  const paused = new Promise((resolve) => { entered = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  pipeline.archiveIterator = (async function* () {
    entered();
    await resume;
  })();
  const pending = pipeline.sweepArchiveBatch();
  await paused;
  await pipeline.updateSettings({ archive_retention_days: 1 });
  release();
  await pending;
  assert.equal(pipeline.nextRetentionSweepAt, 0);
  assert.equal(pipeline.archiveIterator, null);
});

test("archive work is bounded per batch, single-flight, and retries a failed candidate next sweep", async (t) => {
  const pipeline = await archiveFixture(t);
  const date = "2000-01-01";
  const directory = path.join(pipeline.directories.archive, date, "journey-many-originals");
  await mkdir(directory, { recursive: true });
  const originals = Object.fromEntries(Array.from({ length: 60 }, (_, index) => ["original-" + index + ".jpg", "2000-01-01T00:00:00.000Z"]));
  for (const name of Object.keys(originals)) await writeFile(path.join(directory, name), "tracked original");
  await writeFile(path.join(directory, ".frame-archive.json"), JSON.stringify({ schema_version: 1, originals }));
  let entered, release;
  const paused = new Promise((resolve) => { entered = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  const expire = pipeline.expireArchiveCandidate.bind(pipeline);
  let attempted = 0;
  pipeline.expireArchiveCandidate = async (...args) => {
    attempted += 1;
    if (attempted === 1) {
      entered();
      await resume;
      throw new Error("simulated transient file failure");
    }
    return expire(...args);
  };
  const pending = pipeline.sweepArchiveBatch();
  await paused;
  await pipeline.sweepArchiveBatch();
  assert.equal(attempted, 1);
  release();
  await pending;
  assert.ok(attempted <= 25);
  assert.ok((await readdir(directory)).length > 1);
  await sweepArchives(pipeline, Date.now());
  assert.equal(pipeline.status.archives_pruned, 59);
  await sweepArchives(pipeline, Date.now());
  assert.equal(pipeline.status.archives_pruned, 60);
  await assert.rejects(readdir(directory), { code: "ENOENT" });
});

async function archiveFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-retention-"));
  const pipeline = new PhotoPipeline(config(root));
  t.after(async () => {
    pipeline.stop();
    await pipeline.resetArchiveIterator();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("frame-photo-retention-"));
    await rm(root, { recursive: true, force: true });
  });
  await pipeline.init();
  return pipeline;
}

async function publishArchive(pipeline, name) {
  const source = path.join(pipeline.directories.staging, name);
  await writeFile(source, await testJpeg("#2cb4fb"));
  await utimes(source, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
  await pipeline.processOnce();
  const latest = JSON.parse(await readFile(path.join(pipeline.directories.state, "latest.json"), "utf8"));
  const sidecar = JSON.parse(await readFile(path.join(pipeline.directories.galleries, latest.date_folder, latest.latest_base + ".json"), "utf8"));
  const directory = path.join(pipeline.directories.archive, latest.date_folder, sidecar.journey_id);
  const metadata = JSON.parse(await readFile(path.join(directory, ".frame-archive.json"), "utf8"));
  const [fileName, createdAt] = Object.entries(metadata.originals)[0];
  assert.ok(Date.parse(createdAt) > Date.now() - 60_000);
  return { date: latest.date_folder, base: latest.latest_base, journey: sidecar.journey_id, file: path.join(directory, fileName), metadata, createdAt: Date.parse(createdAt) };
}

async function sweepArchives(pipeline, now) {
  pipeline.nextRetentionSweepAt = 0;
  if (!pipeline.getSettings().archive_retention_days) {
    await pipeline.sweepArchiveBatch(now);
    return;
  }
  for (let index = 0; index < 500; index += 1) {
    await pipeline.sweepArchiveBatch(now);
    if (!pipeline.archiveIterator && pipeline.nextRetentionSweepAt > now) return;
  }
  assert.fail("Archive sweep did not finish");
}

test("low disk pressure pauses before claiming staged work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-disk-"));
  const pipeline = new PhotoPipeline({
    ...config(root),
    diskMinimumFreeBytes: Number.MAX_SAFE_INTEGER,
  });
  await pipeline.init();
  await writeFile(path.join(root, "staging", "Queued Photo.jpg"), await testJpeg("#2cb4fb"));

  await pipeline.processOnce();

  assert.equal(pipeline.status.processing_paused, true);
  assert.equal(pipeline.status.disk.state, "error");
  assert.match(pipeline.status.disk.message, /processing is paused/i);
  assert.deepEqual(await readdir(path.join(root, "processing")), []);
  assert.ok((await readdir(path.join(root, "staging"))).includes("Queued Photo.jpg"));

  pipeline.config.diskMinimumFreeBytes = 0;
  pipeline.nextStorageCheckAt = 0;
  await pipeline.processOnce();
  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  assert.equal(pipeline.status.processing_paused, false);
  assert.equal(pipeline.status.disk.state, "ok");
  assert.equal((await readdir(path.join(root, "staging"))).includes("Queued Photo.jpg"), false);
  await readFile(path.join(root, "galleries", latest.date_folder, `${latest.latest_base}.ready`));
});

function config(dataRoot) {
  return {
    port: 0,
    dataRoot,
    hostDataRoot: dataRoot,
    timezone: "America/Chicago",
    pollMs: 1000,
    concurrency: 2,
    logLevel: "info",
    maxInputBytes: 50 * 1024 * 1024,
    maxPixels: 80_000_000,
    conversionAttempts: 3,
    archiveOriginals: true,
    diskWarnPercent: 100,
    diskErrorPercent: 100,
    diskMinimumFreeBytes: 0,
    defaultSettings: {
      archive_retention_days: 14,
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
