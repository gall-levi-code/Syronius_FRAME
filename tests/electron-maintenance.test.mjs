import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBackend } from "../apps/frame-setup/electron/backend.mjs";
import { activateRelease, recordSourceCommit, FRAME_IMAGE_SERVICES, RELEASE_IMAGE_PREFIX } from "../installer/frame-release.mjs";

const resourcesRoot = fileURLToPath(new URL("..", import.meta.url));
const oldCommit = "a".repeat(40), newCommit = "c".repeat(40);
const oldImage = `sha256:${"b".repeat(64)}`, newImage = `sha256:${"d".repeat(64)}`;
const releaseManifest = (commit = oldCommit) => ({ schema_version: 1, commit, platform: "linux/amd64", images: Object.fromEntries(
  FRAME_IMAGE_SERVICES.map((name) => [name, `${RELEASE_IMAGE_PREFIX}/${name}@${commit === oldCommit ? oldImage : newImage}`])) });
const stateFiles = ["stack-config.json", "effective-public-prefixes.json", "cloudflared-ingress.yml", "public-routes.yml", "cloudflare-tunnel-token"];

async function fixture(t, { stopped = false, missing = false, knownVersion = true, platform = "linux" } = {}) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "FRAME maintenance ")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT"]) {
    const previous = process.env[key]; delete process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const managedRoot = path.join(temporary, "managed"), installRoot = path.join(managedRoot, "deployment"), dataRoot = path.join(temporary, "media");
  const userData = path.join(managedRoot, "launcher");
  await mkdir(path.join(installRoot, "installer"), { recursive: true });
  await mkdir(path.join(dataRoot, "state"), { recursive: true });
  await mkdir(path.join(dataRoot, "audio-monitor"));
  const env = `FRAME_DATA_ROOT=${dataRoot.replaceAll("\\", "/")}\nEDGE_HTTP_PORT=80\nPORTAL_PASSWORD=private-password\nCOMPOSE_PROFILES=audio-monitor\n`;
  const compose = { name: "syronius-frame", services: {
    "frame-edge": { image: `traefik@${oldImage}`, ports: [] },
    "frame-audio": { image: releaseManifest().images["frame-audio"], volumes: [{ type: "bind", source: path.join(dataRoot, "audio-monitor"), target: "/data" }] },
  } };
  await writeFile(path.join(installRoot, ".env"), env);
  await writeFile(path.join(installRoot, "docker-compose.yml"), JSON.stringify(compose));
  await writeFile(path.join(installRoot, "installer/frame-installer.mjs"), "// checkAudioBridgeExtraction process.env.FRAME_WORKSPACE old source\n");
  await writeFile(path.join(installRoot, "installer/frame-release.mjs"), "// linux/arm64\n");
  for (const file of ["stack.ps1", "stack.sh"]) await writeFile(path.join(installRoot, "installer", file), "old wrapper deployment-restore\n");
  await writeFile(path.join(installRoot, "managed.txt"), "old release bytes\n");
  await writeFile(path.join(installRoot, "user-note.txt"), "not managed by updater\n");
  await writeFile(path.join(dataRoot, "audio-monitor/user-media.txt"), "precious user content\n");
  for (const file of stateFiles) await writeFile(path.join(dataRoot, "state", file), file === "cloudflare-tunnel-token" ? "private-token" : "{}\n");
  await writeFile(path.join(dataRoot, "state/installed-build.json"), JSON.stringify({ schema_version: 1, build_id: oldCommit, ...(knownVersion ? { release_tag: "v1.0.0" } : {}) }));
  await recordSourceCommit(installRoot, oldCommit); await activateRelease(installRoot, releaseManifest());
  let nextId = 0;
  const container = (name, service, running = false) => ({ Id: (++nextId).toString(16).padStart(64, "0"), Image: service.image.startsWith("sha256:") ? service.image : service.image.split("@")[1],
    Config: { Image: service.image, Labels: { "com.docker.compose.project": "syronius-frame", "com.docker.compose.project.working_dir": installRoot, "com.docker.compose.service": name } },
    State: { Running: running, Status: running ? "running" : "exited", ...(name === "frame-audio" ? { Health: { Status: "healthy" } } : {}) }, NetworkSettings: { Ports: {} },
    Mounts: (service.volumes || []).map((volume) => ({ Type: "bind", Source: volume.source, Destination: volume.target })) });
  const state = { calls: [], fetches: [], available: true, version: "v1.1.0", manifest: releaseManifest(newCommit), failStart: false, failRecovery: false,
    containers: Object.entries(compose.services).map(([name, service], index) => container(name, service, !stopped && index === 0)), full: false, progress: [] };
  if (missing) state.containers.pop();
  const resolveCompose = async (args) => {
    const files = args.flatMap((value, index) => value === "-f" ? [args[index + 1]] : []);
    const result = JSON.parse(await readFile(files[0], "utf8"));
    if (files[1]) {
      const override = JSON.parse(await readFile(files[1], "utf8"));
      for (const [name, service] of Object.entries(result.services)) Object.assign(service, override.services[name]);
    }
    return result;
  };
  const run = async (command, args, options = {}) => {
    state.calls.push({ command, args, options });
    if (command !== "docker") {
      const workspace = options.env.FRAME_WORKSPACE;
      if (args[1] === "source-update") {
        if (state.failDownload) throw new Error("download private-password");
        await mkdir(path.join(workspace, "installer"), { recursive: true });
        await writeFile(path.join(workspace, "installer/frame-installer.mjs"), "// checkAudioBridgeExtraction process.env.FRAME_WORKSPACE new source\n");
        await writeFile(path.join(workspace, "installer/frame-release.mjs"), "// linux/arm64\n");
        for (const file of ["stack.ps1", "stack.sh"]) await writeFile(path.join(workspace, "installer", `${file}.next`), "new wrapper deployment-restore\n");
        await writeFile(path.join(workspace, "managed.txt"), "new release bytes\n");
        await writeFile(path.join(workspace, "new-managed.txt"), "newly added release file\n");
        await recordSourceCommit(workspace, state.manifest.commit); await activateRelease(workspace, state.manifest);
      } else if (args[1] === "install") {
        await writeFile(path.join(workspace, "docker-compose.yml"), JSON.stringify(compose));
        await mkdir(path.join(options.env.FRAME_INSTALLER_DATA_ROOT, "state"), { recursive: true });
        for (const file of stateFiles) await writeFile(path.join(options.env.FRAME_INSTALLER_DATA_ROOT, "state", file), await readFile(path.join(dataRoot, "state", file)));
      } else assert.equal(args[1], "validate");
      return { stdout: "" };
    }
    if (!state.available) throw new Error("private-password Docker unavailable");
    if (args[0] === "context") return { stdout: JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]) };
    if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: state.engineArch || "amd64" }) };
    if (args[1] === "version") return { stdout: "" };
    if (args[0] === "ps") return { stdout: args.includes("--format") ? state.containers.map((c) => JSON.stringify([c.Id, c.Config.Labels["com.docker.compose.project.working_dir"], c.Config.Labels["com.docker.compose.service"]])).join("\n") : state.containers.map((c) => c.Id).join("\n") };
    if (args[0] === "inspect") { await state.beforeInspect?.(); return { stdout: JSON.stringify(state.containers.filter((c) => args.includes(c.Id))) }; }
    if (args[0] === "image") {
      if (state.missingRecoveryImage && args[2].startsWith("sha256:")) throw new Error("Recovery image missing private-password");
      return { stdout: args[2].startsWith("sha256:") ? args[2] : args[2].split("@")[1] };
    }
    if (args.includes("config")) { if (state.failConfig) throw new Error("private-password invalid Compose"); return { stdout: JSON.stringify(await resolveCompose(args)) }; }
    if (args[0] === "pull") { if (state.failPull) throw new Error("private-password pull failed"); return { stdout: "" }; }
    if (args[0] === "stop") {
      for (const c of state.containers) if (args.includes(c.Id) && !state.failStop) c.State = { Running: false, Status: "exited" };
      if (state.failStop) throw new Error("private-password stop failed");
      if (state.fullAfterStop) state.full = true;
      return { stdout: "" };
    }
    if (args[0] === "rm") {
      assert.ok(!args.includes("-f") && !args.includes("-v"));
      state.containers = state.containers.filter((c, index) => !args.includes(c.Id) || state.failRemove && index > 0);
      if (state.failRemove) throw new Error("private-password remove failed");
      return { stdout: "" };
    }
    if (args[0] === "start") {
      if (state.failResume) throw new Error("private-password resume failed");
      for (const c of state.containers) if (args.includes(c.Id)) c.State = { Running: true, Status: "running", Health: { Status: "healthy" } };
      return { stdout: "" };
    }
    if (args.includes("up")) {
      assert.ok(args.includes("--no-start") && args.includes("--no-build") && args.includes("never"));
      const resolved = await resolveCompose(args);
      if (args.some((arg) => arg.endsWith("maintenance-compose.json"))) {
        assert.equal((await readFile(path.join(installRoot, "frame-source-commit"), "utf8")).trim(), oldCommit, "source must be restored BEFORE old containers are recreated");
        if (state.failRecovery) throw new Error("private-password recovery failed");
      }
      for (const [name, service] of Object.entries(resolved.services)) {
        state.containers = state.containers.filter((c) => c.Config.Labels["com.docker.compose.service"] !== name);
        state.containers.push(container(name, service));
      }
      return { stdout: "" };
    }
    if (args.includes("start")) {
      const names = args.slice(args.indexOf("120") + 1);
      if (state.failStart && !args.some((arg) => arg.endsWith("maintenance-compose.json"))) throw new Error("private-password start failed");
      for (const c of state.containers) if (names.includes(c.Config.Labels["com.docker.compose.service"])) c.State = { Running: true, Status: "running", Health: { Status: "healthy" } };
      return { stdout: "" };
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  const fetchImpl = async (url) => {
    state.fetches.push(url);
    return Response.json(String(url).includes("api.github.com") ? { tag_name: state.version, draft: false, prerelease: false, published_at: "2026-09-30T12:00:00Z", body: "Release notes.", assets: [
      { name: "frame-images.json", browser_download_url: `https://github.com/gall-levi-code/Syronius_FRAME/releases/download/${state.version}/frame-images.json` },
      { name: `FRAME-Setup-${state.version.slice(1)}-linux-x86_64.AppImage`, browser_download_url: `https://github.com/gall-levi-code/Syronius_FRAME/releases/download/${state.version}/FRAME-Setup-${state.version.slice(1)}-linux-x86_64.AppImage` },
    ] } : state.manifest);
  };
  const backend = createBackend({ userData, managedRoot, defaultDataRoot: dataRoot, resourcesRoot, run, fetchImpl, platform, arch: "x64", launcherVersion: "1.0.0",
    storageProbe: async (_location, label) => ({ label, status: state.full ? "bad" : "good", detail: state.full ? "Storage full." : "Storage ready." }),
    dockerStorageProbe: async () => ({ label: "Docker storage", status: "good", detail: "Ready." }),
    setIntervalImpl: () => 1, clearIntervalImpl: () => {}, emit: (event, payload) => { if (event === "launcher-progress") {
      state.progress.push(payload); if (state.failNotification && payload.phase === "complete") throw new Error("Notification transport unavailable");
    } } });
  t.after(() => backend.dispose());
  return { backend, state, installRoot, dataRoot, temporary, env };
}

