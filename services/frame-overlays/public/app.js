import {
  BITRATE_LEVEL_MAX,
  BITRATE_LEVEL_STEP,
  RTT_LEVEL_MAX,
  RTT_LEVEL_STEP,
  clampBitrateLevels,
  clampNumericValue,
  clampRttLevels,
  samplingWindowLabel,
} from "./wizard-core.js";

const state = { catalog: null, streams: [], config: null, overlayType: "connectivity", tab: "sources", selectedId: null, draft: null, dirty: false };
const defaultOrder = ["header", "bitrate", "rtt", "latency", "buffer", "server", "dropped", "uptime", "meter", "chart", "recovery"];
const telemetryToggleFields = ["show_name", "show_status", "show_bitrate", "show_rtt", "show_latency", "show_buffer", "show_chart", "show_meter", "show_server", "show_dropped", "show_uptime", "show_recovery"];
const layoutRangeFields = [["layout.pad", "Padding", 0, 200, 1], ["layout.scale", "Scale", .5, 3, .05], ["layout.width_px", "Overlay width", 0, 1200, 10], ["layout.height_px", "Minimum height", 0, 1000, 10]];
const telemetryRangeFields = [["config.telemetry_block_width_px", "Block width", 80, 600, 10], ["config.telemetry_block_height_px", "Block height", 40, 400, 4]];
const samplingRangeFields = [["config.poll_ms", "Poll interval (ms)", 20, 2000, 20], ["config.history_len", "Poll history count", 2, 120, 1]];
const themeRangeFields = [["theme.bg_opacity_good", "Good opacity", 0, 1, .01], ["theme.bg_opacity_warn", "Warn opacity", 0, 1, .01], ["theme.bg_opacity_bad", "Bad opacity", 0, 1, .01], ["theme.border_radius_px", "Corner radius", 0, 50, 1], ["theme.font_size_base_px", "Font size", 10, 32, 1], ["config.transition_ms", "Transition (ms)", 0, 2000, 50]];
const uploadThemeRangeFields = [["theme.bg_opacity_good", "Uploading opacity", 0, 1, .01], ["theme.bg_opacity_warn", "Waiting/queued opacity", 0, 1, .01], ["theme.bg_opacity_bad", "Failed upload opacity", 0, 1, .01], ["theme.border_radius_px", "Corner radius", 0, 50, 1], ["theme.font_size_base_px", "Font size", 10, 32, 1]];
const uploadColorFields = [["text_color", "Text color"], ["muted_color", "Muted text color"], ["good_color", "Uploading color"], ["warn_color", "Waiting/queued color"], ["bad_color", "Failed color"]];
const uploadRangeFields = [["config.active_poll_ms", "Upload refresh rate (ms)", 200, 2000, 100], ["config.idle_poll_ms", "Idle check rate (ms)", 200, 10000, 100], ["config.complete_hide_ms", "Show completed for (ms)", 0, 30000, 250], ["config.width_px", "Card width", 280, 1200, 10]];
const dockLabels = { tl:"Top left",t:"Top",tr:"Top right",l:"Left",c:"Center",r:"Right",bl:"Bottom left",b:"Bottom",br:"Bottom right" };
const libraryList = document.querySelector("#library-list");
const libraryContext = document.querySelector("#library-context");
const editor = document.querySelector("#editor-content");
const preview = document.querySelector("#preview-frame");
const notice = document.querySelector("#notice");
const dirtyStatus = document.querySelector("#dirty-status");
const receiverStatus = document.querySelector("#receiver-status");
const sourceDialog = document.querySelector("#source-dialog");
const workspaceType = document.querySelector("#workspace-type");
const createType = document.querySelector("#create-type");

void load();
window.addEventListener("beforeunload", (event) => { if (state.dirty) event.preventDefault(); });
document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
document.querySelector("#create-source-button").addEventListener("click", () => openCreateSource());
workspaceType.addEventListener("change", () => switchOverlayType(workspaceType.value));
createType.addEventListener("change", () => syncCreateSourceType());
document.querySelector("[data-close]").addEventListener("click", () => sourceDialog.close());
document.querySelector("#source-form").addEventListener("submit", createSource);
document.querySelector("#create-name").addEventListener("input", (event) => {
  const slug = document.querySelector("#create-slug");
  if (!slug.dataset.manual) slug.value = slugify(event.target.value);
});
document.querySelector("#create-slug").addEventListener("input", (event) => { event.target.dataset.manual = "true"; });

async function load(preserveSelection = false) {
  try {
    let streamsAvailable = true;
    const [catalog, streams, config] = await Promise.all([
      api("/overlays/api/catalog"),
      api("/overlays/api/streams").catch(() => { streamsAvailable = false; return { streams:[] }; }),
      api("/overlays/api/config"),
    ]);
    state.catalog = catalog;
    state.streams = streams.streams || [];
    state.config = config;
    receiverStatus.textContent = streamsAvailable ? "Telemetry ready" : "Telemetry unavailable";
    receiverStatus.classList.toggle("live", streamsAvailable);
    if (!preserveSelection || !items().some((item) => item.id === state.selectedId)) state.selectedId = items()[0]?.id || null;
    state.draft = null;
    setDirty(false);
    render();
  } catch (error) {
    receiverStatus.textContent = "Telemetry unavailable";
    showNotice(error.message, true);
  }
}

