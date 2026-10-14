import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkHostStorage, checkDockerStorage } from "./storage.mjs";
import { fetchStableRelease, isNewerVersion } from "./updates.mjs";
import { snapshotSource, readSourceSnapshot, restoreSource, completeSource } from "./maintenance-source.mjs";
import { buildDiagnostics } from "./diagnostics.mjs";
import { createFullBackup, readFullBackup, restoreFullBackup, FULL_RESTORE_MARKER } from "./full-backup.mjs";

const REPOSITORY = "gall-levi-code/Syronius_FRAME";
const PORTS = {
  edge: ["EDGE_HTTP_PORT", 80], portal: ["PORTAL_PORT", 3730],
  audioMonitor: ["AUDIO_MONITOR_PORT", 3734],
  slsStats: ["SLS_STATS_PORT", 8080], photoFtp: ["PHOTO_FTP_PORT", 2121],
  photoUpload: ["PHOTO_UPLOAD_PORT", 3736], gallery: ["GALLERY_PORT", 3738],
  today: ["TODAY_PORT", 3739], streams: ["STREAMS_PORT", 3732], overlays: ["OVERLAYS_PORT", 3733],
  srtla: ["SRTLA_PORT", 5000], srtPlayer: ["SRT_PLAYER_PORT", 4000], srtSender: ["SRT_SENDER_PORT", 4001],
};
const ADVANCED = new Set(["PUBLIC_RELAY_HOST", "PHOTO_FTP_PASSIVE_HOST", "PHOTO_FTP_MIN_PASSWORD_LENGTH", "PHOTO_FTP_MAX_SESSIONS",
  "PHOTO_FTP_MAX_SESSIONS_PER_IP", "PHOTO_UPLOAD_MAX_FILES", "PHOTO_UPLOAD_MAX_SESSIONS", "PHOTO_ARCHIVE_RETENTION_DAYS"]);
const SECRET_KEYS = ["portalUsername", "portalPassword", "tunnelToken"];
const EXTRACTION_STATE = ["audio-bridge-extraction-complete", "audio-bridge-extraction/legacy.env", "audio-bridge-extraction/stack-config.json"];
const CONFIG_STATE = ["stack-config.json", "effective-public-prefixes.json", "cloudflared-ingress.yml", "public-routes.yml", "cloudflare-tunnel-token"];
const INSTALL_MARKER = ".frame-online-install.json";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const good = (label, detail) => ({ label, detail, status: "good" });
const bad = (label, detail) => ({ label, detail, status: "bad" });
const optional = async (file) => readFile(file, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });
const dashboardUrl = (port) => `http://localhost${Number(port) === 80 ? "" : `:${port}`}/dashboard`;
const imagePlatforms = new Set(["linux/amd64", "linux/arm64"]);
const readinessError = (code, message) => Object.assign(new Error(message), { launcherIssue: code });

export function dockerBindSource(value, platform = process.platform) {
  if (typeof value !== "string") return value;
  if (platform === "win32") return value.replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt|mnt)\/([a-z])(?=\/|$)/i, "$1:");
  if (platform === "darwin") return value.replace(/^\/host_mnt(?=\/)/, "");
  return value;
}

function folder(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value) || /[\r\n\0]/.test(value)) throw new Error(`${label} must be an absolute folder.`);
  const result = path.resolve(value);
  if (result === path.parse(result).root) throw new Error(`${label} must be a dedicated folder, not a filesystem root.`);
  return result;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative || !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

// Arguments go directly to the executable. Never interpolate a command through a shell.
export function runCommand(command, args, { cwd, env = process.env, input, onOutput, timeout = 60_000, platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, detached: platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure;
    const stop = () => {
      if (!child.pid) return;
      if (platform === "win32") {
        const killer = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32/taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        killer.once("error", () => child.kill());
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill(); } }
    };
    const timer = setTimeout(() => { failure = new Error(`${path.basename(command)} timed out. If installation had started, use stack recover before retrying.`); stop(); }, timeout);
    for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (isError) stderr += chunk; else stdout += chunk;
        // Redaction at the caller sees complete lines even when a secret spans OS pipe chunks.
        pending += chunk;
        let end;
        while ((end = pending.indexOf("\n")) !== -1) { onOutput?.(pending.slice(0, end + 1)); pending = pending.slice(end + 1); }
        if (stdout.length + stderr.length > 8 * 1024 * 1024) {
          failure = new Error("Installer command exceeded its output limit."); stop();
        }
      });
      stream.on("end", () => { if (pending) onOutput?.(pending); });
    }
    child.once("error", (error) => { clearTimeout(timer); error.spawned = false; reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(Object.assign(new Error(stderr.trim() || `${path.basename(command)} exited with status ${code}.`), { exitCode: code, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin.on("error", () => {}); // Early validation failures can close stdin before a credential write.
    child.stdin.end(input);
  });
}

async function jsonResponse(url, fetchImpl, limit, missingMessage = "No published FRAME release is available. Publish a release containing frame-images.json, then retry.") {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000), headers: {
    Accept: "application/vnd.github+json", "User-Agent": "FRAME-Setup", "X-GitHub-Api-Version": "2022-11-28",
  } });
  if (response.status === 404) throw new Error(missingMessage);
  if (!response.ok) throw new Error(`FRAME release download failed (HTTP ${response.status}). Check the connection or GitHub rate limit, then retry.`);
  if (!response.body) throw new Error("FRAME release download was empty.");
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error("FRAME release metadata exceeds its size limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function fetchLatestRelease(validateManifest, fetchImpl = fetch, releaseTag, desiredPlatform = "linux/amd64") {
  if (!imagePlatforms.has(desiredPlatform)) throw new Error("FRAME release images support linux/amd64 and linux/arm64 only.");
  const assetName = desiredPlatform === "linux/arm64" ? "frame-images-arm64.json" : "frame-images.json";
  if (releaseTag !== undefined && (typeof releaseTag !== "string" || !releaseTag || /[\r\n\0]/.test(releaseTag))) throw new Error("FRAME release tag must be a nonempty string.");
  const endpoint = releaseTag ? `tags/${encodeURIComponent(releaseTag)}` : "latest";
  const release = await jsonResponse(`https://api.github.com/repos/${REPOSITORY}/releases/${endpoint}`, fetchImpl, 1024 * 1024,
    releaseTag ? `FRAME release "${releaseTag}" is not published or is unavailable. Publish that release with ${assetName}, then retry.`
      : `No published FRAME release is available. Publish a release containing ${assetName}, then retry.`);
  if (releaseTag && (release.tag_name !== releaseTag || release.draft !== false || typeof release.published_at !== "string" || !Number.isFinite(Date.parse(release.published_at)))) {
    throw new Error(`GitHub did not return the requested published FRAME release "${releaseTag}".`);
  }
  const asset = release.assets?.find((entry) => entry.name === assetName);
  if (!asset) throw new Error(`The ${releaseTag ? `FRAME release "${releaseTag}"` : "latest FRAME release"} has no ${assetName} image manifest for ${desiredPlatform}. Publish matching release images; FRAME will not substitute another architecture.`);
  const url = new URL(asset.browser_download_url);
  const downloadPrefix = `/${REPOSITORY}/releases/download/`;
  if (url.origin !== "https://github.com" || !url.pathname.startsWith(downloadPrefix)
    || url.username || url.password || url.search || url.hash) throw new Error("FRAME release asset URL is not an official release download.");
  if (!url.pathname.endsWith(`/${assetName}`)) throw new Error(`The release asset URL does not name ${assetName} for ${desiredPlatform}.`);
  if (releaseTag && decodeURIComponent(url.pathname.slice(downloadPrefix.length, url.pathname.lastIndexOf("/"))) !== releaseTag) {
    throw new Error(`FRAME image manifest does not belong to release "${releaseTag}".`);
  }
  const manifest = validateManifest(await jsonResponse(url.href, fetchImpl, 64 * 1024,
    `The ${desiredPlatform} image manifest${releaseTag ? ` for FRAME release "${releaseTag}"` : ""} is unavailable. Wait for matching release images to finish publishing, then retry.`));
  if (manifest.platform !== desiredPlatform) throw new Error(`The release manifest targets ${manifest.platform}; this Docker engine requires ${desiredPlatform}. FRAME will not use emulation or another architecture.`);
  return manifest;
}

export function validatePlan(value, capabilities) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("An installation plan is required.");
  if (!path.isAbsolute(value.installRoot || "") || /[\r\n\0]/.test(value.installRoot)) throw new Error("Choose an absolute FRAME installation folder.");
  const installRoot = path.resolve(value.installRoot);
  if (installRoot === path.parse(installRoot).root) throw new Error("Choose a dedicated FRAME folder, not a filesystem root.");
  const dataRoot = value.dataRoot === undefined ? undefined : folder(value.dataRoot, "FRAME data location");
  if (dataRoot && inside(dataRoot, installRoot)) throw new Error("FRAME data cannot contain the installation folder.");
  if (!["LAN", "HYBRID"].includes(value.deploymentMode)) throw new Error("Choose LAN or Hybrid deployment.");
  if (!Array.isArray(value.selectedServices) || !value.selectedServices.length
    || value.selectedServices.some((name) => !capabilities.includes(name))) throw new Error("Choose valid FRAME services.");
  for (const [name, folder] of Object.entries(value.subfolders || {})) {
    if (folder !== name) throw new Error("Custom subfolder names are not supported by this installer. Use the standard FRAME data folders.");
  }
  const ports = {};
  for (const [key, [, fallback]] of Object.entries(PORTS)) {
    const number = value.ports?.[key] ?? fallback;
    if (!/^\d+$/.test(String(number)) || +number < 1 || +number > 65535) throw new Error(`${key} must be a port from 1 to 65535.`);
    ports[key] = +number;
  }
  const passive = /^(\d+)-(\d+)$/.exec(value.ports?.photoFtpPassive || "30000-30019");
  if (!passive || +passive[1] < 1 || +passive[2] > 65535 || +passive[2] < +passive[1] || +passive[2] - +passive[1] > 1023) {
    throw new Error("FTP passive ports must be an ascending range of at most 1024 ports within 1–65535.");
  }
  ports.photoFtpPassive = `${+passive[1]}-${+passive[2]}`;
  const advancedSettings = {};
  for (const [key, setting] of Object.entries(value.advancedSettings || {})) {
    if (!ADVANCED.has(key) || typeof setting !== "string" || setting.length > 1024 || /[\r\n\0]/.test(setting)) throw new Error(`Invalid advanced setting: ${key}`);
    advancedSettings[key] = setting;
  }
  const credentials = {};
  for (const key of SECRET_KEYS) {
    const secret = value.credentials?.[key] ?? "";
    if (typeof secret !== "string" || secret.length > 16384 || /[\r\n\0]/.test(secret)) throw new Error(`Invalid credential field: ${key}`);
    credentials[key] = secret;
  }
  const publicHostname = value.publicHostname || "";
  if (typeof publicHostname !== "string" || publicHostname.length > 253 || /[\r\n\0]/.test(publicHostname)) throw new Error("Invalid public hostname.");
  return { mode: ["quick", "guided", "advanced"].includes(value.mode) ? value.mode : "guided", deploymentMode: value.deploymentMode,
    publicHostname, installRoot, ...(dataRoot ? { dataRoot } : {}), subfolders: value.subfolders || {}, selectedServices: [...new Set(value.selectedServices)].sort(),
    ports, autoPorts: false, advancedSettings, credentials };
}

export function installArguments(plan, capabilities, dataRoot) {
  const args = ["install", "--mode", plan.deploymentMode, "--data-root", dataRoot, "--host-data-root", dataRoot,
    "--edge-http-port", String(plan.ports.edge)];
  if (plan.publicHostname) args.push("--public-hostname", plan.publicHostname);
  for (const name of capabilities) args.push(plan.selectedServices.includes(name) ? "--enable" : "--disable", name);
  for (const [key, [env]] of Object.entries(PORTS)) if (key !== "edge") args.push("--set", `${env}=${plan.ports[key]}`);
  const [min, max] = plan.ports.photoFtpPassive.split("-");
  args.push("--set", `PHOTO_FTP_PASSIVE_MIN=${min}`, "--set", `PHOTO_FTP_PASSIVE_MAX=${max}`);
  for (const [key, value] of Object.entries(plan.advancedSettings)) if (value !== "") args.push("--set", `${key}=${value}`);
  return args;
}

