const state = { config: null, document: null, streams: [], selectedId: null };
const dockLabels = { tl: "Top Left", t: "Top", tr: "Top Right", l: "Left", c: "Center", r: "Right", bl: "Bottom Left", b: "Bottom", br: "Bottom Right" };
const defaultTelemetryOrder = ["header", "bitrate", "rtt", "latency", "buffer", "server", "dropped", "uptime", "meter", "chart", "recovery"];
const telemetryBlocks = [
  { id: "header", label: "Header", toggles: [["show_name", "Name"], ["show_status", "Status"]] },
  { id: "bitrate", label: "Bitrate", toggles: [["show_bitrate", "Show"]] },
  { id: "rtt", label: "RTT", toggles: [["show_rtt", "Show"]] },
  { id: "latency", label: "Latency", toggles: [["show_latency", "Show"]] },
  { id: "buffer", label: "Buffer", toggles: [["show_buffer", "Show"]] },
  { id: "server", label: "Server", toggles: [["show_server", "Show"]] },
  { id: "dropped", label: "Dropped", toggles: [["show_dropped", "Show"]] },
  { id: "uptime", label: "Uptime", toggles: [["show_uptime", "Show"]] },
  { id: "meter", label: "Meter", toggles: [["show_meter", "Show"]] },
  { id: "chart", label: "Chart", toggles: [["show_chart", "Show"]] },
  { id: "recovery", label: "Recovery", toggles: [["show_recovery", "Show"]] },
];
const behaviorToggles = [
  ["compact_when_good", "Compact good"],
  ["use_rtt_in_good", "Use RTT"],
];
const visibleFields = ["show_name", "show_status", "show_bitrate", "show_rtt", "show_latency", "show_buffer", "show_chart", "show_meter", "show_server", "show_dropped", "show_uptime", "show_recovery"];
const selectors = {
  list: document.querySelector("#preset-list"),
  status: document.querySelector("#receiver-status"),
  notice: document.querySelector("#notice"),
  title: document.querySelector("#editor-title"),
  url: document.querySelector("#editor-url"),
  frame: document.querySelector("#preview-frame"),
  stream: document.querySelector("#stream-select"),
  slug: document.querySelector("#slug-input"),
  duplicateDialog: document.querySelector("#duplicate-dialog"),
};

document.documentElement.dataset.theme = localStorage.getItem("frame-theme") || "night";
document.querySelector("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "day" ? "night" : "day";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("frame-theme", next);
});
document.querySelector("#save-button").addEventListener("click", saveSelected);
document.querySelector("#copy-url-button").addEventListener("click", copyOverlayUrl);
document.querySelector("#restore-button").addEventListener("click", restoreSelected);
document.querySelector("#delete-button").addEventListener("click", deleteSelected);
document.querySelector("#duplicate-button").addEventListener("click", openDuplicateDialog);
document.querySelector("#duplicate-form").addEventListener("submit", duplicateSelected);
document.querySelectorAll(".close-dialog").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
selectors.frame.addEventListener("load", sendPreview);

for (const [dock, label] of Object.entries(dockLabels)) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.dataset.dock = dock;
  button.textContent = label;
  button.addEventListener("click", () => updateSelected((preset) => { preset.layout.dock = dock; }));
  document.querySelector("#dock-buttons").append(button);
}
for (const [field, label] of behaviorToggles) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary";
  button.dataset.toggle = field;
  button.textContent = label;
  button.addEventListener("click", () => updateSelected((preset) => { preset.config[field] = !preset.config[field]; }));
  document.querySelector("#field-toggles").append(button);
}

