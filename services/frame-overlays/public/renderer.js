import { QUALITY, QualityStabilizer, canvasPixelSize, normalizedTelemetryBlockWidth, normalizedTelemetryOrder, qualityStatusText, resolvedTelemetryColumnCount, shouldResetRuntimeState, telemetryAvailability, telemetryGridPixelWidth, telemetryIsStale } from "./renderer-core.js";

let payload = window.FRAME_OVERLAY;
let preset = payload.preset;
let config = preset.config || {};
let theme = preset.theme || {};
let streamDisplayName = payload.stream_display_name || payload.source?.display_name || preset.name || "FRAME Stream";
let quality = new QualityStabilizer();
let eventSource;
let restTimer;
let settingsTimer;
let restInflight = false;
let lastTelemetry;
const history = [];
const defaultOrder = ["header", "bitrate", "rtt", "latency", "buffer", "server", "dropped", "uptime", "meter", "chart", "recovery"];
const telemetryGridGapPx = 7;
const telemetryWidgetChromePx = 30;
const widget = document.querySelector("#widget");
const layout = document.querySelector("#telemetry-layout");
const widgetHead = document.querySelector("#widget-head");
const statusValue = document.querySelector("#status-value");
const streamName = document.querySelector("#stream-name");
const meterFill = document.querySelector("#meter-fill");
const chart = document.querySelector("#chart");
const chartWarnValue = document.querySelector("#chart-warn-value");
const chartRttValue = document.querySelector("#chart-rtt-value");
const chartRttLegend = document.querySelector(".rtt-line");
const context = chart.getContext("2d");
const blocks = new Map([...layout.querySelectorAll("[data-block]")].map((element) => [element.dataset.block, element]));
const values = new Map([...layout.querySelectorAll("[data-value]")].map((element) => [element.dataset.value, element]));
const query = new URLSearchParams(location.search);
const previewMode = query.has("preview");
const elementPreviewMode = query.has("elementPreview");

if (previewMode) document.body.classList.add("preview");
if (elementPreviewMode) document.body.classList.add("element-preview");
applyPayload(payload);
if (!previewMode) connectEvents();
else acceptTelemetry({
  sequence: 1,
  observed_at: new Date().toISOString(),
  received_at: new Date().toISOString(),
  stale: false,
  connected: true,
  publisher: { connected:true, bitrate:7200, rtt:68, latency:120, buffer:80, dropped_pkts:2, uptime:7320, recovery_rate:1.4 },
});
setInterval(renderLastTelemetry, 1000);
window.addEventListener("resize", () => {
  applyTelemetryColumns();
  drawChart();
  publishPreviewSize();
});
new ResizeObserver(drawChart).observe(chart);
if (elementPreviewMode) new ResizeObserver(publishPreviewSize).observe(widget);
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "frame-preview" || !event.data.preset) return;
  applyPayload({ ...payload, ...event.data });
});

function applyPayload(next) {
  if (shouldResetRuntimeState(payload, next)) {
    history.length = 0;
    quality = new QualityStabilizer();
    lastTelemetry = undefined;
  }
  payload = next;
  preset = payload.preset;
  config = preset.config || {};
  theme = preset.theme || {};
  streamDisplayName = payload.stream_display_name || payload.source?.display_name || preset.name || "FRAME Stream";
  applyTheme();
  applyLayout();
  applyBlockVisibility(false, quality.stable, lastTelemetry?.publisher);
  renderLastTelemetry();
  publishPreviewSize();
}

function connectEvents() {
  eventSource?.close();
  if (!payload.events_url || !("EventSource" in window)) return startRestFallback();
  eventSource = new EventSource(payload.events_url);
  eventSource.addEventListener("open", stopRestFallback);
  eventSource.addEventListener("telemetry", (event) => { stopRestFallback(); acceptTelemetry(JSON.parse(event.data)); });
  eventSource.addEventListener("config", (event) => applyPayload(JSON.parse(event.data)));
  eventSource.addEventListener("source-error", (event) => renderNoSignal(JSON.parse(event.data).error || "SOURCE UNAVAILABLE"));
  eventSource.onerror = startRestFallback;
  clearInterval(settingsTimer);
  settingsTimer = setInterval(refreshSettings, 15_000);
}

function startRestFallback() {
  if (restTimer) return;
  void refreshTelemetry();
  restTimer = setInterval(refreshTelemetry, config.poll_ms || 1000);
}

