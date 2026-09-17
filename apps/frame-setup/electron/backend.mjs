import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPOSITORY = "gall-levi-code/Syronius_FRAME";
const PORTS = {
  edge: ["EDGE_HTTP_PORT", 80], portal: ["PORTAL_PORT", 3730],
  audioBridge: ["AUDIO_BRIDGE_PORT", 3729], audioMonitor: ["AUDIO_MONITOR_PORT", 3734],
  slsStats: ["SLS_STATS_PORT", 8080], photoFtp: ["PHOTO_FTP_PORT", 2121],
  photoUpload: ["PHOTO_UPLOAD_PORT", 3736], gallery: ["GALLERY_PORT", 3738],
  today: ["TODAY_PORT", 3739], streams: ["STREAMS_PORT", 3732], overlays: ["OVERLAYS_PORT", 3733],
  srtla: ["SRTLA_PORT", 5000], srtPlayer: ["SRT_PLAYER_PORT", 4000], srtSender: ["SRT_SENDER_PORT", 4001],
};
const ADVANCED = new Set(["PUBLIC_RELAY_HOST", "PHOTO_FTP_PASSIVE_HOST", "PHOTO_FTP_MIN_PASSWORD_LENGTH", "PHOTO_FTP_MAX_SESSIONS",
  "PHOTO_FTP_MAX_SESSIONS_PER_IP", "PHOTO_UPLOAD_MAX_FILES", "PHOTO_UPLOAD_MAX_SESSIONS", "PHOTO_ARCHIVE_RETENTION_DAYS"]);
const SECRET_KEYS = ["portalUsername", "portalPassword", "discordClientId", "discordToken", "tunnelToken"];
const CONFIG_STATE = ["stack-config.json", "effective-public-prefixes.json", "cloudflared-ingress.yml", "public-routes.yml", "cloudflare-tunnel-token"];
const INSTALL_MARKER = ".frame-online-install.json";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const good = (label, detail) => ({ label, detail, status: "good" });
const bad = (label, detail) => ({ label, detail, status: "bad" });
const optional = async (file) => readFile(file, "utf8").catch((error) => { if (error.code === "ENOENT") return null; throw error; });

// Arguments go directly to the executable. Never interpolate a command through a shell.
export function runCommand(command, args, { cwd, env = process.env, input, onOutput, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", failure;
    const stop = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
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
      else if (code !== 0) reject(new Error(stderr.trim() || `${path.basename(command)} exited with status ${code}.`));
      else resolve({ stdout, stderr });
    });
    child.stdin.on("error", () => {}); // Early validation failures can close stdin before a credential write.
    child.stdin.end(input);
  });
}

async function jsonResponse(url, fetchImpl, limit) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000), headers: {
    Accept: "application/vnd.github+json", "User-Agent": "FRAME-Setup", "X-GitHub-Api-Version": "2022-11-28",
  } });
  if (response.status === 404) throw new Error("No published FRAME release is available. Publish a release containing frame-images.json, then retry.");
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

export async function fetchLatestRelease(validateManifest, fetchImpl = fetch) {
  const release = await jsonResponse(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, fetchImpl, 1024 * 1024);
  const asset = release.assets?.find((entry) => entry.name === "frame-images.json");
  if (!asset) throw new Error("The latest FRAME release has no frame-images.json image manifest. Publish the release images before using the online installer.");
  const url = new URL(asset.browser_download_url);
  if (url.origin !== "https://github.com" || !url.pathname.startsWith(`/${REPOSITORY}/releases/download/`)
    || url.username || url.password || url.search || url.hash) throw new Error("FRAME release asset URL is not an official release download.");
  return validateManifest(await jsonResponse(url.href, fetchImpl, 64 * 1024));
}

export function validatePlan(value, capabilities) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("An installation plan is required.");
  if (!path.isAbsolute(value.installRoot || "") || /[\r\n\0]/.test(value.installRoot)) throw new Error("Choose an absolute FRAME installation folder.");
  const installRoot = path.resolve(value.installRoot);
  if (installRoot === path.parse(installRoot).root) throw new Error("Choose a dedicated FRAME folder, not a filesystem root.");
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
    publicHostname, installRoot, subfolders: value.subfolders || {}, selectedServices: [...new Set(value.selectedServices)].sort(),
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

