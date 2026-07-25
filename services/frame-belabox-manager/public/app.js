const ADD_DEVICE_ID = "__add__";
const THEME_MODE_KEY = "frame-theme";
const LEGACY_PORTAL_THEME_KEY = "frame-portal-theme";
const THEME_PROFILE_ID_KEY = "frame-theme-profile-id";
const THEME_PROFILE_KEY = "frame-theme-profile";
const THEME_CUSTOM_PROFILES_KEY = "frame-theme-custom-profiles";
const COMPAT_THEME_KEYS = ["frame-gallery-theme-mode", "frame-audio-bridge-color-mode"];
const LAST_DEVICE_KEY = "frame-belabox-last-device";
const LAST_WORKSPACE_TAB_KEY = "frame-belabox-workspace-tab";
const ADVANCED_VIEW_KEY = "frame-belabox-advanced-view";
const REFRESH_INTERVAL_MS = 2000;
const COMMAND_POLL_INTERVAL_MS = 500;
const OPEN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
const COPY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>';
const WIZARD_STEPS = ["Welcome", "Photo Agent", "Stream Safe Transfer", "Install"];
const WORKSPACE_TABS = ["overview", "photos", "connections", "diagnostics", "system"];
const TRANSFER_PRESETS = {
  protect: { label: "Protect Stream", chunk_size_bytes: 1048576, chunk_parallel_uploads: 1, chunk_upload_kbps: 768 },
  balanced: { label: "Balanced", chunk_size_bytes: 1048576, chunk_parallel_uploads: 2, chunk_upload_kbps: 2000 },
  fast: { label: "Fast", chunk_size_bytes: 4194304, chunk_parallel_uploads: 4, chunk_upload_kbps: 0 },
};
const THEME_STORAGE_KEYS = new Set([
  THEME_MODE_KEY,
  LEGACY_PORTAL_THEME_KEY,
  THEME_PROFILE_ID_KEY,
  THEME_PROFILE_KEY,
  THEME_CUSTOM_PROFILES_KEY,
  ...COMPAT_THEME_KEYS,
]);

const elements = {
  deviceTabs: document.getElementById("device-tabs"),
  devicePanel: document.getElementById("device-panel"),
  notice: document.getElementById("notice"),
  headerStatus: document.getElementById("header-status"),
  themeToggle: document.getElementById("theme-toggle"),
};

const state = {
  selectedDeviceId: readLastDeviceId() || ADD_DEVICE_ID,
  status: null,
  telemetry: null,
  logs: null,
  formDraft: {},
  detailsOpen: {},
  workspaceTab: readWorkspaceTab(),
  advancedView: readAdvancedView(),
  ftpOutputs: {},
  panelLocked: false,
  panelHoldKey: "",
  wizardStep: 0,
  wizardSshCheckKey: "",
  wizardSshCheckResult: null,
  wizardInstalling: false,
  criticalAction: null,
  noticeMessage: "Loading",
  noticeTone: "busy",
};

initialize();

function initialize() {
  initializeTheme();
  ensureCriticalActionDialog();
  ensureConfirmationDialog();
  elements.themeToggle.addEventListener("click", toggleTheme);
  window.addEventListener("storage", handleThemeStorageChange);
  window.addEventListener("beforeunload", handleCriticalBeforeUnload);
  document.addEventListener("click", blockCriticalNavigation, true);
  elements.deviceTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-device-tab]");
    if (!tab) return;
    event.preventDefault();
    state.selectedDeviceId = tab.dataset.deviceTab;
    state.panelHoldKey = "";
    if (state.selectedDeviceId === ADD_DEVICE_ID) resetWizard();
    else writeLastDeviceId(state.selectedDeviceId);
    render();
  });
  elements.devicePanel.addEventListener("input", handlePanelInput);
  elements.devicePanel.addEventListener("change", handlePanelChange);
  elements.devicePanel.addEventListener("focusin", holdCurrentPanelRender);
  elements.devicePanel.addEventListener("pointerdown", holdCurrentPanelRender);
  elements.devicePanel.addEventListener("click", handlePanelClick);
  elements.devicePanel.addEventListener("submit", handlePanelSubmit);
  elements.devicePanel.addEventListener("toggle", rememberDetailsState, true);
  void refresh();
  setInterval(refresh, REFRESH_INTERVAL_MS);
}

async function refresh() {
  const [status, telemetry, logs] = await Promise.all([
    fetchJson("/belabox/api/status"),
    fetchJson("/belabox/api/telemetry"),
    fetchJson("/belabox/api/logs"),
  ]);
  state.status = status;
  state.telemetry = telemetry;
  state.logs = logs;
  normalizeSelection();
  render();
}

function normalizeSelection() {
  const devices = pairedDevices();
  if (!devices.length) {
    state.selectedDeviceId = ADD_DEVICE_ID;
    return;
  }
  if (state.selectedDeviceId === ADD_DEVICE_ID) return;
  if (!devices.some((device) => device.device_id === state.selectedDeviceId)) {
    const stored = readLastDeviceId();
    state.selectedDeviceId = devices.some((device) => device.device_id === stored) ? stored : devices[0].device_id;
  }
  writeLastDeviceId(state.selectedDeviceId);
}

function render() {
  if (!state.status) return;
  const devices = pairedDevices();
  elements.deviceTabs.innerHTML = renderDeviceTabs(devices);
  elements.deviceTabs.hidden = state.selectedDeviceId === ADD_DEVICE_ID;
  const panelKey = state.selectedDeviceId;
  const shouldRenderPanel = elements.devicePanel.dataset.panelKey !== panelKey || (!state.panelLocked && !panelRenderHeld(panelKey));
  if (shouldRenderPanel) {
    rememberCurrentDetailsState();
    elements.devicePanel.dataset.panelKey = panelKey;
    elements.devicePanel.innerHTML = panelKey === ADD_DEVICE_ID
      ? renderAddDeviceWizard(devices.length === 0)
      : renderDevicePanel(panelKey);
    elements.devicePanel.dataset.advancedView = String(state.advancedView);
    restoreFormDraft();
    restoreDetailsState();
  }
  const issues = (state.status.issues || []).join(" ");
  if (issues) showNotice(issues, "error");
  else if (state.noticeMessage === "Loading") showNotice("Ready", "ready");
  else renderNotice();
}

function renderDeviceTabs(devices) {
  const deviceTabs = devices.map((device) => {
    const live = liveDevice(device.device_id);
    const active = state.selectedDeviceId === device.device_id;
    return `<a href="#" role="tab" aria-controls="device-panel" aria-selected="${active}" class="device-tab ${active ? "active" : ""}" data-device-tab="${escapeAttr(device.device_id)}">
      <span class="status-dot ${live?.online ? "online" : ""}" aria-hidden="true"></span>
      <span>${escapeHtml(device.display_name || device.device_id)}</span>
    </a>`;
  }).join("");
  const addActive = state.selectedDeviceId === ADD_DEVICE_ID;
  return `${deviceTabs}<a href="#" role="tab" aria-controls="device-panel" aria-selected="${addActive}" class="device-tab add ${addActive ? "active" : ""}" data-device-tab="${ADD_DEVICE_ID}">Add Device</a>`;
}

function renderAddDeviceWizard(isEmpty) {
  const step = Math.max(0, Math.min(WIZARD_STEPS.length - 1, state.wizardStep));
  return `<div class="panel-head wizard-head">
      <div>
        <p class="eyebrow">${isEmpty ? "First Belabox" : "New Belabox"}</p>
        <h2>Belabox Manager Agent Installation Wizard</h2>
      </div>
      <div class="panel-actions">
        ${isEmpty ? "" : `<button class="secondary" type="button" data-wizard-cancel>Cancel</button>`}
        <span class="pill ${hybridReady() ? "online" : "warn"}">${hybridReady() ? "Hybrid ready" : "Hybrid required"}</span>
      </div>
    </div>
    <form id="device-wizard" class="wizard ${state.wizardInstalling ? "installing" : ""}" data-wizard-step="${step}">
      <nav class="wizard-steps" aria-label="Installation steps">
        ${WIZARD_STEPS.map((label, index) => `<span class="${index === step ? "active" : index < step ? "done" : ""}"${index === step ? ' aria-current="step"' : ""}>${index + 1}. ${escapeHtml(label)}</span>`).join("")}
      </nav>
      ${wizardStepMarkup(step)}
    </form>`;
}

function wizardStepMarkup(step) {
  if (step === 0) return wizardWelcomeStep();
  if (step === 1) return wizardFtpStep();
  if (step === 2) return wizardTransferStep();
  return wizardInstallStep();
}

function wizardWelcomeStep() {
  const hybrid = hybridReady();
  const checked = state.wizardSshCheckKey && state.wizardSshCheckKey === sshCheckKey();
  return `<section class="wizard-step">
      <h3>Welcome to the Belabox Manager Agent Installation Wizard</h3>
      <p>FRAME installs a small Belabox agent that connects back through your Hybrid tunnel, enables the remote encoder page, publishes live device health, and can manage stream-safe photo transfer.</p>
      <div class="wizard-callouts">
        ${statusTile("Remote Control", "Belabox UI relay", "good")}
        ${statusTile("Photo Agent", "Camera FTP intake", "neutral")}
        ${statusTile("Stream Safety", "Capped uploads", "neutral")}
        ${statusTile("Maintenance", "Repair/uninstall", "neutral")}
      </div>
      <p class="hint ${hybrid ? "" : "warn-text"}">${hybrid ? "Hybrid mode is active. Enter local-network SSH credentials for this one-time install." : "Hybrid mode is required before a Belabox can reach FRAME remotely. Switch the stack to Hybrid, then return here."}</p>
      <div class="form-grid">
        <label>Belabox local host/IP<input id="pair-host" name="host" required autocomplete="off" value="${escapeAttr(wizardDraftValue("pair-host"))}"></label>
        <label>SSH port<input id="pair-port" name="port" type="number" min="1" max="65535" value="${escapeAttr(wizardDraftValue("pair-port", 22))}"></label>
        <label>SSH username<input id="pair-user" name="user" required autocomplete="username" value="${escapeAttr(wizardDraftValue("pair-user", "user"))}"></label>
        <label>Device name<input id="pair-display-name" name="display_name" required maxlength="64" placeholder="Studio Belabox" value="${escapeAttr(wizardDraftValue("pair-display-name"))}"></label>
        <label>Password<input id="pair-password" name="password" type="password" required autocomplete="current-password"></label>
        <label class="check-row"><input id="remember-ssh" name="remember_ssh" type="checkbox" ${wizardDraftChecked("remember-ssh") ? "checked" : ""} ${sshCredentialSaveEnabled() ? "" : "disabled"}>Save encrypted SSH login for repair</label>
        <label class="check-row"><input id="enable-ssh-on-boot" name="enable_ssh_on_boot" type="checkbox" ${wizardDraftChecked("enable-ssh-on-boot") ? "checked" : ""}>Enable SSH on boot</label>
        <label class="check-row"><input id="install-diagnostics" name="install_diagnostics" type="checkbox" ${wizardDraftChecked("install-diagnostics") ? "checked" : ""}>Install network diagnostics tools</label>
      </div>
      <p class="hint">${sshCredentialSaveEnabled() ? "Saved SSH is used for repair, updates, and clean uninstall." : "Encrypted SSH save is disabled until BELABOX_SSH_CREDENTIAL_KEY is configured."}</p>
      <div class="actions wizard-actions">
        <button id="check-ssh" type="button" data-wizard-check-ssh ${hybrid ? "" : "disabled"}>${checked ? "SSH Checked" : "Test SSH & Continue"}</button>
      </div>
      <pre id="pair-output">${checked ? `SSH check passed for ${escapeHtml(state.wizardSshCheckResult?.device_id || "device")}.` : "Waiting for SSH check."}</pre>
    </section>`;
}

function wizardFtpStep() {
  return `<section class="wizard-step">
      <h3>Belabox FTP Photo Agent</h3>
      <p>The Photo Agent gives cameras a Belabox-local FTP login, then forwards finished photos to FRAME. Use this when your camera already sends to the Belabox and you want FRAME to receive the same files.</p>
      <label class="check-row"><input id="setup-ftp-enabled" name="setup_ftp" type="checkbox" ${wizardDraftChecked("setup-ftp-enabled") ? "checked" : ""}>Enable Belabox FTP Photo Agent</label>
      <p class="hint">The external host/IP and port should be the public or forwarded address that reaches the FRAME FTP server.</p>
      <div class="form-grid">
        <label>FRAME FTP external host/IP<input id="ftp-target-host" name="target_host" value="${escapeAttr(wizardDraftValue("ftp-target-host", ftpDefaultHost()))}"></label>
        <label>FRAME FTP external port<input id="ftp-target-port" name="target_port" type="number" min="1" max="65535" value="${escapeAttr(wizardDraftValue("ftp-target-port", state.status.ftp_connector?.target_port || 2121))}"></label>
        <label>Belabox FTP Photo Agent Login username<input id="camera-ftp-user" name="camera_username" value="${escapeAttr(wizardDraftValue("camera-ftp-user", state.status.ftp_connector?.camera_username || "framecam"))}"></label>
        <label>Belabox FTP Photo Agent Login password<input id="camera-ftp-password" name="camera_password" type="password" autocomplete="new-password" placeholder="Generate if blank"></label>
      </div>
      ${wizardNavButtons()}
    </section>`;
}

function wizardTransferStep() {
  const chunkSize = Number(state.status.chunk_upload?.chunk_size_bytes || 4194304);
  const chunkSizeMax = Math.min(8388608, Math.max(262144, chunkSize));
  const parallel = Number(state.status.chunk_upload?.chunk_parallel_uploads || 1);
  const uploadKbps = Number(state.status.chunk_upload?.chunk_upload_kbps || 0);
  const uploadUncapped = wizardDraftChecked("photo-upload-uncapped", uploadKbps <= 0);
  return `<section class="wizard-step">
      <h3>Stream Safe Photo Transfer</h3>
      <p>This sends processed photos through the Hybrid tunnel instead of requiring FTP port forwarding. Use a capped preset while live so photo uploads do not starve SRTLA bitrate recovery.</p>
      <label class="check-row"><input id="setup-chunk-enabled" name="setup_chunk" type="checkbox" ${wizardDraftChecked("setup-chunk-enabled") ? "checked" : ""}>Enable Stream Safe Photo Transfer</label>
      <div class="preset-row" aria-label="Transfer presets">
        ${Object.entries(TRANSFER_PRESETS).map(([key, preset]) => `<button class="preset-button" type="button" data-wizard-preset="${escapeAttr(key)}"><strong>${escapeHtml(preset.label)}</strong><span>${escapeHtml(presetSummary(preset))}</span></button>`).join("")}
      </div>
      <div class="form-grid slider-grid">
        ${sliderControl("photo-chunk-size", "chunk_size_bytes", "Chunk size", 262144, chunkSizeMax, 262144, chunkSize, formatChunkSize)}
        ${sliderControl("photo-chunk-parallel", "chunk_parallel_uploads", "Parallel uploads", 1, 4, 1, parallel, (value) => `${value} connection${Number(value) === 1 ? "" : "s"}`)}
        <label class="check-row wide"><input id="photo-upload-uncapped" name="upload_uncapped" type="checkbox" ${uploadUncapped ? "checked" : ""}>Uncapped upload</label>
        ${sliderControl("photo-chunk-kbps", "chunk_upload_kbps", "Upload cap", 64, 50000, 64, uploadKbps > 0 ? uploadKbps : 2000, formatUploadCap, uploadUncapped, "Uncapped")}
      </div>
      <p class="hint">Protect Stream is safest. Fast is uncapped and can cause stream bitrate dips on limited uplinks.</p>
      ${wizardNavButtons()}
    </section>`;
}

