import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPOSITORY = "gall-levi-code/Syronius_FRAME";
const BRANCH = "main";
const COMMIT_API_URL = `https://api.github.com/repos/${REPOSITORY}/commits/${BRANCH}`;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DOWNLOAD_HOSTS = new Set(["github.com", "codeload.github.com"]);
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const NETWORK_TIMEOUT_MS = 120_000;
const BOOTSTRAP_FILES = new Set(["stack.cmd", "stack.sh"]);
const WRAPPER_NEXT_FILES = new Map([
  ["installer/stack.ps1", "installer/stack.ps1.next"],
  ["installer/stack.sh", "installer/stack.sh.next"],
]);
const ALWAYS_PROTECTED = [".env", "docker-compose.yml", "cf_token.txt", ".git"];
const REQUIRED_FILES = [
  "package.json",
  "installer/frame-installer.mjs",
  "installer/frame-updater.mjs",
  "installer/frame-contract.mjs",
  "installer/stack.ps1",
  "installer/stack.sh",
  "installer/templates/docker-compose.yml",
  "scripts/verify.mjs",
  "stack.cmd",
  "stack.sh",
];
const WRAPPER_CONTRACTS = new Map([
  ["installer/stack.ps1", ['"update" {', '"start" {', '"finalize-source-update" {']],
  ["installer/stack.sh", ["update)", "start)", "finalize-source-update)"]],
]);