test("update checks are read-only, cached, version-aware and still offer launcher packages with Docker offline", async (t) => {
  const { backend, state, installRoot } = await fixture(t);
  const checked = await backend.invoke("check_updates", { installRoot });
  assert.equal(checked.launcher.currentVersion, "1.0.0"); assert.equal(checked.launcher.available, true);
  assert.equal(checked.frame.currentVersion, "v1.0.0"); assert.equal(checked.frame.tag, "v1.1.0"); assert.equal(checked.frame.available, true);
  assert.equal((await backend.invoke("get_launcher_status")).updates.frame.available, true);
  assert.ok(state.calls.every(({ command, args }) => command === "docker" && !args.some((arg) => ["pull", "up", "start", "stop"].includes(arg))));
  state.available = false;
  const offline = await backend.invoke("check_updates", { installRoot });
  assert.equal(offline.launcher.available, true); assert.match(offline.launcher.downloadUrl, /\.AppImage$/);
  assert.equal(offline.frame.eligible, false); assert.ok(!JSON.stringify(offline).includes("private-password"));
});

test("an unchecked target, changed stable metadata and unknown installed release cannot authorize an update", async (t) => {
  const { backend, state, installRoot } = await fixture(t);
  await assert.rejects(backend.invoke("update_stack", { installRoot, releaseTag: "v1.1.0" }), /Check for updates/);
  await backend.invoke("check_updates", { installRoot });
  state.manifest = releaseManifest("e".repeat(40));
  await assert.rejects(backend.invoke("update_stack", { installRoot, releaseTag: "v1.1.0" }), /changed since/);
  assert.ok(!state.calls.some(({ args }) => args[0] === "pull" || args[0] === "stop"));
  const unknown = await fixture(t, { knownVersion: false });
  const status = await unknown.backend.invoke("get_launcher_status");
  assert.equal(status.installations[0].version, oldCommit); assert.equal(status.installations[0].canRepair, true); assert.equal(status.installations[0].canUpdate, false);
  assert.match((await unknown.backend.invoke("check_updates")).frame.reason, /identity is unknown/);
});

