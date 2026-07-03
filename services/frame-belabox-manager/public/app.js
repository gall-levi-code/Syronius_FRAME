const ADD_DEVICE_ID = "__add__";
const THEME_MODE_KEY = "frame-theme";
const LEGACY_PORTAL_THEME_KEY = "frame-portal-theme";
const THEME_PROFILE_ID_KEY = "frame-theme-profile-id";
const THEME_PROFILE_KEY = "frame-theme-profile";
const THEME_CUSTOM_PROFILES_KEY = "frame-theme-custom-profiles";
const COMPAT_THEME_KEYS = ["frame-gallery-theme-mode", "frame-audio-bridge-color-mode"];
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
  setInterval(refresh, 5000);
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
        <label class="check-row"><input id="setup-ftp-enabled" name="setup_ftp" type="checkbox">Install standard FTP connector</label>
        <div class="form-grid">
          <label>FRAME FTP external host/IP<input id="ftp-target-host" name="target_host" value="${escapeAttr(ftpDefaultHost())}"></label>
          <label>FRAME FTP port<input id="ftp-target-port" name="target_port" type="number" min="1" max="65535" value="${escapeAttr(state.status.ftp_connector?.target_port || 2121)}"></label>
          <label>Camera FTP username<input id="camera-ftp-user" name="camera_username" value="${escapeAttr(state.status.ftp_connector?.camera_username || "framecam")}"></label>
          <label>Camera FTP password<input id="camera-ftp-password" name="camera_password" type="password" autocomplete="new-password" placeholder="Generate if blank"></label>
        </div>
      </section>

      <section class="wizard-step">
        <h3>Chunk Relay</h3>
        <label class="check-row"><input id="setup-chunk-enabled" name="setup_chunk" type="checkbox">Enable Chunk Relay mode after pairing</label>
        <div class="form-grid">
          <label>Chunk size bytes<input id="photo-chunk-size" name="chunk_size_bytes" type="number" min="262144" max="67108864" step="262144" value="${escapeAttr(state.status.chunk_upload?.chunk_size_bytes || 4194304)}"></label>
        </div>
        <p class="hint">Chunk Relay is separate from FTP and uses signed MQTT commands after the agent connects.</p>
      </section>

      <section class="wizard-step">
        <h3>Diagnostics</h3>
        <label class="check-row"><input id="install-diagnostics" name="install_diagnostics" type="checkbox">Install optional network diagnostics tools</label>
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
  const cameraFtp = ftp.camera_ftp || {};
  const connector = ftpConnector(deviceId);
  const savedSsh = savedSshCredential(deviceId);
  return `<div class="panel-head">
      <div>
        <p class="eyebrow">Belabox</p>
        <h2>${escapeHtml(deviceId)}</h2>
      </div>
      <span class="pill ${live?.online ? "online" : ""}">${live?.online ? "Online" : "Offline"}</span>
    </div>

    <section class="detail-grid">
      <div class="status-card">
        <h3>Overview</h3>
        <dl>${rows([
          ["Heartbeat", formatDate(live?.last_heartbeat_at)],
          ["Agent", live?.agent_version || "Unknown"],
          ["MQTT", state.status.mqtt?.connected ? "Connected" : "Reconnecting"],
          ["Created", formatDate(provisioned?.created_at)],
        ])}</dl>
      </div>
      <div class="status-card">
        <h3>Modules</h3>
        <dl>${rows([
          ["FTP connector", ftp.state || connectorStatus(connector, ftp)],
          ["Chunk Relay", chunkStatus(ftp)],
          ["Upload file", ftp.file || "None"],
          ["Progress", ftp.file ? `${Math.round(Number(ftp.percent || 0))}%` : "Idle"],
        ])}</dl>
      </div>
    </section>

    <details class="settings-section" data-section="ssh-maintenance">
      <summary>SSH Maintenance</summary>
      <p class="hint">Online controls use signed MQTT. SSH is only needed for agent repair, optional tool install, or reinstalling local services.</p>
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
        <div class="actions wide">
          <button id="pair-device" type="submit">Repair / Update Agent</button>
          ${savedSsh ? `<button id="forget-ssh" type="button">Forget Saved SSH</button>` : ""}
        </div>
      </form>
      <pre id="pair-output">${savedSsh ? "Saved SSH can be reused for installer jobs. Enter a password or key to rotate it." : "Enter SSH credentials when an installer or repair job needs local access."}</pre>
    </details>

    <details class="settings-section" data-section="ftp-connector" open>
      <summary>FTP Connector</summary>
      <dl>${rows([
        ["FRAME target", `${state.status.ftp_connector?.target_host || "Not set"}:${state.status.ftp_connector?.target_port || 2121}`],
        ["FRAME credentials", state.status.ftp_connector?.target_password_configured ? "Configured internally" : "Missing in .env"],
        ["Camera FTP", cameraFtp.port ? `${cameraFtp.username}@Belabox:${cameraFtp.port}` : connector ? `${connector.camera_username}@Belabox:${state.status.ftp_connector?.camera_port || 2121}` : "Not installed"],
        ["Managed folder", state.status.ftp_connector?.managed_upload_dir || "Agent workspace"],
      ])}</dl>
      <form id="ftp-form" class="form-grid">
        <label>FRAME FTP external host/IP<input id="ftp-target-host" name="target_host" value="${escapeAttr(ftpDefaultHost())}"></label>
        <label>FRAME FTP port<input id="ftp-target-port" name="target_port" type="number" min="1" max="65535" value="${escapeAttr(state.status.ftp_connector?.target_port || 2121)}"></label>
        <label>Camera FTP username<input id="camera-ftp-user" name="camera_username" value="${escapeAttr(connector?.camera_username || state.status.ftp_connector?.camera_username || "framecam")}"></label>
        <label>Camera FTP password<input id="camera-ftp-password" name="camera_password" type="password" autocomplete="new-password" placeholder="${connector ? "Keep current if blank" : "Generate if blank"}"></label>
        <div class="actions wide"><button id="setup-ftp-connector" type="submit">Install / Repair FTP Connector</button></div>
      </form>
      <pre id="ftp-output">${connector ? "FTP connector credentials are stored internally. Reinstall uses saved SSH or prompts through SSH Maintenance." : "Install uses saved SSH if available. Otherwise open SSH Maintenance first."}</pre>
    </details>

    <details class="settings-section" data-section="mqtt-controls" open>
      <summary>MQTT Controls</summary>
      <dl>${rows([
        ["Current mode", ftp.transfer_mode || ftp.transport || "Unknown"],
        ["State", ftp.status_text || ftp.state || "Waiting for telemetry"],
        ["Endpoint", state.status.chunk_upload?.public_url_configured ? "Configured" : "Missing"],
        ["Photo stage", state.status.chunk_upload?.photo_upload_configured ? "Configured" : "Missing token"],
      ])}</dl>
      <form id="chunk-form" class="form-grid">
        <label>Chunk size bytes<input id="photo-chunk-size" name="chunk_size_bytes" type="number" min="262144" max="67108864" step="262144" value="${escapeAttr(state.status.chunk_upload?.chunk_size_bytes || 4194304)}"></label>
        <div class="actions wide">
          <button id="enable-chunk-relay" type="button" ${live?.online ? "" : "disabled"}>Enable Chunk Relay</button>
          <button id="use-direct-ftp" type="button" ${live?.online ? "" : "disabled"}>Use Direct FTP</button>
          <button id="refresh-photo-module" type="button" ${live?.online ? "" : "disabled"}>Refresh Status</button>
        </div>
      </form>
      <p class="hint">${live?.online ? "Uses signed MQTT commands. No SSH login required." : "Agent must be online before MQTT configuration can be sent."}</p>
    </details>

    <details class="settings-section" data-section="network-diagnostics" open>
      <summary>Network Diagnostics</summary>
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
        <button class="danger" type="button" data-remove-device="${escapeAttr(deviceId)}">Remove Device</button>
      </div>
    </details>`;
}

