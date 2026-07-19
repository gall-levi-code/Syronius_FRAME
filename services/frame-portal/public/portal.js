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
  toolLinksDialog: document.getElementById("tool-links-dialog"),
  toolLinksTitle: document.getElementById("tool-links-title"),
  toolLinksList: document.getElementById("tool-links-list"),
  toolLinksStatus: document.getElementById("tool-links-status"),
  closeToolLinks: document.getElementById("close-tool-links"),
  toast: document.getElementById("toast"),
  themeModeSelect: document.getElementById("theme-mode-select"),
  newThemePreset: document.getElementById("new-theme-preset"),
  themePresetTrigger: document.getElementById("theme-preset-trigger"),
  themePresetTriggerSwatches: document.getElementById("theme-preset-trigger-swatches"),
  themePresetTriggerName: document.getElementById("theme-preset-trigger-name"),
  themePresetTriggerMeta: document.getElementById("theme-preset-trigger-meta"),
  themePresetMenu: document.getElementById("theme-preset-menu"),
  themePresetDialog: document.getElementById("theme-preset-dialog"),
  themePresetKindStep: document.getElementById("theme-preset-kind-step"),
  themePresetEditorStep: document.getElementById("theme-preset-editor-step"),
  themeColorChoice: document.getElementById("theme-color-choice"),
  themeFullChoice: document.getElementById("theme-full-choice"),
  themeCancelKind: document.getElementById("theme-cancel-kind"),
  themeEditorEyebrow: document.getElementById("theme-editor-eyebrow"),
  themeEditorTitle: document.getElementById("theme-editor-title"),
  themePresetNameInput: document.getElementById("theme-preset-name-input"),
  themePresetDefaultMode: document.getElementById("theme-preset-default-mode"),
  themeColorLabel: document.getElementById("theme-color-label"),
  themeColorInput: document.getElementById("theme-color-input"),
  themePaletteFields: document.getElementById("theme-palette-fields"),
  themeBackKind: document.getElementById("theme-back-kind"),
  themeCancelEditor: document.getElementById("theme-cancel-editor"),
  themeSavePreset: document.getElementById("theme-save-preset"),
  themeConfirmDialog: document.getElementById("theme-confirm-dialog"),
  themeConfirmTitle: document.getElementById("theme-confirm-title"),
  themeConfirmCopy: document.getElementById("theme-confirm-copy"),
  themeConfirmCancel: document.getElementById("theme-confirm-cancel"),
  themeConfirmAccept: document.getElementById("theme-confirm-accept"),
  pipelineState: document.getElementById("pipeline-state"),
  pipelineForm: document.getElementById("pipeline-form"),
  pipelineLongEdge: document.getElementById("pipeline-long-edge"),
  pipelineQuality: document.getElementById("pipeline-quality"),
  pipelineQualityValue: document.getElementById("pipeline-quality-value"),
  pipelineMaxOutput: document.getElementById("pipeline-max-output"),
  pipelineSave: document.getElementById("pipeline-save"),
};

let portalConfig = null;
let refreshTimer = null;
let logsSource = null;
let toastTimer = null;
let toolLinksStatusTimer = null;
let logLines = [];
let activeToolLinksId = null;
let currentView = "dashboard";
let themeSettings = null;
let themePresetDraftKind = "color";
let themeConfirmResolve = null;
let pipelineSettingsLoaded = false;
const MAX_LOG_LINES = 1000;
const DEFAULT_THEME_PROFILE_ID = "frame-blue";
const THEME_MODE_KEY = "frame-theme";
const LEGACY_PORTAL_THEME_KEY = "frame-portal-theme";
const THEME_PROFILE_ID_KEY = "frame-theme-profile-id";
const THEME_PROFILE_KEY = "frame-theme-profile";
const THEME_CUSTOM_PROFILES_KEY = "frame-theme-custom-profiles";
const themePaletteFields = [
  ["page", "Page"],
  ["panel", "Panel"],
  ["panelStrong", "Raised panel"],
  ["panelMuted", "Muted panel"],
  ["border", "Border"],
  ["borderSoft", "Soft border"],
  ["label", "Muted text"],
  ["text", "Text"],
  ["accent", "Primary"],
  ["accentStrong", "Primary text"],
  ["accentSoft", "Primary surface"],
  ["accentBorder", "Primary border"],
  ["accentContrast", "Primary contrast"],
  ["danger", "Danger"],
  ["warning", "Warning"],
  ["good", "Success"],
  ["toggleNightBg", "Night button"],
  ["toggleNightText", "Night icon"],
  ["toggleDayBg", "Day button"],
  ["toggleDayText", "Day icon"],
];
const builtInThemeProfiles = [
  buildThemeProfile("frame-blue", "Frame Blue", "#2cb4fb"),
  buildThemeProfile("signal-green", "Signal Green", "#3bd48a"),
  buildThemeProfile("gallery-gold", "Gallery Gold", "#d8a321"),
  buildThemeProfile("rose-coral", "Rose Coral", "#d45d7c"),
  buildThemeProfile("violet-ink", "Violet Ink", "#7c6ff0"),
];