function stopRestFallback() {
  clearInterval(restTimer);
  restTimer = undefined;
}

async function refreshTelemetry() {
  if (restInflight || !payload.stats_url) return;
  restInflight = true;
  try {
    const response = await fetch(payload.stats_url, { cache: "no-store" });
    if (response.ok) acceptTelemetry(await response.json());
  } finally { restInflight = false; }
}

async function refreshSettings() {
  try {
    const response = await fetch(payload.settings_url, { cache: "no-store" });
    if (!response.ok) return;
    const next = await response.json();
    if (next.revision !== payload.revision) applyPayload(next);
  } catch { /* Last-known configuration remains active while SSE reconnects. */ }
}

function acceptTelemetry(snapshot) {
  if (lastTelemetry && snapshot.sequence < lastTelemetry.sequence) return;
  lastTelemetry = snapshot;
  renderLastTelemetry();
}

function renderLastTelemetry() {
  if (preset.enabled === false || payload.source?.enabled === false) return widget.classList.add("hidden");
  if (!lastTelemetry) return renderNoSignal("CONNECTING", false);
  if (lastTelemetry.error?.includes("not bound")) return renderNoSignal("UNBOUND");
  if ((!previewMode && telemetryIsStale(lastTelemetry, config.poll_ms || 1000)) || !lastTelemetry.publisher || lastTelemetry.publisher.connected === false) {
    return renderNoSignal(config.no_signal_label || "NO SIGNAL");
  }
  renderStats(lastTelemetry.publisher);
}

function renderStats(stats) {
  widget.classList.remove("hidden");
  const stable = quality.update(stats, config);
  const display = stable === QUALITY.UNKNOWN ? QUALITY.WARN : stable;
  const compactGood = config.compact_when_good && stable === QUALITY.GOOD;
  document.documentElement.style.setProperty("--quality", colorFor(display));
  document.documentElement.style.setProperty("--widget-opacity", String(opacityFor(display)));
  statusValue.textContent = qualityStatusText(stable, stats, config, compactGood);
  streamName.textContent = streamDisplayName;
  values.get("bitrate").textContent = formatBitrate(stats.bitrate);
  values.get("rtt").textContent = formatMilliseconds(stats.rtt);
  values.get("latency").textContent = formatMilliseconds(stats.latency);
  values.get("buffer").textContent = formatMilliseconds(stats.buffer);
  values.get("server").textContent = payload.server_name || "FRAME";
  values.get("dropped").textContent = String(stats.dropped_pkts ?? 0);
  values.get("uptime").textContent = formatDuration(stats.uptime ?? 0);
  values.get("recovery").textContent = formatRecovery(stats.recovery_rate);
  meterFill.style.width = `${Math.min(100, Math.max(0, (Number(stats.bitrate || 0) / (config.bitrate_meter_max || 12000)) * 100))}%`;
  applyBlockVisibility(compactGood, stable, stats);
  applyBlockOrder();
  history.push({ bitrate: Number(stats.bitrate || 0), rtt: Number.isFinite(Number(stats.rtt)) ? Number(stats.rtt) : null });
  while (history.length > (config.history_len || 10)) history.shift();
  drawChart();
  publishPreviewSize();
  widget.hidden = false;
}

function renderNoSignal(label, confirmed = true) {
  if (confirmed && config.no_signal_behavior === "hide") return widget.classList.add("hidden");
  widget.classList.remove("hidden");
  document.documentElement.style.setProperty("--quality", confirmed ? theme.bad_color || "#ff5f6d" : theme.warn_color || "#ffd166");
  document.documentElement.style.setProperty("--widget-opacity", String(confirmed ? theme.bg_opacity_bad ?? 0.72 : theme.bg_opacity_warn ?? 0.5));
  statusValue.textContent = label;
  streamName.textContent = streamDisplayName;
  applyHeaderVisibility();
  for (const [id, block] of blocks) block.hidden = id !== "header";
  applyBlockOrder();
  applyTelemetryColumns();
  publishPreviewSize();
}

function applyHeaderVisibility(forceStatus = false) {
  const showStatus = forceStatus || config.show_status !== false;
  const showName = config.show_name !== false;
  widgetHead.hidden = !showStatus && !showName;
  widgetHead.querySelector(".signal-dot").hidden = !showStatus;
  statusValue.hidden = !showStatus;
  streamName.hidden = !showName;
}

