import { QUALITY, QualityStabilizer, ServiceReloadWatchdog, canvasPixelSize, compactTelemetryBlockWidth, formatTelemetryDuration, layoutGrowth, normalizedTelemetryBlockWidth, normalizedTelemetryOrder, previewElementSize, qualityStatusText, resolvedTelemetryColumnCount, shouldResetRuntimeState, telemetryAvailability, telemetryGridPixelWidth, telemetryIsStale } from "./renderer-core.js";

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
const reloadWatchdog = new ServiceReloadWatchdog();
const history = [];
const defaultOrder = ["header", "bitrate", "rtt", "latency", "buffer", "server", "dropped", "uptime", "meter", "chart", "recovery"];
const telemetryWidgetChromePx = 30;
const widget = document.querySelector("#widget");
const layout = document.querySelector("#telemetry-layout");
const widgetHead = document.querySelector("#widget-head");
const statusValue = document.querySelector("#status-value");
const streamName = document.querySelector("#stream-name");
const meterFill = document.querySelector("#meter-fill");
const chart = document.querySelector("#chart");
const chartBlock = document.querySelector("#chart-block");
const chartLegend = document.querySelector(".chart-legend");
const chartWarnValue = document.querySelector("#chart-warn-value");
const chartRttValue = document.querySelector("#chart-rtt-value");
const chartRttLegend = document.querySelector(".rtt-line");
const context = chart.getContext("2d");
const blocks = new Map([...layout.querySelectorAll("[data-block]")].map((element) => [element.dataset.block, element]));
const values = new Map([...layout.querySelectorAll("[data-value]")].map((element) => [element.dataset.value, element]));
const query = new URLSearchParams(location.search);
const previewMode = query.has("preview");
const elementPreviewMode = query.has("elementPreview");
let chartHasRtt = false;
let compactGoodActive = false;

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
  eventSource.addEventListener("open", () => { reloadWatchdog.markOnline(); stopRestFallback(); });
  eventSource.addEventListener("telemetry", (event) => { reloadWatchdog.markOnline(); stopRestFallback(); acceptTelemetry(JSON.parse(event.data)); });
  eventSource.addEventListener("config", (event) => applyPayload(JSON.parse(event.data)));
  eventSource.addEventListener("source-error", (event) => renderNoSignal(JSON.parse(event.data).error || "SOURCE UNAVAILABLE"));
  eventSource.onerror = startRestFallback;
  clearInterval(settingsTimer);
  settingsTimer = setInterval(refreshSettings, 15_000);
}

function startRestFallback() {
  if (restTimer) return;
  void refreshTelemetry();
  restTimer = setInterval(refreshTelemetry, pollIntervalMs());
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
    if (response.ok) { reloadWatchdog.markOnline(); acceptTelemetry(await response.json()); }
  } catch {
    reloadWatchdog.markOffline();
  } finally { restInflight = false; }
}

async function refreshSettings() {
  try {
    const response = await fetch(payload.settings_url, { cache: "no-store" });
    if (!response.ok) return;
    reloadWatchdog.markOnline();
    const next = await response.json();
    if (next.revision !== payload.revision) applyPayload(next);
  } catch {
    reloadWatchdog.markOffline();
  }
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
  if ((!previewMode && telemetryIsStale(lastTelemetry, pollIntervalMs())) || !lastTelemetry.publisher || lastTelemetry.publisher.connected === false) {
    return renderNoSignal(config.no_signal_label || "NO SIGNAL");
  }
  renderStats(lastTelemetry.publisher);
}

