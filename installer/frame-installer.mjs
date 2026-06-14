import { randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  CAPABILITIES,
  IMPLEMENTED_CAPABILITIES,
  ROUTES,
  PUBLIC_PREFIXES,
  computeComposeProfiles,
  computeEffectivePublicPrefixes,
  enforceDependencies,
} from "./frame-contract.mjs";

const WORKSPACE = "/workspace";
const ENV_PATH = path.join(WORKSPACE, ".env");
const COMPOSE_PATH = path.join(WORKSPACE, "docker-compose.yml");
const COMPOSE_TEMPLATE_PATH = path.join(WORKSPACE, "installer/templates/docker-compose.yml");
const TUNNEL_TOKEN_FILE = "state/cloudflare-tunnel-token";
const TUNNEL_TOKEN_PLACEHOLDER = "paste_cloudflare_tunnel_token_here";

const PLACEHOLDERS = new Set([
  "",
  "your_bot_token_here",
  "your_discord_application_client_id_here",
  "replace_with_a_long_random_value",
]);

const IMPORTABLE_ENV_KEYS = new Set([
  "DISCORD_TOKEN",
  "DISCORD_CLIENT_ID",
  "PUBLIC_BASE_URL",
  "SESSION_SECRET",
  "DEFAULT_AUDIO_DELAY_MS",
  "MAX_AUDIO_DELAY_MS",
  "SESSION_IDLE_TIMEOUT_MINUTES",
  "READONLY_OBS_TOKEN",
  "TIMEZONE",
  "FRAME_HOST_DATA_ROOT",
  "PHOTO_FTP_PASSIVE_HOST",
]);