function applyBlockVisibility(compact, stableQuality, stats) {
  const available = telemetryAvailability(stats);
  const showCompactBitrate = compact
    && stableQuality === QUALITY.GOOD
    && config.show_bitrate !== false
    && config.show_bitrate_in_good !== false
    && available.bitrate;
  applyHeaderVisibility(showCompactBitrate);
  const visible = {
    bitrate: config.show_bitrate && available.bitrate && (stableQuality !== QUALITY.GOOD || config.show_bitrate_in_good !== false),
    rtt: config.show_rtt && available.rtt,
    latency: config.show_latency && available.latency,
    buffer: config.show_buffer && available.buffer,
    server: config.show_server && available.server,
    dropped: config.show_dropped && available.dropped,
    uptime: config.show_uptime && available.uptime,
    recovery: config.show_recovery && available.recovery,
    meter: config.show_meter && available.meter,
    chart: config.show_chart && available.chart,
  };
  for (const [id, isVisible] of Object.entries(visible)) blocks.get(id).hidden = compact || !isVisible;
  chartRttLegend.hidden = !available.rtt;
  applyTelemetryColumns();
}

function applyBlockOrder() {
  for (const id of normalizedTelemetryOrder(config.telemetry_order, defaultOrder)) {
    const block = blocks.get(id);
    if (block) layout.append(block);
  }
}

