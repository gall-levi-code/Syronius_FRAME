import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFullBackup, readFullBackup, restoreFullBackup, FULL_BACKUP_MANIFEST, FULL_RESTORE_MARKER } from "../apps/frame-setup/electron/full-backup.mjs";

const commit = "a".repeat(40);
async function write(root, relative, bytes, mode = 0o600) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, bytes); await fs.chmod(file, mode);
}
const read = (root, file) => fs.readFile(path.join(root, file), "utf8");
const missing = (file) => assert.rejects(fs.lstat(file), { code: "ENOENT" });

async function fixture(t, { nested = false } = {}) {
  const base = await fs.realpath(os.tmpdir()), temporary = await fs.mkdtemp(path.join(base, "frame-full-backup-"));
  t.after(async () => {
    assert.equal(path.dirname(temporary), base); assert.ok(path.basename(temporary).startsWith("frame-full-backup-"));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const workspace = path.join(temporary, "deployment"), dataRoot = nested ? path.join(workspace, "media") : path.join(temporary, "data");
  const backupRoot = path.join(temporary, "backup");
  await write(workspace, ".env", `FRAME_DATA_ROOT=${dataRoot}\nPASSWORD=private-secret\n`);
  await write(workspace, "frame-source-commit", `${commit}\n`);
  await write(workspace, "frame-release.json", JSON.stringify({ commit }));
  await write(workspace, "docker-compose.yml", "retained generated configuration");
  await write(workspace, "installer/stack.sh", "#!/bin/sh\n", 0o755);
  await write(workspace, "user-notes.txt", "retain deployment notes");
  await write(workspace, ".frame-deployment-backup/snapshot.json", JSON.stringify({ pending: false }));
  await write(workspace, ".frame-source-backup/snapshot.json", JSON.stringify({ pending: false }));
  await write(dataRoot, "state/cloudflare-tunnel-token", "private-token");
  await write(dataRoot, "state/frame-install-plan.json", "{\"selectedServices\":[\"frame-gallery\"]}");
  await write(dataRoot, "gallery/database.sqlite", Buffer.from([0, 255, 33, 0, 1, 9]));
  await write(dataRoot, "photos/large-media.bin", Buffer.alloc(3 * 1024 ** 2 + 17, 71));
  await fs.mkdir(path.join(dataRoot, "empty-folder"));
  const args = { workspace, dataRoot, backupRoot };
  const vacate = async () => {
    // Move originals aside rather than deleting them, as the restore UI instructs.
    await fs.rename(workspace, path.join(temporary, "retained-deployment"));
    if (!nested) await fs.rename(dataRoot, path.join(temporary, "retained-data"));
  };
  return { temporary, ...args, args, vacate };
}

test("full backup/restore retains configuration, secrets, source, binary databases, media and empty folders", async (t) => {
  for (const nested of [false, true]) {
    const f = await fixture(t, { nested }), manifest = await createFullBackup(f.args);
    assert.equal(manifest.complete, true); assert.equal(manifest.sourceCommit, commit); assert.equal(manifest.platform, process.platform);
    assert.equal(manifest.fileCount, 10); assert.ok(manifest.totalBytes > 3 * 1024 ** 2);
    assert.ok(!manifest.entries.some((entry) => entry.scope === "workspace" && /(?:^media|backup)/.test(entry.path)));
    assert.deepEqual(await readFullBackup({ backupRoot: f.backupRoot }), manifest);
    assert.equal(await read(f.backupRoot, "workspace/.env"), await read(f.workspace, ".env"));
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(f.backupRoot)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(f.backupRoot, "data/state/cloudflare-tunnel-token"))).mode & 0o777, 0o600);
      assert.equal(manifest.roots.data.uid, (await fs.stat(f.dataRoot)).uid);
      assert.equal(manifest.roots.data.gid, (await fs.stat(f.dataRoot)).gid);
    }
    await f.vacate();
    assert.deepEqual(await restoreFullBackup(f.args), manifest);
    assert.equal(await read(f.workspace, "user-notes.txt"), "retain deployment notes");
    assert.equal(await read(f.dataRoot, "state/cloudflare-tunnel-token"), "private-token");
    assert.deepEqual(await fs.readFile(path.join(f.dataRoot, "gallery/database.sqlite")), Buffer.from([0, 255, 33, 0, 1, 9]));
    assert.deepEqual(await fs.readFile(path.join(f.dataRoot, "photos/large-media.bin")), Buffer.alloc(3 * 1024 ** 2 + 17, 71));
    assert.deepEqual(await fs.readdir(path.join(f.dataRoot, "empty-folder")), []);
    await missing(path.join(f.workspace, FULL_RESTORE_MARKER));
    await missing(path.join(f.workspace, ".frame-deployment-backup"));
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(path.join(f.workspace, "installer/stack.sh"))).mode & 0o777, 0o755);
      for (const entry of manifest.entries) {
        const info = await fs.stat(path.join(entry.scope === "workspace" ? f.workspace : f.dataRoot, entry.path));
        assert.equal(info.uid, entry.uid); assert.equal(info.gid, entry.gid);
      }
    }
  }
});