async function handlePanelClick(event) {
  const remove = event.target.closest("[data-remove-device]");
  if (remove) return removeProvisionedDevice(remove);
  const forgetSsh = event.target.closest("#forget-ssh");
  if (forgetSsh) return forgetSavedSsh(forgetSsh);
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
      await applyPhotoTransport("chunked_https", result.device_id, form.querySelector("#photo-chunk-size")?.value, true);
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

async function setupFtpConnector(form, deviceId = state.selectedDeviceId, output = form.querySelector("#ftp-output")) {
  const button = form.querySelector("#setup-ftp-connector");
  const sshScope = form.querySelector("#pair-host") ? form : elements.devicePanel;
  const sshPayload = pairPayload(sshScope, deviceId);
  const resetButton = setButtonBusy(button, "Installing...");
  state.panelLocked = true;
  output.textContent = "Queued...";
  showNotice("Installing FTP connector...", "busy");
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
    output.textContent = [
      `FRAME target: ${result.target_host}:${result.target_port}`,
      `Camera FTP: ${result.camera_ftp_username}@Belabox:${result.camera_ftp_port}`,
      `Camera FTP password: ${result.camera_ftp_password}`,
      `Managed upload folder: ${result.upload_dir}`,
    ].join("\n");
    clearSecrets(form);
    showNotice("FTP connector installed and tested. Waiting for telemetry.", "success");
    await refresh();
  } catch (error) {
    if (/SSH credentials|SSH Maintenance|Saved SSH/i.test(error.message)) openSshMaintenance(error.message);
    if (output) output.textContent = `FTP connector setup failed: ${error.message}`;
    showNotice(`FTP connector setup failed: ${error.message}`, "error");
  } finally {
    state.panelLocked = false;
    resetButton();
  }
}