try {
  const command = process.argv[2] ?? "help";
  const options = parseOptions(process.argv.slice(3));
  assertAllowedOptions(command, options);
  if (command === "install") {
    await install(options);
  } else if (command === "validate") {
    await validate(options);
  } else if (command === "status") {
    await status();
  } else if (command === "set-tunnel-token") {
    await setTunnelToken();
  } else if (command === "set-portal-auth") {
    await setPortalAuth();
  } else if (command === "reset") {
    await reset(options);
  } else if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else {
    throw new Error(`Unknown command "${command}". Run stack help for available commands.`);
  }
} catch (error) {
  console.error(`FRAME installer error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function install(options) {
  const existingEnv = await loadEnv();
  const importedEnv = options["import-env"] ? await loadImportEnv(options["import-env"]) : {};
  const existingConfigRaw = await readJsonIfExists(getConfigPathFromEnv(existingEnv));
  const existingConfig = existingConfigRaw ? upgradeExistingConfig(existingConfigRaw) : null;
  if (existingConfig) {
    validateConfig(existingConfig);
  }

  const mode = String(options.mode ?? existingConfig?.mode ?? "LAN").toUpperCase();
  if (mode !== "LAN" && mode !== "HYBRID") {
    throw new Error("--mode must be LAN or HYBRID.");
  }

  const capabilities = existingConfig?.capabilities
    ? { ...existingConfig.capabilities }
    : Object.fromEntries(CAPABILITIES.map((name) => [name, false]));

  for (const name of toArray(options.enable)) {
    assertCapability(name);
    if (!IMPLEMENTED_CAPABILITIES.has(name)) {
      throw new Error(`${name} is specified by FRAME but its deployable service is not implemented yet.`);
    }
    capabilities[name] = true;
  }
  for (const name of toArray(options.disable)) {
    assertCapability(name);
    capabilities[name] = false;
  }
  assertDeployableCapabilities(capabilities);

  const dependencyWarnings = enforceDependencies(capabilities);
  const env = buildEnvironment({ ...existingEnv, ...importedEnv }, options, mode, capabilities);
  const dataRoot = resolveDataRoot(env.FRAME_DATA_ROOT);
  const config = {
    mode,
    capabilities,
    routes: { ...ROUTES },
    public_route_prefixes: [...PUBLIC_PREFIXES],
  };
  validateConfig(config);
  validateEnvironment(env, config, false);
  const effectivePublicPrefixes = computeEffectivePublicPrefixes(config, (warning) =>
    console.warn(`  Warning: ${warning}`),
  );

  await ensureDataDirectories(dataRoot);
  await atomicWriteJson(path.join(dataRoot, "state/stack-config.json"), config);
  await atomicWriteJson(path.join(dataRoot, "state/effective-public-prefixes.json"), {
    mode,
    prefixes: effectivePublicPrefixes,
    generated_at: new Date().toISOString(),
  });
  await atomicWrite(
    path.join(dataRoot, "state/cloudflared-ingress.yml"),
    generateCloudflaredIngress(env, effectivePublicPrefixes),
  );
  await atomicWrite(path.join(dataRoot, "state/public-routes.yml"), generatePublicRoutes(effectivePublicPrefixes));
  await ensureTunnelTokenFile(dataRoot);
  await atomicWrite(ENV_PATH, serializeEnv(env));
  await atomicWrite(COMPOSE_PATH, await readFile(COMPOSE_TEMPLATE_PATH, "utf8"));

  console.log("FRAME configuration installed.");
  console.log(`  Mode: ${mode}`);
  console.log(`  Data: ${env.FRAME_DATA_ROOT}`);
  console.log(`  Audio Bridge: ${capabilities["frame-discord-audio-bridge"] ? "enabled" : "disabled"}`);
  console.log(`  Audio Monitor: ${capabilities["frame-audio-relay"] ? "enabled" : "disabled"}`);
  console.log(`  Video Relay: ${capabilities["frame-video-relay"] ? "enabled" : "disabled"}`);
  console.log(`  Overlays: ${capabilities["frame-overlays"] ? "enabled" : "disabled"}`);
  console.log(`  Photo Upload: ${capabilities["frame-photo-webupload"] ? "enabled" : "disabled"}`);
  console.log(`  Photo FTP: ${capabilities["frame-photo-ftp"] ? "enabled" : "disabled"}`);
  console.log(`  Photo Gallery: ${capabilities["frame-photo-gallery"] ? "enabled" : "disabled"}`);
  console.log(`  Today Tools: ${capabilities["frame-photo-todaytools"] ? "enabled" : "disabled"}`);
  if (mode === "HYBRID") {
    console.log(`  Public hostname: ${env.CLOUDFLARE_PUBLIC_HOSTNAME}`);
    console.log(`  Public routes: ${effectivePublicPrefixes.join(", ")}`);
    console.log("  Cloudflare Published application: Type HTTP, URL frame-public-gateway:8080");
  }
  for (const warning of dependencyWarnings) {
    console.warn(`  Warning: ${warning}`);
  }
  if (
    capabilities["frame-discord-audio-bridge"] &&
    (isPlaceholder(env.DISCORD_TOKEN) || isPlaceholder(env.DISCORD_CLIENT_ID))
  ) {
    console.warn("  Setup needed: add Discord credentials to the generated .env before running stack start.");
  }
  if (capabilities["frame-photo-ftp"] && env.PHOTO_FTP_PASSIVE_HOST === "127.0.0.1") {
    console.warn("  Setup needed: set PHOTO_FTP_PASSIVE_HOST to this FRAME host's LAN address for camera FTP.");
  }
  if (
    (capabilities["frame-photo-ftp"] || capabilities["frame-photo-webupload"]) &&
    env.FRAME_HOST_DATA_ROOT === "/data"
  ) {
    console.warn("  StreamerBot setup: set FRAME_HOST_DATA_ROOT to the host-visible FRAME data path before using .ready manifests.");
  }
  if (mode === "HYBRID") {
    if (!env.PORTAL_USERNAME || !env.PORTAL_PASSWORD) {
      console.warn("  Setup needed: add PORTAL_USERNAME and PORTAL_PASSWORD to .env before starting Hybrid mode.");
    }
    if (!(await hasConfiguredTunnelToken(dataRoot))) {
      console.warn(`  Setup needed: replace ${env.FRAME_DATA_ROOT}/${TUNNEL_TOKEN_FILE} with the Cloudflare tunnel token.`);
    }
    console.warn("  Setup needed in Cloudflare: publish the hostname with Type HTTP and URL frame-public-gateway:8080.");
  }
  console.log("Run stack validate, then stack start.");
}

async function validate(options) {
  const env = await loadEnv(true);
  const configPath = getConfigPathFromEnv(env);
  const config = await readJson(configPath);
  validateConfig(config);
  assertDeployableCapabilities(config.capabilities);
  validateEnvironment(env, config, Boolean(options["for-start"]));
  if (options["for-start"] && config.mode === "HYBRID") {
    const dataRoot = resolveDataRoot(env.FRAME_DATA_ROOT);
    if (!(await hasConfiguredTunnelToken(dataRoot))) {
      throw new Error(`Cloudflare tunnel token is missing. Replace ${env.FRAME_DATA_ROOT}/${TUNNEL_TOKEN_FILE}.`);
    }
  }
  await access(COMPOSE_PATH);
  await access(COMPOSE_TEMPLATE_PATH);
  console.log(`FRAME configuration is valid for ${options["for-start"] ? "startup" : "installation"}.`);
}

async function status() {
  const env = await loadEnv(true);
  const config = await readJson(getConfigPathFromEnv(env));
  validateConfig(config);
  const enabled = CAPABILITIES.filter((name) => config.capabilities[name]);
  console.log("FRAME stack configuration");
  console.log(`  Mode: ${config.mode}`);
  console.log(`  Data root: ${env.FRAME_DATA_ROOT}`);
  console.log(`  FRAME Edge: ${env.EDGE_PUBLIC_BASE_URL}`);
  console.log(`  FRAME Edge LAN: ${env.EDGE_LAN_BASE_URL}`);
  if (config.mode === "HYBRID") {
    const effective = await readJson(path.join(resolveDataRoot(env.FRAME_DATA_ROOT), "state/effective-public-prefixes.json"));
    console.log(`  Cloudflare hostname: ${env.CLOUDFLARE_PUBLIC_HOSTNAME}`);
    console.log(`  Tunnel token: ${(await hasConfiguredTunnelToken(resolveDataRoot(env.FRAME_DATA_ROOT))) ? "configured" : "needs setup"}`);
    console.log(`  Public routes: ${effective.prefixes.length ? effective.prefixes.join(", ") : "none"}`);
  }
  console.log(`  Portal: ${env.EDGE_PUBLIC_BASE_URL}/dashboard`);
  console.log(
    `  Audio Bridge: ${
      config.capabilities["frame-discord-audio-bridge"]
        ? `http://localhost:${env.AUDIO_BRIDGE_PORT}`
        : "disabled"
    }`,
  );
  console.log(
    `  Audio Monitor: ${
      config.capabilities["frame-audio-relay"] ? `${env.EDGE_PUBLIC_BASE_URL}/audio/admin` : "disabled"
    }`,
  );
  console.log(
    `  Stream Management: ${
      config.capabilities["frame-video-relay"] ? `${env.EDGE_PUBLIC_BASE_URL}/slsui` : "disabled"
    }`,
  );
  console.log(
    `  Overlay Wizard: ${
      config.capabilities["frame-overlays"] ? `${env.EDGE_PUBLIC_BASE_URL}/overlays/setup` : "disabled"
    }`,
  );
  console.log(
    `  Photo Upload: ${
      config.capabilities["frame-photo-webupload"] ? `${env.EDGE_LAN_BASE_URL}/photos/upload` : "disabled"
    }`,
  );
  console.log(
    `  Photo FTP: ${
      config.capabilities["frame-photo-ftp"] ? `${env.PHOTO_FTP_PASSIVE_HOST}:${env.PHOTO_FTP_PORT}` : "disabled"
    }`,
  );
  console.log(
    `  Photo Gallery: ${
      config.capabilities["frame-photo-gallery"] ? `${env.EDGE_PUBLIC_BASE_URL}/gallery` : "disabled"
    }`,
  );
  console.log(
    `  Today Viewer: ${
      config.capabilities["frame-photo-todaytools"] ? `${env.EDGE_PUBLIC_BASE_URL}/today/viewer` : "disabled"
    }`,
  );
  console.log(`  Enabled capabilities: ${enabled.length ? enabled.join(", ") : "none"}`);
}

async function setTunnelToken() {
  const env = await loadEnv(true);
  const config = await readJson(getConfigPathFromEnv(env));
  validateConfig(config);
  if (config.mode !== "HYBRID") {
    throw new Error("Tunnel token setup requires staged HYBRID mode. Run stack hybrid-stage first.");
  }
  const token = (await readStandardInput()).trim();
  if (!isConfiguredTunnelToken(token)) {
    throw new Error("Tunnel token must be the eyJ... token from Cloudflare's connector install command.");
  }
  await atomicWrite(path.join(resolveDataRoot(env.FRAME_DATA_ROOT), TUNNEL_TOKEN_FILE), `${token}\n`);
  console.log("Cloudflare tunnel token stored.");
}

async function setPortalAuth() {
  const env = await loadEnv(true);
  const [username = "", ...passwordLines] = (await readStandardInput()).replace(/\r/g, "").split("\n");
  const password = passwordLines.join("\n").replace(/\n$/, "");
  if (!username.trim() || !password) {
    throw new Error("Portal username and password are both required.");
  }
  env.PORTAL_USERNAME = username.trim();
  env.PORTAL_PASSWORD = password;
  await atomicWrite(ENV_PATH, serializeEnv(env));
  console.log("Portal credentials stored.");
}

async function reset(options) {
  if (!options.yes) {
    throw new Error("Reset requires --yes after the wrapper confirmation.");
  }
  const env = await loadEnv();
  const dataRoot = resolveDataRoot(env.FRAME_DATA_ROOT ?? "./data");
  assertInsideWorkspace(dataRoot);
  await rm(dataRoot, { recursive: true, force: true });
  await rm(ENV_PATH, { force: true });
  await rm(COMPOSE_PATH, { force: true });
  console.log("FRAME generated config and data were removed.");
  await install({});
}

function buildEnvironment(existing, options, mode, capabilities) {
  const dataRoot = normalizeDataRoot(String(options["data-root"] ?? existing.FRAME_DATA_ROOT ?? "./data"));
  const edgePort = normalizePort(options["edge-http-port"] ?? existing.EDGE_HTTP_PORT ?? "80", "FRAME Edge port");
  const edgeLanBaseUrl = formatLocalHttpUrl(edgePort);
  const cloudflarePublicHostname = normalizeHostname(
    options["public-hostname"] ?? existing.CLOUDFLARE_PUBLIC_HOSTNAME ?? "",
    mode === "HYBRID",
  );
  const edgePublicBaseUrl = mode === "HYBRID" ? `https://${cloudflarePublicHostname}` : edgeLanBaseUrl;
  const portalPort = normalizePort(options["portal-port"] ?? existing.PORTAL_PORT ?? "3730", "portal port");
  const audioPort = normalizePort(
    options["audio-bridge-port"] ?? existing.AUDIO_BRIDGE_PORT ?? "3729",
    "Audio Bridge port",
  );
  const audioMonitorPort = normalizePort(existing.AUDIO_MONITOR_PORT ?? "3734", "Audio Monitor port");
  const streamsPort = normalizePort(existing.STREAMS_PORT ?? "3732", "Stream Management port");
  const overlaysPort = normalizePort(existing.OVERLAYS_PORT ?? "3733", "Overlay Wizard port");
  const photoUploadPort = normalizePort(existing.PHOTO_UPLOAD_PORT ?? "3736", "Photo Upload port");
  const photoFtpPort = normalizePort(existing.PHOTO_FTP_PORT ?? "2121", "Photo FTP port");
  const galleryPort = normalizePort(existing.GALLERY_PORT ?? "3738", "Photo Gallery port");
  const todayPort = normalizePort(existing.TODAY_PORT ?? "3739", "Today Tools port");
  const photoFtpPassiveMin = normalizePort(existing.PHOTO_FTP_PASSIVE_MIN ?? "30000", "Photo FTP passive minimum");
  const photoFtpPassiveMax = normalizePort(existing.PHOTO_FTP_PASSIVE_MAX ?? "30009", "Photo FTP passive maximum");
  if (Number(photoFtpPassiveMin) > Number(photoFtpPassiveMax)) {
    throw new Error("Photo FTP passive minimum cannot exceed its maximum.");
  }
  const slsStatsPort = normalizePort(existing.SLS_STATS_PORT ?? "8080", "SLS statistics port");
  const srtlaPort = normalizePort(existing.SRTLA_PORT ?? "5000", "SRTLA port");
  const srtPlayerPort = normalizePort(existing.SRT_PLAYER_PORT ?? "4000", "SRT player port");
  const srtSenderPort = normalizePort(existing.SRT_SENDER_PORT ?? "4001", "SRT sender port");
  assertPortSet([
    ["FRAME Edge", edgePort, true],
    ["Portal", portalPort, true],
    ["Audio Bridge", audioPort, capabilities["frame-discord-audio-bridge"]],
    ["Audio Monitor", audioMonitorPort, capabilities["frame-audio-relay"]],
    ["Stream Management", streamsPort, capabilities["frame-video-relay"]],
    ["Overlay Wizard", overlaysPort, capabilities["frame-overlays"]],
    ["Photo Upload", photoUploadPort, capabilities["frame-photo-webupload"]],
    ["Photo FTP", photoFtpPort, capabilities["frame-photo-ftp"]],
    ["Photo Gallery", galleryPort, capabilities["frame-photo-gallery"]],
    ["Today Tools", todayPort, capabilities["frame-photo-todaytools"]],
    ["SLS statistics", slsStatsPort, capabilities["frame-video-relay"]],
    ["SRTLA ingest", srtlaPort, capabilities["frame-video-relay"]],
    ["SRT player", srtPlayerPort, capabilities["frame-video-relay"]],
    ["SRT sender", srtSenderPort, capabilities["frame-video-relay"]],
  ]);
  const profiles = computeComposeProfiles(capabilities, mode);

  return {
    FRAME_MODE: mode,
    FRAME_DATA_ROOT: dataRoot,
    FRAME_HOST_DATA_ROOT: existing.FRAME_HOST_DATA_ROOT ?? "/data",
    TIMEZONE: existing.TIMEZONE ?? "America/Chicago",
    COMPOSE_PROFILES: profiles.join(","),
    EDGE_HTTP_PORT: edgePort,
    EDGE_PUBLIC_BASE_URL: edgePublicBaseUrl,
    EDGE_LAN_BASE_URL: edgeLanBaseUrl,
    CLOUDFLARE_PUBLIC_HOSTNAME: cloudflarePublicHostname,
    CLOUDFLARE_TUNNEL_ORIGIN: "http://frame-public-gateway:8080",
    PORTAL_PORT: portalPort,
    AUDIO_BRIDGE_PORT: audioPort,
    AUDIO_MONITOR_PORT: audioMonitorPort,
    AUDIO_PUBLIC_BASE_URL: edgePublicBaseUrl,
    AUDIO_CAPTURE_BASE_URL: edgeLanBaseUrl,
    STREAMS_PORT: streamsPort,
    OVERLAYS_PORT: overlaysPort,
    PHOTO_UPLOAD_PORT: photoUploadPort,
    PHOTO_FTP_PORT: photoFtpPort,
    GALLERY_PORT: galleryPort,
    TODAY_PORT: todayPort,
    PHOTO_FTP_PASSIVE_MIN: photoFtpPassiveMin,
    PHOTO_FTP_PASSIVE_MAX: photoFtpPassiveMax,
    PHOTO_FTP_PASSIVE_HOST: existing.PHOTO_FTP_PASSIVE_HOST ?? "127.0.0.1",
    PHOTO_FTP_USERNAME: existing.PHOTO_FTP_USERNAME ?? "frame",
    PHOTO_FTP_PASSWORD: preserveSecret(existing.PHOTO_FTP_PASSWORD, 18),
    PHOTO_FTP_STABLE_MS: existing.PHOTO_FTP_STABLE_MS ?? "3000",
    PHOTO_FTP_SCAN_MS: existing.PHOTO_FTP_SCAN_MS ?? "1000",
    PIPELINE_POLL_MS: existing.PIPELINE_POLL_MS ?? "1000",
    PIPELINE_CONCURRENCY: existing.PIPELINE_CONCURRENCY ?? "2",
    PHOTO_MAX_INPUT_MB: existing.PHOTO_MAX_INPUT_MB ?? "50",
    PHOTO_MAX_MEGAPIXELS: existing.PHOTO_MAX_MEGAPIXELS ?? "80",
    PHOTO_CONVERSION_ATTEMPTS: existing.PHOTO_CONVERSION_ATTEMPTS ?? "3",
    PHOTO_ARCHIVE_ORIGINALS: existing.PHOTO_ARCHIVE_ORIGINALS ?? "true",
    GALLERY_THUMB_WIDTH: existing.GALLERY_THUMB_WIDTH ?? "720",
    GALLERY_THUMB_QUALITY: existing.GALLERY_THUMB_QUALITY ?? "82",
    TODAY_DEFAULT_INTERVAL_MS: existing.TODAY_DEFAULT_INTERVAL_MS ?? "10000",
    TODAY_REFRESH_MS: existing.TODAY_REFRESH_MS ?? "1000",
    FRAME_AUTH_SESSION_SECRET: preserveSecret(existing.FRAME_AUTH_SESSION_SECRET, 32),
    FRAME_AUTH_SESSION_DAYS: existing.FRAME_AUTH_SESSION_DAYS ?? "7",
    PORTAL_SERVICE_TOKEN: preserveSecret(existing.PORTAL_SERVICE_TOKEN, 32),
    PORTAL_USERNAME: existing.PORTAL_USERNAME ?? "",
    PORTAL_PASSWORD: existing.PORTAL_PASSWORD ?? "",
    PORTAL_REALM: existing.PORTAL_REALM ?? "FRAME Portal",
    ENABLE_CONTAINER_RESTARTS: existing.ENABLE_CONTAINER_RESTARTS ?? "false",
    DOCKER_PROXY_POST: existing.DOCKER_PROXY_POST ?? "0",
    STATUS_REFRESH_MS: existing.STATUS_REFRESH_MS ?? "5000",
    STATUS_CACHE_MS: existing.STATUS_CACHE_MS ?? "4000",
    REQUEST_TIMEOUT_MS: existing.REQUEST_TIMEOUT_MS ?? "3000",
    DISK_WARN_PERCENT: existing.DISK_WARN_PERCENT ?? "85",
    DISK_ERROR_PERCENT: existing.DISK_ERROR_PERCENT ?? "95",
    DISK_MINIMUM_FREE_GB: existing.DISK_MINIMUM_FREE_GB ?? "20",
    DISCORD_TOKEN: existing.DISCORD_TOKEN ?? "your_bot_token_here",
    DISCORD_CLIENT_ID: existing.DISCORD_CLIENT_ID ?? "your_discord_application_client_id_here",
    PUBLIC_BASE_URL: mode === "HYBRID" ? edgePublicBaseUrl : `http://localhost:${audioPort}`,
    SESSION_SECRET: preserveSecret(existing.SESSION_SECRET, 32),
    DEFAULT_AUDIO_DELAY_MS: existing.DEFAULT_AUDIO_DELAY_MS ?? "2000",
    MAX_AUDIO_DELAY_MS: existing.MAX_AUDIO_DELAY_MS ?? "10000",
    SESSION_IDLE_TIMEOUT_MINUTES: existing.SESSION_IDLE_TIMEOUT_MINUTES ?? "30",
    READONLY_OBS_TOKEN: existing.READONLY_OBS_TOKEN ?? "",
    SLS_API_KEY: preserveSecret(existing.SLS_API_KEY, 32),
    PUBLIC_RELAY_HOST: existing.PUBLIC_RELAY_HOST ?? "localhost",
    SRTLA_PORT: srtlaPort,
    SRT_PLAYER_PORT: srtPlayerPort,
    SRT_SENDER_PORT: srtSenderPort,
    SLS_STATS_PORT: slsStatsPort,
    STREAMS_USERNAME: existing.STREAMS_USERNAME ?? "",
    STREAMS_PASSWORD: existing.STREAMS_PASSWORD ?? "",
    OVERLAYS_PUBLIC_BASE_URL: edgePublicBaseUrl,
    OVERLAYS_USERNAME: existing.OVERLAYS_USERNAME ?? "",
    OVERLAYS_PASSWORD: existing.OVERLAYS_PASSWORD ?? "",
  };
}

function validateEnvironment(env, config, forStart) {
  const dataRoot = normalizeDataRoot(env.FRAME_DATA_ROOT);
  resolveDataRoot(dataRoot);
  const edgePort = normalizePort(env.EDGE_HTTP_PORT, "FRAME Edge port");
  const portalPort = normalizePort(env.PORTAL_PORT, "portal port");
  const audioPort = normalizePort(env.AUDIO_BRIDGE_PORT, "Audio Bridge port");
  const audioMonitorPort = normalizePort(env.AUDIO_MONITOR_PORT, "Audio Monitor port");
  const streamsPort = normalizePort(env.STREAMS_PORT, "Stream Management port");
  const overlaysPort = normalizePort(env.OVERLAYS_PORT, "Overlay Wizard port");
  const photoUploadPort = normalizePort(env.PHOTO_UPLOAD_PORT, "Photo Upload port");
  const photoFtpPort = normalizePort(env.PHOTO_FTP_PORT, "Photo FTP port");
  const galleryPort = normalizePort(env.GALLERY_PORT, "Photo Gallery port");
  const todayPort = normalizePort(env.TODAY_PORT, "Today Tools port");
  const photoFtpPassiveMin = normalizePort(env.PHOTO_FTP_PASSIVE_MIN, "Photo FTP passive minimum");
  const photoFtpPassiveMax = normalizePort(env.PHOTO_FTP_PASSIVE_MAX, "Photo FTP passive maximum");
  if (Number(photoFtpPassiveMin) > Number(photoFtpPassiveMax)) {
    throw new Error("Photo FTP passive minimum cannot exceed its maximum.");
  }
  const slsStatsPort = normalizePort(env.SLS_STATS_PORT, "SLS statistics port");
  const srtlaPort = normalizePort(env.SRTLA_PORT, "SRTLA port");
  const srtPlayerPort = normalizePort(env.SRT_PLAYER_PORT, "SRT player port");
  const srtSenderPort = normalizePort(env.SRT_SENDER_PORT, "SRT sender port");
  assertPortSet([
    ["FRAME Edge", edgePort, true],
    ["Portal", portalPort, true],
    ["Audio Bridge", audioPort, config.capabilities["frame-discord-audio-bridge"]],
    ["Audio Monitor", audioMonitorPort, config.capabilities["frame-audio-relay"]],
    ["Stream Management", streamsPort, config.capabilities["frame-video-relay"]],
    ["Overlay Wizard", overlaysPort, config.capabilities["frame-overlays"]],
    ["Photo Upload", photoUploadPort, config.capabilities["frame-photo-webupload"]],
    ["Photo FTP", photoFtpPort, config.capabilities["frame-photo-ftp"]],
    ["Photo Gallery", galleryPort, config.capabilities["frame-photo-gallery"]],
    ["Today Tools", todayPort, config.capabilities["frame-photo-todaytools"]],
    ["SLS statistics", slsStatsPort, config.capabilities["frame-video-relay"]],
    ["SRTLA ingest", srtlaPort, config.capabilities["frame-video-relay"]],
    ["SRT player", srtPlayerPort, config.capabilities["frame-video-relay"]],
    ["SRT sender", srtSenderPort, config.capabilities["frame-video-relay"]],
  ]);
  if (env.FRAME_MODE !== config.mode) {
    throw new Error(".env FRAME_MODE does not match stack-config.json mode.");
  }
  const expectedProfiles = computeComposeProfiles(config.capabilities, config.mode);
  if (env.COMPOSE_PROFILES !== expectedProfiles.join(",")) {
    throw new Error(".env COMPOSE_PROFILES does not match the enabled capabilities. Re-run stack install.");
  }
  assertCredentialPair(env.STREAMS_USERNAME, env.STREAMS_PASSWORD, "Stream Management");
  assertCredentialPair(env.OVERLAYS_USERNAME, env.OVERLAYS_PASSWORD, "Overlay Wizard");
  if ((env.FRAME_AUTH_SESSION_SECRET ?? "").length < 32) {
    throw new Error("FRAME_AUTH_SESSION_SECRET is missing or too short. Re-run stack install.");
  }
  const authSessionDays = Number.parseInt(String(env.FRAME_AUTH_SESSION_DAYS ?? ""), 10);
  if (!Number.isInteger(authSessionDays) || String(authSessionDays) !== String(env.FRAME_AUTH_SESSION_DAYS) || authSessionDays < 1 || authSessionDays > 30) {
    throw new Error("FRAME_AUTH_SESSION_DAYS must be an integer from 1 to 30.");
  }
  if (!isHttpUrl(env.EDGE_PUBLIC_BASE_URL)) {
    throw new Error("EDGE_PUBLIC_BASE_URL must be a valid http:// or https:// URL.");
  }
  if (!isHttpUrl(env.EDGE_LAN_BASE_URL)) {
    throw new Error("EDGE_LAN_BASE_URL must be a valid http:// or https:// URL.");
  }
  if (config.capabilities["frame-audio-relay"] && !isHttpUrl(env.AUDIO_PUBLIC_BASE_URL)) {
    throw new Error("AUDIO_PUBLIC_BASE_URL must be a valid http:// or https:// URL.");
  }
  if (config.capabilities["frame-audio-relay"] && !isHttpUrl(env.AUDIO_CAPTURE_BASE_URL)) {
    throw new Error("AUDIO_CAPTURE_BASE_URL must be a valid http:// or https:// URL.");
  }
  if (config.capabilities["frame-video-relay"] && !String(env.PUBLIC_RELAY_HOST ?? "").trim()) {
    throw new Error("PUBLIC_RELAY_HOST is required when the Video Relay is enabled.");
  }
  if (config.capabilities["frame-photo-ftp"] && String(env.PHOTO_FTP_PASSWORD ?? "").length < 12) {
    throw new Error("PHOTO_FTP_PASSWORD is missing or too short. Re-run stack install.");
  }
  if (config.mode === "HYBRID") {
    const hostname = normalizeHostname(env.CLOUDFLARE_PUBLIC_HOSTNAME, true);
    if (env.EDGE_PUBLIC_BASE_URL !== `https://${hostname}`) {
      throw new Error("EDGE_PUBLIC_BASE_URL must use the configured Cloudflare public hostname in HYBRID mode.");
    }
    if (env.CLOUDFLARE_TUNNEL_ORIGIN !== "http://frame-public-gateway:8080") {
      throw new Error("CLOUDFLARE_TUNNEL_ORIGIN must be http://frame-public-gateway:8080.");
    }
    if (forStart && (!String(env.PORTAL_USERNAME ?? "").trim() || !String(env.PORTAL_PASSWORD ?? "").trim())) {
      throw new Error("PORTAL_USERNAME and PORTAL_PASSWORD are required before starting HYBRID mode.");
    }
  }
  if (!forStart || !config.capabilities["frame-discord-audio-bridge"]) {
    if (config.capabilities["frame-video-relay"] && (env.SLS_API_KEY ?? "").length < 32) {
      throw new Error("SLS_API_KEY is missing or too short. Re-run stack install.");
    }
    if (config.capabilities["frame-overlays"] && !isHttpUrl(env.OVERLAYS_PUBLIC_BASE_URL)) {
      throw new Error("OVERLAYS_PUBLIC_BASE_URL must be a valid http:// or https:// URL.");
    }
    return;
  }
  if (isPlaceholder(env.DISCORD_TOKEN)) {
    throw new Error("DISCORD_TOKEN must be configured before starting the Audio Bridge.");
  }
  if (isPlaceholder(env.DISCORD_CLIENT_ID)) {
    throw new Error("DISCORD_CLIENT_ID must be configured before starting the Audio Bridge.");
  }
  if (!isHttpUrl(env.PUBLIC_BASE_URL)) {
    throw new Error("PUBLIC_BASE_URL must be a valid http:// or https:// URL.");
  }
  if ((env.SESSION_SECRET ?? "").length < 32 || (env.PORTAL_SERVICE_TOKEN ?? "").length < 32) {
    throw new Error("Generated service secrets are missing or too short. Re-run stack install.");
  }
  if (config.capabilities["frame-video-relay"] && (env.SLS_API_KEY ?? "").length < 32) {
    throw new Error("SLS_API_KEY is missing or too short. Re-run stack install.");
  }
  if (config.capabilities["frame-overlays"] && !isHttpUrl(env.OVERLAYS_PUBLIC_BASE_URL)) {
    throw new Error("OVERLAYS_PUBLIC_BASE_URL must be a valid http:// or https:// URL.");
  }
}

function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("stack-config.json must be a JSON object.");
  }
  const expectedTopLevel = ["mode", "capabilities", "routes", "public_route_prefixes"];
  assertExactKeys(config, expectedTopLevel, "stack-config.json");
  if (config.mode !== "LAN" && config.mode !== "HYBRID") {
    throw new Error("stack-config.json mode must be LAN or HYBRID.");
  }
  assertExactKeys(config.capabilities, CAPABILITIES, "stack-config.json capabilities");
  for (const name of CAPABILITIES) {
    if (typeof config.capabilities[name] !== "boolean") {
      throw new Error(`Capability ${name} must be boolean.`);
    }
  }
  assertExactKeys(config.routes, Object.keys(ROUTES), "stack-config.json routes");
  for (const [name, route] of Object.entries(config.routes)) {
    validatePath(route, `Route ${name}`);
  }
  if (!Array.isArray(config.public_route_prefixes) || config.public_route_prefixes.length === 0) {
    throw new Error("public_route_prefixes must be a non-empty array.");
  }
  const unique = new Set(config.public_route_prefixes);
  if (unique.size !== config.public_route_prefixes.length) {
    throw new Error("public_route_prefixes must not contain duplicates.");
  }
  for (const prefix of config.public_route_prefixes) {
    validatePath(prefix, "Public route prefix");
  }
}

