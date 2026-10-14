import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBackend, dockerBindSource } from "../apps/frame-setup/electron/backend.mjs";
import { activateRelease, completeDeployment, FRAME_IMAGE_SERVICES, recordSourceCommit, RELEASE_IMAGE_PREFIX, snapshotDeployment } from "../installer/frame-release.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const commit = "a".repeat(40), digest = `sha256:${"b".repeat(64)}`;
const manifest = (platform = "linux/amd64") => ({ schema_version: 1, commit, platform, images: Object.fromEntries(
  FRAME_IMAGE_SERVICES.map((name) => [name, `${RELEASE_IMAGE_PREFIX}/${name}@${digest}`]),
) });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("Expected asynchronous progress did not arrive");
}

async function fixture(t, { installed = true, legacy = false, platform, arch, engineArch = "amd64", releasePlatform = "linux/amd64",
  storageProbe = async (_location, label) => ({ label, status: "good", detail: "Storage ready." }) } = {}) {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "FRAME launcher test ")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT"]) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const managedRoot = path.join(temporary, "managed"), userData = path.join(managedRoot, "launcher"), dataRoot = path.join(temporary, "FRAME data");
  const installRoot = legacy ? path.join(temporary, "original installation") : path.join(managedRoot, "deployment");
  const legacyUserData = path.join(temporary, "old launcher"), calls = [], logs = [], progress = [];
  const clock = { active: false, tick: () => {} };
  const compose = { name: "syronius-frame", services: {
    "frame-edge": { image: "caddy:2", ports: [] },
    "frame-audio": { image: manifest().images["frame-audio"], volumes: [{ type: "bind", source: path.join(dataRoot, "audio-monitor"), target: "/data" }] },
  } };
  if (installed) {
    await mkdir(path.join(installRoot, "installer"), { recursive: true });
    await mkdir(path.join(dataRoot, "audio-monitor"), { recursive: true });
    await mkdir(path.join(dataRoot, "state"), { recursive: true });
    await writeFile(path.join(installRoot, ".env"), `FRAME_DATA_ROOT=${dataRoot.replaceAll("\\", "/")}\nEDGE_HTTP_PORT=18080\nPORTAL_PASSWORD=private-password\nCOMPOSE_PROFILES=audio-monitor\n`);
    await writeFile(path.join(installRoot, "docker-compose.yml"), "name: syronius-frame\n");
    for (const file of ["frame-installer.mjs", "frame-release.mjs", "stack.ps1", "stack.sh"]) await copyFile(path.join(repository, "installer", file), path.join(installRoot, "installer", file));
    await recordSourceCommit(installRoot, commit);
    await activateRelease(installRoot, manifest(releasePlatform));
    if (legacy) {
      await mkdir(legacyUserData, { recursive: true });
      await writeFile(path.join(legacyUserData, "installations.json"), JSON.stringify([{ installRoot }]));
    }
  }
  const state = { available: true, engineArch, engineOS: "linux", endpoint: "unix:///var/run/docker.sock", failStart: false, failStop: false, failConfig: false, calls, compose, containers: installed ? Object.entries(compose.services).map(([name, service], index) => ({
    Id: String(index + 1).repeat(64), Name: `/${name}`, Image: digest,
    Config: { Image: service.image, Labels: { "com.docker.compose.project": "syronius-frame", "com.docker.compose.project.working_dir": installRoot, "com.docker.compose.service": name } },
    State: { Running: false, Status: "exited", Health: { Status: "healthy" } }, NetworkSettings: { Ports: {} },
    Mounts: (service.volumes || []).map((volume) => ({ Type: "bind", Source: volume.source, Destination: volume.target })),
  })) : [] };
  const run = async (command, args, options = {}) => {
    calls.push({ command, args, env: options.env, timeout: options.timeout });
    if (command !== "docker") {
      assert.equal(args.at(-1), "recover", "only explicit recovery may invoke a wrapper");
      assert.equal(options.env.DOCKER_HOST, process.env.DOCKER_HOST, "installed .env cannot redirect recovery to another engine");
      await completeDeployment(options.cwd);
      return { stdout: "", stderr: "" };
    }
    if (!state.available) throw new Error("Docker unavailable private-password");
    if (state.failure?.stage === (args[0] === "compose" && args[1] === "version" ? "compose-version" : args[0])) throw state.failure.error;
    if (args[0] === "context") return { stdout: JSON.stringify([{ Endpoints: { docker: { Host: state.endpoint } } }]) };
    if (args[0] === "info") return { stdout: JSON.stringify({ OSType: state.engineOS, Architecture: state.engineArch, OperatingSystem: state.operatingSystem, SecurityOptions: state.securityOptions }) };
    if (args[1] === "version") return { stdout: "" };
    if (args[0] === "ps") {
      if (args.includes("--format")) {
        await state.beforeProgressList?.();
        return { stdout: state.containers.filter((container) => container.Config.Labels["com.docker.compose.project"] === "syronius-frame")
          .map((container) => JSON.stringify([container.Id, container.Config.Labels["com.docker.compose.project.working_dir"], container.Config.Labels["com.docker.compose.service"]])).join("\n") };
      }
      assert.deepEqual(args, ["ps", "-a", "-q"]); return { stdout: state.containers.map((container) => container.Id).join("\n") };
    }
    if (args[0] === "inspect") {
      if (options.timeout === 5_000) await state.beforeProgressInspect?.(); else state.beforeInspect?.();
      return { stdout: JSON.stringify(state.containers.filter((container) => args.includes(container.Id))) };
    }
    if (args[0] === "image") return { stdout: digest };
    if (args.includes("config")) {
      assert.equal(options.env.DOCKER_HOST, process.env.DOCKER_HOST, "installed .env cannot redirect Docker to another engine");
      if (state.failConfig) throw new Error("invalid current Compose private-password");
      return { stdout: JSON.stringify(compose) };
    }
    if (args.includes("start")) {
      assert.ok(args.includes("--wait"));
      await state.start?.();
      for (const [index, container] of state.containers.entries()) if (!state.failStart || index === 0) container.State = { Running: true, Status: "running", Health: { Status: "healthy" } };
      if (state.failStart) throw new Error("Start failed private-password");
      return { stdout: "" };
    }
    if (args[0] === "stop") {
      for (const [index, container] of state.containers.entries()) if (args.includes(container.Id) && (!state.failStop || index === 0)) container.State = { Running: false, Status: "exited", Health: { Status: "healthy" } };
      if (state.failStop) throw new Error("Stop failed private-password");
      return { stdout: "" };
    }
    throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
  };
  const backend = createBackend({ userData, managedRoot, defaultDataRoot: dataRoot, legacyUserData, resourcesRoot: repository, run,
    platform, arch, homeDirectory: "/Users/frame",
    storageProbe, dockerStorageProbe: async () => ({ label: "Docker storage", status: "good", detail: "Docker storage ready." }),
    setIntervalImpl: (tick, delay) => { assert.equal(delay, 1_000); clock.tick = tick; clock.active = true; return clock; },
    clearIntervalImpl: () => { clock.active = false; },
    fetchImpl: () => { throw new Error("Routine launcher actions must be offline"); },
    emit: (event, message) => { if (event === "install-log") logs.push(message); if (event === "launcher-progress") progress.push(message); } });
  t.after(() => backend.dispose());
  return { backend, state, temporary, installRoot, dataRoot, userData, managedRoot, logs, progress, clock };
}

