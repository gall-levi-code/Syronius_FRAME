import net from "node:net";
import dgram from "node:dgram";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parseEnv } from "./frame-env.mjs";

// Consume resolved, active Compose services; never interpret or execute .env here.
const MAX_BINDINGS = 4096;
const bad = (label, detail, binding = {}) => ({ ...binding, label, status: "bad", detail });
const label = (b) => `${b.service}: ${b.protocol.toUpperCase()} ${b.address || "all addresses"}:${b.hostPort}`;

export function localDockerEnv(settings, inherited = process.env) {
  const env = { ...inherited, ...settings };
  // Installed settings cannot select another daemon, context, CLI config or TLS identity.
  for (const key of Object.keys(env)) if (/^DOCKER_/i.test(key)) delete env[key];
  for (const [key, value] of Object.entries(inherited)) if (/^DOCKER_/i.test(key)) env[key] = value;
  return env;
}

const readinessError = (code, message) => Object.assign(new Error(message), { launcherIssue: code });

export function dockerReadinessFailure(error, stage) {
  const detail = `${error?.stderr || ""}\n${error?.message || ""}`;
  if (["EACCES", "EPERM"].includes(error?.code) || /permission denied|access (?:is )?denied|operation not permitted/i.test(detail)) {
    return readinessError("docker_permission_denied", "Permission to run Docker or access its local engine was denied. Check Docker access for this user, then recheck.");
  }
  if (error?.code === "ENOENT" && (stage === "context" || error.spawned === false || /spawn/i.test(error.syscall || ""))) {
    return readinessError("docker_cli_missing", "The Docker command-line tool was not found. Install Docker Desktop or Docker Engine with its CLI, then reopen FRAME Launcher.");
  }
  if (stage === "compose-version") {
    const missing = /['"]?compose['"]? (?:is not a docker command|is not a docker subcommand)|unknown command[^\r\n]*\bcompose\b|docker-compose[^\r\n]*(?:no such file|not found)/i.test(detail);
    return readinessError(missing ? "docker_compose_missing" : "docker_compose_unavailable",
      missing ? "Docker Compose v2 was not found. Install the Docker Compose plugin or repair Docker Desktop, then recheck."
        : "Docker Compose v2 could not run. Check or repair the Compose plugin or Docker Desktop, then recheck.");
  }
  if (["info", "ps", "inspect"].includes(stage)) {
    return readinessError("docker_engine_unavailable", "The local Docker engine could not be reached or inspected. Open Docker Desktop or start Docker Engine, then recheck. If it is already running, check its selected context and access permissions.");
  }
  return readinessError("docker_unavailable", stage === "context"
    ? "Docker's selected context could not be read. Check the Docker CLI and selected context, then recheck."
    : "Docker could not inspect the installation configuration. Check Docker readiness and the selected settings, then recheck.");
}

export function validateDockerEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !(endpoint.startsWith("unix:///") || /^npipe:\/{2,}\.\/pipe\//i.test(endpoint))) {
    throw readinessError("remote_engine", "Select a local Docker context. FRAME cannot validate host storage or ports on a remote Docker engine.");
  }
}

export function validateDockerEngine(info, endpoint) {
  validateDockerEndpoint(endpoint);
  if (info?.OSType !== "linux") throw readinessError("unsupported_engine_os", "FRAME requires a Linux Docker engine. On Windows, switch Docker Desktop to Linux containers.");
  const arch = { x86_64: "amd64", amd64: "amd64", aarch64: "arm64", arm64: "arm64" }[info.Architecture];
  if (!arch) throw readinessError("unsupported_engine_architecture", "This Docker engine architecture is unsupported. FRAME requires native AMD64 or ARM64 Linux images; emulation is not used.");
  if (info.SecurityOptions?.some((option) => /^(?:name=)?rootless(?:,|$)/.test(option))) {
    throw readinessError("unsupported_rootless", "Rootless Docker is not supported by this FRAME deployment. Its management service requires the standard Docker engine socket. Select Docker Desktop or the standard local Docker Engine.");
  }
  const standard = /^unix:\/\/(?:\/var)?\/run\/docker\.sock$/.test(endpoint);
  // Desktop's user-facing socket forwards into its VM; the proxy mounts the VM's standard socket.
  const desktopSocket = /^unix:\/\/\/[^\r\n]+\/\.docker\/(?:run|desktop)\/docker\.sock$/.test(endpoint)
    || /^npipe:\/{2,}\.\/pipe\/(?:docker_engine|dockerDesktopLinuxEngine)$/i.test(endpoint);
  if (!standard && !(info.OperatingSystem === "Docker Desktop" && desktopSocket)) {
    throw readinessError("unsupported_docker_socket", "This Docker socket configuration is not supported by FRAME's fixed /var/run/docker.sock mount. Select standard local Docker Engine or Docker Desktop; FRAME will not redirect the mount to a custom socket.");
  }
  return `linux/${arch}`;
}

