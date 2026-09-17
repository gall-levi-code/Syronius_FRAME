import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const FRAME_IMAGE_SERVICES = [
  "frame-auth", "frame-audio", "frame-audio-bridge", "frame-belabox-manager", "frame-gallery",
  "frame-ingest-video", "frame-overlays", "frame-photo-ftp", "frame-photo-upload",
  "frame-pipeline-photos", "frame-portal", "frame-streams", "frame-today",
];
export const RELEASE_IMAGE_PREFIX = "ghcr.io/gall-levi-code/syronius-frame";
export const RELEASE_MANIFEST_FILE = "frame-release.json";
export const RELEASE_COMPOSE_FILE = "docker-compose.release.json";
export const SOURCE_COMMIT_FILE = "frame-source-commit";
export const DEPLOYMENT_BACKUP = ".frame-deployment-backup";
const WORKSPACE_FILES = [".env", "docker-compose.yml", RELEASE_MANIFEST_FILE, RELEASE_COMPOSE_FILE];
const STATE_FILES = ["stack-config.json", "effective-public-prefixes.json", "cloudflared-ingress.yml", "public-routes.yml", "installed-build.json", "pending-source-update.json", "frame-install-plan.json", "frame-install.json", "cloudflare-tunnel-token"];
const SERVICES = new Set([...FRAME_IMAGE_SERVICES, "frame-edge", "frame-docker-proxy", "frame-public-gateway", "frame-tunnel"]);

export function validateReleaseManifest(value) {
  if (!value || value.schema_version !== 1 || typeof value.commit !== "string" || !/^[0-9a-f]{40}$/.test(value.commit)
    || value.platform !== "linux/amd64" || !value.images || typeof value.images !== "object" || Array.isArray(value.images)) {
    throw new Error("Invalid FRAME release manifest: expected schema 1, commit SHA, linux/amd64 and image digests.");
  }
  const keys = Object.keys(value.images);
  if (keys.length !== FRAME_IMAGE_SERVICES.length || keys.some((key) => !FRAME_IMAGE_SERVICES.includes(key))) {
    throw new Error("FRAME release manifest must contain exactly the 13 FRAME service images.");
  }
  for (const service of FRAME_IMAGE_SERVICES) {
    const prefix = `${RELEASE_IMAGE_PREFIX}/${service}@sha256:`;
    const image = value.images[service];
    if (typeof image !== "string" || !image.startsWith(prefix) || !/^[0-9a-f]{64}$/.test(image.slice(prefix.length))) {
      throw new Error(`Invalid release image digest for ${service}.`);
    }
  }
  return { schema_version: 1, commit: value.commit, platform: value.platform, images: { ...value.images } };
}

export async function readReleaseManifest(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.size > 64 * 1024) throw new Error("Release manifest must be a regular JSON file no larger than 64 KiB.");
  return validateReleaseManifest(JSON.parse(await readFile(file, "utf8")));
}

export async function activateRelease(workspace, manifest) {
  await atomicFile(workspace, RELEASE_MANIFEST_FILE, `${JSON.stringify(validateReleaseManifest(manifest), null, 2)}\n`);
  await writeReleaseOverride(workspace);
}

export async function recordSourceCommit(workspace, commit) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("FRAME source commit must be a full commit SHA.");
  await atomicFile(workspace, SOURCE_COMMIT_FILE, `${commit}\n`);
}

export async function writeReleaseOverride(workspace) {
  const file = path.join(workspace, RELEASE_MANIFEST_FILE);
  if (await optionalFile(file) === null) {
    await safeRemove(workspace, RELEASE_COMPOSE_FILE);
    return;
  }
  const manifest = await readReleaseManifest(file);
  await assertSafePath(workspace, SOURCE_COMMIT_FILE);
  const sourceCommit = await optionalFile(path.join(workspace, SOURCE_COMMIT_FILE));
  if (sourceCommit?.trim() !== manifest.commit) {
    throw new Error("FRAME release images do not match the installed source commit. Recovery does not restore source files; rerun stack update --image-manifest FILE with the intended release before starting FRAME.");
  }
  await atomicFile(workspace, RELEASE_COMPOSE_FILE, `${JSON.stringify({ services: Object.fromEntries(
    FRAME_IMAGE_SERVICES.map((service) => [service, { image: manifest.images[service], platform: manifest.platform }]),
  ) }, null, 2)}\n`);
}

export async function clearRelease(workspace) {
  for (const file of [RELEASE_MANIFEST_FILE, RELEASE_COMPOSE_FILE]) await safeRemove(workspace, file);
}

