// === Query params ===
const qs = new URLSearchParams(location.search);
const POLL_MS = Number(qs.get("poll") || 1000);

// Bitrate thresholds (defaults you asked for)
const BITRATE_GOOD_MIN = Number(qs.get("bitrate_good_min") || 5000);
const BITRATE_WARN_MIN = Number(qs.get("bitrate_warn_min")  || 2500);

// RTT thresholds (back-compat with old latency params)
const RTT_WARN_MAX = Number(qs.get("rtt_warn_max") || qs.get("latency_warn_max") || 1500);
const RTT_BAD_MAX  = Number(qs.get("rtt_bad_max")  || qs.get("latency_bad_max")  || 3500);

// Meter scale
const BITRATE_METER_MAX = Number(qs.get("bitrate_meter_max") || 12000);

// Chart config
const HIST_LEN = Number(qs.get("history") || 10);
const CHART_BITRATE_MAX = Number(qs.get("chart_bitrate_max") || 12000);
const CHART_RTT_MAX     = Number(qs.get("chart_rtt_max")     || 6000);

// Behavior toggles
// If 0, "Good" ignores RTT (bitrate-only). Back-compat with use_latency_in_good.
const USE_RTT_IN_GOOD = (qs.get("use_rtt_in_good") ?? qs.get("use_latency_in_good") ?? "1") !== "0";
// Compact UI when Good (hides .hide-when-good)
const COMPACT_WHEN_GOOD = (qs.get("compact_when_good") ?? "1") !== "0";
// Show the (fixed) latency row?
const SHOW_LATENCY = (qs.get("show_latency") ?? "0") === "1";

// Hysteresis for WARN/BAD transitions (consecutive polls required)
const BITRATE_STREAK_WARN = Math.max(1, Number(qs.get("bitrate_streak_warn") || 2));
const BITRATE_STREAK_BAD  = Math.max(1, Number(qs.get("bitrate_streak_bad")  || 2));
const RTT_STREAK_WARN     = Math.max(1, Number(qs.get("rtt_streak_warn")     || qs.get("latency_streak_warn") || 2));
const RTT_STREAK_BAD      = Math.max(1, Number(qs.get("rtt_streak_bad")      || 2));

// Label style: "emoji" (default) or "svg"
const LABEL_STYLE = (qs.get("label_style") || "emoji").toLowerCase();

// === Elements ===
const el = {
  statusDot: document.getElementById("status-dot"),
  statusText: document.getElementById("status-text"),
  server: document.getElementById("server"),
  bitrate: document.getElementById("bitrate"),
  latency: document.getElementById("latency"),
  rtt: document.getElementById("rtt"),
  dropped: document.getElementById("dropped"),
  bitrateBar: document.getElementById("bitrate-bar"),
  error: document.getElementById("error"),
  histN: document.getElementById("histN"),
  canvas: document.getElementById("miniChart"),
  wrap: document.getElementById("wrap")
};
if (el.histN) el.histN.textContent = HIST_LEN;

// Toggle latency row visibility
if (SHOW_LATENCY) {
  document.querySelectorAll(".latency-row").forEach(n => n.classList.remove("hide-latency"));
}

// === Chart setup ===
let ctx = null, DPR = 1, CSS_W = 0, CSS_H = 0;
if (el.canvas) {
  ctx = el.canvas.getContext("2d");
  DPR = window.devicePixelRatio || 1;
  CSS_W = el.canvas.width;
  CSS_H = el.canvas.height;
  el.canvas.width = CSS_W * DPR;
  el.canvas.height = CSS_H * DPR;
  el.canvas.style.width = CSS_W + "px";
  el.canvas.style.height = CSS_H + "px";
  ctx.scale(DPR, DPR);
}

// History buffers
const hist = { bitrate: [], rtt: [] };

// Streak state
let bitrateWarnStreak = 0, bitrateBadStreak = 0;
let rttWarnStreak = 0, rttBadStreak = 0;

function pushTrim(arr, val, max) {
  arr.push(val);
  if (arr.length > max) arr.shift();
}