async function applyPhotoTransport(mode, deviceId = state.selectedDeviceId, chunkSizeValue, quiet = false, button = null) {
  const resetButton = setButtonBusy(button, mode === "chunked_https" ? "Enabling..." : "Switching...");
  const chunkSize = Number(chunkSizeValue || elements.devicePanel.querySelector("#photo-chunk-size")?.value || 0);
  try {
    if (chunkSize > 0) await sendPhotoCommand("photo_transport_config_set", { chunk_size_bytes: chunkSize }, deviceId);
    await sendPhotoCommand("photo_transfer_mode_set", { mode }, deviceId);
    if (!quiet) showNotice(`Photo transfer mode requested: ${mode}.`, "success");
  } catch (error) {
    showNotice(`${mode === "chunked_https" ? "Chunk Relay" : "Direct FTP"} update failed: ${error.message}`, "error");
  } finally {
    resetButton();
  }
}

async function sendPhotoCommand(command, args, deviceId = state.selectedDeviceId, button = null) {
  if (!deviceId || deviceId === ADD_DEVICE_ID) throw new Error("Select a paired Belabox device first.");
  const resetButton = setButtonBusy(button, "Sending...");
  showNotice(`Sending ${command}...`, "busy");
  try {
    await fetchJson("/belabox/api/cmd/request", postJson({ device_id: deviceId, command, args }));
    showNotice(`${command} sent to ${deviceId}.`, "success");
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
    if (job.status === "error") throw new Error(job.error || "FTP connector setup failed.");
    await delay(1000);
  }
}

async function pollCommandResult(commandId, output) {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    await refresh();
    const diagnostic = liveDevice(state.selectedDeviceId)?.telemetry?.network_diagnostics;
    if (diagnostic) output.textContent = diagnosticSummary(diagnostic);
    const audit = await fetchJson("/belabox/api/commands");
    const result = (audit.commands || []).find((entry) => entry.type === "result" && entry.command_id === commandId);
    if (result) return result;
    await delay(1000);
  }
  throw new Error("Timed out waiting for agent result.");
}

function renderJob(job, output) {
  const lines = (job.steps || []).map((step) => `${formatDate(step.at)}  ${step.message}`);
  if (job.status === "error" && job.error) lines.push(`Error: ${job.error}`);
  output.textContent = lines.join("\n");
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

function connectorStatus(connector, ftp) {
  if (ftp?.state || ftp?.status_text) return ftp.status_text || ftp.state;
  return connector ? "Installed" : "Not installed";
}

function chunkStatus(ftp) {
  if (ftp?.transfer_mode === "chunked_https" || ftp?.transport === "chunked_https") return "Enabled";
  return "Direct FTP";
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
