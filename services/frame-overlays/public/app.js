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
import { layoutGrowth } from "./renderer-core.js";

const defaultOrder = ["header", "bitrate", "rtt", "latency", "buffer", "server", "dropped", "uptime", "meter", "chart", "recovery"];
const connectivityLayoutRangeFields = [["layout.pad", "Padding", 0, 200, 1], ["layout.scale", "Scale", .5, 3, .05], ["layout.width_px", "Layout width", 0, 1200, 10], ["layout.height_px", "Min height", 0, 1000, 10]];
const uploadLayoutRangeFields = [["layout.pad", "Padding", 0, 200, 1], ["layout.scale", "Scale", .5, 3, .05], ["config.width_px", "Card width", 280, 1200, 10]];
const blockSizeRangeFields = [["config.telemetry_block_width_px", "Block width", 80, 600, 1], ["config.telemetry_block_height_px", "Block height", 40, 400, 1]];
const samplingRangeFields = [["config.poll_ms", "Poll interval (ms)", 200, 2000, 100], ["config.history_len", "Poll history count", 2, 120, 1]];
const panelColorFields = [["panel_bg_color", "Background"], ["panel_border_color", "Border"], ["panel_glow_color", "Shadow"]];
const blockColorFields = [["block_bg_color", "Background"], ["block_border_color", "Border"]];
const plotColorFields = [["plot_primary", "Bitrate"], ["plot_secondary", "RTT"]];
const panelRangeFields = [["theme.panel_bg_alpha", "Background opacity", 0, 1, .01], ["theme.panel_padding_px", "Widget padding", 0, 60, 1], ["theme.border_radius_px", "Corner radius", 0, 50, 1], ["theme.backdrop_blur_px", "Backdrop blur", 0, 50, 1], ["theme.panel_border_width_px", "Border width", 0, 8, 1], ["theme.glow_blur_px", "Shadow blur", 0, 80, 1], ["theme.glow_spread_px", "Shadow spread", -20, 80, 1], ["theme.glow_offset_x_px", "Shadow X", -80, 80, 1], ["theme.glow_offset_y_px", "Shadow Y", -80, 80, 1]];
const blockRangeFields = [["theme.block_bg_alpha", "Background opacity", 0, 1, .01], ["theme.block_gap_px", "Block gap", 0, 40, 1], ["theme.block_padding_px", "Inner padding", 0, 40, 1], ["theme.block_border_width_px", "Border width", 0, 8, 1]];
const textRangeFields = [["theme.font_size_base_px", "Size", 10, 32, 1], ["theme.font_weight", "Weight", 100, 900, 100]];
const subheaderRangeFields = [["theme.subheader_font_size_px", "Size", 8, 24, 1], ["theme.subheader_font_weight", "Weight", 100, 900, 100]];
const plotRangeFields = [["config.bitrate_meter_height_px", "Meter thickness", 4, 40, 1], ["config.bitrate_meter_radius_px", "Meter radius", 0, 30, 1], ["config.chart_bitrate_line_width_px", "Bitrate thickness", .5, 12, .5], ["config.chart_rtt_line_width_px", "RTT thickness", .5, 12, .5], ["config.chart_warn_line_width_px", "Warn thickness", .5, 12, .5]];
const themeStateFields = [["good", "Good", "good_color", "theme.bg_opacity_good"], ["warn", "Warn", "warn_color", "theme.bg_opacity_warn"], ["bad", "Bad", "bad_color", "theme.bg_opacity_bad"]];
const uploadRangeFields = [["config.active_poll_ms", "Upload refresh rate (ms)", 200, 2000, 100], ["config.idle_poll_ms", "Idle check rate", 200, 10000, 100], ["config.complete_hide_ms", "Show completed for", 0, 30000, 250]];
const fontFamilyOptions = [
  ["Inter, system-ui, sans-serif", "Inter / System"],
  ["system-ui, sans-serif", "System UI"],
  ["Arial, Helvetica, sans-serif", "Arial"],
  ["Verdana, Geneva, sans-serif", "Verdana"],
  ["Tahoma, Geneva, sans-serif", "Tahoma"],
  ["Trebuchet MS, sans-serif", "Trebuchet"],
  ["Georgia, serif", "Georgia"],
  ["Times New Roman, Times, serif", "Times New Roman"],
  ["Consolas, monospace", "Consolas"],
  ["Courier New, monospace", "Courier New"],
];
const lineStyleOptions = [["solid", "Solid"], ["dashed", "Dashed"], ["dotted", "Dotted"]];
const uploadAdapterOptions = [
  ["web_upload", "Web upload", false],
  ["ftp", "FTP (coming soon)", true],
  ["belabox_agent", "BELABOX agent (coming soon)", true],
];
const dockLabels = { tl:"Top left",t:"Top",tr:"Top right",l:"Left",c:"Center",r:"Right",bl:"Bottom left",b:"Bottom",br:"Bottom right" };
const growthDirectionLabels = [["up", "Up", "&uarr;"], ["left", "Left", "&larr;"], ["auto", "Auto", "&bull;"], ["right", "Right", "&rarr;"], ["down", "Down", "&darr;"]];
const customTelemetryBlocks = new Set(["header", "bitrate", "rtt", "buffer", "server", "dropped", "uptime", "meter", "chart"]);
const blockDensityOptions = [["compact", "Compact", 56], ["normal", "Normal", 72], ["spacious", "Spacious", 104]];
const fakePreviewStorageKey = "frame-overlays-fake-preview";
const telemetryBlockFields = [
  ["header", "Header", ["show_name", "show_status"]],
  ["bitrate", "Bitrate", ["show_bitrate"]],
  ["rtt", "RTT", ["show_rtt"]],
  ["latency", "Latency", ["show_latency"]],
  ["buffer", "Buffer", ["show_buffer"]],
  ["server", "Server", ["show_server"]],
  ["dropped", "Dropped frames", ["show_dropped"]],
  ["uptime", "Uptime", ["show_uptime"]],
  ["meter", "Bitrate meter", ["show_meter"]],
  ["chart", "Chart", ["show_chart"]],
  ["recovery", "Recovery", ["show_recovery"]],
];
const telemetryBlockMap = new Map(telemetryBlockFields.map(([id, label, fields]) => [id, { label, fields }]));
const icons = {
  reset: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/></svg>`,
  arrowUp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5-7 7"/><path d="m12 5 7 7"/><path d="M12 5v14"/></svg>`,
  arrowDown: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 19-7-7"/><path d="m12 19 7-7"/><path d="M12 5v14"/></svg>`,
  grip: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>`,
};

const state = {
  catalog: null,
  streams: [],
  config: null,
  mode: "loading",
  selectedSourceId: null,
  sourceDraft: null,
  designDraft: null,
  fakePreview: readStoredFakePreview(),
  previewFrameSize: null,
  create: null,
  pendingSave: new Set(),
  saveTimer: null,
  saveInFlight: false,
  confirmResolve: null,
};

const mainContent = document.querySelector("#main-content");
const sourceTabsShell = document.querySelector("#source-tabs-shell");
const sourceTabs = document.querySelector("#source-tabs");
const previewDock = document.querySelector("#preview-dock");
const previewFrameShell = document.querySelector(".preview-frame-shell");
const previewScaleShell = document.querySelector("#preview-scale-shell");
const preview = document.querySelector("#preview-frame");
const previewCaption = document.querySelector("#preview-caption");
const fakePreviewToggle = document.querySelector("#fake-preview-toggle");
const notice = document.querySelector("#notice");
const saveStatus = document.querySelector("#save-status");
const receiverStatus = document.querySelector("#receiver-status");
const themeToggle = document.querySelector("#theme-toggle");
const confirmDialog = document.querySelector("#confirm-dialog");
const confirmTitle = document.querySelector("#confirm-title");
const confirmSubtitle = document.querySelector("#confirm-subtitle");
const confirmBody = document.querySelector("#confirm-body");
const confirmAccept = document.querySelector("#confirm-accept");

void load();
initializeTheme();
themeToggle.addEventListener("click", toggleTheme);
fakePreviewToggle.addEventListener("change", () => {
  state.fakePreview = fakePreviewToggle.checked;
  writeStoredFakePreview(state.fakePreview);
  renderPreview();
});
fakePreviewToggle.checked = state.fakePreview;
preview.addEventListener("load", sendPreview);
window.addEventListener("resize", applyPreviewScale);
window.addEventListener("storage", (event) => {
  if (event.key === "frame-theme-profile") {
    setThemeMode(readStoredTheme(), false);
    return;
  }
  if (event.key === "frame-theme" && (event.newValue === "day" || event.newValue === "night")) setThemeMode(event.newValue, false);
  if (event.key === fakePreviewStorageKey) {
    state.fakePreview = readStoredFakePreview();
    fakePreviewToggle.checked = state.fakePreview;
    renderPreview();
  }
});
window.addEventListener("message", (event) => {
  if (!isTrustedPreviewOrigin(event.origin) || event.data?.type !== "frame-preview-size") return;
  const width = Number(event.data.width);
  const height = Number(event.data.height);
  const contentWidth = Number(event.data.content_width);
  const contentHeight = Number(event.data.content_height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  state.previewFrameSize = {
    width: Math.ceil(width),
    height: Math.ceil(height),
    contentWidth: Number.isFinite(contentWidth) ? Math.ceil(contentWidth) : Math.ceil(width),
    contentHeight: Number.isFinite(contentHeight) ? Math.ceil(contentHeight) : Math.ceil(height),
  };
  updatePreviewCaption();
  applyPreviewScale();
});
document.querySelector("#confirm-cancel").addEventListener("click", () => resolveConfirm(false));
document.querySelector("#confirm-cancel-x").addEventListener("click", () => resolveConfirm(false));
confirmAccept.addEventListener("click", () => resolveConfirm(true));
confirmDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  resolveConfirm(false);
});

function initializeTheme() {
  setThemeMode(readStoredTheme(), false);
}

function toggleTheme() {
  setThemeMode(document.documentElement.dataset.theme === "day" ? "night" : "day", true);
}

function setThemeMode(nextMode, persist) {
  const mode = nextMode === "day" ? "day" : "night";
  document.documentElement.dataset.theme = mode;
  window.FrameTheme?.apply(mode);
  const nextLabel = mode === "day" ? "Switch to night mode" : "Switch to day mode";
  themeToggle.setAttribute("aria-label", nextLabel);
  themeToggle.title = nextLabel;
  themeToggle.setAttribute("aria-pressed", String(mode === "day"));
  if (persist) {
    try { localStorage.setItem("frame-theme", mode); } catch {}
  }
}

function readStoredTheme() {
  try {
    const stored = localStorage.getItem("frame-theme");
    if (stored === "day" || stored === "night") return stored;
  } catch {}
  return "night";
}

function readStoredFakePreview() {
  try {
    return localStorage.getItem(fakePreviewStorageKey) !== "false";
  } catch {
    return true;
  }
}

function writeStoredFakePreview(value) {
  try {
    localStorage.setItem(fakePreviewStorageKey, value ? "true" : "false");
  } catch {}
}

async function load(preserveSelection = false) {
  try {
    let streamsAvailable = true;
    const [catalog, streams, config] = await Promise.all([
      api("/overlays/api/catalog"),
      api("/overlays/api/streams").catch(() => { streamsAvailable = false; return { streams:[] }; }),
      api("/overlays/api/config"),
    ]);
    state.catalog = catalog;
    state.streams = (streams.streams || []).slice().sort(compareStream);
    state.config = config;
    receiverStatus.textContent = streamsAvailable ? "Telemetry ready" : "Telemetry unavailable";
    receiverStatus.classList.toggle("live", streamsAvailable);
    const sources = sortedSources();
    if (!preserveSelection || !sources.some((source) => source.id === state.selectedSourceId)) state.selectedSourceId = sources[0]?.id || null;
    if (!sources.length && state.mode !== "create") state.mode = "welcome";
    else if (state.mode !== "create") state.mode = "edit";
    setSaveStatus("saved", "");
    render();
  } catch (error) {
    receiverStatus.textContent = "Telemetry unavailable";
    showNotice(error.message, true);
  }
}

function render() {
  renderTabs();
  if (state.mode === "welcome") renderWelcome();
  else if (state.mode === "create") renderCreate();
  else renderSelectedSource();
}

function renderTabs() {
  const sources = sortedSources();
  const showTabs = sources.length && state.mode !== "welcome";
  sourceTabsShell.classList.toggle("hidden", !showTabs);
  if (!showTabs) return;
  sourceTabs.innerHTML = `${sources.map((source) => {
    const unbound = source.data_source.kind === "stream" && !source.data_source.stream_profile_id;
    const active = source.id === state.selectedSourceId && state.mode === "edit";
    return `<a href="#" role="tab" aria-selected="${active}" class="source-tab ${active ? "active" : ""} ${unbound ? "unbound" : ""}" data-source-tab="${escapeAttr(source.id)}">${escapeHtml(source.display_name)}</a>`;
  }).join("")}<a href="#" role="tab" aria-selected="${state.mode === "create"}" class="source-tab new-tab ${state.mode === "create" ? "active" : ""}" id="new-source-tab">New +</a>`;
  sourceTabs.querySelectorAll("[data-source-tab]").forEach((tab) => tab.addEventListener("click", (event) => { event.preventDefault(); selectSource(tab.dataset.sourceTab); }));
  sourceTabs.querySelector("#new-source-tab")?.addEventListener("click", (event) => { event.preventDefault(); startCreate(); });
}

function renderWelcome() {
  setPreviewVisible(false);
  mainContent.innerHTML = `
    <section class="welcome-panel">
      <div class="welcome-card">
        <h1>Welcome to the Overlay Wizard! Let's get started!</h1>
        <p>Create one durable OBS browser-source URL, bind it to stream or upload telemetry, then tune the overlay without exposing internal presets.</p>
        <button id="welcome-create" class="primary-action" type="button">Create OBS Overlay Source</button>
      </div>
    </section>`;
  mainContent.querySelector("#welcome-create").addEventListener("click", startCreate);
}

function startCreate() {
  state.mode = "create";
  state.create = { step: 1, dataSource: null, name: "", slug: "", slugManual: false };
  state.sourceDraft = null;
  state.designDraft = null;
  setSaveStatus("saved", "");
  render();
}

function renderCreate() {
  setPreviewVisible(false);
  if (!state.create || state.create.step === 1) renderCreateDataSource();
  else renderCreateDetails();
}

function renderCreateDataSource() {
  const selectedKey = createSourceKey(state.create?.dataSource);
  const streams = state.streams.slice().sort(compareStream);
  mainContent.innerHTML = `
    <section class="create-panel">
      <div class="step-head">
        <div><h1>Choose a data source</h1><p>The data source determines the overlay type FRAME will create.</p></div>
        ${sortedSources().length ? '<button class="secondary" id="cancel-create" type="button">Cancel</button>' : ""}
      </div>
      <div class="source-grid">
        <section class="choice-section">
          <h2>SRT Streams</h2>
          <p>Use live relay telemetry from Stream Management.</p>
          ${streams.length ? `<div class="choice-list">${streams.map((stream) => sourceChoice({
            key: `stream:${stream.player}`,
            title: stream.description || stream.source_label || stream.player,
            detail: stream.source_label || stream.player,
            active: selectedKey === `stream:${stream.player}`,
          })).join("")}</div>` : `<div class="empty-choice"><span>No SRT streams yet.</span><button id="add-srt-stream" type="button" class="secondary">Add SRT Stream</button></div>`}
        </section>
        <section class="choice-section">
          <h2>Upload Progress</h2>
          <p>Show browser or ingest transfer progress inside OBS.</p>
          <div class="choice-list">
            ${sourceChoice({ key:"upload:web_upload", title:"Web upload", detail:"Browser and mobile upload telemetry", active:selectedKey === "upload:web_upload" })}
            ${sourceChoice({ key:"upload:ftp", title:"FTP (coming soon)", detail:"Adapter listed now; telemetry fetcher is not wired yet.", disabled:true })}
            ${sourceChoice({ key:"upload:belabox_agent", title:"BELABOX agent (coming soon)", detail:"Adapter listed now; telemetry fetcher is not wired yet.", disabled:true })}
          </div>
        </section>
      </div>
      <div class="step-actions">
        <button id="create-next" class="primary-action" type="button" ${state.create?.dataSource ? "" : "disabled"}>Next</button>
      </div>
    </section>`;
  mainContent.querySelectorAll("[data-choice]").forEach((button) => button.addEventListener("click", () => selectCreateDataSource(button.dataset.choice)));
  mainContent.querySelector("#create-next")?.addEventListener("click", () => { state.create.step = 2; renderCreateDetails(); });
  mainContent.querySelector("#cancel-create")?.addEventListener("click", cancelCreate);
  mainContent.querySelector("#add-srt-stream")?.addEventListener("click", openAddStream);
}

function sourceChoice({ key, title, detail, active = false, disabled = false }) {
  return `<button type="button" class="choice-card ${active ? "active" : ""} ${disabled ? "disabled" : ""}" data-choice="${escapeAttr(key)}" ${disabled ? "disabled" : ""}><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span></button>`;
}

function selectCreateDataSource(choice) {
  if (choice.startsWith("stream:")) {
    const streamId = choice.slice("stream:".length);
    const stream = state.streams.find((item) => item.player === streamId);
    state.create.dataSource = { type:"connectivity", label:stream?.description || streamId, data_source:{ kind:"stream", stream_profile_id:streamId } };
  } else if (choice === "upload:web_upload") {
    state.create.dataSource = { type:"upload_progress", label:"Web upload", data_source:{ kind:"upload_progress", adapters:["web_upload"] } };
  }
  renderCreateDataSource();
}

function renderCreateDetails(focusTarget = "name") {
  const validation = validateCreateDetails();
  mainContent.innerHTML = `
    <section class="create-panel">
      <div class="step-head">
        <div><h1>Name the OBS source</h1><p>${escapeHtml(state.create.dataSource?.label || "Selected data source")} will be used for this overlay.</p></div>
        <button class="secondary" id="create-back" type="button">Back</button>
      </div>
      <div class="form-grid">
        <label>Display name<input id="create-name" maxlength="80" required autocomplete="off" value="${escapeAttr(state.create.name)}"></label>
        <label>OBS URL slug<input id="create-slug" maxlength="64" required autocomplete="off" value="${escapeAttr(state.create.slug)}"></label>
      </div>
      <div class="validation-list">
        ${validation.messages.map((item) => `<span class="${item.ok ? "good" : "bad"}">${item.ok ? "OK" : "Needs work"}: ${escapeHtml(item.text)}</span>`).join("")}
      </div>
      <div class="step-actions">
        <button id="cancel-create" class="secondary" type="button">Cancel</button>
        <button id="create-submit" class="primary-action" type="button" ${validation.ok ? "" : "disabled"}>Create</button>
      </div>
    </section>`;
  const nameInput = mainContent.querySelector("#create-name");
  const slugInput = mainContent.querySelector("#create-slug");
  nameInput.addEventListener("input", () => {
    state.create.name = nameInput.value;
    if (!state.create.slugManual) state.create.slug = slugify(nameInput.value);
    renderCreateDetails("name");
  });
  slugInput.addEventListener("input", () => {
    state.create.slugManual = true;
    state.create.slug = slugify(slugInput.value);
    renderCreateDetails("slug");
  });
  mainContent.querySelector("#create-back").addEventListener("click", () => { state.create.step = 1; renderCreateDataSource(); });
  mainContent.querySelector("#cancel-create").addEventListener("click", cancelCreate);
  mainContent.querySelector("#create-submit").addEventListener("click", createSource);
  const focusInput = focusTarget === "slug" ? slugInput : nameInput;
  focusInput.focus();
  focusInput.setSelectionRange(focusInput.value.length, focusInput.value.length);
}

function validateCreateDetails() {
  const name = state.create?.name.trim() || "";
  const slug = state.create?.slug.trim() || "";
  const nameConflict = state.catalog.sources.some((source) => sameIdentity(source.display_name, name));
  const slugConflict = state.catalog.sources.some((source) => sameIdentity(source.slug, slug));
  const slugValid = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(slug);
  const messages = [
    { ok: name.length >= 1, text:"Display name is required." },
    { ok: !nameConflict, text:"Display name must be unique." },
    { ok: slugValid, text:"Slug uses lowercase letters, numbers, and hyphens." },
    { ok: !slugConflict, text:"Slug must be unique." },
  ];
  return { ok: messages.every((item) => item.ok), messages };
}

async function createSource() {
  const validation = validateCreateDetails();
  if (!validation.ok) return;
  const type = state.create.dataSource.type;
  const templateId = state.config.default_template_ids?.[type] || state.config.default_template_id;
  const body = {
    expected_revision: state.catalog.revision,
    template_id: templateId,
    preset_name: `${state.create.name.trim()} Design`,
    display_name: state.create.name.trim(),
    slug: state.create.slug.trim(),
    data_source: state.create.dataSource.data_source,
  };
  try {
    const result = await api("/overlays/api/sources", { method:"POST", body:JSON.stringify(body) });
    state.catalog.revision = result.revision;
    state.catalog.sources.push(result.source);
    if (result.preset) state.catalog.presets.push(result.preset);
    state.selectedSourceId = result.source.id;
    state.mode = "edit";
    state.create = null;
    showNotice("OBS source created.");
    await load(true);
  } catch (error) {
    showNotice(error.message, true);
  }
}

function cancelCreate() {
  const sources = sortedSources();
  state.mode = sources.length ? "edit" : "welcome";
  state.create = null;
  render();
}

function selectSource(id) {
  if (state.saveInFlight || state.pendingSave.size) flushAutosave();
  state.selectedSourceId = id;
  state.mode = "edit";
  state.sourceDraft = null;
  state.designDraft = null;
  render();
}

function renderSelectedSource() {
  const source = selectedSource();
  if (!source) {
    state.mode = sortedSources().length ? "edit" : "welcome";
    render();
    return;
  }
  const preset = findPreset(source.preset_id);
  state.sourceDraft = structuredClone(source);
  state.designDraft = structuredClone(preset);
  state.designDraft.theme ??= {};
  const type = preset.type;
  const unbound = source.data_source.kind === "stream" && !source.data_source.stream_profile_id;
  const url = sourceUrl(source);
  mainContent.innerHTML = `
    <section class="source-panel">
      <div class="source-head">
        <div>
          <div class="source-title-row"><h1>${escapeHtml(source.display_name)}</h1>${unbound ? '<span class="badge warn">Unbound</span>' : ""}<span class="badge">${escapeHtml(typeLabel(type))}</span></div>
          <p>Editing this source updates the OBS browser URL automatically.</p>
        </div>
        <div class="source-actions">
          <button id="copy-source" class="secondary" type="button">Copy OBS URL</button>
          <button id="reset-source" class="secondary" type="button">Reset to base template</button>
          <button id="delete-source" class="danger" type="button">Delete</button>
        </div>
      </div>
      <p class="source-url">${escapeHtml(url)}</p>
      ${sourceDetailsMarkup(source, preset)}
      ${type === "upload_progress" ? uploadDesignMarkup(state.designDraft) : connectivityDesignMarkup(state.designDraft)}
    </section>`;
  bindSourceDetails(type);
  bindDesignControls(type);
  mainContent.querySelector("#copy-source").addEventListener("click", async () => { await copyText(url); showNotice("OBS URL copied."); });
  mainContent.querySelector("#reset-source").addEventListener("click", resetSourceDesign);
  mainContent.querySelector("#delete-source").addEventListener("click", deleteSource);
  renderPreview();
}

function sourceDetailsMarkup(source, preset) {
  const type = preset.type;
  const dataSource = source.data_source;
  const binding = type === "upload_progress" ? uploadAdapterMarkup(dataSource.adapters || ["web_upload"]) : streamBindingMarkup(dataSource.stream_profile_id);
  return `
    <details class="settings-section" open>
      <summary>Source details</summary>
      <div class="settings-body">
        <div class="form-grid">
          <label>Display name<input id="source-name" maxlength="80" value="${escapeAttr(source.display_name)}"></label>
          <label>Permanent slug<input readonly value="${escapeAttr(source.slug)}"></label>
          ${binding}
        </div>
        ${type === "connectivity" ? sourceCapabilityNotice(dataSource.stream_profile_id) : ""}
      </div>
    </details>`;
}

function streamBindingMarkup(selected) {
  const options = [`<option value="">Unbound</option>`, ...state.streams.map((stream) => `<option value="${escapeAttr(stream.player)}" ${stream.player === selected ? "selected" : ""}>${escapeHtml(stream.description || stream.source_label || stream.player)}</option>`)];
  return `<label>Data source<select id="source-stream">${options.join("")}</select><small>Deleting a stream unbinds sources instead of deleting their OBS URLs.</small></label><div class="field-action"><button id="add-srt-stream" class="secondary" type="button">Add SRT Stream</button></div>`;
}

function uploadAdapterMarkup(selectedAdapters) {
  const selected = new Set(Array.isArray(selectedAdapters) && selectedAdapters.length ? selectedAdapters : ["web_upload"]);
  return `<div class="wide"><strong>Upload adapters</strong><div class="toggle-grid">${uploadAdapterOptions.map(([id,label,disabled]) => `<label class="${disabled ? "disabled" : ""}"><input type="checkbox" data-upload-adapter value="${escapeAttr(id)}" ${selected.has(id) ? "checked" : ""} ${disabled ? "disabled" : ""}>${escapeHtml(label)}</label>`).join("")}</div><small>Multiple adapters are part of the long-term source model. Only Web upload is active today.</small></div>`;
}

function bindSourceDetails(type) {
  mainContent.querySelector("#source-name").addEventListener("input", (event) => {
    state.sourceDraft.display_name = event.target.value;
    queueAutosave("source", 800);
  });
  if (type === "connectivity") {
    mainContent.querySelector("#source-stream").addEventListener("change", (event) => {
      state.sourceDraft.data_source = { kind:"stream", stream_profile_id:event.target.value || null };
      queueAutosave("source", 0);
      renderPreview();
    });
    mainContent.querySelector("#add-srt-stream").addEventListener("click", openAddStream);
  } else {
    mainContent.querySelectorAll("[data-upload-adapter]").forEach((input) => input.addEventListener("change", () => {
      const editable = [...mainContent.querySelectorAll("[data-upload-adapter]:not(:disabled)")];
      if (!editable.some((candidate) => candidate.checked)) input.checked = true;
      const adapters = [...new Set([
        ...editable.filter((candidate) => candidate.checked).map((candidate) => candidate.value),
        ...(state.sourceDraft.data_source.adapters || []).filter((adapter) => uploadAdapterOptions.some(([id,,disabled]) => id === adapter && disabled)),
      ])];
      state.sourceDraft.data_source = { kind:"upload_progress", adapters };
      queueAutosave("source", 0);
      renderPreview();
    }));
  }
}

function connectivityDesignMarkup(draft) {
  return `
    ${layoutSectionMarkup(draft, true)}
    ${blockThemeSectionMarkup(draft, true)}
    ${stateColoringSectionMarkup(draft)}
    ${connectivityTelemetryMarkup(draft)}
    ${advancedTimingMarkup(draft)}
    <details class="settings-section" open><summary>Behavior</summary><div class="settings-body"><div class="toggle-grid behavior-toggles"><label><input type="checkbox" data-behavior="use_rtt_in_good" ${draft.config.use_rtt_in_good ? "checked" : ""}>Use RTT in quality</label><label><input type="checkbox" data-behavior="show_bitrate_in_good" ${draft.config.show_bitrate_in_good !== false ? "checked" : ""}>Show bitrate while good</label><label><input type="checkbox" data-behavior="compact_when_good" ${draft.config.compact_when_good ? "checked" : ""}>Compact when good</label><label><input type="checkbox" data-behavior="hide_when_offline" ${draft.config.no_signal_behavior === "hide" ? "checked" : ""}>Hide when offline</label></div><div class="level-control-grid">${bitrateLevelControl(draft, templateForDraft(draft))}${rttLevelControl(draft, templateForDraft(draft))}</div></div></details>
  `;
}

function uploadDesignMarkup(draft) {
  return `
    ${layoutSectionMarkup(draft, false)}
    ${blockThemeSectionMarkup(draft, false)}
    ${stateColoringSectionMarkup(draft)}
    <details class="settings-section" open><summary>Telemetry</summary><div class="settings-body"><div class="toggle-grid"><label><input type="checkbox" data-upload-toggle="show_sent" ${draft.config.show_sent !== false ? "checked" : ""}>Show sent bytes</label><label><input type="checkbox" data-upload-toggle="show_speed" ${draft.config.show_speed !== false ? "checked" : ""}>Show aggregate speed</label><label><input type="checkbox" data-upload-toggle="show_elapsed" ${draft.config.show_elapsed !== false ? "checked" : ""}>Show elapsed time</label></div><div class="capability-note"><strong>Adaptive by ingest method</strong><span>Known totals use a determinate aggregate bar. FTP or agent transfers without totals automatically use an indeterminate bar and hide unavailable values.</span></div></div></details>
    <details class="settings-section" open><summary>Behavior</summary><div class="settings-body"><div class="toggle-grid behavior-toggles"><label><input type="checkbox" data-upload-idle ${draft.config.idle_behavior === "show_idle" ? "checked" : ""}>Show while idle</label></div><div class="range-list">${uploadRangeFields.map((field) => rangeControl(field, draft, templateForDraft(draft))).join("")}</div><div class="form-grid"><label class="wide">Idle label<input data-path="config.idle_label" maxlength="80" value="${escapeAttr(draft.config.idle_label || "WAITING FOR UPLOAD")}"></label></div></div></details>
  `;
}

function layoutSectionMarkup(draft, includeTelemetryColumns) {
  const template = templateForDraft(draft);
  const fields = draft.type === "upload_progress" ? uploadLayoutRangeFields : connectivityLayoutRangeFields;
  const growth = layoutGrowth(draft.layout);
  return `<details class="settings-section" open><summary>Layout</summary><div class="settings-body"><div class="layout-editor"><div class="layout-control-row"><div class="layout-control-group"><span class="layout-control-label">Anchor</span><div class="dock-grid" aria-label="Overlay anchor">${Object.entries(dockLabels).map(([id,label]) => `<button class="secondary ${draft.layout.dock === id ? "active" : ""}" data-dock="${id}" title="${escapeAttr(label)}" aria-label="${escapeAttr(label)}" type="button">${anchorIcon(id)}<span class="sr-only">${escapeHtml(label)}</span></button>`).join("")}</div></div><div class="layout-control-group"><span class="layout-control-label">Growth direction</span>${growthDpadMarkup(draft.layout, growth)}</div></div><div class="range-list">${fields.map((field) => rangeControl(field, draft, template)).join("")}${includeTelemetryColumns ? telemetryColumnsMarkup(draft) : ""}</div></div></div></details>`;
}

function growthDpadMarkup(layout, growth) {
  const active = activeGrowthDirection(layout, growth);
  return `<div class="growth-grid" role="group" aria-label="Overlay growth direction">${growthDirectionLabels.map(([id,label,icon]) => `<button class="secondary growth-button ${active === id ? "active" : ""}" data-growth-direction="${escapeAttr(id)}" title="${escapeAttr(id === "auto" ? "Auto growth from anchor" : `Grow ${label.toLowerCase()}`)}" aria-label="${escapeAttr(id === "auto" ? "Auto growth from anchor" : `Grow ${label.toLowerCase()}`)}" type="button" style="grid-area:${escapeAttr(id === "auto" ? "middle" : id)}"><span aria-hidden="true">${icon}</span><span class="sr-only">${escapeHtml(label)}</span></button>`).join("")}</div>`;
}

function activeGrowthDirection(layout, growth) {
  if (!layout.growth_x && !layout.growth_y) return "auto";
  if (growth.x === "center" && growth.y === "up") return "up";
  if (growth.x === "center" && growth.y === "down") return "down";
  if (growth.x === "left" && growth.y === "center") return "left";
  if (growth.x === "right" && growth.y === "center") return "right";
  if (growth.x === "center" && growth.y === "center") return "auto";
  return "";
}

function telemetryColumnsMarkup(draft) {
  const value = telemetryColumnsToSliderValue(draft.config.telemetry_columns);
  return `<div class="range-row wrap-slider-row"><label>Blocks per row <output id="telemetry-columns-output">${escapeHtml(telemetryColumnsLabel(draft.config.telemetry_columns))}</output></label><input type="range" min="0" max="9" step="1" value="${value}" data-telemetry-columns-range aria-label="Blocks per row"></div>`;
}

function blockThemeSectionMarkup(draft, includeBlockSizing) {
  const template = templateForDraft(draft);
  const blockRanges = includeBlockSizing ? [...blockSizeRangeFields, ...blockRangeFields] : blockRangeFields;
  return `<details class="settings-section" open><summary>Theme</summary><div class="settings-body"><div class="theme-group-grid">
    ${themeGroup("Panel", `<div class="theme-neutral-grid">${panelColorFields.map(([field,label]) => colorControl(field, label, draft, template)).join("")}</div><div class="range-list">${panelRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div>`)}
    ${themeGroup("Block", `<div class="theme-neutral-grid">${blockColorFields.map(([field,label]) => colorControl(field, label, draft, template)).join("")}</div><div class="range-list">${blockRanges.map((field) => rangeControl(field, draft, template)).join("")}</div>${includeBlockSizing ? blockDensityMarkup(draft) : ""}`)}
    ${themeGroup("Text", `${fontSelectControl("theme.font_family", "Font family", draft, template)}${colorControl("text_color", "Color", draft, template)}<div class="range-list">${textRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div>`)}
    ${themeGroup("Subheader", `${fontSelectControl("theme.subheader_font_family", "Font family", draft, template, "Inter, system-ui, sans-serif")}${colorControl("muted_color", "Color", draft, template)}<div class="range-list">${subheaderRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div>`)}
    ${draft.type === "connectivity" ? plotThemeMarkup(draft, template) : ""}
  </div></div></details>`;
}

function colorControl(field, label, draft, template) {
  return `<label>${escapeHtml(label)}<input type="color" data-color="${field}" value="${escapeAttr(colorInputValue(draft.theme[field] ?? template.theme?.[field]))}"></label>`;
}

function themeGroup(title, body) {
  return `<section class="theme-group"><h3>${escapeHtml(title)}</h3>${body}</section>`;
}

function fontSelectControl(path, label, draft, template, fallback = "Inter, system-ui, sans-serif") {
  const value = getPath(draft, path) ?? getPath(template, path) ?? fallback;
  return selectControl(path, label, fontFamilyOptions, value);
}

function plotThemeMarkup(draft, template) {
  return themeGroup("Plot", `<div class="theme-neutral-grid">${plotColorFields.map(([field,label]) => colorControl(field, label, draft, template)).join("")}</div><div class="range-list">${plotRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div><div class="form-grid plot-style-grid">${selectControl("config.chart_bitrate_line_style", "Bitrate line", lineStyleOptions, draft.config.chart_bitrate_line_style ?? template.config.chart_bitrate_line_style ?? "solid")}${selectControl("config.chart_rtt_line_style", "RTT line", lineStyleOptions, draft.config.chart_rtt_line_style ?? template.config.chart_rtt_line_style ?? "solid")}${selectControl("config.chart_warn_line_style", "Warn line", lineStyleOptions, draft.config.chart_warn_line_style ?? template.config.chart_warn_line_style ?? "dashed")}</div>`);
}

function selectControl(path, label, options, value) {
  return `<label>${escapeHtml(label)}<select data-select="${escapeAttr(path)}">${options.map(([id, name]) => `<option value="${escapeAttr(id)}" ${id === value ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label>`;
}

function colorInputValue(value, fallback = "#ffffff") {
  const text = String(value ?? fallback).trim();
  if (/^#[0-9a-f]{6}$/i.test(text)) return text;
  const short = text.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) return `#${short.slice(1).map((digit) => digit + digit).join("")}`;
  const rgb = text.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!rgb) return fallback;
  return `#${rgb.slice(1, 4).map((part) => Math.min(255, Number(part)).toString(16).padStart(2, "0")).join("")}`;
}

function blockDensityMarkup(draft) {
  const currentHeight = Number(draft.config.telemetry_block_height_px ?? 72);
  return `<div class="segmented-field"><span>Block density</span><div class="segmented-control density-control" role="group" aria-label="Block density">${blockDensityOptions.map(([id,label,height]) => `<button class="secondary ${Math.abs(currentHeight - Number(height)) <= 1 ? "active" : ""}" data-block-density="${escapeAttr(String(id))}" data-block-height="${height}" type="button">${escapeHtml(label)}</button>`).join("")}</div></div>`;
}

function stateColoringSectionMarkup(draft) {
  const template = templateForDraft(draft);
  return `<details class="settings-section" open><summary>State coloring</summary><div class="settings-body"><div class="state-theme-grid">${themeStateFields.map((field) => stateThemeRowMarkup(field, draft, template)).join("")}</div></div></details>`;
}

function stateThemeRowMarkup([stateId, label, colorField, opacityPath], draft, template) {
  return `<div class="state-theme-row" data-theme-state="${escapeAttr(stateId)}"><label>${escapeHtml(label)} color<input type="color" data-color="${escapeAttr(colorField)}" value="${escapeAttr(colorInputValue(draft.theme[colorField] ?? template.theme?.[colorField]))}"></label>${rangeControl([opacityPath, `${label} opacity`, 0, 1, .01], draft, template)}</div>`;
}

function connectivityTelemetryMarkup(draft) {
  return `<details class="settings-section" open><summary>Telemetry</summary><div class="settings-body"><div class="telemetry-order-head"><h3>Telemetry blocks</h3><span>Drag rows to reorder; uncheck rows to hide them.</span></div><div id="order-list" class="order-list telemetry-block-list"></div></div></details>`;
}

function advancedTimingMarkup(draft) {
  const template = templateForDraft(draft);
  return `<details id="chart-timing-section" class="settings-section" open ${draft.config.show_chart === false ? "hidden" : ""}><summary>Advanced timing</summary><div class="settings-body"><div class="toggle-grid"><label><input type="checkbox" data-toggle="show_chart_legend" ${draft.config.show_chart_legend !== false ? "checked" : ""}>Show chart legend</label></div><div class="sampling-group"><div class="sampling-head"><h3>Chart Sample Rates</h3><span id="sampling-window">${escapeHtml(samplingWindowLabel(draft.config.poll_ms, draft.config.history_len))} visible history</span></div><div class="range-list">${samplingRangeFields.map((field) => rangeControl(field, draft, template)).join("")}</div></div></div></details>`;
}

function bindDesignControls(type) {
  const template = templateForDraft(state.designDraft);
  mainContent.querySelectorAll("[data-path]").forEach((input) => input.addEventListener("input", () => {
    setPath(state.designDraft, input.dataset.path, input.value);
    designChanged(800);
  }));
  mainContent.querySelectorAll("[data-select]").forEach((input) => input.addEventListener("change", () => {
    setPath(state.designDraft, input.dataset.select, input.value);
    designChanged(0);
  }));
  mainContent.querySelectorAll("[data-dock]").forEach((button) => button.addEventListener("click", () => {
    state.designDraft.layout.dock = button.dataset.dock;
    delete state.designDraft.layout.growth_x;
    delete state.designDraft.layout.growth_y;
    designChanged(0);
    syncLayoutButtons();
  }));
  mainContent.querySelectorAll("[data-growth-direction]").forEach((button) => button.addEventListener("click", () => {
    const direction = button.dataset.growthDirection;
    const map = {
      up: { growth_x:"center", growth_y:"up" },
      down: { growth_x:"center", growth_y:"down" },
      left: { growth_x:"left", growth_y:"center" },
      right: { growth_x:"right", growth_y:"center" },
    };
    delete state.designDraft.layout.growth_x;
    delete state.designDraft.layout.growth_y;
    if (map[direction]) Object.assign(state.designDraft.layout, map[direction]);
    designChanged(0);
    syncLayoutButtons();
  }));
  mainContent.querySelectorAll("[data-range],[data-number]").forEach((input) => {
    input.addEventListener("input", () => updateRangeInput(input, false));
    input.addEventListener("change", () => updateRangeInput(input, true));
    input.addEventListener("pointerup", () => queueAutosave("design", 0));
  });
  mainContent.querySelectorAll("[data-reset]").forEach((button) => button.addEventListener("click", () => {
    const path = button.dataset.reset;
    const resetRange = mainContent.querySelector(`[data-range="${path}"]`);
    const value = getPath(template, path) ?? rangeFallback(path, state.designDraft, template, Number(resetRange?.min ?? 0));
    setPath(state.designDraft, path, value);
    setRangeInputs(path, value);
    updateSamplingWindow();
    if (path === "config.telemetry_block_height_px") syncBlockDensityButtons();
    designChanged(0);
  }));
  mainContent.querySelectorAll("[data-color]").forEach((input) => input.addEventListener("input", () => {
    state.designDraft.theme[input.dataset.color] = input.value;
    designChanged(500);
  }));
  if (type === "connectivity") {
    mainContent.querySelectorAll("[data-toggle]").forEach((input) => input.addEventListener("change", () => {
      state.designDraft.config[input.dataset.toggle] = input.checked;
      designChanged(0);
    }));
    mainContent.querySelector("[data-telemetry-columns-range]")?.addEventListener("input", (event) => {
      state.designDraft.config.telemetry_columns = sliderValueToTelemetryColumns(event.target.value);
      syncTelemetryColumnsSlider();
      designChanged(null);
    });
    mainContent.querySelector("[data-telemetry-columns-range]")?.addEventListener("change", (event) => {
      state.designDraft.config.telemetry_columns = sliderValueToTelemetryColumns(event.target.value);
      syncTelemetryColumnsSlider();
      designChanged(0);
    });
    mainContent.querySelector("[data-telemetry-columns-range]")?.addEventListener("pointerup", () => queueAutosave("design", 0));
    mainContent.querySelectorAll("[data-block-density]").forEach((button) => button.addEventListener("click", () => {
      const height = Number(button.dataset.blockHeight);
      state.designDraft.config.telemetry_block_height_px = height;
      setRangeInputs("config.telemetry_block_height_px", height);
      syncBlockDensityButtons();
      designChanged(0);
    }));
    mainContent.querySelectorAll("[data-behavior]").forEach((input) => input.addEventListener("change", () => {
      const behavior = input.dataset.behavior;
      if (behavior === "hide_when_offline") state.designDraft.config.no_signal_behavior = input.checked ? "hide" : "show_offline";
      else state.designDraft.config[behavior] = input.checked;
      designChanged(0);
    }));
    bindBitrateLevelControls(template);
    bindRttLevelControls(template);
    renderOrder();
  } else {
    mainContent.querySelectorAll("[data-upload-toggle]").forEach((input) => input.addEventListener("change", () => {
      state.designDraft.config[input.dataset.uploadToggle] = input.checked;
      designChanged(0);
    }));
    mainContent.querySelector("[data-upload-idle]")?.addEventListener("change", (event) => {
      state.designDraft.config.idle_behavior = event.target.checked ? "show_idle" : "hide";
      designChanged(0);
    });
  }
}

function updateRangeInput(input, saveNow) {
  const path = input.dataset.range || input.dataset.number;
  const value = clampNumericValue(input.value, input.min, input.max, input.step);
  setPath(state.designDraft, path, value);
  setRangeInputs(path, value);
  updateSamplingWindow();
  if (path === "config.telemetry_block_height_px") syncBlockDensityButtons();
  designChanged(saveNow ? 0 : null);
}

function setRangeInputs(path, value) {
  const range = mainContent.querySelector(`[data-range="${path}"]`);
  const number = mainContent.querySelector(`[data-number="${path}"]`);
  if (range) range.value = value;
  if (number) number.value = value;
}

function syncLayoutButtons() {
  const growth = layoutGrowth(state.designDraft.layout);
  mainContent.querySelectorAll("[data-dock]").forEach((button) => button.classList.toggle("active", state.designDraft.layout.dock === button.dataset.dock));
  const active = activeGrowthDirection(state.designDraft.layout, growth);
  mainContent.querySelectorAll("[data-growth-direction]").forEach((button) => button.classList.toggle("active", active === button.dataset.growthDirection));
}

function designChanged(delay) {
  sendPreview();
  if (delay !== null) queueAutosave("design", delay);
}

function queueAutosave(kind, delay = 500) {
  state.pendingSave.add(kind);
  setSaveStatus("saving", "Saving...");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushAutosave, delay);
}

async function flushAutosave() {
  if (!state.pendingSave.size) return;
  if (state.saveInFlight) return;
  state.saveInFlight = true;
  clearTimeout(state.saveTimer);
  const kinds = new Set(state.pendingSave);
  state.pendingSave.clear();
  try {
    if (kinds.has("source")) await saveSourceDraft();
    if (kinds.has("design")) await saveDesignDraft();
    setSaveStatus("saved", "Saved");
  } catch (error) {
    setSaveStatus("error", "Save failed");
    showNotice(error.message, true);
  } finally {
    state.saveInFlight = false;
    if (state.pendingSave.size) flushAutosave();
  }
}

async function saveSourceDraft() {
  const result = await api(`/overlays/api/sources/${encodeURIComponent(state.sourceDraft.id)}`, { method:"PUT", headers:{ "If-Match":String(state.catalog.revision) }, body:JSON.stringify(state.sourceDraft) });
  state.catalog.revision = result.revision;
  const index = state.catalog.sources.findIndex((source) => source.id === result.source.id);
  if (index >= 0) state.catalog.sources[index] = result.source;
  state.sourceDraft = structuredClone(result.source);
  renderTabs();
  renderPreview();
}

async function saveDesignDraft() {
  const result = await api(`/overlays/api/presets/${encodeURIComponent(state.designDraft.id)}`, { method:"PUT", headers:{ "If-Match":String(state.catalog.revision) }, body:JSON.stringify({ preset:state.designDraft }) });
  state.catalog.revision = result.revision;
  const index = state.catalog.presets.findIndex((preset) => preset.id === result.preset.id);
  if (index >= 0) state.catalog.presets[index] = result.preset;
  state.designDraft = structuredClone(result.preset);
  renderPreview();
}

function setSaveStatus(kind, text) {
  saveStatus.textContent = text;
  saveStatus.className = `status-pill ${text ? kind : "hidden"}`;
}

function renderPreview() {
  const source = selectedSource();
  if (!source || !state.designDraft) {
    setPreviewVisible(false);
    preview.removeAttribute("src");
    state.previewFrameSize = null;
    return;
  }
  setPreviewVisible(true);
  fakePreviewToggle.checked = state.fakePreview;
  updatePreviewCaption();
  state.previewFrameSize = null;
  applyPreviewScale();
  const nextSrc = state.fakePreview ? previewPresetUrl(state.designDraft.id) : previewSourceUrl(source);
  if (preview.getAttribute("src") !== nextSrc) preview.src = nextSrc;
  else sendPreview();
}

function sendPreview() {
  if (!state.designDraft) return;
  preview.contentWindow?.postMessage({
    type:"frame-preview",
    preset:state.designDraft,
    stream_display_name:state.sourceDraft?.display_name || state.designDraft.name,
    ...(state.sourceDraft ? { source:state.sourceDraft } : {}),
  }, previewTargetOrigin());
}

function updatePreviewCaption() {
  const type = state.designDraft?.type;
  const sourceText = state.fakePreview ? (type === "upload_progress" ? "Sample upload data" : "Sample telemetry data") : "Live source URL";
  const size = state.previewFrameSize;
  const sizeText = size ? ` - ${size.contentWidth} x ${size.contentHeight}` : "";
  previewCaption.textContent = `${sourceText}${sizeText}`;
}

function applyPreviewScale() {
  const size = state.previewFrameSize || { width: 520, height: 240 };
  const shellRect = previewFrameShell.getBoundingClientRect();
  const availableWidth = Math.max(220, shellRect.width - 24);
  const desktopPreviewColumn = window.matchMedia("(min-width: 901px)").matches;
  const maxPreviewHeight = Math.max(180, Math.min(window.innerHeight * (desktopPreviewColumn ? 0.62 : 0.44), desktopPreviewColumn ? 620 : 360));
  const scale = Math.min(1, availableWidth / size.width, maxPreviewHeight / size.height);
  const scaledWidth = Math.max(1, Math.ceil(size.width * scale));
  const scaledHeight = Math.max(1, Math.ceil(size.height * scale));
  preview.style.width = `${size.width}px`;
  preview.style.height = `${size.height}px`;
  preview.style.transform = `scale(${scale})`;
  previewScaleShell.style.width = `${scaledWidth}px`;
  previewScaleShell.style.height = `${scaledHeight}px`;
  previewScaleShell.style.setProperty("--preview-scale", String(scale));
}

function setPreviewVisible(visible) {
  previewDock.classList.toggle("hidden", !visible);
  document.body.classList.toggle("has-preview", visible);
}

async function resetSourceDesign() {
  const confirmed = await confirmAction({
    title:"Reset visual settings?",
    subtitle:"Source URL and data binding stay unchanged.",
    body:"This restores layout, behavior, telemetry display, and theme controls from the base template.",
    confirmText:"Reset visuals",
  });
  if (!confirmed) return;
  const template = templateForDraft(state.designDraft);
  const base = designFrom(template);
  state.designDraft = {
    ...state.designDraft,
    layout: structuredClone(base.layout),
    theme: structuredClone(base.theme),
    config: structuredClone(base.config),
    window_title: base.window_title,
    description: base.description,
  };
  await saveDesignDraft();
  showNotice("Visual settings reset.");
  renderSelectedSource();
}

async function deleteSource() {
  const source = selectedSource();
  const confirmed = await confirmAction({
    title:`Delete ${source.display_name}?`,
    subtitle:"The OBS URL will stop working.",
    body:"This deletes the source and its hidden visual configuration. Stream profiles and upload adapters are not changed.",
    confirmText:"Delete source",
    danger:true,
  });
  if (!confirmed) return;
  try {
    await api(`/overlays/api/sources/${encodeURIComponent(source.id)}`, { method:"DELETE", headers:{ "If-Match":String(state.catalog.revision) } });
    showNotice("OBS source deleted.");
    state.selectedSourceId = null;
    await load();
  } catch (error) {
    showNotice(error.message, true);
  }
}

function confirmAction({ title, subtitle = "", body, confirmText, danger = false }) {
  confirmTitle.textContent = title;
  confirmSubtitle.textContent = subtitle;
  confirmBody.textContent = body;
  confirmAccept.textContent = confirmText;
  confirmAccept.classList.toggle("danger", danger);
  confirmDialog.showModal();
  return new Promise((resolve) => { state.confirmResolve = resolve; });
}

function resolveConfirm(value) {
  if (confirmDialog.open) confirmDialog.close();
  state.confirmResolve?.(value);
  state.confirmResolve = null;
}

function openAddStream() {
  window.location.href = "http://localhost/slsui#add-stream";
}

function sortedSources() {
  return (state.catalog?.sources || []).slice().sort((a, b) => a.display_name.localeCompare(b.display_name, undefined, { sensitivity:"base", numeric:true }));
}

function selectedSource() {
  return state.catalog?.sources.find((source) => source.id === state.selectedSourceId) || null;
}

function findPreset(id) {
  return state.catalog.presets.find((preset) => preset.id === id);
}

function templateForDraft(draft) {
  return state.catalog.templates.find((template) => template.id === draft.template_id) || state.catalog.templates.find((template) => template.type === draft.type) || state.catalog.templates[0];
}

function typeLabel(type) {
  return type === "upload_progress" ? "Upload progress" : "SRT stream";
}

function createSourceKey(dataSource) {
  if (!dataSource) return "";
  if (dataSource.data_source.kind === "stream") return `stream:${dataSource.data_source.stream_profile_id}`;
  return `upload:${dataSource.data_source.adapters?.[0] || "web_upload"}`;
}

function sameIdentity(a, b) {
  return String(a || "").trim().toLocaleLowerCase("en-US") === String(b || "").trim().toLocaleLowerCase("en-US");
}

function compareStream(a, b) {
  return (a.description || a.source_label || a.player || "").localeCompare(b.description || b.source_label || b.player || "", undefined, { sensitivity:"base", numeric:true });
}

function sourceUrl(source) {
  return `${state.config.public_base_url}/overlays/view/${encodeURIComponent(source.slug)}/${encodeURIComponent(source.source_key)}`;
}

function previewPresetUrl(presetId) {
  return `/overlays/api/preview/${encodeURIComponent(presetId)}?preview=1&elementPreview=1`;
}

function previewSourceUrl(source) {
  return `/overlays/view/${encodeURIComponent(source.slug)}/${encodeURIComponent(source.source_key)}?elementPreview=1`;
}

function previewTargetOrigin() {
  try {
    return new URL(preview.getAttribute("src") || location.href, location.href).origin;
  } catch {
    return location.origin;
  }
}

function isTrustedPreviewOrigin(origin) {
  if (origin === location.origin) return true;
  try {
    return origin === new URL(state.config.public_base_url).origin;
  } catch {
    return false;
  }
}

function sourceCapabilityNotice(streamProfileId) {
  const stream = state.streams.find((item) => item.player === streamProfileId);
  if (!streamProfileId) return `<div class="capability-note"><strong>Unbound source</strong><span>This OBS URL stays valid. Choose a new stream when you are ready.</span></div>`;
  if (stream?.source_type !== "custom") return "";
  return `<div class="capability-note"><strong>BELABOX-aware rendering</strong><span>This feed does not publish every metric. Unavailable telemetry cards and chart lines are hidden automatically.</span></div>`;
}

function bitrateLevelControl(draft, template) {
  const levels = readBitrateLevels(draft);
  const defaults = readBitrateLevels(template);
  const warnColor = draft.theme.warn_color || "#ffd166";
  const goodColor = draft.theme.good_color || "#2cb4fb";
  const maxColor = draft.theme.plot_primary || "#8de7ff";
  return `<div class="bitrate-level-control" data-bitrate-control style="--warn-position:${levelPercent(levels.warn)}%;--good-position:${levelPercent(levels.good)}%;--max-position:${levelPercent(levels.max)}%;--warn-level:${escapeAttr(warnColor)};--good-level:${escapeAttr(goodColor)};--max-level:${escapeAttr(maxColor)}">
    <div class="bitrate-level-caption">Set Bitrate levels (<span><i style="background:${escapeAttr(warnColor)}"></i>Warn</span>, <span><i style="background:${escapeAttr(goodColor)}"></i>Good</span>, <span><i style="background:${escapeAttr(maxColor)}"></i>Max</span>)</div>
    <div class="multi-range" aria-label="Bitrate quality levels"><div class="multi-range-track"></div>${["warn","good","max"].map((level) => `<input class="level-${level}" type="range" min="0" max="${BITRATE_LEVEL_MAX}" step="${BITRATE_LEVEL_STEP}" value="${levels[level]}" data-bitrate-range="${level}" aria-label="${humanize(level)} bitrate level">`).join("")}</div>
    <div class="bitrate-level-values">${["warn","good","max"].map((level) => `<label>${humanize(level)}<input type="number" min="0" max="${BITRATE_LEVEL_MAX}" step="${BITRATE_LEVEL_STEP}" value="${levels[level]}" data-bitrate-number="${level}"></label>`).join("")}<button class="icon-reset" data-reset-bitrate type="button" data-default-warn="${defaults.warn}" data-default-good="${defaults.good}" data-default-max="${defaults.max}" aria-label="Reset bitrate levels" title="Reset bitrate levels">${icons.reset}</button></div>
  </div>`;
}

function bindBitrateLevelControls(template) {
  mainContent.querySelectorAll("[data-bitrate-range],[data-bitrate-number]").forEach((input) => {
    input.addEventListener("input", () => {
      const changed = input.dataset.bitrateRange || input.dataset.bitrateNumber;
      const levels = readBitrateLevels(state.designDraft);
      levels[changed] = Number(input.value);
      applyBitrateLevels(state.designDraft, clampBitrateLevels(levels, changed));
      syncBitrateLevelControl();
      designChanged(null);
    });
    input.addEventListener("change", () => queueAutosave("design", 0));
    input.addEventListener("pointerup", () => queueAutosave("design", 0));
  });
  mainContent.querySelector("[data-reset-bitrate]")?.addEventListener("click", () => {
    applyBitrateLevels(state.designDraft, readBitrateLevels(template));
    syncBitrateLevelControl();
    designChanged(0);
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
    <div class="multi-range" aria-label="RTT quality levels"><div class="multi-range-track"></div>${["good","bad","max"].map((level) => `<input class="level-${level}" type="range" min="0" max="${RTT_LEVEL_MAX}" step="${RTT_LEVEL_STEP}" value="${levels[level]}" data-rtt-range="${level}" aria-label="${humanize(level)} RTT level">`).join("")}</div>
    <div class="bitrate-level-values">${["good","bad","max"].map((level) => `<label>${humanize(level)} (ms)<input type="number" min="0" max="${RTT_LEVEL_MAX}" step="${RTT_LEVEL_STEP}" value="${levels[level]}" data-rtt-number="${level}"></label>`).join("")}<button class="icon-reset" data-reset-rtt type="button" data-default-good="${defaults.good}" data-default-bad="${defaults.bad}" data-default-max="${defaults.max}" aria-label="Reset RTT levels" title="Reset RTT levels">${icons.reset}</button></div>
  </div>`;
}

function bindRttLevelControls(template) {
  mainContent.querySelectorAll("[data-rtt-range],[data-rtt-number]").forEach((input) => {
    input.addEventListener("input", () => {
      const changed = input.dataset.rttRange || input.dataset.rttNumber;
      const levels = readRttLevels(state.designDraft);
      levels[changed] = Number(input.value);
      applyRttLevels(state.designDraft, clampRttLevels(levels, changed));
      syncRttLevelControl();
      designChanged(null);
    });
    input.addEventListener("change", () => queueAutosave("design", 0));
    input.addEventListener("pointerup", () => queueAutosave("design", 0));
  });
  mainContent.querySelector("[data-reset-rtt]")?.addEventListener("click", () => {
    applyRttLevels(state.designDraft, readRttLevels(template));
    syncRttLevelControl();
    designChanged(0);
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
  const levels = readBitrateLevels(state.designDraft);
  const control = mainContent.querySelector("[data-bitrate-control]");
  for (const level of ["warn","good","max"]) {
    mainContent.querySelector(`[data-bitrate-range="${level}"]`).value = levels[level];
    mainContent.querySelector(`[data-bitrate-number="${level}"]`).value = levels[level];
    control.style.setProperty(`--${level}-position`, `${levelPercent(levels[level])}%`);
  }
}

function syncRttLevelControl() {
  const levels = readRttLevels(state.designDraft);
  const control = mainContent.querySelector("[data-rtt-control]");
  for (const level of ["good","bad","max"]) {
    mainContent.querySelector(`[data-rtt-range="${level}"]`).value = levels[level];
    mainContent.querySelector(`[data-rtt-number="${level}"]`).value = levels[level];
    control.style.setProperty(`--${level}-position`, `${rttLevelPercent(levels[level])}%`);
  }
}

function levelPercent(value) { return (Number(value) / BITRATE_LEVEL_MAX) * 100; }
function rttLevelPercent(value) { return (Number(value) / RTT_LEVEL_MAX) * 100; }

function rangeControl([path,label,min,max,step], draft, template) {
  const value = getPath(draft, path) ?? getPath(template, path) ?? rangeFallback(path, draft, template, min);
  return `<div class="range-row"><label>${escapeHtml(label)}</label><input type="range" min="${min}" max="${max}" step="${step}" value="${escapeAttr(value)}" data-range="${escapeAttr(path)}"><input type="number" min="${min}" max="${max}" step="${step}" value="${escapeAttr(value)}" data-number="${escapeAttr(path)}" aria-label="${escapeAttr(label)} value"><button class="icon-reset" data-reset="${escapeAttr(path)}" title="Reset ${escapeAttr(label)}" aria-label="Reset ${escapeAttr(label)}" type="button">${icons.reset}</button></div>`;
}

function rangeFallback(path, draft, template, min) {
  if (path === "theme.panel_bg_alpha" || path === "theme.block_bg_alpha") return 1;
  return min;
}

function updateSamplingWindow() {
  const output = mainContent.querySelector("#sampling-window");
  if (output) output.textContent = `${samplingWindowLabel(state.designDraft.config.poll_ms, state.designDraft.config.history_len)} visible history`;
}

function renderOrder() {
  const available = telemetryBlocksForSelectedSource();
  const order = [...new Set([...(state.designDraft.config.telemetry_order || []), ...defaultOrder])].filter((id) => available.has(id));
  state.designDraft.config.telemetry_order = order;
  const list = mainContent.querySelector("#order-list");
  if (!list) return;
  list.innerHTML = order.map((id,index) => {
    const block = telemetryBlockMap.get(id) || { label:humanize(id), fields:[] };
    const checked = block.fields.length ? block.fields.some((field) => state.designDraft.config[field] !== false) : true;
    return `<div class="order-item" draggable="true" data-order-index="${index}" data-order-id="${escapeAttr(id)}"><span class="drag-handle" aria-hidden="true">${icons.grip}</span><label class="order-toggle"><input type="checkbox" data-telemetry-visible="${escapeAttr(id)}" ${checked ? "checked" : ""}>${escapeHtml(block.label)}</label><div class="order-actions"><button class="icon-reset order-move" data-up="${index}" ${index === 0 ? "disabled" : ""} aria-label="Move ${escapeAttr(block.label)} up" title="Move up" type="button">${icons.arrowUp}</button><button class="icon-reset order-move" data-down="${index}" ${index === order.length - 1 ? "disabled" : ""} aria-label="Move ${escapeAttr(block.label)} down" title="Move down" type="button">${icons.arrowDown}</button></div></div>`;
  }).join("");
  list.querySelectorAll("[data-up]").forEach((button) => button.addEventListener("click", () => moveOrder(Number(button.dataset.up), -1)));
  list.querySelectorAll("[data-down]").forEach((button) => button.addEventListener("click", () => moveOrder(Number(button.dataset.down), 1)));
  list.querySelectorAll("[data-telemetry-visible]").forEach((input) => input.addEventListener("change", () => {
    setTelemetryBlockVisible(input.dataset.telemetryVisible, input.checked);
    designChanged(0);
  }));
  bindTelemetryDrag(list);
}

function telemetryBlocksForSelectedSource() {
  const streamId = state.sourceDraft?.data_source?.kind === "stream" ? state.sourceDraft.data_source.stream_profile_id : null;
  const stream = state.streams.find((item) => item.player === streamId);
  return stream?.source_type === "custom" ? customTelemetryBlocks : new Set(defaultOrder);
}

function moveOrder(index, delta) {
  const order = state.designDraft.config.telemetry_order;
  if (index + delta < 0 || index + delta >= order.length) return;
  [order[index], order[index + delta]] = [order[index + delta], order[index]];
  renderOrder();
  designChanged(0);
}

function moveOrderTo(fromIndex, toIndex) {
  const order = state.designDraft.config.telemetry_order;
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= order.length || toIndex >= order.length) return;
  const [item] = order.splice(fromIndex, 1);
  order.splice(toIndex, 0, item);
  renderOrder();
  designChanged(0);
}

function setTelemetryBlockVisible(id, visible) {
  const block = telemetryBlockMap.get(id);
  if (!block) return;
  for (const field of block.fields) state.designDraft.config[field] = visible;
  if (id === "chart") syncChartTimingVisibility();
}

function bindTelemetryDrag(list) {
  let draggedIndex = null;
  const clearDragState = () => list.querySelectorAll(".dragging,.drag-over").forEach((row) => row.classList.remove("dragging", "drag-over"));
  list.querySelectorAll("[data-order-index]").forEach((row) => {
    row.addEventListener("dragstart", (event) => {
      draggedIndex = Number(row.dataset.orderIndex);
      row.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(draggedIndex));
    });
    row.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (!row.classList.contains("dragging")) row.classList.add("drag-over");
    });
    row.addEventListener("dragleave", () => row.classList.remove("drag-over"));
    row.addEventListener("drop", (event) => {
      event.preventDefault();
      const fromIndex = Number(event.dataTransfer.getData("text/plain") || draggedIndex);
      const toIndex = Number(row.dataset.orderIndex);
      clearDragState();
      moveOrderTo(fromIndex, toIndex);
    });
    row.addEventListener("dragend", clearDragState);
  });
}

function anchorIcon(value) {
  if (value === "c") {
    return `<svg class="anchor-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/><circle cx="12" cy="12" r="3"/></svg>`;
  }
  const target = { tl:[5,5], t:[12,5], tr:[19,5], l:[5,12], r:[19,12], bl:[5,19], b:[12,19], br:[19,19] }[value] || [19,19];
  return `<svg class="anchor-icon" viewBox="0 0 24 24" aria-hidden="true"><path class="anchor-arrow" d="M12 12L${target[0]} ${target[1]}"/><circle cx="12" cy="12" r="1.2"/><circle cx="${target[0]}" cy="${target[1]}" r="2.4"/></svg>`;
}

function telemetryColumnsToSliderValue(value) {
  if (value === "all") return 9;
  if (value === "auto" || value === null || value === undefined) return 0;
  const numeric = Math.round(Number(value));
  return Number.isFinite(numeric) ? Math.min(8, Math.max(1, numeric)) : 0;
}

function sliderValueToTelemetryColumns(value) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return "auto";
  if (numeric >= 9) return "all";
  return Math.min(8, Math.max(1, numeric));
}

function telemetryColumnsLabel(value) {
  const sliderValue = telemetryColumnsToSliderValue(value);
  if (sliderValue === 0) return "Auto";
  if (sliderValue === 9) return "All";
  return String(sliderValue);
}

function syncTelemetryColumnsSlider() {
  const range = mainContent.querySelector("[data-telemetry-columns-range]");
  const output = mainContent.querySelector("#telemetry-columns-output");
  if (range) range.value = telemetryColumnsToSliderValue(state.designDraft.config.telemetry_columns);
  if (output) output.textContent = telemetryColumnsLabel(state.designDraft.config.telemetry_columns);
}

function syncBlockDensityButtons() {
  const currentHeight = Number(state.designDraft.config.telemetry_block_height_px ?? 72);
  mainContent.querySelectorAll("[data-block-density]").forEach((button) => {
    button.classList.toggle("active", Math.abs(currentHeight - Number(button.dataset.blockHeight)) <= 1);
  });
}

function syncChartTimingVisibility() {
  const section = mainContent.querySelector("#chart-timing-section");
  if (section) section.hidden = state.designDraft.config.show_chart === false;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers:{ "Content-Type":"application/json", ...(options.headers || {}) } });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({ error:`Request failed (${response.status})` }));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.current_revision = body.current_revision;
    throw error;
  }
  return body;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const area = document.createElement("textarea");
  area.value = value;
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.remove("hidden", "error");
  notice.classList.toggle("error", isError);
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => notice.classList.add("hidden"), 6000);
}

function designFrom(template) {
  const design = structuredClone(template);
  delete design.id;
  delete design.builtin;
  delete design.readonly;
  return design;
}

function getPath(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function setPath(object, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((current, key) => current[key] ??= {}, object);
  target[last] = value;
}

function humanize(value) {
  return value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-").slice(0, 64);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}
