const FRAME_BLUE = "#2CB4FB";

const SETUP_STAGES = [
  "Welcome",
  "Mode",
  "Storage",
  "Services",
  "Network",
  "Review",
  "Install",
];

const SETUP_MODES = [
  {
    id: "quick",
    label: "Quick Start",
    eyebrow: "Recommended stack",
    summary: "Use the recommended LAN tools and default ports, then open the FRAME dashboard.",
  },
  {
    id: "guided",
    label: "Guided Setup",
    eyebrow: "Service by service",
    summary: "Learn what each service does, then add only the tools this machine needs.",
  },
  {
    id: "advanced",
    label: "Advanced",
    eyebrow: "Every variable",
    summary: "Review paths, ports, services, and the .env model before writing the install plan.",
  },
];

const SERVICES = [
  {
    id: "frame-video-relay",
    label: "Stream Relay and Management",
    summary: "SRTLA/SRT relay, stream profile management, and live bitrate/RTT telemetry.",
    guided: {
      what: "Receives live video from a mobile encoder or IRL backpack and gives FRAME a place to manage that stream locally.",
      why: "Use this when you want FRAME to help route a live SRT/SRTLA feed, view relay health, and power overlays that show bitrate, RTT, dropped packets, and uptime.",
      ports: "Exposes UDP ports for SRTLA ingest, SRT playback, and relay sender/control traffic. These are real streaming ports, so routers/firewalls may need rules when sending video in from outside the LAN.",
      setup: "In the FRAME dashboard you will create or verify stream profiles, confirm relay hostnames/ports, and connect overlay presets to the stream stats you want to display.",
    },
    defaultEnabled: true,
  },
  {
    id: "frame-overlays",
    label: "Overlay Wizard",
    summary: "OBS-friendly telemetry overlays with presets for relay stats and stream scenes.",
    guided: {
      what: "Builds browser-source overlays for OBS using FRAME styling and live telemetry from the relay tools.",
      why: "Use this when you want clean on-stream status panels for bitrate, RTT, buffer health, uptime, or custom stream labels without designing each overlay by hand.",
      ports: "Uses FRAME Edge and currently publishes direct Overlay and Stream Manager TCP ports, shown in the Ports step.",
      setup: "In the FRAME dashboard you will create overlay presets, choose which stats appear, copy OBS browser-source URLs, and adjust layout/visibility for each scene.",
    },
    defaultEnabled: true,
  },
  {
    id: "frame-audio-relay",
    label: "Audio Monitor",
    summary: "Capture a local browser audio feed and serve remote listener links.",
    guided: {
      what: "Captures a local audio source in the browser and creates listener pages so trusted people can monitor the feed remotely.",
      why: "Use this when you need a quick audio confidence monitor for a stream mix, especially when someone off-site is helping watch audio quality.",
      ports: "Uses FRAME Edge and currently publishes a direct Audio Monitor TCP port. Listener routes can be exposed later with Hybrid access.",
      setup: "In the FRAME dashboard you will pick the capture device/page, create listener links, tune quality settings, and decide which routes are safe to publish.",
    },
    defaultEnabled: true,
  },
  {
    id: "frame-belabox-manager",
    label: "Belabox Manager",
    summary: "Hybrid-only remote device control over one authenticated outbound WSS connection.",
    guided: {
      what: "Adds a local FRAME page plus one authenticated WebSocket control connection for roaming Belabox agents.",
      why: "Use this when FRAME should collect Belabox health, stream, network, temperature, uptime, disk, and log data while the Belabox changes networks.",
      ports: "Requires Hybrid mode and a public hostname. The page stays local; agents connect outbound through the existing HTTPS tunnel at /belabox/control.",
      setup: "Selecting this service switches the install to Hybrid. In the FRAME dashboard you can then install or repair agents over the public WSS endpoint.",
    },
    defaultEnabled: false,
    hybridOnly: true,
  },
  {
    id: "frame-photo-ftp",
    label: "Photo FTP Ingest",
    summary: "Camera FTP input with completed-upload stability checks.",
    guided: {
      what: "Starts an FTP endpoint that cameras or phones can send photos to, then moves completed uploads into the photo pipeline.",
      why: "Use this when a camera can FTP images directly to FRAME for live photo galleries, Streamer.bot triggers, or Photo Stage.",
      ports: "Exposes an FTP control port plus a passive FTP port range. Cameras need these open on the LAN, and remote FTP may require router/firewall forwarding.",
      setup: "In the FRAME dashboard you will set the FTP username/password, passive host, passive range, camera connection instructions, and verify that uploads appear in the pipeline.",
    },
    defaultEnabled: true,
  },
  {
    id: "frame-photo-webupload",
    label: "Browser Photo Upload",
    summary: "Portal-protected manual uploads from a phone or browser.",
    guided: {
      what: "Adds a protected web upload page for manually sending photos into the same photo pipeline.",
      why: "Use this when you want a simple backup to FTP or a phone-friendly way to upload images during an event.",
      ports: "Uses FRAME Edge and currently publishes a direct upload TCP port. Uploads require the portal login.",
      setup: "In the FRAME dashboard you will configure upload access, confirm accepted image types, and test multi-file uploads into the pipeline.",
    },
    defaultEnabled: true,
  },
  {
    id: "frame-photo-gallery",
    label: "Photo Gallery",
    summary: "Multi-day published galleries, thumbnail cache, and admin cleanup tools.",
    guided: {
      what: "Publishes processed photos into dated galleries with thumbnails, album stats, and admin cleanup tools.",
      why: "Use this when you want browseable day-by-day galleries for viewers, staff, or your own post-stream review.",
      ports: "Uses FRAME Edge and currently publishes a direct Gallery TCP port. Public/private access depends on your setup.",
      setup: "In the FRAME dashboard you will review gallery routes, admin access, deletion/trash behavior, album covers, and public exposure choices.",
    },
    defaultEnabled: true,
  },
  {
    id: "frame-photo-todaytools",
    label: "Photo Stage",
    summary: "Photo Stage dashboard, OBS viewer, and mobile remote for live photo publishing.",
    guided: {
      what: "Adds the live Photo Stage workflow: current-day gallery, OBS viewer, remote controls, latest image metadata, and Streamer.bot-friendly file outputs.",
      why: "Use this when you want photos to appear live during a stream, with a remote page to control what the OBS viewer shows.",
      ports: "Uses FRAME Edge and currently publishes a direct Photo Stage TCP port. The OBS viewer can be public while operator pages stay protected.",
      setup: "In the FRAME dashboard you will copy the OBS viewer URL, configure remote access, verify latest.json, and confirm published-photo ready-file behavior.",
    },
    defaultEnabled: true,
  },
];

const EXPOSED_PORTS = [
  { key: "edge", label: "FRAME Web GUI", protocol: "tcp", env: "EDGE_HTTP_PORT", defaultValue: 80, required: true },
  { key: "portal", label: "Portal direct access", protocol: "tcp", env: "PORTAL_PORT", defaultValue: 3730, required: true },
  { key: "audioMonitor", label: "Audio Monitor direct access", protocol: "tcp", env: "AUDIO_MONITOR_PORT", defaultValue: 3734, service: "frame-audio-relay" },
  { key: "slsStats", label: "Relay statistics", protocol: "tcp", env: "SLS_STATS_PORT", defaultValue: 8080, service: "frame-video-relay" },
  { key: "photoUpload", label: "Photo Upload direct access", protocol: "tcp", env: "PHOTO_UPLOAD_PORT", defaultValue: 3736, service: "frame-photo-webupload" },
  { key: "gallery", label: "Gallery direct access", protocol: "tcp", env: "GALLERY_PORT", defaultValue: 3738, service: "frame-photo-gallery" },
  { key: "today", label: "Photo Stage direct access", protocol: "tcp", env: "TODAY_PORT", defaultValue: 3739, service: "frame-photo-todaytools" },
  { key: "streams", label: "Stream Manager direct access", protocol: "tcp", env: "STREAMS_PORT", defaultValue: 3732, services: ["frame-video-relay", "frame-overlays"] },
  { key: "overlays", label: "Overlay direct access", protocol: "tcp", env: "OVERLAYS_PORT", defaultValue: 3733, service: "frame-overlays" },
  { key: "ftp", label: "Photo FTP control", protocol: "tcp", env: "PHOTO_FTP_PORT", defaultValue: 2121, service: "frame-photo-ftp" },
  { key: "ftpPassiveMin", label: "Photo FTP passive min", protocol: "tcp", env: "PHOTO_FTP_PASSIVE_MIN", defaultValue: 30000, service: "frame-photo-ftp" },
  { key: "ftpPassiveMax", label: "Photo FTP passive max", protocol: "tcp", env: "PHOTO_FTP_PASSIVE_MAX", defaultValue: 30019, service: "frame-photo-ftp" },
  { key: "srtla", label: "SRTLA ingest", protocol: "udp", env: "SRTLA_PORT", defaultValue: 5000, service: "frame-video-relay" },
  { key: "srtPlayer", label: "SRT player", protocol: "udp", env: "SRT_PLAYER_PORT", defaultValue: 4000, service: "frame-video-relay" },
  { key: "srtSender", label: "SRT sender", protocol: "udp", env: "SRT_SENDER_PORT", defaultValue: 4001, service: "frame-video-relay" },
];

const ADVANCED_SETTINGS = [
  ["FRAME_MODE", "LAN or Hybrid deployment mode."],
  ["FRAME_DATA_ROOT", "Repository-relative container data root used by the stack."],
  ["FRAME_HOST_DATA_ROOT", "Host-visible data root written into photo .ready manifests."],
  ["EDGE_HTTP_PORT", "The one web entry point for Portal, setup, and routed tools."],
  ["PHOTO_FTP_PASSIVE_HOST", "LAN address cameras should use for FTP passive connections."],
  ["PHOTO_FTP_PASSIVE_MIN/MAX", "Passive FTP range exposed only when Photo FTP is enabled."],
  ["PHOTO_FTP_MIN_PASSWORD_LENGTH", "Minimum accepted Photo FTP password length. Default is 5 characters."],
  ["PHOTO_FTP_MAX_SESSIONS", "Maximum total FTP sessions the ingest service allows at once."],
  ["PHOTO_FTP_MAX_SESSIONS_PER_IP", "Maximum FTP sessions from one camera/client address."],
  ["PHOTO_FTP_VERBOSE_LOG", "Temporary diagnostics switch for FTP command logging. Keep false unless troubleshooting."],
  ["PHOTO_UPLOAD_MAX_FILES", "Maximum files the browser upload page lets users queue at one time."],
  ["PHOTO_UPLOAD_MAX_SESSIONS", "Maximum concurrent browser upload sessions from the upload page/service."],
  ["PHOTO_ARCHIVE_RETENTION_DAYS", "Days from archive creation before original backups expire. Default 14; 0 keeps them indefinitely. Gallery photos and trash are never automatically deleted."],
  ["SRTLA_PORT", "UDP ingest port for SRTLA callers."],
  ["SRT_PLAYER_PORT", "UDP output port for SRT playback."],
  ["SRT_SENDER_PORT", "UDP sender/control port used by the relay."],
  ["PUBLIC_RELAY_HOST", "Hostname stream senders should target for relay services."],
  ["PORTAL_USERNAME/PASSWORD", "Shared login for protected setup and operator panels."],
  ["BELABOX_HOST/USER/PORT", "Optional Belabox SSH target for install, diagnostics, or removal."],
  ["BELABOX_SSH_KEY_PATH", "Optional key path used by the Belabox Manager for manual SSH checks."],
  ["BELABOX_CONTROL_RECONNECT_MS", "Agent reconnect interval for the control connection."],
  ["BELABOX_CONTROL_HEARTBEAT_MS", "Heartbeat interval for the control connection."],
  ["BELABOX_CHUNK_UPLOAD_URL", "Optional override for Belabox chunked photo upload endpoint."],
  ["BELABOX_CHUNK_SIZE_BYTES", "Chunk size for Belabox chunked photo uploads."],
];

const ADVANCED_VALUE_FIELDS = [
  {
    key: "PHOTO_FTP_PASSIVE_HOST",
    label: "Photo FTP host address",
    defaultValue: "",
    type: "text",
    placeholder: "192.168.1.10",
  },
  {
    key: "PUBLIC_RELAY_HOST",
    label: "Advertised SRTLA host",
    defaultValue: "",
    type: "text",
    placeholder: "relay.example.com or 203.0.113.10",
  },
  {
    key: "PHOTO_FTP_MIN_PASSWORD_LENGTH",
    label: "FTP password minimum",
    defaultValue: "5",
    min: 5,
    max: 128,
  },
  {
    key: "PHOTO_FTP_MAX_SESSIONS",
    label: "FTP max sessions",
    defaultValue: "20",
    min: 1,
    max: 100,
  },
  {
    key: "PHOTO_FTP_MAX_SESSIONS_PER_IP",
    label: "FTP sessions per IP",
    defaultValue: "10",
    min: 1,
    max: 100,
  },
  {
    key: "PHOTO_UPLOAD_MAX_FILES",
    label: "Upload max files",
    defaultValue: "100",
    min: 1,
    max: 100,
  },
  {
    key: "PHOTO_UPLOAD_MAX_SESSIONS",
    label: "Upload max sessions",
    defaultValue: "2",
    min: 1,
    max: 100,
  },
  {
    key: "PHOTO_ARCHIVE_RETENTION_DAYS",
    label: "Original backup retention days",
    defaultValue: "14",
    min: 0,
    max: 36500,
  },
];

const SERVICE_ADVANCED_FIELDS = {
  "frame-photo-ftp": [
    "PHOTO_FTP_MIN_PASSWORD_LENGTH",
    "PHOTO_FTP_MAX_SESSIONS",
    "PHOTO_FTP_MAX_SESSIONS_PER_IP",
  ],
  "frame-photo-webupload": [
    "PHOTO_UPLOAD_MAX_FILES",
    "PHOTO_UPLOAD_MAX_SESSIONS",
  ],
};

const SUBFOLDERS = ["photos", "galleries", "today", "inbox", "staging", "archive", "state", "logs"];
const emptyCredentials = () => ({ portalUsername: "", portalPassword: "", tunnelToken: "" });

const state = {
  screen: "home",
  launcher: null,
  launcherLoading: true,
  launcherInitializing: true,
  launcherAction: "",
  startupProgress: null,
  startupPending: false,
  lastReadiness: null,
  updates: null,
  updatesChecking: false,
  updatesError: "",
  maintenance: null,
  supportReport: null,
  supportBusy: false,
  supportMessage: "",
  supportError: "",
  protection: null,
  protectionError: "",
  backupRoot: "",
  restoreBackup: null,
  protectionChoosing: false,
  launcherError: "",
  launcherGeneration: 0,
  activeInstallRoot: "",
  confirmAction: null,
  preferences: null,
  preferencesError: "",
  preferencesSaving: false,
  defaults: { installRoot: "", dataRoot: "" },
  pendingDraft: null,
  draftError: "",
  draftLoading: true,
  stage: 0,
  mode: "",
  installRoot: "",
  dataRoot: "",
  deploymentMode: "LAN",
  publicHostname: "",
  autoPorts: false,
  credentials: emptyCredentials(),
  existingInstall: false,
  selectedServices: Object.fromEntries(SERVICES.map((service) => [service.id, false])),
  guidedServiceIndex: 0,
  guidedReviewedServices: Object.fromEntries(SERVICES.map((service) => [service.id, false])),
  ports: Object.fromEntries(EXPOSED_PORTS.map((port) => [port.key, port.defaultValue])),
  subfolders: Object.fromEntries(SUBFOLDERS.map((folder) => [folder, folder])),
  advancedSettings: Object.fromEntries(ADVANCED_VALUE_FIELDS.map((field) => [field.key, field.defaultValue])),
  hostStatus: null,
  detectedInstallations: [],
  previewMode: !isDesktopRuntime(),
  preflight: null,
  preflightRunning: false,
  preflightGeneration: 0,
  log: ["Welcome to FRAME Launcher."],
  savedPlanPath: "",
  lastSetupUrl: "",
  installing: false,
  installStatus: "idle",
  animateStage: false,
  validationMessage: "",
  validationStage: -1,
};