bind("#name-input", "input", (preset, value) => { preset.name = value; });
bind("#description-input", "input", (preset, value) => { preset.description = value; });
bind("#enabled-select", "change", (preset, value) => { preset.enabled = value === "true"; });
bind("#stream-select", "change", (preset, value) => { preset.config.stream_profile_id = value || null; });
bindNumber("#pad-input", "layout", "pad");
bindNumber("#scale-input", "layout", "scale");
bindNumber("#width-input", "layout", "width_px");
bindNumber("#height-input", "layout", "height_px");
bindNumber("#block-width-input", "config", "telemetry_block_width_px");
bindNumber("#block-height-input", "config", "telemetry_block_height_px");
bindNumber("#poll-input", "config", "poll_ms");
bindNumber("#good-bitrate-input", "config", "bitrate_good_min");
bindNumber("#warn-bitrate-input", "config", "bitrate_warn_min");
bindRttThresholds();
bindNumber("#meter-max-input", "config", "bitrate_meter_max");
bindNumber("#opacity-good-input", "theme", "bg_opacity_good");
bindNumber("#opacity-warn-input", "theme", "bg_opacity_warn");
bindNumber("#opacity-bad-input", "theme", "bg_opacity_bad");
bindNumber("#radius-input", "theme", "border_radius_px");
bindNumber("#font-size-input", "theme", "font_size_base_px");
bindNumber("#transition-input", "config", "transition_ms");
bindColor("#text-color-input", "text_color");
bindColor("#muted-color-input", "muted_color");
bindColor("#good-color-input", "good_color");
bindColor("#warn-color-input", "warn_color");
bindColor("#bad-color-input", "bad_color");

async function load() {
  clearNotice();
  try {
    const [config, presets, streams] = await Promise.all([api("/overlays/api/config"), api("/overlays/api/presets"), api("/overlays/api/streams")]);
    state.config = config;
    state.document = presets;
    hydratePresets();
    state.streams = streams.streams;
    const requested = new URLSearchParams(window.location.search).get("stream");
    state.selectedId ||= presets.default_preset_id;
    if (requested && selected()) selected().config.stream_profile_id = requested;
    selectors.status.textContent = "Telemetry connected";
    selectors.status.className = "status-pill good";
    render();
  } catch (error) {
    selectors.status.textContent = "Telemetry unavailable";
    selectors.status.className = "status-pill bad";
    showNotice(error.message);
  }
}

function render() {
  renderPresetList();
  renderEditor();
}

function renderPresetList() {
  selectors.list.innerHTML = state.document.presets.map((preset) => `
    <button class="preset-item ${preset.id === state.selectedId ? "active" : ""}" data-preset="${escapeAttr(preset.id)}">
      ${escapeHtml(preset.name)}
      <small>${escapeHtml(preset.id)}${preset.id === state.document.default_preset_id ? " - default" : ""}</small>
    </button>
  `).join("");
  selectors.list.querySelectorAll("[data-preset]").forEach((button) => button.addEventListener("click", () => {
    state.selectedId = button.dataset.preset;
    render();
  }));
}

