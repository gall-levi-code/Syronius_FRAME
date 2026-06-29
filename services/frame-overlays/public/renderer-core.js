export const QUALITY = Object.freeze({ UNKNOWN: "unknown", GOOD: "good", WARN: "warn", BAD: "bad" });

export function qualityCandidate(stats, config) {
  const bitrate = Number(stats?.bitrate || 0);
  const rtt = Number(stats?.rtt);
  const hasRtt = stats?.rtt !== null && stats?.rtt !== undefined && Number.isFinite(rtt);
  const bitrateState = bitrate >= (config.bitrate_good_min ?? 5000) ? QUALITY.GOOD : bitrate >= (config.bitrate_warn_min ?? 2500) ? QUALITY.WARN : QUALITY.BAD;
  const rttState = !hasRtt || rtt <= (config.rtt_warn_max ?? 1500) ? QUALITY.GOOD : rtt <= (config.rtt_bad_max ?? 3500) ? QUALITY.WARN : QUALITY.BAD;
  if (!config.use_rtt_in_good || !hasRtt) return bitrateState;
  if (bitrateState === QUALITY.BAD || rttState === QUALITY.BAD) return QUALITY.BAD;
  if (bitrateState === QUALITY.WARN || rttState === QUALITY.WARN) return QUALITY.WARN;
  return QUALITY.GOOD;
}

export function qualityStatusText(stable, stats, config, compact) {
  const label = stable === QUALITY.UNKNOWN ? "CHECKING" : stable.toUpperCase();
  const bitrate = Number(stats?.bitrate);
  if (
    compact
    && stable === QUALITY.GOOD
    && config.show_bitrate !== false
    && config.show_bitrate_in_good !== false
    && stats?.bitrate !== null
    && stats?.bitrate !== undefined
    && Number.isFinite(bitrate)
  ) {
    const formatted = bitrate >= 1000 ? `${(bitrate / 1000).toFixed(2)} Mbps` : `${bitrate} kbps`;
    return `${label} · ${formatted}`;
  }
  return label;
}

export function compactTelemetryBlockWidth(baseBlockWidth, contentWidth, chromeWidth = 0) {
  const base = normalizedTelemetryBlockWidth(baseBlockWidth);
  const content = Math.max(0, Math.ceil(Number(contentWidth) || 0));
  const chrome = Math.max(0, Math.ceil(Number(chromeWidth) || 0));
  return Math.max(base, content + chrome);
}

export class QualityStabilizer {
  constructor(initial = QUALITY.UNKNOWN) {
    this.stable = initial;
    this.warnStreak = 0;
    this.badStreak = 0;
  }
  update(stats, config) {
    const candidate = qualityCandidate(stats, config);
    this.warnStreak = candidate === QUALITY.WARN ? this.warnStreak + 1 : 0;
    this.badStreak = candidate === QUALITY.BAD ? this.badStreak + 1 : 0;
    if (candidate === QUALITY.GOOD) this.stable = QUALITY.GOOD;
    if (candidate === QUALITY.WARN && this.warnStreak >= Math.max(config.bitrate_streak_warn || 1, config.rtt_streak_warn || 1)) this.stable = QUALITY.WARN;
    if (candidate === QUALITY.BAD && this.badStreak >= Math.max(config.bitrate_streak_bad || 1, config.rtt_streak_bad || 1)) this.stable = QUALITY.BAD;
    return this.stable;
  }
}

export class ServiceReloadWatchdog {
  constructor({ failureThreshold = 2, reloadDelayMs = 500, reload = () => location.reload(), schedule = (callback, delay) => setTimeout(callback, delay) } = {}) {
    this.failureThreshold = Math.max(1, Math.floor(Number(failureThreshold) || 1));
    this.reloadDelayMs = Math.max(0, Number(reloadDelayMs) || 0);
    this.reload = reload;
    this.schedule = schedule;
    this.failures = 0;
    this.wasOffline = false;
    this.reloadQueued = false;
  }
  markOffline() {
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.wasOffline = true;
  }
  markOnline() {
    this.failures = 0;
    if (!this.wasOffline || this.reloadQueued) return false;
    this.reloadQueued = true;
    this.schedule(this.reload, this.reloadDelayMs);
    return true;
  }
}

export function shouldResetRuntimeState(previousPayload, nextPayload) {
  return Boolean(previousPayload && previousPayload.telemetry_identity !== nextPayload?.telemetry_identity);
}

export function telemetryIsStale(snapshot, pollMs, now = Date.now()) {
  if (!snapshot?.received_at) return true;
  return snapshot.stale || now - Date.parse(snapshot.received_at) > Math.max(5000, (pollMs || 1000) * 3);
}

export function canvasPixelSize(cssWidth, cssHeight, devicePixelRatio = 1) {
  const ratio = Math.max(1, Number(devicePixelRatio) || 1);
  return { width: Math.max(1, Math.round(cssWidth * ratio)), height: Math.max(1, Math.round(cssHeight * ratio)), ratio };
}

export function telemetryAvailability(stats) {
  const available = (field) => stats?.[field] !== null
    && stats?.[field] !== undefined
    && Number.isFinite(Number(stats[field]));
  const bitrate = available("bitrate");
  const rtt = available("rtt");
  return {
    bitrate,
    rtt,
    latency: available("latency"),
    buffer: available("buffer"),
    server: true,
    dropped: available("dropped_pkts"),
    uptime: available("uptime"),
    recovery: available("recovery_rate"),
    meter: bitrate,
    chart: bitrate || rtt,
  };
}

export function normalizedTelemetryOrder(value, defaults) {
  const supplied = Array.isArray(value) ? value.filter((id) => defaults.includes(id)) : [];
  return [...new Set([...supplied, ...defaults])];
}

export function normalizedTelemetryColumns(value, visibleCount = 1) {
  if (value === "all") return Math.max(1, Math.floor(Number(visibleCount) || 1));
  if (value === "auto" || value === null || value === undefined) return 0;
  const numeric = Math.round(Number(value));
  return Number.isFinite(numeric) ? Math.min(8, Math.max(1, numeric)) : 0;
}

export function normalizedTelemetryBlockWidth(value, fallback = 160) {
  const numeric = Math.round(Number(value));
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(600, Math.max(80, numeric));
}

export function resolvedTelemetryColumnCount(value, visibleCount = 1, blockWidth = 160, availableWidth = Infinity, gap = 7) {
  const visible = Math.max(1, Math.floor(Number(visibleCount) || 1));
  const fixed = normalizedTelemetryColumns(value, visible);
  if (fixed) return Math.min(visible, fixed);
  const safeBlockWidth = normalizedTelemetryBlockWidth(blockWidth);
  const safeAvailableWidth = Number.isFinite(Number(availableWidth)) ? Math.max(safeBlockWidth, Number(availableWidth)) : Infinity;
  if (!Number.isFinite(safeAvailableWidth)) return visible;
  return Math.min(visible, Math.max(1, Math.floor((safeAvailableWidth + gap) / (safeBlockWidth + gap))));
}

export function telemetryGridPixelWidth(columns = 1, blockWidth = 160, gap = 7, horizontalChrome = 30) {
  const safeColumns = Math.max(1, Math.floor(Number(columns) || 1));
  const safeBlockWidth = normalizedTelemetryBlockWidth(blockWidth);
  const safeGap = Math.max(0, Number(gap) || 0);
  const safeChrome = Math.max(0, Number(horizontalChrome) || 0);
  return (safeColumns * safeBlockWidth) + ((safeColumns - 1) * safeGap) + safeChrome;
}
