export const BITRATE_LEVEL_MAX = 12000;
export const BITRATE_LEVEL_STEP = 250;
export const RTT_LEVEL_MAX = 5000;
export const RTT_LEVEL_STEP = 100;

export function clampBitrateLevels(levels, changed, step = BITRATE_LEVEL_STEP, ceiling = BITRATE_LEVEL_MAX) {
  const next = {
    warn: snap(levels.warn, step, 0, ceiling),
    good: snap(levels.good, step, 0, ceiling),
    max: snap(levels.max, step, 0, ceiling),
  };
  if (changed === "warn") next.warn = Math.min(next.warn, next.good - step);
  if (changed === "good") next.good = Math.min(Math.max(next.good, next.warn + step), next.max - step);
  if (changed === "max") next.max = Math.max(next.max, next.good + step);
  next.warn = clamp(next.warn, 0, ceiling - step * 2);
  next.good = clamp(next.good, next.warn + step, ceiling - step);
  next.max = clamp(next.max, next.good + step, ceiling);
  return next;
}

export function clampRttLevels(levels, changed, step = RTT_LEVEL_STEP, ceiling = RTT_LEVEL_MAX) {
  const next = {
    good: snap(levels.good, step, 0, ceiling),
    bad: snap(levels.bad, step, 0, ceiling),
    max: snap(levels.max, step, 0, ceiling),
  };
  if (changed === "good") next.good = Math.min(next.good, next.bad - step);
  if (changed === "bad") next.bad = Math.min(Math.max(next.bad, next.good + step), next.max - step);
  if (changed === "max") next.max = Math.max(next.max, next.bad + step);
  next.good = clamp(next.good, 0, ceiling - step * 2);
  next.bad = clamp(next.bad, next.good + step, ceiling - step);
  next.max = clamp(next.max, next.bad + step, ceiling);
  return next;
}

export function samplingWindowLabel(pollMs, historyCount) {
  const totalMs = Math.max(0, Number(pollMs) || 0) * Math.max(0, Number(historyCount) || 0);
  if (totalMs < 1000) return `${totalMs} ms`;
  const seconds = totalMs / 1000;
  return seconds < 60 ? `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} sec` : `${(seconds / 60).toFixed(1)} min`;
}

export function clampNumericValue(value, min, max, step) {
  const bounded = clamp(Number(value) || 0, Number(min), Number(max));
  const increment = Number(step) || 1;
  const snapped = Math.round((bounded - Number(min)) / increment) * increment + Number(min);
  const decimals = String(increment).split(".")[1]?.length ?? 0;
  return Number(snapped.toFixed(decimals));
}

function snap(value, step, min, max) {
  return clamp(Math.round((Number(value) || 0) / step) * step, min, max);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
