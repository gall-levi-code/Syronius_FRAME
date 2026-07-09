const ADD_DEVICE_ID = "__add__";
const THEME_MODE_KEY = "frame-theme";
const LEGACY_PORTAL_THEME_KEY = "frame-portal-theme";
const THEME_PROFILE_ID_KEY = "frame-theme-profile-id";
const THEME_PROFILE_KEY = "frame-theme-profile";
const THEME_CUSTOM_PROFILES_KEY = "frame-theme-custom-profiles";
const COMPAT_THEME_KEYS = ["frame-gallery-theme-mode", "frame-audio-bridge-color-mode"];
const REFRESH_INTERVAL_MS = 2000;
const COMMAND_POLL_INTERVAL_MS = 500;
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
  mqttState: document.getElementById("mqtt-state"),
  deviceCount: document.getElementById("device-count"),
  heartbeatState: document.getElementById("heartbeat-state"),
  commandState: document.getElementById("command-state"),
  deviceTabs: document.getElementById("device-tabs"),
  devicePanel: document.getElementById("device-panel"),
  notice: document.getElementById("notice"),
  headerStatus: document.getElementById("header-status"),
  themeToggle: document.getElementById("theme-toggle"),
};

const state = {
  selectedDeviceId: ADD_DEVICE_ID,
  status: null,
  telemetry: null,
  logs: null,
  formDraft: {},
  detailsOpen: {},
  ftpOutputs: {},
  panelLocked: false,
  noticeMessage: "Loading",
  noticeTone: "busy",
};

initialize();

function initialize() {
  initializeTheme();
  elements.themeToggle.addEventListener("click", toggleTheme);
  window.addEventListener("storage", handleThemeStorageChange);
  elements.deviceTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-device-tab]");
    if (!tab) return;
    event.preventDefault();
    state.selectedDeviceId = tab.dataset.deviceTab;
    render();
  });
  elements.devicePanel.addEventListener("input", rememberFormInput);
  elements.devicePanel.addEventListener("change", rememberFormInput);
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
    state.selectedDeviceId = devices[0].device_id;
  }
}

function render() {
  if (!state.status) return;
  const devices = pairedDevices();
  const onlineDevices = liveDevices().filter((device) => device.online);
  const latestHeartbeat = latest(liveDevices().map((device) => device.last_heartbeat_at).filter(Boolean));

  elements.mqttState.textContent = state.status.mqtt?.connected ? "Connected" : state.status.mqtt?.enabled ? "Reconnecting" : "Not configured";
  elements.deviceCount.textContent = `${onlineDevices.length}/${devices.length}`;
  elements.heartbeatState.textContent = latestHeartbeat ? formatAge(latestHeartbeat) : "Waiting";
  elements.commandState.textContent = state.status.mqtt?.connected ? "Signed" : "Offline";
  elements.deviceTabs.innerHTML = renderDeviceTabs(devices);
  const panelKey = state.selectedDeviceId;
  const shouldRenderPanel = elements.devicePanel.dataset.panelKey !== panelKey || (!state.panelLocked && !panelHasEditableFocus());
  if (shouldRenderPanel) {
    rememberCurrentDetailsState();
    elements.devicePanel.dataset.panelKey = panelKey;
    elements.devicePanel.innerHTML = panelKey === ADD_DEVICE_ID
      ? renderAddDeviceWizard(devices.length === 0)
      : renderDevicePanel(panelKey);
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
    return `<a href="#" role="tab" aria-selected="${active}" class="device-tab ${active ? "active" : ""}" data-device-tab="${escapeAttr(device.device_id)}">
      <span class="status-dot ${live?.online ? "online" : ""}" aria-hidden="true"></span>
      <span>${escapeHtml(device.device_id)}</span>
    </a>`;
  }).join("");
  const addActive = state.selectedDeviceId === ADD_DEVICE_ID;
  return `${deviceTabs}<a href="#" role="tab" aria-selected="${addActive}" class="device-tab add ${addActive ? "active" : ""}" data-device-tab="${ADD_DEVICE_ID}">Add Device</a>`;
}

