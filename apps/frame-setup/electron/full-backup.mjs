import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readFile, readdir, rename, unlink, utimes } from "node:fs/promises";
import path from "node:path";

export const FULL_BACKUP_MANIFEST = "frame-full-backup.json";
export const FULL_RESTORE_MARKER = ".frame-full-restore.json";
const EXCLUDED = new Set([".frame-deployment-backup", ".frame-source-backup", FULL_RESTORE_MARKER]);
const MAX_ENTRIES = 500_000, MAX_MANIFEST = 64 * 1024 ** 2;
const absent = (error) => { if (error.code === "ENOENT") return null; throw error; };
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const within = (root, candidate) => { const relative = path.relative(root, candidate); return !relative || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`); };

function location(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) throw new Error("Full backup paths must be absolute folders.");
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) throw new Error("Choose a dedicated folder for FRAME backup or restore.");
  return resolved;
}

function relativePath(value) {
  if (typeof value !== "string" || !value || /[\\\x00-\x1f<>:"|?*]/.test(value)
    || value.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.toLowerCase() === ".git")) throw new Error("Unsafe full backup file path.");
  return value;
}

async function safePath(value, kind = "directory") {
  const target = path.resolve(value), root = path.parse(target).root;
  let current = root;
  for (const part of target.slice(root.length).split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(absent);
    if (!info) return null;
    if (info.isSymbolicLink() || (current !== target || kind === "directory" ? !info.isDirectory() : !info.isFile())) throw new Error(`Full backups cannot use links or special files: ${current}`);
    if (current === target) return info;
  }
  return lstat(root);
}

function separate(workspace, dataRoot, backupRoot) {
  if (within(dataRoot, workspace)) throw new Error("FRAME data cannot contain its installation folder.");
  for (const source of [workspace, dataRoot]) if (within(source, backupRoot) || within(backupRoot, source)) throw new Error("Choose a backup folder outside the FRAME installation and data folders, not one of their parent folders.");
}

const metadata = (info) => ({ mode: info.mode & 0o777, mtimeMs: info.mtimeMs, ...(process.platform !== "win32" ? { uid: info.uid, gid: info.gid } : {}) });
const unchanged = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.mtimeMs === b.mtimeMs && a.uid === b.uid && a.gid === b.gid;
const excluded = (scope, relative, workspace, dataRoot) => scope === "workspace"
  && (EXCLUDED.has(relative.split("/")[0].toLowerCase()) || within(dataRoot, path.join(workspace, relative)));

async function scan(root, scope, workspace, dataRoot) {
  const entries = [], observations = [];
  async function visit(directory, relative = "") {
    const before = await safePath(directory);
    if (!before) throw new Error(`Required FRAME folder is unavailable: ${directory}`);
    observations.push({ file: directory, info: before, kind: "directory" });
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${child.name}` : child.name;
      relativePath(name);
      if (child.isSymbolicLink() || !child.isFile() && !child.isDirectory()) throw new Error(`Full backups cannot include links or special files: ${name}`);
      if (excluded(scope, name, workspace, dataRoot)) continue;
      const file = path.join(root, name), info = await safePath(file, child.isDirectory() ? "directory" : "file");
      if (!info) throw new Error("FRAME files changed while preparing a backup. Keep FRAME stopped and try again.");
      entries.push({ scope, path: name, type: child.isDirectory() ? "directory" : "file", ...metadata(info), ...(child.isFile() ? { size: info.size } : {}) });
      if (entries.length > MAX_ENTRIES) throw new Error("Full backup contains too many entries.");
      if (child.isDirectory()) await visit(file, name);
      else observations.push({ file, info, kind: "file" });
    }
  }
  await visit(root);
  return { entries, observations, root: metadata(observations[0].info) };
}