test("repair restores a missing service using only installed digests and preserves settings and stopped intent", async (t) => {
  const { backend, state, installRoot, dataRoot, env } = await fixture(t, { missing: true, stopped: true });
  const result = await backend.invoke("repair_stack", { installRoot });
  assert.equal(result.maintenance.success, true, JSON.stringify(result));
  assert.equal(result.installations[0].state, "stopped"); assert.equal(state.containers.length, 2);
  assert.ok(state.calls.filter(({ args }) => args[0] === "pull").every(({ args }) => args[1].endsWith(oldImage)));
  assert.equal(state.fetches.length, 0); assert.ok(!state.calls.some(({ args }) => args.includes("start")));
  assert.equal(await readFile(path.join(installRoot, ".env"), "utf8"), env);
  assert.equal(await readFile(path.join(dataRoot, "audio-monitor/user-media.txt"), "utf8"), "precious user content\n");
});

test("repair starts a missing service when FRAME was running but preserves an explicitly stopped service", async (t) => {
  const missing = await fixture(t, { missing: true });
  assert.equal((await missing.backend.invoke("repair_stack", { installRoot: missing.installRoot })).maintenance.success, true);
  assert.ok(missing.state.containers.every((container) => container.State.Running));
  const partial = await fixture(t);
  assert.equal((await partial.backend.invoke("repair_stack", { installRoot: partial.installRoot })).maintenance.success, true);
  assert.deepEqual(partial.state.containers.map((c) => c.State.Running), [true, false]);
});

