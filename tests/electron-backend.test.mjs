import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBackend, fetchLatestRelease, installArguments, runCommand, validatePlan } from "../apps/frame-setup/electron/backend.mjs";
import { CAPABILITIES, IMPLEMENTED_CAPABILITIES } from "../installer/frame-contract.mjs";
import { parseEnv } from "../installer/frame-env.mjs";
import { validateBindings } from "../installer/frame-preflight.mjs";
import { activateRelease, completeDeployment, FRAME_IMAGE_SERVICES, recordSourceCommit, RELEASE_IMAGE_PREFIX, validateReleaseManifest } from "../installer/frame-release.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const capabilities = CAPABILITIES.filter((name) => IMPLEMENTED_CAPABILITIES.has(name));
const assetUrl = "https://github.com/gall-levi-code/Syronius_FRAME/releases/download/v0.1.0/frame-images.json";
const manifest = (platform = "linux/amd64") => ({ schema_version: 1, commit: "a".repeat(40), platform, images: Object.fromEntries(
  FRAME_IMAGE_SERVICES.map((name) => [name, `${RELEASE_IMAGE_PREFIX}/${name}@sha256:${"b".repeat(64)}`]),
) });
const releaseFetch = async (url) => Response.json(String(url).includes("api.github.com")
  ? { assets: [{ name: "frame-images.json", browser_download_url: assetUrl }] } : manifest());
const planFor = (installRoot, edge = 18080) => ({ deploymentMode: "LAN", installRoot,
  selectedServices: ["frame-audio-relay"], ports: { edge },
  credentials: { portalUsername: "frame user", portalPassword: "literal $secret with spaces" } });

test("Electron command runner preserves argument boundaries and stdin, streams output, and rejects failures", async (t) => {
  const root = await temporary(t), script = path.join(root, "process with spaces.mjs");
  await writeFile(script, `let input = ""; for await (const chunk of process.stdin) input += chunk;
    console.log(JSON.stringify({ args: process.argv.slice(2), input })); console.error("diagnostic output");`);
  const args = ["two words", "$literal; & not-a-command", "--literal-flag"], chunks = [];
  const result = await runCommand(process.execPath, [script, ...args], { cwd: root, input: "credential with spaces\n", onOutput: (chunk) => chunks.push(chunk) });
  assert.deepEqual(JSON.parse(result.stdout), { args, input: "credential with spaces\n" });
  assert.match(result.stderr, /diagnostic output/);
  assert.match(chunks.join(""), /credential with spaces/);
  assert.match(chunks.join(""), /diagnostic output/);
  await assert.rejects(runCommand(process.execPath, ["-e", "console.error('validation rejected');process.exit(7)"]), (error) => {
    assert.match(error.message, /validation rejected/);
    assert.equal(error.exitCode, 7);
    assert.match(error.stderr, /validation rejected/);
    return true;
  });
  await assert.rejects(runCommand(process.execPath, ["-e", "process.exit(3)"]), /status 3/);
  await assert.rejects(runCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100 }), /timed out/);
});

test("validated LAN plans feed the actual shared installer and preserve data paths and credentials with spaces", async (t) => {
  const root = await temporary(t), source = path.join(root, "runtime files"), workspace = path.join(root, "installed FRAME");
  await copyRuntime(source);
  await mkdir(workspace);
  await mkdir(path.join(workspace, "installer", "templates"), { recursive: true });
  await copyFile(path.join(source, "installer/templates/docker-compose.yml"), path.join(workspace, "installer/templates/docker-compose.yml"));
  const plan = validatePlan(planFor(workspace), capabilities), dataRoot = path.join(root, "data with spaces");
  const args = installArguments(plan, CAPABILITIES, dataRoot);
  assert.ok(!args.includes(plan.credentials.portalPassword), "secrets belong on stdin, never command arguments");
  const env = { ...process.env, FRAME_WORKSPACE: workspace, FRAME_INSTALLER_DATA_ROOT: "" };
  const run = (arguments_, input) => runCommand(process.execPath, [path.join(source, "installer/frame-installer.mjs"), ...arguments_], { cwd: root, env, input });
  await run(args);
  await run(["set-portal-auth"], `${plan.credentials.portalUsername}\n${plan.credentials.portalPassword}\n`);
  await run(["validate", "--for-start"]);
  const saved = parseEnv(await readFile(path.join(workspace, ".env"), "utf8"));
  assert.equal(saved.FRAME_DATA_ROOT, dataRoot.replaceAll("\\", "/"));
  assert.equal(saved.PORTAL_PASSWORD, plan.credentials.portalPassword);
  assert.equal(saved.EDGE_HTTP_PORT, "18080");
  assert.throws(() => validatePlan({ ...plan, installRoot: "relative folder" }, capabilities), /absolute/);
  assert.throws(() => validatePlan({ ...plan, credentials: { portalPassword: "line\nbreak" } }, capabilities), /credential/);
  assert.throws(() => validatePlan({ ...plan, selectedServices: ["frame-discord-audio-bridge"] }, capabilities), /valid FRAME services/);
});