function renderStats(stats) {
  widget.classList.remove("hidden");
  const stable = quality.update(stats, config);
  const display = stable === QUALITY.UNKNOWN ? QUALITY.WARN : stable;
  const compactGood = config.compact_when_good && stable === QUALITY.GOOD;
  applyStateTheme(display);
  statusValue.textContent = qualityStatusText(stable, stats, config, compactGood);
  streamName.textContent = streamDisplayName;
  values.get("bitrate").textContent = formatBitrate(stats.bitrate);
  values.get("rtt").textContent = formatMilliseconds(stats.rtt);
  values.get("latency").textContent = formatMilliseconds(stats.latency);
  values.get("buffer").textContent = formatMilliseconds(stats.buffer);
  values.get("server").textContent = payload.server_name || "FRAME";
  values.get("dropped").textContent = String(stats.dropped_pkts ?? 0);
  values.get("uptime").textContent = formatTelemetryDuration(stats.uptime ?? 0);
  values.get("recovery").textContent = formatRecovery(stats.recovery_rate);
  updateMeter(stats.bitrate);
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
  applyStateTheme(confirmed ? QUALITY.BAD : QUALITY.WARN);
  statusValue.textContent = label;
  streamName.textContent = streamDisplayName;
  compactGoodActive = false;
  applyHeaderVisibility();
  for (const [id, block] of blocks) block.hidden = id !== "header";
  applyBlockOrder();
  applyTelemetryColumns();
  publishPreviewSize();
}

function updateMeter(bitrate) {
  const max = config.bitrate_meter_max || config.chart_bitrate_max || 12000;
  const warnStop = Math.min(100, Math.max(0, ((config.bitrate_warn_min ?? 2500) / max) * 100));
  const goodStop = Math.min(100, Math.max(warnStop, ((config.bitrate_good_min ?? 5000) / max) * 100));
  const percent = Math.min(100, Math.max(0, (Number(bitrate || 0) / max) * 100));
  meterFill.style.setProperty("--meter-percent", `${percent}%`);
  meterFill.style.setProperty("--meter-warn-stop", `${warnStop}%`);
  meterFill.style.setProperty("--meter-good-stop", `${goodStop}%`);
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
  compactGoodActive = Boolean(compact);
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
  chartHasRtt = available.rtt;
  chartBlock.classList.toggle("legend-hidden", config.show_chart_legend === false);
  chartLegend.hidden = config.show_chart_legend === false;
  chartRttLegend.hidden = !chartHasRtt;
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
  if (chartHasRtt) drawLine("rtt", rttMax, theme.plot_secondary || "#8de7ff", rect.width, rect.height);
  chartWarnValue.textContent = formatBitrate(config.bitrate_warn_min ?? 2500);
  chartRttValue.textContent = `0–${formatMilliseconds(rttMax)}`;
  context.globalAlpha = 1;
}

function drawGuide(value, max, color, width, height) {
  const y = height - Math.min(1, value / max) * (height - 8) - 4;
  context.save(); context.globalAlpha = .75; context.strokeStyle = color; context.lineWidth = config.chart_warn_line_width_px ?? 1.5; context.setLineDash(lineDashFor(config.chart_warn_line_style ?? "dashed"));
  context.beginPath(); context.moveTo(0,y); context.lineTo(width,y); context.stroke(); context.restore();
}

function drawLine(key, max, color, width, height) {
  if (history.length < 2) return;
  context.save();
  context.globalAlpha = 0.95;
  context.strokeStyle = color;
  context.lineWidth = key === "rtt" ? config.chart_rtt_line_width_px ?? 3 : config.chart_bitrate_line_width_px ?? 3;
  context.setLineDash(lineDashFor(key === "rtt" ? config.chart_rtt_line_style : config.chart_bitrate_line_style));
  context.beginPath();
  let started = false;
  history.forEach((sample, index) => {
    if (!Number.isFinite(sample[key])) return;
    const x = (index / (history.length - 1)) * width;
    const y = height - Math.min(1, sample[key] / max) * (height - 8) - 4;
    if (!started) { context.moveTo(x, y); started = true; } else context.lineTo(x, y);
  });
  if (started) context.stroke();
  context.restore();
}

function lineDashFor(style) {
  if (style === "dotted") return [1, 6];
  if (style === "dashed") return [8, 5];
  return [];
}