initializeTheme();
initializeView();
bindEvents();
initialize();

async function initialize() {
  try {
    await refreshPortalConfig();
    scheduleRefresh(portalConfig.refresh_ms);
    await refreshStatus();
  } catch (error) {
    setDisconnected(error);
  }
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", refreshDashboard);
  elements.themeToggle.addEventListener("click", toggleTheme);
  elements.themeModeSelect.addEventListener("change", () => {
    themeSettings.mode = elements.themeModeSelect.value === "day" ? "day" : "night";
    applyThemeSettings();
    renderThemeControls();
  });
  elements.themePresetTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleThemePresetMenu();
  });
  elements.themePresetMenu.addEventListener("click", async (event) => {
    const deleteButton = event.target.closest("[data-delete-theme-preset]");
    if (deleteButton) {
      event.preventDefault();
      event.stopPropagation();
      await deleteThemePreset(deleteButton.dataset.deleteThemePreset);
      return;
    }
    const option = event.target.closest("[data-theme-preset-option]");
    if (!option) return;
    event.preventDefault();
    selectThemeProfile(option.dataset.themePresetOption);
  });
  elements.newThemePreset.addEventListener("click", openThemePresetDialog);
  elements.themeColorChoice.addEventListener("click", () => showThemePresetEditor("color"));
  elements.themeFullChoice.addEventListener("click", () => showThemePresetEditor("full"));
  elements.themeCancelKind.addEventListener("click", closeThemePresetDialog);
  elements.themeBackKind.addEventListener("click", showThemePresetKindStep);
  elements.themeCancelEditor.addEventListener("click", closeThemePresetDialog);
  elements.themeSavePreset.addEventListener("click", createThemePreset);
  elements.themePresetNameInput.addEventListener("input", () => {
    if (elements.themePresetNameInput.value.trim()) {
      elements.themePresetNameInput.setCustomValidity("");
    }
  });
  elements.themeColorInput.addEventListener("input", () => {
    if (themePresetDraftKind === "full") {
      renderThemePaletteFields(buildThemePalettes(elements.themeColorInput.value));
    }
  });
  elements.themePresetDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeThemePresetDialog();
  });
  elements.themeConfirmCancel.addEventListener("click", () => resolveThemeConfirm(false));
  elements.themeConfirmAccept.addEventListener("click", () => resolveThemeConfirm(true));
  elements.themeConfirmDialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    resolveThemeConfirm(false);
  });
  elements.pipelineForm.addEventListener("submit", savePipelineSettings);
  elements.pipelineQuality.addEventListener("input", updatePipelineQualityLabel);
  document.querySelectorAll("[data-quality-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      elements.pipelineQuality.value = button.dataset.qualityPreset;
      updatePipelineQualityLabel();
    });
  });
  document.addEventListener("click", (event) => {
    if (elements.themePresetMenu.hidden) return;
    if (elements.themePresetTrigger.contains(event.target) || elements.themePresetMenu.contains(event.target)) return;
    closeThemePresetMenu();
  });
  document.querySelectorAll("[data-portal-nav]").forEach((link) => {
    link.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = new URL(link.href, window.location.href);
      if (target.origin !== window.location.origin) return;
      event.preventDefault();
      if (window.location.pathname !== target.pathname) window.history.pushState({}, "", target.pathname);
      initializeView();
    });
  });
  window.addEventListener("popstate", initializeView);
  window.addEventListener("storage", (event) => {
    if (
      event.key === THEME_MODE_KEY ||
      event.key === THEME_PROFILE_ID_KEY ||
      event.key === THEME_CUSTOM_PROFILES_KEY ||
      event.key === THEME_PROFILE_KEY
    ) {
      themeSettings = readThemeSettings();
      applyThemeSettings(false);
      renderThemeControls();
    }
  });
  window.addEventListener("frame-theme-change", () => {
    themeSettings = readThemeSettings();
    applyThemeSettings(false);
    renderThemeControls();
  });
  elements.closeLogs.addEventListener("click", closeLogs);
  elements.logsDialog.addEventListener("close", closeLogs);
  elements.closeToolLinks.addEventListener("click", () => elements.toolLinksDialog.close());
  elements.toolLinksDialog.addEventListener("close", clearToolLinksDialog);
  elements.toolsGrid.addEventListener("click", async (event) => {
    const linksButton = event.target.closest("[data-tool-links]");
    if (!linksButton) return;
    const toolId = linksButton.dataset.toolLinks;
    const cachedTool = portalConfig?.tools?.find((candidate) => candidate.id === toolId);
    if (cachedTool) openToolLinks(cachedTool);
    try {
      await refreshPortalConfig({ renderToolCards: false });
      const currentTool = portalConfig?.tools?.find((candidate) => candidate.id === toolId);
      if (currentTool && getToolLinkGroups(currentTool).length) {
        if (elements.toolLinksDialog.open && activeToolLinksId === toolId) openToolLinks(currentTool);
      } else if (elements.toolLinksDialog.open && activeToolLinksId === toolId) {
        elements.toolLinksDialog.close();
        renderTools(portalConfig.tools);
        elements.refreshButton.focus();
        showToast("No links are currently available.");
      }
    } catch {
      showToolLinksStatus("Showing the last available links.");
    }
  });
  elements.toolLinksList.addEventListener("click", async (event) => {
    const copyButton = event.target.closest("[data-copy-link]");
    if (!copyButton) return;
    try {
      await copyText(copyButton.dataset.copyLink);
      showToolLinksStatus("Link copied.");
    } catch {
      showToolLinksStatus("Could not copy link.");
    }
  });
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
      const linkGroups = getToolLinkGroups(tool);
      const isReady = tool.readiness === "ready" && tool.accessible;
      const linksButton = linkGroups.length
        ? `<button class="tool-access access-${escapeAttribute(tool.access)} tool-links-button" type="button" data-tool-links="${escapeAttribute(tool.id)}" aria-label="Show links for ${escapeAttribute(tool.name)}" aria-haspopup="dialog" aria-controls="tool-links-dialog">Links</button>`
        : "";
      return `
        <article class="tool-card${isReady ? "" : ` disabled readiness-${escapeAttribute(tool.readiness)}`}">
          ${isReady ? `<a class="tool-card-target" href="${escapeAttribute(tool.route)}" aria-label="Open ${escapeAttribute(tool.name)}"></a>` : ""}
          <div class="tool-card-copy"><h3>${escapeHtml(tool.name)}</h3><p>${escapeHtml(tool.description)}</p></div>
          <div class="tool-card-footer">
            <div class="tool-access-actions">
              <span class="tool-access access-${escapeAttribute(tool.access)}">${accessLabel}</span>
              ${linksButton}
            </div>
            <span class="tool-state">${state}</span>
          </div>
        </article>`;
    })
    .join("");
}

