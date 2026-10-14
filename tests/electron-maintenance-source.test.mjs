import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SOURCE_BACKUP, snapshotSource, readSourceSnapshot, restoreSource, completeSource } from "../apps/frame-setup/electron/maintenance-source.mjs";
import { applyStagedUpdate } from "../installer/frame-updater.mjs";
import { recordSourceCommit } from "../installer/frame-release.mjs";

const oldCommit = "a".repeat(40), newCommit = "b".repeat(40);
const read = (root, file) => fs.readFile(path.join(root, file), "utf8");
const missing = (root, file) => assert.rejects(fs.lstat(path.join(root, file)), { code: "ENOENT" });
async function write(root, file, value, mode = 0o644) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
  await fs.chmod(target, mode);
}

async function fixture(t, { commit = oldCommit } = {}) {
  const base = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(base, "frame-source-recovery-"));
  t.after(async () => {
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith("frame-source-recovery-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, "installed"), stagedRoot = path.join(root, "staged"), dataRoot = path.join(workspace, "media");
  const files = ["services/tool/index.mjs", "assets/logo.bin", "installer/stack.sh", "scripts/new.mjs"];
  await fs.mkdir(workspace); await fs.mkdir(stagedRoot);
  await write(workspace, files[0], "old source", 0o755);
  await write(workspace, files[1], Buffer.from([0, 255, 40, 0]));
  await write(workspace, files[2], "old wrapper", 0o700);
  await write(workspace, `${files[2]}.next`, "old queued wrapper", 0o750);
  await write(workspace, ".env", "FRAME_DATA_ROOT=./media\nSECRET=untouched\n", 0o600);
  await write(workspace, "docker-compose.yml", "original generated configuration");
  await write(workspace, "frame-release.json", "original release manifest");
  await write(workspace, "media/photo.bin", "user media");
  await write(workspace, "operator-notes.txt", "user notes");
  await write(workspace, "stack.cmd", "unchanged bootstrap");
  if (commit) await recordSourceCommit(workspace, commit);
  for (const file of files) await write(stagedRoot, file, `new ${file}`, file.endsWith(".sh") ? 0o755 : 0o644);
  const args = { workspace, stagedRoot, dataRoot, files, targetCommit: newCommit };
  const overlay = async ({ activateWrappers = true } = {}) => {
    await fs.unlink(path.join(workspace, "frame-source-commit")).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await applyStagedUpdate({ workspace, stagedRoot, files, protectedPaths: [".env", "docker-compose.yml", ".git", "media", SOURCE_BACKUP] });
    if (activateWrappers) await fs.rename(path.join(workspace, "installer/stack.sh.next"), path.join(workspace, "installer/stack.sh"));
    await recordSourceCommit(workspace, newCommit);
  };
  return { root, workspace, stagedRoot, dataRoot, files, args, overlay };
}

test("cross-version source rollback is offline, preserves binary bytes/modes, and leaves config, data and unknown files alone", async (t) => {
  const f = await fixture(t), snapshot = await snapshotSource(f.args);
  assert.equal(snapshot.pending, true); assert.equal(snapshot.previousCommit, oldCommit);
  assert.equal(snapshot.targetCommit, newCommit); assert.equal(snapshot.dataRoot, f.dataRoot);
  assert.ok(snapshot.files.some((file) => file.path === "installer/stack.sh.next" && file.handoff));
  assert.ok(!snapshot.files.some((file) => [".env", "docker-compose.yml", "media/photo.bin", "stack.cmd"].includes(file.path)));
  await f.overlay();
  assert.equal((await completeSource(f.args)).pending, false);
  await fs.rm(f.stagedRoot, { recursive: true }); // Recovery does not require the download or a registry.
  const restored = await restoreSource(f.args);
  assert.equal(restored.pending, true); assert.equal(restored.restored, true);
  assert.equal(await read(f.workspace, f.files[0]), "old source");
  assert.deepEqual(await fs.readFile(path.join(f.workspace, f.files[1])), Buffer.from([0, 255, 40, 0]));
  assert.equal(await read(f.workspace, "installer/stack.sh"), "old wrapper");
  assert.equal(await read(f.workspace, "installer/stack.sh.next"), "old queued wrapper");
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(f.workspace, f.files[0]))).mode & 0o777, 0o755);
    assert.equal((await fs.stat(path.join(f.workspace, "installer/stack.sh"))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(f.workspace, "installer/stack.sh.next"))).mode & 0o777, 0o750);
  }
  await missing(f.workspace, "scripts/new.mjs");
  assert.equal(await read(f.workspace, "frame-source-commit"), `${oldCommit}\n`);
  assert.equal(await read(f.workspace, ".env"), "FRAME_DATA_ROOT=./media\nSECRET=untouched\n");
  assert.equal(await read(f.workspace, "docker-compose.yml"), "original generated configuration");
  assert.equal(await read(f.workspace, "frame-release.json"), "original release manifest");
  assert.equal(await read(f.workspace, "media/photo.bin"), "user media");
  assert.equal(await read(f.workspace, "operator-notes.txt"), "user notes");
  assert.equal(await read(f.workspace, "stack.cmd"), "unchanged bootstrap");
  assert.equal((await completeSource(f.args)).pending, false);
});

