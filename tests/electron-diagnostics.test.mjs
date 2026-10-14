import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildDiagnostics } from "../apps/frame-setup/electron/diagnostics.mjs";
import { createBackend } from "../apps/frame-setup/electron/backend.mjs";

const privateValue = "PRIVATE_TOKEN_AND_USER_HOSTNAME";
const commit = "a".repeat(40);
const healthy = () => ({ installRoot: `/Users/${privateValue}/FRAME`, dataRoot: `/Volumes/${privateValue}/data`, dashboardUrl: `https://${privateValue}.example/dashboard`,
  version: "v1.0.0-release", releaseTag: "v1.0.0-release", commit, state: "needs_attention", canRecover: true,
  detail: `${privateValue} ${"x".repeat(100_000)}`, env: { PASSWORD: privateValue },
  services: [{ name: "frame-audio", status: "running", health: "unhealthy", logs: privateValue },
    { name: "frame-gallery", status: "missing", health: "none" }, { name: privateValue, status: "running", health: "healthy" }] });

test("support reports allowlist fields and values instead of redacting arbitrary inspection or errors", () => {
  const report = buildDiagnostics({ launcherVersion: `1.0.0+${privateValue}`, platform: "darwin", arch: "arm64", osRelease: `24.6.0-${privateValue}`,
    status: { dockerAvailable: true, enginePlatform: "linux/arm64", installations: [healthy()], detail: privateValue,
      updates: { frame: { notes: privateValue } }, readiness: { checks: [{ detail: privateValue }] } },
    engineInfo: { ServerVersion: `28.5.1-${privateValue}`, Name: privateValue, DockerRootDir: `/private/${privateValue}`, Labels: [privateValue], Swarm: { Cluster: privateValue } } });
  assert.equal(report.launcher.version, "1.0.0"); assert.equal(report.launcher.osRelease, "24.6.0");
  assert.equal(report.docker.version, "28.5.1"); assert.equal(report.docker.architecture, "arm64");
  assert.equal(report.installations[0].version, "v1.0.0-release"); assert.equal(report.installations[0].commit, commit);
  assert.deepEqual(report.installations[0].services.map((service) => service.name), ["frame-audio", "frame-gallery"]);
  assert.ok(report.errors.some((error) => error.code === "service_unhealthy"));
  assert.ok(report.errors.some((error) => error.code === "service_missing"));
  assert.ok(report.errors.some((error) => error.code === "recovery_required"));
  assert.ok(!JSON.stringify(report).includes(privateValue));
  assert.deepEqual(Object.keys(report.installations[0]).sort(), ["commit", "installation", "issues", "releaseTag", "services", "state", "version"]);
});

test("unknown text, duplicate services and oversized arrays produce bounded safe diagnostics", () => {
  const entry = { ...healthy(), version: privateValue, releaseTag: `v1.0.0-${privateValue}`, commit: privateValue, state: privateValue,
    services: [{ name: "frame-audio", status: privateValue, health: privateValue }, { name: "frame-audio", status: "running", health: "healthy" },
      ...Array.from({ length: 200 }, () => ({ name: privateValue, status: privateValue, health: privateValue }))] };
  const report = buildDiagnostics({ launcherVersion: privateValue, platform: privateValue, arch: privateValue, osRelease: privateValue,
    status: { installations: Array.from({ length: 100 }, () => entry), dockerAvailable: false, dockerIssue: privateValue, enginePlatform: privateValue },
    engineInfo: { ServerVersion: privateValue } });
  assert.equal(report.installations.length, 16); assert.equal(report.installations[0].services.length, 1);
  assert.equal(report.installations[0].services[0].status, "ambiguous");
  assert.equal(report.installations[0].version, null); assert.equal(report.installations[0].commit, null);
  assert.equal(report.launcher.platform, "unknown"); assert.equal(report.docker.issue, "docker_unavailable");
  assert.ok(report.errors.length <= 20); assert.ok(report.errors.some((error) => error.code === "report_limited"));
  assert.ok(JSON.stringify(report).length < 32 * 1024); assert.ok(!JSON.stringify(report).includes(privateValue));
  assert.equal(buildDiagnostics({ inspectionFailed: true }).errors[0].code, "inspection_failed");
});

test("get_diagnostics performs read-only inspection, bypasses cleanup and excludes real status private fields", async (t) => {
  const temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "FRAME diagnostics ")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT"]) {
    const previous = process.env[key]; delete process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const managedRoot = path.join(temporary, privateValue), userData = path.join(managedRoot, "launcher"), installRoot = path.join(managedRoot, "deployment");
  await mkdir(installRoot, { recursive: true });
  const stale = path.join(userData, "preflight-ABC123", "keep.txt");
  await mkdir(path.dirname(stale), { recursive: true }); await writeFile(stale, "report must not clean temporary files");
  await writeFile(path.join(installRoot, ".env"), `FRAME_DATA_ROOT=./data\nPASSWORD=${privateValue}\n`);
  const calls = [], events = [], id = "1".repeat(64);
  let denied = false;
  const backend = createBackend({ userData, managedRoot, resourcesRoot: fileURLToPath(new URL("..", import.meta.url)), launcherVersion: "1.0.0-release",
    emit: (event) => events.push(event), fetchImpl: () => { throw new Error("Diagnostics must not contact release servers"); },
    run: async (command, args) => {
      calls.push({ command, args }); assert.equal(command, "docker");
      if (denied) throw Object.assign(new Error(privateValue), { code: "EACCES" });
      if (args[0] === "context") return { stdout: JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]) };
      if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64", ServerVersion: "28.5.1", Name: privateValue, DockerRootDir: managedRoot }) };
      if (args[0] === "compose") { assert.deepEqual(args, ["compose", "version"]); return { stdout: privateValue }; }
      if (args[0] === "ps") { assert.deepEqual(args, ["ps", "-a", "-q"]); return { stdout: id }; }
      assert.deepEqual(args, ["inspect", id]);
      return { stdout: JSON.stringify([{ Id: id, Config: { Env: [`TOKEN=${privateValue}`], Labels: { "com.docker.compose.project": "syronius-frame",
        "com.docker.compose.project.working_dir": installRoot, "com.docker.compose.service": "frame-audio" } }, State: { Status: "running", Running: true, Health: { Status: "unhealthy", Log: [{ Output: privateValue }] } } }]) };
    } });
  const report = await backend.invoke("get_diagnostics");
  assert.equal(report.docker.version, "28.5.1"); assert.equal(report.installations[0].services[0].health, "unhealthy");
  assert.ok(!JSON.stringify(report).includes(privateValue)); assert.ok(!JSON.stringify(report).includes(temporary));
  assert.equal(await readFile(stale, "utf8"), "report must not clean temporary files");
  assert.equal(await readFile(path.join(installRoot, ".env"), "utf8"), `FRAME_DATA_ROOT=./data\nPASSWORD=${privateValue}\n`);
  assert.equal(events.length, 0); assert.ok(calls.every(({ args }) => ["context", "info", "compose", "ps", "inspect"].includes(args[0])));
  denied = true;
  const failed = await backend.invoke("get_diagnostics");
  assert.equal(failed.docker.issue, "docker_permission_denied");
  assert.ok(!JSON.stringify(failed).includes(privateValue));
  assert.equal(await readFile(stale, "utf8"), "report must not clean temporary files");
});