function wizardInstallStep() {
  const summary = wizardSummary();
  return `<section class="wizard-step">
      <div class="install-summary">
        <h3>Install Belabox Agent</h3>
        <p>FRAME will test SSH again, create device MQTT credentials, install or repair the Belabox agent, then run the selected photo setup steps. Repair reuses the same path and refreshes the agent without removing your saved device unless you uninstall it.</p>
        <p class="hint">Uninstall is available from the device Advanced panel after install. It disables FRAME services on the Belabox and archives the local agent folder unless purge is explicitly requested.</p>
        <dl>${rows(summary.rows)}</dl>
        ${summary.warnings.length ? `<div class="warning-list">${summary.warnings.map((warning) => `<p>${escapeHtml(warning)}</p>`).join("")}</div>` : ""}
      </div>
      <div class="install-progress">
        <h3>Installing</h3>
        <progress id="install-progress" max="100" value="0"></progress>
        <pre id="pair-output">Ready to install.</pre>
      </div>
      <div class="actions wizard-actions final">
        <button type="button" class="secondary" data-wizard-back>Back</button>
        <button id="pair-device" class="install-action" type="submit">Install</button>
      </div>
    </section>`;
}

function wizardNavButtons() {
  return `<div class="actions wizard-actions">
    <button type="button" class="secondary" data-wizard-back>Back</button>
    <button type="button" data-wizard-next>Continue</button>
  </div>`;
}