function items() {
  const collection = state.catalog?.[state.tab] || [];
  if (state.tab !== "sources") return collection.filter((item) => item.type === state.overlayType);
  return collection.filter((source) => sourceType(source) === state.overlayType);
}

function switchOverlayType(type) {
  if (type === state.overlayType) return;
  if (!confirmDiscard()) { workspaceType.value = state.overlayType; return; }
  state.overlayType = type;
  state.selectedId = items()[0]?.id || null;
  state.draft = null;
  setDirty(false);
  render();
}

function switchTab(tab) {
  if (tab === state.tab) return;
  if (!confirmDiscard()) return;
  state.tab = tab;
  state.selectedId = items()[0]?.id || null;
  state.draft = null;
  setDirty(false);
  document.querySelectorAll("[data-tab]").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  render();
}

function selectItem(id) {
  if (id === state.selectedId || !confirmDiscard()) return;
  state.selectedId = id;
  state.draft = null;
  setDirty(false);
  render();
}

function confirmDiscard() { return !state.dirty || confirm("Discard unsaved overlay changes?"); }

function render() {
  renderLibrary();
  const item = items().find((candidate) => candidate.id === state.selectedId);
  if (!item) {
    editor.innerHTML = `<div class="empty-state"><div><h1>No ${escapeHtml(state.tab)}</h1><p>${state.tab === "sources" ? "Create an OBS source to get a permanent browser URL." : "Create a source from a template to begin."}</p></div></div>`;
    preview.removeAttribute("src");
    return;
  }
  if (state.tab === "sources") renderSource(item);
  else if (state.tab === "presets") renderPreset(item);
  else renderTemplate(item);
}

function renderLibrary() {
  const context = {
    sources: "Permanent OBS URLs. Each source binds one preset to one stream feed.",
    presets: "Reusable designs. Editing a preset updates every source that uses it.",
    templates: "Read-only starting points for creating a new preset and OBS source.",
  };
  libraryContext.textContent = context[state.tab];
  workspaceType.value = state.overlayType;
  document.querySelectorAll("[data-count]").forEach((count) => {
    const collection = state.catalog[count.dataset.count] || [];
    const filtered = count.dataset.count === "sources" ? collection.filter((source) => sourceType(source) === state.overlayType) : collection.filter((item) => item.type === state.overlayType);
    count.textContent = String(filtered.length);
  });
  libraryList.innerHTML = items().map((item) => {
    const detail = state.tab === "sources" ? `${sourceBindingLabel(item)} · ${sourcePresetLabel(item)}` : `${item.type.replaceAll("_", " ")}${state.tab === "templates" ? " · stock" : ` · revision ${item.revision}`}`;
    return `<button class="library-item ${item.id === state.selectedId ? "active" : ""}" data-id="${escapeAttr(item.id)}"><strong>${escapeHtml(item.display_name || item.name)}</strong><span>${escapeHtml(detail)}</span>${state.tab === "templates" ? '<span class="readonly-badge">Read-only</span>' : ""}</button>`;
  }).join("");
  libraryList.querySelectorAll("[data-id]").forEach((button) => button.addEventListener("click", () => selectItem(button.dataset.id)));
}

function renderSource(source) {
  state.draft ||= structuredClone(source);
  const draft = state.draft;
  const type = sourceType(draft);
  const url = sourceUrl(source);
  const presetOptions = state.catalog.presets.filter((preset) => preset.type === type);
  const dataSourceControl = type === "connectivity"
    ? `<label>Stream data source<select id="source-stream">${streamOptions(draft.data_source.kind === "stream" ? draft.data_source.stream_profile_id : null)}</select></label>`
    : `<div class="source-kind-note"><strong>Web upload telemetry</strong><span>This source automatically follows every active mobile/browser upload. FTP and BELABOX adapters are reserved for later handlers.</span></div>`;
  editor.innerHTML = `
    <div class="editor-head"><div><h1>${escapeHtml(draft.display_name)}</h1><p>OBS Source · URL identity is permanent</p></div><div class="editor-actions"><button id="copy-source" class="secondary">Copy URL</button><button id="delete-source" class="danger">Delete</button></div></div>
    ${saveDock("save-source", "Save source", "Source changes update connected OBS clients.")}
    <p class="source-url">${escapeHtml(url)}</p>
    <div class="form-grid">
      <label>Display name<input id="source-name" maxlength="80" value="${escapeAttr(draft.display_name)}"></label>
      <label>Enabled<select id="source-enabled"><option value="true" ${draft.enabled ? "selected" : ""}>Enabled</option><option value="false" ${!draft.enabled ? "selected" : ""}>Disabled</option></select></label>
      <label>Reusable preset<select id="source-preset">${presetOptions.map((preset) => `<option value="${escapeAttr(preset.id)}" ${preset.id === draft.preset_id ? "selected" : ""}>${escapeHtml(preset.name)}</option>`).join("")}</select></label>
      ${dataSourceControl}
      <label class="wide">Permanent slug<input value="${escapeAttr(draft.slug)}" readonly></label>
    </div>
    <div id="source-capability-note">${type === "connectivity" ? sourceCapabilityNotice(draft.data_source.kind === "stream" ? draft.data_source.stream_profile_id : null) : ""}</div>`;
  preview.src = `/overlays/api/preview/${encodeURIComponent(draft.preset_id)}?preview=1`;
  bindDirty("#source-name", (value) => draft.display_name = value);
  bindDirty("#source-enabled", (value) => draft.enabled = value === "true");
  bindDirty("#source-preset", (value) => { draft.preset_id = value; preview.src = `/overlays/api/preview/${encodeURIComponent(value)}?preview=1`; });
  if (type === "connectivity") bindDirty("#source-stream", (value) => {
      draft.data_source = { kind:"stream", stream_profile_id:value || null };
      document.querySelector("#source-capability-note").innerHTML = sourceCapabilityNotice(value || null);
    });
  document.querySelector("#copy-source").addEventListener("click", async () => { await copyText(url); showNotice("OBS URL copied."); });
  document.querySelector("#save-source").addEventListener("click", saveSource);
  document.querySelector("#delete-source").addEventListener("click", deleteSource);
  syncSaveDock();
}