test("a durable pending record recovers partial overlays and interrupted restores; missing prior commit stays missing", async (t) => {
  for (const commit of [oldCommit, null]) {
    const f = await fixture(t, { commit });
    await snapshotSource(f.args);
    await assert.rejects(snapshotSource(f.args), /needs recovery/);
    await f.overlay({ activateWrappers: false });
    // Simulate a crash after an earlier recovery restored one file and invalidated the commit marker.
    await fs.unlink(path.join(f.workspace, "frame-source-commit"));
    await write(f.workspace, f.files[0], "old source", 0o755);
    assert.equal((await readSourceSnapshot({ workspace: f.workspace })).pending, true);
    await restoreSource({ workspace: f.workspace });
    await restoreSource({ workspace: f.workspace });
    assert.equal(await read(f.workspace, f.files[0]), "old source");
    if (commit) assert.equal(await read(f.workspace, "frame-source-commit"), `${commit}\n`);
    else await missing(f.workspace, "frame-source-commit");
    await completeSource(f.args);
  }
});

test("rollback refuses changed user files before altering source or claiming a previous commit", async (t) => {
  const f = await fixture(t);
  await snapshotSource(f.args); await f.overlay();
  await write(f.workspace, "scripts/new.mjs", "operator changed new file");
  await assert.rejects(restoreSource(f.args), /unexpected changed file/);
  assert.equal(await read(f.workspace, "scripts/new.mjs"), "operator changed new file");
  assert.equal(await read(f.workspace, f.files[0]), `new ${f.files[0]}`);
  assert.equal(await read(f.workspace, "frame-source-commit"), `${newCommit}\n`);
  await write(f.workspace, "scripts/new.mjs", "new scripts/new.mjs");
  await write(f.workspace, f.files[0], "operator changed existing file");
  await assert.rejects(restoreSource(f.args), /unexpected changed file/);
  assert.equal(await read(f.workspace, f.files[0]), "operator changed existing file");
  assert.equal((await readSourceSnapshot(f.args)).pending, true);
});