test("launcher discovers stopped managed containers and starts/stops the existing deployment offline", async (t) => {
  const { backend, state, installRoot, dataRoot } = await fixture(t);
  const status = await backend.invoke("get_launcher_status");
  assert.equal(status.installations.length, 1);
  assert.equal(status.installations[0].state, "stopped");
  assert.equal(status.installations[0].dataRoot, dataRoot);
  assert.equal(status.installations[0].dashboardUrl, "http://localhost:18080/dashboard");
  assert.equal(status.installations[0].canStart, true);
  assert.equal(status.installations[0].canStop, false);
  state.containers[1].Config.Image = digest; // Recovery starts saved immutable local IDs.
  assert.equal((await backend.invoke("get_launcher_status")).installations[0].canStart, true);
  state.containers[1].State.Health.Status = "unhealthy"; // Docker retains the previous health status when stopped.
  assert.equal((await backend.invoke("get_launcher_status")).installations[0].state, "stopped");
  const envPath = path.join(installRoot, ".env");
  await writeFile(envPath, `${await readFile(envPath, "utf8")}DOCKER_HOST=tcp://other-engine:2375\n`);
  assert.equal((await backend.invoke("start_stack", { installRoot })).installations[0].state, "running");
  assert.equal((await backend.invoke("stop_stack", { installRoot })).installations[0].state, "stopped");
  assert.deepEqual(state.calls.find(({ args }) => args.includes("start")).args.slice(-6), ["start", "--wait", "--wait-timeout", "120", "frame-edge", "frame-audio"]);
  assert.deepEqual(state.calls.find(({ args }) => args[0] === "stop").args, ["stop", "--time", "30", ...state.containers.map((container) => container.Id)]);
  assert.ok(state.calls.every(({ args }) => !args.some((argument) => ["pull", "up", "build", "down", "rm", "create"].includes(argument))));
  assert.equal(state.containers.length, 2);
});