function renderAddDeviceWizard(isEmpty) {
  return `<div class="panel-head">
      <div>
        <p class="eyebrow">${isEmpty ? "First Belabox" : "New Belabox"}</p>
        <h2>Add Device</h2>
      </div>
      <span class="pill warn">SSH required</span>
    </div>
    <form id="device-wizard" class="wizard">
      <section class="wizard-step">
        <h3>SSH</h3>
        <div class="form-grid">
          <label>Belabox host/IP<input id="pair-host" name="host" required autocomplete="off"></label>
          <label>SSH port<input id="pair-port" name="port" type="number" min="1" max="65535" value="22"></label>
          <label>SSH username<input id="pair-user" name="user" required autocomplete="username"></label>
          <label>Device ID<input id="pair-device-id" name="device_id" placeholder="Optional"></label>
          <label>Password<input id="pair-password" name="password" type="password" autocomplete="current-password"></label>
          <label class="wide">Private key<textarea id="pair-key" name="private_key" rows="4" spellcheck="false"></textarea></label>
        </div>
        <p class="hint">Password or private key is required for first install and repair.</p>
      </section>

      <section class="wizard-step">
        <h3>FTP Connector</h3>
        <label class="check-row"><input id="setup-ftp-enabled" name="setup_ftp" type="checkbox">Install Photo Agent</label>
        <div class="form-grid">
          <label>FRAME FTP external host/IP<input id="ftp-target-host" name="target_host" value="${escapeAttr(ftpDefaultHost())}"></label>
          <label>FRAME FTP port<input id="ftp-target-port" name="target_port" type="number" min="1" max="65535" value="${escapeAttr(state.status.ftp_connector?.target_port || 2121)}"></label>
          <label>Camera FTP username<input id="camera-ftp-user" name="camera_username" value="${escapeAttr(state.status.ftp_connector?.camera_username || "framecam")}"></label>
          <label>Camera FTP password<input id="camera-ftp-password" name="camera_password" type="password" autocomplete="new-password" placeholder="Generate if blank"></label>
        </div>
      </section>

      <section class="wizard-step">
        <h3>Photo Transfer</h3>
        <label class="check-row"><input id="setup-chunk-enabled" name="setup_chunk" type="checkbox">Enable stream-safe photo transfer after pairing</label>
        <div class="form-grid">
          <label>Chunk size bytes<input id="photo-chunk-size" name="chunk_size_bytes" type="number" min="262144" max="67108864" step="262144" value="${escapeAttr(state.status.chunk_upload?.chunk_size_bytes || 4194304)}"></label>
          <label>Parallel uploads<input id="photo-chunk-parallel" name="chunk_parallel_uploads" type="number" min="1" max="4" step="1" value="${escapeAttr(state.status.chunk_upload?.chunk_parallel_uploads || 1)}"></label>
          <label>Upload cap kbps<input id="photo-chunk-kbps" name="chunk_upload_kbps" type="number" min="0" max="1000000" step="64" value="${escapeAttr(state.status.chunk_upload?.chunk_upload_kbps || 0)}"></label>
        </div>
        <p class="hint">Use a capped upload preset while live. Set upload cap to 0 only when you want maximum speed.</p>
      </section>

      <section class="wizard-step">
        <h3>Diagnostics</h3>
        <label class="check-row"><input id="install-diagnostics" name="install_diagnostics" type="checkbox">Install optional network diagnostics tools</label>
        <label class="check-row"><input id="enable-ssh-on-boot" name="enable_ssh_on_boot" type="checkbox">Enable SSH on boot</label>
      </section>

      <section class="wizard-step">
        <h3>Maintenance Login</h3>
        <label class="check-row"><input id="remember-ssh" name="remember_ssh" type="checkbox" ${sshCredentialSaveEnabled() ? "" : "disabled"}>Save encrypted SSH credential for future repairs</label>
        <p class="hint">${sshCredentialSaveEnabled() ? "Saved SSH is used only for installer and repair jobs." : "Set BELABOX_SSH_CREDENTIAL_KEY to enable encrypted SSH credential save."}</p>
      </section>

      <div class="actions">
        <button id="pair-device" type="submit">Pair Device</button>
      </div>
      <pre id="pair-output">Ready.</pre>
    </form>`;
}