const app = document.querySelector("#app");
let draftWrites = Promise.resolve();
let pendingFocus = null;

render();
void initializeLauncher();

function render() {
  const active = document.activeElement;
  const focused = active?.id || Object.keys(active?.dataset || {}).length ? active : pendingFocus;
  const identity = Object.entries(focused?.dataset || {});
  const selection = typeof focused?.selectionStart === "number" ? [focused.selectionStart, focused.selectionEnd] : null;
  renderContent();
  // Status refreshes replace the view. Keep keyboard users on the same surviving control.
  if (focused && (focused.id || identity.length)) {
    const replacement = [...app.querySelectorAll("button, input, select, textarea, [tabindex]")].find((element) =>
      element.tagName === focused.tagName && (focused.id ? element.id === focused.id
        : identity.every(([key, value]) => element.dataset?.[key] === value)));
    pendingFocus = replacement?.disabled ? focused : null;
    if (replacement && !replacement.disabled) {
      replacement.focus({ preventScroll: true });
      if (selection && replacement.setSelectionRange) replacement.setSelectionRange(...selection);
    }
  }
}

function renderContent() {
  if (state.screen !== "setup") {
    renderLauncher();
    return;
  }
  app.innerHTML = `
    <div class="setup-shell">
      <aside class="sidebar">
        <div class="brand">
          <img src="./frame-logo-square.png" alt="" aria-hidden="true" />
          <div>
            <p class="eyebrow">Syronius FRAME</p>
            <h2>Launcher</h2>
          </div>
        </div>
        <ol class="stage-list">
          ${SETUP_STAGES.map((stage, index) => renderStageItem(stage, index)).join("")}
        </ol>
        <button class="button ghost setup-home" data-screen="home" type="button">Back to launcher</button>
      </aside>
      <section class="content">
        <div class="stage-viewport">
          ${state.previewMode ? previewNotice() : ""}
          ${renderCurrentStage()}
        </div>
        ${renderFooter()}
      </section>
    </div>
  `;
  bindEvents();
  bindLauncherEvents();
  if (state.installing) app.querySelectorAll("button, input, select").forEach((control) => { control.disabled = true; });
  state.animateStage = false;
}

function previewNotice() {
  return '<p class="stage-alert" role="status">Browser preview · simulated examples. Installation, service controls, saved drafts, and preferences are disabled.</p>';
}

function currentInstallation() {
  const installations = state.launcher?.installations ?? [];
  return installations.find((install) => install.installRoot === state.activeInstallRoot) ?? installations[0];
}

function portalUrl(install = currentInstallation()) {
  if (!install?.dashboardUrl) return "";
  try {
    const url = new URL(install.dashboardUrl);
    return `http://localhost${url.port && url.port !== "80" ? `:${url.port}` : ""}/dashboard`;
  } catch { return ""; }
}

function containerReadiness(service) {
  if (service.status === "running" && ["healthy", "none"].includes(service.health)) return { tone: "good", label: service.health === "healthy" ? "Healthy" : "Running · no health check", symbol: "✓" };
  if (service.health === "unhealthy" || ["dead", "removing", "failed"].includes(service.status)) return { tone: "bad", label: service.health === "unhealthy" ? "Unhealthy" : "Failed", symbol: "!" };
  if (service.status === "running" && service.health === "starting") return { tone: "waiting", label: "Starting · checking health", symbol: "…" };
  const labels = { waiting: "Waiting", created: "Created · waiting to start", exited: "Stopped", restarting: "Restarting", missing: "Waiting for container", paused: "Paused", running: "Running · health not reported" };
  return { tone: "waiting", label: labels[service.status] || "Status not reported", symbol: "…" };
}

function renderContainerStartup(progress) {
  const services = progress?.services ?? [];
  const ready = services.filter((service) => containerReadiness(service).tone === "good").length;
  const failed = progress?.phase === "failed";
  return `<section class="container-startup" aria-label="Container startup">
    <div class="panel-heading"><div><p class="eyebrow">Container startup</p><h2>${failed ? "Startup needs attention" : progress?.phase === "complete" ? "Your FRAME tools are ready" : "Starting your FRAME tools"}</h2></div><span class="pill ${failed ? "bad" : ready === services.length && services.length ? "good" : "warn"}">${ready}/${services.length} ready</span></div>
    <p class="startup-announcement" role="status" aria-live="polite" aria-atomic="true">${failed ? "FRAME did not finish starting. Review the container states below." : services.length ? `${ready} of ${services.length} containers ready.${progress.phase === "complete" ? " Startup checks have completed." : " Waiting for the remaining startup checks."}` : "Waiting for the configured container list."}</p>
    ${progress?.detail ? `<p class="launcher-caption">${escapeHtml(progress.detail)}</p>` : ""}
    <ul class="container-checklist">${services.map((service) => {
      let result = containerReadiness(service);
      if (failed && result.tone === "waiting") result = { tone: "bad", label: `Not ready · ${result.label}`, symbol: "!" };
      return `<li class="container-check ${result.tone}" data-container="${escapeHtml(service.name)}"><span class="container-check-icon" aria-hidden="true">${result.symbol}</span><strong>${escapeHtml(service.name)}</strong><span class="container-check-state">${escapeHtml(result.label)}</span></li>`;
    }).join("")}</ul></section>`;
}

function acceptLauncherProgress(progress) {
  if (!progress || typeof progress.installRoot !== "string" || !Array.isArray(progress.services) || !["starting", "complete", "failed"].includes(progress.phase)) return;
  const target = state.installing ? state.installRoot : currentInstallation()?.installRoot;
  if (target && target !== progress.installRoot) return;
  const previous = state.startupProgress;
  if (previous?.installRoot === progress.installRoot && Date.parse(progress.observedAt) < Date.parse(previous.observedAt)) return;
  const active = state.installing || state.launcherAction === "start_stack" || state.launcher?.busy;
  if (!active && previous?.phase === "failed") return;
  if (previous?.phase === "failed" && progress.phase === "complete") return;
  if (!active && previous?.phase === "complete" && progress.phase === "starting") return;
  state.startupProgress = progress;
  state.startupPending = progress.phase === "starting" || progress.phase === "complete" && Boolean(state.startupPending || active);
  if (["home", "updates"].includes(state.screen) || state.screen === "setup" && state.stage === 6 && state.installing) render();
}

function renderLauncher() {
  const install = currentInstallation();
  app.innerHTML = `
    <div class="setup-shell launcher-shell">
      <aside class="sidebar">
        <div class="brand"><img src="./frame-logo-square.png" alt="" aria-hidden="true" /><div><p class="eyebrow">Syronius FRAME</p><h2>Launcher</h2></div></div>
        <nav class="launcher-nav" aria-label="Launcher">
          ${[["home", "Home"], ["my-setup", "My Setup"], ["updates", "Updates & repair"], ["backups", "Backup & removal"], ["support", "Support"], ["preferences", "Preferences"]].map(([screen, label]) => `<button type="button" class="button ghost ${state.screen === screen ? "selected" : ""}" data-screen="${screen}" ${state.screen === screen ? 'aria-current="page"' : ""}>${label}</button>`).join("")}
        </nav>
        <p class="launcher-close-note">Closing this window leaves FRAME services running. Use Stop FRAME to stop them.</p>
      </aside>
      <section class="content launcher-content">
        <div class="stage-viewport">
          ${state.previewMode ? previewNotice() : ""}
          ${state.launcherError ? `<p class="stage-alert" role="alert">${escapeHtml(state.launcherError)}</p>` : ""}
          ${state.screen === "preferences" ? renderPreferences() : state.screen === "backups" ? renderBackups(install) : state.screen === "support" ? renderSupport() : state.screen === "updates" ? renderUpdates(install) : state.screen === "my-setup" ? renderMySetup(install) : renderLauncherHome(install)}
        </div>
      </section>
    </div>`;
  bindLauncherEvents();
}

function renderLauncherHome(install) {
  const labels = { running: "FRAME is running", stopped: "FRAME is stopped", starting: "FRAME is starting", needs_attention: "FRAME needs attention", docker_unavailable: "Docker is unavailable" };
  const compatibility = hostCompatibilityIssue();
  const busy = Boolean(state.launcherAction || state.launcherLoading || state.launcherInitializing || state.launcher?.busy || state.installing);
  const progress = state.startupProgress?.installRoot === install?.installRoot ? state.startupProgress : null;
  const warnings = install && state.lastReadiness?.installRoot === install.installRoot ? state.lastReadiness.checks.filter((check) => check.status === "warn") : [];
  const starting = state.launcherAction === "start_stack" || install?.state === "starting" || state.startupPending && progress && ["starting", "complete"].includes(progress.phase);
  const observedState = state.launcherError || compatibility || progress?.phase === "failed" ? "needs_attention" : starting ? "starting" : install?.state;
  const title = state.launcherLoading && !state.launcher ? "Checking this computer…" : compatibility?.title ?? labels[observedState] ?? (state.launcher?.dockerAvailable === false ? "Docker is unavailable" : "Welcome to FRAME");
  const disabled = busy || state.previewMode || Boolean(state.launcherError);
  const actionLabel = { start_stack: "Starting FRAME…", stop_stack: "Stopping FRAME…", recover_stack: "Recovering FRAME…", update_stack: "Updating FRAME…", repair_stack: "Repairing FRAME…" }[state.launcherAction];
  return `
    <section class="hero launcher-hero">
      <div><p class="eyebrow">Your streaming toolkit</p><h1>${title}</h1><p aria-live="polite">${escapeHtml(actionLabel || (state.launcherError ? "The current service state could not be confirmed. Recheck before continuing." : compatibility?.detail || install?.detail || state.launcher?.detail) || "Set up FRAME on this computer, then return here to open or manage it.")}</p></div>
      <span class="pill ${observedState === "running" ? "good" : observedState === "needs_attention" || observedState === "docker_unavailable" ? "bad" : "warn"}">${state.launcherLoading ? "Checking" : observedState ? escapeHtml(observedState.replaceAll("_", " ")) : "Not installed"}</span>
      <div class="button-row launcher-primary-actions">
        ${install ? `<button class="button primary" type="button" data-open-dashboard ${!portalUrl(install) || observedState !== "running" || disabled ? "disabled" : ""}>Launch FRAME Portal</button>
          ${install.canStart ? `<button class="button" type="button" data-stack-action="start_stack" ${disabled ? "disabled" : ""}>Start FRAME</button>` : ""}
          ${install.canStop ? `<button class="button" type="button" data-stack-action="stop_stack" ${disabled ? "disabled" : ""}>Stop FRAME</button>` : ""}
          ${install.canReconfigure ? `<button class="button" type="button" data-change-setup ${disabled ? "disabled" : ""}>Edit configuration</button>` : ""}
          ${install.canRecover ? `<button class="button" type="button" data-stack-action="recover_stack" ${disabled ? "disabled" : ""}>Recover previous deployment</button>` : ""}`
          : `<button class="button primary" type="button" data-new-setup ${busy || compatibility || state.draftLoading || state.pendingDraft ? "disabled" : ""}>Set up FRAME</button>`}
        <button class="button ghost" type="button" data-recheck ${busy ? "disabled" : ""}>Recheck</button>
      </div>
      <p class="launcher-caption">${state.launcher?.observedAt ? `Last checked ${escapeHtml(formatDetectedDate(state.launcher.observedAt))}. ` : ""}${install ? `FRAME Portal opens on this computer at ${escapeHtml(portalUrl(install) || "its configured localhost address")}.` : dockerGuidance().instructions}</p>
    </section>
    ${starting || progress?.phase === "failed" ? `<section class="panel">${renderContainerStartup(progress || { phase: "starting", services: install?.services ?? [] })}</section>` : progress?.phase === "complete" && observedState === "running" ? `<details class="panel startup-completed"><summary><span class="startup-completed-mark" aria-hidden="true">✓</span> FRAME started · View container checks</summary>${renderContainerStartup(progress)}</details>` : ""}
    ${warnings.length ? `<details class="panel"><summary>Storage warnings from the last setup or start check (${warnings.length})</summary><p>These warnings allow you to continue. Storage is checked again when you apply setup or start FRAME.</p><div class="check-grid">${warnings.map(renderCheckCard).join("")}</div></details>` : ""}
    ${state.updates?.launcher?.available || state.updates?.frame?.available ? '<section class="panel"><h2>An update is available</h2><p>Review the release notes and choose when to install.</p><button class="button" type="button" data-screen="updates">View updates</button></section>' : ""}
    ${state.confirmAction ? `<section class="panel confirmation" role="alert"><h2>${state.confirmAction === "stop_stack" ? "Stop FRAME?" : "Recover the previous deployment?"}</h2><p>${state.confirmAction === "stop_stack" ? "This interrupts active streams, audio, uploads, and photo processing. FRAME configuration and data are retained; Docker and unrelated services stay running." : "Recovery restores the saved deployment configuration and services. Active FRAME work may be interrupted. Review My Setup before continuing."}</p><div class="button-row"><button class="button" type="button" data-cancel-action>Cancel</button><button class="button primary" type="button" data-confirm-action>${state.confirmAction === "stop_stack" ? "Stop FRAME" : "Recover deployment"}</button></div></section>` : ""}
    ${state.pendingDraft ? `<section class="panel"><h2>Continue setup?</h2><p>Your choices were saved. Credentials must be entered again, and readiness checks will run again before installation.</p><div class="button-row"><button class="button" type="button" data-continue-draft ${busy ? "disabled" : ""}>Continue setup</button><button class="button ghost" type="button" data-discard-draft ${busy ? "disabled" : ""}>Discard draft</button></div></section>` : ""}
    ${state.draftError ? `<p class="stage-alert" role="alert">${escapeHtml(state.draftError)}</p>` : ""}
    ${install ? `<section class="panel"><div class="panel-heading"><div><h2>My Setup</h2><p>See the installed version, data folder, and service health.</p></div><button class="button" type="button" data-screen="my-setup">View setup</button></div></section>` : `<section class="panel"><h2>One place to return to</h2><p>Setup downloads FRAME and configures your tools. After installation, use this launcher to start, stop, or open your dashboard.</p><button class="button ghost" type="button" data-docker-guide>Docker install guide</button></section>`}
    ${state.launcherAction || state.launcherError || state.installStatus === "failed" ? `<details class="panel"><summary>Operation log</summary><pre class="log">${escapeHtml(state.log.join("\n"))}</pre></details>` : ""}`;
}