test("backup destinations cannot overlap sources, contain existing files, use a Git checkout, or capture pending recovery", async (t) => {
  const f = await fixture(t);
  for (const backupRoot of [f.workspace, f.dataRoot, f.temporary, path.join(f.workspace, "backup"), path.join(f.dataRoot, "backup")]) {
    await assert.rejects(createFullBackup({ ...f.args, backupRoot }), /outside/);
  }
  await write(f.backupRoot, "keep.txt", "unrelated backup content");
  await assert.rejects(createFullBackup(f.args), /must be empty/);
  assert.equal(await read(f.backupRoot, "keep.txt"), "unrelated backup content");
  const empty = path.join(f.temporary, "empty-backup");
  await write(f.workspace, ".git", "gitdir: external");
  await assert.rejects(createFullBackup({ ...f.args, backupRoot: empty }), /Unsafe/);
  await fs.unlink(path.join(f.workspace, ".git"));
  await write(f.workspace, ".frame-source-backup/snapshot.json", JSON.stringify({ pending: true }));
  await assert.rejects(createFullBackup({ ...f.args, backupRoot: empty }), /Complete FRAME recovery/);
  await missing(empty);
});

test("restore refuses existing data, relocation and a different operating system before any writes", async (t) => {
  const f = await fixture(t), manifest = await createFullBackup(f.args);
  await assert.rejects(restoreFullBackup(f.args), /must be empty/);
  assert.equal(await read(f.workspace, "user-notes.txt"), "retain deployment notes");
  await f.vacate();
  const different = path.join(f.temporary, "different");
  await assert.rejects(restoreFullBackup({ ...f.args, workspace: different }), /original installation/);
  await missing(different);
  await write(f.backupRoot, FULL_BACKUP_MANIFEST, JSON.stringify({ ...manifest, platform: process.platform === "linux" ? "darwin" : "linux" }));
  await assert.rejects(restoreFullBackup(f.args));
  await missing(f.workspace); await missing(f.dataRoot);
});

test("incomplete, corrupted and malformed backups refuse restore without creating destinations", async (t) => {
  const f = await fixture(t), manifest = await createFullBackup(f.args);
  await f.vacate();
  const marker = (value) => write(f.backupRoot, FULL_BACKUP_MANIFEST, JSON.stringify(value));
  for (const value of [
    { ...manifest, complete: false }, { ...manifest, totalBytes: 0 },
    { ...manifest, entries: [...manifest.entries, manifest.entries[0]] },
    { ...manifest, entries: manifest.entries.map((entry, i) => i === 0 ? { ...entry, path: "../escaped" } : entry) },
    { ...manifest, entries: manifest.entries.map((entry, i) => i === 0 ? { ...entry, path: "NUL.txt" } : entry) },
    { ...manifest, entries: manifest.entries.filter((entry) => !(entry.scope === "data" && entry.path === "state")) },
  ]) {
    await marker(value); await assert.rejects(restoreFullBackup(f.args)); await missing(f.workspace); await missing(f.dataRoot);
  }
  await marker(manifest);
  await write(f.backupRoot, "data/gallery/database.sqlite", Buffer.from([1, 255, 33, 0, 1, 9]));
  assert.equal((await readFullBackup({ backupRoot: f.backupRoot, verifyBytes: false })).id, manifest.id);
  await assert.rejects(restoreFullBackup(f.args), /verification failed/);
  await missing(f.workspace); await missing(f.dataRoot);
});