function renderDevicePanel(deviceId) {
  const provisioned = pairedDevices().find((device) => device.device_id === deviceId);
  const live = liveDevice(deviceId);
  const telemetry = live?.telemetry || {};
  const ftp = telemetry.ftp_upload || {};
  const diagnostics = telemetry.network_diagnostics || {};
  const egress = telemetry.egress || {};
  const remoteBelaui = telemetry.remote_belaui || state.status.remote_belaui || {};
  const cameraFtp = ftp.camera_ftp || {};
  const connector = ftpConnector(deviceId);
  const savedSsh = savedSshCredential(deviceId);
  const processing = processingSettings(ftp);
  const preprocess = ftp.preprocess || {};
  const chunkSize = Number(ftp.chunk_size_bytes ?? state.status.chunk_upload?.chunk_size_bytes ?? 4194304);
  const chunkParallel = Number(ftp.chunk_parallel_uploads ?? state.status.chunk_upload?.chunk_parallel_uploads ?? 1);
  const chunkUploadKbps = Number(ftp.chunk_upload_kbps ?? state.status.chunk_upload?.chunk_upload_kbps ?? 0);
  const remoteUrl = remoteAccessUrl(deviceId);
  const slowdown = slowdownSummary(live, connector, ftp, preprocess, egress, chunkUploadKbps);
  const setupButtonLabel = connector ? "Repair Agent" : "Install Photo Agent";
  return `<div class="panel-head">
      <div>
        <p class="eyebrow">Belabox</p>
        <h2>${escapeHtml(deviceId)}</h2>
      </div>
      <div class="panel-actions">
        <span class="pill ${live?.online ? "online" : ""}">${live?.online ? "Online" : "Offline"}</span>
        <a class="primary-action" href="${escapeAttr(remoteUrl)}" target="_blank" rel="noreferrer">Open Encoder Remote</a>
        <button class="secondary" type="button" data-copy-text="${escapeAttr(remoteUrl)}">Copy URL</button>
      </div>
    </div>

    <div class="remote-row">
      <span>Remote access</span>
      <code>${escapeHtml(remoteUrl)}</code>
    </div>

    <section class="encoder-strip" aria-label="Encoder status">
      ${statusTile("Encoder", live?.online ? "Online" : "Offline", live?.online ? "good" : "warn")}
      ${statusTile("Remote", remoteBelauiStatus(remoteBelaui), remoteBelaui.state === "reachable" ? "good" : "warn")}
      ${statusTile("Photo Agent", friendlyTransferState(ftp, connector), connector ? "good" : "warn")}
      ${statusTile("Stream Safety", streamSafetyLabel(ftp, chunkUploadKbps), chunkUploadKbps > 0 ? "good" : "warn")}
    </section>

    <section class="insight-card ${slowdown.tone}">
      <div>
        <p class="eyebrow">What is slowing things down?</p>
        <h3>${escapeHtml(slowdown.title)}</h3>
      </div>
      <p>${escapeHtml(slowdown.detail)}</p>
    </section>

    <section class="status-card pipeline-card">
      <div class="section-head">
        <h3>Photo Pipeline</h3>
        <span>${escapeHtml(friendlyTransferState(ftp, connector))}</span>
      </div>
      ${photoPipeline(ftp, preprocess)}
    </section>

    <section class="detail-grid">
      <div class="status-card">
        <h3>Live Upload</h3>
        <dl>${rows([
          ["Current file", ftp.file || "None"],
          ["Progress", ftp.file ? `${Math.round(Number(ftp.percent || 0))}%` : "Idle"],
          ["Rate", formatBytes(Number(ftp.rate_bps || 0)) + "/s"],
          ["Queue", `${Number(ftp.queue_count || 0)} total, ${Number(ftp.processed_count || 0)} upload-ready`],
          ["ETA", transferEta(ftp)],
        ])}</dl>
      </div>
      <div class="status-card">
        <h3>Connections</h3>
        ${egressLaneChips(egress, ftp)}
        <dl>${rows([
          ["Active lane", ftp.active_egress || "Idle"],
          ["Healthy lanes", `${ftp.egress_lane_count || egress.healthy_lane_count || 0}`],
          ["Last heartbeat", live?.last_heartbeat_at ? formatAge(live.last_heartbeat_at) : "Waiting"],
        ])}</dl>
      </div>
    </section>

    <details class="settings-section" data-section="photo-transfer" open>
      <summary>Photo Transfer</summary>
      <div class="preset-row" aria-label="Transfer presets">
        ${transferPresetButtons(chunkSize, chunkParallel, chunkUploadKbps, live?.online)}
      </div>
      <p class="hint">Protect Stream is the safest starting point while live. Fast is uncapped and can affect bitrate recovery on weak uplinks.</p>

      <dl>${rows([
        ["Mode", friendlyTransferMode(ftp)],
        ["Upload cap", formatUploadCap(chunkUploadKbps)],
        ["Preprocessor", preprocess.status_text || preprocess.state || "Idle"],
        ["Upload-ready", `${Number(ftp.processed_count || 0)}/${Number(preprocess.ahead || 0) || "?"}`],
        ["Resize/compress", processing.enabled ? "Enabled" : "Disabled"],
      ])}</dl>

      <form id="processing-form" class="form-grid">
        <label class="check-row wide"><input id="photo-processing-enabled" name="enabled" type="checkbox" ${processing.enabled ? "checked" : ""}>Resize/compress before transfer</label>
        <label>Long edge px<input id="photo-long-edge" name="long_edge_px" type="number" min="0" max="12000" step="1" value="${escapeAttr(processing.long_edge_px)}"></label>
        <label>JPEG quality<input id="photo-jpeg-quality" name="jpeg_quality" type="number" min="40" max="100" step="1" value="${escapeAttr(processing.jpeg_quality)}"></label>
        <label>Max output MiB<input id="photo-max-output" name="max_output_mb" type="number" min="0" max="500" step="0.1" value="${escapeAttr(processing.max_output_mb)}"></label>
        <div class="actions wide"><button id="apply-photo-processing" type="submit" ${live?.online ? "" : "disabled"}>Apply Processing</button></div>
      </form>

      <details class="nested-details">
        <summary>Advanced transfer settings</summary>
        <dl>${rows([
          ["Endpoint", state.status.chunk_upload?.public_url_configured ? "Configured" : "Missing"],
          ["Photo stage", state.status.chunk_upload?.photo_upload_configured ? "Configured" : "Missing token"],
          ["Chunk size", `${chunkSize} bytes`],
          ["Parallel chunks", chunkParallel],
          ["Egress binding", ftp.egress_binding || "Waiting"],
        ])}</dl>
        <form id="chunk-form" class="form-grid">
          <label>Chunk size bytes<input id="photo-chunk-size" name="chunk_size_bytes" type="number" min="262144" max="67108864" step="262144" value="${escapeAttr(chunkSize)}"></label>
          <label>Parallel uploads<input id="photo-chunk-parallel" name="chunk_parallel_uploads" type="number" min="1" max="4" step="1" value="${escapeAttr(chunkParallel)}"></label>
          <label>Upload cap kbps<input id="photo-chunk-kbps" name="chunk_upload_kbps" type="number" min="0" max="1000000" step="64" value="${escapeAttr(chunkUploadKbps)}"></label>
          <div class="actions wide">
            <button id="enable-chunk-relay" type="button" ${live?.online ? "" : "disabled"}>Enable Chunk Relay</button>
            <button id="use-direct-ftp" type="button" ${live?.online ? "" : "disabled"}>Use Direct FTP</button>
            <button id="refresh-photo-module" type="button" ${live?.online ? "" : "disabled"}>Refresh Status</button>
          </div>
        </form>
      </details>

      <details class="nested-details">
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
    </details>

    <details class="settings-section" data-section="network-diagnostics">
      <summary>Diagnostics</summary>
      <dl>${rows([
        ["State", diagnostics.state || "Idle"],
        ["Progress", diagnostics.bytes_total ? `${Math.round((Number(diagnostics.bytes_sent || 0) / Number(diagnostics.bytes_total)) * 100)}%` : "None"],
        ["Speed", diagnostics.mbps ? `${diagnostics.mbps} Mbps` : "Unknown"],
        ["Streams", diagnostics.parallel || state.status.diagnostics?.parallel_streams || 1],
      ])}</dl>
      <form id="speed-test-form" class="form-grid">
        <label>Upload test size MiB<input id="speed-test-mib" name="mib" type="number" min="1" max="${Math.max(1, Math.floor((state.status.diagnostics?.max_upload_bytes || 67108864) / 1024 / 1024))}" step="1" value="${Math.max(1, Math.round((state.status.diagnostics?.upload_bytes || 8388608) / 1024 / 1024))}"></label>
        <label>Parallel streams<input id="speed-test-parallel" name="parallel" type="number" min="1" max="8" step="1" value="${escapeAttr(state.status.diagnostics?.parallel_streams || 1)}"></label>
        <div class="actions wide"><button id="run-speed-test" type="submit" ${live?.online ? "" : "disabled"}>Run Upload Speed Test</button></div>
      </form>
      <pre id="speed-test-output">${diagnosticSummary(diagnostics)}</pre>
    </details>

    <details class="settings-section" data-section="ssh-maintenance">
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
        <label class="wide">Private key<textarea id="pair-key" name="private_key" rows="4" spellcheck="false"></textarea></label>
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

    <details class="settings-section" data-section="telemetry">
      <summary>Telemetry</summary>
      <dl>${rows([
        ["Hostname", telemetry.hostname || "Unknown"],
        ["Uptime", seconds(telemetry.uptime_seconds)],
        ["CPU load", Array.isArray(telemetry.cpu_load) ? telemetry.cpu_load.map((value) => Number(value).toFixed(2)).join(" / ") : "Unknown"],
        ["Memory", percent(telemetry.memory?.used_percent)],
        ["Disk", percent(telemetry.disk?.used_percent)],
        ["Temperature", telemetry.temperature_c == null ? "Unavailable" : `${telemetry.temperature_c} C`],
      ])}</dl>
    </details>

    <details class="settings-section" data-section="logs">
      <summary>Logs</summary>
      <pre id="logs">${deviceLogs(deviceId)}</pre>
    </details>

    <details class="settings-section danger-zone" data-section="advanced">
      <summary>Advanced</summary>
      <div class="actions">
        <button class="danger" type="button" data-uninstall-agent="${escapeAttr(deviceId)}">Uninstall Agent</button>
        <button class="danger" type="button" data-remove-device="${escapeAttr(deviceId)}">Remove Device From FRAME</button>
      </div>
    </details>`;
}