function renderMySetup(install) {
  if (!install) return `<section class="panel"><h1>My Setup</h1><p>No FRAME installation is currently available. Recheck Home, locate an existing deployment folder, or begin setup.</p><div class="button-row"><button class="button" type="button" data-locate-installation ${state.previewMode || state.launcher?.busy || state.protectionChoosing ? "disabled" : ""}>Locate existing installation</button><button class="button" type="button" data-screen="home">Back to Home</button></div></section>`;
  const busy = state.launcherLoading || state.launcherInitializing || state.launcherAction || state.launcher?.busy || state.installing || state.launcherError;
  return `<section class="panel"><p class="eyebrow">On this computer</p><h1>My Setup</h1><p>${escapeHtml(install.detail || "Installed FRAME configuration")}</p>
    <dl class="setup-facts"><dt>Version</dt><dd>${escapeHtml(install.version || "Not reported")}</dd><dt>Deployment files</dt><dd>${escapeHtml(install.installRoot)}</dd><dt>FRAME data</dt><dd>${escapeHtml(install.dataRoot || "Not reported")}</dd><dt>Dashboard</dt><dd>${escapeHtml(install.dashboardUrl || "Not available")}</dd></dl>
    <p>Docker stores container images separately in its own storage. Changing the FRAME data folder does not move Docker images.</p>
    <div class="button-row"><button class="button" type="button" data-open-data ${state.previewMode || !install.dataRoot || busy ? "disabled" : ""}>Open data folder</button>${install.canReconfigure ? `<button class="button" type="button" data-change-setup ${busy ? "disabled" : ""}>Edit configuration</button>` : ""}<button class="button ghost" type="button" data-recheck ${busy ? "disabled" : ""}>Recheck</button></div>
    </section><section class="panel"><h2>Service health</h2><ul class="launcher-services">${(install.services ?? []).map((service) => `<li><strong>${escapeHtml(service.name)}</strong><span>${escapeHtml(service.status)}${service.health ? ` · ${escapeHtml(service.health)}` : ""}</span></li>`).join("") || '<li>Service health has not been reported.</li>'}</ul></section>`;
}

function renderUpdates(install) {
  const updates = state.updates;
  const frame = updates?.installRoot === install?.installRoot ? updates?.frame : null;
  const busy = Boolean(state.updatesChecking || state.launcherAction || state.launcher?.busy || state.launcherLoading || state.launcherInitializing || state.installing);
  const disabled = busy || state.previewMode;
  const updating = state.confirmAction === "update_stack";
  const confirming = updating || state.confirmAction === "repair_stack";
  const notes = (release, label) => release ? `<p>${release.available ? `Available: <strong>${escapeHtml(release.version)}</strong>` : escapeHtml(release.reason || "No newer stable release is available.")}</p>${release.notes ? `<details><summary>${label} release notes</summary><pre class="release-notes">${escapeHtml(release.notes)}</pre></details>` : ""}${release.url ? `<button class="button ghost" type="button" data-update-link="${escapeHtml(release.url)}" ${disabled ? "disabled" : ""}>View release on GitHub</button>` : ""}` : "<p>Check for updates to see the latest stable release.</p>";
  return `<section class="panel"><p class="eyebrow">Keep FRAME current</p><h1>Updates & repair</h1><p>Review stable releases and choose when to install them.</p>
    <div class="button-row"><button class="button primary" type="button" data-check-updates ${disabled ? "disabled" : ""}>${state.updatesChecking ? "Checking for updates…" : "Check for updates"}</button><button class="button ghost" type="button" data-screen="preferences">Update preferences</button></div>
    <p class="launcher-caption">${updates?.checkedAt ? `Last successful check: ${escapeHtml(formatDetectedDate(updates.checkedAt))}. ` : ""}${state.preferences?.checkUpdatesAutomatically ? "Periodic checks are on: once a day while the launcher is open or in the tray." : "Periodic checks are off. You can enable them in Preferences."}</p>
    ${state.updatesError ? `<p class="stage-alert" role="alert">${escapeHtml(state.updatesError)}</p>` : ""}
    </section>
    ${confirming ? `<section class="panel confirmation" role="alert"><h2>${updating ? `Update FRAME to ${escapeHtml(frame?.version || "the selected release")}?` : "Repair this FRAME installation?"}</h2><p>${updating ? "The update replaces FRAME application files and containers. Active streams, audio, and uploads may be interrupted." : "Repair restores missing containers and images from the installed release. It may interrupt active FRAME work."} Configuration and media are retained. Services that were deliberately stopped stay stopped.</p><p>${updating ? "The previous application files and deployment configuration are retained for recovery. This is not a backup of your media or databases." : "Repair keeps the current release. It cannot recover deleted media or fix account credentials."}</p><div class="button-row"><button class="button" type="button" data-cancel-action ${disabled ? "disabled" : ""}>Cancel</button><button class="button primary" type="button" data-confirm-action ${disabled || state.launcherError || (updating ? !install?.canUpdate || !frame?.available || !frame?.eligible || state.updatesError : !install?.canRepair) ? "disabled" : ""}>${updating ? "Install FRAME update" : "Repair installation"}</button></div></section>` : ""}
    ${state.launcherAction && ["update_stack", "repair_stack"].includes(state.launcherAction) ? `<section class="panel" role="status" aria-live="polite"><h2>${state.launcherAction === "update_stack" ? "Updating FRAME…" : "Repairing FRAME…"}</h2><p>Keep the launcher open until this operation finishes.</p>${state.startupProgress ? renderContainerStartup(state.startupProgress) : "<p>Checking this installation and preparing the required files.</p>"}</section>` : ""}
    ${state.maintenance ? `<section class="panel" role="${state.maintenance.success ? "status" : "alert"}"><h2>${state.maintenance.success ? "Operation completed" : state.maintenance.recovered ? "Operation failed; previous deployment recovered" : "FRAME needs attention"}</h2><p>${escapeHtml(state.maintenance.detail)}</p><button class="button" type="button" data-recheck ${disabled ? "disabled" : ""}>Recheck FRAME</button>${install?.canRecover ? `<button class="button" type="button" data-screen="home">View recovery options</button>` : ""}</section>` : ""}
    <div class="updates-grid"><section class="panel"><h2>FRAME Launcher</h2><p>Installed version: <strong>${escapeHtml(state.launcher?.launcherVersion || updates?.launcher?.currentVersion || "Not reported")}</strong></p>${notes(updates?.launcher, "Launcher")}
      ${updates?.launcher?.available && updates.launcher.downloadUrl ? `<button class="button" type="button" data-update-link="${escapeHtml(updates.launcher.downloadUrl)}" ${disabled ? "disabled" : ""}>Download launcher installer</button><p class="launcher-caption">Run the downloaded installer to update the launcher. Your FRAME deployment and data are retained.</p>` : ""}</section>
    <section class="panel"><h2>FRAME services</h2><p>Installed release: <strong>${escapeHtml(install?.version || "Not installed")}</strong></p>${notes(frame, "FRAME")}
      ${frame?.available ? `<button class="button primary" type="button" data-stack-action="update_stack" ${disabled || state.launcherError || state.updatesError || !frame.eligible || !install?.canUpdate ? "disabled" : ""}>Update FRAME</button>${frame.reason ? `<p>${escapeHtml(frame.reason)}</p>` : ""}` : ""}</section></div>
    ${install ? `<section class="panel"><h2>Repair installation</h2><p>Restore missing containers or images from the installed FRAME release while keeping configuration and media.</p><button class="button" type="button" data-stack-action="repair_stack" ${disabled || state.launcherError || !install.canRepair ? "disabled" : ""}>Repair installation</button>${!install.canRepair ? `<p class="launcher-caption">${escapeHtml(install.detail || "Repair requires an accessible, installer-managed release with valid configuration.")}</p>` : ""}</section>` : ""}
    ${state.launcherAction || state.maintenance || state.launcherError ? `<details class="panel" ${state.launcherAction ? "open" : ""}><summary>Operation log</summary><pre class="log">${escapeHtml(state.log.join("\n"))}</pre></details>` : ""}`;
}

async function checkForUpdates() {
  if (!isDesktopRuntime() || state.previewMode || state.updatesChecking || state.launcherAction || state.launcher?.busy) return;
  state.updatesChecking = true; state.updatesError = ""; state.confirmAction = null;
  render();
  try { state.updates = await invokeCommand("check_updates", { installRoot: currentInstallation()?.installRoot }); }
  catch (error) { state.updatesError = `Could not check for updates: ${error.message ?? error}`; }
  finally { state.updatesChecking = false; render(); }
}

function renderSupport() {
  const disabled = state.previewMode || state.supportBusy || state.launcher?.busy || state.launcherAction || state.installing;
  return `<section class="panel"><p class="eyebrow">Help with FRAME</p><h1>Support report</h1>
    <p>Collect the launcher and FRAME versions, operating system, Docker readiness, and service health to help troubleshoot a problem.</p>
    <p>Reports exclude passwords, tokens, folder paths, raw logs, and configuration files. Nothing is uploaded. Review the report before sharing it.</p>
    <div class="button-row">${[["preview", "Generate report"], ["copy", "Copy diagnostic report"], ["save", "Save support report"]].map(([action, label]) => `<button class="button" type="button" data-support-action="${action}" ${disabled ? "disabled" : ""}>${label}</button>`).join("")}</div>
    <p role="status">${escapeHtml(state.supportBusy ? "Collecting current status…" : state.supportMessage)}</p>
    ${state.supportError ? `<p class="stage-alert" role="alert">${escapeHtml(state.supportError)}</p>` : ""}
    ${state.supportReport ? `<h2>Report preview</h2><pre class="release-notes support-report" tabindex="0" aria-label="Diagnostic report">${escapeHtml(JSON.stringify(state.supportReport, null, 2))}</pre>` : ""}</section>`;
}

function renderBackups(install) {
  const busy = Boolean(state.protectionChoosing || state.launcher?.busy || state.launcherAction || state.launcherLoading || state.launcherInitializing || state.installing);
  const disabled = busy || state.previewMode;
  const restore = state.restoreBackup;
  const permitted = protectionAllowed(state.confirmAction);
  const confirmation = {
    backup_stack: ["Create full backup?", "FRAME will stop while files are copied. Large libraries can take a while. Previously running services will resume afterwards; deliberately stopped services stay stopped. The backup contains passwords and tokens: keep it private."],
    remove_stack: ["Remove FRAME containers?", "This stops FRAME and removes its containers. Deployment files, settings, media, and Docker images are kept. Use Repair installation to recreate the containers later."],
    restore_backup: ["Restore this full backup?", "Restore uses the original deployment and data paths on the same operating system. Both destinations must be empty and FRAME containers must be removed first. Move existing folders aside yourself before restoring. Restored services stay stopped until you choose Repair installation and Start FRAME."],
  }[state.confirmAction];
  return `<section class="panel"><p class="eyebrow">Protect your installation</p><h1>Backup & removal</h1>
    <p>A full backup copies FRAME application files, configuration, databases, and media. Docker images are downloaded again by Repair when needed.</p>
    ${state.protectionError ? `<p class="stage-alert" role="alert">${escapeHtml(state.protectionError)}</p>` : ""}
    ${state.protection ? `<p class="${state.protection.success ? "launcher-caption" : "stage-alert"}" role="status">${escapeHtml(state.protection.detail)}</p>` : ""}
    ${state.launcherAction && ["backup_stack", "restore_backup", "remove_stack"].includes(state.launcherAction) ? '<p role="status">Working… Keep the launcher open and storage connected until this operation finishes.</p>' : ""}
    <h2>Full backup</h2><p>Choose an empty folder outside your deployment and FRAME data folders. Keep the completed backup on a separate drive when possible. Backups contain credentials and are not encrypted.</p>
    ${state.backupRoot ? `<p class="launcher-caption">Backup folder: ${escapeHtml(state.backupRoot)}</p>` : ""}
    <div class="button-row"><button class="button" type="button" data-protection-pick="backup" ${disabled || !install?.canBackup ? "disabled" : ""}>Choose backup folder</button><button class="button primary" type="button" data-protection-action="backup_stack" ${disabled || !install?.canBackup || !state.backupRoot ? "disabled" : ""}>Create full backup</button></div>
    </section><section class="panel"><h2>Restore a full backup</h2><p>Restore to the original paths on this operating system. Restoring to a different computer or folder needs a separate migration.</p>
    <button class="button" type="button" data-protection-pick="restore" ${disabled ? "disabled" : ""}>Choose backup to restore</button>
    ${restore ? `<dl class="setup-facts"><dt>Backup created</dt><dd>${escapeHtml(formatDetectedDate(restore.createdAt))}</dd><dt>Deployment destination</dt><dd>${escapeHtml(restore.workspace)}</dd><dt>Data destination</dt><dd>${escapeHtml(restore.dataRoot)}</dd><dt>Contents</dt><dd>${escapeHtml(restore.fileCount)} files · ${escapeHtml(restore.totalBytes)} bytes</dd></dl><button class="button" type="button" data-protection-action="restore_backup" ${disabled || !state.launcher?.dockerAvailable ? "disabled" : ""}>Restore backup</button>` : ""}
    </section><section class="panel"><h2>Remove FRAME containers</h2><p>Settings and media are kept. This does not uninstall Docker or remove other applications. Reinstalling the launcher can reconnect to this installation.</p>
    <button class="button" type="button" data-protection-action="remove_stack" ${disabled || !install?.canRemove ? "disabled" : ""}>Remove FRAME containers…</button>
    <details><summary>Remove the launcher or permanently delete data</summary><p>Uninstall the launcher through your operating system. FRAME containers keep their current state, and the deployment and data folders remain.</p><p>To permanently erase FRAME, first remove its containers above and make a verified backup. Then use your file manager to delete only the deployment and FRAME data folders shown in My Setup. That separate deletion is permanent. Docker images are managed separately in Docker.</p></details>
    </section>${confirmation ? `<section id="protection-confirmation" class="panel launcher-confirm" role="region" tabindex="-1" aria-label="${confirmation[0]}"><h2>${confirmation[0]}</h2><p>${confirmation[1]}</p><div class="button-row"><button class="button" type="button" data-cancel-action ${busy ? "disabled" : ""}>Cancel</button><button class="button primary" type="button" data-protection-confirm ${disabled || !permitted ? "disabled" : ""}>${state.confirmAction === "backup_stack" ? "Stop FRAME and back up" : state.confirmAction === "remove_stack" ? "Remove containers and keep data" : "Restore into empty folders"}</button></div></section>` : ""}`;
}

function protectionAllowed(action) {
  const install = currentInstallation();
  if (action === "backup_stack") return Boolean(install?.canBackup && state.backupRoot);
  if (action === "remove_stack") return Boolean(install?.canRemove);
  return action === "restore_backup" && Boolean(state.restoreBackup && state.launcher?.dockerAvailable);
}

