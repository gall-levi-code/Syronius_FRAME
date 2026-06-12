const state = { streams: [], config: null };
const list = document.querySelector("#stream-list");
const notice = document.querySelector("#notice");
const receiverStatus = document.querySelector("#receiver-status");
const streamDialog = document.querySelector("#stream-dialog");
const linksDialog = document.querySelector("#links-dialog");

document.querySelector("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "day" ? "night" : "day";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("frame-theme", next);
});
document.documentElement.dataset.theme = localStorage.getItem("frame-theme") || "night";
document.querySelector("#refresh-button").addEventListener("click", load);
document.querySelector("#add-button").addEventListener("click", openAddDialog);
document.querySelector("#regenerate-button").addEventListener("click", generateIds);
document.querySelector("#custom-toggle").addEventListener("change", updateSourceFields);
document.querySelectorAll(".close-dialog").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});
document.querySelector("#stream-form").addEventListener("submit", saveStream);

async function load() {
  clearNotice();
  try {
    const [config, result] = await Promise.all([api("/slsui/api/config"), api("/slsui/api/streams")]);
    state.config = config;
    state.streams = result.streams;
    receiverStatus.textContent = "Telemetry ready";
    receiverStatus.className = "status-pill good";
    render();
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
        <button data-overlay="${escapeAttr(stream.id)}" class="secondary">Create overlay</button>
        <button data-manage-overlays class="secondary">Manage overlays</button>
        <button data-stats="${escapeAttr(stream.id)}" class="secondary">Open statistics</button>
        <button data-delete="${escapeAttr(stream.id)}" class="danger">Delete</button>
      </div>
    </article>`;
  }).join("");
  list.querySelectorAll("[data-links]").forEach((button) => button.addEventListener("click", () => openLinks(button.dataset.links)));
  list.querySelectorAll("[data-overlay]").forEach((button) => button.addEventListener("click", () => openOverlay(button.dataset.overlay)));
  list.querySelectorAll("[data-manage-overlays]").forEach((button) => button.addEventListener("click", openOverlayManager));
  list.querySelectorAll("[data-stats]").forEach((button) => button.addEventListener("click", () => openStats(button.dataset.stats)));
  list.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => removeStream(button.dataset.delete)));
}

function stat(label, value) {
  return `<div class="stat"><span>${label}</span><strong>${escapeHtml(String(value))}</strong></div>`;
}

function openAddDialog() {
  document.querySelector("#dialog-title").textContent = "Add stream";
  document.querySelector("#description-input").value = "";
  document.querySelector("#custom-toggle").checked = false;
  document.querySelector("#stats-url-input").value = "";
  generateIds();
  updateSourceFields();
  streamDialog.showModal();
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

async function removeStream(id) {
  const stream = state.streams.find((item) => item.id === id);
  const name = stream?.description || id;
  const impact = stream?.source_type === "custom"
    ? "The BELABOX relay itself will not be changed."
    : "Relay links will stop working.";
  if (!confirm(`Delete ${name}? ${impact} Related overlay presets will be unbound.`)) return;
  try {
    const result = await api(`/slsui/api/streams/${encodeURIComponent(id)}`, { method: "DELETE" });
    await load();
    const count = Array.isArray(result.unbound_overlays) ? result.unbound_overlays.length : 0;
    const cleanup = count ? ` ${count} overlay preset${count === 1 ? " was" : "s were"} unbound.` : "";
    showNotice(`Stream deleted.${cleanup}${result.overlay_cleanup_warning ? ` ${result.overlay_cleanup_warning}` : ""}`, result.overlay_cleanup_warning ? "error" : "ok");
  } catch (error) {
    showNotice(error.message);
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
    ["FRAME statistics", `${window.location.origin}/slsui/api/stats/${stream.id}`],
  ];
  document.querySelector("#links-list").innerHTML = links.map(([label, url]) => `
    <div class="link-row"><label>${label}<input readonly value="${escapeAttr(url)}"></label>
    <button data-copy="${escapeAttr(url)}">Copy</button></div>`).join("");
  document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1200);
  }));
  linksDialog.showModal();
}

function openOverlay(id) {
  const url = new URL(state.config.overlay_wizard_url, window.location.href);
  url.searchParams.set("stream", id);
  window.location.href = url.toString();
}

function openOverlayManager() {
  window.location.href = new URL(state.config.overlay_wizard_url, window.location.href).toString();
}

function openStats(id) {
  window.open(`/slsui/api/stats/${encodeURIComponent(id)}`, "_blank", "noopener");
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
function formatBitrate(value) { return value >= 1000 ? `${(value / 1000).toFixed(2)} Mbps` : `${value} kbps`; }
function formatMilliseconds(value) { return Number.isFinite(value) ? `${Number(value).toFixed(1)} ms` : "--"; }
function formatDuration(value) { const h = Math.floor(value / 3600); const m = Math.floor((value % 3600) / 60); return `${h}h ${m}m`; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function escapeAttr(value) { return escapeHtml(value).replaceAll('"', "&quot;"); }

load();
setInterval(load, 5000);