test("online release discovery requires an official manifest asset and validates its image digests", async () => {
  const calls = [];
  assert.deepEqual(await fetchLatestRelease(validateReleaseManifest, async (url) => { calls.push(url); return releaseFetch(url); }), manifest());
  assert.deepEqual(calls, ["https://api.github.com/repos/gall-levi-code/Syronius_FRAME/releases/latest", assetUrl]);
  await assert.rejects(fetchLatestRelease(validateReleaseManifest, async () => Response.json({ assets: [] })), /no frame-images.json/);
  let requests = 0;
  await assert.rejects(fetchLatestRelease(validateReleaseManifest, async () => {
    requests += 1;
    return Response.json({ assets: [{ name: "frame-images.json", browser_download_url: "https://example.com/frame-images.json" }] });
  }), /not an official release/);
  assert.equal(requests, 1, "foreign asset must be rejected before making its request");
  await assert.rejects(fetchLatestRelease(validateReleaseManifest, async (url) => String(url).includes("api.github.com")
    ? releaseFetch(url) : Response.json({ ...manifest(), images: {} })), /exactly the 12/);
});

test("explicit release selection accepts a published prerelease and never falls back to another tag", async () => {
  const releaseTag = "v1.0.0-alpha.2";
  const taggedAssetUrl = `https://github.com/gall-levi-code/Syronius_FRAME/releases/download/${releaseTag}/frame-images.json`;
  const metadata = { tag_name: releaseTag, draft: false, prerelease: true, published_at: "2026-09-17T12:00:00Z",
    assets: [{ name: "frame-images.json", browser_download_url: taggedAssetUrl }] };
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return Response.json(String(url).includes("api.github.com") ? metadata : manifest()); };
  assert.deepEqual(await fetchLatestRelease(validateReleaseManifest, fetchImpl, releaseTag), manifest());
  assert.deepEqual(calls, [`https://api.github.com/repos/gall-levi-code/Syronius_FRAME/releases/tags/${releaseTag}`, taggedAssetUrl]);
  for (const changes of [{ tag_name: "v1.0.0-alpha.1" }, { draft: true }, { draft: undefined }, { published_at: null }, { published_at: "invalid" }]) {
    let requests = 0;
    await assert.rejects(fetchLatestRelease(validateReleaseManifest, async () => {
      requests += 1;
      return Response.json({ ...metadata, ...changes });
    }, releaseTag), /requested published FRAME release/);
    assert.equal(requests, 1, "invalid release metadata must stop before fetching an asset or fallback release");
  }
  await assert.rejects(fetchLatestRelease(validateReleaseManifest, async () => Response.json({ ...metadata,
    assets: [{ name: "frame-images.json", browser_download_url: assetUrl }],
  }), releaseTag), /manifest does not belong to release/);
  await assert.rejects(fetchLatestRelease(validateReleaseManifest, async () => new Response(null, { status: 404 }), releaseTag), /release "v1\.0\.0-alpha\.2" is not published/);
});

test("ARM64 release selection requires the ARM asset, exact release and matching platform without fallback", async () => {
  const releaseTag = "v-next", armUrl = `https://github.com/gall-levi-code/Syronius_FRAME/releases/download/${releaseTag}/frame-images-arm64.json`;
  const metadata = { tag_name: releaseTag, draft: false, published_at: "2026-09-30T12:00:00Z", assets: [
    { name: "frame-images.json", browser_download_url: `https://github.com/gall-levi-code/Syronius_FRAME/releases/download/${releaseTag}/frame-images.json` },
    { name: "frame-images-arm64.json", browser_download_url: armUrl },
  ] };
  const requests = [], fetchArm = async (url) => { requests.push(url); return Response.json(String(url).includes("api.github.com") ? metadata : manifest("linux/arm64")); };
  assert.deepEqual(await fetchLatestRelease(validateReleaseManifest, fetchArm, releaseTag, "linux/arm64"), manifest("linux/arm64"));
  assert.deepEqual(requests, [`https://api.github.com/repos/gall-levi-code/Syronius_FRAME/releases/tags/${releaseTag}`, armUrl]);
  await assert.rejects(fetchLatestRelease(validateReleaseManifest, async (url) => Response.json(String(url).includes("api.github.com") ? metadata : manifest()), releaseTag, "linux/arm64"), /requires linux\/arm64/);
  let missingRequests = 0;
  await assert.rejects(fetchLatestRelease(validateReleaseManifest, async () => {
    missingRequests += 1;
    return Response.json({ ...metadata, assets: metadata.assets.slice(0, 1) });
  }, releaseTag, "linux/arm64"), /no frame-images-arm64\.json/);
  assert.equal(missingRequests, 1, "a missing ARM manifest must not download or use the AMD64 asset");
  await assert.rejects(fetchLatestRelease(validateReleaseManifest, async () => Response.json({ ...metadata, assets: [
    { name: "frame-images-arm64.json", browser_download_url: metadata.assets[0].browser_download_url },
  ] }), releaseTag, "linux/arm64"), /does not name frame-images-arm64\.json/);
  await assert.rejects(fetchLatestRelease(validateReleaseManifest, fetchArm, releaseTag, "linux/arm/v7"), /support linux\/amd64 and linux\/arm64 only/);
});