function upgradeExistingConfig(config) {
  return {
    ...config,
    capabilities: {
      ...Object.fromEntries(CAPABILITIES.map((name) => [name, false])),
      ...(config?.capabilities ?? {}),
    },
    routes: {
      ...ROUTES,
      ...(config?.routes ?? {}),
    },
    public_route_prefixes: Array.isArray(config?.public_route_prefixes)
      ? [...new Set([...config.public_route_prefixes, ...PUBLIC_PREFIXES])]
      : [...PUBLIC_PREFIXES],
  };
}

function generatePublicRoutes(prefixes) {
  const publicRouter = prefixes.length
    ? `    frame-public:
      entryPoints:
        - public
      rule: "${prefixes.map((prefix) => `(Path(\`${prefix}\`) || PathPrefix(\`${prefix}/\`))`).join(" || ")}"
      priority: 100
      service: frame-edge
`
    : "";
  return `# Generated by FRAME installer. Do not edit by hand.
http:
  routers:
    frame-public-gateway-health:
      entryPoints:
        - health
      rule: "Path(\`/__frame_gateway_health\`)"
      middlewares:
        - frame-public-gateway-health-path
      service: frame-edge
${publicRouter}  middlewares:
    frame-public-gateway-health-path:
      replacePath:
        path: /healthz
  services:
    frame-edge:
      loadBalancer:
        passHostHeader: true
        servers:
          - url: http://frame-edge:80
`;
}

function generateCloudflaredIngress(env, prefixes) {
  if (env.FRAME_MODE !== "HYBRID") {
    return "# Generated by FRAME installer. LAN mode exposes no tunnel routes.\ningress:\n  - service: http_status:404\n";
  }
  return `# Reference for the remotely managed FRAME tunnel.
# In Cloudflare Published applications, route ${env.CLOUDFLARE_PUBLIC_HOSTNAME} to ${env.CLOUDFLARE_TUNNEL_ORIGIN}.
# FRAME Public Gateway enforces: ${prefixes.join(", ") || "no routes"}
ingress:
  - hostname: ${env.CLOUDFLARE_PUBLIC_HOSTNAME}
    service: ${env.CLOUDFLARE_TUNNEL_ORIGIN}
  - service: http_status:404
`;
}

async function ensureTunnelTokenFile(dataRoot) {
  const file = path.join(dataRoot, TUNNEL_TOKEN_FILE);
  try {
    await access(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await atomicWrite(file, `${TUNNEL_TOKEN_PLACEHOLDER}\n`);
  }
}

async function hasConfiguredTunnelToken(dataRoot) {
  try {
    const token = (await readFile(path.join(dataRoot, TUNNEL_TOKEN_FILE), "utf8")).trim();
    return isConfiguredTunnelToken(token);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isConfiguredTunnelToken(token) {
  return token.length >= 100 &&
    token !== TUNNEL_TOKEN_PLACEHOLDER &&
    /^eyJ[A-Za-z0-9_-]+$/.test(token);
}

async function readStandardInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf8");
}

async function ensureDataDirectories(dataRoot) {
  for (const directory of ["state", "audio-bridge", "audio-monitor", "video-relay", "overlays", "logs", "inbox", "staging", "processing", "galleries", "gallery-cache", "archive", "quarantine"]) {
    await mkdir(path.join(dataRoot, directory), { recursive: true });
  }
}

function getConfigPathFromEnv(env) {
  return path.join(resolveDataRoot(env.FRAME_DATA_ROOT ?? "./data"), "state/stack-config.json");
}

function resolveDataRoot(value) {
  const normalized = normalizeDataRoot(value);
  const resolved = path.resolve(WORKSPACE, normalized);
  assertInsideWorkspace(resolved);
  return resolved;
}

function normalizeDataRoot(value) {
  const normalized = String(value ?? "").trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("FRAME_DATA_ROOT must be a repository-relative path without '..'.");
  }
  return normalized.startsWith("./") ? normalized : `./${normalized}`;
}

function assertInsideWorkspace(target) {
  const relative = path.relative(WORKSPACE, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Refusing to modify a data path outside the FRAME workspace.");
  }
}

function validatePath(value, label) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("..")) {
    throw new Error(`${label} must start with '/' and cannot contain '..'.`);
  }
  if (value.length > 1 && value.endsWith("/")) {
    throw new Error(`${label} cannot end with '/'.`);
  }
}

function assertExactKeys(object, expected, label) {
  if (!object || typeof object !== "object" || Array.isArray(object)) {
    throw new Error(`${label} must be an object.`);
  }
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.join("\n") !== wanted.join("\n")) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function assertCapability(name) {
  if (!CAPABILITIES.includes(name)) {
    throw new Error(`Unknown capability "${name}".`);
  }
}

function assertDeployableCapabilities(capabilities) {
  for (const name of CAPABILITIES) {
    if (capabilities[name] && !IMPLEMENTED_CAPABILITIES.has(name)) {
      throw new Error(`${name} is enabled but its deployable service is not implemented yet.`);
    }
  }
}

function normalizePort(value, label) {
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || String(port) !== String(value) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }
  return String(port);
}

function assertPortSet(entries) {
  const seen = new Map();
  for (const [label, port, enabled] of entries) {
    if (!enabled) continue;
    if (seen.has(port)) {
      throw new Error(`${label} host port ${port} conflicts with ${seen.get(port)}.`);
    }
    seen.set(port, label);
  }
}

function assertCredentialPair(username, password, label) {
  if (Boolean(String(username ?? "").trim()) !== Boolean(String(password ?? "").trim())) {
    throw new Error(`${label} username and password must be configured together.`);
  }
}

function isPlaceholder(value) {
  return PLACEHOLDERS.has(String(value ?? "").trim());
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHostname(value, required = false) {
  const hostname = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!hostname && !required) return "";
  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.includes("://") ||
    hostname.includes("/") ||
    !hostname.includes(".") ||
    hostname.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("Cloudflare public hostname must be a valid fully qualified hostname such as frame.syroni.us.");
  }
  return hostname;
}

function formatLocalHttpUrl(port) {
  return port === "80" ? "http://localhost" : `http://localhost:${port}`;
}