// Stream media and databases with a fixed buffer; a large recording never becomes one in-memory Buffer.
async function transfer(source, destination, expected) {
  const before = await safePath(source, "file");
  if (!before || before.size !== expected.size) throw new Error("Backup source size changed or is invalid.");
  const input = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let output, bytes = 0;
  const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    if (!unchanged(before, await input.stat())) throw new Error("Backup source changed before it could be read.");
    if (destination) {
      await safePath(destination, "file");
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await safePath(path.dirname(destination));
      output = await open(destination, "wx", 0o600);
    }
    while (true) {
      const chunk = await input.read(buffer, 0, buffer.length, null);
      if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead;
      if (bytes > expected.size) throw new Error("Backup source grew while it was being read.");
      const content = buffer.subarray(0, chunk.bytesRead);
      digest.update(content);
      if (output) await output.writeFile(content);
    }
    if (bytes !== expected.size || !unchanged(before, await input.stat()) || !unchanged(before, await safePath(source, "file"))) throw new Error("Backup source changed while it was being read.");
    const sha256 = digest.digest("hex");
    if (expected.sha256 && sha256 !== expected.sha256) throw new Error(`Full backup verification failed: ${source}`);
    if (output) await output.sync();
    return sha256;
  } finally { await input.close(); if (output) await output.close(); }
}

async function writeJson(file, value, exclusive = false) {
  await safePath(file, "file");
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > MAX_MANIFEST) throw new Error("Full backup metadata exceeds the supported size.");
  const temporary = exclusive ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); }
  finally { await handle.close(); }
  if (!exclusive) {
    try { await safePath(file, "file"); await rename(temporary, file); }
    finally { await unlink(temporary).catch(absent); }
  }
}

async function emptyFolder(folder) {
  const info = await safePath(folder);
  if (info && (await readdir(folder)).length) throw new Error(`Restore and backup destinations must be empty: ${folder}`);
}

function validateManifest(value) {
  const validMetadata = (entry) => Number.isInteger(entry?.mode) && entry.mode >= 0 && entry.mode <= 0o777
    && Number.isFinite(entry.mtimeMs) && entry.mtimeMs >= 0 && entry.mtimeMs <= 8.64e15
    && (value.platform === "win32" || [entry.uid, entry.gid].every((id) => Number.isInteger(id) && id >= 0 && id <= 0xffff_fffe));
  if (!value || value.schema_version !== 1 || value.complete !== true || !/^[a-f0-9-]{36}$/.test(value.id || "")
    || !["win32", "darwin", "linux"].includes(value.platform) || !Number.isFinite(Date.parse(value.createdAt))
    || value.sourceCommit !== null && !/^[a-f0-9]{40}$/.test(value.sourceCommit)
    || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES
    || !validMetadata(value.roots?.workspace) || !validMetadata(value.roots?.data)) throw new Error("The full backup is incomplete or its manifest is invalid.");
  const paths = value.platform === "win32" ? path.win32 : path.posix;
  for (const root of [value.workspace, value.dataRoot]) if (typeof root !== "string" || !paths.isAbsolute(root) || /[\x00-\x1f]/.test(root) || paths.normalize(root) !== root || root === paths.parse(root).root) throw new Error("Invalid original full backup location.");
  const seen = new Map(), exact = new Map(); let fileCount = 0, totalBytes = 0;
  for (const entry of value.entries) {
    if (!["workspace", "data"].includes(entry?.scope) || !["file", "directory"].includes(entry.type) || !validMetadata(entry)) throw new Error("Invalid full backup entry.");
    relativePath(entry.path);
    if (entry.scope === "workspace" && EXCLUDED.has(entry.path.split("/")[0].toLowerCase())) throw new Error("Full backup includes an excluded recovery path.");
    const key = `${entry.scope}/${entry.path.toLowerCase()}`;
    if (seen.has(key)) throw new Error("Duplicate full backup path.");
    seen.set(key, entry.type);
    exact.set(`${entry.scope}/${entry.path}`, entry.type);
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")) throw new Error("Invalid full backup file identity.");
      fileCount++; totalBytes += entry.size;
      if (!Number.isSafeInteger(totalBytes)) throw new Error("Full backup exceeds the supported size.");
    }
  }
  for (const entry of value.entries) {
    const parts = entry.path.split("/"); parts.pop();
    while (parts.length) {
      if (exact.get(`${entry.scope}/${parts.join("/")}`) !== "directory") throw new Error("Full backup parent directory is missing or invalid.");
      parts.pop();
    }
  }
  if (value.fileCount !== fileCount || value.totalBytes !== totalBytes) throw new Error("Full backup totals do not match its contents.");
  return value;
}