function renderEditor() {
  const preset = selected();
  if (!preset) return;
  const url = overlayUrl(preset.id);
  selectors.title.textContent = preset.name;
  selectors.url.textContent = url;
  if (selectors.frame.dataset.preset !== preset.id) {
    selectors.frame.dataset.preset = preset.id;
    selectors.frame.src = `${url}?preview=1`;
  } else {
    sendPreview();
  }
  document.querySelector("#name-input").value = preset.name || "";
  selectors.slug.value = preset.id;
  document.querySelector("#description-input").value = preset.description || "";
  document.querySelector("#enabled-select").value = String(preset.enabled !== false);
  document.querySelector("#restore-button").hidden = !state.config.stock_preset_ids.includes(preset.id);
  document.querySelector("#delete-button").hidden = preset.id === state.document.default_preset_id;
  selectors.stream.innerHTML = `<option value="">Unbound stock preset</option>${state.streams.map((stream) => `<option value="${escapeAttr(stream.player)}">${escapeHtml(stream.description || stream.player)} (${escapeHtml(stream.source_label || "FRAME SRTLA")})</option>`).join("")}`;
  selectors.stream.value = preset.config.stream_profile_id || "";
  setValue("#pad-input", preset.layout.pad, "pad", `${preset.layout.pad}px`);
  setValue("#scale-input", preset.layout.scale ?? 1, "scale", `${Number(preset.layout.scale ?? 1).toFixed(2)}x`);
  setValue("#width-input", preset.layout.width_px ?? 420, "width_px", preset.layout.width_px ? `${preset.layout.width_px}px` : "Auto");
  setValue("#height-input", preset.layout.height_px ?? 0, "height_px", preset.layout.height_px ? `${preset.layout.height_px}px` : "Auto");
  setValue("#block-width-input", preset.config.telemetry_block_width_px ?? 160, "telemetry_block_width_px", `${preset.config.telemetry_block_width_px ?? 160}px`);
  setValue("#block-height-input", preset.config.telemetry_block_height_px ?? 72, "telemetry_block_height_px", `${preset.config.telemetry_block_height_px ?? 72}px`);
  setValue("#poll-input", preset.config.poll_ms, "poll_ms", `${preset.config.poll_ms}ms`);
  setValue("#good-bitrate-input", preset.config.bitrate_good_min, "bitrate_good_min", `${preset.config.bitrate_good_min} kbps`);
  setValue("#warn-bitrate-input", preset.config.bitrate_warn_min, "bitrate_warn_min", `${preset.config.bitrate_warn_min} kbps`);
  setRttValues(preset);
  setValue("#meter-max-input", preset.config.bitrate_meter_max, "bitrate_meter_max", `${preset.config.bitrate_meter_max} kbps`);
  setValue("#opacity-good-input", preset.theme.bg_opacity_good ?? 0.3, "bg_opacity_good", `${Math.round((preset.theme.bg_opacity_good ?? 0.3) * 100)}%`);
  setValue("#opacity-warn-input", preset.theme.bg_opacity_warn ?? 0.5, "bg_opacity_warn", `${Math.round((preset.theme.bg_opacity_warn ?? 0.5) * 100)}%`);
  setValue("#opacity-bad-input", preset.theme.bg_opacity_bad ?? 0.72, "bg_opacity_bad", `${Math.round((preset.theme.bg_opacity_bad ?? 0.72) * 100)}%`);
  setValue("#radius-input", preset.theme.border_radius_px, "border_radius_px", `${preset.theme.border_radius_px}px`);
  setValue("#font-size-input", preset.theme.font_size_base_px, "font_size_base_px", `${preset.theme.font_size_base_px}px`);
  setValue("#transition-input", preset.config.transition_ms, "transition_ms", `${preset.config.transition_ms}ms`);
  setColor("#text-color-input", preset.theme.text_color);
  setColor("#muted-color-input", preset.theme.muted_color);
  setColor("#good-color-input", preset.theme.good_color);
  setColor("#warn-color-input", preset.theme.warn_color);
  setColor("#bad-color-input", preset.theme.bad_color);
  renderTelemetryOrder(preset);
  document.querySelectorAll("[data-dock]").forEach((button) => button.classList.toggle("active", button.dataset.dock === preset.layout.dock));
  document.querySelectorAll("[data-toggle]").forEach((button) => {
    const active = Boolean(preset.config[button.dataset.toggle]);
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function saveSelected() {
  try {
    const preset = selected();
    const blank = visibleFields.every((field) => !preset.config[field]);
    await api(`/overlays/api/presets/${encodeURIComponent(preset.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preset),
    });
    await load();
    showNotice(blank ? "Preset saved, but every visible overlay field is disabled." : "Preset saved. Live OBS overlays update within 2 seconds.", blank ? "error" : "ok");
  } catch (error) {
    showNotice(error.message);
  }
}

async function restoreSelected() {
  const preset = selected();
  if (!confirm(`Restore ${preset.name} to the stock version?`)) return;
  try {
    await api(`/overlays/api/presets/${encodeURIComponent(preset.id)}/restore`, { method: "POST" });
    await load();
  } catch (error) {
    showNotice(error.message);
  }
}

async function deleteSelected() {
  const preset = selected();
  if (!confirm(`Delete ${preset.name}? Its OBS URL will stop working.`)) return;
  try {
    await api(`/overlays/api/presets/${encodeURIComponent(preset.id)}`, { method: "DELETE" });
    state.selectedId = state.document.default_preset_id;
    await load();
  } catch (error) {
    showNotice(error.message);
  }
}

function openDuplicateDialog() {
  const preset = selected();
  document.querySelector("#duplicate-name-input").value = `${preset.name} Copy`;
  document.querySelector("#duplicate-id-input").value = slugify(`${preset.id}-copy`);
  selectors.duplicateDialog.showModal();
}

async function duplicateSelected(event) {
  event.preventDefault();
  try {
    const id = slugify(document.querySelector("#duplicate-id-input").value);
    await api(`/overlays/api/presets/${encodeURIComponent(selected().id)}/duplicate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: document.querySelector("#duplicate-name-input").value }),
    });
    selectors.duplicateDialog.close();
    state.selectedId = id;
    await load();
  } catch (error) {
    showNotice(error.message);
  }
}