test("real Compose resolves candidate configuration for an absent installation folder and overrides inherited settings", async (t) => {
  try { await runCommand("docker", ["compose", "version"], { timeout: 10_000 }); }
  catch (error) {
    if (error.code === "ENOENT" || /is not a docker command|unknown command|not found|cannot find/i.test(error.message)) return t.skip("Docker Compose CLI is unavailable");
    throw error;
  }
  for (const [key, value] of Object.entries({ EDGE_HTTP_PORT: "123", FRAME_DATA_ROOT: "/incorrect inherited data", COMPOSE_PROFILES: "hybrid,overlays,audio-bridge" })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const { backend, calls, plan, resolved } = await backendFixture(t, { edge: 38080, realCompose: true });
  plan.selectedServices.push("frame-video-relay", "frame-photo-ftp");
  plan.ports.photoFtpPassive = "39000-39002";
  plan.advancedSettings = { PHOTO_FTP_PASSIVE_HOST: "192.0.2.10" };
  const result = await backend.invoke("run_preflight", { request: plan });
  assert.equal(resolved.length, 1, JSON.stringify(result.checks));
  const compose = resolved[0];
  assert.equal(compose.name, "syronius-frame");
  assert.equal(compose.services["frame-audio"].image, manifest().images["frame-audio"]);
  assert.equal(compose.services["frame-audio-bridge"], undefined);
  assert.equal(compose.services["frame-overlays"], undefined);
  assert.equal(compose.services["frame-tunnel"], undefined);
  const { bindings, checks } = validateBindings(compose);
  assert.deepEqual(checks, []);
  assert.deepEqual(bindings.map((binding) => `${binding.service}:${binding.hostPort}/${binding.protocol}`).sort(), [
    "frame-edge:38080/tcp", "frame-portal:3730/tcp", "frame-audio:3734/tcp", "frame-streams:3732/tcp",
    "frame-ingest-video:5000/udp", "frame-ingest-video:4000/udp", "frame-ingest-video:4001/udp", "frame-ingest-video:8080/tcp",
    "frame-photo-ftp:2121/tcp", "frame-photo-ftp:39000/tcp", "frame-photo-ftp:39001/tcp", "frame-photo-ftp:39002/tcp",
  ].sort());
  assert.equal(path.resolve(compose.services["frame-audio"].volumes.find((volume) => volume.target === "/data").source), path.join(plan.installRoot, "data", "audio-monitor"));
  await assert.rejects(readFile(path.join(plan.installRoot, ".env")), { code: "ENOENT" });
  assertReadOnlyDocker(calls);
});

test("missing online release blocks installation without downloading source or starting Docker", async (t) => {
  const { backend, calls, plan } = await backendFixture(t, { fetchImpl: async () => new Response(null, { status: 404 }) });
  const result = await backend.invoke("run_preflight", { request: plan });
  assert.ok(result.checks.some((check) => check.status === "bad" && /No published FRAME release/.test(check.detail)));
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /readiness checks/);
  assert.ok(calls.every(({ command }) => command === "docker"), "source download/runtime must not start without a release");
  assertReadOnlyDocker(calls);
});

test("backend passes its configured release tag and blocks when that exact release is unavailable", async (t) => {
  const requests = [], releaseTag = "v1.0.0-release";
  const { backend, calls, plan } = await backendFixture(t, { releaseTag, fetchImpl: async (url) => {
    requests.push(url);
    return new Response(null, { status: 404 });
  } });
  const result = await backend.invoke("run_preflight", { request: plan });
  assert.ok(result.checks.some((check) => check.status === "bad" && check.detail.includes(releaseTag)));
  assert.deepEqual(requests, [`https://api.github.com/repos/gall-levi-code/Syronius_FRAME/releases/tags/${releaseTag}`]);
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /readiness checks/);
  assert.ok(calls.every(({ command }) => command === "docker"));
  assertReadOnlyDocker(calls);
});