function renderDevicePanel(deviceId) {
  const provisioned = pairedDevices().find((device) => device.device_id === deviceId);
  const live = liveDevice(deviceId);
  const telemetry = live?.telemetry || {};
  const ftp = telemetry.ftp_upload || {};
  const photoTelemetryReady = Object.keys(ftp).length > 0;
  const diagnostics = telemetry.network_diagnostics || {};
  const egress = telemetry.egress || {};
  const relayHealth = live?.relay_health || {};
  const framePipeline = state.status.photo_pipeline || {};
  const remoteBelaui = telemetry.remote_belaui || state.status.remote_belaui || {};
  const cameraFtp = ftp.camera_ftp || {};
  const connector = ftpConnector(deviceId);
  const savedSsh = savedSshCredential(deviceId);
  const processing = processingSettings(ftp);
  const resizeEnabled = processing.long_edge_px > 0;
  const sizeLimitEnabled = processing.max_output_mb > 0;
  const preprocess = ftp.preprocess || {};
  const chunkSize = Number(ftp.chunk_size_bytes ?? state.status.chunk_upload?.chunk_size_bytes ?? 4194304);
  const chunkSizeMax = Math.min(8388608, Math.max(262144, Number(state.status.chunk_upload?.chunk_size_bytes || 4194304)));
  const chunkParallel = Number(ftp.chunk_parallel_uploads ?? state.status.chunk_upload?.chunk_parallel_uploads ?? 1);
  const chunkUploadKbps = Number(ftp.chunk_upload_kbps ?? state.status.chunk_upload?.chunk_upload_kbps ?? 0);
  const uploadUncapped = chunkUploadKbps <= 0;
  const chunkRelayEnabled = ftp.transfer_mode === "chunked_https" || ftp.transport === "chunked_https";
  const processingBaseline = JSON.stringify({
    enabled: processing.enabled,
    long_edge_px: resizeEnabled ? processing.long_edge_px : 0,
    jpeg_quality: processing.jpeg_quality,
    max_output_mb: sizeLimitEnabled ? processing.max_output_mb : 0,
  });
  const transferBaseline = JSON.stringify({
    chunk_size_bytes: chunkSize,
    chunk_parallel_uploads: chunkParallel,
    chunk_upload_kbps: chunkUploadKbps,
    transfer_mode: chunkRelayEnabled ? "chunked_https" : "direct_ftp",
  });
  const remoteUrl = remoteAccessUrl(deviceId);
  const slowdown = slowdownSummary(live, connector, ftp, preprocess, egress, chunkUploadKbps);
  const setupButtonLabel = connector ? "Repair Agent" : "Install Photo Agent";
  const displayName = provisioned?.display_name || deviceId;
  const bundledAgentVersion = state.status.agent?.bundled_version || "";
  // ponytail: installed agents come from this manager; compare semver when rollback support is added.
  const updateAvailable = Boolean(live?.agent_version && bundledAgentVersion && live.agent_version !== bundledAgentVersion);
  const queueResetAvailable = Boolean(live?.online && live.agent_version === bundledAgentVersion);
  const agentHealth = !live?.last_heartbeat_at ? "Waiting for heartbeat" : live.online ? "Healthy" : "Offline";
  const transferResult = transferResultNotice(ftp, framePipeline);
  const transferState = transferResult?.state === "published"
    ? "Published"
    : transferResult?.state === "failed" ? "Needs attention" : friendlyTransferState(ftp, connector);
  const activeWorkspaceTab = WORKSPACE_TABS.includes(state.workspaceTab) ? state.workspaceTab : "overview";
  const diagnosticFinished = ["complete", "partial", "failed"].includes(diagnostics.state);
  const uploadPercent = ftp.file ? Math.max(0, Math.min(100, Math.round(Number(ftp.percent || 0)))) : 0;
  const uploadQueue = Number(ftp.queue_count || 0);
  const uploadReady = Number(ftp.processed_count || 0);
  return `<div class="panel-head device-header">
      <div>
        <p class="eyebrow">Belabox</p>
        <h2>${escapeHtml(displayName)}</h2>
        <p class="device-id">${escapeHtml(deviceId)}</p>
      </div>
      <div class="panel-actions">
        <span class="pill ${live?.online ? "online" : ""}">${live?.online ? "Online" : "Offline"}</span>
        <a class="icon-button link-action" href="${escapeAttr(remoteUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeAttr(displayName)} encoder remote in a new tab" title="Open ${escapeAttr(displayName)} encoder remote in a new tab">${OPEN_ICON}</a>
        <button class="icon-button link-action advanced-only" type="button" data-copy-text="${escapeAttr(remoteUrl)}" aria-label="Copy ${escapeAttr(displayName)} encoder remote URL" title="Copy ${escapeAttr(displayName)} encoder remote URL">${COPY_ICON}</button>
        <div class="view-mode-toggle" role="group" aria-label="Information level">
          <button type="button" class="${state.advancedView ? "" : "active"}" data-view-mode="simple" aria-pressed="${!state.advancedView}">Simple</button>
          <button type="button" class="${state.advancedView ? "active" : ""}" data-view-mode="advanced" aria-pressed="${state.advancedView}">Advanced</button>
        </div>
      </div>
    </div>

    <nav class="workspace-tabs" role="tablist" aria-label="Belabox tools">
      ${[
        ["overview", "Overview"],
        ["photos", "Photo Transfer"],
        ["connections", "Connections"],
        ["diagnostics", "Diagnostics"],
        ["system", "System"],
      ].map(([id, label]) => `<button type="button" role="tab" id="workspace-tab-${id}" aria-controls="workspace-pane-${id}" aria-selected="${activeWorkspaceTab === id}" tabindex="${activeWorkspaceTab === id ? "0" : "-1"}" class="workspace-tab ${activeWorkspaceTab === id ? "active" : ""}" data-workspace-tab="${id}">${label}</button>`).join("")}
    </nav>

    <div id="workspace-pane-overview" class="workspace-pane" role="tabpanel" aria-labelledby="workspace-tab-overview" data-workspace-pane="overview" ${activeWorkspaceTab === "overview" ? "" : "hidden"}>
    <section class="workspace-section status-workspace" aria-label="Encoder overview">
      <div class="remote-row advanced-only">
        <span>Remote access</span>
        <code>${escapeHtml(remoteUrl)}</code>
      </div>

      <div class="encoder-strip" aria-label="Encoder status">
        ${statusTile("Device Health", live?.online ? agentHealth : "Offline", live?.online ? "good" : "warn")}
        ${statusTile("Remote Access", remoteBelauiStatus(remoteBelaui), remoteBelaui.state === "reachable" ? "good" : "warn")}
        ${statusTile("Photo Transfer", transferState, connector ? "good" : "warn")}
        ${statusTile("Stream Safety", photoTelemetryReady ? streamSafetyLabel(ftp, chunkUploadKbps) : "Waiting", photoTelemetryReady && chunkUploadKbps > 0 ? "good" : "warn")}
      </div>

      <div class="insight-card ${slowdown.tone} ${slowdown.title === "Ready" ? "advanced-only" : ""}">
        <div>
          <p class="eyebrow">What is slowing things down?</p>
          <h3>${escapeHtml(slowdown.title)}</h3>
        </div>
        <p>${escapeHtml(slowdown.detail)}</p>
      </div>
    </section>
    </div>

    <div id="workspace-pane-photos" class="workspace-pane" role="tabpanel" aria-labelledby="workspace-tab-photos" data-workspace-pane="photos" ${activeWorkspaceTab === "photos" ? "" : "hidden"}>
    <section class="workspace-section photo-workspace" aria-labelledby="photo-transfer-title">
      <div class="workspace-heading">
        <div>
          <p class="eyebrow">Daily controls</p>
          <h3 id="photo-transfer-title">Photo Transfer</h3>
        </div>
        <span class="pill ${ftp?.last_error ? "warn" : live?.online ? "online" : ""}">${escapeHtml(transferState)}</span>
      </div>

      ${transferResult ? `<div class="transfer-result ${escapeAttr(transferResult.state)}" role="status"><strong>${escapeHtml(transferResult.title)}</strong><span>${escapeHtml(transferResult.detail)}</span></div>` : ""}

      <div class="pipeline-block">
        ${photoPipeline(ftp, preprocess, framePipeline)}
      </div>

      <div class="detail-grid transfer-grid">
        <div class="status-card live-upload-card">
          <div class="status-card-heading">
            <h3>Live Upload</h3>
            <span class="result-badge ${ftp.file ? "running" : "neutral"}">${ftp.file ? "Uploading" : "Idle"}</span>
          </div>
          <div class="upload-file-row">
            <strong title="${escapeAttr(ftp.file || "No active upload")}">${escapeHtml(ftp.file || "No active upload")}</strong>
            <span>${ftp.file ? `${uploadPercent}%` : "Ready"}</span>
          </div>
          <progress max="100" value="${uploadPercent}" aria-label="Photo upload progress">${uploadPercent}%</progress>
          <div class="upload-meta">
            <span>${escapeHtml(formatBytes(Number(ftp.rate_bps || 0)) + "/s")}</span>
            <span>${uploadQueue} queued · ${uploadReady} ready · ETA ${escapeHtml(transferEta(ftp))}</span>
          </div>
        </div>
        <div class="status-card">
          <h3>FRAME Processing</h3>
          <dl>${rows([
            ["State", !framePipeline.available ? "Unavailable" : Number(framePipeline.processing || 0) > 0 ? "Processing" : Number(framePipeline.queue_depth || 0) > 0 ? "Queued" : "Ready"],
            ["Queue", `${Number(framePipeline.queue_depth || 0)} waiting, ${Number(framePipeline.processing || 0)} processing`],
            ["Last published", framePipeline.last_publish_at ? `${framePipeline.last_publish_file || "Photo"} (${formatAge(framePipeline.last_publish_at)})` : "Waiting"],
          ])}</dl>
        </div>
      </div>

      <div class="transfer-controls">
        <div class="section-head">
          <h3>Transfer profile</h3>
          <span>${escapeHtml(photoTelemetryReady ? formatUploadCap(chunkUploadKbps) : "Waiting")}</span>
        </div>
      <div class="preset-row" aria-label="Transfer presets">
        ${transferPresetButtons(chunkSize, chunkParallel, chunkUploadKbps, live?.online)}
      </div>
      <p class="hint">Protect Stream is the safest starting point while live. Fast is uncapped and can affect bitrate recovery on weak uplinks.</p>

      <dl class="transfer-summary advanced-only">${rows([
        ["Mode", photoTelemetryReady ? friendlyTransferMode(ftp) : "Waiting"],
        ["Upload cap", photoTelemetryReady ? formatUploadCap(chunkUploadKbps) : "Waiting"],
        ["Preprocessor", photoTelemetryReady ? preprocess.status_text || preprocess.state || "Idle" : "Waiting"],
        ["Upload-ready", photoTelemetryReady ? `${Number(ftp.processed_count || 0)}/${Number(preprocess.ahead || 0) || "?"}` : "Waiting"],
        ["Resize/compress", photoTelemetryReady ? (processing.enabled ? "Enabled" : "Disabled") : "Waiting"],
      ])}</dl>

      <details class="nested-details" data-section="photo-preparation">
        <summary>Photo preparation <span class="pending-badge" data-pending-badge hidden>Unsaved</span></summary>
        <form id="processing-form" class="form-grid processing-form" data-form-baseline="${escapeAttr(processingBaseline)}">
          <label class="constraint-toggle processing-master wide">
            <input id="photo-processing-enabled" name="enabled" type="checkbox" ${processing.enabled ? "checked" : ""}>
            <span><strong>Prepare images before transfer</strong><small>Auto-orient and encode using the selected constraints.</small></span>
          </label>
          <div class="processing-toggle-grid wide">
            <label class="constraint-toggle">
              <input id="photo-resize-enabled" name="resize_enabled" type="checkbox" ${resizeEnabled ? "checked" : ""} ${processing.enabled ? "" : "disabled"}>
              <span><strong>Resize dimensions</strong><small>Constrain the longest edge.</small></span>
            </label>
            <label class="constraint-toggle">
              <input id="photo-size-limit-enabled" name="size_limit_enabled" type="checkbox" ${sizeLimitEnabled ? "checked" : ""} ${processing.enabled ? "" : "disabled"}>
              <span><strong>Limit output size</strong><small>Reduce quality, then dimensions if needed.</small></span>
            </label>
          </div>
          <div class="processing-slider-grid wide">
            ${sliderControl("photo-long-edge", "long_edge_px", "Long edge", 800, 8000, 100, resizeEnabled ? processing.long_edge_px : 2400, formatPixelEdge, !processing.enabled || !resizeEnabled, "Original dimensions")}
            ${sliderControl("photo-max-output", "max_output_mb", "Maximum output", 1, 25, 0.5, sizeLimitEnabled ? processing.max_output_mb : 4, formatMaxOutput, !processing.enabled || !sizeLimitEnabled, "No limit")}
            ${sliderControl("photo-jpeg-quality", "jpeg_quality", "JPEG quality", 40, 100, 1, processing.jpeg_quality, (value) => `${value}%`, !processing.enabled, "Processing off")}
          </div>
          ${formCommitMarkup(displayName, live?.online)}
        </form>
      </details>

      <details class="nested-details advanced-only" data-section="advanced-transfer">
        <summary>Advanced transfer settings <span class="pending-badge" data-pending-badge hidden>Unsaved</span></summary>
        <dl>${rows([
          ["Endpoint", state.status.chunk_upload?.public_url_configured ? "Configured" : "Missing"],
          ["Photo stage", state.status.chunk_upload?.photo_upload_configured ? "Configured" : "Missing token"],
          ["Chunk size", `${chunkSize} bytes`],
          ["Parallel chunks", chunkParallel],
          ["Egress binding", ftp.egress_binding || "Waiting"],
        ])}</dl>
        <form id="chunk-form" class="form-grid slider-grid" data-form-baseline="${escapeAttr(transferBaseline)}">
          ${sliderControl("photo-chunk-size", "chunk_size_bytes", "Chunk size", 262144, chunkSizeMax, 262144, chunkSize, formatChunkSize)}
          ${sliderControl("photo-chunk-parallel", "chunk_parallel_uploads", "Parallel uploads", 1, 4, 1, chunkParallel, (value) => `${value} connection${Number(value) === 1 ? "" : "s"}`)}
          <label class="check-row wide"><input id="photo-upload-uncapped" name="upload_uncapped" type="checkbox" ${uploadUncapped ? "checked" : ""}>Uncapped upload</label>
          ${sliderControl("photo-chunk-kbps", "chunk_upload_kbps", "Upload cap", 64, 50000, 64, chunkUploadKbps > 0 ? chunkUploadKbps : 2000, formatUploadCap, uploadUncapped, "Uncapped")}
          <fieldset class="transport-mode-switch wide">
            <legend>Transfer mode</legend>
            <span class="mode-direct">Direct FTP</span>
            <label class="switch-control">
              <input id="photo-transport-mode" name="transport_mode" type="checkbox" role="switch" aria-label="Use Chunked Relay" ${chunkRelayEnabled ? "checked" : ""} ${live?.online ? "" : "disabled"}>
              <span class="switch-track" aria-hidden="true"></span>
            </label>
            <span class="mode-chunked">Chunked Relay</span>
          </fieldset>
          <div class="actions wide">
            <button id="refresh-photo-module" class="secondary" type="button" ${live?.online ? "" : "disabled"}>Refresh Status</button>
          </div>
          ${formCommitMarkup(displayName, live?.online)}
        </form>
      </details>

      <details class="nested-details advanced-only">
        <summary>Agent setup</summary>
        <dl>${rows([
          ["FRAME target", `${connector?.target_host || state.status.ftp_connector?.target_host || "Not set"}:${connector?.target_port || state.status.ftp_connector?.target_port || 2121}`],
          ["Camera FTP", cameraFtp.port ? `${cameraFtp.username}@Belabox:${cameraFtp.port}` : connector ? `${connector.camera_username}@Belabox:${state.status.ftp_connector?.camera_port || 2121}` : "Not installed"],
          ["Managed folder", state.status.ftp_connector?.managed_upload_dir || "Agent workspace"],
        ])}</dl>
        <form id="ftp-form" class="form-grid">
          <label>FRAME FTP external host/IP<input id="ftp-target-host" name="target_host" value="${escapeAttr(ftpTargetHost(connector))}"></label>
          <label>FRAME FTP port<input id="ftp-target-port" name="target_port" type="number" min="1" max="65535" value="${escapeAttr(connector?.target_port || state.status.ftp_connector?.target_port || 2121)}"></label>
          <label>Camera FTP username<input id="camera-ftp-user" name="camera_username" value="${escapeAttr(connector?.camera_username || state.status.ftp_connector?.camera_username || "framecam")}"></label>
          <label>Camera FTP password<input id="camera-ftp-password" name="camera_password" type="password" autocomplete="new-password" placeholder="${connector ? "Keep current if blank" : "Generate if blank"}"></label>
          <div class="actions wide">
            <button id="setup-ftp-connector" type="submit">${setupButtonLabel}</button>
            ${connector ? `<button id="show-ftp-password" type="button">Show Camera FTP Password</button>` : ""}
          </div>
        </form>
        <pre id="ftp-output">${escapeHtml(state.ftpOutputs[deviceId] || (connector ? "Agent credentials are stored internally. Repair uses saved SSH or prompts through SSH Maintenance." : "Install uses saved SSH if available. Otherwise open SSH Maintenance first."))}</pre>
      </details>

      <p class="hint">${live?.online ? "Online controls use signed commands. No SSH login required." : "Agent must be online before photo settings can be sent."}</p>
      </div>
    </section>
    </div>

    <div id="workspace-pane-connections" class="workspace-pane" role="tabpanel" aria-labelledby="workspace-tab-connections" data-workspace-pane="connections" ${activeWorkspaceTab === "connections" ? "" : "hidden"}>
    <section class="workspace-section connections-workspace" aria-labelledby="connections-title">
      <div class="workspace-heading">
        <div><p class="eyebrow">Network paths</p><h3 id="connections-title">Connections</h3></div>
        <span class="pill ${Number(egress.healthy_lane_count || 0) > 0 ? "online" : "warn"}">${Number(egress.healthy_lane_count || 0)} healthy</span>
      </div>
      <div class="connection-lanes">
        <h3>Available connections</h3>
        ${egressLaneCards(egress, ftp)}
      </div>
      <div class="status-card connection-summary">
        <h3>Stream protection</h3>
        <dl>${rows([
          ["Active upload lane", ftp.active_egress || "Idle"],
          ["Safety", photoTelemetryReady ? streamSafetyLabel(ftp, chunkUploadKbps) : "Waiting"],
          ["Upload cap", photoTelemetryReady ? formatUploadCap(chunkUploadKbps) : "Waiting"],
          ["Transfer mode", photoTelemetryReady ? friendlyTransferMode(ftp) : "Waiting"],
        ])}</dl>
      </div>
      <details class="nested-details advanced-only" data-section="connection-details">
        <summary>Technical route details</summary>
        <dl>${rows([
          ["Egress binding", ftp.egress_binding || "Waiting"],
          ["Chunk size", formatChunkSize(chunkSize)],
          ["Parallel uploads", `${chunkParallel}`],
          ["Last heartbeat", live?.last_heartbeat_at ? formatAge(live.last_heartbeat_at) : "Waiting"],
        ])}</dl>
      </details>
    </section>
    </div>

    <div id="workspace-pane-diagnostics" class="workspace-pane" role="tabpanel" aria-labelledby="workspace-tab-diagnostics" data-workspace-pane="diagnostics" ${activeWorkspaceTab === "diagnostics" ? "" : "hidden"}>
    <section class="workspace-section diagnostics-workspace" data-section="network-diagnostics" aria-labelledby="diagnostics-title">
      <div class="workspace-heading">
        <div><p class="eyebrow">Connection testing</p><h3 id="diagnostics-title">Network Diagnostics</h3></div>
        <span class="pill ${diagnostics.state === "complete" ? "online" : diagnostics.state === "failed" ? "warn" : ""}">${escapeHtml(diagnosticStateLabel(diagnostics.state))}</span>
      </div>
      <p class="hint">Test each Belabox interface against the Internet or this FRAME host. Tests are uncapped and can compete with an active stream.</p>
      ${relayProbeMarkup(relayHealth)}
      <dl class="advanced-only">${rows([
        ["Target", diagnosticTargetLabel(diagnostics)],
        ["Current", diagnostics.current_interface ? `${diagnostics.current_interface} - ${diagnosticPhaseLabel(diagnostics.current_phase)}` : "Idle"],
        ["Progress", diagnostics.bytes_total ? `${Math.round((Number(diagnostics.bytes_completed ?? diagnostics.bytes_sent ?? 0) / Number(diagnostics.bytes_total)) * 100)}%` : "None"],
        ["Streams", diagnostics.parallel || state.status.diagnostics?.parallel_streams || 1],
      ])}</dl>
      <form id="speed-test-form" class="form-grid">
        <fieldset class="diagnostic-target-selector wide">
          <legend>Test destination</legend>
          <label><input type="radio" name="diagnostic_target" value="internet" ${diagnostics.target !== "frame" ? "checked" : ""}><span><strong>External Internet</strong><small>Cloudflare edge</small></span></label>
          <label><input type="radio" name="diagnostic_target" value="frame" ${diagnostics.target === "frame" ? "checked" : ""}><span><strong>FRAME endpoint</strong><small>This hosted FRAME device</small></span></label>
        </fieldset>
        <label>Interface<select id="speed-test-interface" name="interface_name">${diagnosticInterfaceOptions(telemetry.network_interfaces, diagnostics.requested_interface)}</select></label>
        ${sliderControl("speed-test-mib", "mib", "Data per direction", 1, Math.max(1, Math.floor((state.status.diagnostics?.max_upload_bytes || 67108864) / 1024 / 1024)), 1, Math.max(1, Math.round((diagnostics.bytes_per_direction || state.status.diagnostics?.upload_bytes || 8388608) / 1024 / 1024)), (value) => `${value} MiB`)}
        <div class="wide advanced-only">${sliderControl("speed-test-parallel", "parallel", "Parallel streams", 1, 8, 1, state.status.diagnostics?.parallel_streams || 1, (value) => `${value} stream${Number(value) === 1 ? "" : "s"}`)}</div>
        <div class="actions wide"><button id="run-speed-test" class="install-action" type="submit" ${live?.online ? "" : "disabled"}>Run Interface Speed Test</button></div>
      </form>
      <pre id="speed-test-output" class="diagnostic-live-output ${diagnosticFinished ? "advanced-only" : ""}">${diagnosticSummary(diagnostics)}</pre>
      ${diagnosticResultsMarkup(diagnostics)}
    </section>
    </div>

    <div id="workspace-pane-system" class="workspace-pane" role="tabpanel" aria-labelledby="workspace-tab-system" data-workspace-pane="system" ${activeWorkspaceTab === "system" ? "" : "hidden"}>
    <section class="workspace-section system-workspace" aria-labelledby="system-title">
      <div class="workspace-heading">
        <div><p class="eyebrow">Device management</p><h3 id="system-title">System</h3></div>
        <span class="pill ${live?.online ? "online" : "warn"}">${escapeHtml(agentHealth)}</span>
      </div>
      <div class="agent-card">
        <div><p class="eyebrow">Installed agent</p><strong class="${live?.online ? "good-text" : ""}">${escapeHtml(agentHealth)}</strong></div>
        <dl>${rows([
          ["Version", live?.agent_version || "Waiting"],
          ["Last heartbeat", live?.last_heartbeat_at ? formatAge(live.last_heartbeat_at) : "Never"],
        ])}</dl>
        ${updateAvailable ? `<span class="pill warn">Agent update available: ${escapeHtml(bundledAgentVersion)}</span>` : ""}
      </div>
    <details class="nested-details" data-section="queue-recovery">
      <summary>Photo queue recovery</summary>
      <p class="hint">${queueResetAvailable ? "Archives pending photos on the Belabox while preserving transfer settings and any file currently uploading or preprocessing." : "Repair the agent to enable queue recovery."}</p>
      <dl>${rows([
        ["Pending", `${Number(ftp.queue_count || 0)}`],
        ["Upload-ready", `${Number(ftp.processed_count || 0)}`],
      ])}</dl>
      <div class="actions"><button class="danger" type="button" data-reset-photo-queue ${queueResetAvailable ? "" : "disabled"}>Reset Photo Queue</button></div>
    </details>
    <details class="nested-details" data-section="ssh-maintenance">
      <summary>SSH Maintenance</summary>
      <p class="hint">SSH is only needed for agent repair, optional tool install, or reinstalling local services.</p>
      <dl>${rows([
        ["Saved login", savedSsh ? `${savedSsh.user}@${savedSsh.host}:${savedSsh.port}` : "Not saved"],
        ["Encrypted save", sshCredentialSaveEnabled() ? "Available" : "Disabled"],
      ])}</dl>
      <form id="repair-form" class="form-grid">
        <label>Belabox local IP<input id="pair-host" name="host" required autocomplete="off" value="${escapeAttr(savedSsh?.host || "")}"></label>
        <label>SSH port<input id="pair-port" name="port" type="number" min="1" max="65535" value="${escapeAttr(savedSsh?.port || 22)}"></label>
        <label>SSH username<input id="pair-user" name="user" required autocomplete="username" value="${escapeAttr(savedSsh?.user || "user")}"></label>
        <input id="pair-device-id" name="device_id" type="hidden" value="${escapeAttr(deviceId)}">
        <label>Password<input id="pair-password" name="password" type="password" autocomplete="current-password"></label>
        <label class="check-row wide"><input id="remember-ssh" name="remember_ssh" type="checkbox" ${sshCredentialSaveEnabled() ? "" : "disabled"}>Save encrypted SSH credential for future maintenance</label>
        <label class="check-row wide"><input id="install-diagnostics" name="install_diagnostics" type="checkbox">Install optional network diagnostics tools</label>
        <label class="check-row wide"><input id="enable-ssh-on-boot" name="enable_ssh_on_boot" type="checkbox">Enable SSH on boot</label>
        <div class="actions wide">
          <button id="pair-device" type="submit">Repair / Update Agent</button>
          ${savedSsh ? `<button id="forget-ssh" type="button">Forget Saved SSH</button>` : ""}
        </div>
      </form>
      <pre id="pair-output">${savedSsh ? "Saved SSH can be reused for installer jobs. Enter a password or key to rotate it." : "Enter SSH credentials when an installer or repair job needs local access."}</pre>
    </details>
    <div class="advanced-only system-advanced">
    <details class="nested-details" data-section="device-identity">
      <summary>Device identity</summary>
      <form id="device-name-form" class="form-grid">
        <label>Display name<input id="device-display-name" name="display_name" required maxlength="64" value="${escapeAttr(displayName)}"></label>
        <label>Device ID<input value="${escapeAttr(deviceId)}" readonly></label>
        <div class="actions wide"><button type="submit">Save Name</button></div>
      </form>
    </details>
    <details class="nested-details" data-section="telemetry">
      <summary>Device telemetry</summary>
      <dl>${rows([
        ["Hostname", telemetry.hostname || "Unknown"],
        ["Uptime", seconds(telemetry.uptime_seconds)],
        ["CPU load", Array.isArray(telemetry.cpu_load) ? telemetry.cpu_load.map((value) => Number(value).toFixed(2)).join(" / ") : "Unknown"],
        ["Memory", percent(telemetry.memory?.used_percent)],
        ["Disk", percent(telemetry.disk?.used_percent)],
        ["Temperature", telemetry.temperature_c == null ? "Unavailable" : `${telemetry.temperature_c} C`],
      ])}</dl>
    </details>

    <details class="nested-details" data-section="logs">
      <summary>Logs</summary>
      <pre id="logs">${deviceLogs(deviceId)}</pre>
    </details>

    <details class="nested-details danger-zone" data-section="device-removal">
      <summary>Remove or uninstall</summary>
      <div class="actions">
        <button class="danger" type="button" data-uninstall-agent="${escapeAttr(deviceId)}">Uninstall Agent</button>
        <button class="danger" type="button" data-remove-device="${escapeAttr(deviceId)}">Remove Device From FRAME</button>
      </div>
    </details>
      </div>
    </section>
    </div>`;
}

