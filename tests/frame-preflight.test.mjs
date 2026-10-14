import assert from "node:assert/strict";
import net from "node:net";
import dgram from "node:dgram";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkHostPorts, dockerReadinessFailure, localDockerEnv, runHostPreflight, validateBindings, validateDockerEngine } from "../installer/frame-preflight.mjs";

const port = (published, extra = {}) => ({ target: published, published: String(published), host_ip: "127.0.0.1", protocol: "tcp", ...extra });
const compose = (ports, services = {}) => ({ name: "syronius-frame", services: { edge: { ports }, ...services } });
const failed = (result) => result.checks.filter((c) => c.status === "bad");
const container = (hostPort, extraLabels = {}, mapping = {}) => ({
  Name: "/existing-frame", State: { Running: true },
  Config: { Labels: { "com.docker.compose.project": "syronius-frame", "com.docker.compose.service": "edge",
    "com.docker.compose.project.working_dir": "/frame workspace", ...extraLabels } },
  NetworkSettings: { Ports: { [`${mapping.target || hostPort}/tcp`]: [{ HostIp: mapping.address || "127.0.0.1", HostPort: String(hostPort) }] } },
});

test("fixed ranges expand and overlaps consider protocol and host address", () => {
  const result = validateBindings(compose([port("30000-30002"), port(30001, { protocol: "udp" })], {
    api: { ports: [port(30001, { host_ip: "127.0.0.2" })] },
  }));
  assert.equal(result.bindings.length, 5);
  assert.equal(failed(result).length, 0);
  for (const host_ip of ["", "0.0.0.0", "::ffff:127.0.0.1"]) {
    assert.equal(failed(validateBindings(compose([port("30000-30002")], { ftp: { ports: [port(30001, { host_ip })] } }))).length, 1);
  }
  assert.equal(failed(validateBindings(compose([port(30001), port(30001, { host_ip: "::" })]))).length, 0);
});

test("invalid, dynamic, oversized, and host-network mappings fail closed", () => {
  for (const mapping of [null, "8080:80", port(0), port(65536), port("1-4097"), port("8000-8002", { target: 80 }),
    port(8080, { published: undefined }), port(8080, { host_ip: "localhost" }), port(8080, { protocol: "sctp" })]) {
    assert.ok(failed(validateBindings(compose([mapping]))).length, JSON.stringify(mapping));
  }
  assert.ok(failed(validateBindings({ services: { api: { network_mode: "host" } } })).length);
  assert.ok(failed(validateBindings({})).length);
  assert.ok(failed(validateBindings(compose("8080"))).length);
  assert.deepEqual(validateBindings({ services: { internal: { expose: [8080] } } }).bindings, []);
});

test("held TCP and UDP host sockets block preflight without process lookup", async (t) => {
  const tcp = net.createServer(), udp = dgram.createSocket("udp4");
  t.after(() => tcp.close());
  t.after(() => udp.close());
  tcp.listen(0, "127.0.0.1");
  udp.bind(0, "127.0.0.1");
  await Promise.all([once(tcp, "listening"), once(udp, "listening")]);
  const result = await checkHostPorts({ compose: compose([port(tcp.address().port), port(udp.address().port, { protocol: "udp" })]) });
  assert.equal(failed(result).length, 2);
  assert.ok(failed(result).every((c) => c.detail.includes("occupied by a host process")));
});

test("host ports become available after listeners close", async () => {
  const tcp = net.createServer(), udp = dgram.createSocket("udp4");
  tcp.listen(0, "127.0.0.1");
  udp.bind(0, "127.0.0.1");
  await Promise.all([once(tcp, "listening"), once(udp, "listening")]);
  // A TCP-assigned port can be occupied or reserved for UDP (and vice versa).
  const ports = [port(tcp.address().port), port(udp.address().port, { protocol: "udp" })];
  await Promise.all([new Promise((resolve) => tcp.close(resolve)), new Promise((resolve) => udp.close(resolve))]);
  const result = await checkHostPorts({ compose: compose(ports) });
  assert.deepEqual(failed(result), []);
  assert.equal(result.checks.length, 2);
});

