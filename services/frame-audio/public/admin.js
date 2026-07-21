const state = { streams: [], editingId: null };
const list = document.querySelector("#stream-list");
const notice = document.querySelector("#notice");
const dialog = document.querySelector("#stream-dialog");
const dialogNotice = document.querySelector("#dialog-notice");
const streamForm = document.querySelector("#stream-form");
const streamIdInput = document.querySelector("#stream-id-input");
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
streamForm.addEventListener("submit", save);
streamIdInput.addEventListener("input", () => {
  const cursor = streamIdInput.selectionStart;
  const sanitized = sanitizeStreamId(streamIdInput.value);
  const delta = streamIdInput.value.length - sanitized.length;
  streamIdInput.value = sanitized;
  if (cursor !== null) streamIdInput.setSelectionRange(Math.max(0, cursor - delta), Math.max(0, cursor - delta));
  validateStreamIdInput();
});

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
    window.FrameTheme?.saveMode?.(mode);
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
      <a class="link-action capture-action" href="${escapeAttr(stream.captureUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open capture for ${escapeAttr(stream.name)} in a new tab" title="Open capture">${microphoneIcon()}</a>
      <a class="link-action" href="${escapeAttr(stream.listenUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Open listener for ${escapeAttr(stream.name)} in a new tab" title="Open listener">${headphonesIcon()}</a>
      <button class="link-action" type="button" data-copy="${escapeAttr(stream.listenUrl)}" aria-label="Copy listen URL for ${escapeAttr(stream.name)}" title="Copy listen URL for ${escapeAttr(stream.name)}">${copyIcon()}</button>
      <button class="link-action edit-action" type="button" data-edit="${escapeAttr(stream.streamId)}" aria-label="Edit ${escapeAttr(stream.name)}" title="Edit">${pencilIcon()}</button>
      <button class="link-action danger-action" type="button" data-delete="${escapeAttr(stream.streamId)}" aria-label="Delete ${escapeAttr(stream.name)}" title="Delete">${trashIcon()}</button>
    </div>
  </article>`).join("");
  list.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(button.dataset.copy);
    showNotice("Listen URL copied.", "ok");
  }));
  list.querySelectorAll("[data-edit]").forEach((button) => button.addEventListener("click", () => openEdit(button.dataset.edit)));
  list.querySelectorAll("[data-delete]").forEach((button) => button.addEventListener("click", () => remove(button.dataset.delete)));
}

function openAdd() {
  state.editingId = null;
  hideDialogNotice();
  document.querySelector("#dialog-title").textContent = "Add audio source";
  document.querySelector("#name-input").value = "";
  document.querySelector("#bitrate-input").value = "192";
  document.querySelector("#listener-limit-input").value = "10";
  document.querySelector("#always-on-input").checked = true;
  streamIdInput.disabled = false;
  generateId();
  validateStreamIdInput();
  dialog.showModal();
}

function openEdit(streamId) {
  const stream = state.streams.find((candidate) => candidate.streamId === streamId);
  state.editingId = streamId;
  hideDialogNotice();
  document.querySelector("#dialog-title").textContent = "Edit audio source";
  document.querySelector("#name-input").value = stream.name;
  streamIdInput.value = stream.streamId;
  streamIdInput.disabled = true;
  document.querySelector("#bitrate-input").value = String(stream.bitrateKbps);
  document.querySelector("#listener-limit-input").value = String(Math.min(10, Math.max(1, Number(stream.listenerLimit) || 10)));
  document.querySelector("#always-on-input").checked = stream.alwaysOn;
  dialog.showModal();
}

function generateId() {
  const bytes = new Uint8Array(12);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
    streamIdInput.value = `audio-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    validateStreamIdInput();
    return;
  }
  streamIdInput.value = `audio-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  validateStreamIdInput();
}

async function save(event) {
  event.preventDefault();
  try {
    if (!state.editingId) {
      streamIdInput.value = sanitizeStreamId(streamIdInput.value);
      validateStreamIdInput();
    }
    if (!streamForm.reportValidity()) {
      showDialogNotice(validationMessage());
      return;
    }
    const body = {
      streamId: state.editingId || streamIdInput.value,
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
    hideDialogNotice();
    showNotice("Audio source saved.", "ok");
    await load();
  } catch (error) {
    if (dialog.open) showDialogNotice(error.message);
    else showNotice(error.message);
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
function modeLabel(mode) { return mode === "publisher" ? "Live capture" : mode === "silence" ? "Sending silence" : "Offline"; }
function sanitizeStreamId(value) { return String(value).toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/^-+/g, "").slice(0, 64); }
function validateStreamIdInput() {
  if (streamIdInput.disabled) {
    streamIdInput.setCustomValidity("");
    return true;
  }
  const value = streamIdInput.value;
  const ok = /^[a-z0-9][a-z0-9-]{6,63}$/.test(value);
  streamIdInput.setCustomValidity(ok || !value ? "" : "Stream ID must be 7-64 lowercase letters, numbers, or hyphens, and start with a letter or number.");
  return ok;
}
function validationMessage() {
  return streamIdInput.validationMessage || "Check the highlighted fields and try again.";
}
function hideDialogNotice() { dialogNotice.textContent = ""; dialogNotice.className = "notice hidden"; }
function showDialogNotice(message, kind = "error") { dialogNotice.textContent = message; dialogNotice.className = `notice ${kind === "ok" ? "ok" : ""}`; }
function showNotice(message, kind = "error") { notice.textContent = message; notice.className = `notice ${kind === "ok" ? "ok" : ""}`; }
async function api(url, init) { const response = await fetch(url, init); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`); return body; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function escapeAttr(value) { return escapeHtml(value).replaceAll('"', "&quot;"); }
function microphoneIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>'; }
function headphonesIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 18v-6a8 8 0 0 1 16 0v6"/><path d="M4 14h3v6H5a1 1 0 0 1-1-1v-5ZM20 14h-3v6h2a1 1 0 0 0 1-1v-5Z"/></svg>'; }
function copyIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>'; }
function pencilIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4L7 21H3v-4L15 5Z"/><path d="m13 7 4 4"/></svg>'; }
function trashIcon() { return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 11v6M14 11v6"/></svg>'; }

load();
setInterval(() => { if (!dialog.open) void load(); }, 5_000);