test("update installs checked source and images, records version, preserves per-service intent and clears the repeated offer", async (t) => {
  const { backend, state, installRoot, dataRoot } = await fixture(t);
  await backend.invoke("check_updates", { installRoot });
  const result = await backend.invoke("update_stack", { installRoot, releaseTag: "v1.1.0" });
  assert.equal(result.maintenance.success, true, JSON.stringify(result));
  assert.equal(result.installations[0].version, "v1.1.0"); assert.equal(result.updates.frame.available, false);
  assert.deepEqual(state.containers.map((c) => c.State.Running), [true, false]);
  assert.equal(state.containers[1].Config.Image, releaseManifest(newCommit).images["frame-audio"]);
  assert.equal(await readFile(path.join(installRoot, "managed.txt"), "utf8"), "new release bytes\n");
  assert.equal(await readFile(path.join(installRoot, "user-note.txt"), "utf8"), "not managed by updater\n");
  assert.equal(await readFile(path.join(dataRoot, "state/cloudflare-tunnel-token"), "utf8"), "private-token");
  assert.equal(state.progress.at(-1).phase, "complete");
  assert.equal(JSON.parse(await readFile(path.join(installRoot, ".frame-source-backup/snapshot.json"))).pending, false);
});

test("failed update restores source before old images, removes only new managed files and retains user data", async (t) => {
  const { backend, state, installRoot, dataRoot, env } = await fixture(t);
  await backend.invoke("check_updates", { installRoot }); state.failStart = true;
  const result = await backend.invoke("update_stack", { installRoot, releaseTag: "v1.1.0" });
  assert.equal(result.maintenance.success, false); assert.equal(result.maintenance.recovered, true, JSON.stringify(result));
  assert.equal(result.installations[0].version, "v1.0.0");
  assert.equal(await readFile(path.join(installRoot, "managed.txt"), "utf8"), "old release bytes\n");
  assert.equal(await readFile(path.join(installRoot, ".env"), "utf8"), env);
  await assert.rejects(readFile(path.join(installRoot, "new-managed.txt")), { code: "ENOENT" });
  assert.deepEqual(state.containers.map((c) => c.State.Running), [true, false]);
  assert.ok(state.containers.every((c) => c.Image === oldImage));
  assert.equal(await readFile(path.join(dataRoot, "audio-monitor/user-media.txt"), "utf8"), "precious user content\n");
  assert.equal(state.progress.at(-1).phase, "failed"); assert.ok(!JSON.stringify(result).includes("private-password"));
});