test("launcher preserves legacy registry locations and reports Docker unavailable without leaking child output", async (t) => {
  const { backend, state, installRoot, dataRoot } = await fixture(t, { legacy: true });
  state.containers = [];
  const found = await backend.invoke("get_launcher_status");
  assert.equal(found.installations[0].installRoot, installRoot);
  assert.equal(found.installations[0].dataRoot, dataRoot);
  assert.equal(found.installations[0].canStart, false);
  assert.ok(found.installations[0].services.every((service) => service.status === "missing"));
  state.available = false;
  const unavailable = await backend.invoke("get_launcher_status");
  assert.equal(unavailable.dockerAvailable, false);
  assert.equal(unavailable.installations[0].state, "docker_unavailable");
  assert.equal(unavailable.installations[0].canStart, false);
  assert.ok(!JSON.stringify(unavailable).includes("private-password"));
});

test("stopped foreign or unowned FRAME containers block preflight and all lifecycle takeover", async (t) => {
  const { backend, state, installRoot, temporary } = await fixture(t);
  state.containers[1].Config.Labels["com.docker.compose.project.working_dir"] = path.join(temporary, "other installation");
  const result = await backend.invoke("get_launcher_status");
  assert.ok(result.installations.every((entry) => !entry.canStart && !entry.canStop && !entry.canRecover));
  await assert.rejects(backend.invoke("start_stack", { installRoot }), /Another FRAME installation/);
  const checked = await backend.invoke("run_preflight", { request: { installRoot: path.join(temporary, "new location"), deploymentMode: "LAN", selectedServices: ["frame-audio-relay"] } });
  assert.ok(checked.checks.some((check) => check.status === "bad" && /Another FRAME installation/.test(check.detail)));
  delete state.containers[1].Config.Labels["com.docker.compose.project.working_dir"];
  assert.ok((await backend.invoke("get_launcher_status")).installations.every((entry) => !entry.canStart && !entry.canStop));
  assert.ok(state.calls.every(({ command, args }) => command === "docker" && !args.includes("start") && !args.includes("stop")));
});

test("routine start refuses missing data, mismatched images, duplicate containers and missing required binds", async (t) => {
  const { backend, state, installRoot, dataRoot } = await fixture(t);
  state.containers[1].Config.Image = "another-image";
  assert.match((await backend.invoke("get_launcher_status")).installations[0].detail, /image differs/);
  state.containers[1].Config.Image = state.compose.services["frame-audio"].image;
  state.containers.push(structuredClone(state.containers[1]));
  assert.match((await backend.invoke("get_launcher_status")).installations[0].detail, /duplicated/);
  state.containers.pop();
  await rm(path.join(dataRoot, "audio-monitor"), { recursive: true });
  assert.match((await backend.invoke("get_launcher_status")).installations[0].detail, /Required storage/);
  await rm(dataRoot, { recursive: true });
  await assert.rejects(backend.invoke("start_stack", { installRoot }), /data folder is missing/);
  assert.ok(state.calls.every(({ args }) => !args.includes("start")));
});

test("routine start blocks unusable storage before starting Docker containers while Stop remains available", async (t) => {
  const { backend, state, installRoot } = await fixture(t, {
    storageProbe: async (_location, label) => ({ label, status: "bad", detail: "The storage device is full." }),
  });
  await assert.rejects(backend.invoke("start_stack", { installRoot }), /storage device is full/);
  assert.ok(state.calls.every(({ args }) => !args.includes("start")));
  for (const container of state.containers) container.State = { Running: true, Status: "running", Health: { Status: "healthy" } };
  const stopped = await backend.invoke("stop_stack", { installRoot });
  assert.equal(stopped.installations[0].state, "stopped");
  assert.ok(state.calls.some(({ args }) => args[0] === "stop"));
});