async function refreshPortalConfig({ renderToolCards = true } = {}) {
  portalConfig = await fetchJson("/api/portal");
  renderPortalNav();
  initializeView();
  renderAccessContext();
  if (renderToolCards) renderTools(portalConfig.tools);
  return portalConfig;
}

async function refreshDashboard() {
  elements.refreshButton.classList.add("spinning");
  try {
    const [, status] = await Promise.all([refreshPortalConfig(), fetchJson("/status/api")]);
    renderStatus(status);
    setConnected();
  } catch (error) {
    setDisconnected(error);
  } finally {
    window.setTimeout(() => elements.refreshButton.classList.remove("spinning"), 300);
  }
}

function openToolLinks(tool) {
  const groups = getToolLinkGroups(tool);
  if (!groups.length) return;
  activeToolLinksId = tool.id;
  elements.toolLinksTitle.textContent = `${tool.name} Links`;
  elements.toolLinksList.innerHTML = groups
    .map(
      (group) => `
        <section class="tool-link-group">
          <h3>${escapeHtml(group.label)}</h3>
          <div class="tool-link-rows">
            ${group.links.map(renderToolLink).join("")}
          </div>
        </section>`,
    )
    .join("");
  if (!elements.toolLinksDialog.open) elements.toolLinksDialog.showModal();
}

function clearToolLinksDialog() {
  activeToolLinksId = null;
  window.clearTimeout(toolLinksStatusTimer);
  elements.toolLinksStatus.hidden = true;
  elements.toolLinksStatus.textContent = "";
}

function showToolLinksStatus(message) {
  if (!elements.toolLinksDialog.open) {
    showToast(message);
    return;
  }
  window.clearTimeout(toolLinksStatusTimer);
  elements.toolLinksStatus.textContent = message;
  elements.toolLinksStatus.hidden = false;
  toolLinksStatusTimer = window.setTimeout(() => {
    elements.toolLinksStatus.hidden = true;
    elements.toolLinksStatus.textContent = "";
  }, 2400);
}

function renderToolLink(link) {
  const url = resolveToolLink(link.url);
  const openUrl = link.openable !== false ? resolveHttpLink(link.url) : null;
  return `
    <div class="tool-link-row">
      <div class="tool-link-copy">
        <strong>${escapeHtml(link.label)}</strong>
        <code>${escapeHtml(url)}</code>
      </div>
      <div class="tool-link-actions">
        ${
          openUrl
            ? `<a class="icon-button tool-link-action" href="${escapeAttribute(openUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${escapeAttribute(link.label)} in a new tab" title="Open in a new tab">
                ${openIcon()}
              </a>`
            : ""
        }
        <button class="icon-button tool-link-action" type="button" data-copy-link="${escapeAttribute(url)}" aria-label="Copy ${escapeAttribute(link.label)}" title="Copy">
          ${copyIcon()}
        </button>
      </div>
    </div>`;
}