function address(value = "") {
  if (typeof value !== "string") throw new Error("Host address must be an IP address.");
  if (!value) return "";
  const family = net.isIP(value);
  if (!family) throw new Error(`Invalid host IP address: ${value}`);
  if (family === 4) return value;
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // IPv4-mapped addresses share their IPv4 endpoint, including wildcard bindings.
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
  if (mapped) return [parseInt(mapped[1], 16) >> 8, parseInt(mapped[1], 16) & 255,
    parseInt(mapped[2], 16) >> 8, parseInt(mapped[2], 16) & 255].join(".");
  return canonical;
}

function overlaps(a, b) {
  if (!a || !b || a === b) return true;
  if (net.isIP(a) !== net.isIP(b)) return false;
  return a === "0.0.0.0" || b === "0.0.0.0" || a === "::" || b === "::";
}

function portRange(value) {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("A fixed published and target port is required.");
  const match = /^(\d+)(?:-(\d+))?$/.exec(String(value));
  if (!match) throw new Error(`Invalid port or range: ${value}`);
  const first = Number(match[1]), last = Number(match[2] || match[1]);
  if (first < 1 || last > 65535 || last < first || last - first >= MAX_BINDINGS) {
    throw new Error(`Port range must be within 1–65535 and contain at most ${MAX_BINDINGS} ports.`);
  }
  return { first, count: last - first + 1 };
}

export function validateBindings(compose) {
  const bindings = [], checks = [], byPort = new Map();
  if (!compose?.services || typeof compose.services !== "object" || Array.isArray(compose.services)
    || !Object.keys(compose.services).length) {
    return { bindings, checks: [bad("Port configuration", "Resolved Compose services are missing.")] };
  }
  for (const [service, config] of Object.entries(compose.services)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      checks.push(bad(service, "Invalid resolved service configuration."));
      continue;
    }
    if (config.network_mode === "host") {
      checks.push(bad(service, "Host networking cannot be validated from published ports. Use explicit port mappings."));
      continue;
    }
    if (config.ports === undefined) continue;
    if (!Array.isArray(config.ports)) {
      checks.push(bad(service, "Resolved ports must be an array."));
      continue;
    }
    for (const mapping of config.ports) {
      try {
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
          throw new Error("Use canonical long-syntax ports from docker compose config --format json.");
        }
        const protocol = mapping.protocol || "tcp";
        if (!["tcp", "udp"].includes(protocol)) throw new Error(`Unsupported port protocol: ${protocol}`);
        const host = portRange(mapping.published), target = portRange(mapping.target);
        if (host.count !== target.count) throw new Error("Dynamic or unequal port ranges cannot be validated; use equal fixed ranges.");
        if (bindings.length + host.count > MAX_BINDINGS) throw new Error(`At most ${MAX_BINDINGS} host bindings can be validated.`);
        const hostAddress = address(mapping.host_ip);
        for (let offset = 0; offset < host.count; offset++) {
          const binding = { service, protocol, address: hostAddress, hostPort: host.first + offset, containerPort: target.first + offset };
          const key = `${protocol}:${binding.hostPort}`, previous = byPort.get(key) || [];
          const conflict = previous.find((other) => overlaps(other.address, binding.address));
          if (conflict) checks.push(bad(label(binding), `Conflicts with ${label(conflict)} in this installation. Change one host port.`, binding));
          previous.push(binding);
          byPort.set(key, previous);
          bindings.push(binding);
        }
      } catch (error) {
        checks.push(bad(`${service}: port configuration`, error.message));
      }
    }
  }
  return { bindings, checks };
}