test("interrupted recovery stays actionable and explicit Recover restores previous stopped choices", async (t) => {
  const { backend, state, installRoot } = await fixture(t);
  await backend.invoke("check_updates", { installRoot }); state.failStart = true; state.failRecovery = true;
  const failed = await backend.invoke("update_stack", { installRoot, releaseTag: "v1.1.0" });
  assert.equal(failed.maintenance.recovered, false); assert.equal(failed.installations[0].canRecover, true, JSON.stringify(failed));
  assert.equal(failed.installations[0].canStart, false); assert.equal(failed.installations[0].canRepair, false);
  state.failRecovery = false;
  const result = await backend.invoke("recover_stack", { installRoot });
  assert.equal(result.installations[0].canRecover, false, JSON.stringify(result));
  assert.deepEqual(state.containers.map((c) => c.State.Running), [true, false]);
});

test("maintenance refuses unavailable storage and foreign ownership before pulls or container mutations", async (t) => {
  const { backend, state, installRoot, temporary } = await fixture(t);
  state.full = true;
  await assert.rejects(backend.invoke("repair_stack", { installRoot }), /Storage full/);
  state.full = false; state.containers[1].Config.Labels["com.docker.compose.project.working_dir"] = path.join(temporary, "someone else");
  await assert.rejects(backend.invoke("repair_stack", { installRoot }), /Another FRAME installation/);
  assert.ok(!state.calls.some(({ args }) => ["pull", "stop", "rm"].includes(args[0]) || args.includes("up")));
});

test("corrupted source backup blocks recovery before stopping any currently running containers", async (t) => {
  const { backend, state, installRoot } = await fixture(t);
  await backend.invoke("check_updates", { installRoot }); state.failStart = true; state.failRecovery = true;
  await backend.invoke("update_stack", { installRoot, releaseTag: "v1.1.0" });
  const snapshot = JSON.parse(await readFile(path.join(installRoot, ".frame-source-backup/snapshot.json")));
  const index = snapshot.files.findIndex((file) => file.previous?.size);
  const file = path.join(installRoot, ".frame-source-backup", `bytes-${snapshot.id}-${index}`);
  const bytes = await readFile(file); bytes[0] ^= 1; await writeFile(file, bytes);
  state.containers[0].State = { Running: true, Status: "running" };
  const stops = state.calls.filter(({ args }) => args[0] === "stop").length;
  await backend.invoke("recover_stack", { installRoot });
  assert.equal(state.calls.filter(({ args }) => args[0] === "stop").length, stops);
  assert.equal(state.containers[0].State.Running, true);
});

test("source-pending recovery remains available after deployment completion was recorded", async (t) => {
  const { backend, state, installRoot } = await fixture(t);
  await backend.invoke("check_updates", { installRoot }); state.failStart = true; state.failRecovery = true;
  await backend.invoke("update_stack", { installRoot, releaseTag: "v1.1.0" });
  const file = path.join(installRoot, ".frame-deployment-backup/snapshot.json"), snapshot = JSON.parse(await readFile(file));
  snapshot.pending = false; await writeFile(file, JSON.stringify(snapshot));
  assert.equal((await backend.invoke("get_launcher_status")).installations[0].canRecover, true);
  state.failRecovery = false;
  assert.equal((await backend.invoke("recover_stack", { installRoot })).installations[0].canRecover, false);
  assert.deepEqual(state.containers.map((c) => c.State.Running), [true, false]);
});

test("a retry interrupted before source publication never reuses a completed prior source backup", async (t) => {
  const { backend, state, installRoot } = await fixture(t);
  await backend.invoke("check_updates", { installRoot }); state.failStart = true;
  assert.equal((await backend.invoke("update_stack", { installRoot, releaseTag: "v1.1.0" })).maintenance.recovered, true);
  const file = path.join(installRoot, ".frame-deployment-backup/snapshot.json"), snapshot = JSON.parse(await readFile(file));
  snapshot.pending = true; snapshot.maintenance.sourceId = null; await writeFile(file, JSON.stringify(snapshot));
  await writeFile(path.join(installRoot, "managed.txt"), "legitimate edit after earlier rollback\n");
  const recovered = await backend.invoke("recover_stack", { installRoot });
  assert.equal(recovered.installations[0].canRecover, false, JSON.stringify(recovered));
  assert.equal(await readFile(path.join(installRoot, "managed.txt"), "utf8"), "legitimate edit after earlier rollback\n");
});

