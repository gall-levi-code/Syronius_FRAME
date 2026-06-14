import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { PhotoPipeline } from "../dist/pipeline.js";

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

  await pipeline.processOnce();
  assert.equal((await readdir(path.join(root, "galleries", latest.date_folder))).filter((name) => name.endsWith(".ready")).length, 1);
});

test("extracts camera EXIF into the reusable camera information sidecar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  await sharp({ create: { width: 320, height: 180, channels: 3, background: "#2cb4fb" } })
    .jpeg()
    .withExif({
      IFD0: { Make: "FRAME", Model: "Test Camera" },
      IFD2: { ISOSpeedRatings: "200", FNumber: "2.8", ExposureTime: "0.008", FocalLength: "35" },
    })
    .toFile(path.join(root, "staging", "Camera Photo.jpg"));

  await pipeline.processOnce();

  const latest = JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8"));
  const gallery = path.join(root, "galleries", latest.date_folder);
  const cameraText = await readFile(path.join(gallery, `${latest.latest_base}.txt`), "utf8");
  const sidecar = JSON.parse(await readFile(path.join(gallery, `${latest.latest_base}.json`), "utf8"));
  assert.match(cameraText, /Camera: FRAME Test Camera/);
  assert.match(cameraText, /ISO: 200/);
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
  await assert.rejects(readFile(path.join(root, "state", "latest.json")));
});

test("recovers a ready publication without publishing the claimed source twice", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-photo-pipeline-"));
  const pipeline = new PhotoPipeline(config(root));
  await pipeline.init();
  const originalName = "Recovered Photo.png";
  const claim = path.join(root, "processing", `job-recovery--${Buffer.from(originalName).toString("base64url")}`);
  const dateFolder = "2026-06-13";
  const base = "Recovered_Photo_2026-06-13_01_02_03";
  const gallery = path.join(root, "galleries", dateFolder);
  await Promise.all([mkdir(claim, { recursive: true }), mkdir(gallery, { recursive: true })]);
  await sharp({ create: { width: 100, height: 50, channels: 3, background: "#2cb4fb" } }).png().toFile(path.join(claim, "source"));
  await writeFile(path.join(claim, "publication.json"), JSON.stringify({ dateFolder, base }));
  for (const extension of ["jpg", "json", "txt", "orientation", "ready"]) {
    await writeFile(path.join(gallery, `${base}.${extension}`), extension);
  }

  await pipeline.processOnce();

  assert.deepEqual((await readdir(gallery)).filter((name) => name.endsWith(".ready")), [`${base}.ready`]);
  assert.equal(JSON.parse(await readFile(path.join(root, "state", "latest.json"), "utf8")).latest_base, base);
  assert.equal((await readdir(path.join(root, "archive", dateFolder))).length, 1);
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
  const trashed = await pipeline.managePhotos("trash-photo", published.date_folder, published.latest_base);
  assert.equal(trashed.latest_base, null);
  assert.equal(trashed.count_today, 0);
  assert.notEqual(trashed.updated_at, published.updated_at);
  assert.equal((await readFile(ready, "utf8")).length > 0, true);
  assert.equal(JSON.parse(await readFile(path.join(gallery, `${published.latest_base}.trashed.json`), "utf8")).base, published.latest_base);

  const restored = await pipeline.managePhotos("restore-photo", published.date_folder, published.latest_base);
  assert.equal(restored.latest_base, published.latest_base);
  assert.equal(restored.count_today, 1);
  assert.notEqual(restored.updated_at, trashed.updated_at);
  await assert.rejects(readFile(path.join(gallery, `${published.latest_base}.trashed.json`), "utf8"));

  await pipeline.managePhotos("trash-photo", published.date_folder, published.latest_base);
  const purged = await pipeline.managePhotos("purge-photo", published.date_folder, published.latest_base);
  assert.equal(purged.latest_base, null);
  await assert.rejects(readFile(ready, "utf8"));
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
  };
}