test("occupied and newly occupied ports block preflight/apply before installation mutations or Docker startup", async (t) => {
  const server = net.createServer();
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const { backend, calls, plan } = await backendFixture(t, { edge: port });
  const occupied = await backend.invoke("run_preflight", { request: plan });
  assert.ok(occupied.checks.some((check) => check.status === "bad" && /occupied/.test(check.detail)), JSON.stringify(occupied.checks));
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /readiness checks/);
  await new Promise((resolve) => server.close(resolve));
  const available = await backend.invoke("run_preflight", { request: plan });
  assert.ok(available.checks.length && available.checks.every((check) => check.status !== "bad"), JSON.stringify(available.checks));
  await assert.rejects(backend.invoke("run_preflight", { request: { ...plan, ports: { edge: 0 } } }), /edge must be a port/);
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /readiness checks/);
  const rechecked = await backend.invoke("run_preflight", { request: plan });
  assert.ok(rechecked.checks.every((check) => check.status !== "bad"), JSON.stringify(rechecked.checks));
  await assert.rejects(backend.invoke("apply_install_plan", { request: { ...plan, ports: { edge: port === 65535 ? port - 1 : port + 1 } } }), /readiness checks/);
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /occupied/);
  await assert.rejects(readFile(path.join(plan.installRoot, ".env")), { code: "ENOENT" });
  assertReadOnlyDocker(calls);
});

test("successful apply records a credential-free plan and a failed wrapper spawn restores prior configuration", async (t) => {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const edge = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  let rejectStart = false;
  const { backend, calls, plan, logs } = await backendFixture(t, { edge, wrapper: async (_command, args, options) => {
    assert.equal(args.at(-1), "start");
    assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(options.env.FRAME_PREFLIGHT_NODE, process.execPath);
    assert.ok(path.isAbsolute(options.env.FRAME_PREFLIGHT_SCRIPT));
    if (rejectStart) throw Object.assign(new Error(`Wrapper could not start with ${options.env.PORTAL_PASSWORD}`), { code: "ENOENT", spawned: false });
    options.onOutput(`Starting with ${options.env.PORTAL_PASSWORD}\n`);
    await completeDeployment(options.cwd);
    return { stdout: "healthy", stderr: "" };
  } });
  const readiness = await backend.invoke("run_preflight", { request: plan });
  assert.ok(readiness.checks.every((check) => check.status !== "bad"), JSON.stringify(readiness.checks));
  const installed = await backend.invoke("apply_install_plan", { request: plan });
  assert.equal(installed.setupUrl, `http://localhost:${edge}/dashboard`);
  assert.equal(installed.dashboardUrl, installed.setupUrl);
  assert.equal(JSON.parse(await readFile(installed.path, "utf8")).credentials, undefined);
  assert.ok(logs.some((line) => line.includes("[redacted]")));
  assert.ok(logs.every((line) => !line.includes(plan.credentials.portalPassword)));
  const originalEnv = await readFile(path.join(plan.installRoot, ".env"), "utf8");
  const changed = { ...plan, credentials: { ...plan.credentials, portalPassword: "replacement secret" } };
  const reconfigure = await backend.invoke("run_preflight", { request: changed });
  assert.ok(reconfigure.checks.every((check) => check.status !== "bad"), JSON.stringify(reconfigure.checks));
  rejectStart = true;
  await assert.rejects(backend.invoke("apply_install_plan", { request: changed }), (error) => {
    assert.match(error.message, /Wrapper could not start/);
    assert.ok(!error.message.includes(changed.credentials.portalPassword));
    return true;
  });
  assert.equal(await readFile(path.join(plan.installRoot, ".env"), "utf8"), originalEnv);
  const snapshot = JSON.parse(await readFile(path.join(plan.installRoot, ".frame-deployment-backup/snapshot.json"), "utf8"));
  assert.equal(snapshot.pending, false);
  assert.equal(calls.filter(({ command }) => command !== "docker" && command !== process.execPath).length, 2);
});

function assertReadOnlyDocker(calls) {
  assert.ok(calls.every(({ command, args }) => command === process.execPath || command === "docker"), "installation wrapper must not be invoked");
  assert.ok(calls.filter(({ command }) => command === "docker").every(({ args }) => !args.some((arg) => ["pull", "build", "up", "run", "start"].includes(arg))));
}

