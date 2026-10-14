import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkArtifacts } from "../apps/frame-setup/scripts/check-artifacts.mjs";

test("installer candidate checks require exact platform filenames and checksum the actual bytes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "frame-artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from([0, 1, 255, 4]);
  for (const [platform, arch, suffixes] of [["win", "x64", ["win-x64.exe"]], ["linux", "x64", ["linux-x86_64.AppImage"]],
    ["mac", "x64", ["mac-x64.dmg", "mac-x64.zip"]], ["mac", "arm64", ["mac-arm64.dmg", "mac-arm64.zip"]]]) {
    const names = suffixes.map((suffix) => `FRAME-Setup-1.2.3-${suffix}`);
    for (const name of names) await writeFile(path.join(directory, name), bytes);
    const report = await checkArtifacts({ directory, version: "1.2.3", platform, arch });
    assert.deepEqual(report.artifacts.map((item) => item.name), names);
    assert.ok(report.artifacts.every((item) => item.bytes === bytes.length && item.sha256 === createHash("sha256").update(bytes).digest("hex")));
    assert.match(report.scope, /acceptance are not established/);
    for (const name of names) await rm(path.join(directory, name));
  }
});

test("missing, stale, wrong-architecture, and empty installer outputs cannot pass the artifact gate", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "frame-artifacts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, version: "1.2.3", platform: "linux", arch: "x64" };
  await assert.rejects(checkArtifacts(options), /do not match/);
  for (const name of ["FRAME-Setup-1.2.3-linux-x64.AppImage", "FRAME-Setup-1.2.2-linux-x86_64.AppImage"]) {
    await writeFile(path.join(directory, name), "test");
    await assert.rejects(checkArtifacts(options), /do not match/);
    await rm(path.join(directory, name));
  }
  const name = "FRAME-Setup-1.2.3-linux-x86_64.AppImage";
  await writeFile(path.join(directory, name), "");
  await assert.rejects(checkArtifacts(options), /empty/);
  await assert.rejects(checkArtifacts({ ...options, arch: "arm64" }), /supported/);
});