export function createBackend({ emit = () => {}, userData, resourcesRoot, nodeExecutable = process.execPath, run = runCommand, fetchImpl = fetch }) {
  let busy = false, prepared = null, modules, cleaned = false;
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
  const readRegistry = async () => JSON.parse(await optional(registryPath) || "[]");
  const planPath = (root) => path.join(userData, "plans", `${hash(root)}.json`);
  const redacted = (plan) => { const { credentials, ...rest } = plan; return rest; };

  async function dockerState() {
    if (!["win32", "linux"].includes(process.platform)) throw new Error("FRAME Setup supports Windows and Linux.");
    const endpoint = process.env.DOCKER_CONTEXT
      ? null : process.env.DOCKER_HOST;
    const context = JSON.parse((await run("docker", ["context", "inspect"], {})).stdout)[0];
    const host = endpoint || context?.Endpoints?.docker?.Host || "";
    if (!(host.startsWith("unix:///") || /^npipe:\/{2,}\.\/pipe\//.test(host))) {
      throw new Error("Select a local Docker context. Host port checks cannot validate a remote Docker engine.");
    }
    const info = JSON.parse((await run("docker", ["info", "--format", "{{json .}}"], {})).stdout);
    if (info.OSType !== "linux" || !["x86_64", "amd64"].includes(info.Architecture)) throw new Error("This FRAME release requires a local Linux AMD64 Docker engine. On Windows, switch Docker Desktop to Linux containers.");
    await run("docker", ["compose", "version"], {});
    const ids = (await run("docker", ["ps", "-q"], {})).stdout.trim().split(/\s+/).filter(Boolean);
    const containers = [];
    for (let i = 0; i < ids.length; i += 100) containers.push(...JSON.parse((await run("docker", ["inspect", ...ids.slice(i, i + 100)], {})).stdout));
    return containers;
  }

  async function composeAt(workspace, envFile, composeFile, releaseFile, all = false) {
    const m = await load(), env = m.parseEnv(await readFile(envFile, "utf8"));
    const args = ["compose", "--project-name", "syronius-frame", "--project-directory", workspace, "--env-file", envFile, "-f", composeFile];
    if (releaseFile) args.push("-f", releaseFile);
    if (all) args.push("--profile", "*");
    const commandEnv = { ...process.env, ...env, COMPOSE_PROFILES: env.COMPOSE_PROFILES || "", COMPOSE_FILE: "", COMPOSE_PROJECT_NAME: "syronius-frame" };
    try { return JSON.parse((await run("docker", [...args, "config", "--format", "json"], { env: commandEnv })).stdout); }
    catch { throw new Error("Docker Compose could not resolve the installation configuration. Check the selected settings and Docker Compose installation."); }
  }

  async function installationState(root) {
    const m = await load();
    await safePath(root);
    if (await lstat(path.join(root, ".git")).catch(() => null)) throw new Error("Choose a deployment folder outside the FRAME Git checkout.");
    for (const file of [".env", "docker-compose.yml", m.RELEASE_MANIFEST_FILE, m.RELEASE_COMPOSE_FILE, m.SOURCE_COMMIT_FILE, INSTALL_MARKER, `${m.DEPLOYMENT_BACKUP}/snapshot.json`]) await safePath(path.join(root, file));
    const envText = await optional(path.join(root, ".env"));
    const entries = await readdir(root).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const marker = JSON.parse(await optional(path.join(root, INSTALL_MARKER)) || "null");
    if (!envText && entries.length && !(marker?.schema_version === 1 && /^[0-9a-f]{40}$/.test(marker.commit))) {
      throw new Error("Choose an empty installation folder, or an existing FRAME release installation.");
    }
    const snapshot = JSON.parse(await optional(path.join(root, m.DEPLOYMENT_BACKUP, "snapshot.json")) || "null");
    if (snapshot?.pending) throw new Error("This installation has an unfinished deployment. Run stack recover in its folder before retrying.");
    const env = m.parseEnv(envText || "");
    const dataRoot = path.resolve(root, env.FRAME_DATA_ROOT || "data");
    m.relativeDataRootOrNull(dataRoot);
    if (dataRoot === root || path.relative(dataRoot, root).split(path.sep)[0] !== ".." && !path.isAbsolute(path.relative(dataRoot, root))) {
      throw new Error("FRAME data cannot contain the installation folder.");
    }
    await safePath(dataRoot);
    const existing = Boolean(envText);
    const manifest = existing ? await m.readReleaseManifest(path.join(root, m.RELEASE_MANIFEST_FILE)).catch(() => {
      throw new Error("This folder is not a release-image installation. Keep managing this existing source deployment with stack, and choose an empty folder for the online installer.");
    }) : null;
    if (manifest && (await optional(path.join(root, m.SOURCE_COMMIT_FILE)))?.trim() !== manifest.commit) throw new Error("Installed FRAME source and release images do not match. Restore the intended release with stack update --image-manifest before reconfiguring.");
    const state = {};
    for (const file of CONFIG_STATE) {
      await safePath(path.join(dataRoot, "state", file));
      state[file] = await optional(path.join(dataRoot, "state", file));
    }
    const compose = await optional(path.join(root, "docker-compose.yml"));
    const override = await optional(path.join(root, m.RELEASE_COMPOSE_FILE));
    const sourceCommit = await optional(path.join(root, m.SOURCE_COMMIT_FILE));
    return { existing, envText, dataRoot, manifest, state, fingerprint: hash(JSON.stringify({ envText, state, manifest, compose, override, sourceCommit })) };
  }

  async function disposePrepared() {
    const old = prepared; prepared = null;
    if (old?.temporary) await rm(old.temporary, { recursive: true, force: true });
  }

  async function prepare(plan) {
    await disposePrepared();
    const m = await load();
    const containers = await dockerState();
    const before = await installationState(plan.installRoot);
    if (plan.selectedServices.includes("frame-photo-ftp")) {
      const ftpHost = plan.advancedSettings.PHOTO_FTP_PASSIVE_HOST || m.parseEnv(before.envText || "").PHOTO_FTP_PASSIVE_HOST || "";
      if (!ftpHost || ftpHost === "localhost" || ftpHost === "0.0.0.0" || ftpHost.startsWith("127.") || ftpHost.includes(":") || !/^[a-zA-Z0-9.-]+$/.test(ftpHost)) {
        throw new Error("Enter the FRAME host's LAN IPv4 address or DNS name for FTP passive connections in Network settings.");
      }
    }
    let storageParent = plan.installRoot;
    while (!(await lstat(storageParent).catch((error) => { if (error.code === "ENOENT") return null; throw error; }))) storageParent = path.dirname(storageParent);
    const probeFile = path.join(storageParent, `.frame-write-check-${randomUUID()}`);
    try { await writeFile(probeFile, "", { flag: "wx", mode: 0o600 }); } finally { await rm(probeFile, { force: true }); }
    const disk = await statfs(storageParent);
    await mkdir(userData, { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(path.join(userData, "preflight-"));
    try {
      const manifest = before.manifest || await fetchLatestRelease(m.validateReleaseManifest, fetchImpl);
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
      if (!(await readFile(path.join(source, "installer/frame-installer.mjs"), "utf8")).includes("process.env.FRAME_WORKSPACE")) {
        throw new Error("This FRAME release predates host installer support. Publish a release that includes FRAME_WORKSPACE support.");
      }
      const wrapperName = process.platform === "win32" ? "stack.ps1" : "stack.sh";
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
      if (c.discordClientId || c.discordToken) await runtime(source, candidate, ["set-discord-auth"], candidateData, `${c.discordClientId}\n${c.discordToken}\n`);
      if (c.tunnelToken) await runtime(source, candidate, ["set-tunnel-token"], candidateData, `${c.tunnelToken}\n`);
      await runtime(source, candidate, ["validate", "--for-start"], candidateData);
      const compose = await composeAt(plan.installRoot, path.join(candidate, ".env"), path.join(candidate, "docker-compose.yml"), path.join(source, m.RELEASE_COMPOSE_FILE));
      const ports = await m.checkHostPorts({ compose, containers, workspace: plan.installRoot });
      const checks = [good("Docker", "Local Linux AMD64 engine and Compose are ready."), good("Storage", `Folder is writable; ${(disk.bavail * disk.bsize / 1024 ** 3).toFixed(1)} GiB available on its volume. Docker image storage is managed separately.`), good("Release", `Pinned release ${manifest.commit.slice(0, 12)}; images download after validation.`), ...ports.checks];
      if (checks.some((check) => check.status === "bad")) { await rm(temporary, { recursive: true, force: true }); return { checks }; }
      // Keep only the validated candidate until Apply; edits require another preflight.
      prepared = { planHash: hash(JSON.stringify(plan)), temporary, candidate, candidateData, source, manifest, before, compose };
      return { checks: [...checks, good("Startup configuration", "Credentials and selected service settings are valid.")] };
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
  }

  async function apply(plan) {
    const m = await load(), ready = prepared;
    if (!ready || ready.planHash !== hash(JSON.stringify(plan))) throw new Error("Run readiness checks for these settings before installing.");
    if ((await installationState(plan.installRoot)).fingerprint !== ready.before.fingerprint) throw new Error("The installed configuration changed. Run readiness checks again before applying.");
    const containers = await dockerState();
    const fresh = await m.checkHostPorts({ compose: ready.compose, containers, workspace: plan.installRoot });
    if (fresh.checks.some((check) => check.status === "bad")) throw new Error(fresh.checks.filter((c) => c.status === "bad").map((c) => `${c.label}: ${c.detail}`).join("\n"));
    const root = plan.installRoot, dataRoot = ready.before.dataRoot;
    await mkdir(root, { recursive: true });
    const oldCompose = ready.before.existing ? await composeAt(root, path.join(root, ".env"), path.join(root, "docker-compose.yml"), path.join(root, m.RELEASE_COMPOSE_FILE), true) : { name: "syronius-frame", services: {} };
    const images = Object.fromEntries(containers.filter((c) => c.Config?.Labels?.["com.docker.compose.project"] === "syronius-frame")
      .map((c) => [c.Config.Labels["com.docker.compose.service"], c.Image]));
    await m.snapshotDeployment({ workspace: root, dataRoot, compose: oldCompose, images });
    let wrapperStarted = false;
    let redact = (text) => text;
    let runWrapper;
    try {
      if (!ready.before.existing) {
        await atomicWrite(path.join(root, INSTALL_MARKER), JSON.stringify({ schema_version: 1, commit: ready.manifest.commit }));
        const excluded = new Set([".env", "docker-compose.yml", "frame-images.json", m.RELEASE_MANIFEST_FILE, m.RELEASE_COMPOSE_FILE, m.SOURCE_COMMIT_FILE]);
        const files = (await payloadFiles(ready.source)).filter((file) => !excluded.has(file) && !file.startsWith("data/"));
        await m.applyStagedUpdate({ workspace: root, stagedRoot: ready.source, files, protectedPaths: [".env", "data", ".git", m.DEPLOYMENT_BACKUP] });
        for (const wrapper of ["stack.ps1", "stack.sh"]) await rename(path.join(root, "installer", `${wrapper}.next`), path.join(root, "installer", wrapper));
        for (const launcher of ["stack.cmd", "stack.sh"]) await atomicWrite(path.join(root, launcher), await readFile(path.join(ready.source, launcher)));
        await m.recordSourceCommit(root, ready.manifest.commit);
        await m.activateRelease(root, ready.manifest);
      }
      for (const name of [".env", "docker-compose.yml"]) await atomicWrite(path.join(root, name), await readFile(path.join(ready.candidate, name)));
      for (const name of CONFIG_STATE) await atomicWrite(path.join(dataRoot, "state", name), await readFile(path.join(ready.candidateData, "state", name)));
      const installedPlan = redacted(plan), file = path.join(dataRoot, "state/frame-install-plan.json");
      await atomicWrite(file, `${JSON.stringify(installedPlan, null, 2)}\n`);
      // Reuse the existing start/recovery/discovery lifecycle; the hook checks again before pull and up.
      const installedEnv = m.parseEnv(await readFile(path.join(root, ".env"), "utf8"));
      const env = { ...process.env, ...installedEnv, COMPOSE_PROFILES: installedEnv.COMPOSE_PROFILES || "", COMPOSE_FILE: "", COMPOSE_PROJECT_NAME: "syronius-frame", FRAME_PREFLIGHT_NODE: nodeExecutable,
        FRAME_PREFLIGHT_SCRIPT: path.join(resourcesRoot, "installer/frame-preflight.mjs"), ELECTRON_RUN_AS_NODE: "1" };
      const secretValues = [...Object.values(plan.credentials), ...Object.entries(installedEnv).filter(([key]) => /PASSWORD|TOKEN|SECRET|KEY/.test(key)).map(([, value]) => value)].filter(Boolean).sort((a, b) => b.length - a.length);
      redact = (text) => secretValues.reduce((out, secret) => out.replaceAll(secret, "[redacted]"), text);
      runWrapper = (action) => process.platform === "win32"
        ? run(path.join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "installer/stack.ps1"), action],
          { cwd: root, env, onOutput: (text) => log(redact(text)), timeout: action === "start" ? 30 * 60_000 : 5 * 60_000 })
        : run("/bin/sh", [path.join(root, "stack.sh"), action], { cwd: root, env, onOutput: (text) => log(redact(text)), timeout: action === "start" ? 30 * 60_000 : 5 * 60_000 });
      log("Port validation passed. Pulling release images and starting FRAME.");
      wrapperStarted = true;
      await runWrapper("start");
      try {
        await atomicWrite(path.join(dataRoot, "state/installed-build.json"), JSON.stringify({ schema_version: 1, build_id: ready.manifest.commit,
          source: `github:${REPOSITORY}@${ready.manifest.commit}`, installed_at: new Date().toISOString() }));
        await atomicWrite(planPath(root), JSON.stringify(installedPlan));
        const registry = (await readRegistry()).filter((entry) => entry.installRoot !== root);
        registry.push({ installRoot: root, setupMode: plan.mode, canReconfigure: true, setupUrl: `http://localhost:${plan.ports.edge}/setup`, source: "FRAME Setup", detail: root });
        await atomicWrite(registryPath, JSON.stringify(registry));
      } catch { log("FRAME started successfully, but the launcher could not update its installation registry. The deployment plan remains in the FRAME data folder."); }
      return { path: file, setupUrl: `http://localhost:${plan.ports.edge}/setup`, logs: ["FRAME release images are running and healthy."] };
    } catch (error) {
      if (!wrapperStarted || error.spawned === false) {
        await m.restoreDeployment({ workspace: root, dataRoot });
        await m.completeDeployment(root);
      } else if (JSON.parse(await readFile(path.join(root, m.DEPLOYMENT_BACKUP, "snapshot.json"), "utf8")).pending) {
        // The wrapper normally recovers itself. Cover failures before it reached its recovery block.
        try { await runWrapper("recover"); }
        catch { log("Automatic recovery could not complete. Run stack recover in the installation folder before retrying."); }
      }
      throw new Error(redact(error.message));
    } finally { await disposePrepared(); }
  }

  return {
    isBusy: () => busy,
    dispose: disposePrepared,
    async invoke(command, args = {}) {
      if (busy) throw new Error("A FRAME installer operation is already running.");
      busy = true;
      try {
        const m = await load();
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
        if (command === "detect_host") {
          let checks;
          try { await dockerState(); checks = [good("Docker CLI", "Docker is available."), good("Docker engine", "Local Linux AMD64 engine is ready."), good("Docker Compose", "Compose is available.")]; }
          catch (error) { checks = [bad("Docker readiness", error.message)]; }
          return { checks, detectedInstallations: await readRegistry(), previewMode: false };
        }
        if (command === "load_install_plan") {
          const root = path.resolve(args.installRoot || "");
          const current = await installationState(root);
          const text = await optional(path.join(current.dataRoot, "state/frame-install-plan.json")) || await optional(planPath(root));
          if (!text) throw new Error("No saved installer plan was found for this folder.");
          return redacted(validatePlan({ ...JSON.parse(text), installRoot: root }, m.CAPABILITIES));
        }
        const plan = validatePlan(args.request || args.plan, m.CAPABILITIES.filter((name) => m.IMPLEMENTED_CAPABILITIES.has(name)));
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
