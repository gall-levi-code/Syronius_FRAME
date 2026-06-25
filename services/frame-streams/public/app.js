const state = { streams: [], config: null, pendingDeleteStreamId: null };
const list = document.querySelector("#stream-list");
const notice = document.querySelector("#notice");
const receiverStatus = document.querySelector("#receiver-status");
const streamDialog = document.querySelector("#stream-dialog");
const linksDialog = document.querySelector("#links-dialog");
const statsOutputDialog = document.querySelector("#stats-output-dialog");
const boundOverlaysDialog = document.querySelector("#bound-overlays-dialog");
const deleteStreamDialog = document.querySelector("#delete-stream-dialog");
const themeToggle = document.querySelector("#theme-toggle");

themeToggle.addEventListener("click", () => {
  setThemeMode(document.documentElement.dataset.theme === "day" ? "night" : "day", true);
});
window.addEventListener("storage", (event) => {
  if (event.key === "frame-theme-profile") {
    setThemeMode(readStoredTheme(), false);
    return;
  }
  if (event.key === "frame-theme" && (event.newValue === "day" || event.newValue === "night")) {
    setThemeMode(event.newValue, false);
  }
});
setThemeMode(readStoredTheme(), false);
document.querySelector("#add-button").addEventListener("click", openAddDialog);
document.querySelector("#manage-overlays-button").addEventListener("click", openOverlayManager);
document.querySelector("#regenerate-button").addEventListener("click", generateIds);
document.querySelector("#custom-toggle").addEventListener("change", updateSourceFields);
document.querySelectorAll(".close-dialog").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
document.querySelector("#stream-form").addEventListener("submit", saveStream);
document.querySelector("#confirm-delete-stream").addEventListener("click", confirmDeleteStream);
streamDialog.addEventListener("close", clearAddStreamHash);
deleteStreamDialog.addEventListener("close", () => { state.pendingDeleteStreamId = null; });
window.addEventListener("hashchange", openDialogForHash);

function setThemeMode(nextMode, persist) {
  const mode = nextMode === "day" ? "day" : "night";
  document.documentElement.dataset.theme = mode;
  window.FrameTheme?.apply(mode);
  const nextLabel = mode === "day" ? "Switch to night mode" : "Switch to day mode";
  themeToggle.setAttribute("aria-label", nextLabel);
  themeToggle.title = nextLabel;
  themeToggle.setAttribute("aria-pressed", String(mode === "day"));
  if (persist) {
    try {
      localStorage.setItem("frame-theme", mode);
    } catch {}
  }
}

function readStoredTheme() {
  try {
    const stored = localStorage.getItem("frame-theme");
    if (stored === "day" || stored === "night") return stored;
  } catch {}
  return "night";
}

async function load() {
  clearNotice();
  try {
    const [config, result] = await Promise.all([api("/slsui/api/config"), api("/slsui/api/streams")]);
    state.config = config;
    state.streams = result.streams;
    receiverStatus.textContent = "Telemetry ready";
    receiverStatus.className = "status-pill good";
    render();
    openDialogForHash();
  } catch (error) {
    receiverStatus.textContent = "Telemetry unavailable";
    receiverStatus.className = "status-pill bad";
    showNotice(error.message);
  }
}

function render() {
  if (!state.streams.length) {
    list.innerHTML = '<div class="empty">No stream profiles yet. Add a FRAME relay stream or connect custom telemetry.</div>';
    return;
  }
  list.innerHTML = state.streams.map((stream) => {
    const stats = stream.stats;
    const online = stats && stats.connected !== false;
    const visibleStats = online ? stats : null;
    return `<article class="stream-card">
      <div class="card-head">
        <div class="stream-title">
          <h2>${escapeHtml(stream.description || stream.player)}</h2>
          <span class="source-badge">${escapeHtml(stream.source_label || "FRAME SRTLA")}</span>
          ${stream.source_type === "sls" ? `<p>${escapeHtml(stream.publisher)} / ${escapeHtml(stream.player)}</p>` : ""}
        </div>
        <div class="quality ${online ? "online" : ""}">${online ? "Live" : "Offline"}</div>
      </div>
      <div class="stats">
        ${stat("Bitrate", visibleStats ? formatBitrate(visibleStats.bitrate) : "--")}
        ${stat("RTT", formatMilliseconds(visibleStats?.rtt))}
        ${stat("Latency", formatMilliseconds(visibleStats?.latency))}
        ${stat("Buffer", formatMilliseconds(visibleStats?.buffer))}
        ${stat("Dropped", visibleStats ? visibleStats.dropped_pkts : "--")}
        ${stat("Uptime", visibleStats ? formatDuration(visibleStats.uptime) : "--")}
      </div>
      <div class="card-actions">
        ${stream.source_type === "sls" ? `<button data-links="${escapeAttr(stream.id)}" class="secondary">Links</button>` : ""}
        <button data-bound-overlays="${escapeAttr(stream.id)}" class="secondary">Bound overlays <span class="action-count">${stream.bound_overlays?.length ?? 0}</span></button>
        <button data-stats="${escapeAttr(stream.id)}" class="secondary">Stats outputs</button>
        <button data-delete="${escapeAttr(stream.id)}" class="danger">Delete</button>
      </div>
    </article>`;
  }).join("");
  list.querySelectorAll("[data-links]").forEach((button) => button.addEventListener("click", () => openLinks(button.dataset.links)));
  list.querySelectorAll("[data-bound-overlays]").forEach((button) => button.addEventListener("click", () => openBoundOverlays(button.dataset.boundOverlays)));
  list.querySelectorAll("[data-stats]").forEach((button) => button.addEventListener("click", () => openStatsOutputs(button.dataset.stats)));
  list.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => removeStream(button.dataset.delete)));
}