test("partial startup, unhealthy services and partial stopping are reported from actual post-command observations", async (t) => {
  const { backend, state, installRoot, logs } = await fixture(t);
  state.failStart = true;
  const partial = await backend.invoke("start_stack", { installRoot });
  assert.equal(partial.installations[0].state, "needs_attention");
  assert.deepEqual(partial.installations[0].services.map((service) => service.status), ["running", "exited"]);
  assert.ok(!JSON.stringify(partial).includes("private-password"));
  state.failStart = false;
  await backend.invoke("start_stack", { installRoot });
  state.containers[1].State.Health.Status = "unhealthy";
  const unhealthy = await backend.invoke("get_launcher_status");
  assert.equal(unhealthy.installations[0].state, "needs_attention");
  assert.equal(unhealthy.installations[0].canStop, true);
  state.failStop = true;
  const stopped = await backend.invoke("stop_stack", { installRoot });
  assert.equal(stopped.installations[0].state, "needs_attention");
  assert.deepEqual(stopped.installations[0].services.map((service) => service.status), ["exited", "running"]);
  assert.ok(logs.every((line) => !line.includes("private-password")));
});

test("startup streams live readiness while Docker is pending and clears stale readiness on an observer failure", async (t) => {
  const { backend, state, installRoot, progress, clock } = await fixture(t), start = deferred();
  t.after(() => start.resolve());
  state.start = () => start.promise;
  const operation = backend.invoke("start_stack", { installRoot });
  await waitFor(() => progress.some((event) => event.services.every((service) => service.status === "exited")));
  assert.equal(backend.isBusy(), true);
  assert.deepEqual(progress[0].services.map((service) => service.status), ["waiting", "waiting"]);
  await assert.rejects(backend.invoke("get_launcher_status"), /already running/);
  state.containers[0].State = { Running: true, Status: "running" }; // No healthcheck is valid readiness.
  state.containers[1].State = { Running: true, Status: "running", Health: { Status: "starting" } };
  clock.tick();
  await waitFor(() => progress.at(-1).services[1].health === "starting");
  assert.equal(progress.at(-1).services[0].health, "none");
  state.available = false;
  clock.tick();
  await waitFor(() => progress.at(-1).services.every((service) => service.status === "unknown"));
  assert.ok(!JSON.stringify(progress).includes("private-password"));
  state.available = true;
  start.resolve();
  assert.equal((await operation).installations[0].state, "running");
  assert.equal(progress.at(-1).phase, "complete");
  assert.equal(clock.active, false);
  const count = progress.length;
  clock.tick();
  await new Promise(setImmediate);
  assert.equal(progress.length, count);
});

test("startup progress inspects only expected owned services and shows duplicates and failed health", async (t) => {
  const { backend, state, installRoot, progress, clock, temporary } = await fixture(t), start = deferred();
  t.after(() => start.resolve());
  state.start = async () => { await start.promise; throw new Error("Start failed private-password"); };
  const operation = backend.invoke("start_stack", { installRoot });
  await waitFor(() => progress.length >= 2);
  const original = state.containers.slice();
  const foreign = structuredClone(original[0]); foreign.Id = "d".repeat(64); foreign.Config.Labels["com.docker.compose.project.working_dir"] = path.join(temporary, "foreign");
  const unrelated = structuredClone(original[0]); unrelated.Id = "e".repeat(64); unrelated.Config.Labels["com.docker.compose.service"] = "not-configured";
  const duplicate = structuredClone(original[0]); duplicate.Id = "f".repeat(64);
  state.containers.push(foreign, unrelated, duplicate);
  clock.tick();
  await waitFor(() => progress.at(-1).services[0].status === "ambiguous");
  const inspections = state.calls.filter(({ args, timeout }) => args[0] === "inspect" && timeout === 5_000);
  assert.ok(inspections.every(({ args }) => !args.includes(foreign.Id) && !args.includes(unrelated.Id)));
  state.containers = original;
  state.containers[0].State = { Running: true, Status: "running", Health: { Status: "healthy" } };
  state.containers[1].State = { Running: true, Status: "running", Health: { Status: "unhealthy" } };
  start.resolve();
  assert.equal((await operation).installations[0].state, "needs_attention");
  assert.equal(progress.at(-1).phase, "failed");
  assert.equal(progress.at(-1).services[1].health, "unhealthy");
  assert.equal(clock.active, false);
  assert.ok(!JSON.stringify(progress).includes("private-password"));
});