async function copyOverlayUrl() {
  try {
    await copyText(overlayUrl(selected().id));
    showNotice("OBS URL copied.", "ok");
  } catch {
    showNotice("Unable to copy the OBS URL. Copy it from the URL shown above instead.");
  }
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.readOnly = true;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("Copy command failed.");
  }
}

function bind(selector, event, mutator) {
  document.querySelector(selector).addEventListener(event, (inputEvent) => {
    updateSelected((preset) => mutator(preset, inputEvent.target.value));
  });
}
function bindNumber(selector, section, key) {
  bind(selector, "input", (preset, value) => { preset[section][key] = Number(value); });
}
function bindRttThresholds() {
  document.querySelector("#rtt-warn-input").addEventListener("input", (event) => {
    updateSelected((preset) => {
      const warn = Number(event.target.value);
      preset.config.rtt_warn_max = warn;
      if (preset.config.rtt_bad_max <= warn) preset.config.rtt_bad_max = warn + 100;
    });
  });
  document.querySelector("#rtt-bad-input").addEventListener("input", (event) => {
    updateSelected((preset) => {
      const bad = Number(event.target.value);
      preset.config.rtt_bad_max = bad;
      if (preset.config.rtt_warn_max >= bad) preset.config.rtt_warn_max = Math.max(0, bad - 100);
    });
  });
}
function bindColor(selector, key) {
  bind(selector, "input", (preset, value) => { preset.theme[key] = value; });
}
function updateSelected(mutator) {
  mutator(selected());
  renderEditor();
}
function sendPreview() {
  const preset = selected();
  if (preset && selectors.frame.contentWindow) {
    const stream = state.streams.find((candidate) => candidate.player === preset.config.stream_profile_id);
    const previewPreset = structuredClone(preset);
    delete previewPreset.config.stream_profile_id;
    selectors.frame.contentWindow.postMessage({
      type: "frame-preview",
      preset: previewPreset,
      stats_url: preset.config.stream_profile_id ? `/overlays/view/${encodeURIComponent(preset.id)}/stats` : null,
      stream_display_name: stream?.description || preset.name || "FRAME Stream",
    }, window.location.origin);
  }
}
function selected() {
  return state.document?.presets.find((preset) => preset.id === state.selectedId) || state.document?.presets[0];
}
function hydratePresets() {
  const baseline = state.document.presets.find((preset) => preset.id === "default-connectivity") || state.document.presets[0];
  state.document.presets = state.document.presets.map((preset) => ({
    ...preset,
    layout: { width_px: 420, height_px: 0, ...(baseline.layout || {}), ...(preset.layout || {}) },
    theme: { bg_opacity_warn: 0.5, ...(baseline.theme || {}), ...(preset.theme || {}) },
    config: {
      show_name: true,
      show_recovery: false,
      telemetry_block_width_px: 160,
      telemetry_block_height_px: 72,
      ...(baseline.config || {}),
      ...(preset.config || {}),
      telemetry_order: normalizedTelemetryOrder(preset.config?.telemetry_order || baseline.config?.telemetry_order),
    },
  }));
}