function preserveSecret(value, bytes) {
  return value && value.length >= 32 ? value : randomBytes(bytes).toString("base64url");
}

function parseOptions(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument "${argument}".`);
    }
    const key = argument.slice(2);
    if (key === "yes" || key === "for-start") {
      parsed[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    index += 1;
    if (key === "enable" || key === "disable") {
      parsed[key] = [...toArray(parsed[key]), value];
    } else {
      parsed[key] = value;
    }
  }
  return parsed;
}

function assertAllowedOptions(command, options) {
  const allowedByCommand = {
    install: new Set([
      "mode",
      "data-root",
      "edge-http-port",
      "portal-port",
      "audio-bridge-port",
      "public-hostname",
      "import-env",
      "enable",
      "disable",
    ]),
    validate: new Set(["for-start"]),
    "set-tunnel-token": new Set(),
    "set-portal-auth": new Set(),
    reset: new Set(["yes"]),
    status: new Set(),
    help: new Set(),
    "--help": new Set(),
    "-h": new Set(),
  };
  const allowed = allowedByCommand[command];
  if (!allowed) {
    return;
  }
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      throw new Error(`--${key} is not valid for ${command}.`);
    }
  }
}

function toArray(value) {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

async function loadEnv(required = false) {
  try {
    return parseEnv(await readFile(ENV_PATH, "utf8"));
  } catch (error) {
    if (!required && error?.code === "ENOENT") {
      return {};
    }
    if (error?.code === "ENOENT") {
      throw new Error("Generated .env is missing. Run stack install.");
    }
    throw error;
  }
}

async function loadImportEnv(value) {
  const normalized = String(value).trim().replaceAll("\\", "/");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error("--import-env must be a repository-relative path without '..'.");
  }
  const imported = parseEnv(await readFile(path.resolve(WORKSPACE, normalized), "utf8"));
  return Object.fromEntries(
    Object.entries(imported).filter(([key]) => IMPORTABLE_ENV_KEYS.has(key)),
  );
}

function parseEnv(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 1) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function serializeEnv(env) {
  const sections = [
    ["FRAME stack", ["FRAME_MODE", "FRAME_DATA_ROOT", "FRAME_HOST_DATA_ROOT", "TIMEZONE", "COMPOSE_PROFILES"]],
    ["FRAME Edge", ["EDGE_HTTP_PORT", "EDGE_PUBLIC_BASE_URL", "EDGE_LAN_BASE_URL"]],
    ["FRAME Auth", ["FRAME_AUTH_SESSION_SECRET", "FRAME_AUTH_SESSION_DAYS"]],
    ["Cloudflare Tunnel", ["CLOUDFLARE_PUBLIC_HOSTNAME", "CLOUDFLARE_TUNNEL_ORIGIN"]],
    [
      "Direct service ports",
      ["PORTAL_PORT", "AUDIO_BRIDGE_PORT", "AUDIO_MONITOR_PORT", "STREAMS_PORT", "OVERLAYS_PORT", "PHOTO_UPLOAD_PORT", "PHOTO_FTP_PORT", "GALLERY_PORT", "TODAY_PORT"],
    ],
    ["Audio Monitor", ["AUDIO_PUBLIC_BASE_URL", "AUDIO_CAPTURE_BASE_URL"]],
    [
      "Photo workflow",
      [
        "PHOTO_FTP_PASSIVE_MIN",
        "PHOTO_FTP_PASSIVE_MAX",
        "PHOTO_FTP_PASSIVE_HOST",
        "PHOTO_FTP_USERNAME",
        "PHOTO_FTP_PASSWORD",
        "PHOTO_FTP_STABLE_MS",
        "PHOTO_FTP_SCAN_MS",
        "PIPELINE_POLL_MS",
        "PIPELINE_CONCURRENCY",
        "PHOTO_MAX_INPUT_MB",
        "PHOTO_MAX_MEGAPIXELS",
        "PHOTO_CONVERSION_ATTEMPTS",
        "PHOTO_ARCHIVE_ORIGINALS",
        "GALLERY_THUMB_WIDTH",
        "GALLERY_THUMB_QUALITY",
        "TODAY_DEFAULT_INTERVAL_MS",
        "TODAY_REFRESH_MS",
      ],
    ],
    [
      "Portal",
      [
        "PORTAL_SERVICE_TOKEN",
        "PORTAL_USERNAME",
        "PORTAL_PASSWORD",
        "PORTAL_REALM",
        "ENABLE_CONTAINER_RESTARTS",
        "DOCKER_PROXY_POST",
        "STATUS_REFRESH_MS",
        "STATUS_CACHE_MS",
        "REQUEST_TIMEOUT_MS",
        "DISK_WARN_PERCENT",
        "DISK_ERROR_PERCENT",
        "DISK_MINIMUM_FREE_GB",
      ],
    ],
    [
      "Discord Audio Bridge",
      [
        "DISCORD_TOKEN",
        "DISCORD_CLIENT_ID",
        "PUBLIC_BASE_URL",
        "SESSION_SECRET",
        "DEFAULT_AUDIO_DELAY_MS",
        "MAX_AUDIO_DELAY_MS",
        "SESSION_IDLE_TIMEOUT_MINUTES",
        "READONLY_OBS_TOKEN",
      ],
    ],
    [
      "Video Relay",
      [
        "SLS_API_KEY",
        "PUBLIC_RELAY_HOST",
        "SRTLA_PORT",
        "SRT_PLAYER_PORT",
        "SRT_SENDER_PORT",
        "SLS_STATS_PORT",
        "STREAMS_USERNAME",
        "STREAMS_PASSWORD",
      ],
    ],
    [
      "Overlays",
      [
        "OVERLAYS_PUBLIC_BASE_URL",
        "OVERLAYS_USERNAME",
        "OVERLAYS_PASSWORD",
      ],
    ],
  ];
  const output = ["# Generated and maintained by the FRAME installer."];
  for (const [heading, keys] of sections) {
    output.push("", `# ${heading}`);
    for (const key of keys) {
      output.push(`${key}=${formatEnvValue(env[key] ?? "")}`);
    }
  }
  return `${output.join("\n")}\n`;
}