async function chooseProtectionFolder(purpose) {
  if (!["backup", "restore"].includes(purpose) || !isDesktopRuntime() || state.previewMode || state.protectionChoosing || state.launcher?.busy || state.launcherAction) return;
  state.protectionChoosing = true; state.protectionError = ""; state.confirmAction = null;
  render();
  try {
    const selected = await window.frameDesktop.pickDirectory({ purpose });
    if (!selected) return;
    if (purpose === "backup") state.backupRoot = selected;
    else { state.restoreBackup = null; state.restoreBackup = { ...await invokeCommand("inspect_backup", { backupRoot: selected }), backupRoot: selected }; }
  } catch (error) { state.protectionError = `Could not use that backup folder: ${error.message ?? error}`; }
  finally { state.protectionChoosing = false; render(); }
}

async function locateInstallation() {
  if (!isDesktopRuntime() || state.previewMode || state.protectionChoosing || state.launcher?.busy || state.launcherAction) return;
  state.protectionChoosing = true; state.launcherError = "";
  render();
  try {
    const installRoot = await window.frameDesktop.pickDirectory({ purpose: "deployment" });
    if (!installRoot) return;
    acceptLauncherStatus(await invokeCommand("locate_installation", { installRoot }));
    state.activeInstallRoot = installRoot;
  } catch (error) { state.launcherError = `Could not reconnect to this installation: ${error.message ?? error}`; }
  finally { state.protectionChoosing = false; render(); }
}

async function protectionAction(action) {
  if (!isDesktopRuntime() || state.previewMode || state.confirmAction !== action || !protectionAllowed(action) || state.protectionChoosing || state.launcher?.busy || state.launcherAction || state.installing) return;
  const install = currentInstallation();
  const args = { confirmed: true, ...(action === "restore_backup" ? { backupRoot: state.restoreBackup.backupRoot } : { installRoot: install.installRoot }), ...(action === "backup_stack" ? { backupRoot: state.backupRoot } : {}) };
  state.launcherAction = action; state.confirmAction = null; state.protection = null; state.protectionError = "";
  render();
  try {
    acceptLauncherStatus(await invokeCommand(action, args));
    if (action === "restore_backup" && state.protection?.success) state.activeInstallRoot = state.restoreBackup.workspace;
    if (action === "backup_stack" && (state.protection?.success || state.protection?.backupComplete)) state.backupRoot = "";
  } catch (error) { state.protectionError = `FRAME could not finish the operation: ${error.message ?? error}. Recheck status before retrying.`; }
  finally { state.launcherAction = ""; render(); }
}

async function supportAction(action) {
  if (!["preview", "copy", "save"].includes(action) || !isDesktopRuntime() || state.previewMode || state.supportBusy || state.launcher?.busy || state.launcherAction || state.installing) return;
  state.supportBusy = true; state.supportError = ""; state.supportMessage = "";
  render();
  try {
    if (action === "preview") { state.supportReport = await invokeCommand("get_diagnostics", {}); state.supportMessage = "Report ready to review."; }
    else {
      const result = await window.frameDesktop.exportReport(action);
      state.supportReport = result.report;
      state.supportMessage = !result.completed ? "Save canceled." : action === "copy" ? "Diagnostic report copied." : "Support report saved.";
    }
  } catch (error) { state.supportError = `Could not prepare the report: ${error.message ?? error}`; }
  finally { state.supportBusy = false; render(); }
}

function renderPreferences() {
  const prefs = state.preferences;
  return `<section class="panel"><p class="eyebrow">This launcher</p><h1>Preferences</h1><p>These settings control the launcher window, not whether FRAME services start after a reboot.</p>
    ${state.preferencesError ? `<p class="stage-alert" role="alert">${escapeHtml(state.preferencesError)}</p>` : ""}
    ${prefs ? [["keepInTray", `Keep the launcher in the ${hostPlatform() === "darwin" ? "menu bar" : "system tray"} when I close the window`, prefs.trayAvailable !== false], ["notifications", "Show notifications for FRAME status and available updates", true], ["startAtLogin", "Open the launcher when I sign in", prefs.startAtLoginSupported], ["checkUpdatesAutomatically", "Check for updates periodically", true]].map(([key, label, supported]) => `<label class="launcher-preference"><input type="checkbox" data-preference="${key}" ${prefs[key] ? "checked" : ""} ${state.previewMode || state.preferencesSaving || !supported ? "disabled" : ""} /><span>${label}${key === "checkUpdatesAutomatically" ? '<small>Checks once a day while the launcher is open or in the tray. Updates are installed only when you choose.</small>' : ""}${!supported ? `<small>${key === "startAtLogin" ? hostPlatform() === "linux" ? "Startup at sign-in is not available on Linux." : "Available in the packaged Windows and macOS launcher." : "Not available on this system."}</small>` : ""}</span></label>`).join("") : "<p>Preferences are not available yet.</p>"}
    <button class="button" type="button" data-screen="updates">Updates & repair</button>
    <p class="launcher-caption">Closing or quitting the launcher does not stop FRAME. Use Stop FRAME on Home when you want to interrupt its services.</p></section>`;
}

function applyDefaults(defaults) {
  if (!defaults) return;
  state.defaults = { ...state.defaults, ...defaults };
  if (!state.existingInstall) {
    if (!state.installRoot) state.installRoot = state.defaults.installRoot;
    if (!state.dataRoot) state.dataRoot = state.defaults.dataRoot;
  }
}

function acceptLauncherStatus(status) {
  if (!status || !Array.isArray(status.installations)) throw new Error("FRAME status could not be read. Recheck before changing services.");
  state.launcher = status;
  if (Object.hasOwn(status, "updates")) state.updates = status.updates;
  if (status.maintenance) state.maintenance = status.maintenance;
  if (status.protection) state.protection = status.protection;
  if (status.readiness?.installRoot && Array.isArray(status.readiness.checks)) state.lastReadiness = status.readiness;
  if (!status.busy) state.startupPending = false;
  state.launcherError = "";
  applyDefaults(status.defaults);
}

async function initializeLauncher() {
  if (isDesktopRuntime()) {
    for (const eventName of ["launcher-progress", "launcher-status", "launcher-preferences", "launcher-updates"]) {
      try {
        await window.frameDesktop.listen(eventName, (event) => {
          const payload = event?.payload ?? event;
          if (eventName === "launcher-progress") { acceptLauncherProgress(payload); return; }
          if (eventName === "launcher-updates") { state.updates = payload; state.updatesError = ""; if (["home", "updates"].includes(state.screen)) render(); return; }
          if (eventName === "launcher-status") {
            try { acceptLauncherStatus(payload); } catch (error) { state.launcherError = String(error.message ?? error); }
          } else state.preferences = payload;
          if (eventName === "launcher-status" ? ["home", "my-setup", "updates", "backups"].includes(state.screen) : state.screen === "preferences") render();
        });
      } catch { /* Older hosts still support explicit status refresh. */ }
    }
  }
  await refreshLauncherStatus();
  await loadSetupDraft();
  await refreshHostStatus({ quiet: true });
  await loadLauncherPreferences();
  state.launcherInitializing = false;
  render();
}

async function refreshLauncherStatus() {
  const generation = ++state.launcherGeneration;
  state.launcherLoading = true;
  render();
  try {
    const status = await invokeCommand("get_launcher_status", {});
    if (generation === state.launcherGeneration) {
      acceptLauncherStatus(status);
      if (state.startupProgress?.phase === "failed") state.startupProgress = null;
    }
  } catch (error) {
    if (generation === state.launcherGeneration) state.launcherError = `Could not check FRAME: ${error.message ?? error}`;
  } finally {
    if (generation === state.launcherGeneration) state.launcherLoading = false;
    render();
  }
}

async function runLauncherAction(action) {
  const install = currentInstallation();
  const permission = { start_stack: "canStart", stop_stack: "canStop", recover_stack: "canRecover", update_stack: "canUpdate", repair_stack: "canRepair" }[action];
  if (!isDesktopRuntime() || state.previewMode || !permission || !install?.[permission] || state.launcherAction || state.launcher?.busy || state.launcherLoading || state.launcherError) return;
  const releaseTag = state.updates?.installRoot === install.installRoot && state.updates.frame?.available && state.updates.frame?.eligible ? state.updates.frame.tag : null;
  if (action === "update_stack" && !releaseTag) return;
  state.confirmAction = null;
  state.launcherAction = action;
  if (["update_stack", "repair_stack"].includes(action)) state.maintenance = null;
  state.activeInstallRoot = install.installRoot;
  state.startupProgress = null;
  state.startupPending = action === "start_stack";
  const generation = ++state.launcherGeneration;
  const logStream = await startInstallLogListener();
  render();
  try {
    await draftWrites;
    acceptLauncherStatus(await invokeCommand(action, { installRoot: install.installRoot, ...(action === "update_stack" ? { releaseTag } : {}) }));
    if (action === "start_stack") {
      const observed = currentInstallation();
      state.startupProgress = { ...state.startupProgress, installRoot: install.installRoot,
        phase: observed?.state === "running" && state.startupProgress?.phase !== "failed" ? "complete" : "failed",
        services: observed?.services ?? state.startupProgress?.services ?? [], detail: observed?.detail };
    }
  } catch (error) {
    state.launcherError = `FRAME action failed: ${error.message ?? error}. Recheck its state before retrying.`;
    addLog(state.launcherError);
    if (action === "start_stack") state.startupProgress = { ...state.startupProgress, installRoot: install.installRoot, phase: "failed", services: state.startupProgress?.services ?? install.services ?? [], detail: "The startup command failed. Recheck before retrying." };
    state.launcherGeneration = generation;
  } finally {
    state.launcherAction = "";
    state.startupPending = false;
    logStream.stop();
    render();
  }
}

function bindLauncherEvents() {
  document.querySelectorAll("[data-screen]").forEach((button) => button.addEventListener("click", () => {
    if (state.installing) return;
    if (state.screen === "setup") { invalidatePreflight(); state.credentials = emptyCredentials(); }
    state.screen = button.dataset.screen;
    state.confirmAction = null;
    render();
  }));
  document.querySelector("[data-new-setup]")?.addEventListener("click", beginSetup);
  document.querySelector("[data-recheck]")?.addEventListener("click", refreshLauncherStatus);
  document.querySelector("[data-check-updates]")?.addEventListener("click", checkForUpdates);
  document.querySelectorAll("[data-support-action]").forEach((button) => button.addEventListener("click", () => supportAction(button.dataset.supportAction)));
  document.querySelector("[data-locate-installation]")?.addEventListener("click", locateInstallation);
  document.querySelectorAll("[data-protection-pick]").forEach((button) => button.addEventListener("click", () => chooseProtectionFolder(button.dataset.protectionPick)));
  document.querySelectorAll("[data-protection-action]").forEach((button) => button.addEventListener("click", () => { state.confirmAction = button.dataset.protectionAction; render(); document.querySelector("#protection-confirmation")?.focus(); }));
  document.querySelector("[data-protection-confirm]")?.addEventListener("click", () => protectionAction(state.confirmAction));
  document.querySelectorAll("[data-update-link]").forEach((button) => button.addEventListener("click", async () => {
    try { if (isDesktopRuntime()) await window.frameDesktop.openExternal(button.dataset.updateLink); }
    catch (error) { state.updatesError = `Could not open the release page: ${error.message ?? error}`; render(); }
  }));
  document.querySelector("[data-open-dashboard]")?.addEventListener("click", () => openSetup({ url: portalUrl() }));
  document.querySelector("[data-docker-guide]")?.addEventListener("click", openDockerGuide);
  document.querySelector("[data-change-setup]")?.addEventListener("click", () => reconfigureInstall(currentInstallation()?.installRoot));
  document.querySelector("[data-open-data]")?.addEventListener("click", async () => {
    try { await invokeCommand("open_data_folder", { installRoot: currentInstallation()?.installRoot }); }
    catch (error) { state.launcherError = `Could not open the data folder: ${error.message ?? error}`; render(); }
  });
  document.querySelectorAll("[data-stack-action]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.stackAction;
    if (action === "start_stack") void runLauncherAction(action);
    else { state.confirmAction = action; render(); }
  }));
  document.querySelector("[data-cancel-action]")?.addEventListener("click", dismissConfirmation);
  document.querySelector("[data-confirm-action]")?.addEventListener("click", () => runLauncherAction(state.confirmAction));
  document.querySelector("[data-continue-draft]")?.addEventListener("click", continueSetupDraft);
  document.querySelector("[data-discard-draft]")?.addEventListener("click", discardSetupDraft);
  document.querySelectorAll("[data-preference]").forEach((input) => input.addEventListener("change", () => saveLauncherPreference(input.dataset.preference, input.checked)));
}

function dismissConfirmation() {
  if (!state.confirmAction || state.launcherAction || state.launcher?.busy || state.installing) return;
  state.confirmAction = null;
  render();
  document.querySelector('.launcher-nav [aria-current="page"]')?.focus();
}

document.addEventListener?.("keydown", (event) => {
  if (event.key === "Escape" && state.confirmAction) { event.preventDefault(); dismissConfirmation(); }
});

async function loadLauncherPreferences() {
  try { state.preferences = await invokeCommand("get_launcher_preferences", {}); }
  catch (error) { state.preferencesError = `Could not load preferences: ${error.message ?? error}`; }
  render();
}

async function saveLauncherPreference(key, value) {
  if (!isDesktopRuntime() || state.preferencesSaving || !["keepInTray", "notifications", "startAtLogin", "checkUpdatesAutomatically"].includes(key)) return;
  const preferences = Object.fromEntries(["keepInTray", "notifications", "startAtLogin", "checkUpdatesAutomatically"].map((name) => [name, Boolean(state.preferences?.[name])]));
  preferences[key] = value;
  state.preferencesSaving = true;
  state.preferencesError = "";
  render();
  try { state.preferences = await invokeCommand("set_launcher_preferences", { preferences }); }
  catch (error) { state.preferencesError = `Preferences were not saved: ${error.message ?? error}`; }
  finally { state.preferencesSaving = false; render(); }
}

function beginSetup() {
  if (state.launcherAction || state.launcherInitializing || state.launcher?.busy || hostCompatibilityIssue() || state.installing || state.pendingDraft) return;
  applyLoadedPlan({ mode: "", installRoot: state.defaults.installRoot, dataRoot: state.defaults.dataRoot });
  state.existingInstall = false;
  state.mode = "";
  state.stage = 0;
  state.screen = "setup";
  saveSetupDraft();
  render();
}

function setupDraft() {
  const plan = buildPlan();
  return { mode: plan.mode, deploymentMode: plan.deploymentMode, publicHostname: plan.publicHostname,
    installRoot: plan.installRoot, dataRoot: plan.dataRoot, selectedServices: plan.selectedServices,
    ports: plan.ports, autoPorts: false, subfolders: plan.subfolders,
    advancedSettings: Object.fromEntries(ADVANCED_VALUE_FIELDS.map((field) => [field.key, plan.advancedSettings[field.key] ?? field.defaultValue])),
    stage: Math.min(5, state.stage) };
}

function saveSetupDraft() {
  if (!isDesktopRuntime() || state.screen !== "setup" || state.installing || state.installStatus === "complete") return draftWrites;
  const draft = setupDraft();
  state.pendingDraft = draft;
  if (state.preflightRunning) return draftWrites;
  draftWrites = draftWrites.then(() => invokeCommand("save_draft", { draft })).then(() => { state.draftError = ""; syncDraftError(); }, (error) => {
    state.draftError = `Setup progress was not saved: ${error.message ?? error}`;
    syncDraftError();
    if (state.screen !== "setup") render();
  });
  return draftWrites;
}

