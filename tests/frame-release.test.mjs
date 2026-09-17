import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  activateRelease, clearDeploymentBackup, clearRelease, completeDeployment, DEPLOYMENT_BACKUP, FRAME_IMAGE_SERVICES,
  readReleaseManifest, recordSourceCommit, recoveryCompose, RELEASE_IMAGE_PREFIX, restoreDeployment,
  snapshotDeployment, SOURCE_COMMIT_FILE, validateReleaseManifest, writeReleaseOverride,
} from "../installer/frame-release.mjs";
import { sourceUpdate } from "../installer/frame-updater.mjs";

const imageId = `sha256:${"a".repeat(64)}`;
const manifest = () => ({ schema_version: 1, commit: "b".repeat(40), platform: "linux/amd64",
  images: Object.fromEntries(FRAME_IMAGE_SERVICES.map((service) => [service, `${RELEASE_IMAGE_PREFIX}/${service}@${imageId}`])) });
const compose = () => ({ name: "syronius-frame", services: {
  "frame-auth": { image: "mutable-local-tag", build: { context: "/source/auth" }, profiles: ["optional"],
    environment: { SECRET: "literal$$PASSWORD$${UNSET}$$$$" }, healthcheck: { test: ["CMD-SHELL", "echo $$PORT"] },
    depends_on: { "frame-portal": { condition: "service_started" } } },
  "frame-portal": { image: "mutable-portal-tag" },
} });
async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "frame-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { workspace: root, dataRoot: path.join(root, "data") };
}

test("release manifest requires every approved service pinned to a digest and commit", () => {
  assert.deepEqual(validateReleaseManifest(manifest()), manifest());
  for (const edit of [
    (m) => { m.commit = "main"; }, (m) => { m.commit = [m.commit]; }, (m) => { m.platform = "linux/arm64"; },
    (m) => { delete m.images["frame-auth"]; }, (m) => { m.images.extra = imageId; },
    (m) => { m.images["frame-auth"] = `${RELEASE_IMAGE_PREFIX}/frame-auth:latest`; },
    (m) => { m.images["frame-auth"] = `ghcr.io/untrusted/frame-auth@${imageId}`; },
    (m) => { m.images["frame-auth"] = `${RELEASE_IMAGE_PREFIX}/frame-portal@${imageId}`; },
  ]) { const value = manifest(); edit(value); assert.throws(() => validateReleaseManifest(value)); }
});

test("release override keeps build source intact, rejects invalid state, and can be cleared", async (t) => {
  const { workspace: root } = await workspace(t);
  await writeFile(path.join(root, "docker-compose.yml"), "services: {}\n");
  await recordSourceCommit(root, manifest().commit);
  await activateRelease(root, manifest());
  assert.deepEqual(await readReleaseManifest(path.join(root, "frame-release.json")), manifest());
  const override = JSON.parse(await readFile(path.join(root, "docker-compose.release.json")));
  assert.equal(Object.keys(override.services).length, 13);
  assert.deepEqual(override.services["frame-auth"], { image: manifest().images["frame-auth"], platform: "linux/amd64" });
  assert.equal(await readFile(path.join(root, "docker-compose.yml"), "utf8"), "services: {}\n");
  await writeFile(path.join(root, "frame-release.json"), "");
  await assert.rejects(writeReleaseOverride(root));
  await clearRelease(root);
  await assert.rejects(readFile(path.join(root, "docker-compose.release.json")), { code: "ENOENT" });
});

test("recovery pins only previously running services and preserves literal Compose dollars", () => {
  const result = recoveryCompose(compose(), { "frame-auth": imageId });
  assert.deepEqual(Object.keys(result.services), ["frame-auth"]);
  const auth = result.services["frame-auth"];
  assert.equal(auth.image, imageId);
  assert.equal(auth.build, undefined);
  assert.equal(auth.profiles, undefined);
  assert.deepEqual(auth.depends_on, {});
  assert.equal(auth.environment.SECRET, "literal$$PASSWORD$${UNSET}$$$$");
  assert.deepEqual(auth.healthcheck.test, ["CMD-SHELL", "echo $$PORT"]);
  assert.throws(() => recoveryCompose({ ...compose(), name: "other-project" }, { "frame-auth": imageId }));
  assert.throws(() => recoveryCompose(compose(), { "frame-auth": "latest" }));
});