function renderTemplate(template) {
  preview.src = `/overlays/api/preview-template/${encodeURIComponent(template.id)}?preview=1`;
  editor.innerHTML = `
    <div class="editor-head"><div><h1>${escapeHtml(template.name)}</h1><p>Stock template · immutable</p></div><button id="use-template">Create source from template</button></div>
    <div class="notice"><strong>Read-only by design.</strong> Stock templates cannot be edited or deleted. Use one to create a user preset and source.</div>
    <dl><dt>Type</dt><dd>${escapeHtml(template.type.replaceAll("_", " "))}</dd><dt>Description</dt><dd>${escapeHtml(template.description || "FRAME stock design")}</dd><dt>Default placement</dt><dd>${escapeHtml(dockLabels[template.layout.dock])}</dd></dl>`;
  document.querySelector("#use-template").addEventListener("click", () => openCreateSource(`template:${template.id}`));
}

function renderPreset(preset) {
  if (preset.type === "upload_progress") return renderUploadPreset(preset);
  state.draft ||= structuredClone(preset);
  const draft = state.draft;
  const template = state.catalog.templates.find((candidate) => candidate.id === draft.template_id) || state.catalog.templates[0];
  const rttExceededCeiling = Number(draft.config.chart_rtt_max) > RTT_LEVEL_MAX;
  applyBitrateLevels(draft, readBitrateLevels(draft));
  applyRttLevels(draft, readRttLevels(draft));
  editor.innerHTML = `
    <div class="editor-head"><div><h1>${escapeHtml(draft.name)}</h1><p>User preset · reusable design · revision ${draft.revision}</p></div><div class="editor-actions"><button id="reset-preset" class="secondary">Reset controls</button><button id="delete-preset" class="danger">Delete</button></div></div>
    ${saveDock("save-preset", "Save preset", "Preset changes update every source that uses this design.")}
    <div class="form-grid"><label>Name<input data-path="name" maxlength="80" value="${escapeAttr(draft.name)}"></label><label>Enabled<select data-path="enabled"><option value="true" ${draft.enabled ? "selected" : ""}>Enabled</option><option value="false" ${!draft.enabled ? "selected" : ""}>Disabled</option></select></label><label class="wide">Notes<input data-path="description" maxlength="280" value="${escapeAttr(draft.description || "")}"></label></div>
    <details class="settings-section" open><summary>Layout</summary><div class="settings-body"><div class="dock-grid">${Object.entries(dockLabels).map(([id,label]) => `<button class="secondary ${draft.layout.dock === id ? "active" : ""}" data-dock="${id}">${label}</button>`).join("")}</div><div class="range-list">${layoutRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div></div></details>
    <details class="settings-section" open><summary>Telemetry</summary><div class="settings-body"><div class="toggle-grid">${telemetryToggleFields.map((field) => `<label><input type="checkbox" data-toggle="${field}" ${draft.config[field] ? "checked" : ""}>${humanize(field)}</label>`).join("")}</div><h3>Touch-safe order</h3><div id="order-list" class="order-list"></div><div class="range-list">${telemetryRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div><div class="sampling-group"><div class="sampling-head"><h3>Sampling</h3><span id="sampling-window">${escapeHtml(samplingWindowLabel(draft.config.poll_ms, draft.config.history_len))} visible history</span></div><div class="range-list">${samplingRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div></div></div></details>
    <details class="settings-section" open><summary>Behavior</summary><div class="settings-body"><div class="toggle-grid behavior-toggles"><label><input type="checkbox" data-behavior="use_rtt_in_good" ${draft.config.use_rtt_in_good ? "checked" : ""}>Use RTT in quality</label><label><input type="checkbox" data-behavior="show_bitrate_in_good" ${draft.config.show_bitrate_in_good !== false ? "checked" : ""}>Show bitrate while good</label><label><input type="checkbox" data-behavior="compact_when_good" ${draft.config.compact_when_good ? "checked" : ""}>Compact when good</label><label><input type="checkbox" data-behavior="hide_when_offline" ${draft.config.no_signal_behavior === "hide" ? "checked" : ""}>Hide when offline</label></div>${bitrateLevelControl(draft, template)}${rttLevelControl(draft, template)}</div></details>
    <details class="settings-section"><summary>Theme</summary><div class="settings-body"><div class="form-grid">${["text_color","muted_color","good_color","warn_color","bad_color"].map((field) => `<label>${humanize(field)}<input type="color" data-color="${field}" value="${escapeAttr(draft.theme[field])}"></label>`).join("")}</div><div class="range-list">${themeRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div></div></details>`;
  preview.src = `/overlays/api/preview/${encodeURIComponent(draft.id)}?preview=1`;
  editor.querySelectorAll("[data-path]").forEach((input) => input.addEventListener("input", () => { setPath(draft, input.dataset.path, input.dataset.path === "enabled" ? input.value === "true" : input.value); presetChanged(); }));
  editor.querySelectorAll("[data-dock]").forEach((button) => button.addEventListener("click", () => { draft.layout.dock = button.dataset.dock; presetChanged(true); }));
  editor.querySelectorAll("[data-toggle]").forEach((input) => input.addEventListener("change", () => { draft.config[input.dataset.toggle] = input.checked; presetChanged(); }));
  editor.querySelectorAll("[data-behavior]").forEach((input) => input.addEventListener("change", () => {
    const behavior = input.dataset.behavior;
    if (behavior === "hide_when_offline") draft.config.no_signal_behavior = input.checked ? "hide" : "show_offline";
    else draft.config[behavior] = input.checked;
    presetChanged();
  }));
  editor.querySelectorAll("[data-color]").forEach((input) => input.addEventListener("input", () => { draft.theme[input.dataset.color] = input.value; presetChanged(); }));
  bindRangeControls(template);
  bindBitrateLevelControls(template);
  bindRttLevelControls(template);
  renderOrder();
  document.querySelector("#save-preset").addEventListener("click", savePreset);
  document.querySelector("#delete-preset").addEventListener("click", deletePreset);
  document.querySelector("#reset-preset").addEventListener("click", () => { if (confirm("Reset this draft to its stock template values?")) { state.draft = { ...structuredClone(draft), ...designFrom(template), id:draft.id,template_id:draft.template_id,revision:draft.revision,created_at:draft.created_at,updated_at:draft.updated_at }; setDirty(true); renderPreset(preset); } });
  if (rttExceededCeiling) {
    setDirty(true);
    showNotice("RTT chart max was clamped to 5000 ms. Save the preset to keep this update.");
  } else syncSaveDock();
}