test("recovery validation checks live source conflicts without changing files or the snapshot", async (t) => {
  const f = await fixture(t), snapshot = await snapshotSource(f.args);
  await f.overlay();
  const paths = [...snapshot.files.map((file) => file.path), `${SOURCE_BACKUP}/snapshot.json`];
  const before = await Promise.all(paths.map(async (file) => {
    try { const info = await fs.stat(path.join(f.workspace, file)); return { bytes: await fs.readFile(path.join(f.workspace, file)), mode: info.mode, mtimeMs: info.mtimeMs }; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }));
  assert.deepEqual(await restoreSource({ workspace: f.workspace, validateOnly: true }), snapshot);
  for (const [index, file] of paths.entries()) {
    if (before[index] === null) { await missing(f.workspace, file); continue; }
    const info = await fs.stat(path.join(f.workspace, file));
    assert.deepEqual(await fs.readFile(path.join(f.workspace, file)), before[index].bytes);
    assert.equal(info.mode, before[index].mode); assert.equal(info.mtimeMs, before[index].mtimeMs);
  }
  await write(f.workspace, f.files[0], "operator changed source");
  await assert.rejects(restoreSource({ workspace: f.workspace, validateOnly: true }), /unexpected changed file/);
  assert.equal(await read(f.workspace, f.files[0]), "operator changed source");
  assert.equal(await read(f.workspace, "frame-source-commit"), `${newCommit}\n`);
  assert.deepEqual(await readSourceSnapshot(f.args), snapshot);
});

test("damaged/missing backup bytes and forged metadata refuse recovery before destination writes", async (t) => {
  const f = await fixture(t), snapshot = await snapshotSource(f.args);
  await f.overlay();
  const blob = `${SOURCE_BACKUP}/bytes-${snapshot.id}-0`, original = await fs.readFile(path.join(f.workspace, blob));
  await write(f.workspace, blob, "corrupt backup");
  assert.equal((await readSourceSnapshot({ workspace: f.workspace, verifyBytes: false })).id, snapshot.id, "status can inspect metadata without hashing the release backup");
  await assert.rejects(readSourceSnapshot(f.args), /missing or damaged/);
  await assert.rejects(restoreSource(f.args), /missing or damaged/);
  assert.equal(await read(f.workspace, "frame-source-commit"), `${newCommit}\n`);
  await write(f.workspace, blob, original, 0o600);
  const marker = `${SOURCE_BACKUP}/snapshot.json`;
  for (const damaged of [
    { ...snapshot, workspace: f.root },
    { ...snapshot, files: [{ ...snapshot.files[0], path: "../operator-notes.txt" }, ...snapshot.files.slice(1)] },
    { ...snapshot, files: [{ ...snapshot.files[0], path: "media/photo.bin" }, ...snapshot.files.slice(1)] },
    { ...snapshot, previousCommit: "c".repeat(40) },
  ]) {
    await write(f.workspace, marker, JSON.stringify(damaged), 0o600);
    await assert.rejects(restoreSource(f.args));
    assert.equal(await read(f.workspace, "frame-source-commit"), `${newCommit}\n`);
    assert.equal(await read(f.workspace, "media/photo.bin"), "user media");
  }
  await write(f.workspace, marker, JSON.stringify(snapshot), 0o600);
  await fs.unlink(path.join(f.workspace, blob));
  await assert.rejects(restoreSource(f.args), /missing or damaged/);
});

test("snapshot rejects traversal, protected data/config, Windows aliases, handoff aliases and duplicate destinations", async (t) => {
  const f = await fixture(t);
  for (const file of ["../outside", "/absolute", "dir\\file", "dir/../file", ".env", "docker-compose.yml", "data/file",
    ".git/config", "nested/.git/config", "nested/.env", "media/photo.bin", ".frame-source-backup/a", ".frame-deployment-backup/a",
    "frame-source-commit", "FRAME-SOURCE-COMMIT", "installer/stack.sh.next", "Installer/Stack.sh", "file:stream", "NUL.txt", "file."]) {
    await assert.rejects(snapshotSource({ ...f.args, files: [file] }), undefined, file);
  }
  await assert.rejects(snapshotSource({ ...f.args, files: [f.files[0], f.files[0].toUpperCase()] }), /Duplicate/);
  await assert.rejects(snapshotSource({ ...f.args, dataRoot: f.root }), /must not contain/);
  await assert.rejects(snapshotSource({ ...f.args, stagedRoot: f.workspace }), /outside/);
  await write(f.workspace, ".git", "gitdir: external");
  await assert.rejects(snapshotSource(f.args), /Git checkout/);
  await missing(f.workspace, `${SOURCE_BACKUP}/snapshot.json`);
});

test("source, destination and backup directory symlinks/junctions are rejected without touching their targets", async (t) => {
  for (const side of ["source", "destination", "backup"]) {
    const f = await fixture(t), outside = path.join(f.root, "outside");
    await fs.mkdir(outside); await write(outside, "file.mjs", "external user file");
    const base = side === "source" ? f.stagedRoot : f.workspace;
    const name = side === "backup" ? SOURCE_BACKUP : "linked";
    try { await fs.symlink(outside, path.join(base, name), process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (error.code === "EPERM") { t.skip("This host does not permit test symlinks."); return; } throw error; }
    if (side === "destination") await write(f.stagedRoot, "linked/file.mjs", "new staged file");
    await assert.rejects(snapshotSource({ ...f.args, files: side === "backup" ? f.files : ["linked/file.mjs"] }), /Unsafe/);
    assert.equal(await read(outside, "file.mjs"), "external user file");
    assert.deepEqual(await fs.readdir(outside), ["file.mjs"]);
  }
});

test("completion checks source identities and wrapper activation, and replacement snapshots preserve unknown backup files", async (t) => {
  const f = await fixture(t), first = await snapshotSource(f.args);
  await f.overlay({ activateWrappers: false });
  await assert.rejects(completeSource(f.args), /mismatched source/);
  assert.equal((await readSourceSnapshot(f.args)).pending, true);
  await fs.rename(path.join(f.workspace, "installer/stack.sh.next"), path.join(f.workspace, "installer/stack.sh"));
  await write(f.workspace, "frame-source-commit", `${oldCommit}\n`, 0o600);
  await assert.rejects(completeSource(f.args), /mismatched source/);
  await recordSourceCommit(f.workspace, newCommit);
  await completeSource(f.args);
  await write(f.workspace, `${SOURCE_BACKUP}/operator-notes.txt`, "retain this unknown file");
  const second = await snapshotSource({ ...f.args, targetCommit: "c".repeat(40) });
  assert.notEqual(second.id, first.id); assert.equal(second.previousCommit, newCommit);
  assert.equal(await read(f.workspace, `${SOURCE_BACKUP}/operator-notes.txt`), "retain this unknown file");
  assert.ok(!(await fs.readdir(path.join(f.workspace, SOURCE_BACKUP))).some((file) => file.startsWith(`bytes-${first.id}-`)));
  assert.equal((await readSourceSnapshot(f.args)).id, second.id);
});

test("failure before snapshot publication cleans only its own copies and leaves the prior source untouched", async (t) => {
  const f = await fixture(t);
  await write(f.workspace, "frame-source-commit", "invalid commit");
  await assert.rejects(snapshotSource(f.args), /source commit is invalid/);
  await missing(f.workspace, `${SOURCE_BACKUP}/snapshot.json`);
  assert.deepEqual(await fs.readdir(path.join(f.workspace, SOURCE_BACKUP)), []);
  assert.equal(await read(f.workspace, f.files[0]), "old source");
  assert.equal(await readSourceSnapshot(f.args), null);
});

test("snapshot discovery is read-only for fresh folders and rejects malformed/oversized records", async (t) => {
  const f = await fixture(t), fresh = path.join(f.root, "not-created");
  assert.equal(await readSourceSnapshot({ workspace: fresh }), null);
  await missing(f.root, "not-created");
  assert.equal(await readSourceSnapshot(f.args), null);
  await missing(f.workspace, SOURCE_BACKUP);
  const snapshot = await snapshotSource(f.args), marker = `${SOURCE_BACKUP}/snapshot.json`;
  for (const value of [null, {}, { ...snapshot, pending: "yes" }, { ...snapshot, files: Array(50_001).fill(null) },
    { ...snapshot, files: snapshot.files.filter((file) => file.path !== "installer/stack.sh.next") },
    { ...snapshot, files: snapshot.files.map((file) => ({ ...file, next: { ...file.next, size: 1024 ** 3 + 1 } })) },
  ]) {
    await write(f.workspace, marker, JSON.stringify(value), 0o600);
    await assert.rejects(readSourceSnapshot(f.args));
  }
  assert.equal(await read(f.workspace, "frame-source-commit"), `${oldCommit}\n`);
});

test("a destination directory replaced by a junction after overlay blocks restore without touching its target", async (t) => {
  const f = await fixture(t);
  await snapshotSource(f.args); await f.overlay();
  const outside = path.join(f.root, "external");
  await fs.mkdir(outside); await write(outside, "index.mjs", "external user file");
  await fs.rename(path.join(f.workspace, "services/tool"), path.join(f.workspace, "services/retained-tool"));
  try { await fs.symlink(outside, path.join(f.workspace, "services/tool"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code === "EPERM") { t.skip("This host does not permit test symlinks."); return; } throw error; }
  await assert.rejects(restoreSource(f.args), /Unsafe/);
  assert.equal(await read(outside, "index.mjs"), "external user file");
  assert.equal(await read(f.workspace, "frame-source-commit"), `${newCommit}\n`);
});