function getToolLinkGroups(tool) {
  if (!Array.isArray(tool?.link_groups)) return [];
  return tool.link_groups
    .map((group) => ({
      label: String(group?.label || "Links"),
      links: Array.isArray(group?.links)
        ? group.links.filter((link) => link && typeof link.label === "string" && typeof link.url === "string" && link.url.trim())
        : [],
    }))
    .filter((group) => group.links.length);
}

function resolveToolLink(value) {
  const url = String(value || "").trim();
  if (!url.startsWith("/")) return url;
  return new URL(url, window.location.origin).href;
}

function resolveHttpLink(value) {
  try {
    const url = new URL(String(value || ""), window.location.origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function renderAccessContext() {
  const isPublic = portalConfig?.access_context === "public";
  elements.accessBanner.classList.toggle("access-banner-public", isPublic);
  elements.accessBanner.innerHTML = isPublic
    ? "<strong>Public dashboard</strong><span>Public-safe tools are available here. Management and capture tools remain available only from the FRAME host or LAN.</span>"
    : "<strong>LAN dashboard</strong><span>This browser can open both local management tools and public-safe presentation links.</span>";
}

function renderPortalNav() {
  document.querySelectorAll("[data-portal-nav=\"pipeline\"]").forEach((link) => {
    link.hidden = !pipelineVisible();
  });
}

function pipelineVisible() {
  return portalConfig?.pipeline_enabled === true && portalConfig?.access_context !== "public";
}

function initializeView() {
  const path = window.location.pathname.replace(/\/+$/, "") || "/dashboard";
  if (path === "/pipeline" && portalConfig && !pipelineVisible()) {
    window.history.replaceState({}, "", "/dashboard");
    currentView = "dashboard";
  } else {
    currentView = path === "/status" ? "status" : path === "/theme" ? "theme" : path === "/pipeline" ? "pipeline" : "dashboard";
  }
  document.querySelectorAll("[data-portal-view]").forEach((element) => {
    element.hidden = !element.dataset.portalView.split(/\s+/).includes(currentView);
  });
  document.querySelectorAll("[data-portal-nav]").forEach((link) => {
    const active = link.dataset.portalNav === currentView;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  elements.pageTitle.textContent = currentView === "status"
    ? "System Status"
    : currentView === "theme" ? "Theme" : currentView === "pipeline" ? "Pipeline" : "Dashboard";
  if (currentView === "pipeline" && pipelineVisible()) void loadPipelineSettings();
}

async function loadPipelineSettings() {
  if (pipelineSettingsLoaded) return;
  setPipelineState("Loading", "pill-idle");
  try {
    const payload = await fetchJson("/pipeline/api/settings");
    renderPipelineSettings(payload.settings);
    pipelineSettingsLoaded = true;
    setPipelineState("Ready", "pill-ok");
  } catch (error) {
    setPipelineState("Unavailable", "pill-bad");
    showToast(error.message || "Pipeline settings unavailable.");
  }
}

function renderPipelineSettings(settings) {
  elements.pipelineLongEdge.value = String(settings?.long_edge_px ?? 0);
  elements.pipelineQuality.value = String(settings?.jpeg_quality ?? 92);
  elements.pipelineMaxOutput.value = String(settings?.max_output_mb ?? 0);
  updatePipelineQualityLabel();
}

async function savePipelineSettings(event) {
  event.preventDefault();
  elements.pipelineSave.disabled = true;
  setPipelineState("Saving", "pill-warn");
  try {
    const payload = await fetchJson("/pipeline/api/settings", {
      method: "PUT",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        long_edge_px: Number.parseInt(elements.pipelineLongEdge.value || "0", 10),
        jpeg_quality: Number.parseInt(elements.pipelineQuality.value || "92", 10),
        max_output_mb: Number.parseFloat(elements.pipelineMaxOutput.value || "0"),
      }),
    });
    renderPipelineSettings(payload.settings);
    setPipelineState("Saved", "pill-ok");
    showToast("Pipeline settings saved.");
  } catch (error) {
    setPipelineState("Error", "pill-bad");
    showToast(error.message || "Pipeline settings were not saved.");
  } finally {
    elements.pipelineSave.disabled = false;
  }
}

function updatePipelineQualityLabel() {
  elements.pipelineQualityValue.textContent = elements.pipelineQuality.value;
}

function setPipelineState(label, className) {
  elements.pipelineState.textContent = label;
  elements.pipelineState.className = `pill ${className}`;
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
  themeSettings = readThemeSettings();
  applyThemeSettings(false);
  renderThemeControls();
}

function toggleTheme() {
  themeSettings = themeSettings || readThemeSettings();
  themeSettings.mode = themeSettings.mode === "day" ? "night" : "day";
  applyThemeSettings();
  renderThemeControls();
}

function updateThemeLabel() {
  const isDay = (themeSettings?.mode || readStoredTheme()) === "day";
  elements.themeToggle.setAttribute("aria-label", isDay ? "Switch to night mode" : "Switch to day mode");
  elements.themeToggle.title = isDay ? "Switch to night mode" : "Switch to day mode";
  elements.themeToggle.setAttribute("aria-pressed", String(isDay));
}

function readThemeSettings() {
  const shared = window.FrameTheme?.getState?.();
  if (shared?.profile) {
    return {
      mode: shared.mode === "day" ? "day" : "night",
      profileId: shared.profileId || DEFAULT_THEME_PROFILE_ID,
      customProfiles: Array.isArray(shared.customProfiles) ? shared.customProfiles.map(normalizeThemeProfile).filter(Boolean) : [],
    };
  }
  const customProfiles = readCustomThemeProfiles();
  const mode = readStoredTheme();
  let profileId = DEFAULT_THEME_PROFILE_ID;
  try {
    profileId = localStorage.getItem(THEME_PROFILE_ID_KEY) || DEFAULT_THEME_PROFILE_ID;
  } catch {}
  if (!findThemeProfile(profileId, customProfiles)) {
    profileId = DEFAULT_THEME_PROFILE_ID;
  }
  return { mode, profileId, customProfiles };
}

function applyThemeSettings(shouldPersist = true) {
  themeSettings = themeSettings || readThemeSettings();
  const profile = selectedThemeProfile() || builtInThemeProfiles[0];
  const mode = themeSettings.mode === "day" ? "day" : "night";
  document.documentElement.dataset.theme = mode;
  document.body.classList.toggle("theme-day", mode === "day");
  applyThemePalette(profile, mode);
  if (shouldPersist) {
    persistThemeSettings(profile);
  }
  updateThemeLabel();
}

function applyThemePalette(profile, mode) {
  const palette = profile?.palettes?.[mode] || builtInThemeProfiles[0].palettes[mode];
  Object.entries(palette).forEach(([key, value]) => {
    document.documentElement.style.setProperty(`--frame-${kebabCase(key)}`, value);
  });
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", palette.page || "#07111b");
}

function persistThemeSettings(profile = selectedThemeProfile()) {
  try {
    localStorage.setItem(THEME_MODE_KEY, themeSettings.mode);
    localStorage.setItem(THEME_PROFILE_ID_KEY, themeSettings.profileId);
    localStorage.setItem(THEME_CUSTOM_PROFILES_KEY, JSON.stringify(themeSettings.customProfiles));
    if (profile) {
      localStorage.setItem(THEME_PROFILE_KEY, JSON.stringify(profile));
    }
  } catch {}
  window.FrameTheme?.save?.({
    mode: themeSettings.mode,
    profileId: themeSettings.profileId,
    customProfiles: themeSettings.customProfiles,
    profile,
  });
}

function renderThemeControls() {
  if (!elements.themeModeSelect) return;
  const profile = selectedThemeProfile() || builtInThemeProfiles[0];
  elements.themeModeSelect.value = themeSettings.mode;
  elements.themePresetTrigger.setAttribute("aria-expanded", String(!elements.themePresetMenu.hidden));
  elements.themePresetTriggerName.innerHTML = `${escapeHtml(profile.name)}${profile.id === DEFAULT_THEME_PROFILE_ID ? frameStarIcon() : ""}`;
  elements.themePresetTriggerMeta.textContent = profile.themeColor.toUpperCase();
  elements.themePresetTriggerSwatches.innerHTML = themeSwatchesHtml(profile);
  renderThemePresetDropdown();
}

function renderThemePresetDropdown() {
  const profiles = orderedThemeProfiles();
  elements.themePresetMenu.innerHTML = profiles
    .map((profile) => {
      const selected = profile.id === themeSettings.profileId;
      const custom = isCustomThemeProfile(profile);
      return `
        <div class="theme-preset-option-row${selected ? " selected" : ""}" role="option" aria-selected="${selected}">
          <button class="theme-preset-option" type="button" data-theme-preset-option="${escapeAttribute(profile.id)}">
            <span class="theme-swatches">${themeSwatchesHtml(profile)}</span>
            <span class="theme-option-copy">
              <span class="theme-option-title">
                <strong>${escapeHtml(profile.name)}</strong>
                ${profile.id === DEFAULT_THEME_PROFILE_ID ? frameStarIcon() : ""}
              </span>
              <small>${escapeHtml(profile.themeColor.toUpperCase())}</small>
            </span>
          </button>
          ${
            custom
              ? `<button class="theme-preset-delete" type="button" data-delete-theme-preset="${escapeAttribute(profile.id)}" aria-label="Delete ${escapeAttribute(profile.name)}">${trashIcon()}</button>`
              : ""
          }
        </div>`;
    })
    .join("");
}

function selectThemeProfile(profileId) {
  if (!findThemeProfile(profileId)) return;
  themeSettings.profileId = profileId;
  closeThemePresetMenu();
  applyThemeSettings();
  renderThemeControls();
}

function toggleThemePresetMenu() {
  const open = elements.themePresetMenu.hidden;
  elements.themePresetMenu.hidden = !open;
  elements.themePresetTrigger.setAttribute("aria-expanded", String(open));
  if (open) renderThemePresetDropdown();
}

function closeThemePresetMenu() {
  elements.themePresetMenu.hidden = true;
  elements.themePresetTrigger.setAttribute("aria-expanded", "false");
}

function openThemePresetDialog() {
  showThemePresetKindStep();
  if (typeof elements.themePresetDialog.showModal === "function") {
    elements.themePresetDialog.showModal();
  } else {
    elements.themePresetDialog.removeAttribute("hidden");
  }
}

function closeThemePresetDialog() {
  if (elements.themePresetDialog.open) {
    elements.themePresetDialog.close();
  } else {
    elements.themePresetDialog.setAttribute("hidden", "");
  }
}

function showThemePresetKindStep() {
  elements.themePresetKindStep.hidden = false;
  elements.themePresetEditorStep.hidden = true;
}

function showThemePresetEditor(kind) {
  themePresetDraftKind = kind === "full" ? "full" : "color";
  const profile = selectedThemeProfile() || builtInThemeProfiles[0];
  elements.themePresetKindStep.hidden = true;
  elements.themePresetEditorStep.hidden = false;
  elements.themeEditorEyebrow.textContent = "Custom preset";
  elements.themeEditorTitle.textContent = themePresetDraftKind === "full" ? "Fully Custom" : "Color Based Theme";
  elements.themePresetNameInput.value = "";
  elements.themePresetNameInput.setCustomValidity("");
  elements.themePresetDefaultMode.value = themeSettings.mode;
  elements.themeColorInput.value = profile.themeColor;
  elements.themeColorLabel.hidden = false;
  elements.themePaletteFields.hidden = themePresetDraftKind !== "full";
  if (themePresetDraftKind === "full") {
    renderThemePaletteFields(profile.palettes);
  } else {
    elements.themePaletteFields.innerHTML = "";
  }
  elements.themePresetNameInput.focus();
  elements.themePresetNameInput.select();
}

function renderThemePaletteFields(palettes) {
  elements.themePaletteFields.innerHTML = ["day", "night"]
    .map((mode) => {
      const palette = sanitizeThemePalette(palettes?.[mode], buildThemePalette(elements.themeColorInput.value, mode));
      return `
        <section class="theme-palette-group">
          <h3>${mode === "day" ? "Day" : "Night"} colors</h3>
          <div class="theme-color-grid">
            ${themePaletteFields
              .map(
                ([key, label]) => `
                  <label>
                    <span>${escapeHtml(label)}</span>
                    <input type="color" value="${escapeAttribute(palette[key])}" data-theme-palette-input data-theme-mode="${mode}" data-theme-color-key="${escapeAttribute(key)}">
                  </label>`,
              )
              .join("")}
          </div>
        </section>`;
    })
    .join("");
}

function createThemePreset() {
  const name = cleanText(elements.themePresetNameInput.value, 40);
  if (!name) {
    elements.themePresetNameInput.setCustomValidity("Preset name is required.");
    elements.themePresetNameInput.reportValidity();
    elements.themePresetNameInput.focus();
    return;
  }
  elements.themePresetNameInput.setCustomValidity("");
  const defaultMode = elements.themePresetDefaultMode.value === "day" ? "day" : "night";
  const themeColor = normalizeHex(elements.themeColorInput.value) || "#2cb4fb";
  const id = uniqueThemeProfileId(name);
  const profile =
    themePresetDraftKind === "full"
      ? {
          id,
          name,
          themeColor,
          custom: true,
          palettes: collectThemePaletteFields(themeColor),
        }
      : { ...buildThemeProfile(id, name, themeColor), custom: true };

  themeSettings.customProfiles = [profile, ...themeSettings.customProfiles];
  themeSettings.profileId = profile.id;
  themeSettings.mode = defaultMode;
  applyThemeSettings();
  renderThemeControls();
  closeThemePresetDialog();
  showToast(`${profile.name} preset created.`);
}

function collectThemePaletteFields(themeColor) {
  const palettes = buildThemePalettes(themeColor);
  elements.themePaletteFields.querySelectorAll("[data-theme-palette-input]").forEach((input) => {
    const mode = input.dataset.themeMode === "day" ? "day" : "night";
    const key = input.dataset.themeColorKey;
    if (!themePaletteFields.some(([fieldKey]) => fieldKey === key)) return;
    palettes[mode][key] = normalizeHex(input.value) || palettes[mode][key];
  });
  return palettes;
}

async function deleteThemePreset(profileId) {
  const profile = themeSettings.customProfiles.find((item) => item.id === profileId);
  if (!profile) return;
  const confirmed = await showThemeConfirm(
    "Delete preset?",
    `Remove "${profile.name}" from your custom theme presets? The interface will return to Frame Blue.`,
  );
  if (!confirmed) return;
  themeSettings.customProfiles = themeSettings.customProfiles.filter((item) => item.id !== profileId);
  themeSettings.profileId = DEFAULT_THEME_PROFILE_ID;
  closeThemePresetMenu();
  applyThemeSettings();
  renderThemeControls();
  showToast(`${profile.name} preset removed.`);
}

function showThemeConfirm(title, copy) {
  elements.themeConfirmTitle.textContent = title;
  elements.themeConfirmCopy.textContent = copy;
  if (typeof elements.themeConfirmDialog.showModal === "function") {
    elements.themeConfirmDialog.showModal();
  } else {
    elements.themeConfirmDialog.removeAttribute("hidden");
  }
  return new Promise((resolve) => {
    themeConfirmResolve = resolve;
  });
}

function resolveThemeConfirm(value) {
  if (themeConfirmResolve) {
    themeConfirmResolve(value);
    themeConfirmResolve = null;
  }
  if (elements.themeConfirmDialog.open) {
    elements.themeConfirmDialog.close();
  } else {
    elements.themeConfirmDialog.setAttribute("hidden", "");
  }
}

function selectedThemeProfile() {
  return findThemeProfile(themeSettings?.profileId, themeSettings?.customProfiles);
}

function findThemeProfile(profileId, customProfiles = themeSettings?.customProfiles) {
  return allThemeProfiles(customProfiles).find((profile) => profile.id === profileId) || null;
}

function orderedThemeProfiles() {
  return [...themeSettings.customProfiles, ...builtInThemeProfiles];
}

function allThemeProfiles(customProfiles = readCustomThemeProfiles()) {
  return [...customProfiles, ...builtInThemeProfiles];
}

function isCustomThemeProfile(profile) {
  return !builtInThemeProfiles.some((builtIn) => builtIn.id === profile.id);
}

function readCustomThemeProfiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(THEME_CUSTOM_PROFILES_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeThemeProfile).filter(Boolean);
  } catch {
    return [];
  }
}

function normalizeThemeProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const name = cleanText(profile.name, 40);
  const themeColor = normalizeHex(profile.themeColor) || "#2cb4fb";
  const id = cleanText(profile.id, 64) || `custom-${slugify(name || "theme")}`;
  const base = buildThemeProfile(id, name || "Custom Theme", themeColor);
  return {
    id,
    name: name || "Custom Theme",
    themeColor,
    custom: profile.custom !== false,
    palettes: {
      day: sanitizeThemePalette(profile.palettes?.day, base.palettes.day),
      night: sanitizeThemePalette(profile.palettes?.night, base.palettes.night),
    },
  };
}

