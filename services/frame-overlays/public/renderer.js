let payload = window.FRAME_OVERLAY;
let preset = payload.preset;
let config = preset.config || {};
let theme = preset.theme || {};
let streamDisplayName = payload.stream_display_name || preset.name || "FRAME Stream";
let statsUrl = payload.stats_url;
let pollTimer;
let settingsTimer;
let stableQuality = "bad";
let warnStreak = 0;
let badStreak = 0;
const history = [];
const defaultTelemetryOrder = ["header", "bitrate", "rtt", "latency", "buffer", "server", "dropped", "uptime", "meter", "chart", "recovery"];
const widget = document.querySelector("#widget");
const telemetryLayout = document.querySelector("#telemetry-layout");
const widgetHead = document.querySelector("#widget-head");
const statusValue = document.querySelector("#status-value");
const streamName = document.querySelector("#stream-name");
const meter = document.querySelector("#meter");
const meterFill = document.querySelector("#meter-fill");
const chart = document.querySelector("#chart");
const context = chart.getContext("2d");

const previewMode = new URLSearchParams(window.location.search).has("preview");
if (previewMode) {
  document.body.classList.add("preview");
}
applyTheme();
applyLayout();
tick();
schedule();
scheduleSettings();
window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin || event.data?.type !== "frame-preview" || !event.data.preset) return;
  applyPayload({ ...payload, ...event.data });
});

function applyPayload(nextPayload) {
  payload = nextPayload;
  preset = payload.preset;
  config = preset.config || {};
  theme = preset.theme || {};
  streamDisplayName = payload.stream_display_name || preset.name || "FRAME Stream";
  statsUrl = payload.stats_url || null;
  history.length = 0;
  stableQuality = "bad";
  warnStreak = 0;
  badStreak = 0;
  applyTheme();
  applyLayout();
  tick();
  schedule();
}

async function refreshSettings() {
  if (!payload.settings_url) return;
  try {
    const response = await fetch(payload.settings_url, { cache: "no-store" });
    if (!response.ok) {
      renderNoSignal("PRESET UNAVAILABLE");
      return;
    }
    const nextPayload = await response.json();
    if (nextPayload.revision !== payload.revision) {
      applyPayload(nextPayload);
    }
  } catch {
    // The last known settings stay active through brief management-service interruptions.
  }
}

async function tick() {
  if (preset.enabled === false) {
    widget.classList.add("hidden");
    return;
  }
  if (!statsUrl) {
    renderNoSignal("UNBOUND");
    return;
  }
  try {
    const response = await fetch(statsUrl, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !body.publisher || body.publisher.connected === false) {
      renderNoSignal(config.no_signal_label || "NO SIGNAL");
      return;
    }
    renderStats(body.publisher);
  } catch {
    renderNoSignal(config.no_signal_label || "NO SIGNAL");
  }
}

function renderStats(stats) {
  widget.classList.remove("hidden");
  const quality = qualityFor(stats);
  document.documentElement.style.setProperty("--quality", colorFor(quality));
  document.documentElement.style.setProperty("--widget-opacity", String(opacityFor(quality)));
  statusValue.textContent = quality.toUpperCase();
  streamName.textContent = streamDisplayName;
  applyHeaderVisibility();
  const compact = config.compact_when_good && quality === "good";
  const rows = [
    ["bitrate", "show_bitrate", "Bitrate", formatBitrate(stats.bitrate)],
    ["rtt", "show_rtt", "RTT", formatMilliseconds(stats.rtt)],
    ["latency", "show_latency", "Latency", formatMilliseconds(stats.latency)],
    ["buffer", "show_buffer", "Buffer", formatMilliseconds(stats.buffer)],
    ["server", "show_server", "Server", payload.server_name || "FRAME"],
    ["dropped", "show_dropped", "Dropped", String(stats.dropped_pkts ?? 0)],
    ["uptime", "show_uptime", "Uptime", formatDuration(stats.uptime ?? 0)],
    ["recovery", "show_recovery", "Recovery", formatRecovery(stats.recovery_rate)],
  ];
  renderDetailBlocks(rows, compact);
  meter.hidden = !config.show_meter || compact;
  meterFill.style.width = `${Math.min(100, Math.max(0, (Number(stats.bitrate || 0) / (config.bitrate_meter_max || 12000)) * 100))}%`;
  chart.hidden = !config.show_chart || compact;
  applyBlockOrder();
  pushHistory(stats);
  drawChart();
  widget.hidden = false;
}