export async function sourceUpdate({ workspace = "/workspace" } = {}) {
  workspace = path.resolve(workspace);
  await requireInstalledWorkspace(workspace);
  const envText = await readFile(path.join(workspace, ".env"), "utf8");
  const dataRootValue = readEnvValue(envText, "FRAME_DATA_ROOT") || "./data";
  const relativeDataRoot = relativeDataRootOrNull(dataRootValue);
  const protectedPaths = [...ALWAYS_PROTECTED, ...(relativeDataRoot ? [relativeDataRoot] : [])];
  const stateRoot = resolveStateRoot(workspace, dataRootValue);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "frame-update-"));

  try {
    const buildId = await resolveCurrentBuild();
    const archiveFile = path.join(temporaryRoot, "frame-update.tar.gz");
    const extractedRoot = path.join(temporaryRoot, "payload");
    const archiveUrl = `https://github.com/${REPOSITORY}/archive/${buildId}.tar.gz`;

    console.log(`[update] current ${BRANCH} build: ${buildId}`);
    console.log("[update] downloading official FRAME source...");
    await downloadArchive(archiveUrl, archiveFile);

    const { entries, bytes: declaredBytes } = await listArchiveEntries(archiveFile);
    validateArchiveEntries(entries, `Syronius_FRAME-${buildId}`);
    await requireFreeSpace(temporaryRoot, declaredBytes);
    await mkdir(extractedRoot, { recursive: true });
    await runTar(["-xzf", archiveFile, "-C", extractedRoot, "--strip-components", "1", "-o", "--no-same-permissions"]);

    const staged = await inspectStagedTree(extractedRoot);
    await validatePayload(extractedRoot, staged.files, protectedPaths);
    await requireFreeSpace(workspace, staged.bytes);
    await verifyStagedPayload(extractedRoot, staged.files);

    console.log("[update] installing verified FRAME source...");
    await applyStagedUpdate({ workspace, stagedRoot: extractedRoot, files: staged.files, protectedPaths });
    await atomicWriteJson(path.join(stateRoot, "state", "pending-source-update.json"), {
      schema_version: 1,
      build_id: buildId,
      source: `github:${REPOSITORY}@${buildId}`,
      staged_at: new Date().toISOString(),
    });
    console.log(`[update] source build ${buildId.slice(0, 12)} installed; starting the updated stack next.`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function finalizeSourceUpdate({ workspace = "/workspace" } = {}) {
  workspace = path.resolve(workspace);
  const envText = await readFile(path.join(workspace, ".env"), "utf8");
  const dataRootValue = readEnvValue(envText, "FRAME_DATA_ROOT") || "./data";
  const stateDirectory = path.join(resolveStateRoot(workspace, dataRootValue), "state");
  const pendingFile = path.join(stateDirectory, "pending-source-update.json");
  let pending;
  try {
    pending = JSON.parse(await readFile(pendingFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("No pending FRAME source update was found.");
    throw new Error(`Pending FRAME update metadata is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!pending || pending.schema_version !== 1 || !SHA_PATTERN.test(String(pending.build_id ?? ""))) {
    throw new Error("Pending FRAME update metadata is incomplete.");
  }
  await atomicWriteJson(path.join(stateDirectory, "installed-build.json"), {
    ...pending,
    installed_at: new Date().toISOString(),
  });
  await rm(pendingFile, { force: true });
  console.log(`[update] FRAME build ${pending.build_id.slice(0, 12)} is installed and healthy.`);
}

export async function applyStagedUpdate({ workspace, stagedRoot, files, protectedPaths }) {
  workspace = path.resolve(workspace);
  stagedRoot = path.resolve(stagedRoot);
  const normalizedProtected = protectedPaths.map(normalizeRelativePath);
  for (const relative of files) {
    assertSafeRelativePath(relative);
    if (isProtectedPath(relative, normalizedProtected)) {
      throw new Error(`Update payload may not contain protected path "${relative}".`);
    }
    if (!BOOTSTRAP_FILES.has(relative)) {
      await assertNoDestinationSymlinks(workspace, WRAPPER_NEXT_FILES.get(relative) ?? relative);
    }
  }

  // ponytail: alpha updates overlay source and never delete unknown files; add a managed-file ledger when stale files matter.
  const orderedFiles = [...files].sort((left, right) => {
    const leftWrapper = WRAPPER_NEXT_FILES.has(left);
    const rightWrapper = WRAPPER_NEXT_FILES.has(right);
    return leftWrapper === rightWrapper ? left.localeCompare(right) : leftWrapper ? 1 : -1;
  });
  for (const relative of orderedFiles) {
    if (BOOTSTRAP_FILES.has(relative)) continue;
    const destinationRelative = WRAPPER_NEXT_FILES.get(relative) ?? relative;
    const source = path.join(stagedRoot, ...relative.split("/"));
    const destination = path.join(workspace, ...destinationRelative.split("/"));
    await atomicCopy(source, destination);
  }
}

export function validateArchiveEntries(entries, expectedRoot) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("FRAME update archive is empty.");
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("FRAME update archive contains too many entries.");
  const roots = new Set();
  for (const rawEntry of entries) {
    if (typeof rawEntry !== "string" || !rawEntry || rawEntry.includes("\\")) {
      throw new Error("FRAME update archive contains an invalid path.");
    }
    const entry = rawEntry.replace(/\/+$/, "");
    if (!entry) continue;
    if (entry.startsWith("/") || /^[A-Za-z]:/.test(entry)) {
      throw new Error(`FRAME update archive contains absolute path "${rawEntry}".`);
    }
    const parts = entry.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
      throw new Error(`FRAME update archive contains unsafe path "${rawEntry}".`);
    }
    roots.add(parts[0]);
  }
  if (roots.size !== 1 || !roots.has(expectedRoot)) {
    throw new Error("FRAME update archive does not have the expected repository root.");
  }
}

export function validateArchiveEntryTypes(typeLines, expectedCount) {
  if (!Array.isArray(typeLines) || typeLines.length !== expectedCount) {
    throw new Error("FRAME update archive contains links or unsupported entry types.");
  }
  let bytes = 0;
  for (const line of typeLines) {
    const fields = typeof line === "string" ? line.trim().split(/\s+/) : [];
    const size = Number(fields[2]);
    const supportedType = typeof line === "string" && (line.startsWith("-") || line.startsWith("d"));
    if (!supportedType || !Number.isSafeInteger(size) || size < 0) {
      throw new Error("FRAME update archive contains links or unsupported entry types.");
    }
    bytes += size;
    if (bytes > MAX_EXTRACTED_BYTES) throw new Error("FRAME update payload exceeds the extracted-size limit.");
  }
  return bytes;
}

export function relativeDataRootOrNull(value) {
  const raw = String(value ?? "").trim().replaceAll("\\", "/");
  if (!raw) throw new Error("FRAME_DATA_ROOT is empty.");
  const parts = raw.split("/").filter((part) => part && part !== ".");
  if (raw.split("/").includes("..")) throw new Error("FRAME_DATA_ROOT may not contain '..'.");
  if ((raw.startsWith("/") && parts.length === 0) ||
      (/^[A-Za-z]:/.test(raw) && parts.length === 1 && /^[A-Za-z]:$/.test(parts[0]))) {
    throw new Error("FRAME_DATA_ROOT may not be a filesystem root.");
  }
  if (/^[A-Za-z]:[^/]/.test(raw)) {
    throw new Error("FRAME_DATA_ROOT may not use a drive-relative Windows path.");
  }
  const normalized = raw.replace(/\/+$/, "");
  if (isAbsoluteDataRoot(normalized)) return null;
  if (parts.length === 0) throw new Error("FRAME_DATA_ROOT may not be the FRAME installation directory.");
  return parts.join("/");
}

async function requireInstalledWorkspace(workspace) {
  try {
    await access(path.join(workspace, ".env"));
  } catch {
    throw new Error("FRAME is not configured in this folder. Run setup before updating.");
  }
  try {
    await access(path.join(workspace, ".git"));
    throw new Error("Automatic source updates are disabled in a Git checkout. Update this development workspace with Git.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await access(workspace, fsConstants.W_OK);
  } catch {
    throw new Error("The FRAME installation folder is not writable. Move it to a user-owned folder or use an account that can write there.");
  }
}

async function resolveCurrentBuild() {
  const response = await fetch(COMMIT_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "Syronius-FRAME-Updater",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub update lookup failed with HTTP ${response.status}.`);
  const result = await response.json();
  const buildId = String(result?.sha ?? "").toLowerCase();
  if (!SHA_PATTERN.test(buildId)) throw new Error("GitHub returned an invalid FRAME commit identifier.");
  return buildId;
}

async function downloadArchive(url, destination) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Syronius-FRAME-Updater" },
    redirect: "follow",
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) throw new Error(`FRAME update download failed with HTTP ${response.status}.`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || !DOWNLOAD_HOSTS.has(finalUrl.hostname.toLowerCase())) {
    throw new Error("FRAME update download was redirected to an unexpected host.");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_BYTES) {
    throw new Error("FRAME update archive is larger than the allowed limit.");
  }
  const handle = await open(destination, "wx");
  let received = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_ARCHIVE_BYTES) throw new Error("FRAME update archive exceeded the allowed limit.");
      await handle.write(value);
    }
  } finally {
    await handle.close();
  }
  if (received === 0) throw new Error("FRAME update download was empty.");
}