function formCommitMarkup(displayName, online) {
  return `<div class="form-commit wide" data-form-commit data-device-name="${escapeAttr(displayName)}" data-online="${online ? "true" : "false"}" data-tone="clean">
    <p aria-live="polite">
      <strong data-form-commit-title>Settings are up to date.</strong>
      <span data-form-commit-detail>Edits stay local until you apply them.</span>
    </p>
    <button class="install-action form-apply-button" data-form-apply type="submit" ${online ? "" : "disabled"} hidden>Apply changes to ${escapeHtml(displayName)}</button>
    <button class="secondary form-discard-button" data-discard-form type="button" hidden>Discard changes</button>
  </div>`;
}

async function handlePanelClick(event) {
  const viewMode = event.target.closest("[data-view-mode]");
  if (viewMode) return setAdvancedView(viewMode.dataset.viewMode === "advanced");
  const workspaceTab = event.target.closest("[data-workspace-tab]");
  if (workspaceTab) return selectWorkspaceTab(workspaceTab.dataset.workspaceTab);
  const cancelWizard = event.target.closest("[data-wizard-cancel]");
  if (cancelWizard) return closeWizard();
  const backWizard = event.target.closest("[data-wizard-back]");
  if (backWizard) return moveWizard(-1);
  const nextWizard = event.target.closest("[data-wizard-next]");
  if (nextWizard) return moveWizard(1);
  const checkSsh = event.target.closest("[data-wizard-check-ssh]");
  if (checkSsh) return checkWizardSsh(checkSsh);
  const wizardPreset = event.target.closest("[data-wizard-preset]");
  if (wizardPreset) return applyWizardPreset(wizardPreset.dataset.wizardPreset);
  const copy = event.target.closest("[data-copy-text]");
  if (copy) return copyToClipboard(copy);
  const preset = event.target.closest("[data-transfer-preset]");
  if (preset) return applyTransferPreset(preset.dataset.transferPreset, preset);
  const resetQueue = event.target.closest("[data-reset-photo-queue]");
  if (resetQueue) return resetPhotoQueue(resetQueue);
  const uninstall = event.target.closest("[data-uninstall-agent]");
  if (uninstall) return uninstallAgent(uninstall);
  const remove = event.target.closest("[data-remove-device]");
  if (remove) return removeProvisionedDevice(remove);
  const forgetSsh = event.target.closest("#forget-ssh");
  if (forgetSsh) return forgetSavedSsh(forgetSsh);
  const showFtpPassword = event.target.closest("#show-ftp-password");
  if (showFtpPassword) return showFtpCredentials(showFtpPassword);
  const discard = event.target.closest("[data-discard-form]");
  if (discard) return discardFormChanges(discard.closest("form"));
  const refresh = event.target.closest("#refresh-photo-module");
  if (refresh) return sendPhotoCommand("photo_module_status", {}, undefined, refresh).catch((error) => showNotice(`Photo status refresh failed: ${error.message}`, "error"));
}

function handlePanelInput(event) {
  rememberFormInput(event);
  updateFormPendingState(event.target.closest("#processing-form, #chunk-form"));
}

function handlePanelChange(event) {
  rememberFormInput(event);
  const form = event.target.closest("#processing-form, #chunk-form");
  if (event.target.matches("#photo-processing-enabled, #photo-resize-enabled, #photo-size-limit-enabled")) {
    updateProcessingControls(form);
  }
  const uncapped = event.target.closest("#photo-upload-uncapped");
  if (uncapped) updateUploadCapControl(uncapped);
  updateFormPendingState(form);
}

function handlePanelSubmit(event) {
  if (event.target.matches("#device-wizard")) return runWizardSubmit(event);
  if (event.target.matches("#device-name-form")) return runDeviceNameSubmit(event);
  if (event.target.matches("#repair-form")) return runRepairSubmit(event);
  if (event.target.matches("#ftp-form")) return runFtpSubmit(event);
  if (event.target.matches("#processing-form")) return runProcessingSubmit(event);
  if (event.target.matches("#chunk-form")) return runTransferSubmit(event);
  if (event.target.matches("#speed-test-form")) return runSpeedTestSubmit(event);
}

async function runDeviceNameSubmit(event) {
  const form = event.target.closest("#device-name-form");
  if (!form) return;
  event.preventDefault();
  const button = form.querySelector('button[type="submit"]');
  const resetButton = setButtonBusy(button, "Saving...");
  try {
    await fetchJson(`/belabox/api/devices/${encodeURIComponent(state.selectedDeviceId)}`, {
      ...postJson({ display_name: formValue(form, "device-display-name").trim() }),
      method: "PATCH",
    });
    showNotice("Device name saved.", "success");
    state.panelHoldKey = "";
    await refresh();
  } catch (error) {
    showNotice(`Device name failed: ${error.message}`, "error");
  } finally {
    resetButton();
  }
}

async function runWizardSubmit(event) {
  const form = event.target.closest("#device-wizard");
  if (!form) return;
  event.preventDefault();
  if (!validateWizardStep(3, form)) return;
  await pairDevice(form, true);
}

async function runRepairSubmit(event) {
  const form = event.target.closest("#repair-form");
  if (!form) return;
  event.preventDefault();
  await pairDevice(form, false);
}

async function runFtpSubmit(event) {
  const form = event.target.closest("#ftp-form");
  if (!form) return;
  event.preventDefault();
  await setupFtpConnector(form);
}

async function runSpeedTestSubmit(event) {
  const form = event.target.closest("#speed-test-form");
  if (!form) return;
  event.preventDefault();
  await runSpeedTest(form);
}

async function runProcessingSubmit(event) {
  const form = event.target.closest("#processing-form");
  if (!form) return;
  event.preventDefault();
  const applied = await applyPhotoProcessing(form);
  if (applied) markFormApplied(form);
  else markFormApplyFailed(form, "Photo preparation settings were not applied.");
}

async function runTransferSubmit(event) {
  const form = event.target.closest("#chunk-form");
  if (!form) return;
  event.preventDefault();
  const mode = formChecked(form, "photo-transport-mode") ? "chunked_https" : "direct_ftp";
  const applied = await applyPhotoTransport(mode, undefined, form, false, form.querySelector("[data-form-apply]"));
  if (applied) markFormApplied(form);
  else markFormApplyFailed(form, "Transfer settings were not applied.");
}

function moveWizard(direction) {
  const form = elements.devicePanel.querySelector("#device-wizard");
  if (direction > 0 && !validateWizardStep(state.wizardStep, form)) return;
  state.wizardStep = Math.max(0, Math.min(WIZARD_STEPS.length - 1, state.wizardStep + direction));
  state.panelHoldKey = "";
  render();
}

function closeWizard() {
  const devices = pairedDevices();
  state.selectedDeviceId = readLastDeviceId() || devices[0]?.device_id || ADD_DEVICE_ID;
  if (state.selectedDeviceId !== ADD_DEVICE_ID) writeLastDeviceId(state.selectedDeviceId);
  resetWizard();
  state.panelHoldKey = "";
  render();
}

async function checkWizardSsh(button) {
  const form = button.closest("#device-wizard");
  if (!validateWizardStep(0, form)) return;
  const resetButton = setButtonBusy(button, "Checking...");
  const output = form.querySelector("#pair-output");
  beginCriticalAction("Testing Belabox SSH", "Opening SSH connection...");
  state.panelLocked = true;
  if (output) output.textContent = "Testing SSH connection...";
  showNotice("Testing Belabox SSH...", "busy");
  try {
    const payload = pairPayload(form);
    criticalActionStep("Running SSH credential check");
    const result = await fetchJson("/belabox/api/ssh/check", postJson(payload));
    finishCriticalAction(`SSH check passed for ${result.device_id || "Belabox"}.`, "success");
    state.wizardSshCheckKey = sshCheckKey(form);
    state.wizardSshCheckResult = result;
    state.wizardStep = 1;
    showNotice("SSH check passed.", "success");
    state.panelLocked = false;
    state.panelHoldKey = "";
    render();
  } catch (error) {
    failCriticalAction(`SSH check failed: ${error.message}`);
    if (output) output.textContent = `SSH check failed: ${error.message}`;
    showNotice(`SSH check failed: ${error.message}`, "error");
  } finally {
    state.panelLocked = false;
    resetButton();
  }
}

function validateWizardStep(step, form) {
  if (!form) return false;
  if (step === 0) return validateWizardWelcome(form);
  if (step === 1) return validateWizardFtp(form);
  if (step === 2) return true;
  return state.wizardSshCheckKey === sshCheckKey(form) || showWizardError("Run the SSH check again before installing.");
}

function validateWizardWelcome(form) {
  if (!hybridReady()) return showWizardError("Hybrid mode is required before installing the Belabox agent.");
  const host = form.querySelector("#pair-host")?.value.trim() || "";
  const user = form.querySelector("#pair-user")?.value.trim() || "";
  const password = form.querySelector("#pair-password")?.value || "";
  const displayName = form.querySelector("#pair-display-name")?.value.trim() || "";
  const deviceId = wizardDeviceId(form);
  if (!host || !user || !password || !displayName) return showWizardError("Device name, Belabox host, SSH username, and SSH password are required.");
  if (!deviceId) return showWizardError("Device name must contain at least one letter or number.");
  if (displayNameExists(displayName)) return showWizardError(`Device name "${displayName}" already exists.`);
  if (deviceIdExists(deviceId)) return showWizardError(`Generated device ID "${deviceId}" already exists. Choose a different device name.`);
  if (hostExists(host)) return showWizardError(`Belabox host/IP "${host}" is already assigned to another device.`);
  return true;
}

function validateWizardFtp(form) {
  if (!form.querySelector("#setup-ftp-enabled")?.checked) return true;
  const targetHost = form.querySelector("#ftp-target-host")?.value.trim() || "";
  const cameraUser = form.querySelector("#camera-ftp-user")?.value.trim() || "";
  if (!targetHost || !cameraUser) return showWizardError("FRAME FTP external host/IP and Belabox FTP Photo Agent Login username are required.");
  return true;
}

function showWizardError(message) {
  showNotice(message, "error");
  const output = elements.devicePanel.querySelector("#pair-output");
  if (output) output.textContent = message;
  return false;
}

async function pairDevice(form, includeModules) {
  const button = form.querySelector("#pair-device");
  const output = form.querySelector("#pair-output") || elements.devicePanel.querySelector("#pair-output");
  const resetButton = setButtonBusy(button, includeModules ? "Pairing..." : "Repairing...");
  beginCriticalAction(includeModules ? "Installing Belabox Agent" : "Repairing Belabox Agent", "Creating SSH job...");
  try {
    state.panelLocked = true;
    state.wizardInstalling = includeModules;
    form.classList.add("installing");
    updateInstallProgress(5);
    if (output) output.textContent = "Queued...";
    showNotice("Pairing Belabox...", "busy");
    const payload = pairPayload(form);
    criticalActionStep("Queueing agent install/repair job");
    const job = await fetchJson("/belabox/api/pair/jobs", postJson(payload));
    const result = await pollPairJob(job.job_id, output);
    updateInstallProgress(60);
    if (output) output.textContent = `${result.device_id}: ${result.agent_status}; ${result.mqtt_status}`;
    if (includeModules && formChecked(form, "setup-ftp-enabled")) {
      await setupFtpConnector(form, result.device_id, output);
      state.panelLocked = true;
      updateInstallProgress(80);
    }
    if (includeModules && formChecked(form, "setup-chunk-enabled")) {
      await applyPhotoTransport("chunked_https", result.device_id, form, true);
      updateInstallProgress(95);
    }
    clearSecrets(form);
    clearWizardSecrets();
    state.selectedDeviceId = result.device_id;
    writeLastDeviceId(result.device_id);
    resetWizard();
    state.panelHoldKey = "";
    updateInstallProgress(100);
    finishCriticalAction(result.mqtt_status === "heartbeat_seen" ? "Belabox paired and online." : "Belabox paired. Waiting for heartbeat.", "success");
    showNotice(result.mqtt_status === "heartbeat_seen" ? "Belabox paired and online." : "Belabox paired. Waiting for heartbeat.", "success");
    await refresh();
  } catch (error) {
    failCriticalAction(`Pairing failed: ${error.message}`);
    showNotice(`Pairing failed: ${error.message}`, "error");
  } finally {
    state.panelLocked = false;
    state.wizardInstalling = false;
    resetButton();
  }
}

async function setupFtpConnector(form, deviceId = state.selectedDeviceId, output = form.querySelector("#ftp-output") || elements.devicePanel.querySelector("#ftp-output")) {
  const button = form.querySelector("#setup-ftp-connector");
  const sshScope = form.querySelector("#pair-host") ? form : elements.devicePanel;
  const sshPayload = pairPayload(sshScope, deviceId);
  const resetButton = setButtonBusy(button, "Installing...");
  const ownsCriticalAction = beginCriticalAction("Installing Photo Agent", "Creating SSH job...");
  state.panelLocked = true;
  if (output) output.textContent = "Queued...";
  showNotice("Installing Photo Agent...", "busy");
  try {
    const payload = {
      ...sshPayload,
      target_host: formValue(form, "ftp-target-host").trim(),
      target_port: formValue(form, "ftp-target-port", 2121),
      camera_username: formValue(form, "camera-ftp-user").trim(),
      camera_password: formValue(form, "camera-ftp-password"),
    };
    criticalActionStep("Queueing Photo Agent install job");
    const job = await fetchJson("/belabox/api/ftp-connector/jobs", postJson(payload));
    const result = await pollFtpConnectorJob(job.job_id, output);
    const lines = ftpCredentialLines(result);
    state.ftpOutputs[deviceId] = lines;
    if (output) output.textContent = lines;
    clearSecrets(form);
    if (ownsCriticalAction) finishCriticalAction("Photo Agent installed and tested.", "success");
    showNotice("Photo Agent installed and tested. Waiting for telemetry.", "success");
    await refresh();
  } catch (error) {
    if (ownsCriticalAction) failCriticalAction(`Photo Agent setup failed: ${error.message}`);
    if (/SSH credentials|SSH Maintenance|Saved SSH/i.test(error.message)) openSshMaintenance(error.message);
    if (output) output.textContent = `Photo Agent setup failed: ${error.message}`;
    showNotice(`Photo Agent setup failed: ${error.message}`, "error");
    if (!ownsCriticalAction) throw error;
  } finally {
    state.panelLocked = false;
    resetButton();
  }
}

async function showFtpCredentials(button) {
  const deviceId = state.selectedDeviceId;
  const output = elements.devicePanel.querySelector("#ftp-output");
  const resetButton = setButtonBusy(button, "Showing...");
  try {
    const result = await fetchJson(`/belabox/api/devices/${encodeURIComponent(deviceId)}/ftp-connector`);
    const lines = ftpCredentialLines(result);
    state.ftpOutputs[deviceId] = lines;
    if (output) output.textContent = lines;
    showNotice("Camera FTP credentials shown.", "success");
  } catch (error) {
    if (output) output.textContent = `Could not show FTP credentials: ${error.message}`;
    showNotice(`Could not show FTP credentials: ${error.message}`, "error");
  } finally {
    resetButton();
  }
}

function ftpCredentialLines(result) {
  return [
    result.target_host ? `FRAME target: ${result.target_host}:${result.target_port}` : "",
    `Camera FTP: ${result.camera_ftp_username}@Belabox:${result.camera_ftp_port}`,
    `Camera FTP password: ${result.camera_ftp_password}`,
    `Managed upload folder: ${result.upload_dir}`,
  ].filter(Boolean).join("\n");
}