test("recovery Compose round-trips interpolated credentials and commands through the real CLI", async (t) => {
  const exec = promisify(execFile);
  try { await exec("docker", ["compose", "version"], { timeout: 10_000, windowsHide: true }); }
  catch (error) {
    if (error.code === "ENOENT" || typeof error.code === "number") return t.skip("Docker Compose CLI is unavailable");
    throw error;
  }
  const { workspace: root } = await workspace(t);
  const source = path.join(root, "source.json");
  const recovery = path.join(root, "recovery.json");
  const envFile = path.join(root, ".env");
  await writeFile(envFile, "FRAME_TEST_LITERAL_SECRET='literal$PASSWORD${UNSET}$$'\n");
  await writeFile(source, JSON.stringify({ name: "syronius-frame", services: {
    "frame-auth": { image: "alpine:3", environment: { SECRET: "${FRAME_TEST_LITERAL_SECRET}" },
      command: ["sh", "-c", "echo $$PORT $${SECRET}"],
      healthcheck: { test: ["CMD-SHELL", "echo $$PORT $${SECRET}"] },
      labels: { "fixture.description": "label$$DOLLAR" } },
  } }));
  const config = async (file) => JSON.parse((await exec("docker", ["compose", "--project-directory", root,
    "--env-file", envFile, "-f", file, "config", "--format", "json"], { timeout: 10_000, windowsHide: true })).stdout);
  const first = await config(source);
  await writeFile(recovery, JSON.stringify(recoveryCompose(first, { "frame-auth": imageId })));
  const second = await config(recovery);
  for (const field of ["environment", "command", "healthcheck", "labels"]) {
    assert.deepEqual(second.services["frame-auth"][field], first.services["frame-auth"][field], `${field} must survive recovery unchanged`);
  }
  assert.equal(second.services["frame-auth"].image, imageId);
});

test("failed deployment restores config and release selection without rewinding photo data", async (t) => {
  const args = await workspace(t);
  await mkdir(path.join(args.dataRoot, "state"), { recursive: true });
  await writeFile(path.join(args.workspace, ".env"), "FRAME_DATA_ROOT=./data\nPASSWORD=original$secret\n");
  await writeFile(path.join(args.workspace, "docker-compose.yml"), "original compose");
  await writeFile(path.join(args.dataRoot, "state", "public-routes.yml"), "original routes");
  await writeFile(path.join(args.dataRoot, "state", "cloudflare-tunnel-token"), "original token\n");
  for (const file of ["frame-install-plan.json", "frame-install.json"]) await writeFile(path.join(args.dataRoot, "state", file), '{"generation":"original"}');
  await recordSourceCommit(args.workspace, manifest().commit);
  await activateRelease(args.workspace, manifest());
  await snapshotDeployment({ ...args, compose: compose(), images: { "frame-auth": imageId } });
  await writeFile(path.join(args.workspace, ".env"), "failed environment");
  await writeFile(path.join(args.dataRoot, "state", "public-routes.yml"), "failed routes");
  await writeFile(path.join(args.dataRoot, "state", "cloudflare-tunnel-token"), "failed token\n");
  for (const file of ["frame-install-plan.json", "frame-install.json"]) await writeFile(path.join(args.dataRoot, "state", file), '{"generation":"candidate"}');
  await writeFile(path.join(args.dataRoot, "state", "pending-source-update.json"), "failed update");
  await writeFile(path.join(args.dataRoot, "photo.jpg"), "new photo must survive");
  await clearRelease(args.workspace);
  await snapshotDeployment({ ...args, compose: compose(), images: { "frame-auth": `sha256:${"c".repeat(64)}` } });
  await restoreDeployment(args);
  assert.equal(await readFile(path.join(args.workspace, ".env"), "utf8"), "FRAME_DATA_ROOT=./data\nPASSWORD=original$secret\n");
  assert.equal(await readFile(path.join(args.dataRoot, "state", "public-routes.yml"), "utf8"), "original routes");
  assert.equal(await readFile(path.join(args.dataRoot, "state", "cloudflare-tunnel-token"), "utf8"), "original token\n");
  for (const file of ["frame-install-plan.json", "frame-install.json"]) assert.equal(await readFile(path.join(args.dataRoot, "state", file), "utf8"), '{"generation":"original"}');
  assert.equal(await readFile(path.join(args.dataRoot, "photo.jpg"), "utf8"), "new photo must survive");
  assert.deepEqual(await readReleaseManifest(path.join(args.workspace, "frame-release.json")), manifest());
  await assert.rejects(readFile(path.join(args.dataRoot, "state", "pending-source-update.json")), { code: "ENOENT" });
  const recovery = JSON.parse(await readFile(path.join(args.workspace, DEPLOYMENT_BACKUP, "compose.json")));
  assert.equal(recovery.services["frame-auth"].image, imageId, "nested start must retain the original snapshot");
  await completeDeployment(args.workspace);
  const snapshotFile = path.join(args.workspace, DEPLOYMENT_BACKUP, "snapshot.json");
  assert.equal(JSON.parse(await readFile(snapshotFile)).pending, false);
  if (process.platform !== "win32") assert.equal((await stat(snapshotFile)).mode & 0o777, 0o600);
  await snapshotDeployment({ ...args, compose: compose(), images: { "frame-auth": `sha256:${"c".repeat(64)}` } });
  assert.equal(JSON.parse(await readFile(path.join(args.workspace, DEPLOYMENT_BACKUP, "compose.json"))).services["frame-auth"].image, `sha256:${"c".repeat(64)}`);
});