test("only exact installation, service, address, and target mappings can be reused", async () => {
  const options = { compose: compose([port(18080)]), workspace: "/frame workspace", platform: "linux" };
  const result = await checkHostPorts({ ...options, containers: [container(18080)] });
  assert.equal(failed(result).length, 0);
  assert.match(result.checks[0].detail, /Already published/);
  for (const labels of [{ "com.docker.compose.project": "other" }, { "com.docker.compose.service": "api" },
    { "com.docker.compose.project.working_dir": "/other" }]) {
    assert.equal(failed(await checkHostPorts({ ...options, containers: [container(18080, labels)] })).length, 1);
  }
  for (const mapping of [{ target: 80 }, { address: "0.0.0.0" }]) {
    assert.equal(failed(await checkHostPorts({ ...options, containers: [container(18080, {}, mapping)] })).length, 1);
  }
  assert.equal(failed(await checkHostPorts({ ...options, workspace: undefined, containers: [container(18080)] })).length, 1);
  assert.equal(failed(await checkHostPorts({ ...options, containers: [container(18080), container(18080, { "com.docker.compose.project": "other" })] })).length, 1);
});

test("Windows workspace identity handles separators, casing, and spaces", async () => {
  const result = await checkHostPorts({ compose: compose([port(18080)]), workspace: "C:\\FRAME Data\\",
    platform: "win32", containers: [container(18080, { "com.docker.compose.project.working_dir": "c:/frame data" })] });
  assert.equal(failed(result).length, 0);
  assert.match(result.checks[0].detail, /Already published/);
});

test("a foreign FRAME project blocks replacement even without overlapping host ports", async () => {
  const record = container(18080);
  record.NetworkSettings.Ports = {};
  const options = { compose: compose([]), containers: [record], platform: "linux" };
  assert.equal(failed(await checkHostPorts({ ...options, workspace: "/another installation" })).length, 1);
  assert.equal(failed(await checkHostPorts({ ...options, workspace: "/frame workspace" })).length, 0);
  record.State.Running = false;
  assert.equal(failed(await checkHostPorts({ ...options, workspace: "/another installation" })).length, 1, "stopped deployments retain ownership");
  assert.equal(failed(await checkHostPorts({ ...options, workspace: "/frame workspace" })).length, 0);
  delete record.Config.Labels["com.docker.compose.project.working_dir"];
  assert.equal(failed(await checkHostPorts({ ...options, workspace: "/frame workspace" })).length, 1, "unknown ownership cannot be adopted");
  assert.equal(failed(await checkHostPorts({ compose: { ...compose([]), name: "overridden-project" } })).length, 1);
});

test("incomplete inspection cannot approve ports", async () => {
  for (const containers of [null, [{}], [{ State: { Running: true }, NetworkSettings: {} }]]) {
    const result = await checkHostPorts({ compose: compose([port(18080)]), containers });
    assert.equal(failed(result).length, 1);
    assert.equal(result.checks[0].label, "Docker port inspection");
  }
});