function sanitizeThemePalette(palette, fallback) {
  const result = { ...fallback };
  themePaletteFields.forEach(([key]) => {
    result[key] = normalizeHex(palette?.[key]) || fallback[key];
  });
  return result;
}

function uniqueThemeProfileId(name) {
  const base = `custom-${slugify(name) || "theme"}`;
  const ids = new Set(allThemeProfiles(themeSettings?.customProfiles).map((profile) => profile.id));
  let id = base;
  let index = 2;
  while (ids.has(id)) {
    id = `${base}-${index}`;
    index += 1;
  }
  return id;
}

function themeSwatchesHtml(profile) {
  const palette = profile.palettes?.[themeSettings?.mode || "night"] || profile.palettes?.night || builtInThemeProfiles[0].palettes.night;
  return [profile.themeColor, palette.accentSoft, palette.panelStrong, palette.text]
    .map((color) => `<span style="background:${escapeAttribute(color)}"></span>`)
    .join("");
}

function readStoredTheme() {
  try {
    const theme = localStorage.getItem(THEME_MODE_KEY) || localStorage.getItem(LEGACY_PORTAL_THEME_KEY);
    if (theme === "day" || theme === "night") {
      localStorage.setItem(THEME_MODE_KEY, theme);
      return theme;
    }
  } catch {}
  return "night";
}