test("runtime recovery cannot pair restored release images with newer source files", async (t) => {
  const args = await workspace(t);
  const original = manifest();
  await recordSourceCommit(args.workspace, original.commit);
  await activateRelease(args.workspace, original);
  await snapshotDeployment({ ...args, compose: compose(), images: { "frame-auth": imageId } });
  const newerCommit = "c".repeat(40);
  await recordSourceCommit(args.workspace, newerCommit);
  await activateRelease(args.workspace, { ...original, commit: newerCommit });
  await restoreDeployment(args);
  assert.equal((await readReleaseManifest(path.join(args.workspace, "frame-release.json"))).commit, original.commit);
  assert.equal(await readFile(path.join(args.workspace, SOURCE_COMMIT_FILE), "utf8"), `${newerCommit}\n`);
  await assert.rejects(writeReleaseOverride(args.workspace), /Recovery does not restore source files; rerun stack update --image-manifest/);
  await rm(path.join(args.workspace, SOURCE_COMMIT_FILE));
  await assert.rejects(writeReleaseOverride(args.workspace), /do not match the installed source commit/);
  await recordSourceCommit(args.workspace, original.commit);
  await writeReleaseOverride(args.workspace);
  await assert.rejects(recordSourceCommit(args.workspace, "main"), /full commit SHA/);
});

test("release updates request the manifest commit and leave source identity unchanged before verification", async (t) => {
  const { workspace: root } = await workspace(t);
  const oldCommit = "c".repeat(40);
  await writeFile(path.join(root, ".env"), "FRAME_DATA_ROOT=./data\n");
  await writeFile(path.join(root, "candidate.json"), JSON.stringify(manifest()));
  await recordSourceCommit(root, oldCommit);
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    throw new Error("isolated download failure");
  });
  await assert.rejects(sourceUpdate({ workspace: root, imageManifest: "candidate.json" }), /isolated download failure/);
  assert.deepEqual(urls, [`https://github.com/gall-levi-code/Syronius_FRAME/archive/${manifest().commit}.tar.gz`]);
  assert.equal(await readFile(path.join(root, SOURCE_COMMIT_FILE), "utf8"), `${oldCommit}\n`);
});