function syncDraftError() {
  const notice = document.querySelector("[data-draft-error]");
  if (notice) notice.textContent = state.draftError;
}

async function loadSetupDraft() {
  try { state.pendingDraft = (await invokeCommand("load_draft", {}))?.draft ?? null; }
  catch (error) { state.draftError = `Saved setup could not be read: ${error.message ?? error}`; }
  finally { state.draftLoading = false; render(); }
}

async function discardSetupDraft() {
  if (!isDesktopRuntime()) return;
  draftWrites = draftWrites.then(() => invokeCommand("clear_draft", {}));
  try { await draftWrites; state.pendingDraft = null; state.draftError = ""; }
  catch (error) { state.draftError = `Saved setup could not be cleared: ${error.message ?? error}`; draftWrites = Promise.resolve(); }
  render();
}

async function continueSetupDraft() {
  const draft = state.pendingDraft;
  if (!draft || state.installing || state.launcherInitializing || state.launcher?.busy || state.launcherAction) return;
  try {
    await draftWrites;
    const existing = state.launcher?.installations?.find((install) => install.installRoot === draft.installRoot);
    if (existing) {
      if (!existing.canReconfigure) throw new Error("This installation cannot be changed yet. Resolve its status on Home first.");
      const installed = await invokeCommand("load_install_plan", { installRoot: existing.installRoot });
      applyLoadedPlan({ ...installed, ...draft, installRoot: installed.installRoot, dataRoot: installed.dataRoot });
    } else {
      applyLoadedPlan(draft);
      state.existingInstall = false;
      state.guidedReviewedServices = Object.fromEntries(SERVICES.map((service) => [service.id, draft.mode === "quick"]));
      state.guidedServiceIndex = 0;
      if (!draft.mode) state.mode = "";
    }
    state.stage = Math.max(0, Math.min(5, Number.isInteger(draft.stage) ? draft.stage : 0));
    state.screen = "setup";
    state.credentials = emptyCredentials();
    invalidatePreflight();
  } catch (error) { state.draftError = `Could not continue setup: ${error.message ?? error}`; }
  render();
}

function renderStageItem(stage, index) {
  const status = stageStatus(index);
  return `
    <li class="stage-item ${status}">
      <span class="stage-number">${index + 1}</span>
      <span>
        <strong>${stage}${status === "complete" ? " <span class=\"stage-check\" aria-label=\"Complete\">&#10003;</span>" : ""}</strong>
        ${status === "complete" ? "" : `<small>${stageStatusLabel(status)}</small>`}
      </span>
    </li>
  `;
}

function stageStatus(index) {
  if (state.stage === index) return "active";
  if (index < state.stage) return "complete";
  return "locked";
}

function stageStatusLabel(status) {
  if (status === "active") return "Current";
  if (status === "complete") return "Done";
  return "Locked";
}

function renderCurrentStage() {
  switch (state.stage) {
    case 0:
      return renderWelcomeStage();
    case 1:
      return renderModePanel();
    case 2:
      return renderStoragePanel();
    case 3:
      return renderServicesPanel();
    case 4:
      return renderPortsPanel();
    case 5:
      return renderReviewPanel();
    case 6:
      return renderLaunchPanel();
    default:
      return renderWelcomeStage();
  }
}

function stepPageClass() {
  return state.animateStage ? "step-page animate" : "step-page";
}

function renderWelcomeStage() {
  const checks = state.hostStatus?.checks ?? [];
  const detected = state.detectedInstallations ?? [];
  const blockingChecks = dockerBlockingChecks();
  const compatibility = hostCompatibilityIssue();
  return `
    <section class="hero ${stepPageClass()}">
      <div>
        <p class="eyebrow">Welcome to FRAME</p>
        <h1>Set up your IRL streamer toolkit.</h1>
        <p>
          This online installer downloads an official FRAME release and its prebuilt container images,
          then returns to the launcher so you can open the FRAME dashboard. Internet access is required.
        </p>
      </div>
      <div class="hero-card">
        <strong>What this app handles</strong>
        <p>Docker readiness, storage selection, exposed ports, previous installs, and launching the web GUI.</p>
      </div>
    </section>
    <section class="panel">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Host check</p>
          <h2>Before we begin</h2>
          <p>${dockerGuidance().instructions} FRAME requires native Linux AMD64 or ARM64 images matching the local engine.</p>
        </div>
        <button class="button" id="refresh-host" type="button">Recheck</button>
      </div>
      ${compatibility ? `<div class="hard-stop" role="alert"><strong>${escapeHtml(compatibility.title)}</strong><p>${escapeHtml(compatibility.detail)}</p></div>` : blockingChecks.length ? `
        <div class="hard-stop">
          <strong>Docker setup is required before continuing.</strong>
          <p>${dockerGuidance().instructions} Then press Recheck. FRAME will keep the next step locked until this clears.</p>
        </div>
      ` : ""}
      <div class="check-grid">
        ${checks.length ? checks.map(renderCheckCard).join("") : "<p class=\"card\">Checking host readiness...</p>"}
      </div>
      <h3 style="margin-top: 18px;">Previous installations</h3>
      <div class="detected-grid">
        ${detected.length ? detected.map(renderDetectedInstall).join("") : "<p class=\"card\">No previous FRAME install was detected yet.</p>"}
      </div>
    </section>
  `;
}

function renderModePanel() {
  return `
    <section class="panel ${stepPageClass()}">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Setup path</p>
          <h2>Choose how much detail you want.</h2>
          <p>Pick one path for this install. You can go back later, but the next step stays locked until a choice is made.</p>
        </div>
      </div>
      ${renderStageNotice(1)}
      <div class="mode-grid">
        ${SETUP_MODES.map((mode) => `
          <button class="card choice-card ${state.mode === mode.id ? "selected" : ""}" data-mode="${mode.id}" type="button" aria-pressed="${state.mode === mode.id}">
            <span>${mode.eyebrow}</span>
            <h3>${mode.label}</h3>
            <p>${mode.summary}</p>
          </button>
        `).join("")}
      </div>
    </section>
  `;
}

function renderStoragePanel() {
  const hasRoot = Boolean(state.dataRoot.trim());
  return `
    <section class="panel ${stepPageClass()}">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Storage</p>
          <h2>Choose where FRAME keeps your data.</h2>
          <p>Photos, galleries, and persistent settings use this folder. Deployment files are managed separately by the launcher; Docker keeps container images in its own storage.</p>
        </div>
        <span class="pill ${hasRoot ? "good" : "warn"}" data-storage-status>${hasRoot ? "Selected" : "Required"}</span>
      </div>
      ${renderStageNotice(2)}
      <div class="folder-picker">
        <div>
          <span>FRAME data folder</span>
          <strong data-storage-path>${escapeHtml(state.dataRoot || "Waiting for the default data folder")}</strong>
          <p>${state.existingInstall ? "This installation keeps its existing data location. Moving data is a separate operation." : state.previewMode ? "This is a simulated path. Use the desktop launcher to choose a real folder." : "Keep the suggested folder or choose a disk with enough room for your photos and media."}</p>
        </div>
        <div class="button-row">
          ${!state.existingInstall ? `<button class="button primary" id="choose-folder" type="button" ${state.previewMode ? "disabled" : ""}>Choose data folder</button>` : ""}
        </div>
      </div>
      ${state.mode === "advanced" ? `
        <p>Standard data folders are managed by the shared installer; custom subfolder layouts are not supported here.</p>
        <div class="subfolder-grid">
          ${SUBFOLDERS.map((folder) => `
            <label class="field">
              <span>${folder}</span>
              <input value="${escapeHtml(state.subfolders[folder])}" readonly />
            </label>
          `).join("")}
        </div>
      ` : ""}
    </section>
  `;
}