function renderUploadPreset(preset) {
  state.draft ||= structuredClone(preset);
  const draft = state.draft;
  const template = state.catalog.templates.find((candidate) => candidate.id === draft.template_id) || state.catalog.templates.find((candidate) => candidate.type === "upload_progress");
  editor.innerHTML = `
    <div class="editor-head"><div><h1>${escapeHtml(draft.name)}</h1><p>Upload progress preset · reusable design · revision ${draft.revision}</p></div><div class="editor-actions"><button id="reset-preset" class="secondary">Reset controls</button><button id="delete-preset" class="danger">Delete</button></div></div>
    ${saveDock("save-preset", "Save preset", "Preset changes update every upload-progress source using this design.")}
    <div class="form-grid"><label>Name<input data-path="name" maxlength="80" value="${escapeAttr(draft.name)}"></label><label>Enabled<select data-path="enabled"><option value="true" ${draft.enabled ? "selected" : ""}>Enabled</option><option value="false" ${!draft.enabled ? "selected" : ""}>Disabled</option></select></label><label class="wide">Notes<input data-path="description" maxlength="280" value="${escapeAttr(draft.description || "")}"></label></div>
    <details class="settings-section" open><summary>Layout</summary><div class="settings-body"><div class="dock-grid">${Object.entries(dockLabels).map(([id,label]) => `<button class="secondary ${draft.layout.dock === id ? "active" : ""}" data-dock="${id}">${label}</button>`).join("")}</div><div class="range-list">${layoutRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div></div></details>
    <details class="settings-section" open><summary>Telemetry</summary><div class="settings-body"><div class="toggle-grid"><label><input type="checkbox" data-upload-toggle="show_sent" ${draft.config.show_sent !== false ? "checked" : ""}>Show sent bytes</label><label><input type="checkbox" data-upload-toggle="show_speed" ${draft.config.show_speed !== false ? "checked" : ""}>Show aggregate speed</label><label><input type="checkbox" data-upload-toggle="show_elapsed" ${draft.config.show_elapsed !== false ? "checked" : ""}>Show elapsed time</label></div><div class="capability-note"><strong>Adaptive by ingest method</strong><span>Known totals use a determinate aggregate bar. FTP or agent transfers without totals automatically use an indeterminate bar and hide unavailable values.</span></div></div></details>
    <details class="settings-section" open><summary>Behavior</summary><div class="settings-body"><div class="toggle-grid behavior-toggles"><label><input type="checkbox" data-upload-idle ${draft.config.idle_behavior === "show_idle" ? "checked" : ""}>Show while idle</label></div><div class="range-list">${uploadRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div><div class="form-grid"><label class="wide">Idle label<input data-path="config.idle_label" maxlength="80" value="${escapeAttr(draft.config.idle_label || "WAITING FOR UPLOAD")}"></label></div></div></details>
    <details class="settings-section"><summary>Theme</summary><div class="settings-body"><div class="capability-note"><strong>Upload state styling</strong><span>Uploading, waiting/queued, and failed states each have their own color and opacity.</span></div><div class="form-grid">${uploadColorFields.map(([field,label]) => `<label>${escapeHtml(label)}<input type="color" data-color="${field}" value="${escapeAttr(draft.theme[field])}"></label>`).join("")}</div><div class="range-list">${uploadThemeRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div></div></details>`;
  preview.src = `/overlays/api/preview/${encodeURIComponent(draft.id)}?preview=1`;
  editor.querySelectorAll("[data-path]").forEach((input) => input.addEventListener("input", () => { setPath(draft,input.dataset.path,input.dataset.path === "enabled" ? input.value === "true" : input.value); presetChanged(); }));
  editor.querySelectorAll("[data-dock]").forEach((button) => button.addEventListener("click", () => { draft.layout.dock=button.dataset.dock; presetChanged(true); }));
  editor.querySelectorAll("[data-upload-toggle]").forEach((input) => input.addEventListener("change", () => { draft.config[input.dataset.uploadToggle]=input.checked; presetChanged(); }));
  editor.querySelector("[data-upload-idle]").addEventListener("change", (event) => { draft.config.idle_behavior=event.target.checked?"show_idle":"hide"; presetChanged(); });
  editor.querySelectorAll("[data-color]").forEach((input) => input.addEventListener("input", () => { draft.theme[input.dataset.color]=input.value; presetChanged(); }));
  bindRangeControls(template);
  document.querySelector("#save-preset").addEventListener("click", savePreset);
  document.querySelector("#delete-preset").addEventListener("click", deletePreset);
  document.querySelector("#reset-preset").addEventListener("click", () => { if(confirm("Reset this draft to its stock template values?")){state.draft={...structuredClone(draft),...designFrom(template),id:draft.id,template_id:draft.template_id,revision:draft.revision,created_at:draft.created_at,updated_at:draft.updated_at};setDirty(true);renderUploadPreset(preset);} });
  syncSaveDock();
}