async function applyTransferPreset(name, button) {
  const preset = TRANSFER_PRESETS[name];
  if (!preset) return;
  const resetButton = setButtonBusy(button, "Applying...");
  showNotice(`Applying ${preset.label} preset...`, "busy");
  try {
    await sendPhotoCommand("photo_transport_config_set", {
      chunk_size_bytes: preset.chunk_size_bytes,
      chunk_parallel_uploads: preset.chunk_parallel_uploads,
      chunk_upload_kbps: preset.chunk_upload_kbps,
    }, state.selectedDeviceId);
    await sendPhotoCommand("photo_transfer_mode_set", { mode: "chunked_https" }, state.selectedDeviceId);
    showNotice(`${preset.label} preset requested.`, "success");
    state.panelHoldKey = "";
    await refresh();
  } catch (error) {
    showNotice(`${preset.label} preset failed: ${error.message}`, "error");
  } finally {
    resetButton();
  }
}

async function applyPhotoTransport(mode, deviceId = state.selectedDeviceId, source = elements.devicePanel, quiet = false, button = null) {
  const resetButton = setButtonBusy(button, mode === "chunked_https" ? "Enabling..." : "Switching...");
  const root = source?.querySelector ? source : elements.devicePanel;
  const chunkSize = Number(formValue(root, "photo-chunk-size", 0));
  const parallel = Number(formValue(root, "photo-chunk-parallel", 1));
  const uploadKbps = formChecked(root, "photo-upload-uncapped") ? 0 : Number(formValue(root, "photo-chunk-kbps", 2000));
  try {
    if (chunkSize > 0) {
      await sendPhotoCommand("photo_transport_config_set", {
        chunk_size_bytes: chunkSize,
        chunk_parallel_uploads: parallel,
        chunk_upload_kbps: uploadKbps,
      }, deviceId);
    }
    await sendPhotoCommand("photo_transfer_mode_set", { mode }, deviceId);
    if (!quiet) showNotice(`Photo transfer mode requested: ${mode}.`, "success");
    return true;
  } catch (error) {
    showNotice(`${mode === "chunked_https" ? "Chunk Relay" : "Direct FTP"} update failed: ${error.message}`, "error");
    return false;
  } finally {
    resetButton();
  }
}

async function applyPhotoProcessing(form, deviceId = state.selectedDeviceId) {
  const payload = {
    enabled: form.querySelector("#photo-processing-enabled")?.checked === true,
    long_edge_px: form.querySelector("#photo-resize-enabled")?.checked === true ? Number(form.querySelector("#photo-long-edge")?.value || 2400) : 0,
    jpeg_quality: Number(form.querySelector("#photo-jpeg-quality")?.value || 92),
    max_output_mb: form.querySelector("#photo-size-limit-enabled")?.checked === true ? Number(form.querySelector("#photo-max-output")?.value || 4) : 0,
  };
  try {
    await sendPhotoCommand("photo_processing_config_set", payload, deviceId, form.querySelector("[data-form-apply]"));
    showNotice("Pre-transfer processing update requested.", "success");
    return true;
  } catch (error) {
    showNotice(`Processing update failed: ${error.message}`, "error");
    return false;
  }
}

async function sendPhotoCommand(command, args, deviceId = state.selectedDeviceId, button = null) {
  if (!deviceId || deviceId === ADD_DEVICE_ID) throw new Error("Select a paired Belabox device first.");
  const resetButton = setButtonBusy(button, "Applying...");
  showNotice(`Sending ${command}...`, "busy");
  try {
    const queued = await fetchJson("/belabox/api/cmd/request", postJson({
      device_id: deviceId,
      command,
      args,
      confirm: command === "photo_queue_reset",
    }));
    const commandId = queued.command?.command_id;
    if (!commandId) {
      showNotice(`${command} sent to ${deviceId}.`, "success");
      return queued.command;
    }
    const result = await pollCommandResult(commandId, null, COMMAND_POLL_INTERVAL_MS);
    if (result.status === "rejected" || result.error_message) {
      throw new Error(result.error_message || result.result_summary || `${command} failed.`);
    }
    showNotice(result.result_summary || `${command} applied.`, "success");
    await refresh();
    return result;
  } finally {
    resetButton();
  }
}

async function runSpeedTest(form) {
  const button = form.querySelector("#run-speed-test");
  const output = elements.devicePanel.querySelector("#speed-test-output");
  const mib = Math.max(1, Number(form.querySelector("#speed-test-mib")?.value || 8));
  const parallel = Math.max(1, Number(form.querySelector("#speed-test-parallel")?.value || 1));
  const target = form.querySelector('input[name="diagnostic_target"]:checked')?.value || "internet";
  const interfaceName = form.querySelector("#speed-test-interface")?.value || "all";
  const requestedAt = Date.now();
  const resetButton = setButtonBusy(button, "Running...");
  state.panelLocked = true;
  output.textContent = "Queued network speed test...";
  showNotice("Running Belabox interface speed test...", "busy");
  try {
    const queued = await fetchJson("/belabox/api/diagnostics/speed-test", postJson({
      device_id: state.selectedDeviceId,
      target,
      interface_name: interfaceName,
      bytes: Math.round(mib * 1024 * 1024),
      parallel,
    }));
    const result = await pollCommandResult(queued.command.command_id, output, 1000, 300);
    if (result.status === "rejected" || result.error_message) {
      throw new Error(result.error_message || result.result_summary || "Speed test failed.");
    }
    const completed = await waitForDiagnosticCompletion(requestedAt, output);
    output.textContent = completed ? diagnosticSummary(completed) : result.result_summary || "Speed test finished.";
    showNotice("Belabox interface speed test finished.", "success");
  } catch (error) {
    output.textContent = `Speed test failed: ${error.message}`;
    showNotice(`Speed test failed: ${error.message}`, "error");
  } finally {
    state.workspaceTab = "diagnostics";
    try { localStorage.setItem(LAST_WORKSPACE_TAB_KEY, state.workspaceTab); } catch {}
    state.panelLocked = false;
    state.panelHoldKey = "";
    resetButton();
    try { await refresh(); } catch {}
  }
}

async function waitForDiagnosticCompletion(requestedAt, output) {
  let latest = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await refresh();
    latest = liveDevice(state.selectedDeviceId)?.telemetry?.network_diagnostics || null;
    if (latest && output) output.textContent = diagnosticSummary(latest);
    const startedAt = Date.parse(latest?.started_at || "");
    if (Number.isFinite(startedAt) && startedAt >= requestedAt - 2000 && ["complete", "partial", "failed"].includes(latest.state)) {
      return latest;
    }
    await delay(250);
  }
  return latest;
}

async function pollPairJob(jobId, output) {
  for (;;) {
    const job = await fetchJson(`/belabox/api/pair/jobs/${encodeURIComponent(jobId)}`);
    renderJob(job, output);
    if (job.status === "success") return job.result;
    if (job.status === "error") throw new Error(job.error || "Pairing failed.");
    await delay(1000);
  }
}

async function pollFtpConnectorJob(jobId, output) {
  for (;;) {
    const job = await fetchJson(`/belabox/api/ftp-connector/jobs/${encodeURIComponent(jobId)}`);
    renderJob(job, output);
    if (job.status === "success") return job.result;
    if (job.status === "error") throw new Error(job.error || "Photo Agent setup failed.");
    await delay(1000);
  }
}

async function pollCommandResult(commandId, output, intervalMs = 1000, maxAttempts = 90) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await refresh();
    const diagnostic = liveDevice(state.selectedDeviceId)?.telemetry?.network_diagnostics;
    if (diagnostic && output) output.textContent = diagnosticSummary(diagnostic);
    const audit = await fetchJson("/belabox/api/commands");
    const result = (audit.commands || []).find((entry) => entry.type === "result" && entry.command_id === commandId);
    if (result) return result;
    await delay(intervalMs);
  }
  throw new Error("Timed out waiting for agent result.");
}

function renderJob(job, output) {
  const lines = (job.steps || []).map((step) => `${formatDate(step.at)}  ${step.message}`);
  if (job.status === "error" && job.error) lines.push(`Error: ${job.error}`);
  if (output) output.textContent = lines.join("\n");
  const pct = job.status === "success" ? 60 : job.status === "error" ? 100 : Math.min(55, 10 + (job.steps || []).length * 10);
  updateCriticalActionFromJob(job, pct);
  updateInstallProgress(pct);
  showNotice(job.step || "");
}