function applyTheme() {
  const root = document.documentElement;
  const variables = {
    "--text": theme.text_color || "#eef8ff",
    "--muted": theme.muted_color || "#9fc6dc",
    "--good": theme.good_color || "#2cb4fb",
    "--warn": theme.warn_color || "#ffd166",
    "--bad": theme.bad_color || "#ff5f6d",
    "--plot-primary": theme.plot_primary || "rgba(44, 180, 251, 0.95)",
    "--plot-secondary": theme.plot_secondary || "#8de7ff",
    "--widget-opacity": String(theme.bg_opacity_warn ?? 0.5),
    "--panel-bg": colorWithAlpha(theme.panel_bg_color || "#000000", panelAlpha(1)),
    "--panel-border": theme.panel_border_color || "color-mix(in srgb, var(--plot-primary, #2cb4fb) 40%, transparent)",
    "--panel-glow": theme.panel_glow_color || "#000000",
    "--block-bg": colorWithAlpha(theme.block_bg_color || "#132f3d", blockAlpha(1)),
    "--block-border": theme.block_border_color || "transparent",
    "--radius": `${theme.border_radius_px ?? 8}px`,
    "--blur": `${theme.backdrop_blur_px ?? 2}px`,
    "--panel-padding": `${theme.panel_padding_px ?? 14}px`,
    "--block-padding": `${theme.block_padding_px ?? 8}px`,
    "--block-gap": `${blockGapPx()}px`,
    "--panel-border-width": `${theme.panel_border_width_px ?? 1}px`,
    "--block-border-width": `${theme.block_border_width_px ?? 0}px`,
    "--glow-blur": `${theme.glow_blur_px ?? 50}px`,
    "--shadow-spread": `${theme.glow_spread_px ?? 0}px`,
    "--shadow-x": `${theme.glow_offset_x_px ?? 0}px`,
    "--shadow-y": `${theme.glow_offset_y_px ?? 16}px`,
    "--meter-height": `${config.bitrate_meter_height_px ?? 14}px`,
    "--meter-radius": `${config.bitrate_meter_radius_px ?? 999}px`,
    "--font-size": `${theme.font_size_base_px ?? 16}px`,
    "--font-family": theme.font_family || "Inter, system-ui, sans-serif",
    "--font-weight": String(theme.font_weight ?? 400),
    "--subheader-font-family": theme.subheader_font_family || theme.font_family || "Inter, system-ui, sans-serif",
    "--subheader-font-size": `${theme.subheader_font_size_px ?? 12}px`,
    "--subheader-font-weight": String(theme.subheader_font_weight ?? 500),
    "--scale": String(preset.layout.scale ?? 1),
    "--transition": `${config.transition_ms ?? 250}ms`,
  };
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
  applyGrowthDirection();
  applyBlockOrder();
  applyTelemetryColumns();
}

function applyTelemetryColumns() {
  const growth = layoutGrowth(preset.layout);
  const visibleCount = [...blocks.values()].filter((block) => !block.hidden).length || 1;
  const baseBlockWidth = normalizedTelemetryBlockWidth(config.telemetry_block_width_px ?? 160);
  const blockGap = blockGapPx();
  const blockWidth = compactGoodActive
    ? compactTelemetryBlockWidth(baseBlockWidth, statusValue.scrollWidth, compactHeaderChromeWidth())
    : baseBlockWidth;
  const layoutWidth = Number(preset.layout.width_px) > 0 ? Number(preset.layout.width_px) : 0;
  const availableWidth = Math.max(blockWidth, (layoutWidth || (elementPreviewMode ? 520 : window.innerWidth)) - ((preset.layout.pad ?? 20) * 2) - telemetryWidgetChromePx);
  const columns = resolvedTelemetryColumnCount(config.telemetry_columns, visibleCount, blockWidth, availableWidth, blockGap);
  layout.style.gridTemplateColumns = `repeat(${columns}, minmax(0, ${blockWidth}px))`;
  layout.style.justifyContent = growth.x === "left" ? "end" : growth.x === "center" ? "center" : "start";
  layout.style.alignContent = growth.y === "up" ? "end" : growth.y === "center" ? "center" : "start";
  widget.style.width = `${layoutWidth || telemetryGridPixelWidth(columns, blockWidth, blockGap, telemetryWidgetChromePx)}px`;
}

