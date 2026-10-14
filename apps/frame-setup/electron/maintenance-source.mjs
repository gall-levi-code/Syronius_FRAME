import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

export const SOURCE_BACKUP = ".frame-source-backup";
const COMMIT_FILE = "frame-source-commit";
const MARKER = `${SOURCE_BACKUP}/snapshot.json`;
const PROTECTED = [".env", "docker-compose.yml", "cf_token.txt", ".git", "data", "frame-release.json",
  "docker-compose.release.json", "frame-images.json", "frame-images-arm64.json", ".frame-deployment-backup", SOURCE_BACKUP, ".frame-online-install.json"];
const WRAPPERS = new Set(["installer/stack.ps1", "installer/stack.sh"]);
const MAX_BYTES = 1024 ** 3, MAX_FILES = 50_000;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const samePath = (a, b) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const absent = (error) => { if (error.code === "ENOENT") return null; throw error; };
const blob = (snapshot, index) => `${SOURCE_BACKUP}/bytes-${snapshot.id}-${index}`;

function relativePath(value) {
  if (typeof value !== "string" || !value || /[\\\x00-\x1f<>:"|?*]/.test(value)
    || value.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error("Unsafe source recovery path.");
  return value;
}

function sourcePath(value, workspace, dataRoot) {
  relativePath(value);
  const normalized = value.toLowerCase();
  const data = path.relative(workspace, dataRoot).split(path.sep).join("/");
  const protectedPaths = [...PROTECTED, ...(data && !data.startsWith("../") && !path.isAbsolute(data) ? [data] : [])];
  if (protectedPaths.some((entry) => normalized === entry.toLowerCase() || normalized.startsWith(`${entry.toLowerCase()}/`))
    || value.split("/").some((part) => [".git", ".env"].includes(part.toLowerCase()))) throw new Error(`Source recovery cannot include protected path ${value}.`);
  return value;
}

// Inspect every ancestor: checking just the leaf would follow directory junctions/symlinks.
async function safePath(file, directory = false) {
  const absolute = path.resolve(file), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep)) {
    current = path.join(current, part);
    const info = await lstat(current).catch(absent);
    if (!info) return null;
    if (info.isSymbolicLink() || (current !== absolute || directory ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Unsafe source recovery filesystem path: ${file}`);
    }
    if (current === absolute) return info;
  }
  if (!directory) throw new Error("Source recovery requires a file path.");
  return lstat(root);
}

async function workspaceRoot(value, allowMissing = false) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("Source recovery requires an absolute installation folder.");
  const workspace = path.resolve(value);
  if (!(await safePath(workspace, true)) && !allowMissing) throw new Error("The source recovery installation folder is unavailable.");
  if (await lstat(path.join(workspace, ".git")).catch(absent)) throw new Error("Source recovery is disabled in a Git checkout.");
  return workspace;
}

function dataLocation(workspace, dataRoot) {
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) throw new Error("Source recovery requires the installed data folder.");
  const resolved = path.resolve(dataRoot), relative = path.relative(resolved, workspace);
  if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
    throw new Error("Source recovery data must not contain the installation folder.");
  }
  return resolved;
}

async function content(file) {
  const info = await safePath(file);
  if (!info) return null;
  if (info.size > MAX_BYTES) throw new Error("Source recovery file exceeds the size limit.");
  const bytes = await readFile(file);
  if (bytes.length !== info.size) throw new Error("Source files changed while preparing recovery. Retry the update.");
  return { bytes, identity: { sha256: sha(bytes), size: bytes.length, mode: info.mode & 0o777 } };
}

function matches(actual, expected, permissions = false) {
  return actual === null ? expected === null : expected !== null && actual.sha256 === expected.sha256 && actual.size === expected.size
    && (!permissions || (process.platform === "win32" ? (actual.mode & 0o200) === (expected.mode & 0o200) : actual.mode === expected.mode));
}

function validIdentity(value) {
  return value && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= MAX_BYTES
    && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777;
}

async function atomicWrite(file, bytes, mode = 0o600) {
  await safePath(file);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await safePath(path.dirname(file), true);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, "wx", mode);
    created = true;
    try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); }
    finally { await handle.close(); }
    await safePath(file);
    await rename(temporary, file);
  } finally { if (created) await unlink(temporary).catch(absent); }
}

async function writeMarker(workspace, snapshot) {
  await atomicWrite(path.join(workspace, MARKER), `${JSON.stringify(snapshot)}\n`);
}

/** Status may request metadata only; mutation/recovery always uses the default full byte verification. */
export async function readSourceSnapshot({ workspace, verifyBytes = true }) {
  workspace = await workspaceRoot(workspace, true);
  const info = await safePath(path.join(workspace, MARKER));
  if (!info) return null;
  if (info.size > 32 * 1024 ** 2) throw new Error("Source recovery metadata exceeds the size limit.");
  let snapshot;
  try { snapshot = JSON.parse(await readFile(path.join(workspace, MARKER), "utf8")); }
  catch { throw new Error("The source recovery record could not be read."); }
  if (!snapshot || snapshot.schema_version !== 1 || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(snapshot.id)
    || typeof snapshot.workspace !== "string" || !samePath(snapshot.workspace, workspace)
    || typeof snapshot.pending !== "boolean" || typeof snapshot.restored !== "boolean"
    || !/^[a-f0-9]{40}$/.test(snapshot.targetCommit) || snapshot.previousCommit !== null && !/^[a-f0-9]{40}$/.test(snapshot.previousCommit)
    || !Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > MAX_FILES) throw new Error("Invalid source recovery record.");
  const dataRoot = dataLocation(workspace, snapshot.dataRoot), seen = new Set();
  let total = 0;
  for (const [index, file] of snapshot.files.entries()) {
    if (!file || typeof file.path !== "string") throw new Error("Invalid source recovery file record.");
    sourcePath(file.path, workspace, dataRoot);
    if (seen.has(file.path.toLowerCase()) || !validIdentity(file.next) || file.previous !== null && !validIdentity(file.previous)
      || typeof file.handoff !== "boolean" || file.handoff !== (file.path.endsWith(".next") && WRAPPERS.has(file.path.slice(0, -5)))) throw new Error("Invalid source recovery file identity.");
    seen.add(file.path.toLowerCase());
    total += (file.previous?.size || 0) + file.next.size;
    if (total > MAX_BYTES * 2) throw new Error("Source recovery snapshot exceeds the size limit.");
    if (file.previous && verifyBytes) {
      const saved = await content(path.join(workspace, blob(snapshot, index)));
      if (!saved || !matches(saved.identity, file.previous)) throw new Error(`Source recovery bytes are missing or damaged: ${file.path}`);
      if (file.path === COMMIT_FILE && saved.bytes.toString("utf8").trim() !== snapshot.previousCommit) throw new Error("Source recovery commit does not match its saved bytes.");
    }
  }
  const marker = snapshot.files.find((file) => file.path === COMMIT_FILE);
  if (!marker || marker.handoff || Boolean(marker.previous) !== (snapshot.previousCommit !== null)
    || marker.next.size !== 41 || marker.next.sha256 !== sha(Buffer.from(`${snapshot.targetCommit}\n`))) throw new Error("Source recovery commit record is incomplete.");
  for (const wrapper of WRAPPERS) {
    const canonical = snapshot.files.find((file) => file.path === wrapper), handoff = snapshot.files.find((file) => file.path === `${wrapper}.next`);
    if (Boolean(canonical) !== Boolean(handoff) || canonical && !matches(canonical.next, handoff.next, true)) throw new Error("Source recovery wrapper handoff is incomplete.");
  }
  return snapshot;
}

/** files are canonical paths from the validated staged release, excluding protected/bootstrap files. */
export async function snapshotSource({ workspace, stagedRoot, files, dataRoot, targetCommit }) {
  workspace = await workspaceRoot(workspace);
  dataRoot = dataLocation(workspace, dataRoot);
  await safePath(dataRoot, true);
  if (typeof stagedRoot !== "string" || !path.isAbsolute(stagedRoot) || !(await safePath(stagedRoot, true))) throw new Error("The staged release folder is unavailable.");
  stagedRoot = path.resolve(stagedRoot);
  const stageRelative = path.relative(workspace, stagedRoot);
  if (!stageRelative || !stageRelative.startsWith(`..${path.sep}`) && stageRelative !== ".." && !path.isAbsolute(stageRelative)) throw new Error("Stage source updates outside the installation folder.");
  if (!/^[a-f0-9]{40}$/.test(targetCommit) || !Array.isArray(files) || !files.length || files.length > MAX_FILES - 3) throw new Error("Invalid staged source recovery input.");
  const prior = await readSourceSnapshot({ workspace });
  if (prior?.pending) throw new Error("A source update needs recovery before another update can begin.");
  const paths = [], seen = new Set();
  for (const file of files) {
    sourcePath(file, workspace, dataRoot);
    if (file.toLowerCase() === COMMIT_FILE || /\.next$/i.test(file) && WRAPPERS.has(file.toLowerCase().slice(0, -5))) throw new Error("Source commit and wrapper handoffs are captured automatically.");
    if (WRAPPERS.has(file.toLowerCase()) && !WRAPPERS.has(file)) throw new Error("Wrapper source paths must use their canonical spelling.");
    for (const target of WRAPPERS.has(file) ? [file, `${file}.next`] : [file]) {
      if (seen.has(target.toLowerCase())) throw new Error("Duplicate staged source path.");
      seen.add(target.toLowerCase()); paths.push({ path: target, source: file, handoff: target !== file });
    }
  }
  paths.push({ path: COMMIT_FILE, handoff: false });
  const snapshot = { schema_version: 1, id: randomUUID(), workspace, dataRoot, previousCommit: null, targetCommit, pending: true, restored: false, files: [] };
  const created = [];
  let published = false, total = 0;
  await mkdir(path.join(workspace, SOURCE_BACKUP), { recursive: true, mode: 0o700 });
  await safePath(path.join(workspace, SOURCE_BACKUP), true);
  await chmod(path.join(workspace, SOURCE_BACKUP), 0o700);
  try {
    for (const [index, file] of paths.entries()) {
      const previous = await content(path.join(workspace, file.path));
      const next = file.path === COMMIT_FILE
        ? { identity: { sha256: sha(Buffer.from(`${targetCommit}\n`)), size: 41, mode: 0o600 } }
        : await content(path.join(stagedRoot, file.source));
      if (!next) throw new Error(`The staged source file is missing: ${file.source}`);
      total += (previous?.identity.size || 0) + next.identity.size;
      if (total > MAX_BYTES * 2) throw new Error("Source recovery snapshot exceeds the size limit.");
      if (file.path === COMMIT_FILE && previous) {
        snapshot.previousCommit = previous.bytes.toString("utf8").trim();
        if (!/^[a-f0-9]{40}$/.test(snapshot.previousCommit)) throw new Error("The installed source commit is invalid.");
      }
      snapshot.files.push({ path: file.path, previous: previous?.identity || null, next: next.identity, handoff: file.handoff });
      if (previous) {
        const backup = path.join(workspace, blob(snapshot, index));
        await safePath(backup);
        const handle = await open(backup, "wx", 0o600);
        created.push(backup);
        try { await handle.writeFile(previous.bytes); await handle.sync(); } finally { await handle.close(); }
      }
    }
    // Do not publish a snapshot if the source changed while its bytes were being copied.
    for (const file of snapshot.files) {
      if (!matches((await content(path.join(workspace, file.path)))?.identity || null, file.previous, true)) throw new Error("Installed source changed while preparing recovery. Retry the update.");
    }
    await writeMarker(workspace, snapshot);
    published = true;
    // Remove only the previous record's verified private byte files, never unknown files/directories.
    if (prior) for (const [index, file] of prior.files.entries()) {
      if (!file.previous) continue;
      const old = path.join(workspace, blob(prior, index));
      try { if (matches((await content(old))?.identity || null, file.previous)) await unlink(old); } catch { /* An older backup is harmless; keep it if cleanup cannot be verified. */ }
    }
    return snapshot;
  } finally {
    if (!published) for (const file of created) { await safePath(file); await unlink(file).catch(absent); }
  }
}

/** Offline and retryable. Caller restores deployment configuration/images afterwards. */
export async function restoreSource({ workspace, validateOnly = false }) {
  workspace = await workspaceRoot(workspace);
  const snapshot = await readSourceSnapshot({ workspace });
  if (!snapshot) throw new Error("No source recovery snapshot was found.");
  for (const file of snapshot.files) {
    const current = (await content(path.join(workspace, file.path)))?.identity || null;
    if (current && !matches(current, file.previous, true) && !matches(current, file.next, true)) throw new Error(`Source recovery found an unexpected changed file: ${file.path}. Preserve it and resolve the conflict before retrying.`);
  }
  if (validateOnly) return snapshot;
  // A partial restore must not advertise either release's source commit as complete.
  await unlink(path.join(workspace, COMMIT_FILE)).catch(absent);
  for (const [index, file] of snapshot.files.entries()) {
    if (file.path === COMMIT_FILE) continue;
    const target = path.join(workspace, file.path);
    const current = (await content(target))?.identity || null;
    if (current && !matches(current, file.previous, true) && !matches(current, file.next, true)) throw new Error(`Source recovery found an unexpected changed file: ${file.path}`);
    if (file.previous) {
      const saved = await content(path.join(workspace, blob(snapshot, index)));
      if (!saved || !matches(saved.identity, file.previous)) throw new Error(`Source recovery bytes changed: ${file.path}`);
      await atomicWrite(target, saved.bytes, file.previous.mode);
    } else {
      const current = await content(target);
      if (current && !matches(current.identity, file.next, true)) throw new Error(`Source recovery found an unexpected new file: ${file.path}`);
      if (current) await unlink(target);
    }
  }
  for (const file of snapshot.files.filter((item) => item.path !== COMMIT_FILE)) {
    if (!matches((await content(path.join(workspace, file.path)))?.identity || null, file.previous, true)) throw new Error(`Source recovery did not verify restored source: ${file.path}`);
  }
  const index = snapshot.files.findIndex((file) => file.path === COMMIT_FILE), marker = snapshot.files[index];
  if (marker.previous) {
    const saved = await content(path.join(workspace, blob(snapshot, index)));
    if (!saved || !matches(saved.identity, marker.previous)) throw new Error("Source recovery commit bytes changed.");
    await atomicWrite(path.join(workspace, COMMIT_FILE), saved.bytes, marker.previous.mode);
  }
  snapshot.pending = true; snapshot.restored = true;
  await writeMarker(workspace, snapshot);
  return snapshot;
}

/** Complete only after the backend has verified the matching deployment and container state. */
export async function completeSource({ workspace }) {
  workspace = await workspaceRoot(workspace);
  const snapshot = await readSourceSnapshot({ workspace });
  if (!snapshot) throw new Error("No source recovery snapshot was found.");
  for (const file of snapshot.files) {
    const expected = snapshot.restored ? file.previous : file.handoff ? null : file.next;
    if (!matches((await content(path.join(workspace, file.path)))?.identity || null, expected, true)) throw new Error(`Source recovery cannot complete with mismatched source: ${file.path}`);
  }
  snapshot.pending = false;
  await writeMarker(workspace, snapshot);
  return snapshot;
}