function writeStoredTheme(theme) {
  try {
    localStorage.setItem(THEME_MODE_KEY, theme);
  } catch {}
}

function buildThemeProfile(id, name, themeColor) {
  const normalized = normalizeHex(themeColor) || "#2cb4fb";
  return {
    id,
    name,
    themeColor: normalized,
    custom: false,
    palettes: buildThemePalettes(normalized),
  };
}

function buildThemePalettes(themeColor) {
  return {
    day: buildThemePalette(themeColor, "day"),
    night: buildThemePalette(themeColor, "night"),
  };
}

function buildThemePalette(themeColor, mode) {
  const base = hexToHsl(themeColor) || { h: 202, s: 97, l: 58 };
  const vivid = clamp(base.s + 16, 46, 88);
  const muted = clamp(base.s - 8, 22, 64);
  if (mode === "day") {
    return {
      page: hslToHex(base.h, muted, 97),
      panel: "#ffffff",
      panelStrong: hslToHex(base.h, muted, 92),
      panelMuted: hslToHex(base.h, muted, 98),
      border: hslToHex(base.h, 24, 76),
      borderSoft: hslToHex(base.h, 32, 66),
      label: hslToHex(base.h, 16, 38),
      text: hslToHex(base.h, 32, 13),
      accent: hslToHex(base.h, vivid, 38),
      accentStrong: hslToHex(base.h, vivid, 35),
      accentSoft: hslToHex(base.h, 72, 92),
      accentBorder: hslToHex(base.h, vivid, 58),
      accentContrast: hslToHex(base.h, 65, 20),
      danger: hslToHex(350, 70, 40),
      warning: hslToHex(42, 74, 35),
      good: hslToHex(145, 46, 34),
      toggleNightBg: "#dff4ff",
      toggleNightText: "#087fc0",
      toggleDayBg: "#fff6d5",
      toggleDayText: "#8a5e00",
    };
  }
  return {
    page: hslToHex(base.h, 36, 8),
    panel: hslToHex(base.h, 34, 13),
    panelStrong: hslToHex(base.h, 32, 18),
    panelMuted: hslToHex(base.h, 34, 11),
    border: hslToHex(base.h, 30, 28),
    borderSoft: hslToHex(base.h, 30, 34),
    label: hslToHex(base.h, 19, 72),
    text: hslToHex(base.h, 28, 94),
    accent: hslToHex(base.h, vivid, 62),
    accentStrong: hslToHex(base.h, vivid, 72),
    accentSoft: hslToHex(base.h, 74, 16),
    accentBorder: hslToHex(base.h, vivid, 45),
    accentContrast: hslToHex(base.h, 70, 91),
    danger: hslToHex(350, 78, 70),
    warning: hslToHex(42, 92, 72),
    good: hslToHex(145, 60, 70),
    toggleNightBg: "#dff4ff",
    toggleNightText: "#087fc0",
    toggleDayBg: "#fff6d5",
    toggleDayText: "#8a5e00",
  };
}