test("startup drains a pending observation and prevents overlapping polls or late events after completion", async (t) => {
  const { backend, state, installRoot, progress, clock } = await fixture(t), inspection = deferred(), start = deferred();
  t.after(() => { inspection.resolve(); start.resolve(); });
  let observing = 0;
  state.beforeProgressInspect = async () => { observing++; await inspection.promise; };
  state.start = () => start.promise;
  const operation = backend.invoke("start_stack", { installRoot });
  await waitFor(() => observing === 1);
  clock.tick(); clock.tick();
  start.resolve();
  await waitFor(() => !clock.active);
  assert.equal(observing, 1);
  assert.deepEqual(progress.map((event) => event.phase), ["starting"]);
  inspection.resolve();
  await operation;
  assert.deepEqual(progress.map((event) => event.phase), ["starting", "complete"]);
  clock.tick();
  await new Promise(setImmediate);
  assert.equal(progress.length, 2);
});

test("pending recovery is explicit and rejects a snapshot that would restore integrated Audio Bridge", async (t) => {
  const { backend, state, installRoot, dataRoot } = await fixture(t);
  await snapshotDeployment({ workspace: installRoot, dataRoot, compose: state.compose, images: { "frame-edge": digest } });
  const pending = await backend.invoke("get_launcher_status");
  assert.equal(pending.installations[0].state, "needs_attention");
  assert.equal(pending.installations[0].canRecover, true);
  assert.equal(pending.installations[0].canStart, false);
  state.failConfig = true;
  assert.equal((await backend.invoke("get_launcher_status")).installations[0].canRecover, true, "recovery must remain available when current Compose is broken");
  state.failConfig = false;
  const envFile = path.join(installRoot, ".env");
  await writeFile(envFile, `${await readFile(envFile, "utf8")}DOCKER_HOST=tcp://other-engine:2375\n`);
  assert.equal((await backend.invoke("recover_stack", { installRoot })).installations[0].state, "stopped");
  const file = path.join(installRoot, ".frame-deployment-backup/snapshot.json");
  const snapshot = JSON.parse(await readFile(file, "utf8"));
  const oldManifest = manifest();
  oldManifest.images["frame-audio-bridge"] = `${RELEASE_IMAGE_PREFIX}/frame-audio-bridge@${digest}`;
  snapshot.pending = true;
  snapshot.files["frame-release.json"] = JSON.stringify(oldManifest);
  await writeFile(file, JSON.stringify(snapshot));
  assert.equal((await backend.invoke("get_launcher_status")).installations[0].canRecover, false);
  await assert.rejects(backend.invoke("recover_stack", { installRoot }), /Historical Audio Bridge recovery/);
  assert.equal(state.calls.filter(({ command }) => command !== "docker").length, 1);
});

test("partial setup drafts persist only nonsecret fields and do not need a running Docker engine", async (t) => {
  const { backend, state, userData, managedRoot, dataRoot } = await fixture(t, { installed: false });
  state.available = false;
  const initial = await backend.invoke("detect_host");
  assert.deepEqual(initial.defaults, { installRoot: path.join(managedRoot, "deployment"), dataRoot });
  assert.deepEqual(initial.detectedInstallations, []);
  assert.deepEqual(await backend.invoke("load_draft"), { draft: null });
  const saved = await backend.invoke("save_draft", { draft: { mode: "", selectedServices: [], stage: 0,
    credentials: { portalPassword: "do-not-save" }, readiness: { secret: "do-not-save" }, arbitrary: "do-not-save" } });
  assert.deepEqual(saved.draft, { mode: "", selectedServices: [], stage: 0 });
  assert.deepEqual(await backend.invoke("load_draft"), saved);
  assert.ok(!(await readFile(path.join(userData, "setup-draft.json"), "utf8")).includes("do-not-save"));
  await assert.rejects(backend.invoke("save_draft", { draft: { selectedServices: ["unrecognized"] } }), /service selection/);
  await backend.invoke("clear_draft");
  assert.deepEqual(await backend.invoke("load_draft"), { draft: null });
});

