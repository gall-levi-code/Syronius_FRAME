const elements = {
  connectionPill: document.getElementById("connection-pill"),
  pageTitle: document.getElementById("page-title"),
  accessBanner: document.getElementById("access-banner"),
  refreshButton: document.getElementById("refresh-button"),
  themeToggle: document.getElementById("theme-toggle"),
  overallValue: document.getElementById("overall-value"),
  overallDetail: document.getElementById("overall-detail"),
  servicesValue: document.getElementById("services-value"),
  diskValue: document.getElementById("disk-value"),
  diskMeterFill: document.getElementById("disk-meter-fill"),
  diskDetail: document.getElementById("disk-detail"),
  modeValue: document.getElementById("mode-value"),
  modePill: document.getElementById("mode-pill"),
  updatedValue: document.getElementById("updated-value"),
  alertsSection: document.getElementById("alerts-section"),
  alertCount: document.getElementById("alert-count"),
  alertsList: document.getElementById("alerts-list"),
  toolsGrid: document.getElementById("tools-grid"),
  serviceCount: document.getElementById("service-count"),
  servicesGrid: document.getElementById("services-grid"),
  lastIngest: document.getElementById("last-ingest"),
  lastPhoto: document.getElementById("last-photo"),
  audioStreams: document.getElementById("audio-streams"),
  discordBridges: document.getElementById("discord-bridges"),
  footerState: document.getElementById("footer-state"),
  logsDialog: document.getElementById("logs-dialog"),
  logsTitle: document.getElementById("logs-title"),
  logsOutput: document.getElementById("logs-output"),
  closeLogs: document.getElementById("close-logs"),
  toast: document.getElementById("toast"),
};

let portalConfig = null;
let refreshTimer = null;
let logsSource = null;
let toastTimer = null;
let logLines = [];
let currentView = "dashboard";
const MAX_LOG_LINES = 1000;

initializeTheme();
initializeView();
bindEvents();
initialize();

async function initialize() {
  try {
    portalConfig = await fetchJson("/api/portal");
    renderAccessContext();
    renderTools(portalConfig.tools);
    scheduleRefresh(portalConfig.refresh_ms);
    await refreshStatus();
  } catch (error) {
    setDisconnected(error);
  }
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", refreshStatus);
  elements.themeToggle.addEventListener("click", toggleTheme);
  elements.closeLogs.addEventListener("click", closeLogs);
  elements.logsDialog.addEventListener("close", closeLogs);
  elements.servicesGrid.addEventListener("click", async (event) => {
    const logsButton = event.target.closest("[data-logs]");
    if (logsButton) {
      openLogs(logsButton.dataset.logs);
      return;
    }

    const restartButton = event.target.closest("[data-restart]");
    if (restartButton) {
      await restartService(restartButton.dataset.restart, restartButton);
    }
  });
}

async function refreshStatus() {
  elements.refreshButton.classList.add("spinning");
  try {
    const status = await fetchJson("/status/api");
    renderStatus(status);
    setConnected();
  } catch (error) {
    setDisconnected(error);
  } finally {
    window.setTimeout(() => elements.refreshButton.classList.remove("spinning"), 300);
  }
}

function renderStatus(status) {
  const services = status.services || [];
  const alerts = status.alerts || [];
  const running = services.filter((service) => service.status === "running").length;
  const errorCount = alerts.filter((alert) => alert.level === "error").length;
  const unknownHealthCount = services.filter(
    (service) => service.status === "running" && service.health === "unknown",
  ).length;

  elements.servicesValue.textContent = `${running} / ${services.length}`;
  elements.serviceCount.textContent = String(services.length);
  elements.diskValue.textContent = `${Number(status.disk?.percent_used || 0).toFixed(1)}%`;
  elements.diskMeterFill.style.width = `${clamp(status.disk?.percent_used || 0, 0, 100)}%`;
  elements.diskDetail.textContent = `${formatBytes(status.disk?.free_bytes || 0)} free`;
  elements.modeValue.textContent = status.mode;
  elements.modePill.textContent = status.mode;
  elements.updatedValue.textContent = `Updated ${formatRelative(status.generated_at)}`;
  elements.footerState.textContent = `Status generated ${formatTime(status.generated_at)}`;

  if (errorCount) {
    elements.overallValue.textContent = "Attention";
    elements.overallDetail.textContent = `${errorCount} critical alert${errorCount === 1 ? "" : "s"}`;
  } else if (alerts.length) {
    elements.overallValue.textContent = "Degraded";
    elements.overallDetail.textContent = `${alerts.length} warning${alerts.length === 1 ? "" : "s"}`;
  } else if (unknownHealthCount) {
    elements.overallValue.textContent = "Unverified";
    elements.overallDetail.textContent = `${unknownHealthCount} service${unknownHealthCount === 1 ? "" : "s"} without healthchecks`;
  } else {
    elements.overallValue.textContent = "Good";
    elements.overallDetail.textContent = services.length ? "No active alerts" : "Portal online";
  }

  renderAlerts(alerts);
  renderServices(services);
  renderActivity(status);
}