function renderNoSignal(label) {
  if (config.no_signal_behavior === "hide") {
    widget.classList.add("hidden");
    return;
  }
  widget.classList.remove("hidden");
  document.documentElement.style.setProperty("--quality", theme.bad_color || "#ff5f6d");
  document.documentElement.style.setProperty("--widget-opacity", String(theme.bg_opacity_bad ?? 0.72));
  statusValue.textContent = label;
  streamName.textContent = streamDisplayName;
  applyHeaderVisibility();
  telemetryLayout.querySelectorAll("[data-generated-detail]").forEach((element) => element.remove());
  meter.hidden = true;
  chart.hidden = true;
  applyBlockOrder();
}

function applyHeaderVisibility() {
  const showStatus = config.show_status !== false;
  const showName = config.show_name !== false;
  widgetHead.hidden = !showStatus && !showName;
  widgetHead.querySelector(".signal-dot").hidden = !showStatus;
  statusValue.hidden = !showStatus;
  streamName.hidden = !showName;
}

function renderDetailBlocks(rows, compact) {
  telemetryLayout.querySelectorAll("[data-generated-detail]").forEach((element) => element.remove());
  if (compact) return;
  for (const [id, field, label, value] of rows) {
    if (!config[field]) continue;
    const block = document.createElement("div");
    block.className = "detail telemetry-block";
    block.dataset.block = id;
    block.dataset.generatedDetail = "true";
    const labelElement = document.createElement("span");
    labelElement.textContent = label;
    const valueElement = document.createElement("strong");
    valueElement.textContent = value;
    block.append(labelElement, valueElement);
    telemetryLayout.append(block);
  }
}

function applyBlockOrder() {
  const order = normalizedTelemetryOrder(config.telemetry_order);
  for (const id of order) {
    const block = telemetryLayout.querySelector(`[data-block="${id}"]`);
    if (block) telemetryLayout.append(block);
  }
}

function normalizedTelemetryOrder(value) {
  const supplied = Array.isArray(value) ? value.filter((id) => defaultTelemetryOrder.includes(id)) : [];
  return [...new Set([...supplied, ...defaultTelemetryOrder])];
}

function qualityFor(stats) {
  const bitrate = Number(stats.bitrate || 0);
  const rtt = Number(stats.rtt);
  const hasRtt = stats.rtt !== null && stats.rtt !== undefined && Number.isFinite(rtt);
  const bitrateState = bitrate >= config.bitrate_good_min ? "good" : bitrate >= config.bitrate_warn_min ? "warn" : "bad";
  const rttState = !hasRtt || rtt <= config.rtt_warn_max ? "good" : rtt <= config.rtt_bad_max ? "warn" : "bad";
  const candidate = !config.use_rtt_in_good || !hasRtt
    ? bitrateState
    : bitrateState === "bad" || rttState === "bad"
      ? "bad"
      : bitrateState === "warn" || rttState === "warn"
        ? "warn"
        : "good";
  badStreak = candidate === "bad" ? badStreak + 1 : 0;
  warnStreak = candidate === "warn" ? warnStreak + 1 : 0;
  if (candidate === "good") stableQuality = "good";
  if (candidate === "warn" && warnStreak >= Math.max(config.bitrate_streak_warn || 1, config.rtt_streak_warn || 1)) {
    stableQuality = "warn";
  }
  if (candidate === "bad" && badStreak >= Math.max(config.bitrate_streak_bad || 1, config.rtt_streak_bad || 1)) {
    stableQuality = "bad";
  }
  return stableQuality;
}

function pushHistory(stats) {
  history.push({ bitrate: Number(stats.bitrate || 0), rtt: Number.isFinite(Number(stats.rtt)) ? Number(stats.rtt) : null });
  while (history.length > (config.history_len || 10)) history.shift();
}

function drawChart() {
  if (chart.hidden) return;
  context.clearRect(0, 0, chart.width, chart.height);
  context.globalAlpha = 0.3;
  context.strokeStyle = theme.muted_color || "#9fc6dc";
  context.beginPath();
  context.moveTo(0, chart.height - 1);
  context.lineTo(chart.width, chart.height - 1);
  context.stroke();
  drawLine("bitrate", config.chart_bitrate_max || 12000, theme.plot_primary || "#2cb4fb");
  drawLine("rtt", config.chart_rtt_max || 6000, theme.warn_color || "#ffd166");
  context.globalAlpha = 1;
}