function renderServicesPanel() {
  if (state.mode === "guided") return renderGuidedServicePanel();

  return `
    <section class="panel ${stepPageClass()}">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Services</p>
          <h2>${state.mode === "quick" ? "Quick Start enables the recommended stack." : "Add the tools this install needs."}</h2>
          <p>${state.existingInstall ? "Your installed choices are preserved. Switch setup path if you want to edit the selection." : "FRAME routes your tools through one dashboard. Network details come next."}</p>
        </div>
        <span class="pill ${selectedServiceCount() ? "good" : "warn"}">${selectedServiceCount()} selected</span>
      </div>
      ${renderStageNotice(3)}
      <div class="service-grid">
        ${SERVICES.filter((service) => state.existingInstall || state.mode !== "quick" || !service.hybridOnly).map((service) => `
          <article class="service-card">
            <label>
              <input type="checkbox" data-service="${service.id}" ${state.selectedServices[service.id] ? "checked" : ""} ${state.mode === "quick" ? "disabled" : ""} />
              <div>
                <span>${service.id}</span>
                <h3>${service.label}</h3>
                <p>${service.summary}</p>
                ${service.hybridOnly ? "<small>Selecting this service also selects Hybrid mode.</small>" : ""}
              </div>
            </label>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderGuidedServicePanel() {
  const service = SERVICES[state.guidedServiceIndex] ?? SERVICES[0];
  const reviewedCount = Object.values(state.guidedReviewedServices).filter(Boolean).length;
  const serviceNumber = state.guidedServiceIndex + 1;
  return `
    <section class="panel ${stepPageClass()}">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Service by service</p>
          <h2>${escapeHtml(service.label)}</h2>
          <p>Service ${serviceNumber} of ${SERVICES.length}. Decide if this machine should install it, then continue to the next service.</p>
        </div>
        <span class="pill ${guidedServiceReviewComplete() ? "good" : "warn"}">${reviewedCount}/${SERVICES.length} reviewed</span>
      </div>
      ${renderStageNotice(3)}
      <article class="service-detail-card">
        <div class="service-detail-copy">
          <span>${escapeHtml(service.id)}</span>
          ${renderGuidedServiceInfo(service)}
        </div>
        <label class="service-toggle">
          <input type="checkbox" data-guided-service="${service.id}" ${state.selectedServices[service.id] ? "checked" : ""} />
          <strong>Install this service</strong>
          <small>${service.hybridOnly
            ? (state.selectedServices[service.id] ? "Enabled with Hybrid mode." : "Selecting this service also selects Hybrid mode.")
            : (state.selectedServices[service.id] ? "Enabled for this FRAME install." : "Leave unchecked to skip it for this install.")}</small>
        </label>
      </article>
      ${renderGuidedServiceSettings(service)}
    </section>
  `;
}

function renderGuidedServiceSettings(service) {
  const keys = SERVICE_ADVANCED_FIELDS[service.id] ?? [];
  if (!keys.length) return "";
  return `
    <article class="guided-settings-card">
      <div>
        <span>Service limits</span>
        <h3>Configure this now, or change it later in Advanced setup.</h3>
      </div>
      <div class="guided-settings-grid">
        ${keys.map((key) => {
          const field = ADVANCED_VALUE_FIELDS.find((candidate) => candidate.key === key);
          const description = ADVANCED_SETTINGS.find(([settingKey]) => settingKey === key)?.[1] ?? "";
          if (!field) return "";
          return `
            <div class="guided-setting">
              ${renderAdvancedInput(field)}
              <p>${escapeHtml(description)}</p>
            </div>
          `;
        }).join("")}
      </div>
    </article>
  `;
}

function renderGuidedServiceInfo(service) {
  const details = service.guided ?? {
    what: service.summary,
    why: "This service adds one part of the FRAME toolkit.",
    ports: "Port requirements depend on the selected service.",
    setup: "the FRAME dashboard will walk through the remaining configuration.",
  };
  return `
    ${renderInfoBlock("What it does", details.what)}
    ${renderInfoBlock("Why you might want it", details.why)}
    ${renderInfoBlock("Ports and exposure", details.ports)}
    ${renderInfoBlock("What comes next in FRAME", details.setup)}
  `;
}

function renderInfoBlock(title, body) {
  return `
    <section class="service-info-block">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(body)}</p>
    </section>
  `;
}

function renderPortsPanel() {
  const visiblePorts = exposedPortsForSelection();
  const hybrid = state.deploymentMode === "HYBRID";
  const hostnameStatus = publicHostnameValidation();
  const relayHostStatus = publicRelayHostValidation();
  const ftpHostStatus = photoFtpHostValidation();
  const portStatus = portValidation();
  const stageNotice = validationMessageForVisibleStage(4);
  const showStageNotice = stageNotice &&
    stageNotice !== hostnameStatus.message &&
    stageNotice !== relayHostStatus.message &&
    stageNotice !== ftpHostStatus.message &&
    stageNotice !== portStatus.message;
  return `
    <section class="panel ${stepPageClass()}">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Network</p>
          <h2>${state.mode === "quick" ? "Connect your tools on the network." : "Confirm the ports exposed on the host."}</h2>
          <p>${state.mode === "quick" ? "Quick Start uses default ports for new installations and retains installed settings when reconfiguring. If a port conflicts, switch to Guided or Advanced to choose another." : "These are the host ports published by the selected services. If a port is occupied, choose another value and rerun readiness checks."}</p>
        </div>
      </div>
      <div class="network-controls ${hybrid ? "hybrid" : "lan"}">
        <label class="field">
          <span>Deployment mode</span>
          <select id="deployment-mode" ${state.mode === "quick" ? "disabled" : ""}>
            <option value="LAN" ${state.deploymentMode === "LAN" ? "selected" : ""} ${state.selectedServices["frame-belabox-manager"] ? "disabled" : ""}>LAN</option>
            <option value="HYBRID" ${state.deploymentMode === "HYBRID" ? "selected" : ""}>Hybrid with Cloudflare</option>
          </select>
          ${state.selectedServices["frame-belabox-manager"] ? "<small>Belabox Manager requires Hybrid mode and a public WSS endpoint.</small>" : ""}
        </label>
        ${hybrid ? `
          <label class="field ${hostnameStatus.status === "bad" ? "invalid" : ""}">
            <span>Public hostname</span>
            <input id="public-hostname" value="${escapeHtml(state.publicHostname)}" placeholder="frame.example.com" />
          </label>
        ` : ""}
        ${state.selectedServices["frame-video-relay"] ? `
          <label class="field ${relayHostStatus.status === "bad" ? "invalid" : ""}">
            <span>Advertised SRTLA host</span>
            <input
              id="public-relay-host"
              value="${escapeHtml(state.advancedSettings.PUBLIC_RELAY_HOST ?? "")}"
              placeholder="relay.example.com or 203.0.113.10"
            />
          </label>
        ` : ""}
        ${state.selectedServices["frame-photo-ftp"] ? `
          <label class="field ${ftpHostStatus.status === "bad" ? "invalid" : ""}">
            <span>Photo FTP host address</span>
            <input id="ftp-passive-host" data-advanced-setting="PHOTO_FTP_PASSIVE_HOST" value="${escapeHtml(state.advancedSettings.PHOTO_FTP_PASSIVE_HOST ?? "")}" placeholder="192.168.1.10" />
          </label>
        ` : ""}
      </div>
      <div class="network-validation">
        ${hybrid ? `<small class="field-help ${hostnameStatus.status}" data-public-host-status>${hostnameStatus.message}</small>` : ""}
        ${state.selectedServices["frame-video-relay"] ? `<small class="field-help ${relayHostStatus.status}" data-public-relay-host-status>${relayHostStatus.message}</small>` : ""}
        ${state.selectedServices["frame-photo-ftp"] ? `<small class="field-help ${ftpHostStatus.status}" data-ftp-host-status>${ftpHostStatus.message}</small>` : ""}
        ${showStageNotice ? renderStageNotice(4, "compact") : ""}
        <small class="field-help ${portStatus.status}" data-port-status>${portStatus.message}</small>
      </div>
      ${state.mode === "quick" ? '<details class="network-port-details"><summary>View published ports</summary>' : ""}
      <div class="port-grid">
        ${visiblePorts.map((port) => `
          <article class="port-card ${portStatus.invalidKeys.includes(port.key) ? "invalid" : ""}">
            <div>
              <strong>${port.label}</strong>
              <span>${port.protocol.toUpperCase()} / ${port.env}</span>
            </div>
            <label class="field">
              <span>Value</span>
              <input
                data-port="${port.key}"
                type="number"
                min="1"
                max="65535"
                step="1"
                inputmode="numeric"
                value="${escapeHtml(String(state.ports[port.key]))}"
                ${state.mode === "quick" ? "readonly" : ""}
              />
            </label>
          </article>
        `).join("")}
      </div>
      ${state.mode === "quick" ? "</details>" : ""}
    </section>
  `;
}

function renderReviewPanel() {
  const checks = state.preflight?.checks ?? [];
  const detected = state.detectedInstallations ?? [];
  return `
    <section class="panel ${stepPageClass()}">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Review</p>
          <h2>Review the plan before launch.</h2>
          <p>Review the configuration, then run readiness checks from the footer. Install unlocks only after checks pass.</p>
        </div>
      </div>
      ${renderStageNotice(5)}
      <div class="summary-grid">
        ${renderSummaryCard("Mode", setupModeLabel())}
        ${renderSummaryCard("FRAME data", state.dataRoot || "Not selected")}
        ${renderSummaryCard("Services", `${selectedServiceCount()} selected`)}
        ${renderSummaryCard("Dashboard", setupUrl())}
      </div>
      <p class="deployment-location">Deployment files: ${escapeHtml(state.installRoot || "Waiting for the managed deployment folder")}. Docker image storage is separate.</p>
      ${renderCredentialsPanel()}
      ${state.mode === "advanced" ? renderAdvancedPanel() : ""}
      <h3 style="margin-top: 18px;">Readiness results</h3>
      <div class="check-grid" data-preflight-results aria-live="polite">
        ${checks.length ? checks.map(renderCheckCard).join("") : `<p class="card" role="status">${state.preflightRunning ? "Checking Docker, storage, configuration, and host ports..." : "Run readiness checks to unlock Install."}</p>`}
      </div>
      <h3 style="margin-top: 18px;">Previous installations</h3>
      <div class="detected-grid">
        ${detected.length ? detected.map(renderDetectedInstall).join("") : "<p class=\"card\">No previous FRAME install was detected yet.</p>"}
      </div>
    </section>
  `;
}

function renderCredentialsPanel() {
  const fields = [
    ["portalUsername", "Operator username", "text"],
    ["portalPassword", "Operator password", "password"],
    ...(state.deploymentMode === "HYBRID" ? [["tunnelToken", "Cloudflare Tunnel token", "password"]] : []),
  ];
  return `
    <section class="advanced-section">
      <h3>Installation credentials</h3>
      <p>${state.existingInstall ? "Leave both operator fields empty to keep your login. Enter both to replace it. Leave the Cloudflare token empty to keep the existing connection." : "Set your operator login. Hybrid mode also requires a Cloudflare Tunnel token."} Credentials are excluded from saved installer plans and used only to prepare and apply this installation.</p>
      <div class="subfolder-grid">
        ${fields.map(([key, label, type]) => `<label class="field"><span>${label}</span><input data-credential="${key}" type="${type}" autocomplete="off" value="${escapeHtml(state.credentials[key])}" /></label>`).join("")}
      </div>
    </section>`;
}

function renderSummaryCard(label, value) {
  return `
    <article class="card summary-card">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `;
}

function renderAdvancedPanel() {
  return `
    <div class="advanced-section">
      <div class="panel-heading compact">
        <div>
          <p class="eyebrow">Advanced</p>
          <h2>Environment settings map.</h2>
          <p>Photo throughput fields are editable here. The remaining cards explain the generated .env model.</p>
        </div>
      </div>
      <div class="advanced-grid">
        ${ADVANCED_SETTINGS.map(([key, description]) => renderAdvancedCard(key, description)).join("")}
      </div>
    </div>
  `;
}

function renderAdvancedCard(key, description) {
  const field = ADVANCED_VALUE_FIELDS.find((candidate) => candidate.key === key);
  return `
    <article class="advanced-card">
      <span>${key}</span>
      <p>${description}</p>
      ${field ? renderAdvancedInput(field) : ""}
    </article>
  `;
}

function renderAdvancedInput(field) {
  if (field.type === "text") {
    return `
      <label class="field advanced-field">
        <span>${field.label}</span>
        <input
          data-advanced-setting="${field.key}"
          type="text"
          value="${escapeHtml(state.advancedSettings[field.key] ?? field.defaultValue)}"
          placeholder="${escapeHtml(field.placeholder ?? "")}"
        />
      </label>
    `;
  }
  return `
    <label class="field advanced-field">
      <span>${field.label}</span>
      <input
        data-advanced-setting="${field.key}"
        type="number"
        inputmode="numeric"
        min="${field.min}"
        max="${field.max}"
        step="1"
        value="${escapeHtml(state.advancedSettings[field.key] ?? field.defaultValue)}"
      />
    </label>
  `;
}

function renderCheckCard(check) {
  return `
    <article class="check-card">
      <span class="pill ${check.status}">${({ good: "Ready", warn: "Warning", bad: "Needs attention" })[check.status] || "Unknown"}</span>
      <strong>${escapeHtml(check.label)}</strong>
      <p>${escapeHtml(check.detail)}</p>
    </article>
  `;
}

function renderDetectedInstall(install) {
  const canReconfigure = Boolean(install.canReconfigure && install.installRoot);
  return `
    <article class="detected-card ${canReconfigure ? "actionable" : ""}">
      <span>${escapeHtml(install.source)}</span>
      <strong>${escapeHtml(canReconfigure ? install.detail : install.source)}</strong>
      ${install.updatedAt ? `<p>Last updated ${escapeHtml(formatDetectedDate(install.updatedAt))}</p>` : ""}
      ${install.setupMode ? `<p>Setup path: ${escapeHtml(setupModeName(install.setupMode))}</p>` : ""}
      ${install.setupUrl ? `<p>Setup URL: ${escapeHtml(install.setupUrl)}</p>` : ""}
      ${!canReconfigure ? `<p>${escapeHtml(install.detail)}</p>` : ""}
      ${canReconfigure ? `
        <button class="button ghost detected-action" data-reconfigure-root="${escapeHtml(install.installRoot)}" type="button">
          Reconfigure this install
        </button>
      ` : ""}
    </article>
  `;
}

function renderStageNotice(stage, variant = "") {
  const message = validationMessageForVisibleStage(stage);
  if (!message) return "";
  return `
    <div class="stage-alert ${variant}">
      ${escapeHtml(message)}
    </div>
  `;
}

function validationMessageForVisibleStage(stage) {
  return state.validationStage === stage ? state.validationMessage : "";
}

function renderLaunchPanel() {
  const setup = state.lastSetupUrl || setupUrl();
  return `
    <section class="panel ${stepPageClass()}">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Ready</p>
          <h2>${state.existingInstall ? "Apply your setup changes." : "Install FRAME."}</h2>
          <p>This writes the configuration and waits for service health checks. Installation may download release images. Changes to an existing installation can interrupt active FRAME work.</p>
        </div>
      </div>
      <div class="summary-grid">
        ${renderSummaryCard("Mode", setupModeLabel())}
        ${renderSummaryCard("FRAME data", state.dataRoot || "Not selected")}
        ${renderSummaryCard("Services", `${selectedServiceCount()} selected`)}
        ${renderSummaryCard("Dashboard", setup)}
      </div>
      <div class="install-action-panel">
        <strong>${installStatusTitle()}</strong>
        <p>${installStatusCopy()}</p>
      </div>
      ${state.installing || state.startupProgress?.installRoot === state.installRoot && state.startupProgress?.phase === "failed" ? renderContainerStartup(state.startupProgress || { phase: "starting", services: [] }) : ""}
      <pre class="log">${escapeHtml(state.log.join("\n"))}</pre>
    </section>
  `;
}

function renderFooter() {
  const isInstallStage = state.stage === SETUP_STAGES.length - 1;
  const guided = state.stage === 3 && state.mode === "guided";
  const hardStopNext = state.preflightRunning || (state.stage === 0 && !hostReadyForInstall());
  return `
    <div class="footer-actions">
      <button class="button ghost" id="${guided && state.guidedServiceIndex > 0 ? "previous-service" : "previous-stage"}" type="button" ${state.stage === 0 ? "disabled" : ""}>${guided && state.guidedServiceIndex > 0 ? "Previous service" : "Back"}</button>
      <div class="button-row">
        <small data-draft-error role="alert">${escapeHtml(state.draftError)}</small>
        ${state.stage === 0 ? "<button class=\"button\" id=\"docker-guide\" type=\"button\">Docker install guide</button>" : ""}
        ${isInstallStage ? renderInstallFooterActions() : `
          <button class="button primary" id="${guided ? "next-service" : "next-stage"}" type="button" ${hardStopNext ? "disabled" : ""}>
            ${guided ? (state.guidedServiceIndex === SERVICES.length - 1 ? "Continue" : "Next service") : nextButtonLabel()}
          </button>
        `}
      </div>
    </div>
  `;
}

function renderInstallFooterActions() {
  if (state.installStatus === "complete") {
    return `
      <button class="button primary install-frame-button" data-open-setup type="button">Launch FRAME Portal</button>
      <button class="button ghost" data-screen="home" type="button">Back to launcher</button>
    `;
  }

  return `
    <button class="button primary get-started install-frame-button" id="apply-install" type="button" ${state.installing || !readinessPassed() || !isDesktopRuntime() ? "disabled" : ""}>
      ${installButtonLabel()}
    </button>
  `;
}

function installButtonLabel() {
  if (state.installing) return "Installing...";
  if (state.installStatus === "failed") return "Retry Install";
  return state.existingInstall ? "Apply setup changes" : "Install FRAME";
}

function installStatusTitle() {
  if (state.installStatus === "running") return "Installing FRAME...";
  if (state.installStatus === "failed") return "Install needs attention";
  if (state.installStatus === "complete") return "FRAME is ready";
  return "Ready to apply";
}

function installStatusCopy() {
  if (state.installStatus === "running") {
    return "Downloading the official release, checking the host, pulling prebuilt images, and waiting for Docker Compose health checks.";
  }
  if (state.installStatus === "failed") {
    return "The install did not complete. Review the log, correct the issue, then return to Review and rerun readiness checks.";
  }
  if (state.installStatus === "complete") {
    return "Service health checks passed. Open the FRAME dashboard from the launcher when you are ready.";
  }
  return "The final button writes the selected configuration, starts FRAME, and waits for service health checks before returning to the launcher.";
}

function selectSetupMode(mode) {
  if (!SETUP_MODES.some((option) => option.id === mode)) return;
  state.mode = mode;
  if (!state.existingInstall && mode === "quick") {
    state.deploymentMode = "LAN";
    state.publicHostname = "";
    state.credentials.tunnelToken = "";
    state.advancedSettings.PUBLIC_RELAY_HOST = "";
    state.autoPorts = false;
    state.ports = Object.fromEntries(EXPOSED_PORTS.map((port) => [port.key, port.defaultValue]));
    state.selectedServices = defaultServiceSelection();
  }
  state.guidedReviewedServices = Object.fromEntries(SERVICES.map((service) => [service.id, state.existingInstall || mode === "quick"]));
  state.guidedServiceIndex = 0;
  clearValidation();
  invalidatePreflight();
  addLog(`Selected ${setupModeLabel()}.`);
  render();
}

function bindEvents() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => selectSetupMode(button.dataset.mode));
  });

  document.querySelector("#choose-folder")?.addEventListener("click", chooseFolder);
  document.querySelector("#refresh-host")?.addEventListener("click", () => refreshHostStatus({ quiet: false }));
  document.querySelector("#apply-install")?.addEventListener("click", applyInstall);
  document.querySelectorAll("[data-open-setup]").forEach((button) => {
    button.addEventListener("click", () => openSetup({ url: state.lastSetupUrl || setupUrl() }));
  });
  document.querySelectorAll("[data-reconfigure-root]").forEach((button) => {
    button.addEventListener("click", () => reconfigureInstall(button.dataset.reconfigureRoot));
  });
  document.querySelector("#docker-guide")?.addEventListener("click", openDockerGuide);
  document.querySelector("#previous-service")?.addEventListener("click", () => {
    clearValidation();
    state.guidedServiceIndex = Math.max(0, state.guidedServiceIndex - 1);
    saveSetupDraft();
    render();
  });
  document.querySelector("#next-service")?.addEventListener("click", () => {
    markCurrentGuidedServiceReviewed();
    clearValidation();
    if (state.guidedServiceIndex < SERVICES.length - 1) {
      state.guidedServiceIndex += 1;
    } else if (canProceedFromStage(3)) {
      state.animateStage = true;
      state.stage = Math.min(SETUP_STAGES.length - 1, state.stage + 1);
    } else {
      state.validationStage = 3;
      state.validationMessage = validationMessageForStage(3);
      addLog(state.validationMessage);
    }
    saveSetupDraft();
    render();
  });

  document.querySelector("#previous-stage")?.addEventListener("click", () => {
    if (state.installing) return;
    clearValidation();
    state.animateStage = true;
    state.stage = Math.max(0, state.stage - 1);
    saveSetupDraft();
    render();
  });
  document.querySelector("#next-stage")?.addEventListener("click", async () => {
    if (state.installing || state.preflightRunning) return;
    if (state.stage === SETUP_STAGES.length - 1) return;
    if (state.stage === 5 && !readinessPassed()) {
      await runPreflight();
      return;
    }
    if (!canProceedFromStage(state.stage)) {
      state.validationStage = state.stage;
      state.validationMessage = validationMessageForStage(state.stage);
      addLog(state.validationMessage);
      render();
      return;
    }
    clearValidation();
    state.animateStage = true;
    state.stage = Math.min(SETUP_STAGES.length - 1, state.stage + 1);
    saveSetupDraft();
    render();
  });

  document.querySelector("#deployment-mode")?.addEventListener("change", (event) => {
    state.deploymentMode = event.target.value;
    if (state.deploymentMode !== "HYBRID" && state.selectedServices["frame-belabox-manager"]) {
      state.selectedServices["frame-belabox-manager"] = false;
      addLog("Belabox Manager was disabled because it requires Hybrid mode.");
    }
    clearValidation();
    invalidatePreflight();
    render();
  });
  document.querySelector("#public-hostname")?.addEventListener("input", (event) => {
    state.publicHostname = event.target.value;
    clearValidation();
    invalidatePreflight();
    syncProgressControls();
  });
  document.querySelector("#public-relay-host")?.addEventListener("input", (event) => {
    state.advancedSettings.PUBLIC_RELAY_HOST = event.target.value;
    clearValidation();
    invalidatePreflight();
    syncProgressControls();
  });
  document.querySelectorAll("[data-service]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      state.selectedServices[checkbox.dataset.service] = checkbox.checked;
      if (checkbox.dataset.service === "frame-belabox-manager" && checkbox.checked) {
        state.deploymentMode = "HYBRID";
        addLog("Belabox Manager selected Hybrid mode for its public WSS connection.");
      }
      clearValidation();
      invalidatePreflight();
      render();
    });
  });
  document.querySelectorAll("[data-guided-service]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      state.selectedServices[checkbox.dataset.guidedService] = checkbox.checked;
      if (checkbox.dataset.guidedService === "frame-belabox-manager" && checkbox.checked) {
        state.deploymentMode = "HYBRID";
        addLog("Belabox Manager selected Hybrid mode for its public WSS connection.");
      }
      markCurrentGuidedServiceReviewed();
      clearValidation();
      invalidatePreflight();
      render();
    });
  });
  document.querySelectorAll("[data-port]").forEach((input) => {
    input.addEventListener("input", () => {
      const sanitized = numericPortInput(input.value);
      state.ports[input.dataset.port] = sanitized;
      if (input.value !== sanitized) input.value = sanitized;
      clearValidation();
      invalidatePreflight();
      syncProgressControls();
    });
  });
  document.querySelectorAll("[data-credential]").forEach((input) => {
    input.addEventListener("input", () => {
      state.credentials[input.dataset.credential] = input.value;
      clearValidation();
      invalidatePreflight();
      syncProgressControls();
    });
  });
  document.querySelectorAll("[data-advanced-setting]").forEach((input) => {
    input.addEventListener("input", () => {
      state.advancedSettings[input.dataset.advancedSetting] = input.value;
      clearValidation();
      invalidatePreflight();
      syncProgressControls();
    });
  });
}