async function handlePanelClick(event) {
  const copy = event.target.closest("[data-copy-text]");
  if (copy) return copyToClipboard(copy);
  const preset = event.target.closest("[data-transfer-preset]");
  if (preset) return applyTransferPreset(preset.dataset.transferPreset, preset);
  const uninstall = event.target.closest("[data-uninstall-agent]");
  if (uninstall) return uninstallAgent(uninstall);
  const remove = event.target.closest("[data-remove-device]");
  if (remove) return removeProvisionedDevice(remove);
  const forgetSsh = event.target.closest("#forget-ssh");
  if (forgetSsh) return forgetSavedSsh(forgetSsh);
  const showFtpPassword = event.target.closest("#show-ftp-password");
  if (showFtpPassword) return showFtpCredentials(showFtpPassword);
  const chunk = event.target.closest("#enable-chunk-relay");
  if (chunk) return applyPhotoTransport("chunked_https", undefined, undefined, false, chunk);
  const direct = event.target.closest("#use-direct-ftp");
  if (direct) return applyPhotoTransport("direct_ftp", undefined, undefined, false, direct);
  const refresh = event.target.closest("#refresh-photo-module");
  if (refresh) return sendPhotoCommand("photo_module_status", {}, undefined, refresh).catch((error) => showNotice(`Photo status refresh failed: ${error.message}`, "error"));
}