function applyGrowthDirection() {
  const growth = layoutGrowth(preset.layout);
  const flipX = growth.x === "left";
  const flipY = growth.y === "up";
  const transform = flipX || flipY ? `scale(${flipX ? -1 : 1}, ${flipY ? -1 : 1})` : "";
  layout.style.transform = transform;
  for (const block of blocks.values()) block.style.transform = transform;
}

function compactHeaderChromeWidth() {
  const style = getComputedStyle(widgetHead);
  const dot = widgetHead.querySelector(".signal-dot");
  const dotWidth = dot.hidden ? 0 : dot.getBoundingClientRect().width;
  const gap = dotWidth ? pixels(style.columnGap || style.gap) : 0;
  return pixels(style.paddingLeft) + pixels(style.paddingRight) + dotWidth + gap;
}

function pixels(value) {
  return Number.parseFloat(value) || 0;
}

function blockGapPx() {
  return Math.max(0, Number(theme.block_gap_px ?? 7) || 0);
}

function pollIntervalMs() {
  const value = Number(config.poll_ms);
  return Number.isFinite(value) ? Math.min(2000, Math.max(200, value)) : 1000;
}

function publishPreviewSize() {
  if (!elementPreviewMode || window.parent === window) return;
  requestAnimationFrame(() => {
    const size = previewElementSize(widget);
    if (!size.content_width || !size.content_height) return;
    window.parent.postMessage({ type: "frame-preview-size", ...size }, "*");
  });
}

function colorFor(value) { return value === QUALITY.GOOD ? theme.good_color || "#2cb4fb" : value === QUALITY.WARN ? theme.warn_color || "#ffd166" : theme.bad_color || "#ff5f6d"; }
function opacityFor(value) { return value === QUALITY.GOOD ? theme.bg_opacity_good ?? 0.3 : value === QUALITY.WARN ? theme.bg_opacity_warn ?? 0.5 : theme.bg_opacity_bad ?? 0.72; }
function applyStateTheme(value) {
  document.documentElement.style.setProperty("--quality", colorFor(value));
  document.documentElement.style.setProperty("--widget-opacity", String(opacityFor(value)));
  document.documentElement.style.setProperty("--panel-bg", colorWithAlpha(theme.panel_bg_color || "#000000", panelAlpha(1)));
  document.documentElement.style.setProperty("--block-bg", colorWithAlpha(theme.block_bg_color || "#132f3d", blockAlpha(1)));
}
function panelAlpha(fallback) {
  return Number.isFinite(Number(theme.panel_bg_alpha)) ? Number(theme.panel_bg_alpha) : fallback;
}
function blockAlpha(fallback) {
  return Number.isFinite(Number(theme.block_bg_alpha)) ? Number(theme.block_bg_alpha) : fallback;
}
function colorWithAlpha(color, alpha) {
  const safeAlpha = Math.min(1, Math.max(0, Number(alpha) || 0));
  const hex = String(color || "").trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
  if (!hex) return color;
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  return `rgba(${Number.parseInt(full.slice(0, 2), 16)}, ${Number.parseInt(full.slice(2, 4), 16)}, ${Number.parseInt(full.slice(4, 6), 16)}, ${safeAlpha})`;
}
function formatBitrate(value) { return value >= 1000 ? `${(value / 1000).toFixed(2)} Mbps` : `${value} kbps`; }
function formatMilliseconds(value) { return Number.isFinite(Number(value)) && value !== null ? `${Number(value).toFixed(1)} ms` : "--"; }
function formatRecovery(value) { return Number.isFinite(Number(value)) && value !== null ? `${Number(value).toFixed(1)}%` : "--"; }