function bitrateLevelControl(draft, template) {
  const levels = readBitrateLevels(draft);
  const defaults = readBitrateLevels(template);
  const warnColor = draft.theme.warn_color || "#ffd166";
  const goodColor = draft.theme.good_color || "#2cb4fb";
  const maxColor = draft.theme.plot_primary || "#8de7ff";
  return `<div class="bitrate-level-control" data-bitrate-control style="--warn-position:${levelPercent(levels.warn)}%;--good-position:${levelPercent(levels.good)}%;--max-position:${levelPercent(levels.max)}%;--warn-level:${escapeAttr(warnColor)};--good-level:${escapeAttr(goodColor)};--max-level:${escapeAttr(maxColor)}">
    <div class="bitrate-level-caption">Set Bitrate levels (<span><i style="background:${escapeAttr(warnColor)}"></i>Warn</span>, <span><i style="background:${escapeAttr(goodColor)}"></i>Good</span>, <span><i style="background:${escapeAttr(maxColor)}"></i>Max</span>)</div>
    <div class="multi-range" aria-label="Bitrate quality levels">
      <div class="multi-range-track"></div>
      ${["warn","good","max"].map((level) => `<input class="level-${level}" type="range" min="0" max="${BITRATE_LEVEL_MAX}" step="${BITRATE_LEVEL_STEP}" value="${levels[level]}" data-bitrate-range="${level}" aria-label="${humanize(level)} bitrate level">`).join("")}
    </div>
    <div class="bitrate-level-values">${["warn","good","max"].map((level) => `<label>${humanize(level)}<input type="number" min="0" max="${BITRATE_LEVEL_MAX}" step="${BITRATE_LEVEL_STEP}" value="${levels[level]}" data-bitrate-number="${level}"></label>`).join("")}<button class="secondary" data-reset-bitrate type="button" data-default-warn="${defaults.warn}" data-default-good="${defaults.good}" data-default-max="${defaults.max}">Reset</button></div>
  </div>`;
}

function bindBitrateLevelControls(template) {
  editor.querySelectorAll("[data-bitrate-range],[data-bitrate-number]").forEach((input) => input.addEventListener("input", () => {
    const changed = input.dataset.bitrateRange || input.dataset.bitrateNumber;
    const levels = readBitrateLevels(state.draft);
    levels[changed] = Number(input.value);
    applyBitrateLevels(state.draft, clampBitrateLevels(levels, changed));
    syncBitrateLevelControl();
    presetChanged();
  }));
  editor.querySelector("[data-reset-bitrate]").addEventListener("click", () => {
    applyBitrateLevels(state.draft, readBitrateLevels(template));
    syncBitrateLevelControl();
    presetChanged();
  });
}