test("a failed same-commit source overlay invalidates release reconciliation", async (t) => {
  const { workspace: root } = await workspace(t);
  const installed = path.join(root, "installed");
  const archiveRoot = `Syronius_FRAME-${manifest().commit}`;
  const staged = path.join(root, archiveRoot);
  const files = {
    "package.json": '{"name":"syronius-frame"}',
    "installer/frame-installer.mjs": "export {};",
    "installer/frame-env.mjs": "export {};",
    "installer/frame-updater.mjs": "export {};",
    "installer/frame-release.mjs": "export {};",
    "installer/frame-contract.mjs": "export {};",
    "installer/stack.ps1": '"update" { }\n"start" { }\n"finalize-source-update" { }',
    "installer/stack.sh": "update)\nstart)\nfinalize-source-update)",
    "installer/templates/docker-compose.yml": "services: {}",
    "scripts/verify.mjs": "export {};",
    "stack.cmd": "echo fixture",
    "stack.sh": "echo fixture",
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(staged, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  const archive = path.join(root, "source.tar.gz");
  await promisify(execFile)("tar", ["-czf", archive, "-C", root, archiveRoot], { timeout: 10_000, windowsHide: true });
  let bytes = await readFile(archive);
  t.mock.method(globalThis, "fetch", async (url) => {
    const response = new Response(bytes);
    Object.defineProperty(response, "url", { value: url });
    return response;
  });
  await mkdir(path.join(installed, "scripts", "verify.mjs"), { recursive: true });
  await writeFile(path.join(installed, ".env"), "FRAME_DATA_ROOT=./data\n");
  await recordSourceCommit(installed, manifest().commit);
  await activateRelease(installed, manifest());
  await assert.rejects(sourceUpdate({ workspace: installed, imageManifest: "frame-release.json" }), /not a regular file/);
  await assert.rejects(readFile(path.join(installed, SOURCE_COMMIT_FILE)), { code: "ENOENT" });
  await assert.rejects(writeReleaseOverride(installed), /do not match the installed source commit/);
  await recordSourceCommit(installed, manifest().commit);
  await writeFile(path.join(staged, SOURCE_COMMIT_FILE), `${"f".repeat(40)}\n`);
  await promisify(execFile)("tar", ["-czf", archive, "-C", root, archiveRoot], { timeout: 10_000, windowsHide: true });
  bytes = await readFile(archive);
  await assert.rejects(sourceUpdate({ workspace: installed, imageManifest: "frame-release.json" }), /protected path "frame-source-commit"/);
  assert.equal(await readFile(path.join(installed, SOURCE_COMMIT_FILE), "utf8"), `${manifest().commit}\n`);
});

test("reset removes only owned deployment backup files and cannot resurrect old credentials", async (t) => {
  const args = await workspace(t);
  await writeFile(path.join(args.workspace, ".env"), "OLD_PASSWORD=fixture-secret\n");
  await snapshotDeployment({ ...args, compose: compose(), images: { "frame-auth": imageId } });
  const unrelated = path.join(args.workspace, DEPLOYMENT_BACKUP, "user-note.txt");
  await writeFile(unrelated, "keep this file");
  await clearDeploymentBackup(args.workspace);
  for (const name of ["snapshot.json", "compose.json", ".env"]) {
    await assert.rejects(readFile(path.join(args.workspace, DEPLOYMENT_BACKUP, name)), { code: "ENOENT" });
  }
  assert.equal(await readFile(unrelated, "utf8"), "keep this file");
  await assert.rejects(restoreDeployment(args), { code: "ENOENT" });
  await clearDeploymentBackup(args.workspace);
});

test("first install recovery restores absent config and never creates a fake old runtime", async (t) => {
  const args = await workspace(t);
  await snapshotDeployment({ ...args, compose: { name: "syronius-frame", services: {} }, images: {} });
  await assert.rejects(readFile(path.join(args.workspace, DEPLOYMENT_BACKUP, "compose.json")), { code: "ENOENT" });
  await writeFile(path.join(args.workspace, ".env"), "candidate");
  await mkdir(path.join(args.dataRoot, "state"), { recursive: true });
  await writeFile(path.join(args.dataRoot, "state", "cloudflare-tunnel-token"), "candidate token");
  await restoreDeployment(args);
  await assert.rejects(readFile(path.join(args.workspace, ".env")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(args.dataRoot, "state", "cloudflare-tunnel-token")), { code: "ENOENT" });
});

test("legacy deployment backups remain recoverable without deleting an unrecorded tunnel token", async (t) => {
  const args = await workspace(t);
  await writeFile(path.join(args.workspace, ".env"), "original");
  await snapshotDeployment({ ...args, compose: compose(), images: {} });
  const snapshotPath = path.join(args.workspace, DEPLOYMENT_BACKUP, "snapshot.json");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  snapshot.schema_version = 1;
  delete snapshot.state["cloudflare-tunnel-token"];
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  await mkdir(path.join(args.dataRoot, "state"), { recursive: true });
  await writeFile(path.join(args.dataRoot, "state", "cloudflare-tunnel-token"), "unrecorded token");
  await writeFile(path.join(args.workspace, ".env"), "candidate");
  await restoreDeployment(args);
  assert.equal(await readFile(path.join(args.workspace, ".env"), "utf8"), "original");
  assert.equal(await readFile(path.join(args.dataRoot, "state", "cloudflare-tunnel-token"), "utf8"), "unrecorded token");
});

test("deployment backup refuses linked destinations before restoring any generated file", async (t) => {
  const args = await workspace(t);
  await writeFile(path.join(args.workspace, ".env"), "original");
  await snapshotDeployment({ ...args, compose: compose(), images: { "frame-auth": imageId } });
  const outside = path.join(args.workspace, "untouched");
  await writeFile(outside, "outside");
  try { await symlink(outside, path.join(args.workspace, "docker-compose.yml")); }
  catch (error) { if (error.code === "EPERM") return t.skip("Host does not permit file symlinks"); throw error; }
  await writeFile(path.join(args.workspace, ".env"), "candidate");
  await assert.rejects(restoreDeployment(args), /Unsafe FRAME deployment path/);
  assert.equal(await readFile(path.join(args.workspace, ".env"), "utf8"), "candidate");
  assert.equal(await readFile(outside, "utf8"), "outside");
});
