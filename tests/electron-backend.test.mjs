import assert from "node:assert/strict";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const manifest = () => ({ schema_version: 1, commit: "a".repeat(40), platform: "linux/amd64", images: Object.fromEntries(
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
  await assert.rejects(runCommand(process.execPath, ["-e", "console.error('validation rejected');process.exit(7)"]), /validation rejected/);
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
    ? releaseFetch(url) : Response.json({ ...manifest(), images: {} })), /exactly the 13/);
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
  assert.equal(installed.setupUrl, `http://localhost:${edge}/setup`);
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

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "FRAME Electron test "));
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

async function backendFixture(t, { fetchImpl = releaseFetch, edge = 18080, wrapper, realCompose = false, releaseTag } = {}) {
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT"]) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  const root = await temporary(t), calls = [], logs = [], resolved = [];
  const plan = planFor(path.join(root, "FRAME installation"), edge);
  const run = async (command, args, options = {}) => {
    calls.push({ command, args });
    if (command === "docker") {
      if (args[0] === "context") return { stdout: JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]) };
      if (args[0] === "info") return { stdout: JSON.stringify({ OSType: "linux", Architecture: "amd64" }) };
      if (args[0] === "ps" || args[1] === "version") return { stdout: "" };
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
    if (command !== process.execPath && wrapper) return wrapper(command, args, options);
    assert.equal(command, process.execPath, "must not launch installation wrapper in a blocked test");
    if (args[1] === "source-update") {
      const source = options.env.FRAME_WORKSPACE;
      await copyRuntime(source);
      for (const wrapperName of ["stack.ps1", "stack.sh"]) await copyFile(path.join(repository, "installer", wrapperName), path.join(source, "installer", `${wrapperName}.next`));
      await recordSourceCommit(source, manifest().commit);
      await activateRelease(source, manifest());
      return { stdout: "" };
    }
    return runCommand(command, args, options);
  };
  const backend = createBackend({ resourcesRoot: repository, userData: path.join(root, "installer profile"), run, fetchImpl, releaseTag, emit: (_event, message) => logs.push(message) });
  t.after(() => backend.dispose());
  return { backend, calls, plan, logs, resolved };
}