function formatEnvValue(value) {
  return /[\s#"'\\]/.test(value) ? JSON.stringify(value) : value;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${path.relative(WORKSPACE, file)} contains invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

async function readJsonIfExists(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function atomicWriteJson(file, value) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWrite(file, contents) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, contents, "utf8");
  await rename(temporary, file);
}

function printHelp() {
  console.log(`FRAME stack installer

Usage:
  stack install [options]   Generate or update FRAME configuration
  stack hybrid-stage       Prompt for a hostname and stage Hybrid mode without starting it
  stack tunnel-token       Securely prompt for and store the Cloudflare tunnel token
  stack portal-auth        Securely prompt for and store Portal credentials
  stack validate           Validate config and startup requirements
  stack verify             Run contract tests and static verification
  stack start              Build and start enabled services
  stack stop               Stop the stack without deleting data
  stack status             Show config summary and container status
  stack logs [service]     Show recent service logs
  stack reset [--yes]      Delete generated config/data and reinstall defaults

Install options:
  --mode LAN|HYBRID        Stage a LAN or Cloudflare Tunnel deployment
  --public-hostname <host> Required for HYBRID, for example frame.syroni.us
  --data-root ./data       Repository-relative FRAME data directory
  --edge-http-port 80      Shared FRAME web entry point
  --portal-port 3730       Portal host port
  --audio-bridge-port 3729 Audio Bridge host port
  --import-env <path>      Import Audio Bridge settings from a repo-relative .env
  --enable <capability>    Enable a deployable capability
  --disable <capability>   Disable a capability

Re-running install preserves existing credentials and generated secrets.
`);
}