function stat(label, value) {
  return `<div class="stat"><span>${label}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function openAddDialog() {
  if (streamDialog.open) return;
  document.querySelector("#dialog-title").textContent = "Add stream";
  document.querySelector("#description-input").value = "";
  document.querySelector("#custom-toggle").checked = false;
  document.querySelector("#stats-url-input").value = "";
  generateIds();
  updateSourceFields();
  streamDialog.showModal();
}

function openDialogForHash() {
  if (window.location.hash.toLowerCase() === "#add-stream") openAddDialog();
}

function clearAddStreamHash() {
  if (window.location.hash.toLowerCase() !== "#add-stream") return;
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

function generateIds() {
  const id = crypto.randomUUID().replaceAll("-", "");
  document.querySelector("#publisher-input").value = `live_${id}`;
  document.querySelector("#player-input").value = `play_${crypto.randomUUID().replaceAll("-", "")}`;
}

function updateSourceFields() {
  const custom = document.querySelector("#custom-toggle").checked;
  document.querySelector("#frame-source-fields").classList.toggle("hidden", custom);
  document.querySelector("#custom-source-fields").classList.toggle("hidden", !custom);
  document.querySelector("#publisher-input").required = !custom;
  document.querySelector("#player-input").required = !custom;
  document.querySelector("#stats-url-input").required = custom;
  document.querySelector("#regenerate-button").hidden = custom;
}

async function saveStream(event) {
  event.preventDefault();
  try {
    const custom = document.querySelector("#custom-toggle").checked;
    await api("/slsui/api/streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(custom ? {
        source_type: "custom",
        stats_url: document.querySelector("#stats-url-input").value,
        description: document.querySelector("#description-input").value,
      } : {
        source_type: "sls",
        publisher: document.querySelector("#publisher-input").value,
        player: document.querySelector("#player-input").value,
        description: document.querySelector("#description-input").value,
      }),
    });
    streamDialog.close();
    await load();
    showNotice(custom ? "BELABOX telemetry connected." : "FRAME relay stream created.", "ok");
  } catch (error) {
    showNotice(error.message);
  }
}

function removeStream(id) {
  const stream = state.streams.find((item) => item.id === id);
  if (!stream) {
    showNotice("Stream not found.");
    return;
  }
  const name = stream?.description || id;
  const impact = stream?.source_type === "custom"
    ? "The BELABOX relay itself will not be changed."
    : "Relay links will stop working.";
  const overlays = stream.bound_overlays ?? [];
  state.pendingDeleteStreamId = id;
  document.querySelector("#delete-stream-title").textContent = `Delete ${name}?`;
  document.querySelector("#delete-stream-copy").textContent = overlays.length
    ? `${impact} ${overlays.length} overlay source${overlays.length === 1 ? "" : "s"} will be unbound but kept.`
    : `${impact} No overlay sources are bound to this stream.`;
  document.querySelector("#delete-stream-overlays").innerHTML = boundOverlaysMarkup(overlays, "No overlay sources are bound to this stream.");
  document.querySelector("#confirm-delete-stream").textContent = overlays.length ? "Delete stream and unbind overlays" : "Delete stream";
  deleteStreamDialog.showModal();
}

async function confirmDeleteStream() {
  const id = state.pendingDeleteStreamId;
  if (!id) return;
  const button = document.querySelector("#confirm-delete-stream");
  button.disabled = true;
  try {
    const result = await api(`/slsui/api/streams/${encodeURIComponent(id)}`, { method: "DELETE" });
    deleteStreamDialog.close();
    await load();
    const count = Array.isArray(result.unbound_overlays) ? result.unbound_overlays.length : 0;
    const cleanup = count ? ` ${count} overlay source${count === 1 ? " was" : "s were"} unbound.` : "";
    showNotice(`Stream deleted.${cleanup}${result.overlay_cleanup_warning ? ` ${result.overlay_cleanup_warning}` : ""}`, result.overlay_cleanup_warning ? "error" : "ok");
  } catch (error) {
    showNotice(error.message);
  } finally {
    button.disabled = false;
  }
}

function openLinks(id) {
  const stream = state.streams.find((item) => item.id === id);
  const host = state.config.relay_host;
  const ports = state.config.ports;
  const links = [
    ["SRTLA publisher", `srtla://${host}:${ports.srtla}?streamid=${stream.publisher}`],
    ["Direct SRT publisher", `srt://${host}:${ports.sender}?streamid=${stream.publisher}`],
    ["SRT player", `srt://${host}:${ports.player}?streamid=${stream.player}`],
    ["FRAME statistics", statsUrl(stream.id)],
    ["BBox Receiver statistics", statsUrl(stream.id, "bbox_receiver")],
  ];
  document.querySelector("#links-list").innerHTML = links.map(([label, url]) => `
    <div class="link-row"><label>${label}<input readonly value="${escapeAttr(url)}"></label>
    <button data-copy="${escapeAttr(url)}">Copy</button></div>`).join("");
  document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => copyWithConfirmation(button)));
  linksDialog.showModal();
}