async function removeProvisionedDevice(button) {
  const deviceId = button.dataset.removeDevice;
  if (!await confirmAction({
    title: "Remove Device From FRAME?",
    message: `${deviceId} will be removed from this manager. This does not uninstall the agent from the Belabox.`,
    confirmLabel: "Remove Device",
  })) return;
  const resetButton = setButtonBusy(button, "Removing...");
  try {
    await fetchJson(`/belabox/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
    state.selectedDeviceId = ADD_DEVICE_ID;
    showNotice(`${deviceId} removed from FRAME.`, "success");
    await refresh();
  } catch (error) {
    showNotice(`Remove failed: ${error.message}`, "error");
  } finally {
    resetButton();
  }
}

async function uninstallAgent(button) {
  const deviceId = button.dataset.uninstallAgent;
  if (!await confirmAction({
    title: "Uninstall Belabox Agent?",
    message: `FRAME services on ${deviceId} will be stopped and its local photo spool and logs will be archived.`,
    confirmLabel: "Uninstall Agent",
  })) return;
  const resetButton = setButtonBusy(button, "Uninstalling...");
  beginCriticalAction("Uninstalling Belabox Agent", "Preparing SSH uninstall...");
  state.panelLocked = true;
  try {
    criticalActionStep("Collecting SSH credentials");
    const sshPayload = pairPayload(elements.devicePanel, deviceId);
    criticalActionStep("Stopping FRAME services on the Belabox");
    const result = await fetchJson("/belabox/api/agent/remove", postJson({ ...sshPayload, purge: false }));
    finishCriticalAction(`${deviceId} agent uninstalled. ${result.summary || ""}`.trim(), "success");
    showNotice(`${deviceId} agent uninstalled. ${result.summary || ""}`, "success");
    await refresh();
  } catch (error) {
    failCriticalAction(`Agent uninstall failed: ${error.message}`);
    showNotice(`Agent uninstall failed: ${error.message}`, "error");
  } finally {
    state.panelLocked = false;
    resetButton();
  }
}

async function copyToClipboard(button) {
  const text = button.dataset.copyText || "";
  try {
    await navigator.clipboard.writeText(text);
    showNotice("Remote URL copied.", "success");
  } catch {
    showNotice(text, "success");
  }
}

async function forgetSavedSsh(button) {
  const deviceId = state.selectedDeviceId;
  if (!await confirmAction({
    title: "Forget Saved SSH Login?",
    message: `Future repair or uninstall work for ${deviceId} will require the SSH password again.`,
    confirmLabel: "Forget Login",
  })) return;
  const resetButton = setButtonBusy(button, "Forgetting...");
  try {
    await fetchJson(`/belabox/api/devices/${encodeURIComponent(deviceId)}/ssh-credential`, { method: "DELETE" });
    showNotice("Saved SSH credential removed.", "success");
    await refresh();
  } catch (error) {
    showNotice(`Forget SSH failed: ${error.message}`, "error");
  } finally {
    resetButton();
  }
}

function pairPayload(form, deviceId) {
  return {
    host: formValue(form, "pair-host").trim(),
    port: formValue(form, "pair-port", 22),
    user: formValue(form, "pair-user", "user").trim(),
    password: formValue(form, "pair-password"),
    device_id: deviceId || (form?.id === "device-wizard" ? wizardDeviceId(form) : formValue(form, "pair-device-id").trim()),
    display_name: form?.id === "device-wizard" ? formValue(form, "pair-display-name").trim() : "",
    install_diagnostics: formChecked(form, "install-diagnostics"),
    enable_ssh_on_boot: formChecked(form, "enable-ssh-on-boot"),
    remember_ssh: formChecked(form, "remember-ssh"),
  };
}

function clearSecrets(scope) {
  scope.querySelectorAll('input[type="password"], textarea').forEach((input) => {
    input.value = "";
    delete state.formDraft[draftKey(input)];
  });
}

function clearWizardSecrets() {
  for (const id of ["pair-password", "camera-ftp-password"]) {
    delete state.formDraft[`${ADD_DEVICE_ID}:device-wizard:${id}`];
  }
}

async function resetPhotoQueue(button) {
  const deviceId = state.selectedDeviceId;
  if (!await confirmAction({
    title: "Reset Photo Queue?",
    message: "Pending photos will be moved into a reset archive on the Belabox. Transfer settings and active work are preserved.",
    confirmLabel: "Reset Queue",
  })) return;
  beginCriticalAction("Resetting Photo Queue", "Sending the signed reset command...");
  state.panelLocked = true;
  try {
    criticalActionStep("Archiving pending Belabox spool files");
    const result = await sendPhotoCommand("photo_queue_reset", {}, deviceId, button);
    finishCriticalAction(result.result_summary || "Photo queue reset completed.", "success");
  } catch (error) {
    failCriticalAction(`Photo queue reset failed: ${error.message}`);
  } finally {
    state.panelLocked = false;
  }
}

function formValue(form, id, fallback = "") {
  const input = form?.querySelector?.(`#${id}`);
  if (input) return input.value;
  if (form?.id === "device-wizard") return wizardDraftValue(id, fallback);
  return fallback;
}

function formChecked(form, id) {
  const input = form?.querySelector?.(`#${id}`);
  if (input) return input.checked === true;
  return form?.id === "device-wizard" ? wizardDraftChecked(id) : false;
}

function trackedFormSnapshot(form) {
  if (form?.id === "processing-form") {
    return {
      enabled: formChecked(form, "photo-processing-enabled"),
      long_edge_px: formChecked(form, "photo-resize-enabled") ? Number(formValue(form, "photo-long-edge", 2400)) : 0,
      jpeg_quality: Number(formValue(form, "photo-jpeg-quality", 92)),
      max_output_mb: formChecked(form, "photo-size-limit-enabled") ? Number(formValue(form, "photo-max-output", 4)) : 0,
    };
  }
  if (form?.id === "chunk-form") {
    return {
      chunk_size_bytes: Number(formValue(form, "photo-chunk-size", 1048576)),
      chunk_parallel_uploads: Number(formValue(form, "photo-chunk-parallel", 1)),
      chunk_upload_kbps: formChecked(form, "photo-upload-uncapped") ? 0 : Number(formValue(form, "photo-chunk-kbps", 2000)),
      transfer_mode: formChecked(form, "photo-transport-mode") ? "chunked_https" : "direct_ftp",
    };
  }
  return null;
}

function formBaseline(form) {
  try {
    return JSON.parse(form?.dataset.formBaseline || "{}");
  } catch {
    return {};
  }
}

function updateFormPendingState(form, requestedTone = "") {
  const current = trackedFormSnapshot(form);
  if (!form || !current) return;
  const baseline = formBaseline(form);
  const count = Object.keys(current).filter((key) => current[key] !== baseline[key]).length;
  const pending = count > 0;
  const commit = form.querySelector("[data-form-commit]");
  if (!commit) return;
  const badge = form.closest("details")?.querySelector("[data-pending-badge]");
  const apply = commit.querySelector("[data-form-apply]");
  const discard = commit.querySelector("[data-discard-form]");
  const title = commit.querySelector("[data-form-commit-title]");
  const detail = commit.querySelector("[data-form-commit-detail]");
  const displayName = commit.dataset.deviceName || "this Belabox";
  const tone = requestedTone || (pending ? "pending" : "clean");

  commit.dataset.tone = tone;
  if (badge) {
    badge.hidden = !pending;
    badge.textContent = `${count} unsaved`;
  }
  apply.hidden = !pending;
  apply.disabled = !pending || commit.dataset.online !== "true";
  discard.hidden = !pending;

  if (tone === "success") {
    title.textContent = "Changes applied.";
    detail.textContent = `${displayName} acknowledged these settings.`;
  } else if (tone === "error") {
    title.textContent = "Changes not applied.";
    detail.textContent = `Your edits are still here. Retry when ${displayName} is reachable.`;
  } else if (pending) {
    title.textContent = `${count} unapplied change${count === 1 ? "" : "s"}`;
    detail.textContent = `These settings have not been sent to ${displayName}.`;
  } else {
    title.textContent = "Settings are up to date.";
    detail.textContent = "Edits stay local until you apply them.";
  }
}

function clearTrackedFormDraft(form) {
  form?.querySelectorAll("input, textarea, select").forEach((input) => delete state.formDraft[draftKey(input)]);
}

function markFormApplied(form) {
  form.dataset.formBaseline = JSON.stringify(trackedFormSnapshot(form));
  clearTrackedFormDraft(form);
  updateFormPendingState(form, "success");
}

function markFormApplyFailed(form, message) {
  updateFormPendingState(form, "error");
  const detail = form.querySelector("[data-form-commit-detail]");
  if (detail) detail.textContent = message;
}

function discardFormChanges(form) {
  const baseline = formBaseline(form);
  if (form?.id === "processing-form") {
    form.querySelector("#photo-processing-enabled").checked = baseline.enabled === true;
    form.querySelector("#photo-resize-enabled").checked = Number(baseline.long_edge_px) > 0;
    form.querySelector("#photo-long-edge").value = String(Number(baseline.long_edge_px) || 2400);
    form.querySelector("#photo-jpeg-quality").value = String(Number(baseline.jpeg_quality) || 92);
    form.querySelector("#photo-size-limit-enabled").checked = Number(baseline.max_output_mb) > 0;
    form.querySelector("#photo-max-output").value = String(Number(baseline.max_output_mb) || 4);
  } else if (form?.id === "chunk-form") {
    form.querySelector("#photo-chunk-size").value = String(Number(baseline.chunk_size_bytes) || 1048576);
    form.querySelector("#photo-chunk-parallel").value = String(Number(baseline.chunk_parallel_uploads) || 1);
    form.querySelector("#photo-upload-uncapped").checked = Number(baseline.chunk_upload_kbps) <= 0;
    form.querySelector("#photo-chunk-kbps").value = String(Number(baseline.chunk_upload_kbps) || 2000);
    form.querySelector("#photo-transport-mode").checked = baseline.transfer_mode === "chunked_https";
  } else {
    return;
  }

  form.querySelectorAll('input[type="range"]').forEach(updateSliderValue);
  if (form.id === "processing-form") updateProcessingControls(form);
  if (form.id === "chunk-form") updateUploadCapControl(form.querySelector("#photo-upload-uncapped"));
  clearTrackedFormDraft(form);
  updateFormPendingState(form);
  showNotice("Unapplied changes discarded.", "ready");
}

function rememberFormInput(event) {
  const input = event.target;
  if (!input.matches?.("input, textarea, select")) return;
  holdCurrentPanelRender();
  state.formDraft[draftKey(input)] = input.type === "checkbox" ? input.checked : input.value;
  if (input.closest("#device-wizard") && ["pair-host", "pair-port", "pair-user", "pair-password", "pair-display-name"].includes(input.id)) {
    state.wizardSshCheckKey = "";
    state.wizardSshCheckResult = null;
  }
  if (input.matches('input[type="range"]')) updateSliderValue(input);
}

function restoreFormDraft() {
  elements.devicePanel.querySelectorAll("input, textarea, select").forEach((input) => {
    const key = draftKey(input);
    if (!(key in state.formDraft)) return;
    if (input.type === "checkbox") input.checked = Boolean(state.formDraft[key]);
    else input.value = state.formDraft[key];
    if (input.type === "range") updateSliderValue(input);
  });
  elements.devicePanel.querySelectorAll("#processing-form, #chunk-form").forEach((form) => {
    if (form.id === "processing-form") updateProcessingControls(form);
    if (form.id === "chunk-form") updateUploadCapControl(form.querySelector("#photo-upload-uncapped"));
    updateFormPendingState(form);
  });
}

function rememberDetailsState(event) {
  const details = event.target;
  if (!details.matches?.("details[data-section]")) return;
  holdCurrentPanelRender();
  state.detailsOpen[detailKey(details)] = details.open;
}

function rememberCurrentDetailsState() {
  elements.devicePanel.querySelectorAll("details[data-section]").forEach((details) => {
    state.detailsOpen[detailKey(details)] = details.open;
  });
}

function restoreDetailsState() {
  elements.devicePanel.querySelectorAll("details[data-section]").forEach((details) => {
    const key = detailKey(details);
    if (key in state.detailsOpen) details.open = state.detailsOpen[key];
  });
}

function draftKey(input) {
  const panelKey = input.closest("[data-panel-key]")?.dataset.panelKey || state.selectedDeviceId;
  const formId = input.closest("form")?.id || "panel";
  return `${panelKey}:${formId}:${input.id || input.name}`;
}

function detailKey(details) {
  return `${elements.devicePanel.dataset.panelKey || state.selectedDeviceId}:${details.dataset.section}`;
}

function panelHasEditableFocus() {
  const active = document.activeElement;
  return Boolean(active && elements.devicePanel.contains(active) && active.matches?.("input, textarea, select"));
}

function holdCurrentPanelRender() {
  state.panelHoldKey = elements.devicePanel.dataset.panelKey || state.selectedDeviceId;
}

function panelRenderHeld(panelKey) {
  return state.panelHoldKey === panelKey || panelHasEditableFocus();
}

function setButtonBusy(button, label) {
  if (!button) return () => undefined;
  const original = button.dataset.originalLabel || button.textContent;
  button.dataset.originalLabel = original;
  button.textContent = label;
  button.disabled = true;
  button.classList.add("busy");
  return () => {
    button.textContent = button.dataset.originalLabel || original;
    button.disabled = false;
    button.classList.remove("busy");
  };
}

function ensureCriticalActionDialog() {
  if (document.getElementById("critical-action-modal")) return;
  document.body.insertAdjacentHTML("beforeend", `<div id="critical-action-modal" class="critical-action-modal hidden" role="dialog" aria-modal="true" aria-labelledby="critical-action-title">
    <section class="critical-action-card" tabindex="-1">
      <p class="eyebrow">SSH Maintenance</p>
      <h2 id="critical-action-title">Working</h2>
      <progress id="critical-action-progress" max="100" value="0"></progress>
      <p id="critical-action-status" class="critical-action-status">Starting...</p>
      <ol id="critical-action-steps" class="critical-action-steps"></ol>
      <div class="actions critical-action-actions">
        <button id="critical-action-close" type="button" class="secondary">Done</button>
      </div>
    </section>
  </div>`);
  document.getElementById("critical-action-close")?.addEventListener("click", () => {
    if (!criticalActionRunning()) closeCriticalAction();
  });
}

function ensureConfirmationDialog() {
  if (document.getElementById("confirmation-dialog")) return;
  document.body.insertAdjacentHTML("beforeend", `<dialog id="confirmation-dialog" class="confirmation-dialog" aria-labelledby="confirmation-title" aria-describedby="confirmation-message">
    <form method="dialog" class="confirmation-card">
      <p class="eyebrow">Confirm action</p>
      <h2 id="confirmation-title">Are you sure?</h2>
      <p id="confirmation-message"></p>
      <div class="actions confirmation-actions">
        <button type="submit" class="secondary" value="cancel">Cancel</button>
        <button id="confirmation-confirm" type="submit" class="danger" value="confirm">Confirm</button>
      </div>
    </form>
  </dialog>`);
}

function confirmAction({ title, message, confirmLabel }) {
  const dialog = document.getElementById("confirmation-dialog");
  if (!dialog?.showModal) return Promise.resolve(window.confirm(message));
  dialog.querySelector("#confirmation-title").textContent = title;
  dialog.querySelector("#confirmation-message").textContent = message;
  const confirmButton = dialog.querySelector("#confirmation-confirm");
  confirmButton.textContent = confirmLabel;
  dialog.returnValue = "cancel";
  dialog.showModal();
  confirmButton.focus();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
}

function beginCriticalAction(title, status) {
  if (criticalActionRunning()) {
    criticalActionStep(status);
    return false;
  }
  state.criticalAction = {
    title,
    status,
    progress: 5,
    tone: "busy",
    running: true,
    steps: [{ at: new Date().toISOString(), message: status }],
  };
  document.body.classList.add("critical-action-active");
  setManagerInert(true);
  renderCriticalActionDialog();
  document.querySelector(".critical-action-card")?.focus();
  return true;
}

function criticalActionStep(message, progress = null) {
  const action = state.criticalAction;
  if (!action) return;
  action.status = message;
  if (progress !== null) action.progress = Math.max(action.progress || 0, progress);
  const last = action.steps[action.steps.length - 1]?.message;
  if (message && message !== last) action.steps.push({ at: new Date().toISOString(), message });
  action.steps = action.steps.slice(-30);
  renderCriticalActionDialog();
}

function updateCriticalActionFromJob(job, progress) {
  const action = state.criticalAction;
  if (!action) return;
  action.status = job.step || action.status;
  action.progress = progress;
  action.steps = (job.steps || []).map((step) => ({ at: step.at, message: step.message }));
  if (job.status === "error" && job.error) {
    action.tone = "error";
    action.steps.push({ at: new Date().toISOString(), message: `Error: ${job.error}` });
  }
  renderCriticalActionDialog();
}

function finishCriticalAction(message, tone = "success") {
  const action = state.criticalAction;
  if (!action) return;
  action.running = false;
  action.tone = tone;
  action.progress = 100;
  criticalActionStep(message, 100);
  renderCriticalActionDialog();
  document.getElementById("critical-action-close")?.focus();
}

function failCriticalAction(message) {
  finishCriticalAction(message, "error");
}

function closeCriticalAction() {
  state.criticalAction = null;
  document.body.classList.remove("critical-action-active");
  setManagerInert(false);
  renderCriticalActionDialog();
  elements.devicePanel.focus();
}

function setManagerInert(value) {
  document.querySelector(".topbar").inert = value;
  document.querySelector(".shell").inert = value;
}

function criticalActionRunning() {
  return state.criticalAction?.running === true;
}

function renderCriticalActionDialog() {
  const modal = document.getElementById("critical-action-modal");
  if (!modal) return;
  const action = state.criticalAction;
  modal.classList.toggle("hidden", !action);
  if (!action) return;
  modal.dataset.tone = action.tone || "busy";
  modal.querySelector("#critical-action-title").textContent = action.title || "Working";
  modal.querySelector("#critical-action-status").textContent = action.status || "Working...";
  modal.querySelector("#critical-action-progress").value = action.progress || 0;
  modal.querySelector("#critical-action-steps").innerHTML = (action.steps || [])
    .map((step) => `<li><span>${escapeHtml(formatDate(step.at))}</span>${escapeHtml(step.message)}</li>`)
    .join("");
  const close = modal.querySelector("#critical-action-close");
  close.hidden = action.running;
  close.disabled = action.running;
}

function blockCriticalNavigation(event) {
  if (!criticalActionRunning()) return;
  if (event.target.closest?.("#critical-action-modal")) return;
  const target = event.target.closest?.("a[href], button, input, select, textarea");
  if (!target) return;
  if (target.closest?.("#critical-action-modal")) return;
  event.preventDefault();
  event.stopPropagation();
  criticalActionStep("Finish the SSH action before leaving this page.");
}

function handleCriticalBeforeUnload(event) {
  if (!criticalActionRunning()) return;
  event.preventDefault();
  event.returnValue = "";
}

function postJson(body) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  };
}

function pairedDevices() {
  return state.status?.provisioning?.devices || [];
}

function liveDevices() {
  return state.status?.devices || [];
}

function liveDevice(deviceId) {
  return liveDevices().find((device) => device.device_id === deviceId);
}

function ftpConnector(deviceId) {
  return (state.status?.ftp_connectors || []).find((record) => record.device_id === deviceId);
}

function savedSshCredential(deviceId) {
  return (state.status?.ssh_credentials?.devices || []).find((record) => record.device_id === deviceId);
}

function sshCredentialSaveEnabled() {
  return state.status?.ssh_credentials?.save_enabled === true;
}

function openSshMaintenance(message) {
  selectWorkspaceTab("system");
  let section = elements.devicePanel.querySelector("#repair-form")?.closest("details");
  while (section) {
    section.open = true;
    section = section.parentElement?.closest("details");
  }
  const output = elements.devicePanel.querySelector("#pair-output");
  if (output) output.textContent = message;
  elements.devicePanel.querySelector("#pair-host")?.focus();
}

function ftpDefaultHost() {
  const value = state.status?.ftp_connector?.target_host || "";
  return value === "Not set" ? "" : value;
}

function ftpTargetHost(connector) {
  const value = connector?.target_host || ftpDefaultHost();
  return value === "Not set" ? "" : value;
}

function connectorStatus(connector, ftp) {
  if (ftp?.state || ftp?.status_text) return ftp.status_text || ftp.state;
  return connector ? "Installed" : "Not installed";
}

function chunkStatus(ftp) {
  if (ftp?.transfer_mode === "chunked_https" || ftp?.transport === "chunked_https") return "Enabled";
  return "Direct FTP";
}

function applyWizardPreset(name) {
  const preset = TRANSFER_PRESETS[name];
  const form = elements.devicePanel.querySelector("#device-wizard");
  if (!preset || !form) return;
  setInputValue(form.querySelector("#photo-chunk-size"), preset.chunk_size_bytes);
  setInputValue(form.querySelector("#photo-chunk-parallel"), preset.chunk_parallel_uploads);
  setInputValue(form.querySelector("#photo-chunk-kbps"), preset.chunk_upload_kbps || 2000);
  const uncapped = form.querySelector("#photo-upload-uncapped");
  uncapped.checked = preset.chunk_upload_kbps <= 0;
  state.formDraft[draftKey(uncapped)] = uncapped.checked;
  updateUploadCapControl(uncapped);
  showNotice(`${preset.label} preset selected.`, "success");
}

function updateUploadCapControl(control) {
  const slider = control.closest("form")?.querySelector("#photo-chunk-kbps");
  if (!slider) return;
  if (!control.checked && Number(slider.value || 0) <= 0) setInputValue(slider, 2000);
  slider.disabled = control.checked;
  document.getElementById(`${slider.id}-value`).textContent = control.checked ? "Uncapped" : formatUploadCap(slider.value);
}