test("first install and reconfiguration report live container progress before the wrapper finishes", async (t) => {
  const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
  const waitFor = async (predicate) => {
    for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.fail("Expected startup progress did not arrive");
  };
  let gate = deferred(), entered = deferred();
  t.after(() => gate.resolve());
  const { backend, plan, engine, progress, clock } = await backendFixture(t, {
    startup: async () => { entered.resolve(); await gate.promise; },
    wrapper: async (_command, _args, options) => { await completeDeployment(options.cwd); return { stdout: "", stderr: "" }; },
  });
  for (const reconfigure of [false, true]) {
    const ready = await backend.invoke("run_preflight", { request: plan });
    assert.ok(ready.checks.every((check) => check.status !== "bad"), JSON.stringify(ready.checks));
    progress.length = 0;
    const operation = backend.invoke("apply_install_plan", { request: plan });
    await Promise.race([entered.promise, operation.then(() => { throw new Error("Apply completed without invoking startup"); })]);
    assert.equal(backend.isBusy(), true);
    assert.equal(progress[0].phase, "starting");
    assert.deepEqual(progress[0].services, [{ name: "frame-edge", status: "waiting", health: "none" }]);
    if (!reconfigure) await waitFor(() => progress.at(-1).services[0].status === "missing");
    engine.containers = [{ Id: "c".repeat(64), Image: `sha256:${"b".repeat(64)}`, Config: { Labels: {
      "com.docker.compose.project": "syronius-frame", "com.docker.compose.project.working_dir": plan.installRoot, "com.docker.compose.service": "frame-edge",
    } }, State: { Running: true, Status: "running", Health: { Status: "starting" } },
    NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(plan.ports.edge) }] } } }];
    await waitFor(() => { clock.tick(); return progress.at(-1).services[0].health === "starting"; });
    assert.ok(progress.every((event) => event.phase === "starting"));
    engine.containers[0].State.Health.Status = "healthy";
    gate.resolve();
    const installed = await operation;
    assert.equal(installed.dashboardUrl, `http://localhost:${plan.ports.edge}/dashboard`);
    assert.equal(progress.at(-1).phase, "complete");
    assert.equal(progress.at(-1).services[0].health, "healthy");
    assert.equal(clock.active, false);
    const count = progress.length;
    clock.tick();
    await new Promise(setImmediate);
    assert.equal(progress.length, count);
    gate = deferred(); entered = deferred();
  }
});

test("an install wrapper exiting successfully cannot complete startup with missing containers", async (t) => {
  const { backend, plan, progress, clock } = await backendFixture(t, {
    startup: async () => {}, // Leave the expected container absent even though the wrapper returns zero.
    wrapper: async (_command, _args, options) => { await completeDeployment(options.cwd); return { stdout: "", stderr: "" }; },
  });
  const readiness = await backend.invoke("run_preflight", { request: plan });
  assert.ok(readiness.checks.every((check) => check.status !== "bad"));
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /container is missing/);
  assert.equal(progress.at(-1).phase, "failed");
  assert.equal(progress.at(-1).services[0].status, "missing");
  assert.ok(progress.every((event) => event.phase !== "complete"));
  assert.equal(clock.active, false);
});

async function temporary(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "FRAME Electron test ")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function copyRuntime(root) {
  for (const file of ["installer/frame-installer.mjs", "installer/frame-env.mjs", "installer/frame-contract.mjs", "installer/frame-updater.mjs",
    "installer/frame-release.mjs", "installer/templates/docker-compose.yml", "config/frame-services.json"]) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await copyFile(path.join(repository, file), path.join(root, file));
  }
}