function drawChart() {
  if (!ctx) return;
  ctx.clearRect(0, 0, CSS_W, CSS_H);

  const pad = { l: 6, r: 6, t: 4, b: 4 };
  const w = CSS_W - pad.l - pad.r;
  const h = CSS_H - pad.t - pad.b;

  const len = Math.max(hist.bitrate.length, hist.rtt.length);
  if (len < 2) return;

  const points = HIST_LEN - 1 || 1;
  const xPos = (i) => pad.l + (w * (i / points));

  function plotLine(data, maxValue, strokeStyle) {
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      const x = xPos(i);
      const y = pad.t + h - Math.max(0, Math.min(1, v / maxValue)) * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = strokeStyle;
    ctx.stroke();
  }

  // Bitrate line: gradient accent -> lime
  const styles = getComputedStyle(document.documentElement);
  const c1 = styles.getPropertyValue("--accent").trim() || "#3aa0ff";
  const c2 = styles.getPropertyValue("--accent-2").trim() || "#a7ff3f";
  const grad = ctx.createLinearGradient(pad.l, 0, pad.l + w, 0);
  grad.addColorStop(0, c1); grad.addColorStop(1, c2);
  plotLine(hist.bitrate, CHART_BITRATE_MAX, grad);

  // RTT line: semi-white
  plotLine(hist.rtt, CHART_RTT_MAX, "rgba(255,255,255,0.8)");
}

function setClass(elm, classes) {
  elm.className = classes.filter(Boolean).join(" ");
}

// Compute tier from streaks
function tierFromStreaks() {
  const bitrateTier =
    bitrateBadStreak >= BITRATE_STREAK_BAD ? "bad" :
    bitrateWarnStreak >= BITRATE_STREAK_WARN ? "warn" : "good";

  const rttTier =
    rttBadStreak >= RTT_STREAK_BAD ? "bad" :
    rttWarnStreak >= RTT_STREAK_WARN ? "warn" : "good";

  return { bitrateTier, rttTier };
}

// Returns { quality, reasonKey } where reasonKey is one of:
// 'ok', 'bitrate_warn', 'rtt_warn', 'both_warn', 'bitrate_bad', 'rtt_bad', 'both_bad', 'disconnected'
function qualityClassDetailed({ connected, bitrate, rtt }) {
  if (!connected) return { quality: "bad", reasonKey: "disconnected" };

  if (!USE_RTT_IN_GOOD && bitrate >= BITRATE_GOOD_MIN) {
    return { quality: "good", reasonKey: "ok" };
  }

  const { bitrateTier, rttTier } = tierFromStreaks();

  if (bitrateTier === "good" && rttTier === "good") return { quality: "good", reasonKey: "ok" };

  if (bitrateTier === "bad" && rttTier === "bad") return { quality: "bad", reasonKey: "both_bad" };
  if (bitrateTier === "bad") return { quality: "bad", reasonKey: "bitrate_bad" };
  if (rttTier === "bad") return { quality: "bad", reasonKey: "rtt_bad" };

  if (bitrateTier === "warn" && rttTier === "warn") return { quality: "warn", reasonKey: "both_warn" };
  if (bitrateTier === "warn") return { quality: "warn", reasonKey: "bitrate_warn" };
  if (rttTier === "warn") return { quality: "warn", reasonKey: "rtt_warn" };

  return { quality: "bad", reasonKey: "unknown" };
}

// Emoji & SVG dictionaries
const EMOJI = {
  good: "",
  warn: "⚠️",
  bad: "💩",
  disconnected: "🔌☠️",
  reason: {
    ok: "",
    bitrate_warn: "📉",
    rtt_warn: "🕒",
    both_warn: "📉🕒",
    bitrate_bad: "📉",
    rtt_bad: "🕒",
    both_bad: "📉🕒",
    unknown: "❔"
  }
};

// Tiny inline SVG icon (circle) for quality
function svgBadge(color) {
  const size = 14;
  return `
    <svg width="${size}" height="${size}" viewBox="0 0 20 20"
         xmlns="http://www.w3.org/2000/svg" style="vertical-align: -2px;">
      <circle cx="10" cy="10" r="8" fill="${color}" />
    </svg>`;
}
const SVG_COLOR = { good: "#4caf50", warn: "#ffb300", bad: "#f44336" };
const SVG_REASON = {
  ok: "", bitrate_warn: "low bitrate", rtt_warn: "high RTT", both_warn: "borderline",
  bitrate_bad: "low bitrate", rtt_bad: "high RTT", both_bad: "low bitrate & high RTT", unknown: "unknown"
};