test("notification failure after maintenance commit cannot roll back an installed release", async (t) => {
  const { backend, state, installRoot } = await fixture(t);
  await backend.invoke("check_updates", { installRoot }); state.failNotification = true;
  const result = await backend.invoke("update_stack", { installRoot, releaseTag: "v1.1.0" });
  assert.equal(result.maintenance.success, true); assert.equal(result.installations[0].version, "v1.1.0");
  assert.ok(!state.calls.some(({ args }) => args.some((arg) => arg.endsWith("maintenance-compose.json"))));
  assert.equal((await readFile(path.join(installRoot, "frame-source-commit"), "utf8")).trim(), newCommit);
});

test("missing recovery images and conflicting current source are checked before stopping services", async (t) => {
  const { backend, state, installRoot } = await fixture(t);
  await backend.invoke("check_updates", { installRoot }); state.failStart = true; state.failRecovery = true;
  await backend.invoke("update_stack", { installRoot, releaseTag: "v1.1.0" });
  state.containers[0].State = { Running: true, Status: "running" };
  const stops = state.calls.filter(({ args }) => args[0] === "stop").length;
  state.missingRecoveryImage = true;
  await backend.invoke("recover_stack", { installRoot });
  assert.equal(state.calls.filter(({ args }) => args[0] === "stop").length, stops);
  state.missingRecoveryImage = false;
  await writeFile(path.join(installRoot, "managed.txt"), "user change after interruption\n");
  await backend.invoke("recover_stack", { installRoot });
  assert.equal(state.calls.filter(({ args }) => args[0] === "stop").length, stops);
  assert.equal(state.containers[0].State.Running, true);
});

test("backup requires confirmation, pauses consistently and resumes only original running container IDs", async (t) => {
  const { backend, state, installRoot, temporary } = await fixture(t, { platform: process.platform });
  const backupRoot = path.join(temporary, "full backup");
  await assert.rejects(backend.invoke("backup_stack", { installRoot, backupRoot }), /Confirm/);
  assert.equal(state.calls.length, 0);
  const runningIds = state.containers.filter((container) => container.State.Running).map((container) => container.Id);
  const result = await backend.invoke("backup_stack", { installRoot, backupRoot, confirmed: true });
  assert.equal(result.protection.success, true, JSON.stringify(result)); assert.equal(result.protection.resumed, true);
  assert.deepEqual(state.calls.find(({ args }) => args[0] === "start").args, ["start", ...runningIds]);
  assert.deepEqual(state.containers.map((container) => container.State.Running), [true, false]);
  assert.equal(result.protection.backupComplete, true);
  const backup = await backend.invoke("inspect_backup", { backupRoot });
  assert.equal(backup.workspace, installRoot); assert.equal(backup.verified, true); assert.ok(backup.fileCount > 0);
  assert.equal(await readFile(path.join(backupRoot, "data/audio-monitor/user-media.txt"), "utf8"), "precious user content\n");
  assert.ok(!state.calls.some(({ args }) => args[0] === "pull" || args.includes("up")));
});

test("backup storage failures happen before stopping and resume failures preserve a verified backup", async (t) => {
  const { backend, state, installRoot, temporary } = await fixture(t, { platform: process.platform });
  state.full = true;
  await assert.rejects(backend.invoke("backup_stack", { installRoot, backupRoot: path.join(temporary, "full"), confirmed: true }), /Storage full/);
  assert.ok(!state.calls.some(({ args }) => args[0] === "stop"));
  state.full = false; state.failResume = true;
  const backupRoot = path.join(temporary, "verified despite resume failure");
  const result = await backend.invoke("backup_stack", { installRoot, backupRoot, confirmed: true });
  assert.equal(result.protection.success, false); assert.equal(result.protection.backupComplete, true); assert.equal(result.protection.resumed, false);
  assert.equal((await backend.invoke("inspect_backup", { backupRoot })).verified, true);
  assert.ok(!JSON.stringify(result.protection).includes("private-password"));
});