async function backendFixture(t, { fetchImpl = releaseFetch, edge = 18080, wrapper, realCompose = false, releaseTag, sourceTransform,
  engineArch = "amd64", imagePlatform = "linux/amd64", platform, arch, releaseHelpersTransform, startup,
  storageProbe = async (location, label) => ({ label, status: "good", detail: `${location} is writable; storage ready.` }) } = {}) {
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT"]) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const root = await temporary(t), calls = [], logs = [], progress = [], resolved = [], engine = { architecture: engineArch, containers: [] };
  const clock = { active: false, tick: () => {} };
  const plan = planFor(path.join(root, "FRAME installation"), edge);
  const run = async (command, args, options = {}) => {
    calls.push({ command, args });
    if (command === "docker") {
      if (args[0] === "context") return { stdout: JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]) };
      if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: engine.architecture }) };
      if (args[0] === "ps") return { stdout: engine.containers.map((container) => args.includes("--format")
        ? JSON.stringify([container.Id, container.Config.Labels["com.docker.compose.project.working_dir"], container.Config.Labels["com.docker.compose.service"]]) : container.Id).join("\n") };
      if (args[0] === "inspect") return { stdout: JSON.stringify(engine.containers.filter((container) => args.includes(container.Id))) };
      if (args[1] === "version") return { stdout: "" };
      if (args.includes("config") && realCompose) {
        const result = await runCommand(command, args, options);
        resolved.push(JSON.parse(result.stdout));
        return result;
      }
      if (args.includes("config")) return { stdout: JSON.stringify({ name: "syronius-frame", services: {
        "frame-edge": { ports: [{ host_ip: "127.0.0.1", published: String(edge), target: 80, protocol: "tcp" }] },
      } }) };
      throw new Error(`Unexpected Docker mutation: ${args.join(" ")}`);
    }
    if (command !== process.execPath && wrapper) {
      await startup?.(engine, options);
      const result = await wrapper(command, args, options);
      if (!startup) engine.containers = [{ Id: "c".repeat(64), Image: `sha256:${"b".repeat(64)}`, Config: { Labels: { "com.docker.compose.project": "syronius-frame",
        "com.docker.compose.project.working_dir": options.cwd, "com.docker.compose.service": "frame-edge" } }, State: { Running: true, Status: "running" },
        NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: String(edge) }] } } }];
      return result;
    }
    assert.equal(command, process.execPath, "must not launch installation wrapper in a blocked test");
    if (args[1] === "source-update") {
      const source = options.env.FRAME_WORKSPACE;
      await copyRuntime(source);
      for (const wrapperName of ["stack.ps1", "stack.sh"]) await copyFile(path.join(repository, "installer", wrapperName), path.join(source, "installer", `${wrapperName}.next`));
      await recordSourceCommit(source, manifest(imagePlatform).commit);
      await activateRelease(source, manifest(imagePlatform));
      if (sourceTransform) {
        const runtimePath = path.join(source, "installer/frame-installer.mjs");
        await writeFile(runtimePath, sourceTransform(await readFile(runtimePath, "utf8")));
      }
      if (releaseHelpersTransform) {
        const helper = path.join(source, "installer/frame-release.mjs");
        await writeFile(helper, releaseHelpersTransform(await readFile(helper, "utf8")));
      }
      return { stdout: "" };
    }
    return runCommand(command, args, { ...options, platform: process.platform }); // Execute fixture scripts on the actual test host.
  };
  const backend = createBackend({ resourcesRoot: repository, userData: path.join(root, "installer profile"), run, fetchImpl, releaseTag, platform, arch, storageProbe,
    setIntervalImpl: (tick, delay) => { assert.equal(delay, 1_000); clock.tick = tick; clock.active = true; return clock; },
    clearIntervalImpl: () => { clock.active = false; },
    emit: (event, message) => { if (event === "install-log") logs.push(message); if (event === "launcher-progress") progress.push(message); } });
  t.after(() => backend.dispose());
  return { backend, calls, plan, logs, resolved, engine, progress, clock };
}