function drawChart() {
  if (blocks.get("chart").hidden) return;
  const rect = chart.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const pixels = canvasPixelSize(rect.width, rect.height, devicePixelRatio);
  if (chart.width !== pixels.width || chart.height !== pixels.height) { chart.width = pixels.width; chart.height = pixels.height; }
  context.setTransform(pixels.ratio, 0, 0, pixels.ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  context.globalAlpha = 0.3;
  context.strokeStyle = theme.muted_color || "#9fc6dc";
  context.lineWidth = 1;
  context.beginPath(); context.moveTo(0, rect.height - 1); context.lineTo(rect.width, rect.height - 1); context.stroke();
  const bitrateMax = config.bitrate_meter_max || config.chart_bitrate_max || 12000;
  const rttMax = Math.min(5000, Math.max(500, config.chart_rtt_max || (config.rtt_bad_max || 3500) * 1.25));
  drawGuide(config.bitrate_warn_min ?? 2500, bitrateMax, theme.warn_color || "#ffd166", rect.width, rect.height);
  drawLine("bitrate", bitrateMax, theme.plot_primary || "#2cb4fb", rect.width, rect.height);
  if (!chartRttLegend.hidden) drawLine("rtt", rttMax, theme.plot_secondary || "#8de7ff", rect.width, rect.height);
  chartWarnValue.textContent = formatBitrate(config.bitrate_warn_min ?? 2500);
  chartRttValue.textContent = `0–${formatMilliseconds(rttMax)}`;
  context.globalAlpha = 1;
}

function drawGuide(value, max, color, width, height) {
  const y = height - Math.min(1, value / max) * (height - 8) - 4;
  context.save(); context.globalAlpha = .75; context.strokeStyle = color; context.lineWidth = 1.5; context.setLineDash([6,4]);
  context.beginPath(); context.moveTo(0,y); context.lineTo(width,y); context.stroke(); context.restore();
}

function drawLine(key, max, color, width, height) {
  if (history.length < 2) return;
  context.globalAlpha = 0.95; context.strokeStyle = color; context.lineWidth = 3; context.beginPath();
  let started = false;
  history.forEach((sample, index) => {
    if (!Number.isFinite(sample[key])) return;
    const x = (index / (history.length - 1)) * width;
    const y = height - Math.min(1, sample[key] / max) * (height - 8) - 4;
    if (!started) { context.moveTo(x, y); started = true; } else context.lineTo(x, y);
  });
  if (started) context.stroke();
}

function applyTheme() {
  const root = document.documentElement;
  const variables = { "--text": theme.text_color || "#eef8ff", "--muted": theme.muted_color || "#9fc6dc", "--good": theme.good_color || "#2cb4fb", "--warn": theme.warn_color || "#ffd166", "--bad": theme.bad_color || "#ff5f6d", "--plot-primary": theme.plot_primary || "rgba(44, 180, 251, 0.95)", "--plot-secondary": theme.plot_secondary || "#8de7ff", "--radius": `${theme.border_radius_px ?? 8}px`, "--blur": `${theme.backdrop_blur_px ?? 2}px`, "--font-size": `${theme.font_size_base_px ?? 16}px`, "--scale": String(preset.layout.scale ?? 1), "--transition": `${config.transition_ms ?? 250}ms` };
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
}

function applyLayout() {
  const pad = `${preset.layout.pad ?? 20}px`;
  const placement = { tl: { top: pad, left: pad, origin: "top left" }, t: { top: pad, left: "50%", transform: "translateX(-50%)", origin: "top center" }, tr: { top: pad, right: pad, origin: "top right" }, l: { left: pad, top: "50%", transform: "translateY(-50%)", origin: "center left" }, c: { left: "50%", top: "50%", transform: "translate(-50%, -50%)", origin: "center" }, r: { right: pad, top: "50%", transform: "translateY(-50%)", origin: "center right" }, bl: { bottom: pad, left: pad, origin: "bottom left" }, b: { bottom: pad, left: "50%", transform: "translateX(-50%)", origin: "bottom center" }, br: { bottom: pad, right: pad, origin: "bottom right" } }[preset.layout.dock || "br"];
  const { origin, transform = "", ...position } = placement;
  if (elementPreviewMode) {
    Object.assign(widget.style, { top: "", right: "", bottom: "", left: "" });
    widget.style.transform = "scale(var(--scale, 1))";
    widget.style.transformOrigin = "top left";
  } else {
    Object.assign(widget.style, { top: "", right: "", bottom: "", left: "" }, position);
    widget.style.transform = `${transform} scale(var(--scale, 1))`.trim();
    widget.style.transformOrigin = origin;
  }
  widget.style.width = "";
  widget.style.minHeight = preset.layout.height_px ? `${preset.layout.height_px}px` : "";
  document.documentElement.style.setProperty("--block-width", `${config.telemetry_block_width_px ?? 160}px`);
  document.documentElement.style.setProperty("--block-height", `${config.telemetry_block_height_px ?? 72}px`);
  document.documentElement.style.setProperty("--origin", origin);
  applyBlockOrder();
  applyTelemetryColumns();
}

function applyTelemetryColumns() {
  const visibleCount = [...blocks.values()].filter((block) => !block.hidden).length || 1;
  const blockWidth = normalizedTelemetryBlockWidth(config.telemetry_block_width_px ?? 160);
  const availableWidth = Math.max(blockWidth, window.innerWidth - ((preset.layout.pad ?? 20) * 2) - telemetryWidgetChromePx);
  const columns = resolvedTelemetryColumnCount(config.telemetry_columns, visibleCount, blockWidth, availableWidth, telemetryGridGapPx);
  layout.style.gridTemplateColumns = `repeat(${columns}, minmax(0, ${blockWidth}px))`;
  widget.style.width = `${telemetryGridPixelWidth(columns, blockWidth, telemetryGridGapPx, telemetryWidgetChromePx)}px`;
}

function publishPreviewSize() {
  if (!elementPreviewMode || window.parent === window) return;
  requestAnimationFrame(() => {
    const rect = widget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    window.parent.postMessage({
      type: "frame-preview-size",
      width: Math.ceil(rect.width + 28),
      height: Math.ceil(rect.height + 28),
      content_width: Math.ceil(rect.width),
      content_height: Math.ceil(rect.height),
    }, "*");
  });
}

function colorFor(value) { return value === QUALITY.GOOD ? theme.good_color || "#2cb4fb" : value === QUALITY.WARN ? theme.warn_color || "#ffd166" : theme.bad_color || "#ff5f6d"; }
function opacityFor(value) { return value === QUALITY.GOOD ? theme.bg_opacity_good ?? 0.3 : value === QUALITY.WARN ? theme.bg_opacity_warn ?? 0.5 : theme.bg_opacity_bad ?? 0.72; }
function formatBitrate(value) { return value >= 1000 ? `${(value / 1000).toFixed(2)} Mbps` : `${value} kbps`; }
function formatMilliseconds(value) { return Number.isFinite(Number(value)) && value !== null ? `${Number(value).toFixed(1)} ms` : "--"; }
function formatRecovery(value) { return Number.isFinite(Number(value)) && value !== null ? `${Number(value).toFixed(1)}%` : "--"; }
function formatDuration(seconds) { const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); return `${h}h ${m}m`; }