async function restoreMetadata(target, entry, kind) {
  const current = await safePath(target, kind);
  if (!current) throw new Error("A restored path disappeared before its permissions could be verified.");
  try {
    if (process.platform !== "win32" && (current.uid !== entry.uid || current.gid !== entry.gid)) await chown(target, entry.uid, entry.gid);
    await chmod(target, entry.mode);
    await utimes(target, new Date(entry.mtimeMs), new Date(entry.mtimeMs));
  } catch {
    throw new Error(`Could not restore ownership or permissions for ${target}. The full restore is incomplete; retain the backup and original folders, and resolve account permissions before retrying.`);
  }
}

/** Caller must stop and verify all FRAME containers before copying databases or other persistent data. */
export async function createFullBackup({ workspace, dataRoot, backupRoot, beforeComplete }) {
  workspace = location(workspace); dataRoot = location(dataRoot); backupRoot = location(backupRoot);
  separate(workspace, dataRoot, backupRoot);
  if (await safePath(path.join(workspace, FULL_RESTORE_MARKER), "file")) throw new Error("Complete the interrupted full restore before creating a backup.");
  for (const folder of [".frame-deployment-backup", ".frame-source-backup"]) {
    const marker = path.join(workspace, folder, "snapshot.json"), info = await safePath(marker, "file");
    if (info && (info.size > MAX_MANIFEST || JSON.parse(await readFile(marker, "utf8")).pending)) throw new Error("Complete FRAME recovery before creating a full backup.");
  }
  await emptyFolder(backupRoot);
  const deployment = await scan(workspace, "workspace", workspace, dataRoot), data = await scan(dataRoot, "data", workspace, dataRoot);
  const entries = [...deployment.entries, ...data.entries];
  if (entries.length > MAX_ENTRIES) throw new Error("Full backup contains too many entries.");
  const commitFile = path.join(workspace, "frame-source-commit"), commitInfo = await safePath(commitFile, "file");
  const sourceCommit = commitInfo ? (commitInfo.size <= 128 ? (await readFile(commitFile, "utf8")).trim() : "invalid") : null;
  if (sourceCommit !== null && !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("The installed source commit is invalid.");
  const manifest = { schema_version: 1, id: randomUUID(), complete: false, workspace, dataRoot, platform: process.platform,
    createdAt: new Date().toISOString(), sourceCommit, roots: { workspace: deployment.root, data: data.root },
    fileCount: entries.filter((entry) => entry.type === "file").length,
    totalBytes: entries.reduce((sum, entry) => sum + (entry.size || 0), 0), entries };
  await mkdir(backupRoot, { recursive: true, mode: 0o700 }); await chmod(backupRoot, 0o700);
  await writeJson(path.join(backupRoot, FULL_BACKUP_MANIFEST), { ...manifest, entries: [] }, true);
  for (const scope of ["workspace", "data"]) await mkdir(path.join(backupRoot, scope), { mode: 0o700 });
  for (const entry of entries) {
    const destination = path.join(backupRoot, entry.scope, entry.path);
    if (entry.type === "directory") await mkdir(destination, { recursive: true, mode: 0o700 });
    else entry.sha256 = await transfer(path.join(entry.scope === "workspace" ? workspace : dataRoot, entry.path), destination, entry);
  }
  for (const observation of [...deployment.observations, ...data.observations]) {
    if (!unchanged(observation.info, await safePath(observation.file, observation.kind))) throw new Error("FRAME files changed during backup. Keep FRAME stopped and create a new backup.");
  }
  manifest.complete = true;
  validateManifest(manifest);
  for (const entry of entries.filter((item) => item.type === "file")) await transfer(path.join(backupRoot, entry.scope, entry.path), null, entry);
  await beforeComplete?.();
  await writeJson(path.join(backupRoot, FULL_BACKUP_MANIFEST), manifest);
  return manifest;
}

/** Verification streams every file by default. Summary callers may skip hashing, never path/type validation. */
export async function readFullBackup({ backupRoot, verifyBytes = true }) {
  backupRoot = location(backupRoot);
  const marker = path.join(backupRoot, FULL_BACKUP_MANIFEST), info = await safePath(marker, "file");
  if (!info || info.size > MAX_MANIFEST) throw new Error("No complete FRAME full backup was found in this folder.");
  let manifest;
  try { manifest = validateManifest(JSON.parse(await readFile(marker, "utf8"))); }
  catch (error) { if (error instanceof SyntaxError) throw new Error("The full backup manifest could not be read."); throw error; }
  for (const scope of ["workspace", "data"]) if (!await safePath(path.join(backupRoot, scope))) throw new Error("Full backup content is missing.");
  for (const entry of manifest.entries) {
    const file = path.join(backupRoot, entry.scope, entry.path), current = await safePath(file, entry.type);
    if (!current || entry.type === "file" && current.size !== entry.size) throw new Error(`Full backup content is missing or changed: ${entry.path}`);
    if (entry.type === "file" && verifyBytes) await transfer(file, null, entry);
  }
  return manifest;
}

/** Restore never replaces existing data. Caller handles container removal and subsequent explicit Repair. */
export async function restoreFullBackup({ backupRoot, workspace, dataRoot }) {
  backupRoot = location(backupRoot); workspace = location(workspace); dataRoot = location(dataRoot);
  separate(workspace, dataRoot, backupRoot);
  const manifest = await readFullBackup({ backupRoot });
  if (manifest.platform !== process.platform || !samePath(workspace, manifest.workspace) || !samePath(dataRoot, manifest.dataRoot)) throw new Error("Restore requires the original installation and data paths on the same operating system. Relocation needs explicit configuration migration.");
  for (const entry of manifest.entries) if (excluded(entry.scope, entry.path, workspace, dataRoot)) throw new Error("Full backup includes overlapping deployment and data paths.");
  await emptyFolder(workspace); await emptyFolder(dataRoot);
  await mkdir(workspace, { recursive: true, mode: 0o700 }); await chmod(workspace, 0o700);
  await writeJson(path.join(workspace, FULL_RESTORE_MARKER), { schema_version: 1, backupId: manifest.id, complete: false, backupRoot }, true);
  await mkdir(dataRoot, { recursive: true, mode: 0o700 }); await chmod(dataRoot, 0o700);
  const ordered = [...manifest.entries].sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  for (const entry of ordered) {
    const target = path.join(entry.scope === "workspace" ? workspace : dataRoot, entry.path);
    if (entry.type === "directory") { await safePath(target); await mkdir(target, { recursive: true, mode: 0o700 }); }
    else await transfer(path.join(backupRoot, entry.scope, entry.path), target, entry);
  }
  for (const entry of ordered.filter((item) => item.type === "file")) await transfer(path.join(entry.scope === "workspace" ? workspace : dataRoot, entry.path), null, entry);
  for (const entry of ordered.reverse()) {
    const target = path.join(entry.scope === "workspace" ? workspace : dataRoot, entry.path);
    await restoreMetadata(target, entry, entry.type);
  }
  // Set child metadata first. Any permission failure leaves the incomplete marker in place.
  for (const [root, meta] of [[dataRoot, manifest.roots.data], [workspace, manifest.roots.workspace]]) await restoreMetadata(root, meta, "directory");
  await safePath(path.join(workspace, FULL_RESTORE_MARKER), "file");
  await unlink(path.join(workspace, FULL_RESTORE_MARKER));
  // Removing the marker changes only this directory's timestamp; content/ownership are already verified.
  await utimes(workspace, new Date(manifest.roots.workspace.mtimeMs), new Date(manifest.roots.workspace.mtimeMs)).catch(() => {});
  return manifest;
}