test("container removal stops then removes only owned IDs while preserving all deployment and data files", async (t) => {
  const { backend, state, installRoot, dataRoot, env } = await fixture(t);
  await assert.rejects(backend.invoke("remove_stack", { installRoot }), /Confirm/);
  const ids = state.containers.map((container) => container.Id);
  const result = await backend.invoke("remove_stack", { installRoot, confirmed: true });
  assert.equal(result.protection.success, true); assert.equal(state.containers.length, 0);
  assert.deepEqual(state.calls.find(({ args }) => args[0] === "rm").args, ["rm", ...ids]);
  assert.ok(state.calls.findIndex(({ args }) => args[0] === "stop") < state.calls.findIndex(({ args }) => args[0] === "rm"));
  assert.ok(!state.calls.some(({ args }) => ["image", "volume", "network", "start", "pull", "down"].includes(args[0])));
  assert.equal(await readFile(path.join(installRoot, ".env"), "utf8"), env);
  assert.equal(await readFile(path.join(dataRoot, "audio-monitor/user-media.txt"), "utf8"), "precious user content\n");
  assert.equal(result.installations[0].canRepair, true);
});

test("failed stop prevents removal, partial removal never restarts and foreign ownership blocks protection", async (t) => {
  const { backend, state, installRoot, temporary } = await fixture(t);
  state.failStop = true;
  assert.equal((await backend.invoke("remove_stack", { installRoot, confirmed: true })).protection.success, false);
  assert.ok(!state.calls.some(({ args }) => args[0] === "rm"));
  state.failStop = false; state.failRemove = true;
  assert.equal((await backend.invoke("remove_stack", { installRoot, confirmed: true })).protection.success, false);
  assert.equal(state.containers.length, 1); assert.ok(!state.calls.some(({ args }) => args[0] === "start"));
  state.containers[0].Config.Labels["com.docker.compose.project.working_dir"] = path.join(temporary, "foreign");
  await assert.rejects(backend.invoke("backup_stack", { installRoot, backupRoot: path.join(temporary, "blocked"), confirmed: true }), /Another FRAME installation/);
  await assert.rejects(backend.invoke("remove_stack", { installRoot, confirmed: true }), /Another FRAME installation/);
});

test("full restore requires no existing FRAME containers and empty original folders, then registers files without starting", async (t) => {
  const { backend, state, installRoot, dataRoot, temporary, env } = await fixture(t, { platform: process.platform, stopped: true });
  const backupRoot = path.join(temporary, "restore backup");
  assert.equal((await backend.invoke("backup_stack", { installRoot, backupRoot, confirmed: true })).protection.success, true);
  await assert.rejects(backend.invoke("restore_backup", { backupRoot }), /Confirm/);
  await assert.rejects(backend.invoke("restore_backup", { backupRoot, confirmed: true }), /Remove all existing FRAME containers/);
  await backend.invoke("remove_stack", { installRoot, confirmed: true });
  await assert.rejects(backend.invoke("restore_backup", { backupRoot, confirmed: true }), /empty original/);
  await rename(installRoot, `${installRoot}-original`); await rename(dataRoot, `${dataRoot}-original`);
  const beforeCalls = state.calls.length;
  const restored = await backend.invoke("restore_backup", { backupRoot, confirmed: true });
  assert.equal(restored.protection.success, true, JSON.stringify(restored)); assert.equal(restored.protection.resumed, false);
  assert.equal(await readFile(path.join(installRoot, ".env"), "utf8"), env);
  assert.equal(await readFile(path.join(dataRoot, "audio-monitor/user-media.txt"), "utf8"), "precious user content\n");
  assert.equal(restored.installations[0].canRepair, true); assert.equal(state.containers.length, 0);
  assert.ok(state.calls.slice(beforeCalls).every(({ args }) => !["start", "stop", "rm", "pull"].includes(args[0]) && !args.includes("up")));
});

test("interrupted full restore markers block all lifecycle, backup and removal controls", async (t) => {
  const { backend, installRoot } = await fixture(t);
  await writeFile(path.join(installRoot, ".frame-full-restore.json"), JSON.stringify({ complete: false }));
  const entry = (await backend.invoke("get_launcher_status")).installations[0];
  for (const key of ["canStart", "canStop", "canRepair", "canUpdate", "canRecover", "canReconfigure", "canBackup", "canRemove"]) assert.equal(entry[key], false, key);
  assert.match(entry.detail, /restore was interrupted/);
});