function rttLevelControl(draft, template) {
  const levels = readRttLevels(draft);
  const defaults = readRttLevels(template);
  const goodColor = draft.theme.good_color || "#2cb4fb";
  const badColor = draft.theme.bad_color || "#ff5f6d";
  const maxColor = draft.theme.plot_secondary || "#8de7ff";
  return `<div class="bitrate-level-control rtt-level-control" data-rtt-control style="--good-position:${rttLevelPercent(levels.good)}%;--bad-position:${rttLevelPercent(levels.bad)}%;--max-position:${rttLevelPercent(levels.max)}%;--good-level:${escapeAttr(goodColor)};--bad-level:${escapeAttr(badColor)};--max-level:${escapeAttr(maxColor)}">
    <div class="bitrate-level-caption">Set RTT levels (<span><i style="background:${escapeAttr(goodColor)}"></i>Good</span>, <span><i style="background:${escapeAttr(badColor)}"></i>Bad</span>, <span><i style="background:${escapeAttr(maxColor)}"></i>Max</span>)</div>
    <div class="multi-range" aria-label="RTT quality levels">
      <div class="multi-range-track"></div>
      ${["good","bad","max"].map((level) => `<input class="level-${level}" type="range" min="0" max="${RTT_LEVEL_MAX}" step="${RTT_LEVEL_STEP}" value="${levels[level]}" data-rtt-range="${level}" aria-label="${humanize(level)} RTT level">`).join("")}
    </div>
    <div class="bitrate-level-values">${["good","bad","max"].map((level) => `<label>${humanize(level)} (ms)<input type="number" min="0" max="${RTT_LEVEL_MAX}" step="${RTT_LEVEL_STEP}" value="${levels[level]}" data-rtt-number="${level}"></label>`).join("")}<button class="secondary" data-reset-rtt type="button" data-default-good="${defaults.good}" data-default-bad="${defaults.bad}" data-default-max="${defaults.max}">Reset</button></div>
  </div>`;
}

function bindRttLevelControls(template) {
  editor.querySelectorAll("[data-rtt-range],[data-rtt-number]").forEach((input) => input.addEventListener("input", () => {
    const changed = input.dataset.rttRange || input.dataset.rttNumber;
    const levels = readRttLevels(state.draft);
    levels[changed] = Number(input.value);
    applyRttLevels(state.draft, clampRttLevels(levels, changed));
    syncRttLevelControl();
    presetChanged();
  }));
  editor.querySelector("[data-reset-rtt]").addEventListener("click", () => {
    applyRttLevels(state.draft, readRttLevels(template));
    syncRttLevelControl();
    presetChanged();
  });
}

function readBitrateLevels(design) {
  return clampBitrateLevels({
    warn: design.config.bitrate_warn_min ?? 2500,
    good: design.config.bitrate_good_min ?? 5000,
    max: design.config.bitrate_meter_max ?? design.config.chart_bitrate_max ?? BITRATE_LEVEL_MAX,
  }, "good");
}

function applyBitrateLevels(design, levels) {
  design.config.bitrate_warn_min = levels.warn;
  design.config.bitrate_good_min = levels.good;
  design.config.bitrate_meter_max = levels.max;
  design.config.chart_bitrate_max = levels.max;
}

function readRttLevels(design) {
  return clampRttLevels({
    good: design.config.rtt_warn_max ?? 1500,
    bad: design.config.rtt_bad_max ?? 3500,
    max: design.config.chart_rtt_max ?? RTT_LEVEL_MAX,
  }, "bad");
}

function applyRttLevels(design, levels) {
  design.config.rtt_warn_max = levels.good;
  design.config.rtt_bad_max = levels.bad;
  design.config.chart_rtt_max = levels.max;
}

function syncBitrateLevelControl() {
  const levels = readBitrateLevels(state.draft);
  const control = editor.querySelector("[data-bitrate-control]");
  for (const level of ["warn","good","max"]) {
    editor.querySelector(`[data-bitrate-range="${level}"]`).value = levels[level];
    editor.querySelector(`[data-bitrate-number="${level}"]`).value = levels[level];
    control.style.setProperty(`--${level}-position`, `${levelPercent(levels[level])}%`);
  }
}

function syncRttLevelControl() {
  const levels = readRttLevels(state.draft);
  const control = editor.querySelector("[data-rtt-control]");
  for (const level of ["good","bad","max"]) {
    editor.querySelector(`[data-rtt-range="${level}"]`).value = levels[level];
    editor.querySelector(`[data-rtt-number="${level}"]`).value = levels[level];
    control.style.setProperty(`--${level}-position`, `${rttLevelPercent(levels[level])}%`);
  }
}

function levelPercent(value) { return (Number(value) / BITRATE_LEVEL_MAX) * 100; }
function rttLevelPercent(value) { return (Number(value) / RTT_LEVEL_MAX) * 100; }

function rangeControl([path,label,min,max,step], draft, template) {
  const value = getPath(draft,path) ?? getPath(template,path) ?? min;
  return `<div class="range-row"><label>${escapeHtml(label)}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-range="${path}"><input type="number" min="${min}" max="${max}" step="${step}" value="${value}" data-number="${path}" aria-label="${escapeAttr(label)} value"><button class="secondary" data-reset="${path}" title="Reset ${escapeAttr(label)}">↺</button></div>`;
}

function bindRangeControls(template) {
  editor.querySelectorAll("[data-range],[data-number]").forEach((input) => input.addEventListener("input", () => {
    const path = input.dataset.range || input.dataset.number;
    const value = clampNumericValue(input.value, input.min, input.max, input.step);
    setPath(state.draft,path,value);
    editor.querySelector(`[data-range="${path}"]`).value = value;
    editor.querySelector(`[data-number="${path}"]`).value = value;
    updateSamplingWindow();
    presetChanged();
  }));
  editor.querySelectorAll("[data-reset]").forEach((button) => button.addEventListener("click", () => {
    const path = button.dataset.reset;
    const value = getPath(template,path);
    setPath(state.draft,path,value);
    editor.querySelector(`[data-range="${path}"]`).value = value;
    editor.querySelector(`[data-number="${path}"]`).value = value;
    updateSamplingWindow();
    presetChanged();
  }));
}