function renderTelemetryOrder(preset) {
  const container = document.querySelector("#telemetry-order");
  const order = normalizedTelemetryOrder(preset.config.telemetry_order);
  container.innerHTML = order.map((id, index) => {
    const block = telemetryBlocks.find((candidate) => candidate.id === id);
    const toggles = block.toggles.map(([field, label]) => {
      const active = Boolean(preset.config[field]);
      return `<button type="button" class="secondary ${active ? "active" : ""}" data-toggle="${field}" aria-pressed="${active}">${escapeHtml(label)}</button>`;
    }).join("");
    return `<div class="telemetry-order-row" draggable="true" data-block="${id}">
      <div class="telemetry-order-header">
        <button type="button" class="secondary drag-handle" title="Drag to reorder" aria-label="Drag ${escapeAttr(block.label)} to reorder">&#8942;&#8942;</button>
        <div class="telemetry-move-actions" aria-label="Move ${escapeAttr(block.label)} block">
          <button type="button" class="secondary move-button" data-move-block="${id}" data-direction="-1" aria-label="Move ${escapeAttr(block.label)} up" ${index === 0 ? "disabled" : ""}>&uarr;</button>
          <button type="button" class="secondary move-button" data-move-block="${id}" data-direction="1" aria-label="Move ${escapeAttr(block.label)} down" ${index === order.length - 1 ? "disabled" : ""}>&darr;</button>
        </div>
        <div class="telemetry-order-title">
          <strong>${escapeHtml(block.label)}</strong>
          <span>${escapeHtml(blockSummary(block, preset))}</span>
        </div>
      </div>
      <div class="block-toggles">${toggles}</div>
    </div>`;
  }).join("");
  container.querySelectorAll("[data-toggle]").forEach((button) => button.addEventListener("click", () => {
    updateSelected((selectedPreset) => { selectedPreset.config[button.dataset.toggle] = !selectedPreset.config[button.dataset.toggle]; });
  }));
  container.querySelectorAll("[data-move-block]").forEach((button) => button.addEventListener("click", () => {
    moveTelemetryBlock(button.dataset.moveBlock, Number(button.dataset.direction));
  }));
  container.querySelectorAll("[data-block]").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", row.dataset.block);
      row.classList.add("dragging");
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      row.classList.add("drop-target");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("dragend", () => {
      container.querySelectorAll("[data-block]").forEach((candidate) => candidate.classList.remove("dragging", "drop-target"));
    });
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      reorderTelemetryBlock(event.dataTransfer.getData("text/plain"), row.dataset.block);
    });
  });
}

function moveTelemetryBlock(id, direction) {
  updateSelected((preset) => {
    const order = normalizedTelemetryOrder(preset.config.telemetry_order);
    const index = order.indexOf(id);
    const target = Math.max(0, Math.min(order.length - 1, index + direction));
    order.splice(target, 0, order.splice(index, 1)[0]);
    preset.config.telemetry_order = order;
  });
}

function reorderTelemetryBlock(sourceId, targetId) {
  if (!sourceId || sourceId === targetId) return;
  updateSelected((preset) => {
    const order = normalizedTelemetryOrder(preset.config.telemetry_order);
    const sourceIndex = order.indexOf(sourceId);
    const targetIndex = order.indexOf(targetId);
    const insertionIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    order.splice(insertionIndex, 0, order.splice(sourceIndex, 1)[0]);
    preset.config.telemetry_order = order;
  });
}

function normalizedTelemetryOrder(value) {
  const supplied = Array.isArray(value) ? value.filter((id) => defaultTelemetryOrder.includes(id)) : [];
  return [...new Set([...supplied, ...defaultTelemetryOrder])];
}

function blockSummary(block, preset) {
  const enabled = block.toggles.filter(([field]) => Boolean(preset.config[field])).map(([, label]) => label);
  if (!enabled.length) return "Hidden";
  if (block.toggles.length === 1) return "Visible";
  return enabled.join(" + ");
}
function setValue(selector, value, key, label) {
  document.querySelector(selector).value = value;
  document.querySelector(`[data-value="${key}"]`).textContent = label;
}
function setRttValues(preset) {
  const warn = Number(preset.config.rtt_warn_max ?? 1500);
  const bad = Number(preset.config.rtt_bad_max ?? 3500);
  const warnInput = document.querySelector("#rtt-warn-input");
  const badInput = document.querySelector("#rtt-bad-input");
  warnInput.max = String(Math.max(0, bad - 100));
  badInput.min = String(Math.min(20000, warn + 100));
  setValue("#rtt-warn-input", warn, "rtt_warn_max", `${warn}ms`);
  setValue("#rtt-bad-input", bad, "rtt_bad_max", `${bad}ms`);
}
function setColor(selector, value) {
  const input = document.querySelector(selector);
  input.value = String(value || "#2cb4fb").match(/^#[0-9a-fA-F]{6}$/) ? value : "#2cb4fb";
}
function overlayUrl(id) {
  return `${state.config.public_base_url}/overlays/view/${encodeURIComponent(id)}`;
}
async function api(url, init) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
  return body;
}
function showNotice(message, kind = "error") {
  selectors.notice.textContent = message;
  selectors.notice.className = `notice notice-${kind}`;
}
function clearNotice() { selectors.notice.className = "notice hidden"; }
function slugify(value) { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "overlay-preset"; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function escapeAttr(value) { return escapeHtml(value).replaceAll('"', "&quot;"); }

load();