export function workspacePath(value, platform = process.platform) {
  if (typeof value !== "string" || !value) return null;
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(value)) return null;
  const normalized = paths.normalize(value).replace(/[\\/]+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function checkProjectOwnership({ containers, workspace, platform = process.platform }) {
  if (!Array.isArray(containers)) return [bad("Docker project", "Docker container inspection is unavailable.")];
  const owner = workspacePath(workspace, platform);
  for (const container of containers) {
    const labels = container.Config?.Labels || {};
    if (labels["com.docker.compose.project"] === "syronius-frame"
      && (!owner || workspacePath(labels["com.docker.compose.project.working_dir"], platform) !== owner)) {
      return [bad("Docker project", "Another FRAME installation uses this Docker project, including when stopped. Select its installation folder before reconfiguring or starting FRAME.")];
    }
  }
  return [];
}

function containerBindings(containers) {
  if (!Array.isArray(containers)) throw new Error("Docker container inspection is unavailable.");
  const result = [];
  for (const container of containers) {
    if (container?.State?.Running === false) continue;
    if (container?.State?.Running !== true || !container.NetworkSettings?.Ports) {
      throw new Error("A running container's published ports could not be inspected.");
    }
    for (const [target, publications] of Object.entries(container.NetworkSettings.Ports)) {
      if (publications === null) continue; // Exposed internally, not published on the host.
      const match = /^(\d+)\/(tcp|udp|sctp)$/.exec(target);
      if (!match || !Array.isArray(publications)) throw new Error("Docker returned an invalid published port mapping.");
      for (const publication of publications) {
        const host = portRange(publication.HostPort), destination = portRange(match[1]);
        if (host.count !== 1) throw new Error("Docker returned an unresolved published port range.");
        result.push({ container, protocol: match[2], address: address(publication.HostIp), hostPort: host.first, containerPort: destination.first });
      }
    }
  }
  return result;
}

function owned(publication, binding, compose, workspace, platform) {
  const labels = publication.container.Config?.Labels || {};
  return Boolean(workspace && compose.name && labels["com.docker.compose.project"] === compose.name
    && labels["com.docker.compose.service"] === binding.service
    && workspacePath(labels["com.docker.compose.project.working_dir"], platform) === workspace
    && publication.address === binding.address && publication.containerPort === binding.containerPort);
}

function probe(binding) {
  return new Promise((resolve) => {
    const ipv6 = net.isIP(binding.address) === 6;
    const socket = binding.protocol === "tcp" ? net.createServer()
      : dgram.createSocket({ type: ipv6 ? "udp6" : "udp4", reuseAddr: false, ipv6Only: ipv6 });
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.close(() => resolve(error)); } catch { resolve(error); }
    };
    const timer = setTimeout(() => finish({ code: "ETIMEDOUT" }), 3000);
    socket.once("error", finish);
    socket.once("listening", () => finish(null));
    try {
      if (binding.protocol === "tcp") socket.listen({ host: binding.address, port: binding.hostPort, exclusive: true, ipv6Only: ipv6 });
      else socket.bind({ address: binding.address, port: binding.hostPort, exclusive: true });
    } catch (error) { finish(error); }
  });
}

async function probeInterfaces(binding) {
  const hosts = new Set([binding.address]);
  if (["0.0.0.0", "::"].includes(binding.address)) {
    // Windows can allow a wildcard bind alongside a specific-address listener.
    // Test the actual interfaces too, rather than approving that false positive.
    for (const info of Object.values(os.networkInterfaces()).flat()) {
      if (net.isIP(info.address) === net.isIP(binding.address)) {
        hosts.add(info.scopeid ? `${info.address}%${info.scopeid}` : info.address);
      }
    }
  }
  for (const host of hosts) {
    const error = await probe({ ...binding, address: host });
    if (error) return error;
  }
  return null;
}