function updateSamplingWindow() {
  const output = editor.querySelector("#sampling-window");
  if (output) output.textContent = `${samplingWindowLabel(state.draft.config.poll_ms, state.draft.config.history_len)} visible history`;
}

function renderOrder() {
  const order = [...new Set([...(state.draft.config.telemetry_order || []), ...defaultOrder])];
  state.draft.config.telemetry_order = order;
  const list = document.querySelector("#order-list");
  list.innerHTML = order.map((id,index) => `<div class="order-item"><span>${humanize(id)}</span><button class="secondary" data-up="${index}" ${index === 0 ? "disabled" : ""}>↑</button><button class="secondary" data-down="${index}" ${index === order.length-1 ? "disabled" : ""}>↓</button></div>`).join("");
  list.querySelectorAll("[data-up]").forEach((button) => button.addEventListener("click", () => moveOrder(Number(button.dataset.up),-1)));
  list.querySelectorAll("[data-down]").forEach((button) => button.addEventListener("click", () => moveOrder(Number(button.dataset.down),1)));
}

function moveOrder(index,delta) { const order=state.draft.config.telemetry_order; [order[index],order[index+delta]]=[order[index+delta],order[index]]; presetChanged(); renderOrder(); }

function presetChanged(rerender = false) { setDirty(true); sendPreview(); if (rerender) renderPreset(state.catalog.presets.find((item) => item.id === state.selectedId)); }
function sendPreview() { preview.contentWindow?.postMessage({ type:"frame-preview", preset:state.draft, telemetry_identity:"preview", stream_display_name:state.draft.name }, location.origin); }

async function savePreset() {
  try {
    const result = await api(`/overlays/api/presets/${encodeURIComponent(state.draft.id)}`, { method:"PUT", headers:{ "If-Match":String(state.catalog.revision) }, body:JSON.stringify({ preset:state.draft }) });
    state.catalog.revision = result.revision;
    const index = state.catalog.presets.findIndex((item) => item.id === result.preset.id); state.catalog.presets[index] = result.preset;
    state.draft = structuredClone(result.preset); setDirty(false); showNotice("Preset saved and live renderers notified."); render();
  } catch (error) { handleMutationError(error); }
}

async function saveSource() {
  try {
    const result = await api(`/overlays/api/sources/${encodeURIComponent(state.draft.id)}`, { method:"PUT", headers:{ "If-Match":String(state.catalog.revision) }, body:JSON.stringify(state.draft) });
    state.catalog.revision = result.revision; const index=state.catalog.sources.findIndex((item)=>item.id===state.draft.id); state.catalog.sources[index]=result.source; state.draft=structuredClone(result.source); setDirty(false); showNotice("Source saved. OBS clients received the new revision."); render();
  } catch (error) { handleMutationError(error); }
}

async function deletePreset() { if (!confirm("Delete this preset? Sources using it must be removed first.")) return; await deleteItem(`/overlays/api/presets/${encodeURIComponent(state.selectedId)}`); }
async function deleteSource() { if (!confirm("Delete this OBS source? Its URL will stop working.")) return; await deleteItem(`/overlays/api/sources/${encodeURIComponent(state.selectedId)}`); }
async function deleteItem(path) { try { await api(path,{method:"DELETE",headers:{"If-Match":String(state.catalog.revision)}}); state.selectedId=null; await load(); showNotice("Deleted."); } catch(error) { handleMutationError(error); } }

function openCreateSource(designValue) {
  if (designValue) {
    const [kind,id]=designValue.split(":");
    const selected=state.catalog[kind === "preset" ? "presets" : "templates"].find((item)=>item.id===id);
    if(selected)createType.value=selected.type;
  } else createType.value=state.overlayType;
  syncCreateSourceType(designValue);
  document.querySelector("#create-stream").innerHTML=streamOptions(null);
  document.querySelector("#create-name").value="";
  const slug=document.querySelector("#create-slug"); slug.value=""; delete slug.dataset.manual;
  document.querySelector("#create-confirmation").textContent="";
  sourceDialog.showModal();
}

function syncCreateSourceType(preferredValue) {
  const type=createType.value;
  const design=document.querySelector("#create-design");
  const presets=state.catalog.presets.filter((item)=>item.type===type);
  const templates=state.catalog.templates.filter((item)=>item.type===type);
  design.innerHTML=`<optgroup label="Reusable presets">${presets.map((item)=>`<option value="preset:${escapeAttr(item.id)}">${escapeHtml(item.name)}</option>`).join("")}</optgroup><optgroup label="Read-only templates">${templates.map((item)=>`<option value="template:${escapeAttr(item.id)}">${escapeHtml(item.name)} (creates preset)</option>`).join("")}</optgroup>`;
  if(preferredValue && [...design.options].some((option)=>option.value===preferredValue))design.value=preferredValue;
  document.querySelector("#create-stream-field").hidden=type!=="connectivity";
  document.querySelector("#create-upload-field").hidden=type!=="upload_progress";
}