function renderTools(tools) {
  elements.toolsGrid.innerHTML = tools
    .map((tool) => {
      const labels = {
        ready: "Ready - Open tool",
        "needs-setup": "Needs setup",
        offline: "Offline",
        disabled: "Disabled",
      };
      const state = tool.accessible ? labels[tool.readiness] || "Unknown" : "LAN only";
      const accessLabel = tool.access === "public" ? "Public route" : "LAN only";
      if (tool.readiness !== "ready" || !tool.accessible) {
        return `
          <div class="tool-card disabled readiness-${escapeAttribute(tool.readiness)}" aria-disabled="true">
            <div><h3>${escapeHtml(tool.name)}</h3><p>${escapeHtml(tool.description)}</p></div>
            <div class="tool-card-footer">
              <span class="tool-access access-${escapeAttribute(tool.access)}">${accessLabel}</span>
              <span class="tool-state">${state}</span>
            </div>
          </div>`;
      }
      return `
        <a class="tool-card" href="${escapeAttribute(tool.route)}">
          <div><h3>${escapeHtml(tool.name)}</h3><p>${escapeHtml(tool.description)}</p></div>
          <div class="tool-card-footer">
            <span class="tool-access access-${escapeAttribute(tool.access)}">${accessLabel}</span>
            <span class="tool-state">${state}</span>
          </div>
        </a>`;
    })
    .join("");
}

function renderAccessContext() {
  const isPublic = portalConfig?.access_context === "public";
  elements.accessBanner.classList.toggle("access-banner-public", isPublic);
  elements.accessBanner.innerHTML = isPublic
    ? "<strong>Public dashboard</strong><span>Public-safe tools are available here. Management and capture tools remain available only from the FRAME host or LAN.</span>"
    : "<strong>LAN dashboard</strong><span>This browser can open both local management tools and public-safe presentation links.</span>";
}

function initializeView() {
  currentView = window.location.pathname === "/status" ? "status" : "dashboard";
  document.querySelectorAll("[data-portal-view]").forEach((element) => {
    element.hidden = !element.dataset.portalView.split(/\s+/).includes(currentView);
  });
  document.querySelectorAll("[data-portal-nav]").forEach((link) => {
    const active = link.dataset.portalNav === currentView;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
  });
  elements.pageTitle.textContent = currentView === "status" ? "System Status" : "Dashboard";
}

function renderAlerts(alerts) {
  elements.alertsSection.hidden = alerts.length === 0 || currentView !== "status";
  elements.alertCount.textContent = String(alerts.length);
  elements.alertsList.innerHTML = alerts
    .map(
      (alert) => `
        <div class="alert-item alert-${escapeAttribute(alert.level)}">
          <span class="alert-mark" aria-hidden="true"></span>
          <span>${escapeHtml(alert.message)}</span>
        </div>`,
    )
    .join("");
}

function renderServices(services) {
  if (!services.length) {
    elements.servicesGrid.innerHTML =
      '<p class="empty-state">No FRAME containers were discovered. Check the Docker socket mount.</p>';
    return;
  }

  const restartsEnabled = portalConfig?.restarts_enabled === true;
  elements.servicesGrid.innerHTML = services
    .map(
      (service) => `
        <article class="service-card">
          <div class="service-heading">
            <div class="service-title">
              <h3 title="${escapeAttribute(service.name)}">${escapeHtml(service.name)}</h3>
              <span class="service-meta">${formatUptime(service.uptime_seconds)}</span>
            </div>
          </div>
          <div class="status-row">
            <span class="status-badge status-${escapeAttribute(service.status)}">${escapeHtml(service.status)}</span>
            <span class="status-badge status-${escapeAttribute(service.health)}">${escapeHtml(service.health)}</span>
          </div>
          <div class="service-actions">
            <button class="text-button" type="button" data-logs="${escapeAttribute(service.name)}">Logs</button>
            <button class="text-button" type="button" data-restart="${escapeAttribute(service.name)}" ${restartsEnabled ? "" : "disabled"} title="${restartsEnabled ? "Restart service" : "Restarts are disabled"}">Restart</button>
          </div>
        </article>`,
    )
    .join("");
}