test("backup consistency failure retains an incomplete copy and storage is checked again before resume", async (t) => {
  const changing = await fixture(t, { platform: process.platform });
  const backupRoot = path.join(changing.temporary, "incomplete concurrent backup");
  let changed = false;
  changing.state.beforeInspect = async () => {
    if (!changed && await readFile(path.join(backupRoot, "frame-full-backup.json")).catch(() => null)) {
      changing.state.containers[0].State = { Running: true, Status: "running" }; changed = true;
    }
  };
  const result = await changing.backend.invoke("backup_stack", { installRoot: changing.installRoot, backupRoot, confirmed: true });
  assert.equal(result.protection.backupComplete, false); assert.equal(result.protection.success, false);
  await assert.rejects(changing.backend.invoke("inspect_backup", { backupRoot }), /incomplete/);
  const full = await fixture(t, { platform: process.platform });
  full.state.fullAfterStop = true;
  const fullResult = await full.backend.invoke("backup_stack", { installRoot: full.installRoot, backupRoot: path.join(full.temporary, "valid backup"), confirmed: true });
  assert.equal(fullResult.protection.backupComplete, true); assert.equal(fullResult.protection.resumed, false);
  assert.ok(!full.state.calls.some(({ args }) => args[0] === "start"));
});

test("stopped broken configurations can still be backed up and notification failure cannot change verified resume", async (t) => {
  const broken = await fixture(t, { stopped: true, platform: process.platform });
  broken.state.failConfig = true;
  assert.equal((await broken.backend.invoke("get_launcher_status")).installations[0].canBackup, true);
  assert.equal((await broken.backend.invoke("backup_stack", { installRoot: broken.installRoot, backupRoot: path.join(broken.temporary, "broken config backup"), confirmed: true })).protection.success, true);
  const notify = await fixture(t, { platform: process.platform }); notify.state.failNotification = true;
  const result = await notify.backend.invoke("backup_stack", { installRoot: notify.installRoot, backupRoot: path.join(notify.temporary, "notification backup"), confirmed: true });
  assert.equal(result.protection.success, true); assert.equal(result.protection.resumed, true);
});

test("restore refuses a different operating system or Docker image architecture before touching folders or containers", async (t) => {
  const { backend, state, installRoot, temporary } = await fixture(t, { stopped: true, platform: process.platform });
  const backupRoot = path.join(temporary, "platform backup");
  await backend.invoke("backup_stack", { installRoot, backupRoot, confirmed: true });
  state.engineArch = "arm64";
  await assert.rejects(backend.invoke("restore_backup", { backupRoot, confirmed: true }), /requires linux\/arm64/);
  const file = path.join(backupRoot, "frame-full-backup.json"), manifest = JSON.parse(await readFile(file));
  manifest.platform = process.platform === "win32" ? "linux" : "win32";
  manifest.workspace = manifest.platform === "win32" ? "C:\\FRAME\\deployment" : "/home/frame/deployment";
  manifest.dataRoot = manifest.platform === "win32" ? "C:\\FRAME\\data" : "/home/frame/data";
  if (manifest.platform !== "win32") for (const entry of [manifest.roots.workspace, manifest.roots.data, ...manifest.entries]) { entry.uid = 1000; entry.gid = 1000; }
  await writeFile(file, JSON.stringify(manifest));
  const beforeCalls = state.calls.length;
  await assert.rejects(backend.invoke("restore_backup", { backupRoot, confirmed: true }), /same operating system/);
  assert.equal(state.calls.length, beforeCalls); assert.equal(state.containers.length, 2);
});

test("locating an existing custom installation reconnects its original data even when Docker is unavailable", async (t) => {
  const { backend, state, installRoot, dataRoot, temporary, env } = await fixture(t);
  const relocated = path.join(temporary, "original custom installation");
  await rename(installRoot, relocated); state.containers = []; state.available = false;
  assert.equal((await backend.invoke("get_launcher_status")).installations.length, 0);
  const result = await backend.invoke("locate_installation", { installRoot: relocated });
  assert.equal(result.protection.success, true); assert.equal(result.installations[0].installRoot, relocated);
  assert.equal(result.installations[0].dataRoot, dataRoot); assert.equal(result.dockerAvailable, false);
  assert.equal(await readFile(path.join(relocated, ".env"), "utf8"), env);
  assert.ok(state.calls.every(({ args }) => !["start", "stop", "rm", "pull"].includes(args[0]) && !args.includes("up")));
});