test("unspecified host address detects IPv6-only listeners", async (t) => {
  const tcp = net.createServer();
  try {
    tcp.listen({ port: 0, host: "::1", ipv6Only: true });
    await once(tcp, "listening");
  } catch (error) {
    if (["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes(error.code)) return t.skip("Host has no IPv6 loopback");
    throw error;
  }
  t.after(() => tcp.close());
  const result = await checkHostPorts({ compose: compose([port(tcp.address().port, { host_ip: "" })]) });
  assert.ok(failed(result).some((c) => c.address === "::"));
});

test("host command resolves active Compose with file values and inspects running and stopped containers", async (t) => {
  const previousPort = process.env.EDGE_HTTP_PORT;
  process.env.EDGE_HTTP_PORT = "19090";
  t.after(() => { if (previousPort === undefined) delete process.env.EDGE_HTTP_PORT; else process.env.EDGE_HTTP_PORT = previousPort; });
  const workspace = await mkdtemp(path.join(os.tmpdir(), "frame preflight "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, ".env"), 'DOCKER_CONTEXT=desktop-linux\nEDGE_HTTP_PORT=18080\nCOMPOSE_PROFILES=photos\n');
  await writeFile(path.join(workspace, "docker-compose.release.json"), '{}');
  const calls = [];
  const record = container(18080, { "com.docker.compose.project.working_dir": workspace });
  const run = async (command, args, options) => {
    assert.equal(command, "docker");
    assert.equal(options.cwd, workspace);
    assert.equal(options.env.EDGE_HTTP_PORT, "18080");
    assert.equal(options.env.COMPOSE_PROFILES, "photos");
    calls.push(args);
    const responses = { context: JSON.stringify([{ Endpoints: { docker: { Host: "unix:///var/run/docker.sock" } } }]),
      info: JSON.stringify({ OSType: "linux", Architecture: "amd64" }),
      compose: JSON.stringify(compose([port(18080)])), ps: "frame-container\nother-container\n", inspect: JSON.stringify([record]) };
    return { stdout: responses[args[0]] };
  };
  assert.equal(failed(await runHostPreflight(workspace, { run })).length, 0);
  const rendering = calls.find((args) => args[0] === "compose" && args.includes("config"));
  assert.ok(rendering.includes(path.join(workspace, "docker-compose.release.json")));
  assert.ok(!rendering.includes("--profile"), "preflight must not activate disabled profiles");
  assert.deepEqual(calls.find((args) => args[0] === "ps"), ["ps", "-a", "-q"]);
  assert.deepEqual(calls.find((args) => args[0] === "inspect"), ["inspect", "frame-container", "other-container"]);
  await assert.rejects(runHostPreflight(workspace, { run: async () => ({ stdout: JSON.stringify([{ Endpoints: { docker: { Host: "ssh://remote" } } }]) }) }), /local Docker/);
  await assert.rejects(runHostPreflight(workspace, { run: async () => { throw new Error("secret output"); } }), (error) => !error.message.includes("secret output"));
  await assert.rejects(runHostPreflight(workspace, { run: async () => ({ stdout: "secret malformed output" }) }), /invalid JSON/);
  await assert.rejects(runHostPreflight("relative"), /absolute/);
});

test("Docker readiness gives specific safe failures without mistaking a missing engine socket for a missing CLI", () => {
  for (const [stage, error, issue] of [
    ["context", Object.assign(new Error("private ENOENT"), { code: "ENOENT", spawned: false }), "docker_cli_missing"],
    ["info", Object.assign(new Error("private missing socket"), { code: "ENOENT" }), "docker_engine_unavailable"],
    ["info", new Error("Cannot connect to the Docker daemon: private missing socket"), "docker_engine_unavailable"],
    ["info", Object.assign(new Error("private socket"), { code: "EACCES" }), "docker_permission_denied"],
    ["info", new Error("permission denied while trying to connect: private"), "docker_permission_denied"],
    ["compose-version", new Error("docker: 'compose' is not a docker command. private"), "docker_compose_missing"],
    ["compose-version", new Error("plugin crashed private"), "docker_compose_unavailable"],
    ["context", new Error("private invalid context"), "docker_unavailable"],
  ]) {
    const failure = dockerReadinessFailure(error, stage);
    assert.equal(failure.launcherIssue, issue);
    assert.ok(!failure.message.includes("private"));
    assert.ok(!failure.message.includes("is stopped"));
  }
});

test("fixed socket support includes Docker Desktop on each OS and standard Linux, rejecting rootless and custom sockets", () => {
  const linux = { OSType: "linux", Architecture: "x86_64", SecurityOptions: ["name=seccomp,profile=builtin"] };
  for (const endpoint of ["unix:///var/run/docker.sock", "unix:///run/docker.sock"]) assert.equal(validateDockerEngine(linux, endpoint), "linux/amd64");
  const desktop = { ...linux, OperatingSystem: "Docker Desktop", Architecture: "aarch64" };
  for (const endpoint of ["unix:///Users/Frame User/.docker/run/docker.sock", "unix:///home/frame/.docker/desktop/docker.sock",
    "npipe:////./pipe/docker_engine", "npipe:////./pipe/dockerDesktopLinuxEngine"]) {
    assert.equal(validateDockerEngine(desktop, endpoint), "linux/arm64");
  }
  for (const [info, endpoint, issue] of [
    [{ ...linux, SecurityOptions: ["name=rootless"] }, "unix:///var/run/docker.sock", "unsupported_rootless"],
    [linux, "unix:///run/user/1000/docker.sock", "unsupported_docker_socket"],
    [linux, "unix:///home/frame/.docker/desktop/docker.sock", "unsupported_docker_socket"],
    [desktop, "unix:///custom/docker.sock", "unsupported_docker_socket"],
    [desktop, "npipe:////./pipe/custom-engine", "unsupported_docker_socket"],
    [desktop, "ssh://remote", "remote_engine"],
  ]) assert.throws(() => validateDockerEngine(info, endpoint), (error) => error.launcherIssue === issue);
});

test("installed settings cannot override any inherited Docker selection, config or TLS variable", async (t) => {
  const settings = { DOCKER_HOST: "tcp://private:2375", DOCKER_CONTEXT: "foreign", DOCKER_TLS_VERIFY: "1", DOCKER_CERT_PATH: "/private-certs",
    DOCKER_CONFIG: "/private-config", DOCKER_DEFAULT_PLATFORM: "linux/arm64", DOCKER_API_VERSION: "0.1", Docker_Host: "mixed-case-private", EDGE_HTTP_PORT: "18080" };
  const inherited = { DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONTEXT: "selected", DOCKER_CONFIG: "/trusted-config", EDGE_HTTP_PORT: "19090" };
  assert.deepEqual(localDockerEnv(settings, inherited), { ...inherited, EDGE_HTTP_PORT: "18080" });
  const saved = Object.fromEntries(Object.keys(settings).filter((key) => /^DOCKER_/i.test(key)).map((key) => [key, process.env[key]]));
  for (const key of Object.keys(saved)) delete process.env[key];
  process.env.DOCKER_HOST = inherited.DOCKER_HOST;
  process.env.DOCKER_CONFIG = inherited.DOCKER_CONFIG;
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const workspace = await mkdtemp(path.join(os.tmpdir(), "frame Docker env "));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, ".env"), Object.entries(settings).map(([key, value]) => `${key}=${value}`).join("\n"));
  const calls = [];
  const result = await runHostPreflight(workspace, { run: async (_command, args, { env }) => {
    calls.push(args);
    assert.equal(env.DOCKER_HOST, inherited.DOCKER_HOST);
    assert.equal(env.DOCKER_CONFIG, inherited.DOCKER_CONFIG);
    assert.equal(env.EDGE_HTTP_PORT, "18080");
    for (const key of Object.keys(settings).filter((key) => /^DOCKER_/i.test(key) && !["DOCKER_HOST", "DOCKER_CONFIG"].includes(key))) assert.equal(env[key], undefined);
    return { stdout: args[0] === "info" ? JSON.stringify({ OSType: "linux", Architecture: "amd64" })
      : args.includes("config") ? JSON.stringify(compose([])) : "" };
  } });
  assert.deepEqual(failed(result), []);
  assert.ok(calls.some((args) => args[0] === "info"));
  assert.ok(calls.some((args) => args[0] === "compose" && args[1] === "version"));
});