async function chooseFolder() {
  try {
    if (!isDesktopRuntime() || state.existingInstall) return;
    const selected = await window.frameDesktop.pickDirectory({ defaultPath: state.dataRoot });
    if (typeof selected === "string") {
      state.dataRoot = selected;
      clearValidation();
      invalidatePreflight();
      addLog(`Selected FRAME data folder: ${selected}`);
    }
  } catch (error) {
    addLog(`Could not choose folder: ${error.message ?? error}`);
  }
  render();
}

async function reconfigureInstall(installRoot) {
  if (!installRoot || state.installing || state.launcher?.busy || state.launcherAction) return;
  invalidatePreflight();
  try {
    await draftWrites;
    const plan = await invokeCommand("load_install_plan", { installRoot });
    applyLoadedPlan(plan);
    state.activeInstallRoot = installRoot;
    state.stage = 5;
    state.screen = "setup";
    state.animateStage = true;
    addLog(`Loaded previous FRAME install from ${installRoot}.`);
    saveSetupDraft();
  } catch (error) {
    state.launcherError = `Could not load previous install: ${error.message ?? error}`;
    addLog(state.launcherError);
  }
  render();
}

function applyLoadedPlan(plan) {
  state.mode = normalizeSetupMode(plan.mode);
  state.installRoot = plan.installRoot ?? "";
  state.dataRoot = plan.dataRoot ?? "";
  state.deploymentMode = plan.deploymentMode ?? "LAN";
  state.publicHostname = plan.publicHostname ?? "";
  state.autoPorts = false;
  state.credentials = emptyCredentials();
  state.existingInstall = true;
  state.subfolders = Object.fromEntries(SUBFOLDERS.map((folder) => [folder, folder]));
  state.advancedSettings = {
    ...Object.fromEntries(ADVANCED_VALUE_FIELDS.map((field) => [field.key, field.defaultValue])),
    ...(plan.advancedSettings ?? {}),
  };
  delete state.advancedSettings.PHOTO_TRASH_RETENTION_DAYS;
  state.selectedServices = Object.fromEntries(SERVICES.map((service) => [
    service.id,
    (plan.selectedServices ?? []).includes(service.id),
  ]));
  if (state.deploymentMode !== "HYBRID" && state.selectedServices["frame-belabox-manager"]) {
    state.selectedServices["frame-belabox-manager"] = false;
    addLog("Belabox Manager was removed from this LAN plan because agent installation requires Hybrid mode.");
  }
  state.guidedReviewedServices = Object.fromEntries(SERVICES.map((service) => [service.id, true]));
  state.ports = {
    ...Object.fromEntries(EXPOSED_PORTS.map((port) => [port.key, port.defaultValue])),
    ...Object.fromEntries(EXPOSED_PORTS.filter((port) => plan.ports?.[port.key] !== undefined).map((port) => [port.key, plan.ports[port.key]])),
    edge: plan.ports?.edge ?? 80,
    ftp: plan.ports?.photoFtp ?? 2121,
    ...passiveRangeToPorts(plan.ports?.photoFtpPassive),
    srtla: plan.ports?.srtla ?? 5000,
    srtPlayer: plan.ports?.srtPlayer ?? 4000,
    srtSender: plan.ports?.srtSender ?? 4001,
  };
  state.installStatus = "idle";
  state.lastSetupUrl = "";
  clearValidation();
  invalidatePreflight();
}

async function refreshHostStatus({ quiet } = { quiet: false }) {
  state.hostStatus = null;
  invalidatePreflight();
  render();
  try {
    const status = await invokeCommand("detect_host", {});
    state.hostStatus = status;
    state.previewMode = Boolean(status.previewMode);
    state.detectedInstallations = status.detectedInstallations ?? [];
    applyDefaults(status.defaults);
    if (!quiet) addLog("Host detection completed.");
  } catch (error) {
    addLog(`Host detection failed: ${error.message ?? error}`);
  }
  render();
}

async function runPreflight() {
  if (state.installing || state.preflightRunning) return;
  invalidatePreflight();
  const credentialError = credentialsValidation();
  if (credentialError) {
    state.validationStage = 5;
    state.validationMessage = credentialError;
    render();
    return;
  }
  clearValidation();
  const generation = state.preflightGeneration;
  state.preflightRunning = true;
  render();
  try {
    await draftWrites;
    if (generation !== state.preflightGeneration) return;
    const preflight = await invokeCommand("run_preflight", {
      request: buildPlan(),
    });
    if (generation !== state.preflightGeneration) return;
    state.preflight = preflight;
    state.detectedInstallations = preflight.detectedInstallations ?? state.detectedInstallations;
    for (const check of preflight.checks ?? []) {
      addLog(`${check.status.toUpperCase()}: ${check.label} - ${check.detail}`);
    }
  } catch (error) {
    if (generation === state.preflightGeneration) {
      state.preflight = null;
      state.validationStage = 5;
      state.validationMessage = `Readiness checks failed: ${error.message ?? error}`;
      addLog(state.validationMessage);
    }
  } finally {
    state.preflightRunning = false;
    saveSetupDraft();
    render();
  }
}

async function applyInstall() {
  if (state.installing) return;
  if (!isDesktopRuntime() || !readinessPassed()) {
    addLog("Run current readiness checks in the desktop installer before starting installation.");
    render();
    return;
  }
  const plan = buildPlan();
  state.installing = true;
  state.startupProgress = null;
  state.startupPending = true;
  state.installStatus = "running";
  addLog("Starting FRAME install/apply.");
  const installLogStream = await startInstallLogListener();
  render();
  try {
    await draftWrites;
    const result = await invokeCommand("apply_install_plan", { plan });
    if (Array.isArray(result.readinessChecks)) state.lastReadiness = { installRoot: state.installRoot, checks: result.readinessChecks };
    if (state.startupProgress?.phase === "failed") throw new Error("FRAME startup did not complete. Review the container states and recheck readiness before retrying.");
    state.savedPlanPath = result.path;
    if (!installLogStream.streamed()) {
      for (const line of result.logs ?? []) addLog(line);
    }
    addLog(`Committed FRAME setup plan: ${result.path}`);
    state.lastSetupUrl = result.dashboardUrl || setupUrl();
    state.activeInstallRoot = state.installRoot;
    await refreshLauncherStatus();
    const observed = currentInstallation();
    if (state.launcherError || observed?.installRoot !== state.installRoot || observed?.state !== "running") {
      throw new Error(state.launcherError || observed?.detail || "The deployment finished, but FRAME could not be confirmed running. Recheck its status before continuing.");
    }
    state.startupProgress = { ...state.startupProgress, installRoot: state.installRoot, phase: "complete", services: observed.services ?? [], detail: observed.detail };
    addLog(`FRAME stack apply completed. Portal: ${state.lastSetupUrl}.`);
    state.installStatus = "complete";
    state.credentials = emptyCredentials();
    await discardSetupDraft();
    state.screen = "home";
  } catch (error) {
    state.installStatus = "failed";
    if (state.startupProgress) state.startupProgress = { ...state.startupProgress, phase: "failed" };
    invalidatePreflight();
    addLog(`Could not start installation: ${error.message ?? error}`);
  } finally {
    installLogStream.stop();
    state.startupPending = false;
  }
  state.installing = false;
  render();
}

async function startInstallLogListener() {
  let count = 0;
  const empty = { stop: () => undefined, streamed: () => count > 0 };
  if (!isDesktopRuntime()) return empty;
  try {
    const unlisten = await window.frameDesktop.listen("install-log", (event) => {
      const message = typeof event.payload === "string" ? event.payload : event.payload?.message;
      if (!message) return;
      count += 1;
      addLog(message);
      render();
    });
    return { stop: unlisten, streamed: () => count > 0 };
  } catch (error) {
    addLog(`Install progress stream unavailable: ${error.message ?? error}`);
    return empty;
  }
}

async function openSetup({ renderAfter = true, url = setupUrl() } = {}) {
  try {
    if (!url) return;
    if (isDesktopRuntime()) await window.frameDesktop.openExternal(url);
    else window.open(url, "_blank", "noopener");
    addLog(`Opened ${url}`);
  } catch (error) {
    addLog(`Could not open browser: ${error.message ?? error}`);
  }
  if (renderAfter) render();
}

async function openDockerGuide() {
  await openSetup({ url: dockerGuidance().url });
}

function hostPlatform() {
  return state.launcher?.platform ?? state.hostStatus?.platform;
}

function dockerGuidance() {
  const platform = hostPlatform();
  if (platform === "darwin") return { instructions: "Install and start Docker Desktop for Mac.", url: "https://docs.docker.com/desktop/setup/install/mac-install/" };
  if (platform === "win32") return { instructions: "Install and start Docker Desktop for Windows with Linux containers enabled.", url: "https://docs.docker.com/desktop/setup/install/windows-install/" };
  if (platform === "linux") return { instructions: "Install Docker Engine with the Compose plugin and start the Docker service.", url: "https://docs.docker.com/engine/install/" };
  return { instructions: "Use Docker Desktop on Windows or macOS, or Docker Engine with Compose on Linux.", url: "https://docs.docker.com/get-started/get-docker/" };
}

function hostCompatibilityIssue() {
  const host = state.screen === "setup" ? { ...state.launcher, ...state.hostStatus } : { ...state.hostStatus, ...state.launcher };
  if (host.hostSupported === false || host.dockerIssue === "unsupported_host") return { title: "This computer is not supported", detail: host.hostDetail || host.detail || "This operating system or architecture is not supported by FRAME Launcher." };
  const titles = { docker_cli_missing: "Docker is not installed", docker_compose_missing: "Docker Compose is unavailable", docker_compose_unavailable: "Docker Compose is unavailable",
    docker_permission_denied: "Docker access is denied", docker_engine_unavailable: "Docker is not reachable",
    unsupported_engine_os: "This Docker engine is not supported", unsupported_engine_architecture: "This Docker engine is not supported",
    unsupported_docker_socket: "This Docker connection is not supported", unsupported_rootless: "This Docker configuration is not supported",
    remote_engine: "Select a local Docker engine" };
  if (titles[host.dockerIssue]) return { title: titles[host.dockerIssue], detail: host.detail };
  return null;
}

function buildPlan() {
  return {
    mode: state.mode,
    deploymentMode: state.deploymentMode,
    publicHostname: state.publicHostname,
    installRoot: state.installRoot,
    dataRoot: state.dataRoot,
    subfolders: { ...state.subfolders },
    selectedServices: Object.entries(state.selectedServices)
      .filter(([, enabled]) => enabled)
      .map(([id]) => id),
    ports: {
      ...Object.fromEntries(EXPOSED_PORTS.filter((port) => port.key !== "ftp" && !port.key.startsWith("ftpPassive")).map((port) => [port.key, parsePort(state.ports[port.key])])),
      photoFtp: parsePort(state.ports.ftp),
      photoFtpPassive: `${parsePort(state.ports.ftpPassiveMin)}-${parsePort(state.ports.ftpPassiveMax)}`,
    },
    autoPorts: false,
    credentials: { ...state.credentials },
    advancedSettings: { ...state.advancedSettings },
    createdAt: new Date().toISOString(),
  };
}

async function invokeCommand(command, args) {
  if (!isDesktopRuntime()) {
    return mockInvoke(command, args, new Error("Electron desktop runtime is not available."));
  }
  return window.frameDesktop.invoke(command, args);
}

function isDesktopRuntime() {
  return typeof window !== "undefined" && Boolean(window.frameDesktop);
}

async function mockInvoke(command, args, originalError) {
  const previewDefaults = { installRoot: "C:\\FRAME-deployment-preview", dataRoot: "D:\\FRAME-data-preview" };
  if (command === "get_launcher_status") return { platform: "preview", installations: [], dockerAvailable: false, detail: "Simulated first-run view. No host services were checked.", observedAt: new Date().toISOString(), defaults: previewDefaults };
  if (command === "load_draft") return { draft: null };
  if (command === "get_launcher_preferences") return { keepInTray: true, notifications: true, startAtLogin: false, startAtLoginSupported: false, trayAvailable: false };
  if (["start_stack", "stop_stack", "recover_stack", "update_stack", "repair_stack", "check_updates", "get_diagnostics", "backup_stack", "inspect_backup", "restore_backup", "remove_stack", "locate_installation", "open_data_folder", "save_draft", "clear_draft", "set_launcher_preferences"].includes(command)) throw new Error("Host changes are disabled in browser preview.");
  if (command === "detect_host") {
    return {
      previewMode: true,
      platform: "preview",
      defaults: previewDefaults,
      checks: [
        { label: "Desktop host bridge", status: "warn", detail: "Browser preview only: host checks are simulated and installation is disabled." },
        { label: "Docker CLI", status: "warn", detail: "Native Docker detection requires the Electron app." },
        { label: "FRAME web endpoint", status: "warn", detail: "No native health probe was run." },
      ],
      detectedInstallations: [{
        source: "Preview registry",
        detail: "D:\\FRAME-preview",
        installRoot: "D:\\FRAME-preview",
        setupMode: "quick",
        updatedAt: new Date().toISOString(),
        setupUrl: "http://localhost/dashboard",
        canReconfigure: true,
      }],
    };
  }
  if (command === "run_preflight") {
    return {
      checks: [
        { label: "FRAME data folder", status: args.request.dataRoot ? "warn" : "bad", detail: args.request.dataRoot || "Choose a data folder before installation." },
        { label: "Port plan", status: "bad", detail: "Browser preview cannot inspect host ports. Run the desktop installer for real validation." },
        { label: "Docker readiness", status: "warn", detail: "Install Docker Desktop or Docker Engine, then recheck in the native app." },
      ],
      detectedInstallations: state.detectedInstallations,
    };
  }
  if (command === "load_install_plan") {
    return {
      mode: "quick",
      deploymentMode: "LAN",
      publicHostname: "",
      installRoot: args.installRoot,
      dataRoot: previewDefaults.dataRoot,
      subfolders: Object.fromEntries(SUBFOLDERS.map((folder) => [folder, folder])),
      selectedServices: SERVICES.filter((service) => service.defaultEnabled).map((service) => service.id),
      ports: {
        edge: 80,
        photoFtp: 2121,
        photoFtpPassive: "30000-30019",
        srtla: 5000,
        srtPlayer: 4000,
        srtSender: 4001,
      },
      autoPorts: false,
      advancedSettings: Object.fromEntries(ADVANCED_VALUE_FIELDS.map((field) => [field.key, field.defaultValue])),
      createdAt: new Date().toISOString(),
    };
  }
  if (command === "save_install_plan" || command === "apply_install_plan") {
    throw new Error("Installation and saving configuration are disabled in browser preview.");
  }
  throw originalError;
}