// Call on the Docker host, after verifying a local context and inspecting all
// running and stopped containers. Results are observations, not a reservation: recheck at start.
export async function checkHostPorts({ compose, containers = [], workspace, platform = process.platform }) {
  const { bindings, checks } = validateBindings(compose);
  if (checks.some((check) => check.status === "bad")) return { bindings, checks };
  if (compose.name !== "syronius-frame") {
    return { bindings, checks: [bad("Docker project", "The resolved Docker project must be syronius-frame. Remove any conflicting project-name override.")] };
  }
  let publications;
  try { publications = containerBindings(containers); }
  catch (error) { return { bindings, checks: [bad("Docker port inspection", error.message)] }; }
  const normalizedWorkspace = workspacePath(workspace, platform);
  // Stopped and internal-only containers still own the deployment identity.
  const ownership = checkProjectOwnership({ containers, workspace, platform });
  if (ownership.length) return { bindings, checks: ownership };
  for (const planned of bindings) {
    // Unspecified Compose host IP publishes on all host interfaces. Probe IPv6
    // separately so a v6-only listener is not hidden by a successful IPv4 bind.
    for (const host of planned.address ? [planned.address] : ["0.0.0.0", "::"]) {
      const binding = { ...planned, address: host }, title = label(binding);
      const matches = publications.filter((p) => p.protocol === binding.protocol && p.hostPort === binding.hostPort && overlaps(p.address, host));
      const foreign = matches.filter((p) => !owned(p, binding, compose, normalizedWorkspace, platform));
      if (foreign.length) {
        const names = [...new Set(foreign.map((p) => (p.container.Name || p.container.Id || "unknown container").replace(/^\//, "")))];
        checks.push(bad(title, `Published by Docker container ${names.join(", ")}. Stop the conflicting container or change this host port, then retry.`, binding));
      } else if (matches.length) {
        checks.push({ ...binding, label: title, status: "good", detail: "Already published by this FRAME installation with the same service and mapping." });
      } else {
        const error = await probeInterfaces(binding);
        if (!error) checks.push({ ...binding, label: title, status: "good", detail: "Host port is available." });
        else if (!planned.address && host === "::" && ["EAFNOSUPPORT", "EPROTONOSUPPORT"].includes(error.code)) {
          checks.push({ ...binding, label: title, status: "warn", detail: "IPv6 is unavailable on this host; IPv4 was checked separately." });
        } else {
          const reason = error.code === "EADDRINUSE" ? "Port is occupied by a host process. Stop it or change this host port, then retry."
            : error.code === "EACCES" ? "Cannot validate this binding: permission denied or port reserved by the OS. Check host permissions/reservations and retry."
            : `Cannot validate this binding (${error.code || "unknown socket error"}). Correct the host address or networking issue and retry.`;
          checks.push(bad(title, reason, binding));
        }
      }
    }
  }
  return { bindings, checks };
}

// Electron supplies its bundled Node runtime to the shell launchers. Ordinary
// CLI users do not need host Node unless they opt into this host preflight hook.
export async function runHostPreflight(workspace, { run = promisify(execFile) } = {}) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) throw new Error("Preflight requires an absolute installation directory.");
  const env = localDockerEnv(parseEnv(await readFile(path.join(workspace, ".env"), "utf8")));
  const docker = async (args, stage = args[0]) => {
    try {
      return (await run("docker", args, { cwd: workspace, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout.trim();
    } catch (error) {
      throw dockerReadinessFailure(error, stage);
    }
  };
  const dockerJson = async (args) => {
    const text = await docker(args);
    try { return JSON.parse(text); }
    catch { throw new Error(`Docker ${args[0]} inspection returned invalid JSON.`); }
  };
  let endpoint = env.DOCKER_HOST;
  if (!endpoint || env.DOCKER_CONTEXT) {
    const contexts = await dockerJson(["context", "inspect"]);
    endpoint = contexts[0]?.Endpoints?.docker?.Host;
  }
  validateDockerEndpoint(endpoint);
  validateDockerEngine(await dockerJson(["info", "--format", "{{json .}}"]), endpoint);
  await docker(["compose", "version"], "compose-version");
  const args = ["compose", "--project-directory", workspace, "--env-file", path.join(workspace, ".env"), "-f", path.join(workspace, "docker-compose.yml")];
  const release = path.join(workspace, "docker-compose.release.json");
  try {
    if ((await stat(release)).isFile()) args.push("-f", release);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const compose = await dockerJson([...args, "config", "--format", "json"]);
  const ids = (await docker(["ps", "-a", "-q"])).split(/\s+/).filter(Boolean);
  const containers = ids.length ? await dockerJson(["inspect", ...ids]) : [];
  return checkHostPorts({ compose, containers, workspace });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { checks } = await runHostPreflight(process.argv[2]);
    for (const check of checks) console.log(`[${check.status.toUpperCase()}] ${check.label}: ${check.detail}`);
    if (checks.some((check) => check.status === "bad")) {
      console.error("FRAME preflight failed. Correct these issues before retrying installation.");
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`FRAME preflight could not complete: ${error.message}`);
    process.exitCode = 1;
  }
}