function updateProcessingControls(form) {
  if (!form) return;
  const enabled = form.querySelector("#photo-processing-enabled")?.checked === true;
  const resize = form.querySelector("#photo-resize-enabled");
  const sizeLimit = form.querySelector("#photo-size-limit-enabled");
  resize.disabled = !enabled;
  sizeLimit.disabled = !enabled;
  setSliderDisabled(form.querySelector("#photo-long-edge"), !enabled || !resize.checked, "Original dimensions");
  setSliderDisabled(form.querySelector("#photo-max-output"), !enabled || !sizeLimit.checked, "No limit");
  setSliderDisabled(form.querySelector("#photo-jpeg-quality"), !enabled, "Processing off");
}

function setSliderDisabled(slider, disabled, disabledLabel) {
  if (!slider) return;
  slider.disabled = disabled;
  const output = document.getElementById(`${slider.id}-value`);
  if (disabled) output.textContent = disabledLabel;
  else updateSliderValue(slider);
}

function setInputValue(input, value) {
  if (!input) return;
  input.value = String(value);
  state.formDraft[draftKey(input)] = input.type === "checkbox" ? input.checked : input.value;
  if (input.type === "range") updateSliderValue(input);
}

function sliderControl(id, name, label, min, max, step, value, formatter, disabled = false, disabledLabel = "") {
  const current = Number(state.selectedDeviceId === ADD_DEVICE_ID ? wizardDraftValue(id, value) : value);
  return `<label class="slider-control wide">${escapeHtml(label)}
    <span id="${escapeAttr(id)}-value">${escapeHtml(disabled ? disabledLabel : formatter(current))}</span>
    <input id="${escapeAttr(id)}" name="${escapeAttr(name)}" type="range" min="${min}" max="${max}" step="${step}" value="${escapeAttr(current)}" data-format="${escapeAttr(id)}" ${disabled ? "disabled" : ""}>
  </label>`;
}

function updateSliderValue(input) {
  const output = document.getElementById(`${input.id}-value`);
  if (!output) return;
  const value = Number(input.value || 0);
  if (input.id === "photo-chunk-size") output.textContent = formatChunkSize(value);
  else if (input.id === "photo-chunk-parallel") output.textContent = `${value} connection${value === 1 ? "" : "s"}`;
  else if (input.id === "photo-chunk-kbps") output.textContent = formatUploadCap(value);
  else if (input.id === "photo-long-edge") output.textContent = formatPixelEdge(value);
  else if (input.id === "photo-jpeg-quality") output.textContent = `${value}%`;
  else if (input.id === "photo-max-output") output.textContent = formatMaxOutput(value);
  else if (input.id === "speed-test-mib") output.textContent = `${value} MiB`;
  else if (input.id === "speed-test-parallel") output.textContent = `${value} stream${value === 1 ? "" : "s"}`;
}

