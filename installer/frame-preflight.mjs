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

function workspacePath(value, platform) {
  if (typeof value !== "string" || !value) return null;
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(value)) return null;
  const normalized = paths.normalize(value).replace(/[\\/]+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
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
// running containers. Results are observations, not a reservation: recheck at start.
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
  // Compose can replace services and remove orphans without overlapping ports.
  // Protect the entire project identity, including internal-only services.
  for (const container of containers) {
    const labels = container.Config?.Labels || {};
    if (container.State?.Running && labels["com.docker.compose.project"] === compose.name
      && (!normalizedWorkspace || workspacePath(labels["com.docker.compose.project.working_dir"], platform) !== normalizedWorkspace)) {
      return { bindings, checks: [bad("Docker project", "Another FRAME installation uses this Docker project. Select its installation folder before reconfiguring or starting FRAME.")] };
    }
  }
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
  const env = { ...process.env, ...parseEnv(await readFile(path.join(workspace, ".env"), "utf8")) };
  const docker = async (args) => {
    try {
      return (await run("docker", args, { cwd: workspace, env, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout.trim();
    } catch {
      // Compose output can contain credentials; never forward an error's captured output.
      throw new Error(`Docker ${args[0]} inspection failed. Check Docker availability and the installation configuration.`);
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
  if (!/^unix:\/\//.test(endpoint || "") && !/^npipe:\/\/+\.\/pipe\//i.test(endpoint || "")) {
    throw new Error("Host port checks require a local Docker socket or named-pipe context. Select a local Docker context and retry.");
  }
  const args = ["compose", "--project-directory", workspace, "--env-file", path.join(workspace, ".env"), "-f", path.join(workspace, "docker-compose.yml")];
  const release = path.join(workspace, "docker-compose.release.json");
  try {
    if ((await stat(release)).isFile()) args.push("-f", release);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const compose = await dockerJson([...args, "config", "--format", "json"]);
  const ids = (await docker(["ps", "-q"])).split(/\s+/).filter(Boolean);
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