// Render status label
function renderLabel({ quality, reasonKey, connected, rtt }) {
  const rttLabel = isFinite(rtt) ? `${rtt} ms` : "—";

  if (!connected) {
    if (LABEL_STYLE === "svg") {
      return `${svgBadge(SVG_COLOR.bad)} Disconnected`;
    }
    return `${EMOJI.disconnected} Disconnected`;
  }

  if (quality === "good") {
    if (LABEL_STYLE === "svg") {
      return `${svgBadge(SVG_COLOR.good)} Connected — RTT ${rttLabel}`;
    }
    return `${EMOJI.good} Connected — RTT ${rttLabel}`;
  }

  if (LABEL_STYLE === "svg") {
    const color = quality === "warn" ? SVG_COLOR.warn : SVG_COLOR.bad;
    const word = quality === "warn" ? "Degraded" : "Poor";
    const reason = SVG_REASON[reasonKey] || "unknown";
    return `${svgBadge(color)} Connected (${word} — ${reason})`;
  } else {
    const icon = quality === "warn" ? EMOJI.warn : EMOJI.bad;
    const word = quality === "warn" ? "Degraded" : "Poor";
    const reasonIcon = EMOJI.reason[reasonKey] || EMOJI.reason.unknown;
    return `${icon} Connected (${word} — ${reasonIcon})`;
  }
}

// === Polling ===
async function fetchStatus() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) throw new Error("Bad response " + res.status);
    const data = await res.json();

    const pub = data?.publishers?.live || {};
    const connected = !!pub.connected;
    const bitrate = Number(pub.bitrate ?? 0);
    const rtt = Number(pub.rtt ?? Infinity);

    // --- Update streaks
    // Bitrate
    if (bitrate < BITRATE_WARN_MIN) {
      bitrateBadStreak = Math.min(bitrateBadStreak + 1, 999);
      bitrateWarnStreak = 0;
    } else if (bitrate < BITRATE_GOOD_MIN) {
      bitrateWarnStreak = Math.min(bitrateWarnStreak + 1, 999);
      bitrateBadStreak = 0;
    } else {
      bitrateWarnStreak = 0;
      bitrateBadStreak = 0;
    }

    // RTT
    if (rtt > RTT_BAD_MAX) {
      rttBadStreak = Math.min(rttBadStreak + 1, 999);
      rttWarnStreak = 0;
    } else if (rtt > RTT_WARN_MAX) {
      rttWarnStreak = Math.min(rttWarnStreak + 1, 999);
      rttBadStreak = 0;
    } else {
      rttWarnStreak = 0;
      rttBadStreak = 0;
    }

    // --- Decide quality + reason
    const { quality, reasonKey } = qualityClassDetailed({ connected, bitrate, rtt });

    // Classes for dot/text/background
    setClass(el.statusDot, ["dot", quality, quality === "good" ? "pulse" : ""]);
    setClass(el.statusText, ["status", quality]);
    setClass(el.wrap, ["wrap", quality]); // drives background opacity

    // Label (emoji or svg)
    if (LABEL_STYLE === "svg") {
      el.statusText.innerHTML = renderLabel({ quality, reasonKey, connected, rtt });
    } else {
      el.statusText.textContent = renderLabel({ quality, reasonKey, connected, rtt });
    }

    // Compact UI toggle
    if (COMPACT_WHEN_GOOD) {
      document.body.classList.toggle("compact-good", quality === "good");
    }

    // Fields
    el.server.textContent = pub.server ?? "—";
    el.bitrate.textContent = bitrate.toLocaleString();
    if (el.latency) el.latency.textContent = pub.latency ?? "—"; // optional, hidden by default
    el.rtt.textContent = isFinite(rtt) ? rtt : "—";
    el.dropped.textContent = pub.dropped_pkts ?? "—";

    // Meter
    const pct = Math.max(0, Math.min(100, Math.round((bitrate / BITRATE_METER_MAX) * 100)));
    el.bitrateBar.style.width = pct + "%";

    // Chart history
    pushTrim(hist.bitrate, bitrate, HIST_LEN);
    pushTrim(hist.rtt, rtt, HIST_LEN);
    drawChart();

    // Clear error
    if (el.error) el.error.style.display = "none";
  } catch (e) {
    setClass(el.statusDot, ["dot", "bad"]);
    setClass(el.statusText, ["status", "bad"]);
    setClass(el.wrap, ["wrap", "bad"]);
    if (LABEL_STYLE === "svg") {
      el.statusText.innerHTML = `${svgBadge(SVG_COLOR.bad)} Unavailable`;
    } else {
      el.statusText.textContent = `${EMOJI.bad} Unavailable`;
    }
    if (el.error) el.error.style.display = "";
    if (COMPACT_WHEN_GOOD) {
      document.body.classList.remove("compact-good");
    }
  }
}

setInterval(fetchStatus, POLL_MS);
fetchStatus();