function selectWorkspaceTab(tabName) {
  state.workspaceTab = WORKSPACE_TABS.includes(tabName) ? tabName : "overview";
  try { localStorage.setItem(LAST_WORKSPACE_TAB_KEY, state.workspaceTab); } catch {}
  elements.devicePanel.querySelectorAll("[data-workspace-tab]").forEach((tab) => {
    const active = tab.dataset.workspaceTab === state.workspaceTab;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  elements.devicePanel.querySelectorAll("[data-workspace-pane]").forEach((pane) => {
    pane.hidden = pane.dataset.workspacePane !== state.workspaceTab;
  });
  state.panelHoldKey = "";
}

function setAdvancedView(enabled) {
  state.advancedView = enabled === true;
  elements.devicePanel.dataset.advancedView = String(state.advancedView);
  elements.devicePanel.querySelectorAll("[data-view-mode]").forEach((button) => {
    const active = button.dataset.viewMode === (state.advancedView ? "advanced" : "simple");
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  try { localStorage.setItem(ADVANCED_VIEW_KEY, String(state.advancedView)); } catch {}
  state.panelHoldKey = "";
}

function wizardSummary() {
  const form = elements.devicePanel.querySelector("#device-wizard");
  const setupFtp = formChecked(form, "setup-ftp-enabled");
  const setupChunk = formChecked(form, "setup-chunk-enabled");
  const uploadKbps = formChecked(form, "photo-upload-uncapped") ? 0 : Number(formValue(form, "photo-chunk-kbps", 2000));
  const rowsList = [
    ["Device", formValue(form, "pair-display-name")],
    ["Device ID", wizardDeviceId(form)],
    ["Belabox SSH", `${formValue(form, "pair-user", "user")}@${formValue(form, "pair-host", "host")}:${formValue(form, "pair-port", 22)}`],
    ["SSH on boot", formChecked(form, "enable-ssh-on-boot") ? "Enabled" : "No change"],
    ["Maintenance login", formChecked(form, "remember-ssh") ? "Save encrypted" : "Do not save"],
    ["FTP Photo Agent", setupFtp ? `${formValue(form, "ftp-target-host", "target")}:${formValue(form, "ftp-target-port", 2121)}` : "Disabled"],
    ["Stream Safe Photo Transfer", setupChunk ? `${formatChunkSize(Number(formValue(form, "photo-chunk-size", 0)))}, ${formValue(form, "photo-chunk-parallel", 1)} connection(s), ${formatUploadCap(uploadKbps)}` : "Disabled"],
  ];
  const warnings = [];
  if (setupChunk && uploadKbps <= 0) warnings.push("Fast/uncapped photo transfer can compete with the live stream and slow bitrate recovery.");
  if (setupFtp) warnings.push("FTP Photo Agent requires your port forward to reach the FRAME FTP server.");
  if (!setupFtp && !setupChunk) warnings.push("No photo transfer module is selected; only the remote/control agent will be installed.");
  return { rows: rowsList, warnings };
}

function presetSummary(preset) {
  return `${formatChunkSize(preset.chunk_size_bytes)}, ${preset.chunk_parallel_uploads} connection${preset.chunk_parallel_uploads === 1 ? "" : "s"}, ${formatUploadCap(preset.chunk_upload_kbps)}`;
}

function wizardDeviceId(form) {
  const explicit = form?.querySelector("#pair-device-id")?.value.trim() || wizardDraftValue("pair-device-id", "");
  const displayName = form?.querySelector("#pair-display-name")?.value.trim() || wizardDraftValue("pair-display-name", "");
  const host = form?.querySelector("#pair-host")?.value.trim() || wizardDraftValue("pair-host", "");
  return sanitizeDeviceId(explicit || displayName || `belabox-${host.replace(/[^A-Za-z0-9]+/g, "-")}`);
}

function sanitizeDeviceId(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function deviceIdExists(deviceId) {
  return pairedDevices().some((device) => device.device_id === deviceId);
}

function displayNameExists(displayName) {
  const normalized = String(displayName || "").trim().toLocaleLowerCase();
  return pairedDevices().some((device) => (device.display_name || device.device_id).toLocaleLowerCase() === normalized);
}

function hostExists(host) {
  const normalized = String(host || "").trim().toLowerCase();
  return pairedDevices().some((device) => String(device.host || "").trim().toLowerCase() === normalized);
}

function sshCheckKey(form) {
  return [
    form?.querySelector("#pair-host")?.value.trim() || wizardDraftValue("pair-host", ""),
    form?.querySelector("#pair-port")?.value || wizardDraftValue("pair-port", "22"),
    form?.querySelector("#pair-user")?.value.trim() || wizardDraftValue("pair-user", "user"),
    form?.querySelector("#pair-display-name")?.value.trim() || wizardDraftValue("pair-display-name", ""),
    wizardDeviceId(form),
  ].join("|");
}

function hybridReady() {
  if (state.status?.frame?.mode === "HYBRID") return true;
  try {
    const url = new URL(state.status?.mqtt?.public_host || window.location.origin);
    return url.protocol === "https:" && !isLocalHost(url.hostname);
  } catch {
    return false;
  }
}

function resetWizard() {
  state.wizardStep = 0;
  state.wizardSshCheckKey = "";
  state.wizardSshCheckResult = null;
  state.wizardInstalling = false;
  for (const key of Object.keys(state.formDraft)) {
    if (key.startsWith(`${ADD_DEVICE_ID}:device-wizard:`)) delete state.formDraft[key];
  }
}

function updateInstallProgress(value) {
  const progress = elements.devicePanel.querySelector("#install-progress");
  if (progress) progress.value = Math.max(Number(progress.value || 0), value);
}

function wizardDraftValue(id, fallback = "") {
  const key = `${ADD_DEVICE_ID}:device-wizard:${id}`;
  return key in state.formDraft ? state.formDraft[key] : fallback;
}

function wizardDraftChecked(id, fallback = false) {
  const key = `${ADD_DEVICE_ID}:device-wizard:${id}`;
  return key in state.formDraft ? state.formDraft[key] === true : fallback;
}

function formatChunkSize(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes % (1024 * 1024) ? 1 : 0)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

function remoteAccessUrl(deviceId) {
  const path = `/belabox/remote?key=${encodeURIComponent(deviceId)}`;
  try {
    return new URL(path, publicFrameOrigin()).href;
  } catch {
    return path;
  }
}

function publicFrameOrigin() {
  const configured = state.status?.mqtt?.public_host || "";
  try {
    const url = new URL(configured || window.location.origin);
    if (!isLocalHost(url.hostname)) url.protocol = "https:";
    return url.origin;
  } catch {
    return window.location.origin;
  }
}

function isLocalHost(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
}

function statusTile(label, value, tone = "neutral") {
  return `<div class="status-tile ${escapeAttr(tone)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function transferPresetButtons(chunkSize, parallel, kbps, online) {
  const selected = selectedTransferPreset(chunkSize, parallel, kbps);
  return Object.entries(TRANSFER_PRESETS).map(([key, preset]) => {
    const active = selected === key ? " active" : "";
    const cap = preset.chunk_upload_kbps ? formatUploadCap(preset.chunk_upload_kbps) : "Uncapped";
    return `<button class="preset-button${active}" type="button" data-transfer-preset="${escapeAttr(key)}" ${online ? "" : "disabled"}>
      <strong>${escapeHtml(preset.label)}</strong>
      <span>${preset.chunk_parallel_uploads} stream${preset.chunk_parallel_uploads === 1 ? "" : "s"} &middot; ${escapeHtml(cap)}</span>
    </button>`;
  }).join("");
}

function selectedTransferPreset(chunkSize, parallel, kbps) {
  const match = Object.entries(TRANSFER_PRESETS).find(([, preset]) =>
    preset.chunk_size_bytes === chunkSize
      && preset.chunk_parallel_uploads === parallel
      && preset.chunk_upload_kbps === kbps,
  );
  return match ? match[0] : "";
}

function remoteBelauiStatus(value) {
  if (!value?.enabled) return "Disabled";
  if (value.state === "reachable") return `Reachable (${value.http_status || "HTTP"})`;
  if (value.state === "unreachable") return "Unreachable";
  return value.state || "Configured";
}

function friendlyTransferState(ftp, connector) {
  if (!connector && !ftp?.state) return "Needs setup";
  const stateName = String(ftp?.state || "").toLowerCase();
  if (ftp?.done || stateName === "complete" || stateName === "published") return "Sent to FRAME";
  if (stateName === "failed" || stateName === "error") return "Needs attention";
  if (stateName === "uploading") return "Uploading";
  if (["connecting", "preparing", "assembling"].includes(stateName)) return "Sending";
  if (stateName === "processing") return "Processing";
  if (stateName === "queued") return "Queued";
  if (stateName === "idle") return "Ready";
  return ftp?.status_text || stateName || "Waiting";
}

function friendlyTransferMode(ftp) {
  return ftp?.transfer_mode === "chunked_https" || ftp?.transport === "chunked_https" ? "Stream-safe HTTPS" : "Direct FTP";
}

function streamSafetyLabel(ftp, kbps) {
  if (ftp?.transfer_mode !== "chunked_https" && ftp?.transport !== "chunked_https") return "Direct FTP";
  return kbps > 0 ? "Capped" : "Uncapped";
}

function slowdownSummary(live, connector, ftp, preprocess, egress, kbps) {
  if (!live?.online) return { tone: "warn", title: "Encoder offline", detail: "FRAME is waiting for the Belabox agent to reconnect." };
  if (!connector) return { tone: "warn", title: "Photo Agent not installed", detail: "Install the Photo Agent before camera uploads can be managed." };
  if (ftp?.last_error) return { tone: "warn", title: "Last transfer needs attention", detail: ftp.last_error };
  if (String(preprocess?.state || "").toLowerCase() === "processing") return { tone: "busy", title: "Preparing images on the Belabox", detail: "Image resize/compression is active before upload begins." };
  if (ftp?.state === "uploading") {
    const cap = kbps > 0 ? `Upload is capped at ${formatUploadCap(kbps)}.` : "Upload is uncapped and can compete with the live stream.";
    return { tone: kbps > 0 ? "good" : "warn", title: "Network upload is active", detail: cap };
  }
  if (Number(ftp?.queue_count || 0) > 0 && Number(ftp?.processed_count || 0) === 0) return { tone: "busy", title: "Waiting for upload-ready files", detail: "The Belabox is staging or processing photos before sending them." };
  if (egress?.lane_count && !egress.healthy_lane_count) return { tone: "warn", title: "No healthy egress lanes", detail: "The agent can see network interfaces, but none currently route cleanly to FRAME." };
  if (kbps === 0 && (ftp?.transfer_mode === "chunked_https" || ftp?.transport === "chunked_https")) return { tone: "warn", title: "Uploads are uncapped", detail: "Use Protect Stream while live to avoid starving SRTLA bitrate recovery." };
  return { tone: "good", title: "Ready", detail: "No current photo-transfer bottleneck is reported." };
}

function photoPipeline(ftp, preprocess, framePipeline) {
  const stages = ["Camera", "Prepared", "Sent to FRAME", "FRAME processing", "Published"];
  const stateName = String(ftp?.state || "").toLowerCase();
  const result = ftp?.last_result || {};
  const resultAt = Date.parse(result.at || "");
  const publishedAt = Date.parse(framePipeline?.last_publish_at || "");
  const published = result.file
    && framePipeline?.last_publish_file === result.file
    && Number.isFinite(resultAt)
    && Number.isFinite(publishedAt)
    && publishedAt >= resultAt;
  let active = -1;
  if (published) active = 4;
  else if (result.status === "completed") active = 3;
  else if (["connecting", "preparing", "uploading", "assembling", "complete"].includes(stateName)) active = 2;
  else if (Number(ftp?.processed_count || 0) > 0) active = 1;
  else if (stateName === "processing" || String(preprocess?.state || "").toLowerCase() === "processing") active = 1;
  else if (Number(ftp?.queue_count || 0) > 0 || stateName === "queued") active = 0;
  return `<ol class="pipeline">${stages.map((stage, index) => {
    const className = active < 0 ? "pending" : index < active ? "done" : index === active ? "active" : "pending";
    return `<li class="${className}"><span></span>${escapeHtml(stage)}</li>`;
  }).join("")}</ol>`;
}

function transferResultNotice(ftp, framePipeline) {
  const result = ftp?.last_result;
  if (!result?.file || !result.at) return null;
  const resultAt = Date.parse(result.at);
  const publishedAt = Date.parse(framePipeline?.last_publish_at || "");
  const failedAt = Date.parse(framePipeline?.last_quarantine_at || "");
  let state = result.status;
  let at = resultAt;
  let title = result.status === "failed" ? "Transfer failed" : "Sent to FRAME";
  let detail = result.status === "failed" ? `${result.file}: ${result.error || "Retrying"}` : result.file;
  if (framePipeline?.last_quarantine_file === result.file && Number.isFinite(failedAt) && failedAt >= resultAt) {
    state = "failed";
    at = failedAt;
    title = "FRAME processing failed";
    detail = `${result.file}: ${framePipeline.last_error || "Moved to quarantine"}`;
  } else if (framePipeline?.last_publish_file === result.file && Number.isFinite(publishedAt) && publishedAt >= resultAt) {
    state = "published";
    at = publishedAt;
    title = "Published";
    detail = result.file;
  }
  return Number.isFinite(at) && Date.now() - at >= 0 && Date.now() - at <= 45000 ? { state, title, detail } : null;
}

function egressLaneCards(egress, ftp) {
  const lanes = Array.isArray(egress?.lanes) ? egress.lanes : [];
  if (!lanes.length) return `<p class="hint">Waiting for connection telemetry.</p>`;
  return `<div class="lane-grid">${lanes.map((lane, index) => {
    const stateName = lane.state === "healthy" ? "healthy" : lane.state === "unreachable" ? "offline" : "warn";
    const active = String(ftp?.active_egress || "").includes(lane.address) || String(ftp?.active_egress || "").includes(lane.name);
    const label = active ? "Upload" : stateName === "healthy" ? "Ready" : stateName === "offline" ? "Down" : "Check";
    const badgeTone = active ? "running" : stateName === "healthy" ? "ok" : "warn";
    return `<article class="lane-card ${stateName}${active ? " active" : ""}">
      <div><strong>${escapeHtml(friendlyLaneName(lane, index))}</strong><span class="result-badge ${badgeTone}">${label}</span></div>
      <dl class="advanced-only">${rows([
        ["Interface", lane.name || lane.interface_name || "Unknown"],
        ["Address", lane.address || "Unavailable"],
      ])}</dl>
    </article>`;
  }).join("")}</div>`;
}

function friendlyLaneName(lane, index) {
  const name = String(lane?.name || lane?.interface_name || "");
  if (name.startsWith("eth")) return "Ethernet";
  if (name.startsWith("wlan")) return `Wi-Fi ${index + 1}`;
  return name || `Lane ${index + 1}`;
}

function egressSummary(value) {
  if (!value?.lane_count) return "Waiting";
  return `${value.healthy_lane_count || 0}/${value.lane_count} healthy`;
}

function relayProbeMarkup(health) {
  const lanes = Array.isArray(health?.lanes) ? health.lanes : [];
  const updatedAt = Date.parse(health?.updated_at || "");
  const hasSample = Number.isFinite(updatedAt);
  const stale = !hasSample || Date.now() - updatedAt > 15000;
  const stateName = stale ? "stale" : health.state || "waiting";
  const healthy = stateName === "online" || stateName === "degraded";
  const label = stateName === "online" ? "Online" : stateName === "degraded" ? "Degraded" : stateName === "offline" ? "Offline" : stateName === "error" ? "Error" : stale ? "Stale" : "Waiting";
  const lowest = Number.isFinite(Number(health?.rtt_ms)) ? `${Math.round(Number(health.rtt_ms))} ms` : "Unavailable";
  const probeTarget = health?.probe_host ? `${health.probe_host}:${health.probe_port || 443}` : "Waiting for agent";
  const relayTarget = health?.host ? `${health.host}:${health.port || 5000}/UDP` : "Waiting for catalog";

  return `<div class="relay-probe-block" aria-label="Continuous FRAME control-path probe">
    <div class="status-card-heading">
      <div><p class="eyebrow">Continuous check</p><h4>FRAME Control Path</h4></div>
      <span class="pill ${healthy ? "online" : "warn"}">${label}</span>
    </div>
    <dl>${rows([
      ["Lowest response", lowest],
      ["Sample age", hasSample ? formatAge(health.updated_at) : "Waiting"],
    ])}</dl>
    <p class="hint">Lightweight TCP reachability used by the remote BelaUI badge. This is not UDP SRTLA RTT or an MTU test.</p>
    <div class="relay-probe-details advanced-only">
      <dl>${rows([
        ["Probe target", `${probeTarget}/TCP`],
        ["Relay destination", relayTarget],
        ["Reachable interfaces", `${Number(health?.reachable_lane_count || 0)}/${Number(health?.lane_count || lanes.length || 0)}`],
      ])}</dl>
      ${relayProbeLaneMarkup(lanes, stale)}
    </div>
  </div>`;
}

function relayProbeLaneMarkup(lanes, stale) {
  if (!lanes.length) return `<p class="hint">Waiting for per-interface relay checks.</p>`;
  return `<div class="diagnostic-results" aria-label="Relay probe interface results">${lanes.map((lane, index) => {
    const stateName = stale ? "running" : lane.reachable === true ? "complete" : lane.reachable === false ? "failed" : "running";
    const badgeLabel = stale ? "Stale" : lane.reachable === true ? "Online" : lane.reachable === false ? "Offline" : "Waiting";
    const badgeTone = stateName === "complete" ? "ok" : stateName === "failed" ? "warn" : "running";
    return `<article class="diagnostic-result ${stateName}">
      <div class="diagnostic-result-head"><div><strong>${escapeHtml(friendlyLaneName(lane, index))}</strong><span>${escapeHtml(lane.interface_name || "Unknown")} · ${escapeHtml(lane.address || "No address")}</span></div><span class="result-badge ${badgeTone}">${badgeLabel}</span></div>
      <dl>${rows([
        ["Response", diagnosticMetric(lane.rtt_ms, "ms")],
        ["Error", lane.error || "None"],
      ])}</dl>
    </article>`;
  }).join("")}</div>`;
}

function formatUploadCap(value) {
  const kbps = Number(value || 0);
  if (kbps <= 0) return "Uncapped";
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps % 1000 ? 1 : 0)} Mbps` : `${kbps} kbps`;
}

function formatMaxOutput(value) {
  const mib = Number(value || 0);
  return mib > 0 ? `${mib.toFixed(Number.isInteger(mib) ? 0 : 1)} MiB` : "No limit";
}

function formatPixelEdge(value) {
  return `${Math.round(Number(value || 0)).toLocaleString()} px`;
}

function processingSettings(ftp) {
  const processing = ftp?.image_processing || {};
  return {
    enabled: processing.enabled === true,
    long_edge_px: nonNegativeNumber(processing.long_edge_px, 0),
    jpeg_quality: nonNegativeNumber(processing.jpeg_quality, 92) || 92,
    max_output_mb: nonNegativeNumber(processing.max_output_mb, 0),
    processor: processing.processor || "",
  };
}

function nonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function diagnosticTargetLabel(diagnostics) {
  if (diagnostics?.target_name) return diagnostics.target_name;
  if (diagnostics?.target === "frame") return "FRAME endpoint";
  if (diagnostics?.target === "internet") return "External Internet";
  return "Not selected";
}

function diagnosticStateLabel(state) {
  return ({ preparing: "Preparing", running: "Running", complete: "Complete", partial: "Partially complete", failed: "Failed" })[state] || "Idle";
}

function diagnosticPhaseLabel(phase) {
  return ({
    route_check: "Checking route",
    latency: "Latency",
    download: "Download",
    upload: "Upload",
    complete: "Complete",
  })[phase] || "Waiting";
}

function diagnosticInterfaceOptions(interfaces, selected = "all") {
  const seen = new Set();
  const options = (Array.isArray(interfaces) ? interfaces : [])
    .filter((entry) => {
      if (entry?.family !== "IPv4" || !entry.name || !entry.address || String(entry.address).startsWith("169.254.") || seen.has(entry.name)) return false;
      seen.add(entry.name);
      return true;
    })
    .map((entry, index) => `<option value="${escapeAttr(entry.name)}" ${selected === entry.name ? "selected" : ""}>${escapeHtml(friendlyLaneName(entry, index))} · ${escapeHtml(entry.name)} · ${escapeHtml(entry.address)}</option>`)
    .join("");
  return `<option value="all" ${selected === "all" || !selected ? "selected" : ""}>All available interfaces (sequential)</option>${options}`;
}

function diagnosticResultsMarkup(diagnostics) {
  const results = Array.isArray(diagnostics?.results) ? diagnostics.results : [];
  if (!results.length) return `<p class="hint">No interface results yet.</p>`;
  return `<div class="diagnostic-results" aria-label="Interface speed test results">${results.map((result, index) => {
    const stateName = result.state === "complete" ? "complete" : result.state === "failed" ? "failed" : "running";
    const badgeLabel = stateName === "complete" ? "OK" : stateName === "failed" ? "Warn" : "Testing";
    const badgeTone = stateName === "complete" ? "ok" : stateName === "failed" ? "warn" : "running";
    return `<article class="diagnostic-result ${stateName}">
      <div class="diagnostic-result-head"><div><strong>${escapeHtml(friendlyLaneName(result, index))}</strong><span>${escapeHtml(result.interface_name || "Unknown")} · ${escapeHtml(result.address || "No address")}</span></div><span class="result-badge ${badgeTone}">${badgeLabel}</span></div>
      <dl>${rows([
        ["Latency", diagnosticMetric(result.latency_ms, "ms")],
        ["Download", diagnosticMetric(result.download_mbps, "Mbps")],
        ["Upload", diagnosticMetric(result.upload_mbps, "Mbps")],
        ["Status", result.state === "complete" ? "Complete" : result.state === "failed" ? "Failed" : diagnosticPhaseLabel(diagnostics.current_phase)],
      ])}</dl>
      ${result.error ? `<p>${escapeHtml(result.error)}</p>` : ""}
    </article>`;
  }).join("")}</div>`;
}

function diagnosticMetric(value, unit) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) ? `${Number(value)} ${unit}` : "Waiting";
}

function diagnosticSummary(diagnostics) {
  if (!diagnostics?.state) return "Run a per-interface Internet or FRAME endpoint test.";
  const total = Number(diagnostics.bytes_total || 0);
  const completed = Number(diagnostics.bytes_completed ?? diagnostics.bytes_sent ?? 0);
  const pct = total ? `${Math.round((completed / total) * 100)}%` : "0%";
  const lines = [
    `${diagnosticStateLabel(diagnostics.state)}: ${diagnosticTargetLabel(diagnostics)}`,
    `${pct} (${formatBytes(completed)} / ${formatBytes(total)})`,
    diagnostics.current_interface ? `${diagnostics.current_interface}: ${diagnosticPhaseLabel(diagnostics.current_phase)}` : `${diagnostics.parallel || 1} stream${Number(diagnostics.parallel || 1) === 1 ? "" : "s"}`,
  ];
  for (const result of Array.isArray(diagnostics.results) ? diagnostics.results : []) {
    if (result.state === "complete") lines.push(`${result.interface_name}: ${result.download_mbps} Mbps down / ${result.upload_mbps} Mbps up / ${result.latency_ms} ms`);
    if (result.state === "failed") lines.push(`${result.interface_name}: failed · ${result.error || "Unknown error"}`);
  }
  if (diagnostics.error) lines.push(`Error: ${diagnostics.error}`);
  return lines.join("\n");
}

function transferEta(ftp) {
  const total = Number(ftp?.size_bytes || 0);
  const sent = Number(ftp?.sent_bytes || 0);
  const rate = Number(ftp?.rate_bps || 0);
  if (!total || !sent || !rate || sent >= total) return "Unknown";
  const secondsLeft = Math.ceil((total - sent) / rate);
  return secondsLeft < 60 ? `${secondsLeft}s` : `${Math.ceil(secondsLeft / 60)}m`;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function deviceLogs(deviceId) {
  const logs = (state.logs?.logs || []).filter((line) => line.includes(`${deviceId}:`));
  return logs.length ? logs.join("\n") : "No logs collected yet.";
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rows(items) {
  return items.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value ?? "Unknown")}</dd>`).join("");
}

function formatDate(value) {
  if (!value) return "Never";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "Unknown" : time.toLocaleString();
}

function formatAge(value) {
  const secondsAgo = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 1000));
  return secondsAgo < 60 ? `${secondsAgo}s ago` : `${Math.round(secondsAgo / 60)}m ago`;
}

function seconds(value) {
  if (!Number.isFinite(Number(value))) return "Unknown";
  const total = Number(value);
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

function percent(value) {
  return Number.isFinite(Number(value)) ? `${value}%` : "Unknown";
}

function showNotice(message, tone = "ready") {
  state.noticeMessage = message || "Ready";
  state.noticeTone = tone;
  renderNotice();
}

function renderNotice() {
  const message = state.noticeMessage || "Ready";
  const tone = state.noticeTone || "ready";
  elements.headerStatus.textContent = message;
  elements.headerStatus.className = `status-pill ${tone}`;
  elements.notice.textContent = message;
  elements.notice.className = `notice ${tone === "error" ? "error" : ""}`;
  elements.notice.hidden = !message || message === "Ready" || message === "Loading";
}

function readLastDeviceId() {
  try {
    return localStorage.getItem(LAST_DEVICE_KEY) || "";
  } catch {
    return "";
  }
}

function readWorkspaceTab() {
  try {
    const stored = localStorage.getItem(LAST_WORKSPACE_TAB_KEY) || "";
    return WORKSPACE_TABS.includes(stored) ? stored : "overview";
  } catch {
    return "overview";
  }
}

function readAdvancedView() {
  try {
    return localStorage.getItem(ADVANCED_VIEW_KEY) === "true";
  } catch {
    return false;
  }
}

function writeLastDeviceId(deviceId) {
  if (!deviceId || deviceId === ADD_DEVICE_ID) return;
  try {
    localStorage.setItem(LAST_DEVICE_KEY, deviceId);
  } catch {}
}

function initializeTheme() {
  setThemeMode(readStoredTheme(), false);
}

function toggleTheme() {
  setThemeMode(document.documentElement.dataset.theme === "day" ? "night" : "day", true);
}

function setThemeMode(nextMode, persist) {
  const mode = nextMode === "day" ? "day" : "night";
  document.documentElement.dataset.theme = mode;
  document.documentElement.dataset.themeMode = mode;
  document.body.classList.toggle("theme-day", mode === "day");
  window.FrameTheme?.apply(mode);
  const nextLabel = mode === "day" ? "Switch to night mode" : "Switch to day mode";
  elements.themeToggle.setAttribute("aria-label", nextLabel);
  elements.themeToggle.title = nextLabel;
  elements.themeToggle.setAttribute("aria-pressed", String(mode === "day"));
  if (persist) {
    try { localStorage.setItem(THEME_MODE_KEY, mode); } catch {}
    window.FrameTheme?.saveMode?.(mode);
  }
}

function readStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_MODE_KEY)
      || localStorage.getItem(LEGACY_PORTAL_THEME_KEY)
      || COMPAT_THEME_KEYS.map((key) => localStorage.getItem(key)).find(Boolean);
    if (stored === "day" || stored === "night") return stored;
  } catch {}
  return "night";
}

function handleThemeStorageChange(event) {
  if (!THEME_STORAGE_KEYS.has(event.key)) return;
  setThemeMode(readStoredTheme(), false);
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