test("Electron stages extraction acknowledgement and preserves legacy secrets before applying replacement config", async (t) => {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const edge = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  let starts = 0;
  const { backend, plan } = await backendFixture(t, { edge, wrapper: async (_command, _args, options) => {
    starts += 1;
    await completeDeployment(options.cwd);
    return { stdout: "healthy", stderr: "" };
  } });
  await backend.invoke("run_preflight", { request: plan });
  await backend.invoke("apply_install_plan", { request: plan });
  const historicalManifest = manifest();
  historicalManifest.images["frame-audio-bridge"] = `${RELEASE_IMAGE_PREFIX}/frame-audio-bridge@sha256:${"b".repeat(64)}`;
  await writeFile(path.join(plan.installRoot, "frame-release.json"), JSON.stringify(historicalManifest));
  const envPath = path.join(plan.installRoot, ".env");
  const stateRoot = path.join(plan.installRoot, "data/state");
  const configPath = path.join(stateRoot, "stack-config.json");
  const original = await readFile(envPath, "utf8");
  const legacy = original.replace(/^COMPOSE_PROFILES=.*$/m, "COMPOSE_PROFILES=audio-monitor,audio-bridge") + "DISCORD_TOKEN=private-legacy-token\n";
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.capabilities["frame-discord-audio-bridge"] = true;
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(envPath, legacy);
  const planPath = path.join(stateRoot, "frame-install-plan.json");
  const savedPlan = JSON.parse(await readFile(planPath, "utf8"));
  await writeFile(planPath, JSON.stringify({ ...savedPlan, selectedServices: [...savedPlan.selectedServices, "frame-discord-audio-bridge"],
    ports: { ...savedPlan.ports, audioBridge: 3729 }, credentials: { discordToken: "private-legacy-token" } }));
  const loaded = await backend.invoke("load_install_plan", { installRoot: plan.installRoot });
  assert.deepEqual(loaded.selectedServices, ["frame-audio-relay"]);
  assert.equal(loaded.ports.audioBridge, undefined);
  assert.equal(loaded.credentials, undefined);
  assert.equal(loaded.ports.audioMonitor, 3734);
  await writeFile(planPath, JSON.stringify({ ...savedPlan, selectedServices: ["frame-discord-audio-bridge"] }));
  assert.deepEqual((await backend.invoke("load_install_plan", { installRoot: plan.installRoot })).selectedServices, []);
  const runtimePath = path.join(plan.installRoot, "installer/frame-installer.mjs");
  const runtimeSource = await readFile(runtimePath, "utf8");
  await writeFile(runtimePath, runtimeSource.replaceAll("checkAudioBridgeExtraction", "historicalInstallerWithoutExtraction"));
  const bootstrapBlocked = await backend.invoke("run_preflight", { request: plan });
  assert.ok(bootstrapBlocked.checks.some((check) => check.status === "bad" && /bootstrap the updated FRAME source/.test(check.detail)));
  await writeFile(runtimePath, runtimeSource);
  const blocked = await backend.invoke("run_preflight", { request: plan });
  assert.ok(blocked.checks.some((check) => check.status === "bad" && /complete the standalone cutover/.test(check.detail)));
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /readiness checks/);
  assert.equal(starts, 1);
  assert.equal(await readFile(envPath, "utf8"), legacy);
  const markerPath = path.join(stateRoot, "audio-bridge-extraction-complete");
  await writeFile(markerPath, "standalone-cutover-complete\n");
  const result = await backend.invoke("run_preflight", { request: plan });
  assert.ok(result.checks.every((check) => check.status !== "bad"));
  // Preflight writes only its temporary candidate.
  await assert.rejects(readFile(path.join(stateRoot, "audio-bridge-extraction/legacy.env")), { code: "ENOENT" });
  await backend.invoke("apply_install_plan", { request: plan });
  assert.equal(starts, 2);
  assert.equal(await readFile(path.join(stateRoot, "audio-bridge-extraction/legacy.env"), "utf8"), legacy);
  assert.equal(parseEnv(await readFile(envPath, "utf8")).DISCORD_TOKEN, undefined);
  assert.equal(await readFile(markerPath, "utf8"), "standalone-cutover-complete\n");
});

test("fresh setup rejects a downloaded historical runtime before creating an installation", async (t) => {
  const { backend, calls, plan } = await backendFixture(t, {
    sourceTransform: (source) => source.replaceAll("checkAudioBridgeExtraction", "historicalInstallerWithoutExtraction"),
  });
  const result = await backend.invoke("run_preflight", { request: plan });
  assert.ok(result.checks.some((check) => check.status === "bad" && /release still includes the integrated Audio Bridge/.test(check.detail)), JSON.stringify(result.checks));
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /readiness checks/);
  await assert.rejects(readFile(path.join(plan.installRoot, ".env")), { code: "ENOENT" });
  assertReadOnlyDocker(calls);
});

test("storage warnings permit readiness but a newly full drive blocks Apply before deployment changes", async (t) => {
  let full = false;
  const probes = [];
  const { backend, calls, plan } = await backendFixture(t, { storageProbe: async (location, label, options) => {
    probes.push({ location, label, requiredBytes: options.requiredBytes });
    return { label, status: full && label === "FRAME data storage" ? "bad" : "warn", detail: full ? "Storage is full." : "Network storage; low space. You can continue." };
  } });
  const ready = await backend.invoke("run_preflight", { request: plan });
  assert.ok(ready.checks.every((check) => check.status !== "bad"));
  assert.ok(ready.checks.some((check) => check.label === "Docker image storage" && check.status === "warn"));
  assert.ok(probes.some((probe) => probe.label === "Deployment storage" && probe.requiredBytes > 0), "fresh source space is measured from staged files");
  full = true;
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /FRAME data storage: Storage is full/);
  await assert.rejects(readFile(path.join(plan.installRoot, ".env")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(plan.installRoot, ".frame-deployment-backup/snapshot.json")), { code: "ENOENT" });
  assertReadOnlyDocker(calls);
});

test("a measured staged-source shortage blocks readiness and cannot authorize Apply", async (t) => {
  const { backend, calls, plan } = await backendFixture(t, { storageProbe: async (_location, label, { requiredBytes }) => ({
    label, status: requiredBytes > 0 ? "bad" : "good", detail: requiredBytes > 0 ? "The staged release does not fit." : "Storage ready.",
  }) });
  const ready = await backend.invoke("run_preflight", { request: plan });
  assert.ok(ready.checks.some((check) => check.label === "Deployment storage" && check.status === "bad"));
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /readiness checks/);
  await assert.rejects(readFile(path.join(plan.installRoot, ".env")), { code: "ENOENT" });
  assertReadOnlyDocker(calls);
});