function openOverlayManager() {
  window.location.href = new URL(state.config.overlay_wizard_url, window.location.href).toString();
}

function openBoundOverlays(id) {
  const stream = state.streams.find((item) => item.id === id);
  const overlays = stream?.bound_overlays ?? [];
  document.querySelector("#bound-overlays-title").textContent = `Bound overlays · ${stream?.description || id}`;
  document.querySelector("#bound-overlays-list").innerHTML = boundOverlaysMarkup(overlays, "No overlay sources are bound to this stream.");
  boundOverlaysDialog.showModal();
}

function boundOverlaysMarkup(overlays, emptyText) {
  return overlays.length
    ? overlays.map((overlay) => `<article class="bound-overlay-row">
        <div><strong>${escapeHtml(overlay.display_name)}</strong><span>${escapeHtml(overlay.preset_name)} · ${escapeHtml(overlay.slug)}</span></div>
        <span class="binding-status ${overlay.enabled ? "enabled" : ""}">${overlay.enabled ? "Enabled" : "Disabled"}</span>
      </article>`).join("")
    : `<div class="empty compact">${escapeHtml(emptyText)}</div>`;
}

function openStatsOutputs(id) {
  const stream = state.streams.find((item) => item.id === id);
  document.querySelector("#stats-output-title").textContent = `Stats outputs · ${stream?.description || id}`;
  const outputs = Array.isArray(state.config.stats_outputs) && state.config.stats_outputs.length
    ? state.config.stats_outputs
    : [{ id: "frame", label: "FRAME native", description: "Normalized FRAME telemetry JSON.", query: "" }];
  document.querySelector("#stats-output-list").innerHTML = outputs.map((output) => {
    const url = statsUrl(id, output.id === "frame" ? "" : output.id);
    return `<div class="link-row output-row">
      <label>${escapeHtml(output.label)}
        <small>${escapeHtml(output.description || "Public read-only stats output.")}</small>
        <input readonly value="${escapeAttr(url)}">
      </label>
      <div class="output-actions">
        <button data-open="${escapeAttr(url)}" class="secondary">Open</button>
        <button data-copy="${escapeAttr(url)}">Copy</button>
      </div>
    </div>`;
  }).join("");
  document.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", () => window.open(button.dataset.open, "_blank", "noopener")));
  document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => copyWithConfirmation(button)));
  statsOutputDialog.showModal();
}

function statsUrl(id, output = "") {
  const base = `${state.config.stats_base_url}/${encodeURIComponent(id)}`;
  return output ? `${base}?output=${encodeURIComponent(output)}` : base;
}

async function api(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
  return body;
}

function showNotice(message, kind = "error") {
  notice.textContent = message;
  notice.className = `notice notice-${kind}`;
}
function clearNotice() { notice.className = "notice hidden"; }
async function copyWithConfirmation(button) {
  await navigator.clipboard.writeText(button.dataset.copy);
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = "Copy"; }, 1200);
}
function formatBitrate(value) { return value >= 1000 ? `${(value / 1000).toFixed(2)} Mbps` : `${value} kbps`; }
function formatMilliseconds(value) { return Number.isFinite(value) ? `${Number(value).toFixed(1)} ms` : "--"; }
function formatDuration(value) { const h = Math.floor(value / 3600); const m = Math.floor((value % 3600) / 60); return `${h}h ${m}m`; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function escapeAttr(value) { return escapeHtml(value).replaceAll('"', "&quot;"); }

load();
setInterval(load, 5000);