test("stop uses fresh running state when another owned service starts during the request", async (t) => {
  const { backend, state, installRoot } = await fixture(t);
  state.containers[0].State = { Running: true, Status: "running" };
  let inspections = 0;
  state.beforeInspect = () => { if (++inspections === 2) state.containers[1].State = { Running: true, Status: "running" }; };
  const result = await backend.invoke("stop_stack", { installRoot });
  assert.equal(result.installations[0].state, "stopped");
  assert.deepEqual(state.calls.find(({ args }) => args[0] === "stop").args.slice(3), state.containers.map((container) => container.Id));
});

test("configuration-only recovery restores broken Compose only after all owned containers stop", async (t) => {
  const { backend, state, installRoot, dataRoot } = await fixture(t);
  const composeFile = path.join(installRoot, "docker-compose.yml"), original = await readFile(composeFile, "utf8");
  await snapshotDeployment({ workspace: installRoot, dataRoot, compose: state.compose, images: {} });
  await writeFile(composeFile, "invalid current Compose");
  state.failConfig = true;
  state.failStop = true;
  for (const container of state.containers) container.State = { Running: true, Status: "running" };
  const failed = await backend.invoke("recover_stack", { installRoot });
  assert.equal(failed.installations[0].state, "needs_attention");
  assert.equal(await readFile(composeFile, "utf8"), "invalid current Compose", "partial stop must not restore files");
  const backup = path.join(installRoot, ".frame-deployment-backup/snapshot.json");
  assert.equal(JSON.parse(await readFile(backup, "utf8")).pending, true);
  state.failStop = false;
  await backend.invoke("recover_stack", { installRoot });
  assert.equal(await readFile(composeFile, "utf8"), original);
  assert.equal(JSON.parse(await readFile(backup, "utf8")).pending, false);
  assert.ok(state.containers.every((container) => !container.State.Running));
  assert.ok(state.calls.every(({ command }) => command === "docker"), "configuration-only recovery uses shared file recovery, not a Compose wrapper");
});

test("macOS Intel and Apple Silicon launchers use their local engine's native platform and child-only Docker PATH", async (t) => {
  const inheritedPath = process.env.PATH;
  for (const [arch, engineArch, releasePlatform] of [["x64", "x86_64", "linux/amd64"], ["arm64", "aarch64", "linux/arm64"]]) {
    const { backend, state, installRoot, dataRoot } = await fixture(t, { platform: "darwin", arch, engineArch, releasePlatform });
    state.endpoint = "unix:///Users/frame/.docker/run/docker.sock";
    state.operatingSystem = "Docker Desktop";
    const status = await backend.invoke("get_launcher_status");
    assert.equal(status.hostSupported, true);
    assert.equal(status.platform, "darwin");
    assert.equal(status.arch, arch);
    assert.equal(status.enginePlatform, releasePlatform);
    assert.equal(status.installations[0].canStart, true, status.installations[0].detail);
    assert.equal((await backend.invoke("start_stack", { installRoot })).installations[0].state, "running");
    await backend.invoke("stop_stack", { installRoot });
    await snapshotDeployment({ workspace: installRoot, dataRoot, compose: state.compose, images: { "frame-edge": digest } });
    await backend.invoke("recover_stack", { installRoot });
    assert.ok(state.calls.some(({ command, args }) => command === "/bin/sh" && args.at(-1) === "recover"));
    assert.ok(state.calls.every(({ env }) => env.PATH.includes("/Users/frame/.docker/bin") && env.PATH.includes("/Applications/Docker.app/Contents/Resources/bin")
      && env.PATH.includes("/usr/local/bin") && env.PATH.includes("/opt/homebrew/bin")));
    assert.ok(state.calls.filter(({ args }) => args.includes("start") || args.at(-1) === "recover").every(({ env }) => env.DOCKER_DEFAULT_PLATFORM === releasePlatform));
    assert.equal(process.env.PATH, inheritedPath, "GUI Docker discovery must not mutate global PATH");
  }
});