async function safePath(target) {
  let current = path.resolve(target);
  while (true) {
    const info = await lstat(current).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error(`FRAME paths cannot use symbolic links or junctions: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function atomicWrite(file, contents) {
  await safePath(file);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, contents, { flag: "wx", mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

async function payloadFiles(directory, relative = "") {
  const result = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected link in FRAME source: ${file}`);
    if (entry.isDirectory()) result.push(...await payloadFiles(directory, file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}

export function createBackend({ emit = () => {}, userData, managedRoot = userData, defaultDataRoot, legacyUserData, resourcesRoot, nodeExecutable = process.execPath,
  run: execute = runCommand, fetchImpl = fetch, releaseTag, launcherVersion = "0.0.0", platform = process.platform, arch = process.arch, homeDirectory = os.homedir(),
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, storageProbe = checkHostStorage, dockerStorageProbe = checkDockerStorage }) {
  let busy = false, prepared = null, modules, cleaned = false, enginePlatform = null, engineInfo = null, updates = null, checkedRelease = null;
  const hostSupported = ["win32", "linux", "darwin"].includes(platform) && ["x64", "arm64"].includes(arch);
  const hostDetail = hostSupported ? `FRAME Launcher supports this ${platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux"} ${arch} host.`
    : `FRAME Launcher supports Windows, macOS and Linux on x64 or ARM64. This host reports ${platform}/${arch}.`;
  const run = (command, args, options = {}) => {
    const env = { ...(options.env || process.env) };
    if (platform === "darwin") {
      // Finder-launched apps do not necessarily inherit the user's shell PATH.
      // Keep this child-only and include Docker Desktop's CLI/credential helpers.
      env.PATH = [...new Set([...(process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin").split(":"),
        path.posix.join(homeDirectory, ".docker/bin"), "/usr/local/bin", "/Applications/Docker.app/Contents/Resources/bin", "/opt/homebrew/bin"].filter(Boolean))].join(":");
    }
    if (enginePlatform) env.DOCKER_DEFAULT_PLATFORM = enginePlatform;
    return execute(command, args, { ...options, env, platform });
  };
  const log = (message) => emit("install-log", String(message));
  const load = async () => modules ??= await Promise.all(["frame-env", "frame-contract", "frame-release", "frame-updater", "frame-preflight"]
    .map((name) => import(pathToFileURL(path.join(resourcesRoot, "installer", `${name}.mjs`)).href)))
    .then(([env, contract, release, updater, preflight]) => ({ ...env, ...contract, ...release, ...updater, ...preflight }));
  const nodeEnv = (workspace, dataRoot) => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1", FRAME_WORKSPACE: workspace,
    FRAME_INSTALLER_DATA_ROOT: dataRoot || "" });
  const runtime = (source, workspace, args, dataRoot, input) => run(nodeExecutable, [path.join(source, "installer/frame-installer.mjs"), ...args], {
    cwd: source, env: nodeEnv(workspace, dataRoot), input, timeout: args[0] === "source-update" ? 10 * 60_000 : 60_000,
  });
  const registryPath = path.join(userData, "installations.json");
  const defaults = { installRoot: folder(path.join(managedRoot, "deployment"), "FRAME installation"),
    dataRoot: folder(defaultDataRoot || path.join(managedRoot, "data"), "FRAME data location") };
  const readRegistry = async () => {
    const entries = [];
    for (const directory of new Set([userData, legacyUserData].filter(Boolean))) {
      const file = path.join(directory, "installations.json");
      await safePath(file);
      let saved;
      try { saved = JSON.parse(await optional(file) || "[]"); }
      catch { throw new Error("FRAME's installation registry could not be read. Restore the registry before changing installations."); }
      if (!Array.isArray(saved)) throw new Error("FRAME's installation registry is invalid.");
      for (const entry of saved) {
        const root = folder(entry?.installRoot, "Saved FRAME installation");
        if (!entries.some((prior) => path.resolve(prior.installRoot) === root)) entries.push({ ...entry, installRoot: root });
      }
    }
    return entries;
  };
  const planPath = (root) => path.join(userData, "plans", `${hash(root)}.json`);
  const redacted = (plan) => { const { credentials, ...rest } = plan; return rest; };

  async function dockerState() {
    enginePlatform = null; engineInfo = null;
    if (!hostSupported) throw readinessError("unsupported_host", hostDetail);
    const m = await load();
    const docker = async (args, stage = args[0]) => {
      try { return await run("docker", args, {}); }
      catch (error) { throw m.dockerReadinessFailure(error, stage); }
    };
    const dockerJson = async (args) => {
      const { stdout } = await docker(args);
      try { return JSON.parse(stdout); }
      catch { throw readinessError("docker_unavailable", "Docker inspection returned invalid data. Check Docker readiness, then recheck."); }
    };
    const endpoint = process.env.DOCKER_CONTEXT
      ? null : process.env.DOCKER_HOST;
    const context = (await dockerJson(["context", "inspect"]))[0];
    const host = endpoint || context?.Endpoints?.docker?.Host || "";
    m.validateDockerEndpoint(host);
    const info = await dockerJson(["info", "--format", "{{json .}}"]);
    enginePlatform = m.validateDockerEngine(info, host);
    await docker(["compose", "version"], "compose-version");
    const ids = (await docker(["ps", "-a", "-q"])).stdout.trim().split(/\s+/).filter(Boolean);
    const containers = [];
    for (let i = 0; i < ids.length; i += 100) containers.push(...await dockerJson(["inspect", ...ids.slice(i, i + 100)]));
    engineInfo = { ...info, endpoint: host };
    return containers;
  }

  function requireMatchingPlatform(manifest) {
    if (!enginePlatform || manifest.platform !== enginePlatform) throw new Error(`This installation targets ${manifest.platform}, but the selected Docker engine requires ${enginePlatform || "a supported Linux platform"}. Use its matching release; FRAME will not switch architectures or use emulation.`);
  }

  async function startupProgress(root, compose) {
    const m = await load(), names = Object.keys(compose.services);
    const placeholders = (status) => names.map((name) => ({ name, status, health: "none" }));
    const expectedServices = (services) => names.map((name) => {
      const matches = services.filter((service) => service.name === name);
      return matches.length === 1 ? matches[0] : { name, status: matches.length ? "ambiguous" : "missing", health: "none" };
    });
    const publish = (phase, services, detail) => emit("launcher-progress", { installRoot: root, phase, services: expectedServices(services),
      ...(detail ? { detail } : {}), observedAt: new Date().toISOString() });
    const observe = async () => {
      // Read only IDs and ownership labels first; never inspect unrelated containers for progress.
      const format = '[{{json .ID}},{{json (.Label "com.docker.compose.project.working_dir")}},{{json (.Label "com.docker.compose.service")}}]';
      const listed = (await run("docker", ["ps", "-a", "--no-trunc", "--filter", "label=com.docker.compose.project=syronius-frame",
        "--filter", "label=com.docker.compose.project.working_dir", "--format", format], { timeout: 5_000 })).stdout;
      const ids = listed.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
        .filter(([id, workspace, name]) => /^[a-f0-9]{12,64}$/.test(id) && m.workspacePath(workspace) === m.workspacePath(root) && names.includes(name))
        .map(([id]) => id);
      const containers = [];
      for (let i = 0; i < ids.length; i += 100) containers.push(...JSON.parse((await run("docker", ["inspect", ...ids.slice(i, i + 100)], { timeout: 5_000 })).stdout));
      const owned = projectContainers(containers).filter((container) => ids.includes(container.Id)
        && m.workspacePath(container.Config?.Labels?.["com.docker.compose.project.working_dir"]) === m.workspacePath(root)
        && names.includes(container.Config?.Labels?.["com.docker.compose.service"]));
      return expectedServices(observedServices(owned));
    };
    let stopped = false, inFlight;
    const poll = () => {
      if (stopped || inFlight) return;
      inFlight = observe().then((services) => { if (!stopped) publish("starting", services); })
        .catch(() => { if (!stopped) publish("starting", placeholders("unknown"), "Waiting for Docker service status."); })
        .finally(() => { inFlight = null; });
    };
    publish("starting", placeholders("waiting"));
    const timer = setIntervalImpl(poll, 1_000);
    poll();
    const stop = async () => { stopped = true; clearIntervalImpl(timer); await inFlight; };
    return { stop, async finish(success, services) {
      await stop();
      if (!services) { try { services = await observe(); } catch { services = placeholders("unknown"); } }
      success = success && servicesReady(expectedServices(services));
      publish(success ? "complete" : "failed", services, success ? "FRAME is running." : "FRAME did not finish starting. Review service status before retrying.");
    } };
  }

  async function composeCommand(workspace, envFile, composeFile, releaseFile, all = false) {
    const m = await load(), env = m.parseEnv(await readFile(envFile, "utf8"));
    const args = ["compose", "--project-name", "syronius-frame", "--project-directory", workspace, "--env-file", envFile, "-f", composeFile];
    if (releaseFile) args.push("-f", releaseFile);
    if (all) args.push("--profile", "*");
    const commandEnv = m.localDockerEnv({ ...env, COMPOSE_PROFILES: env.COMPOSE_PROFILES || "", COMPOSE_FILE: "", COMPOSE_PROJECT_NAME: "syronius-frame" });
    return { args, env: commandEnv };
  }

  async function composeAt(workspace, envFile, composeFile, releaseFile, all = false) {
    const { args, env: commandEnv } = await composeCommand(workspace, envFile, composeFile, releaseFile, all);
    try { return JSON.parse((await run("docker", [...args, "config", "--format", "json"], { env: commandEnv })).stdout); }
    catch { throw new Error("Docker Compose could not resolve the installation configuration. Check the selected settings and Docker Compose installation."); }
  }

  async function installationState(root, { requestedDataRoot, allowPending = false } = {}) {
    const m = await load();
    await safePath(root);
    await safePath(path.join(root, FULL_RESTORE_MARKER));
    if (await lstat(path.join(root, FULL_RESTORE_MARKER)).catch(() => null)) throw new Error("A full FRAME restore was interrupted. Preserve the backup and move the partial restored folders aside before retrying; launcher controls are blocked until restore is complete.");
    if (await lstat(path.join(root, ".git")).catch(() => null)) throw new Error("This is a FRAME source checkout. Keep managing it with stack; launcher controls require a release installation outside the Git checkout.");
    for (const file of [".env", "docker-compose.yml", m.RELEASE_MANIFEST_FILE, m.RELEASE_COMPOSE_FILE, m.SOURCE_COMMIT_FILE, INSTALL_MARKER, `${m.DEPLOYMENT_BACKUP}/snapshot.json`, `${m.DEPLOYMENT_BACKUP}/compose.json`]) await safePath(path.join(root, file));
    const envText = await optional(path.join(root, ".env"));
    const entries = await readdir(root).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const marker = JSON.parse(await optional(path.join(root, INSTALL_MARKER)) || "null");
    if (!envText && entries.length && !(marker?.schema_version === 1 && /^[0-9a-f]{40}$/.test(marker.commit))) {
      throw new Error("Choose an empty installation folder, or an existing FRAME release installation.");
    }
    let snapshot;
    try { snapshot = JSON.parse(await optional(path.join(root, m.DEPLOYMENT_BACKUP, "snapshot.json")) || "null"); }
    catch { throw new Error("The deployment recovery record is invalid. Restore it before changing this installation."); }
    const sourceSnapshot = await readSourceSnapshot({ workspace: root, verifyBytes: false });
    if ((snapshot?.pending || sourceSnapshot?.pending) && !allowPending) throw new Error("This installation has an unfinished deployment. Use Recover before retrying.");
    const env = m.parseEnv(envText || "");
    const dataRoot = envText ? path.resolve(root, env.FRAME_DATA_ROOT || "data")
      : requestedDataRoot || (marker?.dataRoot ? folder(marker.dataRoot, "Recorded FRAME data location") : path.resolve(root) === defaults.installRoot ? defaults.dataRoot : path.join(root, "data"));
    if (envText && requestedDataRoot && m.workspacePath(requestedDataRoot) !== m.workspacePath(dataRoot)) throw new Error("This installation already has a data location. Moving existing FRAME data is not supported; keep its current folder.");
    m.relativeDataRootOrNull(dataRoot);
    if (dataRoot === root || path.relative(dataRoot, root).split(path.sep)[0] !== ".." && !path.isAbsolute(path.relative(dataRoot, root))) {
      throw new Error("FRAME data cannot contain the installation folder.");
    }
    await safePath(dataRoot);
    const existing = Boolean(envText);
    if (existing && !allowPending && !(await lstat(dataRoot).catch(() => null))?.isDirectory()) throw new Error("The existing FRAME data folder is unavailable. Reconnect it before reconfiguring this installation.");
    const manifest = existing || allowPending && snapshot?.pending ? await m.readReleaseManifest(path.join(root, m.RELEASE_MANIFEST_FILE)).catch(() => {
      if (allowPending && sourceSnapshot?.pending && snapshot?.pending) return m.validateReleaseManifest(JSON.parse(snapshot.files[m.RELEASE_MANIFEST_FILE]));
      throw new Error("This folder is not a release-image installation. Keep managing this existing source deployment with stack, and choose an empty folder for the online installer.");
    }) : null;
    if (sourceSnapshot?.pending && m.workspacePath(sourceSnapshot.dataRoot) !== m.workspacePath(dataRoot)) throw new Error("Source recovery refers to another FRAME data folder.");
    if (manifest && (await optional(path.join(root, m.SOURCE_COMMIT_FILE)))?.trim() !== manifest.commit && !(allowPending && sourceSnapshot?.pending)) throw new Error("Installed FRAME source and release images do not match. Restore the intended release with stack update --image-manifest before reconfiguring.");
    const state = {};
    for (const file of [...CONFIG_STATE, ...EXTRACTION_STATE]) {
      await safePath(path.join(dataRoot, "state", file));
      state[file] = await optional(path.join(dataRoot, "state", file));
    }
    if (!existing && !snapshot?.pending && state["stack-config.json"] !== null) throw new Error("This data folder already contains FRAME settings. Manage its existing installation instead of creating a new one over it.");
    const compose = await optional(path.join(root, "docker-compose.yml"));
    const override = await optional(path.join(root, m.RELEASE_COMPOSE_FILE));
    const sourceCommit = await optional(path.join(root, m.SOURCE_COMMIT_FILE));
    const recoveryCompose = await optional(path.join(root, m.DEPLOYMENT_BACKUP, "compose.json"));
    await safePath(path.join(dataRoot, "state/installed-build.json"));
    const installedBuild = await optional(path.join(dataRoot, "state/installed-build.json"));
    let tag = "";
    try { const build = JSON.parse(installedBuild); if (build?.build_id === manifest?.commit && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(build.release_tag || "")) tag = build.release_tag; } catch { /* Older installations may only record a source commit. */ }
    return { existing, envText, dataRoot, manifest, state, snapshot, sourceSnapshot, tag, recoveryCompose,
      fingerprint: hash(JSON.stringify({ envText, dataRoot, state, manifest, compose, override, sourceCommit, snapshot, sourceSnapshot, recoveryCompose, installedBuild })) };
  }

  async function checkStorage(location, label, requiredBytes = 0) {
    await safePath(location);
    return storageProbe(location, label, { platform, run, requiredBytes });
  }

  async function storageReadiness(root, dataRoot, { staging = false, requiredBytes = 0 } = {}) {
    const checks = [await checkStorage(root, "Deployment storage", requiredBytes), await checkStorage(dataRoot, "FRAME data storage")];
    if (staging) checks.push(await checkStorage(userData, "Setup working space"));
    checks.push(await dockerStorageProbe(engineInfo, { platform }));
    return checks;
  }

  function requireStorage(checks) {
    const failures = checks.filter((check) => check.status === "bad");
    if (failures.length) throw new Error(failures.map((check) => `${check.label}: ${check.detail}`).join("\n"));
  }

  async function disposePrepared() {
    const old = prepared; prepared = null;
    if (old?.temporary) await rm(old.temporary, { recursive: true, force: true });
  }

  async function prepare(plan) {
    await disposePrepared();
    const m = await load();
    const containers = await dockerState();
    const ownership = m.checkProjectOwnership({ containers, workspace: plan.installRoot });
    if (ownership.length) throw new Error(ownership.map((check) => check.detail).join(" "));
    const before = await installationState(plan.installRoot, { requestedDataRoot: plan.dataRoot });
    if (before.manifest) requireMatchingPlatform(before.manifest);
    if (plan.selectedServices.includes("frame-photo-ftp")) {
      const ftpHost = plan.advancedSettings.PHOTO_FTP_PASSIVE_HOST || m.parseEnv(before.envText || "").PHOTO_FTP_PASSIVE_HOST || "";
      if (!ftpHost || ftpHost === "localhost" || ftpHost === "0.0.0.0" || ftpHost.startsWith("127.") || ftpHost.includes(":") || !/^[a-zA-Z0-9.-]+$/.test(ftpHost)) {
        throw new Error("Enter the FRAME host's LAN IPv4 address or DNS name for FTP passive connections in Network settings.");
      }
    }
    let storageChecks = await storageReadiness(plan.installRoot, before.dataRoot, { staging: true });
    if (storageChecks.some((check) => check.status === "bad")) return { checks: storageChecks };
    await mkdir(userData, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(path.join(userData, "preflight-"));
    try {
      const manifest = before.manifest || await fetchLatestRelease(m.validateReleaseManifest, fetchImpl, releaseTag, enginePlatform);
      requireMatchingPlatform(manifest);
      let source = plan.installRoot;
      if (!before.existing) {
        // ponytail: stage each check independently; cache verified releases if repeated downloads become costly.
        source = path.join(temporary, "release");
        await mkdir(source);
        await atomicWrite(path.join(source, ".env"), "FRAME_DATA_ROOT=./data\n");
        await atomicWrite(path.join(source, "frame-images.json"), JSON.stringify(manifest));
        log(`Downloading FRAME release source ${manifest.commit.slice(0, 12)}. Application images have not been pulled.`);
        await runtime(resourcesRoot, source, ["source-update", "--image-manifest", "frame-images.json"]);
        for (const wrapper of ["stack.ps1", "stack.sh"]) await rename(path.join(source, "installer", `${wrapper}.next`), path.join(source, "installer", wrapper));
        for (const launcher of ["stack.cmd", "stack.sh"]) await cp(path.join(resourcesRoot, launcher), path.join(source, launcher));
      }
      const runtimeSource = await readFile(path.join(source, "installer/frame-installer.mjs"), "utf8");
      if (!runtimeSource.includes("checkAudioBridgeExtraction")) {
        throw new Error(before.existing
          ? "This FRAME installation predates Audio Bridge extraction. Complete the separate bridge cutover, then bootstrap the updated FRAME source/installer using docs/audio-bridge-extraction.md before reconfiguring this historical release."
          : "This FRAME release still includes the integrated Audio Bridge. Use a release with matching source and images that support standalone Audio Bridge extraction.");
      }
      if (!runtimeSource.includes("process.env.FRAME_WORKSPACE")) {
        throw new Error("This FRAME release predates host installer support. Publish a release that includes FRAME_WORKSPACE support.");
      }
      await checkReleaseHelpers(source);
      const wrapperName = platform === "win32" ? "stack.ps1" : "stack.sh";
      if (!(await readFile(path.join(source, "installer", wrapperName), "utf8")).includes("FRAME_PREFLIGHT_NODE")) {
        throw new Error("This FRAME release predates installer port enforcement. Publish a release containing the host preflight hook.");
      }
      const candidate = path.join(temporary, "candidate"), candidateData = path.join(candidate, "data");
      await mkdir(candidate);
      await cp(path.join(source, "installer"), path.join(candidate, "installer"), { recursive: true });
      if (before.envText) await atomicWrite(path.join(candidate, ".env"), before.envText);
      for (const [file, text] of Object.entries(before.state)) if (text !== null) await atomicWrite(path.join(candidateData, "state", file), text);
      await runtime(source, candidate, installArguments(plan, m.CAPABILITIES, before.dataRoot), candidateData);
      const c = plan.credentials;
      if (c.portalUsername || c.portalPassword) await runtime(source, candidate, ["set-portal-auth"], candidateData, `${c.portalUsername}\n${c.portalPassword}\n`);
      if (c.tunnelToken) await runtime(source, candidate, ["set-tunnel-token"], candidateData, `${c.tunnelToken}\n`);
      await runtime(source, candidate, ["validate", "--for-start"], candidateData);
      const compose = await composeAt(plan.installRoot, path.join(candidate, ".env"), path.join(candidate, "docker-compose.yml"), path.join(source, m.RELEASE_COMPOSE_FILE));
      // A new empty destination must fit the actual staged source, independently of Docker images.
      const emptyDestination = !before.existing && !(await readdir(plan.installRoot).catch((error) => { if (error.code === "ENOENT") return []; throw error; })).length;
      const excluded = new Set([".env", "docker-compose.yml", "frame-images.json", m.RELEASE_MANIFEST_FILE, m.RELEASE_COMPOSE_FILE, m.SOURCE_COMMIT_FILE]);
      const files = before.existing ? [] : (await payloadFiles(source)).filter((file) => !excluded.has(file) && !file.startsWith("data/"));
      let requiredBytes = 0;
      if (emptyDestination) for (const file of files) requiredBytes += (await lstat(path.join(source, file))).size;
      storageChecks = await storageReadiness(plan.installRoot, before.dataRoot, { staging: true, requiredBytes });
      const ports = await m.checkHostPorts({ compose, containers, workspace: plan.installRoot });
      const checks = [good("Docker", `Local ${enginePlatform} engine and Compose are ready.`), ...storageChecks, good("Release", `Pinned ${manifest.platform} release ${manifest.commit.slice(0, 12)}; images download after validation.`), ...ports.checks];
      if (checks.some((check) => check.status === "bad")) { await rm(temporary, { recursive: true, force: true }); return { checks }; }
      // Keep only the validated candidate until Apply; edits require another preflight.
      prepared = { planHash: hash(JSON.stringify(plan)), temporary, candidate, candidateData, source, manifest, before, compose, requiredBytes, files };
      return { checks: [...checks, good("Startup configuration", "Credentials and selected service settings are valid.")] };
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }

  async function apply(plan) {
    const m = await load(), ready = prepared;
    if (!ready || ready.planHash !== hash(JSON.stringify(plan))) throw new Error("Run readiness checks for these settings before installing.");
    if ((await installationState(plan.installRoot, { requestedDataRoot: plan.dataRoot })).fingerprint !== ready.before.fingerprint) throw new Error("The installed configuration changed. Run readiness checks again before applying.");
    const containers = await dockerState();
    requireMatchingPlatform(ready.manifest);
    const fresh = await m.checkHostPorts({ compose: ready.compose, containers, workspace: plan.installRoot });
    if (fresh.checks.some((check) => check.status === "bad")) throw new Error(fresh.checks.filter((c) => c.status === "bad").map((c) => `${c.label}: ${c.detail}`).join("\n"));
    const readinessChecks = await storageReadiness(plan.installRoot, ready.before.dataRoot, { staging: true, requiredBytes: ready.requiredBytes });
    requireStorage(readinessChecks);
    const root = plan.installRoot, dataRoot = ready.before.dataRoot;
    await mkdir(root, { recursive: true });
    const oldCompose = ready.before.existing ? await composeAt(root, path.join(root, ".env"), path.join(root, "docker-compose.yml"), path.join(root, m.RELEASE_COMPOSE_FILE), true) : { name: "syronius-frame", services: {} };
    const images = Object.fromEntries(containers.filter((c) => c.State?.Running && c.Config?.Labels?.["com.docker.compose.project"] === "syronius-frame")
      .map((c) => [c.Config.Labels["com.docker.compose.service"], c.Image]));
    await m.snapshotDeployment({ workspace: root, dataRoot, compose: oldCompose, images });
    let wrapperStarted = false;
    let progress;
    let redact = (text) => text;
    let runWrapper;
    try {
      if (!ready.before.existing) {
        await atomicWrite(path.join(root, INSTALL_MARKER), JSON.stringify({ schema_version: 1, commit: ready.manifest.commit, dataRoot }));
        await m.applyStagedUpdate({ workspace: root, stagedRoot: ready.source, files: ready.files, protectedPaths: [".env", "data", ".git", m.DEPLOYMENT_BACKUP] });
        for (const wrapper of ["stack.ps1", "stack.sh"]) await rename(path.join(root, "installer", `${wrapper}.next`), path.join(root, "installer", wrapper));
        for (const launcher of ["stack.cmd", "stack.sh"]) await atomicWrite(path.join(root, launcher), await readFile(path.join(ready.source, launcher)));
        await m.recordSourceCommit(root, ready.manifest.commit);
        await m.activateRelease(root, ready.manifest);
      }
      for (const name of EXTRACTION_STATE) {
        const contents = await optional(path.join(ready.candidateData, "state", name));
        if (contents === null) continue;
        const destination = path.join(dataRoot, "state", name);
        await safePath(destination);
        await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        try { await writeFile(destination, contents, { flag: "wx", mode: 0o600 }); }
        catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      for (const name of [".env", "docker-compose.yml"]) await atomicWrite(path.join(root, name), await readFile(path.join(ready.candidate, name)));
      for (const name of CONFIG_STATE) await atomicWrite(path.join(dataRoot, "state", name), await readFile(path.join(ready.candidateData, "state", name)));
      const installedPlan = { ...redacted(plan), dataRoot }, file = path.join(dataRoot, "state/frame-install-plan.json");
      await atomicWrite(file, `${JSON.stringify(installedPlan, null, 2)}\n`);
      // Reuse the existing start/recovery lifecycle; the hook checks again before pull and up.
      const installedEnv = m.parseEnv(await readFile(path.join(root, ".env"), "utf8"));
      const env = m.localDockerEnv({ ...installedEnv, COMPOSE_PROFILES: installedEnv.COMPOSE_PROFILES || "", COMPOSE_FILE: "", COMPOSE_PROJECT_NAME: "syronius-frame", FRAME_PREFLIGHT_NODE: nodeExecutable,
        FRAME_PREFLIGHT_SCRIPT: path.join(resourcesRoot, "installer/frame-preflight.mjs"), ELECTRON_RUN_AS_NODE: "1" });
      const secretValues = [...Object.values(plan.credentials), ...Object.entries(installedEnv).filter(([key]) => /PASSWORD|TOKEN|SECRET|KEY/.test(key)).map(([, value]) => value)].filter(Boolean).sort((a, b) => b.length - a.length);
      redact = (text) => secretValues.reduce((out, secret) => out.replaceAll(secret, "[redacted]"), text);
      runWrapper = (action) => platform === "win32"
        ? run(path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "installer/stack.ps1"), action],
          { cwd: root, env, onOutput: (text) => log(redact(text)), timeout: action === "start" ? 30 * 60_000 : 5 * 60_000 })
        : run("/bin/sh", [path.join(root, "stack.sh"), action], { cwd: root, env, onOutput: (text) => log(redact(text)), timeout: action === "start" ? 30 * 60_000 : 5 * 60_000 });
      log("Port validation passed. Pulling release images and starting FRAME.");
      progress = await startupProgress(root, ready.compose);
      wrapperStarted = true;
      await runWrapper("start");
      await progress.stop();
      const finalContainers = await dockerState();
      requireMatchingPlatform(ready.manifest);
      const current = await installationState(root, { allowPending: true });
      const owned = projectContainers(finalContainers);
      if (current.snapshot?.pending || m.workspacePath(current.dataRoot) !== m.workspacePath(dataRoot)
        || m.checkProjectOwnership({ containers: finalContainers, workspace: root }).length
        || owned.some((container) => !Object.hasOwn(ready.compose.services, container.Config?.Labels?.["com.docker.compose.service"]))) {
        throw new Error("FRAME startup could not verify the installed deployment. Review its service status before retrying.");
      }
      await startResources(root, current, ready.compose, owned);
      const finalServices = observedServices(owned);
      if (!servicesReady(finalServices)) throw new Error("FRAME did not reach the expected running service state. Review its service status before retrying.");
      try {
        await atomicWrite(path.join(dataRoot, "state/installed-build.json"), JSON.stringify({ schema_version: 1, build_id: ready.manifest.commit,
          source: `github:${REPOSITORY}@${ready.manifest.commit}`, release_tag: ready.before.tag || (!ready.before.existing ? releaseTag : undefined), installed_at: new Date().toISOString() }));
        await atomicWrite(planPath(root), JSON.stringify(installedPlan));
        const registry = (await readRegistry()).filter((entry) => entry.installRoot !== root);
        registry.push({ installRoot: root, dataRoot, setupMode: plan.mode, canReconfigure: true, dashboardUrl: dashboardUrl(plan.ports.edge), source: "FRAME Launcher", detail: root });
        await atomicWrite(registryPath, JSON.stringify(registry));
      } catch { log("FRAME started successfully, but the launcher could not update its installation registry. The deployment plan remains in the FRAME data folder."); }
      await progress.finish(true, finalServices);
      return { path: file, setupUrl: dashboardUrl(plan.ports.edge), dashboardUrl: dashboardUrl(plan.ports.edge), readinessChecks, logs: ["FRAME release images are running and healthy."] };
    } catch (error) {
      await progress?.stop();
      try {
        if (!wrapperStarted || error.spawned === false) {
          await m.restoreDeployment({ workspace: root, dataRoot });
          await m.completeDeployment(root);
        } else if (JSON.parse(await readFile(path.join(root, m.DEPLOYMENT_BACKUP, "snapshot.json"), "utf8")).pending) {
          // The wrapper normally recovers itself. Cover failures before it reached its recovery block.
          try { await runWrapper("recover"); }
          catch { log("Automatic recovery could not complete. Run stack recover in the installation folder before retrying."); }
        }
      } finally { await progress?.finish(false); }
      throw new Error(redact(error.message));
    } finally { await disposePrepared(); }
  }

  function sanitizeDraft(value, capabilities) {
    if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(value).length > 32 * 1024) throw new Error("Invalid setup draft.");
    const partial = {};
    for (const key of ["mode", "deploymentMode", "publicHostname", "installRoot", "dataRoot", "subfolders", "selectedServices", "ports", "advancedSettings"]) {
      if (Object.hasOwn(value, key)) partial[key] = value[key];
    }
    if (partial.mode !== undefined && !["", "quick", "guided", "advanced"].includes(partial.mode)) throw new Error("Invalid draft setup mode.");
    if (partial.selectedServices !== undefined && (!Array.isArray(partial.selectedServices) || partial.selectedServices.some((name) => !capabilities.includes(name)))) throw new Error("Invalid draft service selection.");
    const checked = validatePlan({ deploymentMode: "LAN", installRoot: defaults.installRoot, ...partial,
      selectedServices: partial.selectedServices?.length ? partial.selectedServices : [capabilities[0]] }, capabilities);
    const draft = Object.fromEntries(Object.keys(partial).map((key) => [key, key === "mode" && partial.mode === "" ? ""
      : key === "selectedServices" && !partial.selectedServices.length ? [] : checked[key]]));
    if (Object.hasOwn(value, "stage")) {
      if (!Number.isInteger(value.stage) || value.stage < 0 || value.stage > 5) throw new Error("Invalid draft setup stage.");
      draft.stage = value.stage;
    }
    return draft;
  }

  const projectContainers = (containers) => containers.filter((container) => container.Config?.Labels?.["com.docker.compose.project"] === "syronius-frame");
  const observedServices = (containers) => containers.map((container) => ({ name: container.Config?.Labels?.["com.docker.compose.service"] || "Unknown service",
    status: container.State?.Status || (container.State?.Running ? "running" : "unknown"), health: container.State?.Running ? container.State?.Health?.Status || "none" : "none" }));
  const servicesReady = (services) => services.length > 0 && services.every((service) => service.status === "running" && ["healthy", "none"].includes(service.health));
  function observedState(services) {
    if (!services.length) return "needs_attention";
    if (services.some((service) => ["unhealthy"].includes(service.health) || ["dead", "removing", "paused", "missing", "unknown"].includes(service.status))) return "needs_attention";
    if (services.some((service) => service.health === "starting" || service.status === "restarting")) return "starting";
    if (servicesReady(services)) return "running";
    if (services.every((service) => ["exited", "created"].includes(service.status))) return "stopped";
    return "needs_attention";
  }

  async function checkRuntime(root, manifest) {
    const m = await load();
    m.validateReleaseManifest(manifest); // Historical integrated-Bridge releases are read-only in the launcher.
    const file = path.join(root, "installer/frame-installer.mjs");
    await safePath(file);
    const source = await optional(file);
    if (!source?.includes("checkAudioBridgeExtraction") || !source.includes("process.env.FRAME_WORKSPACE")) {
      throw new Error("This installation needs the current release helpers before FRAME Launcher can manage it.");
    }
    await checkReleaseHelpers(root);
  }

  async function checkReleaseHelpers(root) {
    if (enginePlatform !== "linux/arm64") return;
    const file = path.join(root, "installer/frame-release.mjs");
    await safePath(file);
    if (!(await optional(file))?.includes("linux/arm64")) throw new Error("This release's source helpers predate ARM64 support. Publish matching ARM64-aware source and images before using this release on an ARM64 engine.");
  }

  async function recoveryReady(root, current) {
    const m = await load(), snapshot = current.snapshot;
    if (!snapshot?.pending && !current.sourceSnapshot?.pending) return false;
    if (![1, 2].includes(snapshot.schema_version) || !snapshot.files || !snapshot.state) throw new Error("The deployment recovery record is invalid.");
    const previous = snapshot.files[m.RELEASE_MANIFEST_FILE];
    if (previous !== null) {
      let manifest;
      try { manifest = m.validateReleaseManifest(JSON.parse(previous)); }
      catch { throw new Error("This recovery record is not a supported FRAME release. Historical Audio Bridge recovery must be completed separately."); }
      if (manifest.commit !== (maintenanceSourceMatches(current) ? current.sourceSnapshot.previousCommit : current.manifest.commit)
        || manifest.platform !== current.manifest.platform) throw new Error("Recovery needs a different source version or image platform. Restore its matching release with stack before using the launcher.");
    }
    const oldEnv = m.parseEnv(snapshot.files[".env"] || "");
    if ((oldEnv.COMPOSE_PROFILES || "").split(",").includes("audio-bridge")) throw new Error("This recovery record includes the retired Audio Bridge. Complete its recovery separately.");
    if (oldEnv.FRAME_DATA_ROOT && m.workspacePath(path.resolve(root, oldEnv.FRAME_DATA_ROOT)) !== m.workspacePath(current.dataRoot)) throw new Error("Recovery refers to a different data folder. Restore it separately before using the launcher.");
    if (snapshot.files[".env"] && !(await lstat(current.dataRoot).catch(() => null))?.isDirectory()) throw new Error("The FRAME data folder is unavailable. Reconnect it before recovering this deployment.");
    if (current.recoveryCompose !== null) {
      let compose;
      try { compose = JSON.parse(current.recoveryCompose); } catch { throw new Error("The deployment recovery configuration is invalid."); }
      const supported = new Set([...m.FRAME_IMAGE_SERVICES, "frame-edge", "frame-docker-proxy", "frame-public-gateway", "frame-tunnel"]);
      if (compose.name !== "syronius-frame" || !compose.services || Object.keys(compose.services).some((name) => !supported.has(name))) throw new Error("The recovery configuration contains unsupported services. Recover it separately before using the launcher.");
    }
    if (snapshot.maintenance) await maintenanceRecoveryRecord(root, current);
    if (current.sourceSnapshot?.pending && !snapshot.maintenance) throw new Error("Source recovery is missing its matching deployment record.");
    return true;
  }

  async function maintenanceStorage(root, current, compose, recovery = false) {
    const m = await load(), supported = [...m.FRAME_IMAGE_SERVICES, "frame-edge", "frame-docker-proxy", "frame-public-gateway", "frame-tunnel"];
    if (compose.name !== "syronius-frame" || !Object.keys(compose.services || {}).length) throw new Error("The installed service configuration is unsupported.");
    if (!(await lstat(current.dataRoot).catch(() => null))?.isDirectory()) throw new Error("The FRAME data folder is unavailable. Reconnect it before maintenance.");
    for (const [name, service] of Object.entries(compose.services)) {
      if (!supported.includes(name) || !(recovery ? /^sha256:[a-f0-9]{64}$/ : /@sha256:[a-f0-9]{64}$/).test(service.image || "")
        || !recovery && m.FRAME_IMAGE_SERVICES.includes(name) && service.image !== current.manifest.images[name]) throw new Error("Maintenance requires the installed release's exact image digests. Restore its configuration before retrying.");
      for (const volume of service.volumes || []) {
        if (volume.type !== "bind" || volume.source === "/var/run/docker.sock") continue;
        const source = folder(volume.source, "Installed storage");
        if (!inside(root, source) && !inside(current.dataRoot, source)) throw new Error("FRAME uses storage outside this installation. Manage it with stack.");
        await safePath(source);
        if (!(await lstat(source).catch(() => null))) throw new Error("Required FRAME storage is unavailable. Restore it before maintenance; empty replacements will not be created.");
      }
    }
  }

  async function startResources(root, current, compose, owned) {
    const m = await load();
    const hostPath = (value) => m.workspacePath(dockerBindSource(value, platform));
    if (!(await lstat(current.dataRoot).catch(() => null))?.isDirectory()) throw new Error("The FRAME data folder is missing or unavailable. Reconnect it before starting; FRAME will not create an empty replacement.");
    for (const [name, service] of Object.entries(compose.services)) {
      const matches = owned.filter((container) => container.Config?.Labels?.["com.docker.compose.service"] === name);
      if (matches.length !== 1) throw new Error(`The installed ${name} container is missing or duplicated. Reconfigure or repair this installation before starting.`);
      const container = matches[0];
      let matchingImage = container.Config.Image === service.image;
      if (!matchingImage && /^sha256:[a-f0-9]{64}$/.test(container.Config.Image || "") && container.Config.Image === container.Image) {
        // Recovery recreates from saved local image IDs. Resolve the release reference locally, without pulling.
        try { matchingImage = (await run("docker", ["image", "inspect", service.image, "--format", "{{.Id}}"], {})).stdout.trim() === container.Image; }
        catch { matchingImage = false; }
      }
      if (!container.Id || !matchingImage) throw new Error(`The installed ${name} image differs from its deployment. Repair this installation before starting.`);
      for (const volume of service.volumes || []) {
        if (volume.type !== "bind") continue;
        const mount = container.Mounts?.find((entry) => entry.Destination === volume.target && entry.Type === "bind");
        if (!mount || hostPath(mount.Source) !== hostPath(volume.source)) throw new Error(`The installed ${name} storage differs from its deployment. Repair this installation before starting.`);
        if (volume.source === "/var/run/docker.sock") continue; // Local engine socket, not a Windows host file.
        const source = folder(volume.source, "Installed storage");
        if (!inside(root, source) && !inside(current.dataRoot, source)) throw new Error(`The installed ${name} uses storage outside this FRAME installation. Manage it with stack.`);
        await safePath(source);
        if (!(await lstat(source).catch(() => null))) throw new Error(`Required storage for ${name} is unavailable. Restore it before starting FRAME.`);
      }
    }
  }

  async function inspectInstallation(root, containers, dockerAvailable, globalIssue, dockerDetail) {
    const m = await load();
    const owned = projectContainers(containers).filter((container) => m.workspacePath(container.Config?.Labels?.["com.docker.compose.project.working_dir"]) === m.workspacePath(root));
    const entry = { installRoot: root, dataRoot: "", dashboardUrl: "", state: dockerAvailable ? observedState(observedServices(owned)) : "docker_unavailable",
      detail: "", version: "", services: observedServices(owned), canStart: false, canStop: false, canRecover: false, canReconfigure: false, canRepair: false, canUpdate: false, canBackup: false, canRemove: false };
    let current;
    try {
      current = await installationState(root, { allowPending: true });
      entry.dataRoot = current.dataRoot;
      const env = m.parseEnv(current.envText || ""), port = env.EDGE_HTTP_PORT || "80";
      if (/^\d+$/.test(port) && +port > 0 && +port <= 65535) entry.dashboardUrl = dashboardUrl(port);
      entry.version = current.tag || current.manifest?.commit || "";
      entry.releaseTag = current.tag; entry.commit = current.manifest?.commit || "";
      if ((!current.existing && !current.snapshot?.pending) || !current.manifest) throw new Error("The deployment is incomplete. Complete setup or restore its configuration before managing it.");
      if (!current.sourceSnapshot?.pending) await checkRuntime(root, current.manifest);
      if (!dockerAvailable) { entry.detail = dockerDetail; return { entry }; }
      requireMatchingPlatform(current.manifest);
      if (globalIssue) throw new Error(globalIssue);
      const ownership = m.checkProjectOwnership({ containers, workspace: root });
      if (ownership.length) throw new Error(ownership.map((check) => check.detail).join(" "));
      const supported = [...m.FRAME_IMAGE_SERVICES, "frame-edge", "frame-docker-proxy", "frame-public-gateway", "frame-tunnel"];
      if (owned.some((container) => !supported.includes(container.Config?.Labels?.["com.docker.compose.service"]))) throw new Error("Docker contains unsupported FRAME services. Resolve the installation mismatch before using launcher controls.");
      const identities = owned.every((container) => /^[a-f0-9]{12,64}$/.test(container.Id || ""))
        && new Set(owned.map((container) => container.Config.Labels["com.docker.compose.service"])).size === owned.length;
      entry.canRemove = Boolean(owned.length && identities);
      entry.canBackup = Boolean(identities && !current.snapshot?.pending && !current.sourceSnapshot?.pending && (await lstat(current.dataRoot).catch(() => null))?.isDirectory());
      entry.canStop = owned.some((container) => container.State?.Running) && owned.every((container) => /^[a-f0-9]{12,64}$/.test(container.Id || ""));
      if (current.snapshot?.pending || current.sourceSnapshot?.pending) {
        entry.canRecover = await recoveryReady(root, current);
        entry.state = "needs_attention";
        entry.detail = "An interrupted deployment needs recovery before setup or routine startup can continue.";
        return { entry, current, owned };
      }
      const compose = await composeAt(root, path.join(root, ".env"), path.join(root, "docker-compose.yml"), path.join(root, m.RELEASE_COMPOSE_FILE));
      const names = Object.keys(compose.services || {});
      if (compose.name !== "syronius-frame" || !names.length || names.some((name) => !supported.includes(name))) throw new Error("The installed service configuration is unsupported. Manage it with stack.");
      if (owned.some((container) => !names.includes(container.Config?.Labels?.["com.docker.compose.service"]))) throw new Error("Docker contains additional FRAME services. Resolve the installation mismatch before using launcher controls.");
      entry.services.push(...names.filter((name) => !entry.services.some((service) => service.name === name)).map((name) => ({ name, status: "missing", health: "none" })));
      entry.state = observedState(entry.services);
      entry.canReconfigure = true;
      try {
        await maintenanceStorage(root, current, compose);
        if (owned.some((container) => !/^[a-f0-9]{12,64}$/.test(container.Id || "") || owned.filter((other) => other.Config?.Labels?.["com.docker.compose.service"] === container.Config?.Labels?.["com.docker.compose.service"]).length !== 1)) throw new Error("Ambiguous FRAME container identity.");
        entry.canRepair = true;
        entry.canUpdate = Boolean(current.tag);
      } catch { /* Routine resume can still work for older installations that need a manual release migration. */ }
      try {
        await startResources(root, current, compose, owned);
        entry.canStart = entry.state === "stopped" || entry.services.some((service) => ["exited", "created"].includes(service.status));
        entry.detail = entry.state === "running" ? "FRAME is running." : entry.state === "stopped" ? "FRAME is installed and stopped."
          : entry.state === "starting" ? "FRAME is starting; waiting for service health." : "Some FRAME services need attention. Review their status before continuing.";
      } catch (error) { entry.state = "needs_attention"; entry.detail = error.message; }
      return { entry, current, compose, owned };
    } catch (error) {
      entry.state = dockerAvailable ? "needs_attention" : "docker_unavailable";
      entry.detail = error instanceof SyntaxError ? "The installed configuration could not be read. Restore it before using launcher controls." : error.message;
      entry.canStart = entry.canStop = entry.canRecover = entry.canReconfigure = entry.canRepair = entry.canUpdate = false;
      return { entry, current, owned };
    }
  }

  async function launcherStatus() {
    const m = await load();
    let containers = [], dockerAvailable = true, detail = "", registry = [], registryIssue = "", dockerIssue = null;
    try { containers = await dockerState(); }
    catch (error) {
      dockerAvailable = false;
      dockerIssue = error.launcherIssue || "docker_unavailable";
      detail = error.launcherIssue ? error.message : "Docker CLI, Docker Compose or the local engine is unavailable. Start Docker Desktop or your local Docker engine and refresh.";
    }
    try { registry = await readRegistry(); } catch (error) { registryIssue = error.message; detail ||= registryIssue; }
    const roots = new Map(registry.map((entry) => [m.workspacePath(entry.installRoot), entry.installRoot]));
    if (await lstat(path.join(defaults.installRoot, ".env")).catch(() => null) || await lstat(path.join(defaults.installRoot, INSTALL_MARKER)).catch(() => null)) roots.set(m.workspacePath(defaults.installRoot), defaults.installRoot);
    let unknownOwner = false;
    for (const container of projectContainers(containers)) {
      const root = container.Config?.Labels?.["com.docker.compose.project.working_dir"];
      if (!m.workspacePath(root)) unknownOwner = true;
      else roots.set(m.workspacePath(root), path.resolve(root));
    }
    const records = [];
    for (const root of roots.values()) records.push(await inspectInstallation(root, containers, dockerAvailable, registryIssue, detail));
    if (unknownOwner) records.push({ entry: { installRoot: "", dataRoot: "", dashboardUrl: "", state: "needs_attention", detail: "FRAME containers have no usable installation owner. Resolve their ownership before creating or changing a deployment.", version: "", services: observedServices(projectContainers(containers)), canStart: false, canStop: false, canRecover: false, canReconfigure: false, canRepair: false, canUpdate: false, canBackup: false, canRemove: false } });
    if (updates) {
      const selected = records.find(({ entry }) => entry.installRoot === updates.installRoot);
      if (selected) updates = updateSummary(checkedRelease, selected.entry, updates.checkedAt);
    }
    return { result: { installations: records.map(({ entry }) => entry), dockerAvailable, detail, observedAt: new Date().toISOString(), defaults,
      platform, arch, hostSupported, hostDetail, enginePlatform, dockerIssue, launcherVersion, updates }, records, containers };
  }

  function updateSummary(release, entry, checkedAt = new Date().toISOString()) {
    const newer = release?.manifest && entry?.releaseTag ? isNewerVersion(release.version, entry.releaseTag) : null;
    const eligible = Boolean(entry?.canUpdate && release?.manifest && newer !== null);
    return { checkedAt, installRoot: entry?.installRoot || "", launcher: { currentVersion: launcherVersion,
      version: release.version, tag: release.tag, available: Boolean(release.launcherAsset && isNewerVersion(release.version, launcherVersion) === true),
      notes: release.notes, url: release.url, downloadUrl: release.launcherAsset?.url || "",
      reason: !release.launcherAsset ? "This release has no launcher package for this operating system and architecture." : "" },
    frame: { currentVersion: entry?.version || "", currentCommit: entry?.commit || "", version: release.version,
      tag: release.tag, commit: release.commit, available: Boolean(eligible && newer),
      notes: release.notes, url: release.url, eligible, reason: !entry ? "Select an installed FRAME deployment to check its update."
        : release.frameError || (!entry.releaseTag ? "This installation's release identity is unknown. Repair remains available; verify its release tag before updating."
          : !entry.canUpdate ? "Resolve this installation's readiness or recovery issue before updating."
          : newer === null ? "The installed and available versions cannot be safely compared." : "") } };
  }

  async function checkUpdates(requestedRoot) {
    const status = await launcherStatus(), m = await load();
    const root = requestedRoot ? folder(requestedRoot, "FRAME installation") : null;
    const selected = root ? status.result.installations.find((entry) => m.workspacePath(entry.installRoot) === m.workspacePath(root))
      : status.result.installations.length === 1 ? status.result.installations[0] : null;
    const release = await fetchStableRelease({ fetchImpl, platform, arch, enginePlatform, validateManifest: m.validateReleaseManifest });
    checkedRelease = release;
    updates = updateSummary(release, selected);
    return updates;
  }

  async function ownedForMaintenance(root, names) {
    const containers = await dockerState(), m = await load();
    const problems = m.checkProjectOwnership({ containers, workspace: root });
    if (problems.length) throw new Error("FRAME ownership changed. Refresh before maintenance.");
    const owned = projectContainers(containers);
    const services = owned.map((container) => container.Config?.Labels?.["com.docker.compose.service"]);
    if (new Set(services).size !== services.length || services.some((name) => !names.includes(name))
      || owned.some((container) => !/^[a-f0-9]{12,64}$/.test(container.Id || ""))) throw new Error("FRAME container identities are missing, duplicated or unexpected. Resolve the mismatch before maintenance.");
    return owned;
  }

  async function stopMaintenanceContainers(root, names) {
    const owned = await ownedForMaintenance(root, names);
    const ids = owned.filter((container) => container.State?.Running).map((container) => container.Id);
    if (ids.length) await run("docker", ["stop", "--time", "30", ...ids], { cwd: root, timeout: 90_000 });
    const stopped = await ownedForMaintenance(root, names);
    if (stopped.some((container) => container.State?.Running) || stopped.length !== owned.length
      || stopped.some((container) => !owned.some((prior) => prior.Id === container.Id))) throw new Error("FRAME could not safely stop its existing containers.");
    return stopped;
  }

  async function maintenanceRecoveryRecord(root, current) {
    const m = await load(), record = current.snapshot?.maintenance;
    const supported = [...m.FRAME_IMAGE_SERVICES, "frame-edge", "frame-docker-proxy", "frame-public-gateway", "frame-tunnel"];
    if (!record || record.schema_version !== 1 || !["update", "repair"].includes(record.action)
      || !record.compose || record.compose.name !== "syronius-frame" || !record.compose.services
      || !Array.isArray(record.running) || !Array.isArray(record.targetServices)
      || record.targetServices.some((name) => !supported.includes(name))
      || record.running.some((name) => !Object.hasOwn(record.compose.services, name))) throw new Error("The maintenance recovery record is invalid.");
    const hasSourceBackup = maintenanceSourceMatches(current);
    if (hasSourceBackup && current.sourceSnapshot.previousCommit !== JSON.parse(current.snapshot.files[m.RELEASE_MANIFEST_FILE]).commit) throw new Error("The maintenance source and deployment backups do not match.");
    if (record.action === "update" && !hasSourceBackup && current.sourceSnapshot?.pending) throw new Error("The maintenance source backup is not the expected release.");
    // Empty original deployments have no container configuration to restore.
    if (Object.keys(record.compose.services).length) await maintenanceStorage(root, current, record.compose, true);
    return { ...record, hasSourceBackup };
  }

  function maintenanceSourceMatches(current) {
    const record = current.snapshot?.maintenance, source = current.sourceSnapshot;
    return Boolean(record?.action === "update" && source && source.targetCommit === record.targetCommit
      && (record.sourceId ? source.id === record.sourceId : source.pending));
  }

  async function restoreMaintenance(root, current) {
    const m = await load();
    await recoveryReady(root, current);
    const record = await maintenanceRecoveryRecord(root, current);
    const originalNames = Object.keys(record.compose.services), names = [...new Set([...originalNames, ...record.targetServices])];
    if (record.hasSourceBackup && (await restoreSource({ workspace: root, validateOnly: true }))?.id !== current.sourceSnapshot.id) throw new Error("The source recovery record changed. Refresh before recovering.");
    requireStorage([await checkStorage(root, "Deployment storage"), await checkStorage(current.dataRoot, "FRAME data storage")]);
    for (const image of new Set(Object.values(record.compose.services).map((service) => service.image))) {
      if ((await run("docker", ["image", "inspect", image, "--format", "{{.Id}}"], {})).stdout.trim() !== image) throw new Error("A saved recovery image is unavailable. Restore it before recovering FRAME.");
    }
    const stopped = await stopMaintenanceContainers(root, names);
    requireMatchingPlatform(current.manifest);
    // Restore source first: old configuration/images must never run against a partial new source tree.
    if (record.hasSourceBackup) await restoreSource({ workspace: root });
    await m.restoreDeployment({ workspace: root, dataRoot: current.dataRoot });
    const restoredManifest = await m.readReleaseManifest(path.join(root, m.RELEASE_MANIFEST_FILE));
    requireMatchingPlatform(restoredManifest);
    if ((await optional(path.join(root, m.SOURCE_COMMIT_FILE)))?.trim() !== restoredManifest.commit) throw new Error("Recovered source does not match the saved release.");
    const added = stopped.filter((container) => !originalNames.includes(container.Config.Labels["com.docker.compose.service"]));
    if (added.length) await run("docker", ["rm", ...added.map((container) => container.Id)], { cwd: root, timeout: 60_000 });
    if (originalNames.length) {
      const file = path.join(root, m.DEPLOYMENT_BACKUP, "maintenance-compose.json");
      await atomicWrite(file, JSON.stringify(record.compose));
      const command = await composeCommand(root, path.join(root, ".env"), file);
      await run("docker", [...command.args, "up", "--no-start", "--no-build", "--pull", "never", "--no-deps", ...originalNames], { cwd: root, env: command.env, timeout: 180_000 });
      if (record.running.length) await run("docker", [...command.args, "start", "--wait", "--wait-timeout", "120", ...record.running], { cwd: root, env: command.env, timeout: 150_000 });
    }
    const final = await ownedForMaintenance(root, originalNames);
    if (final.length !== originalNames.length) throw new Error("Recovery did not restore every original FRAME container.");
    for (const container of final) {
      const name = container.Config.Labels["com.docker.compose.service"];
      if (container.Image !== record.compose.services[name].image || Boolean(container.State?.Running) !== record.running.includes(name)
        || record.running.includes(name) && !servicesReady(observedServices([container]))) throw new Error("Recovery could not verify the previous FRAME service state.");
    }
    await m.completeDeployment(root);
    if (record.hasSourceBackup) await completeSource({ workspace: root });
  }

  async function maintain(action, requestedRoot, requestedTag) {
    const root = folder(requestedRoot, "FRAME installation"), m = await load();
    const status = await launcherStatus(), record = status.records.find(({ entry }) => m.workspacePath(entry.installRoot) === m.workspacePath(root));
    if (!record?.current || !(action === "update" ? record.entry.canUpdate : record.entry.canRepair)) throw new Error(record?.entry.detail || "This installation is not ready for maintenance.");
    const { current, compose } = record;
    let release = null;
    if (action === "update") {
      if (!checkedRelease || updates?.installRoot !== root || !updates.frame.available || requestedTag !== checkedRelease.tag) throw new Error("Check for updates and select the available stable release before updating FRAME.");
      release = await fetchStableRelease({ fetchImpl, platform, arch, enginePlatform, validateManifest: m.validateReleaseManifest });
      if (!release.manifest || release.tag !== requestedTag || hash(JSON.stringify(release.manifest)) !== hash(JSON.stringify(checkedRelease.manifest))) throw new Error("The stable release changed since the update check. Check again before installing it.");
      requireMatchingPlatform(release.manifest);
    }
    await disposePrepared();
    let readinessChecks = await storageReadiness(root, current.dataRoot, { staging: action === "update" });
    requireStorage(readinessChecks);
    await maintenanceStorage(root, current, compose);
    const original = await ownedForMaintenance(root, Object.keys(compose.services));
    requireMatchingPlatform(current.manifest);
    let temporary, source, candidate, candidateData, files, target = compose, targetCurrent = current, snapshotted = false, committed = false, progress;
    try {
      if (release) {
        await mkdir(userData, { recursive: true, mode: 0o700 });
        temporary = await mkdtemp(path.join(userData, "preflight-"));
        source = path.join(temporary, "release");
        await mkdir(source);
        await atomicWrite(path.join(source, ".env"), "FRAME_DATA_ROOT=./data\n");
        await atomicWrite(path.join(source, "frame-images.json"), JSON.stringify(release.manifest));
        log(`Preparing stable FRAME ${release.tag}. The running installation is unchanged.`);
        await runtime(resourcesRoot, source, ["source-update", "--image-manifest", "frame-images.json"]);
        for (const wrapper of ["stack.ps1", "stack.sh"]) await rename(path.join(source, "installer", `${wrapper}.next`), path.join(source, "installer", wrapper));
        await checkRuntime(source, release.manifest);
        candidate = path.join(temporary, "candidate"); candidateData = path.join(candidate, "data");
        await mkdir(candidate);
        await cp(path.join(source, "installer"), path.join(candidate, "installer"), { recursive: true });
        await atomicWrite(path.join(candidate, ".env"), current.envText);
        for (const [name, text] of Object.entries(current.state)) if (text !== null) await atomicWrite(path.join(candidateData, "state", name), text);
        await runtime(source, candidate, ["install", "--data-root", current.dataRoot, "--host-data-root", current.dataRoot], candidateData);
        await runtime(source, candidate, ["validate", "--for-start"], candidateData);
        const candidateEnv = m.parseEnv(await readFile(path.join(candidate, ".env"), "utf8"));
        if (m.workspacePath(path.resolve(root, candidateEnv.FRAME_DATA_ROOT || "data")) !== m.workspacePath(current.dataRoot)) throw new Error("The release would change FRAME's data location.");
        target = await composeAt(root, path.join(candidate, ".env"), path.join(candidate, "docker-compose.yml"), path.join(source, m.RELEASE_COMPOSE_FILE));
        targetCurrent = { ...current, manifest: release.manifest };
        await maintenanceStorage(root, targetCurrent, target);
        const excluded = new Set([".env", "docker-compose.yml", "frame-images.json", "stack.cmd", "stack.sh", INSTALL_MARKER, m.RELEASE_MANIFEST_FILE, m.RELEASE_COMPOSE_FILE, m.SOURCE_COMMIT_FILE]);
        files = (await payloadFiles(source)).filter((file) => !excluded.has(file) && !["data/", `${m.DEPLOYMENT_BACKUP}/`, ".frame-source-backup/"].some((prefix) => file.startsWith(prefix)));
        let bytes = 0;
        for (const file of files) bytes += (await lstat(path.join(source, file))).size;
        readinessChecks = await storageReadiness(root, current.dataRoot, { staging: true, requiredBytes: bytes });
        requireStorage(readinessChecks);
      }
      const names = Object.keys(target.services);
      // Pull immutable references before interrupting any service or changing the installed source.
      for (const image of new Set(Object.values(target.services).map((service) => service.image))) await run("docker", ["pull", image], { cwd: root, timeout: 15 * 60_000 });
      const fresh = await ownedForMaintenance(root, Object.keys(compose.services));
      requireMatchingPlatform(targetCurrent.manifest);
      if (fresh.length !== original.length || fresh.some((container) => !original.some((prior) => prior.Id === container.Id && prior.Image === container.Image && prior.State?.Running === container.State?.Running))
        || (await installationState(root)).fingerprint !== current.fingerprint) throw new Error("FRAME changed while preparing maintenance. Refresh and try again.");
      const ports = await m.checkHostPorts({ compose: target, containers: fresh, workspace: root });
      if (ports.checks.some((check) => check.status === "bad")) throw new Error("Required FRAME ports are unavailable. Resolve the conflict before maintenance.");
      requireStorage(await storageReadiness(root, current.dataRoot));
      const images = Object.fromEntries(fresh.map((container) => [container.Config.Labels["com.docker.compose.service"], container.Image]));
      const running = fresh.filter((container) => container.State?.Running).map((container) => container.Config.Labels["com.docker.compose.service"]);
      const startNames = names.filter((name) => running.includes(name) || running.length && !fresh.some((container) => container.Config.Labels["com.docker.compose.service"] === name));
      await m.snapshotDeployment({ workspace: root, dataRoot: current.dataRoot, compose, images: Object.fromEntries(running.map((name) => [name, images[name]])) });
      snapshotted = true;
      const snapshotPath = path.join(root, m.DEPLOYMENT_BACKUP, "snapshot.json");
      const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
      snapshot.maintenance = { schema_version: 1, action, targetCommit: targetCurrent.manifest.commit, sourceId: null, compose: m.recoveryCompose(compose, images), running, targetServices: names };
      await atomicWrite(snapshotPath, JSON.stringify(snapshot));
      if (release) {
        const sourceBackup = await snapshotSource({ workspace: root, stagedRoot: source, files, dataRoot: current.dataRoot, targetCommit: release.commit });
        snapshot.maintenance.sourceId = sourceBackup.id;
        await atomicWrite(snapshotPath, JSON.stringify(snapshot));
      }
      await stopMaintenanceContainers(root, Object.keys(compose.services));
      if (release) {
        await rm(path.join(root, m.SOURCE_COMMIT_FILE));
        await m.applyStagedUpdate({ workspace: root, stagedRoot: source, files, protectedPaths: [".env", "data", ".git", m.DEPLOYMENT_BACKUP, ".frame-source-backup", m.SOURCE_COMMIT_FILE, m.RELEASE_MANIFEST_FILE, m.RELEASE_COMPOSE_FILE] });
        for (const wrapper of ["stack.ps1", "stack.sh"]) await rename(path.join(root, "installer", `${wrapper}.next`), path.join(root, "installer", wrapper));
        await m.recordSourceCommit(root, release.commit);
        await m.activateRelease(root, release.manifest);
        for (const name of [".env", "docker-compose.yml"]) await atomicWrite(path.join(root, name), await readFile(path.join(candidate, name)));
        for (const name of CONFIG_STATE) await atomicWrite(path.join(current.dataRoot, "state", name), await readFile(path.join(candidateData, "state", name)));
      }
      const command = await composeCommand(root, path.join(root, ".env"), path.join(root, "docker-compose.yml"), path.join(root, m.RELEASE_COMPOSE_FILE));
      if (startNames.length) progress = await startupProgress(root, { services: Object.fromEntries(startNames.map((name) => [name, target.services[name]])) });
      await run("docker", [...command.args, "up", "--no-start", "--no-build", "--pull", "never", "--no-deps", ...names], { cwd: root, env: command.env, timeout: 180_000 });
      // Remove only previously validated, stopped services that this release no longer configures.
      const retired = (await ownedForMaintenance(root, [...new Set([...names, ...Object.keys(compose.services)])])).filter((container) => !names.includes(container.Config.Labels["com.docker.compose.service"]));
      if (retired.some((container) => container.State?.Running)) throw new Error("A retired FRAME service unexpectedly started.");
      if (retired.length) await run("docker", ["rm", ...retired.map((container) => container.Id)], { cwd: root, timeout: 60_000 });
      if (startNames.length) await run("docker", [...command.args, "start", "--wait", "--wait-timeout", "120", ...startNames], { cwd: root, env: command.env, timeout: 150_000 });
      await progress?.stop();
      const final = await ownedForMaintenance(root, names);
      requireMatchingPlatform(targetCurrent.manifest);
      await startResources(root, targetCurrent, target, final);
      if (final.some((container) => Boolean(container.State?.Running) !== startNames.includes(container.Config.Labels["com.docker.compose.service"]))
        || startNames.length && !servicesReady(observedServices(final.filter((container) => startNames.includes(container.Config.Labels["com.docker.compose.service"]))))) throw new Error("FRAME did not reach the intended service state.");
      if (release) await atomicWrite(path.join(current.dataRoot, "state/installed-build.json"), JSON.stringify({ schema_version: 1, build_id: release.commit,
        release_tag: release.tag, source: `github:${REPOSITORY}@${release.commit}`, installed_at: new Date().toISOString() }));
      await m.completeDeployment(root);
      if (release) await completeSource({ workspace: root });
      committed = true;
      await progress?.finish(true, observedServices(final));
      const after = (await launcherStatus()).result;
      after.maintenance = { action, success: true, recovered: false, detail: action === "update" ? `FRAME ${release.tag} is installed. Previous running and stopped service choices were preserved.` : "FRAME was repaired at its installed release. Settings, data and previous running choices were preserved." };
      after.readiness = { installRoot: root, checks: readinessChecks };
      return after;
    } catch {
      await progress?.stop();
      if (committed) {
        // Observation/notification failures after commit cannot authorize a deployment rollback.
        updates = null; checkedRelease = null;
        let after;
        try { after = (await launcherStatus()).result; }
        catch { after = { ...status.result, updates: null, installations: status.result.installations.map((entry) => entry.installRoot !== root ? entry
          : { ...entry, version: release?.tag || entry.version, commit: targetCurrent.manifest.commit, state: "needs_attention", services: [],
            detail: "Maintenance finished, but the final service status could not be read. Refresh FRAME before taking another action.", canStart: false, canStop: false, canRepair: false, canUpdate: false, canRecover: false, canReconfigure: false, canBackup: false, canRemove: false }) }; }
        after.maintenance = { action, success: true, recovered: false, detail: "Maintenance finished. Refresh FRAME to verify its current service status." };
        return after;
      }
      let recovered = false;
      if (snapshotted) {
        try {
          const interrupted = await installationState(root, { allowPending: true });
          if (interrupted.snapshot?.maintenance) await restoreMaintenance(root, interrupted);
          else { // Failure to publish maintenance metadata precedes all source/container changes.
            await m.restoreDeployment({ workspace: root, dataRoot: current.dataRoot });
            await m.completeDeployment(root);
          }
          recovered = true;
        }
        catch { /* Leave both verified backups pending for explicit recovery. */ }
      }
      await progress?.finish(false);
      const after = (await launcherStatus()).result;
      after.maintenance = { action, success: false, recovered, detail: recovered ? "Maintenance failed. The previous source, configuration and container state were restored. Application data was preserved, not rolled back."
        : snapshotted ? "Maintenance failed and recovery is still required. Keep the data folder connected and use Recover before retrying."
          : "Maintenance preparation failed before changing the installation. Check the connection, storage and release readiness, then try again." };
      after.readiness = { installRoot: root, checks: readinessChecks };
      return after;
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => {}); }
  }

  const containerIdentity = (container) => hash(JSON.stringify({ id: container.Id, image: container.Image, config: container.Config, mounts: container.Mounts }));

  async function protectionStatus(protection) {
    try { return { ...(await launcherStatus()).result, protection }; }
    catch { return { installations: [], dockerAvailable: false, defaults, platform, arch, hostSupported, hostDetail, launcherVersion,
      detail: "The operation finished, but FRAME status could not be refreshed. Recheck before taking another action.", observedAt: new Date().toISOString(), protection }; }
  }

  async function resumeBackup(root, current, compose, original) {
    const running = original.filter((container) => container.State?.Running);
    if (!running.length) return false;
    const names = original.map((container) => container.Config.Labels["com.docker.compose.service"]);
    const fresh = await ownedForMaintenance(root, names);
    requireMatchingPlatform(current.manifest);
    if (!compose || fresh.length !== original.length || fresh.some((container) => !original.some((prior) => containerIdentity(prior) === containerIdentity(container)))
      || (await installationState(root)).fingerprint !== current.fingerprint) throw new Error("The installed configuration or containers changed during backup; automatic resume was stopped.");
    const selected = { ...compose, services: Object.fromEntries(running.map((container) => {
      const name = container.Config.Labels["com.docker.compose.service"];
      if (!compose.services[name]) throw new Error("A previous running service no longer has a matching configuration.");
      return [name, compose.services[name]];
    })) };
    await startResources(root, current, selected, fresh);
    requireStorage(await storageReadiness(root, current.dataRoot));
    const m = await load(), ports = await m.checkHostPorts({ compose: selected, containers: fresh, workspace: root });
    if (ports.checks.some((check) => check.status === "bad")) throw new Error("Required FRAME ports are unavailable after backup.");
    const ids = running.map((container) => container.Id);
    const progress = await startupProgress(root, selected);
    let final, success = false;
    try {
      await run("docker", ["start", ...ids], { cwd: root, timeout: 90_000 });
      const deadline = Date.now() + 120_000;
      do {
        const owned = await ownedForMaintenance(root, names);
        if (owned.length !== original.length || owned.some((container) => !original.some((prior) => containerIdentity(prior) === containerIdentity(container)))) throw new Error("FRAME ownership or container configuration changed during resume.");
        final = observedServices(owned.filter((container) => ids.includes(container.Id)));
        if (servicesReady(final)) { success = true; return true; }
        if (final.some((service) => service.health === "unhealthy" || ["exited", "dead", "paused", "removing"].includes(service.status))) throw new Error("A resumed FRAME service needs attention.");
        if (Date.now() >= deadline) throw new Error("FRAME resume did not become ready in time.");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      } while (true);
    } finally { await progress.finish(success, final).catch(() => {}); }
  }

  async function protectInstallation(action, args) {
    if (args.confirmed !== true) throw new Error("Confirm this action and its effect on running FRAME services before continuing.");
    const root = folder(args.installRoot, "FRAME installation"), m = await load(), status = await launcherStatus();
    const record = status.records.find(({ entry }) => m.workspacePath(entry.installRoot) === m.workspacePath(root));
    if (!record?.current || !(action === "backup" ? record.entry.canBackup : record.entry.canRemove)) throw new Error(record?.entry.detail || "This installation is not ready for that action.");
    const { current, compose, owned } = record, names = owned.map((container) => container.Config.Labels["com.docker.compose.service"]);
    const fresh = await ownedForMaintenance(root, names);
    if (fresh.length !== owned.length || fresh.some((container) => !owned.some((prior) => containerIdentity(prior) === containerIdentity(container) && prior.State?.Running === container.State?.Running))
      || (await installationState(root, { allowPending: action === "remove" })).fingerprint !== current.fingerprint) throw new Error("FRAME changed. Refresh before continuing.");
    let backupRoot;
    if (action === "backup") {
      backupRoot = folder(args.backupRoot, "FRAME backup");
      for (const source of [root, current.dataRoot]) if (inside(source, backupRoot) || inside(backupRoot, source)) throw new Error("Choose a backup folder outside the FRAME installation and data folders.");
      await safePath(backupRoot);
      if ((await readdir(backupRoot).catch((error) => { if (error.code === "ENOENT") return []; throw error; })).length) throw new Error("Choose an empty backup folder.");
      requireStorage([await checkStorage(backupRoot, "Backup storage")]);
    }
    await disposePrepared();
    let success = false, resumeFailed = false, resumed = false, stopping = false;
    try {
      stopping = true;
      const stopped = await stopMaintenanceContainers(root, names);
      if ((await installationState(root, { allowPending: action === "remove" })).fingerprint !== current.fingerprint) throw new Error("FRAME configuration changed while stopping.");
      if (action === "backup") {
        log("FRAME is paused while its deployment and data are copied into a verified full backup.");
        await createFullBackup({ workspace: root, dataRoot: current.dataRoot, backupRoot, beforeComplete: async () => {
          const unchanged = await ownedForMaintenance(root, names);
          if (unchanged.length !== fresh.length || unchanged.some((container) => container.State?.Running || !fresh.some((prior) => containerIdentity(prior) === containerIdentity(container)))
            || (await installationState(root)).fingerprint !== current.fingerprint) throw new Error("FRAME changed while its backup was being copied.");
        } });
      } else {
        log("Removing the verified stopped FRAME containers. Installed files, images and data are preserved.");
        if (stopped.length) await run("docker", ["rm", ...stopped.map((container) => container.Id)], { cwd: root, timeout: 90_000 });
        if ((await ownedForMaintenance(root, names)).length) throw new Error("Some FRAME containers could not be removed.");
      }
      success = true;
    } catch { /* Raw command output and application data never become operation messages. */ }
    finally {
      if (action === "backup" && stopping) {
        try { resumed = await resumeBackup(root, current, compose, fresh); }
        catch { resumeFailed = fresh.some((container) => container.State?.Running); }
      }
    }
    return protectionStatus({ action, success: success && !resumeFailed, ...(backupRoot ? { backupRoot, backupComplete: success, resumed } : {}),
      detail: action === "remove" ? success ? "FRAME containers were removed. Release images, installation files and user data remain. Use Repair to recreate containers."
        : "FRAME containers could not all be safely removed. Review their current state before retrying; files and data were preserved."
        : success ? resumeFailed ? "The full backup was verified, but previous running services could not be safely resumed. Review FRAME's current state."
          : resumed ? "The full backup was verified. Previously running services resumed; previously stopped services stayed stopped."
            : "The full backup was verified. FRAME remains stopped."
          : resumeFailed ? "The backup did not complete and previous running services could not be safely resumed. Keep any incomplete backup separate and review FRAME's current state."
            : resumed ? "The backup did not complete. Previously running services resumed. Choose a new empty backup folder before retrying."
              : "The backup did not complete. FRAME remains stopped. Choose a new empty backup folder before retrying." });
  }

  async function inspectBackup(backupRoot) {
    backupRoot = folder(backupRoot, "FRAME backup");
    const backup = await readFullBackup({ backupRoot });
    return { backupRoot, createdAt: backup.createdAt, platform: backup.platform, workspace: backup.workspace, installRoot: backup.workspace,
      dataRoot: backup.dataRoot, sourceCommit: backup.sourceCommit, fileCount: backup.fileCount, totalBytes: backup.totalBytes, verified: true };
  }

  async function restoreBackup(args) {
    if (args.confirmed !== true) throw new Error("Confirm restoration into the original empty FRAME folders before continuing.");
    const backupRoot = folder(args.backupRoot, "FRAME backup"), backup = await readFullBackup({ backupRoot }), m = await load();
    if (backup.platform !== platform) throw new Error("Restore requires the same operating system as this backup.");
    for (const file of [".env", m.RELEASE_MANIFEST_FILE, m.SOURCE_COMMIT_FILE]) if (!backup.entries.some((entry) => entry.scope === "workspace" && entry.path === file && entry.type === "file")) throw new Error("The backup lacks a complete FRAME release identity. Restore its files separately before using launcher controls.");
    const manifest = await m.readReleaseManifest(path.join(backupRoot, "workspace", m.RELEASE_MANIFEST_FILE));
    m.validateReleaseManifest(manifest);
    if (backup.sourceCommit !== manifest.commit) throw new Error("The backed-up source and release images do not match.");
    const env = m.parseEnv(await readFile(path.join(backupRoot, "workspace/.env"), "utf8"));
    if (m.workspacePath(path.resolve(backup.workspace, env.FRAME_DATA_ROOT || "data")) !== m.workspacePath(backup.dataRoot)) throw new Error("The backup configuration refers to a different data folder.");
    const containers = await dockerState();
    requireMatchingPlatform(manifest);
    if (projectContainers(containers).length) throw new Error("Remove all existing FRAME containers before restoring. Restore will not stop or take over another deployment.");
    for (const directory of [backup.workspace, backup.dataRoot]) {
      await safePath(directory);
      if ((await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; })).length) throw new Error("Restore requires empty original installation and data folders. Existing files will not be overwritten.");
    }
    const size = (scope) => backup.entries.filter((entry) => entry.scope === scope && entry.type === "file").reduce((sum, entry) => sum + entry.size, 0);
    requireStorage([await checkStorage(backup.workspace, "Restore deployment storage", size("workspace")), await checkStorage(backup.dataRoot, "Restore data storage", size("data")), await checkStorage(userData, "Launcher registry storage")]);
    await disposePrepared();
    let copied = false, registered = false;
    try {
      if (projectContainers(await dockerState()).length) throw new Error("FRAME containers appeared before restore.");
      requireMatchingPlatform(manifest);
      log("Restoring verified FRAME files and data. Containers will remain absent until an explicit Repair.");
      await restoreFullBackup({ backupRoot, workspace: backup.workspace, dataRoot: backup.dataRoot });
      copied = true;
      const registry = (await readRegistry()).filter((entry) => m.workspacePath(entry.installRoot) !== m.workspacePath(backup.workspace));
      registry.push({ installRoot: backup.workspace, dataRoot: backup.dataRoot, source: "FRAME Launcher" });
      await atomicWrite(registryPath, JSON.stringify(registry)); registered = true;
    } catch { /* A partial restore remains marked and cannot authorize launcher lifecycle actions. */ }
    return protectionStatus({ action: "restore", success: copied && registered, backupRoot, resumed: false,
      detail: copied ? registered ? "Verified FRAME files and data were restored. FRAME has not started. Review readiness and use Repair to recreate its containers."
        : "FRAME files and data were restored, but the launcher registry could not be updated. Preserve the restored folders and resolve launcher storage before continuing."
        : "Restore did not complete. Preserve the verified backup and move any partial restored folders aside before retrying. FRAME was not started." });
  }

  async function lifecycle(action, requestedRoot) {
    const root = folder(requestedRoot, "FRAME installation"), m = await load();
    const snapshot = await launcherStatus();
    const record = snapshot.records.find(({ entry }) => m.workspacePath(entry.installRoot) === m.workspacePath(root));
    if (!record) throw new Error("This FRAME installation was not found. Refresh its status before taking action.");
    const { entry, current, compose, owned } = record;
    const allowed = action === "start" ? entry.canStart : action === "stop" ? entry.canStop : entry.canRecover;
    if (!allowed) throw new Error(entry.detail || "This installation is not ready for that action.");
    if ((await installationState(root, { allowPending: true })).fingerprint !== current.fingerprint) throw new Error("FRAME configuration changed. Refresh before taking action.");
    const freshContainers = await dockerState();
    requireMatchingPlatform(current.manifest);
    const ownership = m.checkProjectOwnership({ containers: freshContainers, workspace: root });
    if (ownership.length) throw new Error(ownership.map((check) => check.detail).join(" "));
    const sameContainers = projectContainers(freshContainers);
    if (sameContainers.length !== owned.length || sameContainers.some((container) => !owned.some((prior) => prior.Id === container.Id))) throw new Error("FRAME containers changed. Refresh before taking action.");
    const readinessChecks = action === "start" ? await storageReadiness(root, current.dataRoot) : [];
    requireStorage(readinessChecks);
    await disposePrepared();
    let failure = false, progress;
    try {
      if (action === "start") {
        progress = await startupProgress(root, compose);
        await startResources(root, current, compose, sameContainers);
        const ports = await m.checkHostPorts({ compose, containers: freshContainers, workspace: root });
        if (ports.checks.some((check) => check.status === "bad")) throw new Error("The required host ports are unavailable. Resolve the conflict before starting FRAME.");
        const command = await composeCommand(root, path.join(root, ".env"), path.join(root, "docker-compose.yml"), path.join(root, m.RELEASE_COMPOSE_FILE));
        log("Starting the installed FRAME containers. No images will be downloaded or rebuilt.");
        await run("docker", [...command.args, "start", "--wait", "--wait-timeout", "120", ...Object.keys(compose.services)], { cwd: root, env: command.env, timeout: 150_000 });
      } else if (action === "stop") {
        log("Stopping FRAME while preserving its containers and data.");
        const ids = sameContainers.filter((container) => container.State?.Running).map((container) => container.Id);
        if (ids.length) await run("docker", ["stop", "--time", "30", ...ids], { cwd: root, timeout: 90_000 });
      } else {
        if (current.snapshot?.maintenance) {
          await restoreMaintenance(root, current);
        } else if (current.recoveryCompose === null) {
          // With no previously running services, recovery only restores saved configuration.
          // Do not ask broken current Compose to stop the containers from the failed attempt.
          const ids = sameContainers.filter((container) => container.State?.Running).map((container) => container.Id);
          if (ids.length) await run("docker", ["stop", "--time", "30", ...ids], { cwd: root, timeout: 90_000 });
          const stopped = await dockerState();
          requireMatchingPlatform(current.manifest);
          if (m.checkProjectOwnership({ containers: stopped, workspace: root }).length || projectContainers(stopped).some((container) => container.State?.Running)
            || projectContainers(stopped).length !== sameContainers.length || projectContainers(stopped).some((container) => !sameContainers.some((prior) => prior.Id === container.Id))) {
            throw new Error("FRAME containers could not be safely stopped before recovery.");
          }
          if ((await installationState(root, { allowPending: true })).fingerprint !== current.fingerprint) throw new Error("Recovery configuration changed. Refresh before retrying.");
          log("Restoring FRAME configuration while keeping its previously stopped services stopped.");
          await m.restoreDeployment({ workspace: root, dataRoot: current.dataRoot });
          await m.completeDeployment(root);
        } else {
          const installedEnv = m.parseEnv(current.envText || "");
          const env = m.localDockerEnv({ ...installedEnv, ELECTRON_RUN_AS_NODE: "1", COMPOSE_PROJECT_NAME: "syronius-frame", COMPOSE_FILE: "", COMPOSE_PROFILES: installedEnv.COMPOSE_PROFILES || "" });
          const wrapper = path.join(root, "installer", platform === "win32" ? "stack.ps1" : "stack.sh");
          await safePath(wrapper);
          if (!(await optional(wrapper))?.includes("deployment-restore")) throw new Error("The installed recovery helper is unsupported.");
          log("Restoring the saved FRAME deployment. Its data will be preserved.");
          if (platform === "win32") await run(path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapper, "recover"], { cwd: root, env, timeout: 5 * 60_000 });
          else await run("/bin/sh", [wrapper, "recover"], { cwd: root, env, timeout: 5 * 60_000 });
        }
      }
    } catch { failure = true; } // Child output can contain secrets; report the subsequent observed state instead.
    finally { await progress?.stop(); }
    let after;
    try { after = (await launcherStatus()).result; }
    catch (error) { await progress?.finish(false); throw error; }
    const changed = after.installations.find((installation) => m.workspacePath(installation.installRoot) === m.workspacePath(root));
    if (failure || !changed || action === "start" && changed.state !== "running" || action === "stop" && changed.services.some((service) => ["running", "restarting", "paused"].includes(service.status)) || action === "recover" && changed.canRecover) {
      after.detail = `FRAME could not complete ${action}. Review the observed service status before retrying.`;
      if (changed) { changed.state = after.dockerAvailable ? "needs_attention" : "docker_unavailable"; changed.detail = `${after.detail} ${changed.detail}`; }
    }
    await progress?.finish(!failure && changed?.state === "running", changed?.services);
    if (action === "start") after.readiness = { installRoot: root, checks: readinessChecks };
    return after;
  }

  return {
    isBusy: () => busy,
    dispose: disposePrepared,
    async invoke(command, args = {}) {
      if (busy) throw new Error("A FRAME installer operation is already running.");
      busy = true;
      try {
        const m = await load();
        if (command === "get_diagnostics") {
          const host = { launcherVersion, platform, arch, osRelease: os.release() };
          try { return buildDiagnostics({ ...host, status: (await launcherStatus()).result, engineInfo }); }
          catch { return buildDiagnostics({ ...host, inspectionFailed: true }); }
        }
        if (command === "inspect_backup") return await inspectBackup(args.backupRoot);
        if (!cleaned) {
          // The app's single-instance lock makes leftover private preparations safe to clean after a crash.
          for (const entry of await readdir(userData, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; })) {
            if (entry.isDirectory() && /^preflight-[A-Za-z0-9]{6}$/.test(entry.name)) {
              const stale = path.join(userData, entry.name);
              await safePath(stale);
              await rm(stale, { recursive: true, force: true });
            }
          }
          cleaned = true;
        }
        if (command === "run_preflight") await disposePrepared();
        if (command === "get_launcher_status") return (await launcherStatus()).result;
        if (command === "locate_installation") {
          const root = folder(args.installRoot, "FRAME installation"), current = await installationState(root, { allowPending: true });
          if (!current.existing || !current.manifest) throw new Error("Choose an existing FRAME release installation folder.");
          await checkRuntime(root, current.manifest);
          const registry = (await readRegistry()).filter((entry) => m.workspacePath(entry.installRoot) !== m.workspacePath(root));
          registry.push({ installRoot: root, dataRoot: current.dataRoot, source: "FRAME Launcher" });
          await atomicWrite(registryPath, JSON.stringify(registry));
          return await protectionStatus({ action: "locate", success: true, detail: "The existing FRAME release installation was added to this launcher. Its files and service state were preserved." });
        }
        if (["backup_stack", "remove_stack"].includes(command)) return await protectInstallation(command === "backup_stack" ? "backup" : "remove", args);
        if (command === "restore_backup") return await restoreBackup(args);
        if (command === "check_updates") return await checkUpdates(args.installRoot);
        if (["update_stack", "repair_stack"].includes(command)) return await maintain(command === "update_stack" ? "update" : "repair", args.installRoot, args.releaseTag);
        if (["start_stack", "stop_stack", "recover_stack"].includes(command)) return await lifecycle(command.replace("_stack", ""), args.installRoot);
        const draftPath = path.join(userData, "setup-draft.json");
        const implemented = m.CAPABILITIES.filter((name) => m.IMPLEMENTED_CAPABILITIES.has(name));
        if (command === "save_draft") {
          const draft = sanitizeDraft(args.draft, implemented);
          await atomicWrite(draftPath, JSON.stringify({ schema_version: 1, draft }, null, 2));
          return { draft };
        }
        if (command === "load_draft") {
          await safePath(draftPath);
          const text = await optional(draftPath);
          if (!text) return { draft: null };
          let saved;
          try { saved = JSON.parse(text); } catch { throw new Error("The saved setup draft could not be read. Discard it to begin again."); }
          if (saved.schema_version !== 1) throw new Error("The saved setup draft is unsupported. Discard it to begin again.");
          return { draft: sanitizeDraft(saved.draft, implemented) };
        }
        if (command === "clear_draft") {
          await safePath(draftPath);
          await rm(draftPath, { force: true });
          return { draft: null };
        }
        if (command === "detect_host") {
          const status = (await launcherStatus()).result;
          const checks = [status.hostSupported ? good("Host platform", status.hostDetail) : bad("Host platform", status.hostDetail)];
          if (status.hostSupported) checks.push(...(status.dockerAvailable ? [good("Docker CLI", "Docker is available."), good("Docker engine", `Local ${status.enginePlatform} engine is ready.`), good("Docker Compose", "Compose is available.")]
            : [bad(status.dockerIssue === "docker_unavailable" ? "Docker readiness" : "Docker engine", status.detail)]));
          return { checks, detectedInstallations: status.installations, defaults, previewMode: false,
            platform, arch, hostSupported, hostDetail, enginePlatform: status.enginePlatform, dockerIssue: status.dockerIssue, detail: status.detail };
        }
        if (command === "load_install_plan") {
          const root = folder(args.installRoot, "FRAME installation");
          const current = await installationState(root);
          const savedPaths = [path.join(current.dataRoot, "state/frame-install-plan.json"), planPath(root),
            ...(legacyUserData ? [path.join(legacyUserData, "plans", `${hash(root)}.json`)] : [])];
          let text;
          for (const file of savedPaths) { await safePath(file); text = await optional(file); if (text) break; }
          if (!text) throw new Error("No saved installer plan was found for this folder.");
          // Load historical plans without offering the retired service on the next apply.
          const plan = validatePlan({ ...JSON.parse(text), installRoot: root, dataRoot: current.dataRoot }, [...m.CAPABILITIES, "frame-discord-audio-bridge"]);
          plan.selectedServices = plan.selectedServices.filter((name) => name !== "frame-discord-audio-bridge");
          return redacted(plan);
        }
        const request = args.request || args.plan;
        if (!request || typeof request !== "object") throw new Error("An installation plan is required.");
        const plan = validatePlan({ ...request, installRoot: request.installRoot || defaults.installRoot }, implemented);
        const capabilities = Object.fromEntries(m.CAPABILITIES.map((name) => [name, plan.selectedServices.includes(name)]));
        const warnings = m.enforceDependencies(capabilities);
        if (warnings.length) throw new Error(`The service selection has missing dependencies: ${warnings.join(" ")}`);
        if (command === "run_preflight") {
          try { return { ...await prepare(plan), detectedInstallations: await readRegistry() }; }
          catch (error) { await disposePrepared(); return { checks: [bad("Readiness", error.message)], detectedInstallations: await readRegistry() }; }
        }
        if (command === "save_install_plan") {
          await atomicWrite(planPath(plan.installRoot), JSON.stringify(redacted(plan), null, 2));
          return { path: planPath(plan.installRoot) };
        }
        if (command === "apply_install_plan") return await apply(plan);
        throw new Error("Unsupported installer command.");
      } finally { busy = false; }
    },
  };
}
