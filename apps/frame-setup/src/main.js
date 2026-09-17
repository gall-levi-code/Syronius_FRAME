const FRAME_BLUE = "#2CB4FB";

const SETUP_STAGES = [
  "Welcome",
  "Mode",
  "Storage",
  "Services",
  "Ports",
  "Review",
  "Install",
];

const SETUP_MODES = [
  {
    id: "quick",
    label: "Quick Start",
    eyebrow: "Recommended stack",
    summary: "Install the core FRAME tools, create your operator login, then finish details in the web setup page.",
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
      setup: "In localhost/setup you will create or verify stream profiles, confirm relay hostnames/ports, and connect overlay presets to the stream stats you want to display.",
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
      setup: "In localhost/setup you will create overlay presets, choose which stats appear, copy OBS browser-source URLs, and adjust layout/visibility for each scene.",
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
      setup: "In localhost/setup you will pick the capture device/page, create listener links, tune quality settings, and decide which routes are safe to publish.",
    },
    defaultEnabled: true,
  },
  {
    id: "frame-discord-audio-bridge",
    label: "Discord Audio Bridge",
    summary: "Optional Discord voice-to-OBS bridge. Requires a Discord bot and extra setup.",
    guided: {
      what: "Runs the Discord voice bridge service that can mix selected Discord voice users into stable OBS browser-source URLs.",
      why: "Use this when streamers need Discord voice audio and speaker overlays without changing OBS URLs for every session.",
      ports: "Uses FRAME Edge and a direct TCP port. Requires a Discord bot token and Discord application permissions.",
      setup: "In localhost/setup you will add Discord bot credentials, configure operator access, invite/setup guild links, and then finish per-guild control from Discord commands.",
    },
    defaultEnabled: false,
  },
  {
    id: "frame-belabox-manager",
    label: "Belabox Manager",
    summary: "Hybrid-only remote device control over one authenticated outbound WSS connection.",
    guided: {
      what: "Adds a local FRAME page plus one authenticated WebSocket control connection for roaming Belabox agents.",
      why: "Use this when FRAME should collect Belabox health, stream, network, temperature, uptime, disk, and log data while the Belabox changes networks.",
      ports: "Requires Hybrid mode and a public hostname. The page stays local; agents connect outbound through the existing HTTPS tunnel at /belabox/control.",
      setup: "Selecting this service switches the install to Hybrid. In localhost/setup you can then install or repair agents over the public WSS endpoint.",
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
      setup: "In localhost/setup you will set the FTP username/password, passive host, passive range, camera connection instructions, and verify that uploads appear in the pipeline.",
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
      setup: "In localhost/setup you will configure upload access, confirm accepted image types, and test multi-file uploads into the pipeline.",
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
      setup: "In localhost/setup you will review gallery routes, admin access, deletion/trash behavior, album covers, and public exposure choices.",
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
      setup: "In localhost/setup you will copy the OBS viewer URL, configure remote access, verify latest.json, and confirm published-photo ready-file behavior.",
    },
    defaultEnabled: true,
  },
];