function handlePanelSubmit(event) {
  if (event.target.matches("#device-wizard")) return runWizardSubmit(event);
  if (event.target.matches("#repair-form")) return runRepairSubmit(event);
  if (event.target.matches("#ftp-form")) return runFtpSubmit(event);
  if (event.target.matches("#processing-form")) return runProcessingSubmit(event);
  if (event.target.matches("#speed-test-form")) return runSpeedTestSubmit(event);
}

async function runWizardSubmit(event) {
  const form = event.target.closest("#device-wizard");
  if (!form) return;
  event.preventDefault();
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
  await applyPhotoProcessing(form);
}

async function pairDevice(form, includeModules) {
  const button = form.querySelector("#pair-device");
  const output = form.querySelector("#pair-output");
  const resetButton = setButtonBusy(button, includeModules ? "Pairing..." : "Repairing...");
  state.panelLocked = true;
  output.textContent = "Queued...";
  showNotice("Pairing Belabox...", "busy");
  try {
    const payload = pairPayload(form);
    const job = await fetchJson("/belabox/api/pair/jobs", postJson(payload));
    const result = await pollPairJob(job.job_id, output);
    output.textContent = `${result.device_id}: ${result.agent_status}; ${result.mqtt_status}`;
    state.selectedDeviceId = result.device_id;
    if (includeModules && form.querySelector("#setup-ftp-enabled")?.checked) {
      await setupFtpConnector(form, result.device_id, output);
    }
    if (includeModules && form.querySelector("#setup-chunk-enabled")?.checked) {
      await applyPhotoTransport("chunked_https", result.device_id, form, true);
    }
    clearSecrets(form);
    showNotice(result.mqtt_status === "heartbeat_seen" ? "Belabox paired and online." : "Belabox paired. Waiting for heartbeat.", "success");
    await refresh();
  } catch (error) {
    showNotice(`Pairing failed: ${error.message}`, "error");
  } finally {
    state.panelLocked = false;
    resetButton();
  }
}