function canProceedFromStage(stage) {
  if (stage === 0) return hostReadyForInstall();
  if (stage === 1) return Boolean(state.mode);
  if (stage === 2) return Boolean(state.installRoot.trim() && state.dataRoot.trim());
  if (stage === 3) return servicesStageComplete();
  if (stage === 4) return portValidation().status === "good" && publicHostnameValidation().status === "good" && publicRelayHostValidation().status === "good" && photoFtpHostValidation().status === "good";
  if (stage === 5) return readinessPassed();
  return false;
}

function nextButtonLabel() {
  if (state.preflightRunning) return "Checking readiness...";
  if (state.stage === 0 && !hostReadyForInstall()) return hostCompatibilityIssue() ? "Resolve host compatibility" : "Check Docker first";
  if (state.stage === 5 && !readinessPassed()) return "Run readiness checks";
  if (state.stage === 5) return "Continue to install";
  return "Next";
}

function validationMessageForStage(stage) {
  if (stage === 0) return hostCompatibilityIssue()?.detail || `${dockerGuidance().instructions} Then press Recheck before continuing.`;
  if (stage === 1) return "Choose Quick Start, Guided Setup, or Advanced before continuing.";
  if (stage === 2) return "Choose a FRAME storage folder before continuing.";
  if (stage === 3 && state.mode === "guided" && !guidedServiceReviewComplete()) {
    return "Review each service with the Next service button before continuing.";
  }
  if (stage === 3) return "Select at least one FRAME service before continuing.";
  if (stage === 4) {
    const hostnameStatus = publicHostnameValidation();
    if (hostnameStatus.status !== "good") return hostnameStatus.message;

    const relayHostStatus = publicRelayHostValidation();
    if (relayHostStatus.status !== "good") return relayHostStatus.message;

    const ftpHostStatus = photoFtpHostValidation();
    if (ftpHostStatus.status !== "good") return ftpHostStatus.message;

    const portStatus = portValidation();
    if (portStatus.status !== "good") return portStatus.message;

    return "Review the network settings before continuing.";
  }
  if (stage === 5) return "Run readiness checks before continuing to install.";
  return `Finish ${SETUP_STAGES[stage]} before continuing.`;
}

function exposedPortsForSelection() {
  return EXPOSED_PORTS.filter((port) => port.services
    ? port.services.some((service) => state.selectedServices[service])
    : !port.service || state.selectedServices[port.service]);
}

function selectedServiceCount() {
  return Object.values(state.selectedServices).filter(Boolean).length;
}

function defaultServiceSelection() {
  return Object.fromEntries(SERVICES.map((service) => [service.id, Boolean(service.defaultEnabled)]));
}

function servicesStageComplete() {
  if (state.mode === "guided") {
    return guidedServiceReviewComplete() && selectedServiceCount() > 0;
  }
  return selectedServiceCount() > 0;
}

function guidedServiceReviewComplete() {
  return SERVICES.every((service) => state.guidedReviewedServices[service.id]);
}

function markCurrentGuidedServiceReviewed() {
  const service = SERVICES[state.guidedServiceIndex];
  if (!service) return;
  state.guidedReviewedServices[service.id] = true;
}

function readinessPassed() {
  return isDesktopRuntime() && !state.preflightRunning && !state.previewMode && Boolean(state.preflight?.checks?.length) &&
    state.preflight.checks.every((check) => ["good", "warn"].includes(check.status)) &&
    state.preflight.checks.some((check) => check.status === "good") && !credentialsValidation();
}

function credentialsValidation() {
  if (state.previewMode) return "";
  const credentials = state.credentials;
  if (state.existingInstall) {
    if (Boolean(credentials.portalUsername.trim()) !== Boolean(credentials.portalPassword)) return "Enter both operator fields to change the login, or leave both empty to keep it.";
    return "";
  }
  if (!credentials.portalUsername.trim() || !credentials.portalPassword) return "Enter an operator username and password before running readiness checks.";
  if (state.deploymentMode === "HYBRID" && !credentials.tunnelToken) return "Enter the Cloudflare Tunnel token for Hybrid mode.";
  return "";
}

function hostReadyForInstall() {
  return Boolean(state.hostStatus?.checks?.length) && !hostCompatibilityIssue() && !state.hostStatus.checks.some((check) => check.status === "bad");
}

function dockerBlockingChecks() {
  return (state.hostStatus?.checks ?? []).filter((check) =>
    check.label.startsWith("Docker") && check.status === "bad",
  );
}

function setupModeLabel() {
  return SETUP_MODES.find((mode) => mode.id === state.mode)?.label ?? "Not selected";
}

function setupModeName(mode) {
  return SETUP_MODES.find((option) => option.id === normalizeSetupMode(mode))?.label ?? mode;
}

function normalizeSetupMode(mode) {
  return SETUP_MODES.some((option) => option.id === mode) ? mode : "advanced";
}

function setupUrl() {
  const port = String(state.ports.edge || 80);
  return port === "80" ? "http://localhost/dashboard" : `http://localhost:${port}/dashboard`;
}

function invalidatePreflight() {
  state.preflight = null;
  state.preflightGeneration += 1;
  const results = document.querySelector("[data-preflight-results]");
  if (results) results.innerHTML = '<p class="card">Run readiness checks for the current settings.</p>';
  saveSetupDraft();
}

function syncProgressControls() {
  const next = document.querySelector("#next-stage");
  if (next) {
    next.disabled = state.preflightRunning || (state.stage === 0 && !hostReadyForInstall());
    next.textContent = nextButtonLabel();
  }

  const storagePill = document.querySelector("[data-storage-status]");
  if (storagePill) {
    const hasRoot = Boolean(state.dataRoot.trim());
    storagePill.className = `pill ${hasRoot ? "good" : "warn"}`;
    storagePill.textContent = hasRoot ? "Selected" : "Required";
  }

  syncPublicHostnameStatus();
  syncPublicRelayHostStatus();
  syncPhotoFtpHostStatus();
  syncPortStatus();
}

function syncPhotoFtpHostStatus() {
  const statusNode = document.querySelector("[data-ftp-host-status]");
  if (!statusNode) return;
  const status = photoFtpHostValidation();
  statusNode.className = `field-help ${status.status}`;
  statusNode.textContent = status.message;
  document.querySelector("#ftp-passive-host")?.closest(".field")?.classList.toggle("invalid", status.status === "bad");
}

function photoFtpHostValidation() {
  if (!state.selectedServices["frame-photo-ftp"]) return { status: "good", message: "Photo FTP is not selected." };
  const host = String(state.advancedSettings.PHOTO_FTP_PASSIVE_HOST ?? "").trim();
  if (!host && state.existingInstall) return { status: "good", message: "Leave empty to preserve the existing FTP host address." };
  if (!host) return { status: "warn", message: "Enter this machine's LAN IPv4 address or DNS hostname so cameras can connect to Photo FTP." };
  if (!isValidRelayHost(host) || /^(?:0|127)\./.test(host)) return { status: "bad", message: "Use a reachable LAN IPv4 address or a DNS name you have configured, without a scheme or port." };
  return { status: "good", message: "Photo FTP will advertise this address to cameras; reserve it in your router if it is assigned by DHCP." };
}

function syncPublicHostnameStatus() {
  const statusNode = document.querySelector("[data-public-host-status]");
  if (!statusNode) return;

  const hostnameStatus = publicHostnameValidation();
  statusNode.className = `field-help ${hostnameStatus.status}`;
  statusNode.textContent = hostnameStatus.message;

  const field = statusNode.closest(".field");
  if (field) {
    field.classList.toggle("invalid", hostnameStatus.status === "bad");
  }
}

function syncPortStatus() {
  const portStatus = portValidation();
  document.querySelectorAll("[data-port]").forEach((input) => {
    input.closest(".port-card")?.classList.toggle("invalid", portStatus.invalidKeys.includes(input.dataset.port));
  });

  const statusNode = document.querySelector("[data-port-status]");
  if (statusNode) {
    statusNode.className = `field-help ${portStatus.status}`;
    statusNode.textContent = portStatus.message;
  }
}

function syncPublicRelayHostStatus() {
  const statusNode = document.querySelector("[data-public-relay-host-status]");
  if (!statusNode) return;

  const relayHostStatus = publicRelayHostValidation();
  statusNode.className = `field-help ${relayHostStatus.status}`;
  statusNode.textContent = relayHostStatus.message;
  document.querySelector("#public-relay-host")?.closest(".field")?.classList.toggle("invalid", relayHostStatus.status === "bad");
}

function publicHostnameValidation() {
  if (state.deploymentMode !== "HYBRID") {
    return { status: "good", message: "LAN mode does not need a public hostname." };
  }

  const hostname = state.publicHostname.trim();
  if (!hostname) {
    return { status: "warn", message: "Required for Hybrid mode." };
  }

  if (!isValidPublicHostname(hostname)) {
    return { status: "bad", message: "Use a bare hostname like frame.example.com, without https://, ports, paths, or spaces." };
  }

  return { status: "good", message: "Hostname format looks good." };
}

function publicRelayHostValidation() {
  if (!state.selectedServices["frame-video-relay"]) {
    return { status: "good", message: "Video Relay is not selected." };
  }

  const host = String(state.advancedSettings.PUBLIC_RELAY_HOST ?? "").trim();
  if (!host) {
    return state.deploymentMode === "HYBRID"
      ? { status: "warn", message: "Enter the public DNS name or IPv4 address that forwards SRTLA UDP traffic to FRAME." }
      : { status: "good", message: "Optional in LAN mode; localhost will be used when empty." };
  }
  if (!isValidRelayHost(host) || (state.deploymentMode === "HYBRID" && host.toLowerCase() === "localhost")) {
    return { status: "bad", message: "Use a bare DNS name or IPv4 address, without a scheme, port, path, or localhost." };
  }
  return { status: "good", message: "Relay senders will use this host; Docker continues to bind the UDP port below." };
}

function portValidation() {
  const visiblePorts = exposedPortsForSelection();
  const invalidKeys = [];
  const singlePorts = [];
  const passiveMinVisible = visiblePorts.some((port) => port.key === "ftpPassiveMin");
  const passiveMaxVisible = visiblePorts.some((port) => port.key === "ftpPassiveMax");
  const passiveMin = parsePort(state.ports.ftpPassiveMin);
  const passiveMax = parsePort(state.ports.ftpPassiveMax);

  for (const port of visiblePorts) {
    const value = parsePort(state.ports[port.key]);
    if (!validPortNumber(value)) {
      invalidKeys.push(port.key);
    }
    if (!port.key.startsWith("ftpPassive")) {
      singlePorts.push({ key: port.key, value, label: port.label, protocol: port.protocol });
    }
  }

  if (passiveMinVisible && passiveMaxVisible) {
    if (!validPortNumber(passiveMin)) invalidKeys.push("ftpPassiveMin");
    if (!validPortNumber(passiveMax)) invalidKeys.push("ftpPassiveMax");
    if (validPortNumber(passiveMin) && validPortNumber(passiveMax) && passiveMin > passiveMax) {
      invalidKeys.push("ftpPassiveMin", "ftpPassiveMax");
      return {
        status: "bad",
        message: "Photo FTP passive min must be lower than or equal to passive max.",
        invalidKeys: unique(invalidKeys),
      };
    }
  }

  if (invalidKeys.length) {
    return {
      status: "bad",
      message: "Ports must be whole numbers from 1 to 65535.",
      invalidKeys: unique(invalidKeys),
    };
  }

  const seenPorts = new Map();
  for (const port of singlePorts) {
    const binding = `${port.protocol}:${port.value}`;
    if (seenPorts.has(binding)) {
      return {
        status: "bad",
        message: `${port.label} conflicts with ${seenPorts.get(binding).label} on ${port.protocol.toUpperCase()} port ${port.value}.`,
        invalidKeys: [port.key, seenPorts.get(binding).key],
      };
    }
    seenPorts.set(binding, port);
  }

  if (passiveMinVisible && passiveMaxVisible) {
    for (const port of singlePorts) {
      if (port.protocol === "tcp" && port.value >= passiveMin && port.value <= passiveMax) {
        return {
          status: "bad",
          message: `${port.label} conflicts with the Photo FTP passive range.`,
          invalidKeys: [port.key, "ftpPassiveMin", "ftpPassiveMax"],
        };
      }
    }
  }

  return { status: "good", message: "Port entries look good.", invalidKeys: [] };
}

function validPortNumber(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function unique(values) {
  return [...new Set(values)];
}

function isValidPublicHostname(hostname) {
  const value = hostname.trim().toLowerCase();
  if (
    value.length > 253 ||
    value.includes("://") ||
    value.includes("/") ||
    value.includes(":") ||
    value.includes(" ") ||
    value.endsWith(".") ||
    !value.includes(".")
  ) {
    return false;
  }

  const labels = value.split(".");
  const topLevelLabel = labels[labels.length - 1];
  return /^[a-z]{2,63}$/.test(topLevelLabel) &&
    labels.every((label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    );
}

function isValidRelayHost(host) {
  const value = host.trim().toLowerCase();
  const octets = value.split(".");
  if (octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet))) {
    return octets.every((octet) => Number(octet) <= 255);
  }
  return isValidPublicHostname(value);
}

function clearValidation() {
  state.validationMessage = "";
  state.validationStage = -1;
}

function numericPortInput(value) {
  return String(value).replace(/\D/g, "").slice(0, 5);
}

function parsePort(value) {
  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function passiveRangeToPorts(range) {
  const [start, end] = String(range ?? "").split("-").map((value) => parsePort(value.trim()));
  return {
    ftpPassiveMin: start || 30000,
    ftpPassiveMax: end || start || 30019,
  };
}

function formatDetectedDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function addLog(line) {
  state.log = [...state.log, line].slice(-80);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

document.documentElement.style.setProperty("--frame-accent", FRAME_BLUE);