async function listArchiveEntries(archiveFile) {
  const [{ stdout }, { stdout: verbose }] = await Promise.all([
    runTar(["-tzf", archiveFile]),
    runTar(["-tvzf", archiveFile]),
  ]);
  const entries = stdout.split(/\r?\n/).filter(Boolean);
  const typeLines = verbose.split(/\r?\n/).filter(Boolean);
  const bytes = validateArchiveEntryTypes(typeLines, entries.length);
  return { entries, bytes };
}

async function runTar(arguments_) {
  try {
    return await execFileAsync("tar", arguments_, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: NETWORK_TIMEOUT_MS,
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(`Could not inspect or extract the FRAME update archive${detail ? `: ${detail}` : "."}`);
  }
}

async function inspectStagedTree(root) {
  const files = [];
  let bytes = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) throw new Error(`FRAME update payload contains symbolic link "${path.relative(root, fullPath)}".`);
      if (info.isDirectory()) await visit(fullPath);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > MAX_EXTRACTED_BYTES) throw new Error("FRAME update payload exceeds the extracted-size limit.");
        files.push(path.relative(root, fullPath).split(path.sep).join("/"));
      } else throw new Error(`FRAME update payload contains unsupported entry "${path.relative(root, fullPath)}".`);
    }
  }
  await visit(root);
  return { files, bytes };
}