async function setupFtpConnector(form, deviceId = state.selectedDeviceId, output = form.querySelector("#ftp-output") || elements.devicePanel.querySelector("#ftp-output")) {
  const button = form.querySelector("#setup-ftp-connector");
  const sshScope = form.querySelector("#pair-host") ? form : elements.devicePanel;
  const sshPayload = pairPayload(sshScope, deviceId);
  const resetButton = setButtonBusy(button, "Installing...");
  state.panelLocked = true;
  if (output) output.textContent = "Queued...";
  showNotice("Installing Photo Agent...", "busy");
  try {
    const payload = {
      ...sshPayload,
      target_host: form.querySelector("#ftp-target-host")?.value.trim() || "",
      target_port: form.querySelector("#ftp-target-port")?.value || 2121,
      camera_username: form.querySelector("#camera-ftp-user")?.value.trim() || "",
      camera_password: form.querySelector("#camera-ftp-password")?.value || "",
    };
    const job = await fetchJson("/belabox/api/ftp-connector/jobs", postJson(payload));
    const result = await pollFtpConnectorJob(job.job_id, output);
    const lines = ftpCredentialLines(result);
    state.ftpOutputs[deviceId] = lines;
    if (output) output.textContent = lines;
    clearSecrets(form);
    showNotice("Photo Agent installed and tested. Waiting for telemetry.", "success");
    await refresh();
  } catch (error) {
    if (/SSH credentials|SSH Maintenance|Saved SSH/i.test(error.message)) openSshMaintenance(error.message);
    if (output) output.textContent = `Photo Agent setup failed: ${error.message}`;
    showNotice(`Photo Agent setup failed: ${error.message}`, "error");
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
  const chunkSize = Number(root.querySelector("#photo-chunk-size")?.value || 0);
  const parallel = Number(root.querySelector("#photo-chunk-parallel")?.value || 1);
  const uploadKbps = Number(root.querySelector("#photo-chunk-kbps")?.value || 0);
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
  } catch (error) {
    showNotice(`${mode === "chunked_https" ? "Chunk Relay" : "Direct FTP"} update failed: ${error.message}`, "error");
  } finally {
    resetButton();
  }
}