test("source, backup and restore symlinks/junctions are rejected without touching their targets", async (t) => {
  for (const phase of ["source", "backup", "restore"]) {
    const f = await fixture(t), outside = path.join(f.temporary, "outside");
    await write(outside, "user-file", "unrelated data");
    if (phase !== "source") await createFullBackup(f.args);
    if (phase === "restore") await f.vacate();
    const target = phase === "source" ? path.join(f.dataRoot, "linked") : phase === "backup" ? path.join(f.backupRoot, "data/gallery") : f.workspace;
    if (phase === "backup") await fs.rename(target, `${target}-retained`);
    try { await fs.symlink(outside, target, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (error.code === "EPERM") { t.skip("This host does not permit test symlinks."); return; } throw error; }
    await assert.rejects(phase === "source" ? createFullBackup(f.args) : phase === "backup" ? readFullBackup(f.args) : restoreFullBackup(f.args), /links or special/);
    assert.equal(await read(outside, "user-file"), "unrelated data"); assert.deepEqual(await fs.readdir(outside), ["user-file"]);
  }
});

test("changes while copying leave an explicitly incomplete backup that cannot be restored", async (t) => {
  const f = await fixture(t);
  await write(f.dataRoot, "photos/large-media.bin", Buffer.alloc(32 * 1024 ** 2, 19));
  let changed = false, change;
  const timer = setInterval(async () => {
    if (changed || !await fs.lstat(path.join(f.backupRoot, "data/photos/large-media.bin")).catch(() => null)) return;
    changed = true;
    change = write(f.workspace, "user-notes.txt", "changed while copying");
    await change;
  }, 1);
  try { await assert.rejects(createFullBackup(f.args), /changed during backup/); }
  finally { clearInterval(timer); await change; }
  assert.equal(changed, true);
  assert.equal(JSON.parse(await read(f.backupRoot, FULL_BACKUP_MANIFEST)).complete, false);
  await assert.rejects(readFullBackup(f.args), /incomplete/);
  assert.equal(await read(f.workspace, "user-notes.txt"), "changed while copying");
});

test("a rejected final service-state check leaves copied and verified backup data incomplete", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(createFullBackup({ ...f.args, beforeComplete: async () => {
    calls++;
    assert.equal(JSON.parse(await read(f.backupRoot, FULL_BACKUP_MANIFEST)).complete, false);
    assert.deepEqual(await fs.readFile(path.join(f.backupRoot, "data/gallery/database.sqlite")), Buffer.from([0, 255, 33, 0, 1, 9]));
    throw new Error("FRAME containers no longer remain stopped.");
  } }), /no longer remain stopped/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(await read(f.backupRoot, FULL_BACKUP_MANIFEST)).complete, false);
  await assert.rejects(readFullBackup(f.args), /incomplete/);
  assert.equal(await read(f.workspace, "user-notes.txt"), "retain deployment notes");
});

test("POSIX ownership that this account cannot restore leaves the incomplete marker", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const f = await fixture(t), manifest = await createFullBackup(f.args);
  manifest.entries.find((entry) => entry.scope === "data" && entry.path === "gallery/database.sqlite").uid = process.getuid() + 1;
  await write(f.backupRoot, FULL_BACKUP_MANIFEST, JSON.stringify(manifest));
  await f.vacate();
  await assert.rejects(restoreFullBackup(f.args), /Could not restore ownership or permissions/);
  assert.equal(JSON.parse(await read(f.workspace, FULL_RESTORE_MARKER)).complete, false);
  assert.equal(await read(path.join(f.temporary, "retained-data"), "state/cloudflare-tunnel-token"), "private-token");
});