const EXPOSED_PORTS = [
  { key: "edge", label: "FRAME Web GUI", protocol: "tcp", env: "EDGE_HTTP_PORT", defaultValue: 80, required: true },
  { key: "portal", label: "Portal direct access", protocol: "tcp", env: "PORTAL_PORT", defaultValue: 3730, required: true },
  { key: "audioBridge", label: "Discord bridge direct access", protocol: "tcp", env: "AUDIO_BRIDGE_PORT", defaultValue: 3729, service: "frame-discord-audio-bridge" },
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
  ["DISCORD_CLIENT_ID/TOKEN", "Only needed when Discord Audio Bridge is enabled."],
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
const emptyCredentials = () => ({ portalUsername: "", portalPassword: "", discordClientId: "", discordToken: "", tunnelToken: "" });

const state = {
  stage: 0,
  mode: "",
  installRoot: "",
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
  previewMode: false,
  preflight: null,
  preflightRunning: false,
  preflightGeneration: 0,
  log: ["Welcome to FRAME Setup."],
  savedPlanPath: "",
  lastSetupUrl: "",
  installing: false,
  installStatus: "idle",
  animateStage: false,
  validationMessage: "",
  validationStage: -1,
};

const app = document.querySelector("#app");

render();
void refreshHostStatus({ quiet: true });

function render() {
  app.innerHTML = `
    <div class="setup-shell">
      <aside class="sidebar">
        <div class="brand">
          <img src="./frame-logo-square.png" alt="" aria-hidden="true" />
          <div>
            <p class="eyebrow">Syronius FRAME</p>
            <h2>Installer</h2>
          </div>
        </div>
        <ol class="stage-list">
          ${SETUP_STAGES.map((stage, index) => renderStageItem(stage, index)).join("")}
        </ol>
      </aside>
      <section class="content">
        <div class="stage-viewport">
          ${state.previewMode ? '<p class="stage-alert" role="status">Browser preview — host checks are simulated and installation is disabled.</p>' : ""}
          ${renderCurrentStage()}
        </div>
        ${renderFooter()}
      </section>
    </div>
  `;
  bindEvents();
  if (state.installing) app.querySelectorAll("button, input, select").forEach((control) => { control.disabled = true; });
  state.animateStage = false;
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
  return `
    <section class="hero ${stepPageClass()}">
      <div>
        <p class="eyebrow">Welcome to FRAME</p>
        <h1>Set up your IRL streamer toolkit.</h1>
        <p>
          This online installer downloads an official FRAME release and its prebuilt container images,
          then opens the local web setup page. Internet access is required.
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
          <p>Install Docker Desktop on Windows or Docker Engine with Compose on Linux first. Docker must run Linux containers on an x64 (linux/amd64) host.</p>
        </div>
        <button class="button" id="refresh-host" type="button">Recheck</button>
      </div>
      ${blockingChecks.length ? `
        <div class="hard-stop">
          <strong>Docker setup is required before continuing.</strong>
          <p>Install Docker Desktop, start Docker, then press Recheck. FRAME will keep the next step locked until this clears.</p>
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
          <button class="card choice-card ${state.mode === mode.id ? "selected" : ""}" data-mode="${mode.id}" type="button">
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
  const hasRoot = Boolean(state.installRoot.trim());
  return `
    <section class="panel ${stepPageClass()}">
      <div class="panel-heading">
        <div>
          <p class="eyebrow">Storage</p>
          <h2>Choose one FRAME storage root.</h2>
          <p>Choose the installation folder. New installs keep persistent data in its data subfolder; existing release installations retain their configured data root.</p>
        </div>
        <span class="pill ${hasRoot ? "good" : "warn"}" data-storage-status>${hasRoot ? "Selected" : "Required"}</span>
      </div>
      ${renderStageNotice(2)}
      <div class="folder-picker">
        <div>
          <span>Installation folder</span>
          <strong data-storage-path>${escapeHtml(state.installRoot || "No folder selected yet")}</strong>
          <p>${state.previewMode ? "Browser preview cannot open the native folder picker. Use the desktop app to install FRAME." : "Use the native folder picker to choose where FRAME keeps install state and data."}</p>
        </div>
        <div class="button-row">
          <button class="button primary" id="choose-folder" type="button">Browse folder</button>
          ${state.previewMode ? "<button class=\"button\" id=\"use-preview-folder\" type=\"button\">Use preview path</button>" : ""}
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
          <p>FRAME Edge routes the web tools. Review all published web, FTP, and SRT/SRTLA ports in the next step.</p>
        </div>
        <span class="pill ${selectedServiceCount() ? "good" : "warn"}">${selectedServiceCount()} selected</span>
      </div>
      ${renderStageNotice(3)}
      <div class="service-grid">
        ${SERVICES.map((service) => `
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
  const finalService = state.guidedServiceIndex === SERVICES.length - 1;
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
      <div class="guided-service-actions">
        <button class="button ghost" id="previous-service" type="button" ${state.guidedServiceIndex === 0 ? "disabled" : ""}>Previous service</button>
        <button class="button primary" id="next-service" type="button">
          ${finalService ? "Finish service review" : "Next service"}
        </button>
      </div>
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
    setup: "localhost/setup will walk through the remaining configuration.",
  };
  return `
    ${renderInfoBlock("What it does", details.what)}
    ${renderInfoBlock("Why you might want it", details.why)}
    ${renderInfoBlock("Ports and exposure", details.ports)}
    ${renderInfoBlock("What comes next in localhost/setup", details.setup)}
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
          <h2>Confirm the ports exposed on the host.</h2>
          <p>These are the host ports published by the selected services. If a port is occupied, choose another value and rerun readiness checks.</p>
        </div>
      </div>
      <div class="network-controls ${hybrid ? "hybrid" : "lan"}">
        <label class="field">
          <span>Deployment mode</span>
          <select id="deployment-mode">
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
              />
            </label>
          </article>
        `).join("")}
      </div>
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
        ${renderSummaryCard("Storage", state.installRoot || "Not selected")}
        ${renderSummaryCard("Services", `${selectedServiceCount()} selected`)}
        ${renderSummaryCard("Web setup", setupUrl())}
      </div>
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
    ...(state.selectedServices["frame-discord-audio-bridge"] ? [["discordClientId", "Discord application ID", "text"], ["discordToken", "Discord bot token", "password"]] : []),
    ...(state.deploymentMode === "HYBRID" ? [["tunnelToken", "Cloudflare Tunnel token", "password"]] : []),
  ];
  return `
    <section class="advanced-section">
      <h3>Installation credentials</h3>
      <p>${state.existingInstall ? "Leave credential pairs empty to preserve the existing login and integrations. Enter both fields to replace an operator login or Discord configuration." : "Set your operator login. Optional integrations require their credentials before the stack can start."} Credentials are excluded from saved installer plans and used only to prepare and apply this installation.</p>
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
      <span class="pill ${check.status}">${check.status}</span>
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
          <h2>Install FRAME, then continue in setup.</h2>
          <p>Press Install FRAME once. This commits your configuration, downloads the release images, and waits for Docker Compose health checks before offering the web setup page.</p>
        </div>
      </div>
      <div class="summary-grid">
        ${renderSummaryCard("Mode", setupModeLabel())}
        ${renderSummaryCard("Storage", state.installRoot || "Not selected")}
        ${renderSummaryCard("Services", `${selectedServiceCount()} selected`)}
        ${renderSummaryCard("Web setup", setup)}
      </div>
      <div class="install-action-panel">
        <strong>${installStatusTitle()}</strong>
        <p>${installStatusCopy()}</p>
      </div>
      <pre class="log">${escapeHtml(state.log.join("\n"))}</pre>
    </section>
  `;
}