test("launcher reports distinct Docker prerequisites and blocks lifecycle commands for incompatible engines", async (t) => {
  const { backend, state, installRoot } = await fixture(t);
  for (const [stage, error, issue] of [
    ["context", Object.assign(new Error("private-password executable missing"), { code: "ENOENT", spawned: false }), "docker_cli_missing"],
    ["compose-version", new Error("docker: 'compose' is not a docker command. private-password"), "docker_compose_missing"],
    ["info", new Error("cannot connect to daemon: private-password"), "docker_engine_unavailable"],
    ["info", Object.assign(new Error("private-password"), { code: "EPERM" }), "docker_permission_denied"],
  ]) {
    state.failure = { stage, error };
    const result = await backend.invoke("detect_host");
    assert.equal(result.dockerIssue, issue);
    assert.equal(result.detectedInstallations[0].canStart, false);
    assert.ok(!JSON.stringify(result).includes("private-password"));
  }
  state.failure = null;
  for (const [changes, issue] of [
    [{ securityOptions: ["name=rootless"] }, "unsupported_rootless"],
    [{ securityOptions: [], endpoint: "unix:///custom/docker.sock" }, "unsupported_docker_socket"],
  ]) {
    Object.assign(state, changes);
    const status = await backend.invoke("get_launcher_status");
    assert.equal(status.dockerIssue, issue);
    assert.equal(status.installations[0].canStart || status.installations[0].canStop, false);
    await assert.rejects(backend.invoke("start_stack", { installRoot }));
  }
  assert.ok(state.calls.every(({ args }) => !args.includes("start") && !args.includes("stop")));
});

test("launcher separates unsupported host, engine OS, engine architecture, remote context and Docker-down details", async (t) => {
  const unsupported = await fixture(t, { installed: false, platform: "freebsd", arch: "x64" });
  const host = await unsupported.backend.invoke("detect_host");
  assert.equal(host.hostSupported, false);
  assert.equal(host.dockerIssue, "unsupported_host");
  assert.equal(unsupported.state.calls.length, 0);
  assert.match(host.detail, /freebsd/);
  const { backend, state } = await fixture(t, { installed: false, platform: "darwin", arch: "arm64" });
  for (const [changes, issue] of [[{ engineOS: "windows" }, "unsupported_engine_os"],
    [{ engineOS: "linux", engineArch: "armv7l" }, "unsupported_engine_architecture"],
    [{ engineArch: "arm64", endpoint: "ssh://remote.example" }, "remote_engine"],
    [{ endpoint: "unix:///Users/frame/.docker/run/docker.sock", available: false }, "docker_unavailable"]]) {
    Object.assign(state, changes);
    const result = await backend.invoke("detect_host");
    assert.equal(result.hostSupported, true);
    assert.equal(result.dockerIssue, issue);
    assert.ok(result.detail);
    assert.ok(!result.detail.includes("private-password"));
  }
});

test("an existing release on the wrong engine architecture cannot start, stop, reconfigure or recover", async (t) => {
  const { backend, state, installRoot } = await fixture(t, { platform: "darwin", arch: "arm64", engineArch: "arm64" });
  const status = await backend.invoke("get_launcher_status");
  assert.equal(status.dockerAvailable, true);
  assert.equal(status.enginePlatform, "linux/arm64");
  const installation = status.installations[0];
  assert.equal(installation.state, "needs_attention");
  assert.equal(installation.canStart || installation.canStop || installation.canRecover || installation.canReconfigure, false);
  assert.match(installation.detail, /targets linux\/amd64.*requires linux\/arm64/);
  await assert.rejects(backend.invoke("start_stack", { installRoot }), /will not switch architectures/);
  assert.ok(state.calls.every(({ command, args }) => command === "docker" && !args.includes("start") && !args.includes("stop")));
});

test("Docker Desktop bind-source normalization preserves platform boundaries and macOS file sharing prefixes", () => {
  for (const source of ["/Users/frame/FRAME data", "/Volumes/Photos/FRAME", "/private/tmp/frame"]) {
    assert.equal(dockerBindSource(source, "darwin"), source);
    assert.equal(dockerBindSource(`/host_mnt${source}`, "darwin"), source);
    assert.equal(dockerBindSource(`/host_mnt${source}`, "linux"), `/host_mnt${source}`);
  }
  assert.equal(dockerBindSource("/run/desktop/mnt/host/c/FRAME/data", "win32"), "c:/FRAME/data");
  assert.equal(dockerBindSource("/host_mnt/c/FRAME/data", "darwin"), "/c/FRAME/data");
});