function cleanText(value, maxLength = 80) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function slugify(value) {
  return cleanText(value, 48)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function kebabCase(value) {
  return String(value).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function normalizeHex(value) {
  const match = String(value || "").trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!match) return null;
  const hex = match[1].length === 3 ? match[1].replace(/./g, (char) => char + char) : match[1];
  return `#${hex.toLowerCase()}`;
}

function hexToHsl(hex) {
  const normalized = normalizeHex(hex);
  if (!normalized) return null;
  const red = parseInt(normalized.slice(1, 3), 16) / 255;
  const green = parseInt(normalized.slice(3, 5), 16) / 255;
  const blue = parseInt(normalized.slice(5, 7), 16) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  let hue = 0;
  let saturation = 0;
  const lightness = (max + min) / 2;
  if (max !== min) {
    const delta = max - min;
    saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    if (max === red) hue = (green - blue) / delta + (green < blue ? 6 : 0);
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue /= 6;
  }
  return {
    h: Math.round(hue * 360),
    s: Math.round(saturation * 100),
    l: Math.round(lightness * 100),
  };
}

function hslToHex(hue, saturation, lightness) {
  const h = (((Number(hue) || 0) % 360) + 360) % 360 / 360;
  const s = clamp(saturation, 0, 100) / 100;
  const l = clamp(lightness, 0, 100) / 100;
  if (s === 0) {
    return rgbToHex(l, l, l);
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return rgbToHex(hueToRgb(p, q, h + 1 / 3), hueToRgb(p, q, h), hueToRgb(p, q, h - 1 / 3));
}

function hueToRgb(p, q, t) {
  let value = t;
  if (value < 0) value += 1;
  if (value > 1) value -= 1;
  if (value < 1 / 6) return p + (q - p) * 6 * value;
  if (value < 1 / 2) return q;
  if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
  return p;
}

function rgbToHex(red, green, blue) {
  return `#${[red, green, blue]
    .map((channel) => Math.round(clamp(channel, 0, 1) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function frameStarIcon() {
  return '<svg class="theme-star" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2 7.5 14 3 9.6l6.2-.9L12 3Z"/></svg>';
}

function trashIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6"/></svg>';
}

function openIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
}

function copyIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>';
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // LAN-only HTTP pages may not have access to the Clipboard API.
    }
  }

  const previousFocus = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  const container = elements.toolLinksDialog.open ? elements.toolLinksDialog : document.body;
  container.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    if (!document.execCommand("copy")) throw new Error("Copy failed");
  } finally {
    textarea.remove();
    if (typeof previousFocus?.focus === "function") previousFocus.focus();
  }
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    ...options,
  });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : {};
  if (!response.ok) {
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  if (!isJson) throw new Error("Sign in required.");
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