function renderActivity(status) {
  elements.lastIngest.textContent = status.last_ingest
    ? `${status.last_ingest.stream_id} - ${formatRelative(status.last_ingest.at)}`
    : "No ingest reported";
  elements.lastPhoto.textContent = status.last_photo
    ? `${status.last_photo.base} - ${formatRelative(status.last_photo.at)}`
    : "No photo reported";

  const activeAudio = (status.audio_streams || []).filter((stream) => stream.status === "live");
  elements.audioStreams.textContent = activeAudio.length
    ? `${activeAudio.length} live - ${activeAudio.reduce((sum, stream) => sum + stream.listener_count, 0)} listeners`
    : "None active";

  const bridges = status.discord_audio_bridges || [];
  const activeMixes = bridges.reduce((sum, bridge) => sum + bridge.active_mix_count, 0);
  const activeStreamers = bridges.flatMap((bridge) => bridge.active_streamers || []);
  const clientCount = bridges.reduce(
    (sum, bridge) => sum + (bridge.clients?.audio || 0) + (bridge.clients?.overlay || 0) + (bridge.clients?.control || 0),
    0,
  );
  elements.discordBridges.textContent = bridges.length
    ? activeMixes
      ? `${activeMixes} mixes - ${activeStreamers.join(", ")} - ${clientCount} clients`
      : `${bridges.length} configured - ${clientCount} clients`
    : "None reported";
}

async function restartService(name, button) {
  if (!window.confirm(`Restart ${name}? Active work in that service may be interrupted.`)) {
    return;
  }

  button.disabled = true;
  try {
    await fetchJson(`/status/services/${encodeURIComponent(name)}/restart`, { method: "POST" });
    showToast(`${name} restart requested.`);
    window.setTimeout(refreshStatus, 1200);
  } catch (error) {
    showToast(error.message || "Restart failed.");
  } finally {
    button.disabled = false;
  }
}

function openLogs(name) {
  closeLogs();
  elements.logsTitle.textContent = `${name} Logs`;
  elements.logsOutput.textContent = "Connecting...\n";
  logLines = [];
  elements.logsDialog.showModal();
  logsSource = new EventSource(`/status/logs/${encodeURIComponent(name)}`);
  logsSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      logLines.push(String(payload.line || ""));
      if (logLines.length > MAX_LOG_LINES) {
        logLines.splice(0, logLines.length - MAX_LOG_LINES);
      }
      elements.logsOutput.textContent = `${logLines.join("\n")}\n`;
      elements.logsOutput.scrollTop = elements.logsOutput.scrollHeight;
    } catch {
      elements.logsOutput.textContent += "\nUnable to parse a log event.\n";
    }
  };
  logsSource.onerror = () => {
    elements.logsOutput.textContent += "\nLog stream disconnected.\n";
    logsSource?.close();
  };
}

function closeLogs() {
  logsSource?.close();
  logsSource = null;
  if (elements.logsDialog.open) {
    elements.logsDialog.close();
  }
}

function setConnected() {
  elements.connectionPill.textContent = "Connected";
  elements.connectionPill.className = "pill pill-ok";
}

function setDisconnected(error) {
  elements.connectionPill.textContent = "Disconnected";
  elements.connectionPill.className = "pill pill-bad";
  elements.footerState.textContent = error?.message || "Status API unavailable";
}

function scheduleRefresh(milliseconds) {
  window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(refreshStatus, Math.max(1000, milliseconds || 5000));
}

function initializeTheme() {
  const theme = localStorage.getItem("frame-portal-theme");
  document.body.classList.toggle("theme-day", theme === "day");
  updateThemeLabel();
}

function toggleTheme() {
  const isDay = document.body.classList.toggle("theme-day");
  localStorage.setItem("frame-portal-theme", isDay ? "day" : "night");
  updateThemeLabel();
}

function updateThemeLabel() {
  const isDay = document.body.classList.contains("theme-day");
  elements.themeToggle.setAttribute("aria-label", isDay ? "Switch to night mode" : "Switch to day mode");
  elements.themeToggle.title = isDay ? "Switch to night mode" : "Switch to day mode";
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  return payload;
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function formatUptime(seconds) {
  if (!Number.isFinite(seconds)) {
    return "Not running";
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `Up ${days}d ${hours}h`;
  if (hours) return `Up ${hours}h ${minutes}m`;
  return `Up ${minutes}m`;
}

function formatRelative(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "unknown";
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TiB`;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${value} B`;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