async function applyPhotoProcessing(form, deviceId = state.selectedDeviceId) {
  const payload = {
    enabled: form.querySelector("#photo-processing-enabled")?.checked === true,
    long_edge_px: Number(form.querySelector("#photo-long-edge")?.value || 0),
    jpeg_quality: Number(form.querySelector("#photo-jpeg-quality")?.value || 92),
    max_output_mb: Number(form.querySelector("#photo-max-output")?.value || 0),
  };
  try {
    await sendPhotoCommand("photo_processing_config_set", payload, deviceId, form.querySelector("#apply-photo-processing"));
    showNotice("Pre-transfer processing update requested.", "success");
  } catch (error) {
    showNotice(`Processing update failed: ${error.message}`, "error");
  }
}

async function sendPhotoCommand(command, args, deviceId = state.selectedDeviceId, button = null) {
  if (!deviceId || deviceId === ADD_DEVICE_ID) throw new Error("Select a paired Belabox device first.");
  const resetButton = setButtonBusy(button, "Applying...");
  showNotice(`Sending ${command}...`, "busy");
  try {
    const queued = await fetchJson("/belabox/api/cmd/request", postJson({ device_id: deviceId, command, args }));
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
  const resetButton = setButtonBusy(button, "Running...");
  state.panelLocked = true;
  output.textContent = "Queued network speed test...";
  showNotice("Running Belabox upload speed test...", "busy");
  try {
    const queued = await fetchJson("/belabox/api/diagnostics/speed-test", postJson({
      device_id: state.selectedDeviceId,
      bytes: Math.round(mib * 1024 * 1024),
      parallel,
    }));
    const result = await pollCommandResult(queued.command.command_id, output);
    output.textContent = result.error_message || result.result_summary || "Speed test finished.";
    showNotice("Belabox upload speed test finished.", "success");
    await refresh();
  } catch (error) {
    output.textContent = `Speed test failed: ${error.message}`;
    showNotice(`Speed test failed: ${error.message}`, "error");
  } finally {
    state.panelLocked = false;
    resetButton();
  }
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

async function pollCommandResult(commandId, output, intervalMs = 1000) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
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
  showNotice(job.step || "");
}

async function removeProvisionedDevice(button) {
  const deviceId = button.dataset.removeDevice;
  if (!confirm(`Remove ${deviceId} from FRAME?`)) return;
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
  if (!confirm(`Uninstall the FRAME agent from ${deviceId}? Local photo spool and logs will be archived on the Belabox.`)) return;
  const resetButton = setButtonBusy(button, "Uninstalling...");
  try {
    const sshPayload = pairPayload(elements.devicePanel, deviceId);
    const result = await fetchJson("/belabox/api/agent/remove", postJson({ ...sshPayload, purge: false }));
    showNotice(`${deviceId} agent uninstalled. ${result.summary || ""}`, "success");
    await refresh();
  } catch (error) {
    showNotice(`Agent uninstall failed: ${error.message}`, "error");
  } finally {
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
  if (!confirm(`Forget saved SSH credential for ${deviceId}?`)) return;
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
    host: form.querySelector("#pair-host")?.value.trim() || "",
    port: form.querySelector("#pair-port")?.value || 22,
    user: form.querySelector("#pair-user")?.value.trim() || "",
    password: form.querySelector("#pair-password")?.value || "",
    private_key: form.querySelector("#pair-key")?.value || "",
    device_id: deviceId || form.querySelector("#pair-device-id")?.value.trim() || "",
    install_diagnostics: form.querySelector("#install-diagnostics")?.checked === true,
    enable_ssh_on_boot: form.querySelector("#enable-ssh-on-boot")?.checked === true,
    remember_ssh: form.querySelector("#remember-ssh")?.checked === true,
  };
}

function clearSecrets(scope) {
  scope.querySelectorAll('input[type="password"], textarea').forEach((input) => {
    input.value = "";
    delete state.formDraft[draftKey(input)];
  });
}

function rememberFormInput(event) {
  const input = event.target;
  if (!input.matches?.("input, textarea, select")) return;
  state.formDraft[draftKey(input)] = input.type === "checkbox" ? input.checked : input.value;
}

function restoreFormDraft() {
  elements.devicePanel.querySelectorAll("input, textarea, select").forEach((input) => {
    const key = draftKey(input);
    if (!(key in state.formDraft)) return;
    if (input.type === "checkbox") input.checked = Boolean(state.formDraft[key]);
    else input.value = state.formDraft[key];
  });
}

function rememberDetailsState(event) {
  const details = event.target;
  if (!details.matches?.("details[data-section]")) return;
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
  const section = elements.devicePanel.querySelector("#repair-form")?.closest("details");
  if (section) section.open = true;
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
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) url.protocol = "https:";
    return url.origin;
  } catch {
    return window.location.origin;
  }
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
  if (ftp?.done || stateName === "complete" || stateName === "published") return "Published";
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