async function createSource(event) {
  event.preventDefault();
  const [kind,id]=document.querySelector("#create-design").value.split(":");
  const displayName=document.querySelector("#create-name").value.trim();
  const type=createType.value;
  const dataSource=type==="connectivity"?{kind:"stream",stream_profile_id:document.querySelector("#create-stream").value||null}:{kind:"upload_progress",adapters:["web_upload"]};
  const body={ expected_revision:state.catalog.revision, display_name:displayName, slug:document.querySelector("#create-slug").value, data_source:dataSource, ...(kind==="preset"?{preset_id:id}:{template_id:id,preset_name:`${displayName} Preset`}) };
  try {
    const result=await api("/overlays/api/sources",{method:"POST",body:JSON.stringify(body)});
    let copied=true;
    try { await copyText(result.source.public_url); } catch { copied=false; }
    document.querySelector("#create-confirmation").textContent=copied?"Created · URL copied":"Created · use Copy URL in the source editor";
    state.overlayType=type; workspaceType.value=type; state.tab="sources"; state.selectedId=result.source.id;
    document.querySelectorAll("[data-tab]").forEach((button)=>button.classList.toggle("active",button.dataset.tab==="sources"));
    setTimeout(async()=>{sourceDialog.close(); await load(true); showNotice(copied?"OBS source created and URL copied.":"OBS source created. Use Copy URL in the source editor.");},700);
  } catch(error) { document.querySelector("#create-confirmation").textContent=error.message; }
}

function bindDirty(selector, update) { document.querySelector(selector).addEventListener("input", (event) => { update(event.target.value); setDirty(true); }); }
function setDirty(value) { state.dirty=value; dirtyStatus.classList.toggle("hidden",!value); dirtyStatus.classList.toggle("dirty",value); syncSaveDock(); }
function saveDock(id, label, description) { return `<div class="save-dock" data-save-dock><div><strong data-save-status>All changes saved</strong><span>${escapeHtml(description)}</span></div><button id="${escapeAttr(id)}" disabled>${escapeHtml(label)}</button></div>`; }
function syncSaveDock() {
  const dock = editor.querySelector("[data-save-dock]");
  if (!dock) return;
  dock.classList.toggle("dirty", state.dirty);
  dock.querySelector("[data-save-status]").textContent = state.dirty ? "Unsaved changes" : "All changes saved";
  dock.querySelector("button").disabled = !state.dirty;
}
function handleMutationError(error) { if(error.status===409){showNotice(`${error.message} Your draft is still here. Reload the page to compare with revision ${error.current_revision ?? "latest"}.`,true);}else showNotice(error.message,true); }
function showNotice(message,isError=false) { notice.textContent=message; notice.classList.remove("hidden","error"); notice.classList.toggle("error",isError); clearTimeout(showNotice.timer); showNotice.timer=setTimeout(()=>notice.classList.add("hidden"),6000); }

async function api(path,options={}) { const response=await fetch(path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}}); if(response.status===204)return null; const body=await response.json().catch(()=>({error:`Request failed (${response.status})`})); if(!response.ok){const error=new Error(body.error||`Request failed (${response.status})`);error.status=response.status;error.current_revision=body.current_revision;throw error;} return body; }
async function copyText(value) { if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(value); const area=document.createElement("textarea");area.value=value;document.body.append(area);area.select();document.execCommand("copy");area.remove(); }
function streamOptions(selected) { return `<option value="">Unbound</option>${state.streams.map((stream)=>`<option value="${escapeAttr(stream.player)}" ${stream.player===selected?"selected":""}>${escapeHtml(stream.description||stream.source_label||stream.player)}</option>`).join("")}`; }
function sourceType(source) { return state.catalog.presets.find((preset)=>preset.id===source.preset_id)?.type||"connectivity"; }
function sourceBindingLabel(source) { if(source.data_source.kind==="upload_progress")return source.data_source.adapters?.includes("web_upload")?"Web upload":"Ingest progress"; if(source.data_source.kind!=="stream")return source.data_source.kind; const stream=state.streams.find((item)=>item.player===source.data_source.stream_profile_id); return stream?.description||source.data_source.stream_profile_id||"unbound"; }
function sourcePresetLabel(source) { return state.catalog.presets.find((preset)=>preset.id===source.preset_id)?.name||"Missing preset"; }
function sourceCapabilityNotice(streamProfileId) {
  const stream = state.streams.find((item)=>item.player===streamProfileId);
  if (stream?.source_type !== "custom") return "";
  return `<div class="capability-note"><strong>BELABOX-aware rendering</strong><span>This feed does not publish every metric. Unavailable telemetry cards and chart lines are hidden automatically—no empty values will reach OBS.</span></div>`;
}
function sourceUrl(source) { return `${state.config.public_base_url}/overlays/view/${encodeURIComponent(source.slug)}/${encodeURIComponent(source.source_key)}`; }
function designFrom(template) { const design=structuredClone(template); delete design.id;delete design.builtin;delete design.readonly;return design; }
function getPath(object,path) { return path.split(".").reduce((value,key)=>value?.[key],object); }
function setPath(object,path,value) { const keys=path.split(".");const last=keys.pop();const target=keys.reduce((value,key)=>value[key]??={},object);target[last]=value; }
function humanize(value) { return value.replaceAll("_"," ").replace(/^./,(letter)=>letter.toUpperCase()); }
function slugify(value) { return value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,64); }
function escapeHtml(value) { return String(value??"").replace(/[&<>"']/g,(character)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]); }
function escapeAttr(value) { return escapeHtml(value); }