async function validatePayload(root, files, protectedPaths) {
  const available = new Set(files);
  for (const required of REQUIRED_FILES) {
    if (!available.has(required)) throw new Error(`FRAME update payload is missing ${required}.`);
  }
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (packageJson?.name !== "syronius-frame") throw new Error("FRAME update payload has the wrong package identity.");
  for (const [relative, markers] of WRAPPER_CONTRACTS) {
    const wrapper = await readFile(path.join(root, ...relative.split("/")), "utf8");
    if (!wrapper.trim() || markers.some((marker) => !wrapper.includes(marker))) {
      throw new Error(`FRAME update wrapper does not support the required handoff (${relative}).`);
    }
  }
  const normalizedProtected = protectedPaths.map(normalizeRelativePath);
  for (const file of files) {
    assertSafeRelativePath(file);
    if (isProtectedPath(file, normalizedProtected)) {
      throw new Error(`FRAME update payload may not contain protected path "${file}".`);
    }
  }
}

async function verifyStagedPayload(root, files) {
  console.log("[update] checking staged FRAME source...");
  for (const relative of files) {
    const file = path.join(root, ...relative.split("/"));
    if (relative.endsWith(".json")) {
      try {
        JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        throw new Error(`Downloaded JSON is invalid (${relative}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!relative.endsWith(".js") && !relative.endsWith(".mjs")) continue;
    try {
      await execFileAsync(process.execPath, ["--check", file], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
      });
    } catch {
      throw new Error(`Downloaded JavaScript failed its syntax check (${relative}).`);
    }
  }
}

async function requireFreeSpace(workspace, payloadBytes) {
  try {
    const info = await statfs(workspace);
    const available = Number(info.bavail) * Number(info.bsize);
    const required = payloadBytes + 64 * 1024 * 1024;
    if (Number.isFinite(available) && available < required) {
      throw new Error("The FRAME installation drive does not have enough free space for this update.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("does not have enough free space")) throw error;
    // Some Docker bind mounts do not expose statfs; the copy still reports a normal disk error.
  }
}

async function atomicCopy(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.frame-update-${randomUUID()}`;
  try {
    await copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    await chmod(temporary, (await stat(source)).mode & 0o777);
    await replaceFile(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function replaceFile(temporary, destination) {
  try {
    await rename(temporary, destination);
  } catch (error) {
    if (!["EEXIST", "EPERM", "ENOTEMPTY"].includes(error?.code)) throw error;
    const existing = await lstat(destination).catch((statError) => {
      if (statError?.code === "ENOENT") return null;
      throw statError;
    });
    if (existing?.isSymbolicLink() || existing?.isDirectory()) {
      throw new Error(`Refusing to replace unsafe update destination "${destination}".`);
    }
    await rm(destination, { force: true });
    await rename(temporary, destination);
  }
}

function resolveStateRoot(workspace, value) {
  const normalized = String(value).trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (isAbsoluteDataRoot(normalized)) {
    const mounted = String(process.env.FRAME_INSTALLER_DATA_ROOT ?? "").trim();
    if (!mounted) throw new Error("The configured external FRAME_DATA_ROOT is not mounted into the installer runtime.");
    return path.resolve(mounted);
  }
  const relative = relativeDataRootOrNull(normalized);
  return path.resolve(workspace, ...relative.split("/"));
}

function isAbsoluteDataRoot(value) {
  return path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value) || value.startsWith("//");
}

function readEnvValue(contents, key) {
  let value = "";
  for (const line of contents.split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals < 1 || line.slice(0, equals).trim() !== key) continue;
    const raw = line.slice(equals + 1).trim();
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw.slice(1, -1);
      }
    } else {
      value = raw;
    }
  }
  return value;
}

function normalizeRelativePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

function assertSafeRelativePath(value) {
  const normalized = String(value).replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe FRAME update path "${value}".`);
  }
}

async function assertNoDestinationSymlinks(workspace, relative) {
  const parts = relative.split("/");
  let current = workspace;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Refusing to update through symbolic link "${relative}".`);
    if (index < parts.length - 1 && !info.isDirectory()) {
      throw new Error(`Update destination parent is not a directory (${relative}).`);
    }
    if (index === parts.length - 1 && !info.isFile()) {
      throw new Error(`Update destination is not a regular file (${relative}).`);
    }
  }
}

function isProtectedPath(relative, protectedPaths) {
  const normalized = normalizeRelativePath(relative);
  return protectedPaths.some((protectedPath) => normalized === protectedPath || normalized.startsWith(`${protectedPath}/`));
}

async function atomicWriteJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await replaceFile(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