function drawLine(key, max, color) {
  if (history.length < 2) return;
  context.globalAlpha = 0.95;
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.beginPath();
  let started = false;
  history.forEach((sample, index) => {
    if (!Number.isFinite(sample[key])) return;
    const x = (index / (history.length - 1)) * chart.width;
    const y = chart.height - Math.min(1, sample[key] / max) * (chart.height - 8) - 4;
    if (!started) {
      context.moveTo(x, y);
      started = true;
    }
    else context.lineTo(x, y);
  });
  if (started) context.stroke();
}

function applyTheme() {
  const root = document.documentElement;
  root.style.setProperty("--text", theme.text_color || "#eef8ff");
  root.style.setProperty("--muted", theme.muted_color || "#9fc6dc");
  root.style.setProperty("--good", theme.good_color || "#2cb4fb");
  root.style.setProperty("--warn", theme.warn_color || "#ffd166");
  root.style.setProperty("--bad", theme.bad_color || "#ff5f6d");
  root.style.setProperty("--plot-primary", theme.plot_primary || "rgba(44, 180, 251, 0.95)");
  root.style.setProperty("--plot-secondary", theme.plot_secondary || "#8de7ff");
  root.style.setProperty("--radius", `${theme.border_radius_px ?? 8}px`);
  root.style.setProperty("--blur", `${theme.backdrop_blur_px ?? 2}px`);
  root.style.setProperty("--font-size", `${theme.font_size_base_px ?? 16}px`);
  root.style.setProperty("--scale", String(preset.layout.scale ?? 1));
  root.style.setProperty("--transition", `${config.transition_ms ?? 250}ms`);
}

function applyLayout() {
  const dock = preset.layout.dock || "br";
  const pad = `${preset.layout.pad ?? 20}px`;
  const placement = {
    tl: { top: pad, left: pad, origin: "top left" },
    t: { top: pad, left: "50%", transform: "translateX(-50%)", origin: "top center" },
    tr: { top: pad, right: pad, origin: "top right" },
    l: { left: pad, top: "50%", transform: "translateY(-50%)", origin: "center left" },
    c: { left: "50%", top: "50%", transform: "translate(-50%, -50%)", origin: "center" },
    r: { right: pad, top: "50%", transform: "translateY(-50%)", origin: "center right" },
    bl: { bottom: pad, left: pad, origin: "bottom left" },
    b: { bottom: pad, left: "50%", transform: "translateX(-50%)", origin: "bottom center" },
    br: { bottom: pad, right: pad, origin: "bottom right" },
  }[dock];
  const { origin, transform = "", ...position } = placement;
  Object.assign(widget.style, { top: "", right: "", bottom: "", left: "" }, position);
  widget.style.transform = `${transform} scale(var(--scale, 1))`.trim();
  const width = preset.layout.width_px ?? 420;
  widget.style.width = width ? `${width}px` : "fit-content";
  widget.style.minHeight = preset.layout.height_px ? `${preset.layout.height_px}px` : "";
  document.documentElement.style.setProperty("--block-width", `${config.telemetry_block_width_px ?? 160}px`);
  document.documentElement.style.setProperty("--block-height", `${config.telemetry_block_height_px ?? 72}px`);
  document.documentElement.style.setProperty("--origin", origin);
  applyBlockOrder();
}

function schedule() {
  clearInterval(pollTimer);
  pollTimer = setInterval(tick, config.poll_ms || 1000);
}

function scheduleSettings() {
  clearInterval(settingsTimer);
  if (!previewMode) settingsTimer = setInterval(refreshSettings, 2000);
}

function colorFor(quality) {
  if (quality === "good") return theme.good_color || "#2cb4fb";
  if (quality === "warn") return theme.warn_color || "#ffd166";
  return theme.bad_color || "#ff5f6d";
}
function opacityFor(quality) {
  if (quality === "good") return theme.bg_opacity_good ?? 0.3;
  if (quality === "warn") return theme.bg_opacity_warn ?? 0.5;
  return theme.bg_opacity_bad ?? 0.72;
}
function formatBitrate(value) { return value >= 1000 ? `${(value / 1000).toFixed(2)} Mbps` : `${value} kbps`; }
function formatMilliseconds(value) { return Number.isFinite(Number(value)) && value !== null ? `${Number(value).toFixed(1)} ms` : "--"; }
function formatRecovery(value) { return Number.isFinite(Number(value)) && value !== null ? `${Number(value).toFixed(1)}%` : "--"; }
function formatDuration(seconds) { const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60); return `${h}h ${m}m`; }