function renderFooter() {
  const isInstallStage = state.stage === SETUP_STAGES.length - 1;
  const hardStopNext = state.preflightRunning || (state.stage === 0 && !hostReadyForInstall());
  return `
    <div class="footer-actions">
      <button class="button ghost" id="previous-stage" type="button" ${state.stage === 0 ? "disabled" : ""}>Previous</button>
      <div class="button-row">
        ${state.stage === 0 ? "<button class=\"button\" id=\"docker-guide\" type=\"button\">Docker install guide</button>" : ""}
        ${isInstallStage ? renderInstallFooterActions() : `
          <button class="button primary" id="next-stage" type="button" ${hardStopNext ? "disabled" : ""}>
            ${nextButtonLabel()}
          </button>
        `}
      </div>
    </div>
  `;
}

function renderInstallFooterActions() {
  if (state.installStatus === "complete") {
    return `
      <button class="button primary install-frame-button" data-open-setup type="button">Open FRAME Setup</button>
      <button class="button ghost" data-finish-installer type="button">Finish</button>
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
  return "Install FRAME";
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
    return "Docker Compose health checks passed. Open FRAME Setup when you are ready, or Finish to close this installer.";
  }
  return "The final button writes the selected configuration, starts the FRAME stack, and waits for Compose health checks before showing the setup link.";
}

function bindEvents() {
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.mode = button.dataset.mode;
      clearValidation();
      if (state.mode === "quick") {
        state.selectedServices = defaultServiceSelection();
        state.guidedReviewedServices = Object.fromEntries(SERVICES.map((service) => [service.id, true]));
      } else {
        state.selectedServices = Object.fromEntries(SERVICES.map((service) => [service.id, false]));
        state.guidedReviewedServices = Object.fromEntries(SERVICES.map((service) => [service.id, false]));
      }
      state.guidedServiceIndex = 0;
      invalidatePreflight();
      addLog(`Selected ${setupModeLabel()}.`);
      render();
    });
  });

  document.querySelector("#choose-folder")?.addEventListener("click", chooseFolder);
  document.querySelector("#use-preview-folder")?.addEventListener("click", usePreviewFolder);
  document.querySelector("#refresh-host")?.addEventListener("click", () => refreshHostStatus({ quiet: false }));
  document.querySelector("#apply-install")?.addEventListener("click", applyInstall);
  document.querySelectorAll("[data-open-setup]").forEach((button) => {
    button.addEventListener("click", () => openSetup({ url: state.lastSetupUrl || setupUrl() }));
  });
  document.querySelectorAll("[data-finish-installer]").forEach((button) => {
    button.addEventListener("click", finishInstaller);
  });
  document.querySelectorAll("[data-reconfigure-root]").forEach((button) => {
    button.addEventListener("click", () => reconfigureInstall(button.dataset.reconfigureRoot));
  });
  document.querySelector("#docker-guide")?.addEventListener("click", openDockerGuide);
  document.querySelector("#previous-service")?.addEventListener("click", () => {
    clearValidation();
    state.guidedServiceIndex = Math.max(0, state.guidedServiceIndex - 1);
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
    render();
  });

  document.querySelector("#previous-stage")?.addEventListener("click", () => {
    if (state.installing) return;
    clearValidation();
    state.animateStage = true;
    state.stage = Math.max(0, state.stage - 1);
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
    if (!isDesktopRuntime()) throw new Error("Open the desktop installer to choose a folder.");
    const selected = await window.frameDesktop.pickDirectory({ defaultPath: state.installRoot });
    if (typeof selected === "string") {
      state.installRoot = selected;
      state.credentials = emptyCredentials();
      state.existingInstall = state.detectedInstallations.some((install) => install.installRoot === selected);
      clearValidation();
      invalidatePreflight();
      addLog(`Selected storage root: ${selected}`);
    }
  } catch (error) {
    addLog(`Could not choose folder: ${error.message ?? error}`);
  }
  render();
}

function usePreviewFolder() {
  state.installRoot = "D:\\FRAME-preview";
  state.credentials = emptyCredentials();
  state.existingInstall = false;
  clearValidation();
  invalidatePreflight();
  addLog(`Selected preview storage root: ${state.installRoot}`);
  render();
}

async function reconfigureInstall(installRoot) {
  if (!installRoot || state.installing) return;
  invalidatePreflight();
  try {
    const plan = await invokeCommand("load_install_plan", { installRoot });
    applyLoadedPlan(plan);
    state.stage = 5;
    state.animateStage = true;
    addLog(`Loaded previous FRAME install from ${installRoot}.`);
  } catch (error) {
    addLog(`Could not load previous install: ${error.message ?? error}`);
  }
  render();
}

function applyLoadedPlan(plan) {
  state.mode = normalizeSetupMode(plan.mode);
  state.installRoot = plan.installRoot ?? "";
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
  state.installStatus = "running";
  addLog("Starting FRAME install/apply.");
  const installLogStream = await startInstallLogListener();
  render();
  try {
    const result = await invokeCommand("apply_install_plan", { plan });
    state.savedPlanPath = result.path;
    if (!installLogStream.streamed()) {
      for (const line of result.logs ?? []) addLog(line);
    }
    addLog(`Committed FRAME setup plan: ${result.path}`);
    state.lastSetupUrl = result.setupUrl || setupUrl();
    addLog(`FRAME stack apply completed. Setup is ready at ${state.lastSetupUrl}.`);
    state.installStatus = "complete";
    state.credentials = emptyCredentials();
  } catch (error) {
    state.installStatus = "failed";
    invalidatePreflight();
    addLog(`Could not start installation: ${error.message ?? error}`);
  } finally {
    installLogStream.stop();
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
    if (isDesktopRuntime()) await window.frameDesktop.openExternal(url);
    else window.open(url, "_blank", "noopener");
    addLog(`Opened ${url}`);
  } catch (error) {
    addLog(`Could not open browser: ${error.message ?? error}`);
  }
  if (renderAfter) render();
}

async function finishInstaller() {
  if (state.installing) return;
  if (isDesktopRuntime()) await window.frameDesktop.closeWindow();
  else window.close();
}

async function openDockerGuide() {
  const url = "https://docs.docker.com/get-started/get-docker/";
  await openSetup({ url });
}

function buildPlan() {
  return {
    mode: state.mode,
    deploymentMode: state.deploymentMode,
    publicHostname: state.publicHostname,
    installRoot: state.installRoot,
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
  if (command === "detect_host") {
    return {
      previewMode: true,
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
        setupUrl: "http://localhost/setup",
        canReconfigure: true,
      }],
    };
  }
  if (command === "run_preflight") {
    return {
      checks: [
        { label: "Storage root", status: args.request.installRoot ? "good" : "bad", detail: args.request.installRoot || "Choose a storage root before install." },
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
  if (stage === 2) return Boolean(state.installRoot.trim());
  if (stage === 3) return servicesStageComplete();
  if (stage === 4) return portValidation().status === "good" && publicHostnameValidation().status === "good" && publicRelayHostValidation().status === "good" && photoFtpHostValidation().status === "good";
  if (stage === 5) return readinessPassed();
  return false;
}

function nextButtonLabel() {
  if (state.preflightRunning) return "Checking readiness...";
  if (state.stage === 0 && !hostReadyForInstall()) return "Install Docker first";
  if (state.stage === 5 && !readinessPassed()) return "Run readiness checks";
  if (state.stage === 5) return "Continue to install";
  return "Next";
}

function validationMessageForStage(stage) {
  if (stage === 0) return "Install Docker Desktop, start Docker, then press Recheck before continuing.";
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
    if (state.selectedServices["frame-discord-audio-bridge"] && Boolean(credentials.discordClientId.trim()) !== Boolean(credentials.discordToken)) return "Enter both Discord fields to change the integration, or leave both empty to keep it.";
    return "";
  }
  if (!credentials.portalUsername.trim() || !credentials.portalPassword) return "Enter an operator username and password before running readiness checks.";
  if (state.selectedServices["frame-discord-audio-bridge"] && (!credentials.discordClientId.trim() || !credentials.discordToken)) return "Enter the Discord application ID and bot token for Discord Audio Bridge.";
  if (state.deploymentMode === "HYBRID" && !credentials.tunnelToken) return "Enter the Cloudflare Tunnel token for Hybrid mode.";
  return "";
}

function hostReadyForInstall() {
  return Boolean(state.hostStatus?.checks?.length) && dockerBlockingChecks().length === 0;
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
  return port === "80" ? "http://localhost/setup" : `http://localhost:${port}/setup`;
}

function invalidatePreflight() {
  state.preflight = null;
  state.preflightGeneration += 1;
  const results = document.querySelector("[data-preflight-results]");
  if (results) results.innerHTML = '<p class="card">Run readiness checks for the current settings.</p>';
}

function syncProgressControls() {
  const next = document.querySelector("#next-stage");
  if (next) {
    next.disabled = state.preflightRunning || (state.stage === 0 && !hostReadyForInstall());
    next.textContent = nextButtonLabel();
  }

  const storagePill = document.querySelector("[data-storage-status]");
  if (storagePill) {
    const hasRoot = Boolean(state.installRoot.trim());
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
  if (!isValidRelayHost(host) || /^(?:0|127)\./.test(host)) return { status: "bad", message: "Use a reachable LAN IPv4 address or DNS name such as frame.local, without a scheme or port." };
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