function photoPipeline(ftp, preprocess) {
  const stages = ["Received", "Processing", "Upload-ready", "Sending", "Published"];
  const stateName = String(ftp?.state || "").toLowerCase();
  let active = -1;
  if (ftp?.done || stateName === "complete" || stateName === "published") active = 4;
  else if (["connecting", "preparing", "uploading", "assembling"].includes(stateName)) active = 3;
  else if (Number(ftp?.processed_count || 0) > 0) active = 2;
  else if (stateName === "processing" || String(preprocess?.state || "").toLowerCase() === "processing") active = 1;
  else if (Number(ftp?.queue_count || 0) > 0 || stateName === "queued") active = 0;
  return `<ol class="pipeline">${stages.map((stage, index) => {
    const className = active < 0 ? "pending" : index < active ? "done" : index === active ? "active" : "pending";
    return `<li class="${className}"><span></span>${escapeHtml(stage)}</li>`;
  }).join("")}</ol>`;
}

function egressLaneChips(egress, ftp) {
  const lanes = Array.isArray(egress?.lanes) ? egress.lanes : [];
  if (!lanes.length) return `<p class="hint">Waiting for connection telemetry.</p>`;
  return `<div class="lane-chips">${lanes.map((lane, index) => {
    const stateName = lane.state === "healthy" ? "healthy" : lane.state === "unreachable" ? "offline" : "warn";
    const active = String(ftp?.active_egress || "").includes(lane.address) || String(ftp?.active_egress || "").includes(lane.name);
    return `<span class="lane-chip ${stateName}${active ? " active" : ""}">${escapeHtml(friendlyLaneName(lane, index))}</span>`;
  }).join("")}</div>`;
}

function friendlyLaneName(lane, index) {
  const name = String(lane?.name || "");
  if (name.startsWith("eth")) return "Ethernet";
  if (name.startsWith("wlan")) return `Wi-Fi ${index + 1}`;
  return name || `Lane ${index + 1}`;
}

function egressSummary(value) {
  if (!value?.lane_count) return "Waiting";
  return `${value.healthy_lane_count || 0}/${value.lane_count} healthy`;
}

function formatUploadCap(value) {
  const kbps = Number(value || 0);
  if (kbps <= 0) return "Uncapped";
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps % 1000 ? 1 : 0)} Mbps` : `${kbps} kbps`;
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

function diagnosticSummary(diagnostics) {
  if (!diagnostics?.state) return "Run a short upload test to measure Belabox-to-FRAME throughput.";
  const total = Number(diagnostics.bytes_total || 0);
  const sent = Number(diagnostics.bytes_sent || 0);
  const pct = total ? `${Math.round((sent / total) * 100)}%` : "0%";
  const speed = diagnostics.mbps ? `${diagnostics.mbps} Mbps` : "calculating";
  const error = diagnostics.error ? `\nError: ${diagnostics.error}` : "";
  return `${diagnostics.state}: ${pct} (${formatBytes(sent)} / ${formatBytes(total)})\nSpeed: ${speed}\nStreams: ${diagnostics.parallel || 1}${error}`;
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

function latest(values) {
  return values.sort((left, right) => Date.parse(right) - Date.parse(left))[0] || null;
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