test("new installs separate deployment and data storage while reconfiguration preserves the installed data path", async (t) => {
  const { backend, plan } = await backendFixture(t, { wrapper: async (_command, _args, options) => {
    await completeDeployment(options.cwd);
    return { stdout: "healthy", stderr: "" };
  } });
  plan.dataRoot = path.join(path.dirname(plan.installRoot), "user content");
  const ready = await backend.invoke("run_preflight", { request: plan });
  assert.ok(ready.checks.every((check) => check.status !== "bad"), JSON.stringify(ready.checks));
  assert.ok(ready.checks.some((check) => check.label === "Deployment storage"));
  assert.ok(ready.checks.some((check) => check.label === "FRAME data storage" && check.detail.includes(plan.dataRoot)));
  await backend.invoke("get_launcher_status"); // Tray polling must not invalidate a prepared installation.
  const installed = await backend.invoke("apply_install_plan", { request: plan });
  assert.equal(installed.path, path.join(plan.dataRoot, "state/frame-install-plan.json"));
  assert.equal(parseEnv(await readFile(path.join(plan.installRoot, ".env"), "utf8")).FRAME_DATA_ROOT, plan.dataRoot.replaceAll("\\", "/"));
  assert.equal((await backend.invoke("load_install_plan", { installRoot: plan.installRoot })).dataRoot, plan.dataRoot);
  const changed = await backend.invoke("run_preflight", { request: { ...plan, dataRoot: path.join(path.dirname(plan.installRoot), "replacement") } });
  assert.ok(changed.checks.some((check) => check.status === "bad" && /Moving existing FRAME data/.test(check.detail)));
  const { dataRoot, ...withoutPath } = plan;
  const preserved = await backend.invoke("run_preflight", { request: withoutPath });
  assert.ok(preserved.checks.every((check) => check.status !== "bad"), JSON.stringify(preserved.checks));
  assert.throws(() => validatePlan({ ...plan, dataRoot: plan.installRoot }, capabilities), /cannot contain/);
  assert.throws(() => validatePlan({ ...plan, dataRoot: "relative" }, capabilities), /absolute/);
});

test("fresh Apple Silicon setup uses ARM64 images and refuses an engine change after readiness", async (t) => {
  const armUrl = assetUrl.replace("frame-images.json", "frame-images-arm64.json"), requests = [];
  const fetchImpl = async (url) => { requests.push(url); return Response.json(String(url).includes("api.github.com")
    ? { assets: [{ name: "frame-images-arm64.json", browser_download_url: armUrl }] } : manifest("linux/arm64")); };
  const { backend, calls, plan, engine } = await backendFixture(t, { fetchImpl, platform: "darwin", arch: "arm64", engineArch: "aarch64", imagePlatform: "linux/arm64" });
  const ready = await backend.invoke("run_preflight", { request: plan });
  assert.ok(ready.checks.every((check) => check.status !== "bad"), JSON.stringify(ready.checks));
  assert.equal(requests[1], armUrl);
  assert.ok(ready.checks.some((check) => check.label === "Release" && /linux\/arm64/.test(check.detail)));
  engine.architecture = "amd64";
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /requires linux\/amd64/);
  await assert.rejects(readFile(path.join(plan.installRoot, ".env")), { code: "ENOENT" });
  assertReadOnlyDocker(calls);
});

test("ARM64 setup rejects historical source helpers even when manifest metadata declares ARM64", async (t) => {
  const armUrl = assetUrl.replace("frame-images.json", "frame-images-arm64.json");
  const { backend, calls, plan } = await backendFixture(t, { platform: "darwin", arch: "arm64", engineArch: "arm64", imagePlatform: "linux/arm64",
    fetchImpl: async (url) => Response.json(String(url).includes("api.github.com") ? { assets: [{ name: "frame-images-arm64.json", browser_download_url: armUrl }] } : manifest("linux/arm64")),
    releaseHelpersTransform: (source) => source.replaceAll("linux/arm64", "historical-unsupported-platform"),
  });
  const result = await backend.invoke("run_preflight", { request: plan });
  assert.ok(result.checks.some((check) => check.status === "bad" && /source helpers predate ARM64/.test(check.detail)), JSON.stringify(result.checks));
  await assert.rejects(backend.invoke("apply_install_plan", { request: plan }), /readiness checks/);
  assertReadOnlyDocker(calls);
});