export function recoveryCompose(compose, images) {
  if (!compose || compose.name !== "syronius-frame" || !compose.services || !images || typeof images !== "object" || Array.isArray(images)) {
    throw new Error("Invalid FRAME deployment snapshot input.");
  }
  const previous = structuredClone(compose);
  previous.services = {};
  for (const [service, image] of Object.entries(images)) {
    if (!SERVICES.has(service) || !compose.services[service] || !/^sha256:[0-9a-f]{64}$/.test(image)) {
      throw new Error(`Invalid previous FRAME image for ${service}.`);
    }
    const config = { ...compose.services[service], image };
    delete config.build;
    delete config.profiles;
    delete config.pull_policy;
    if (config.depends_on) config.depends_on = Object.fromEntries(Object.entries(config.depends_on).filter(([name]) => Object.hasOwn(images, name)));
    previous.services[service] = config;
  }
  // `compose config` already escapes literal dollars for another Compose read.
  return previous;
}

export async function snapshotDeployment({ workspace, dataRoot, compose, images }) {
  const backup = path.join(workspace, DEPLOYMENT_BACKUP);
  await assertSafePath(workspace, `${DEPLOYMENT_BACKUP}/snapshot.json`);
  const prior = await optionalFile(path.join(backup, "snapshot.json"));
  if (prior && JSON.parse(prior).pending) return;
  const recovery = recoveryCompose(compose, images);
  const files = {};
  for (const file of WORKSPACE_FILES) {
    await assertSafePath(workspace, file);
    files[file] = await optionalFile(path.join(workspace, file));
  }
  const state = {};
  for (const file of STATE_FILES) {
    await assertSafePath(dataRoot, `state/${file}`);
    state[file] = await optionalFile(path.join(dataRoot, "state", file));
  }
  await mkdir(backup, { recursive: true, mode: 0o700 });
  await chmod(backup, 0o700);
  await atomicFile(backup, ".env", files[".env"] ?? "");
  if (Object.keys(recovery.services).length) await atomicFile(backup, "compose.json", `${JSON.stringify(recovery, null, 2)}\n`);
  else await safeRemove(backup, "compose.json");
  await atomicFile(backup, "snapshot.json", `${JSON.stringify({ schema_version: 2, pending: true, files, state }, null, 2)}\n`);
}

export async function restoreDeployment({ workspace, dataRoot }) {
  const backup = path.join(workspace, DEPLOYMENT_BACKUP);
  await assertSafePath(workspace, `${DEPLOYMENT_BACKUP}/snapshot.json`);
  const snapshot = JSON.parse(await readFile(path.join(backup, "snapshot.json"), "utf8"));
  if (![1, 2].includes(snapshot.schema_version) || !snapshot.files || !snapshot.state) throw new Error("Invalid FRAME deployment backup.");
  // Older backups did not capture the tunnel token; leave that unrecorded secret intact.
  const stateFiles = snapshot.schema_version === 1 ? STATE_FILES.filter((name) => name !== "cloudflare-tunnel-token") : STATE_FILES;
  for (const [root, files, names, prefix] of [[workspace, snapshot.files, WORKSPACE_FILES, ""], [dataRoot, snapshot.state, stateFiles, "state/"]]) {
    if (Object.keys(files).length !== names.length || names.some((name) => files[name] !== null && typeof files[name] !== "string")) throw new Error("Incomplete FRAME deployment backup.");
    for (const name of names) await assertSafePath(root, `${prefix}${name}`);
  }
  for (const [root, files, names, prefix] of [[workspace, snapshot.files, WORKSPACE_FILES, ""], [dataRoot, snapshot.state, stateFiles, "state/"]]) {
    for (const name of names) {
      if (files[name] === null) await safeRemove(root, `${prefix}${name}`);
      else await atomicFile(root, `${prefix}${name}`, files[name]);
    }
  }
}

export async function completeDeployment(workspace) {
  const file = `${DEPLOYMENT_BACKUP}/snapshot.json`;
  await assertSafePath(workspace, file);
  const text = await optionalFile(path.join(workspace, file));
  if (!text) return;
  const snapshot = JSON.parse(text);
  snapshot.pending = false;
  await atomicFile(workspace, file, `${JSON.stringify(snapshot, null, 2)}\n`);
}

export async function clearDeploymentBackup(workspace) {
  const files = ["snapshot.json", "compose.json", ".env"].map((file) => `${DEPLOYMENT_BACKUP}/${file}`);
  for (const file of files) await assertSafePath(workspace, file);
  for (const file of files) await safeRemove(workspace, file);
}

async function optionalFile(file) {
  try { return await readFile(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function assertSafePath(root, relative, directory = false) {
  let current = path.resolve(root);
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info) return;
    if (info.isSymbolicLink() || ((index < parts.length - 1 || directory) ? !info.isDirectory() : !info.isFile())) throw new Error(`Unsafe FRAME deployment path: ${relative}`);
  }
}

async function safeRemove(root, relative) {
  await assertSafePath(root, relative);
  await rm(path.join(root, relative), { force: true });
}

async function atomicFile(root, relative, contents) {
  await assertSafePath(root, relative);
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
