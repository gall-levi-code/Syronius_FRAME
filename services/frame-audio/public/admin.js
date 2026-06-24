const state = { streams: [], editingId: null };
const list = document.querySelector("#stream-list");
const notice = document.querySelector("#notice");
const dialog = document.querySelector("#stream-dialog");
const themeToggle = document.querySelector("#theme-toggle");

setThemeMode(readStoredTheme(), false);
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
document.querySelector("#add-button").addEventListener("click", openAdd);
document.querySelector("#close-dialog").addEventListener("click", () => dialog.close());
document.querySelector("#regenerate-button").addEventListener("click", generateId);
document.querySelector("#stream-form").addEventListener("submit", save);

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
  try {
    const result = await api("/audio/api/streams");
    state.streams = result.streams;
    document.querySelector("#service-status").textContent = "Relay ready";
    document.querySelector("#service-status").className = "status-pill good";
    render();
  } catch (error) {
    document.querySelector("#service-status").textContent = "Relay unavailable";
    document.querySelector("#service-status").className = "status-pill bad";
    showNotice(error.message);
  }
}

function render() {
  if (!state.streams.length) {
    list.innerHTML = '<div class="empty">No audio sources yet. Add one to create capture and remote listening links.</div>';
    return;
  }
  list.innerHTML = state.streams.map((stream) => `<article class="stream-card">
    <div class="card-head"><div class="stream-title"><h2>${escapeHtml(stream.name)}</h2><p>${escapeHtml(stream.streamId)}</p></div><div class="quality ${stream.mode}">${modeLabel(stream.mode)}</div></div>
    <div class="stats">
      ${stat("Publisher", stream.publisherActive ? "Connected" : "Offline")}
      ${stat("Relay", modeLabel(stream.mode))}
      ${stat("Target", stream.activeBitrateKbps === stream.bitrateKbps ? `${stream.bitrateKbps} kbps` : `${stream.bitrateKbps} next / ${stream.activeBitrateKbps} active`)}
      ${stat("Input", stream.publisherActive ? `${stream.inputKbps} kbps` : "--")}
      ${stat("Listeners", `${stream.listenerCount} / ${stream.listenerLimit}`)}
      ${stat("Generation", stream.generation)}
    </div>
    <div class="card-actions">
      <button data-capture="${escapeAttr(stream.captureUrl)}">Open capture</button>
      <button data-listen="${escapeAttr(stream.listenUrl)}" class="secondary">Open listener</button>
      <button data-copy="${escapeAttr(stream.listenUrl)}" class="secondary">Copy listen URL</button>
      <button data-edit="${escapeAttr(stream.streamId)}" class="secondary">Edit</button>
      <button data-delete="${escapeAttr(stream.streamId)}" class="danger">Delete</button>
    </div>
  </article>`).join("");
  list.querySelectorAll("[data-capture]").forEach((button) => button.addEventListener("click", () => window.open(button.dataset.capture, "_blank", "noopener")));
  list.querySelectorAll("[data-listen]").forEach((button) => button.addEventListener("click", () => window.open(button.dataset.listen, "_blank", "noopener")));
  list.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(button.dataset.copy);
    showNotice("Listen URL copied.", "ok");
  }));
  list.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => openEdit(button.dataset.edit)));
  list.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => remove(button.dataset.delete)));
}

function openAdd() {
  state.editingId = null;
  document.querySelector("#dialog-title").textContent = "Add audio source";
  document.querySelector("#name-input").value = "";
  document.querySelector("#bitrate-input").value = "192";
  document.querySelector("#listener-limit-input").value = "10";
  document.querySelector("#always-on-input").checked = true;
  document.querySelector("#stream-id-input").disabled = false;
  generateId();
  dialog.showModal();
}

function openEdit(streamId) {
  const stream = state.streams.find((candidate) => candidate.streamId === streamId);
  state.editingId = streamId;
  document.querySelector("#dialog-title").textContent = "Edit audio source";
  document.querySelector("#name-input").value = stream.name;
  document.querySelector("#stream-id-input").value = stream.streamId;
  document.querySelector("#stream-id-input").disabled = true;
  document.querySelector("#bitrate-input").value = String(stream.bitrateKbps);
  document.querySelector("#listener-limit-input").value = String(stream.listenerLimit);
  document.querySelector("#always-on-input").checked = stream.alwaysOn;
  dialog.showModal();
}

function generateId() {
  const bytes = new Uint8Array(12);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
    document.querySelector("#stream-id-input").value = `audio-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    return;
  }
  document.querySelector("#stream-id-input").value = `audio-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

async function save(event) {
  event.preventDefault();
  try {
    const body = {
      streamId: state.editingId || document.querySelector("#stream-id-input").value,
      name: document.querySelector("#name-input").value,
      bitrateKbps: Number(document.querySelector("#bitrate-input").value),
      listenerLimit: Number(document.querySelector("#listener-limit-input").value),
      alwaysOn: document.querySelector("#always-on-input").checked,
    };
    await api(state.editingId ? `/audio/api/streams/${encodeURIComponent(state.editingId)}` : "/audio/api/streams", {
      method: state.editingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    dialog.close();
    showNotice("Audio source saved.", "ok");
    await load();
  } catch (error) {
    showNotice(error.message);
  }
}

async function remove(streamId) {
  const stream = state.streams.find((candidate) => candidate.streamId === streamId);
  if (!confirm(`Delete ${stream.name}? Its capture, listen, and HLS URLs will stop working.`)) return;
  try {
    await api(`/audio/api/streams/${encodeURIComponent(streamId)}`, { method: "DELETE" });
    clearLocalCaptureSettings(streamId);
    showNotice("Audio source deleted.", "ok");
    await load();
  } catch (error) {
    showNotice(error.message);
  }
}

function clearLocalCaptureSettings(streamId) {
  const prefix = `frame-audio-capture:${streamId}`;
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) localStorage.removeItem(key);
  }
}

function stat(label, value) { return `<div class="stat"><span>${label}</span><strong>${escapeHtml(String(value))}</strong></div>`; }
function modeLabel(mode) { return mode === "publisher" ? "Live capture" : mode === "silence" ? "Always-on silence" : "Offline"; }
function showNotice(message, kind = "error") { notice.textContent = message; notice.className = `notice ${kind === "ok" ? "ok" : ""}`; }
async function api(url, init) { const response = await fetch(url, init); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`); return body; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function escapeAttr(value) { return escapeHtml(value).replaceAll('"', "&quot;"); }

load();
setInterval(() => { if (!dialog.open) void load(); }, 5_000);
