export function deriveUploadView(transfers, completeHideMs = 5000, now = Date.now()) {
  const visible = (Array.isArray(transfers) ? transfers : []).filter((transfer) => {
    if (transfer.phase !== "published") return true;
    return now - Date.parse(transfer.updated_at) <= Math.max(0, completeHideMs);
  }).sort(compareTransfers);
  const phase = (name) => visible.filter((transfer) => transfer.phase === name);
  const receiving = phase("receiving");
  const queued = phase("queued");
  const processing = phase("processing");
  const published = phase("published");
  const failed = phase("failed");
  const focus = focusTransfer({ receiving, processing, queued, published, failed });
  const focusIndex = focus ? visible.findIndex((transfer) => transfer.transfer_id === focus.transfer_id) : -1;
  const knownTotals = receiving.length > 0 && receiving.every((transfer) => Number.isFinite(transfer.bytes_total));
  const bytesReceived = receiving.reduce((total, transfer) => total + finite(transfer.bytes_received), 0);
  const bytesTotal = knownTotals ? receiving.reduce((total, transfer) => total + finite(transfer.bytes_total), 0) : null;
  const speeds = receiving.map((transfer) => transfer.speed_bps).filter(Number.isFinite);
  const completeCount = published.length + failed.length;
  const overallTotal = visible.length;
  const currentPercent = focus ? transferPercent(focus) : null;
  const currentBytesTotal = focus && finite(focus.bytes_total) > 0 ? finite(focus.bytes_total) : null;
  return {
    transfers: visible,
    focus,
    focus_index: focusIndex,
    adapters: [...new Set(visible.map((transfer) => transfer.adapter).filter(Boolean))],
    receiving: receiving.length,
    queued: queued.length,
    processing: processing.length,
    published: published.length,
    failed: failed.length,
    bytes_received: bytesReceived,
    bytes_total: bytesTotal,
    percent: bytesTotal > 0 ? Math.min(100, (bytesReceived / bytesTotal) * 100) : null,
    speed_bps: speeds.length ? speeds.reduce((total, value) => total + value, 0) : null,
    current_percent: currentPercent,
    current_bytes_received: focus ? finite(focus.bytes_received) : 0,
    current_bytes_total: currentBytesTotal,
    overall_complete: completeCount,
    overall_total: overallTotal,
    overall_percent: overallTotal ? Math.min(100, (completeCount / overallTotal) * 100) : 0,
  };
}

export function uploadSummary(view) {
  const parts = [];
  if (view.receiving) parts.push(`${view.receiving} uploading`);
  if (view.processing) parts.push(`${view.processing} processing`);
  if (view.queued) parts.push(`${view.queued} waiting`);
  if (view.published) parts.push(`${view.published} published`);
  if (view.failed) parts.push(`${view.failed} failed`);
  return parts.join(" - ");
}

export function formatBytes(bytes) {
  const value = finite(bytes);
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(finite(milliseconds) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function focusTransfer(groups) {
  const receiving = [...groups.receiving].sort((left, right) => {
    const leftPercent = transferPercent(left);
    const rightPercent = transferPercent(right);
    if (leftPercent !== null || rightPercent !== null) return (rightPercent ?? -1) - (leftPercent ?? -1);
    return compareTransfers(left, right);
  });
  return receiving[0] ?? groups.processing[0] ?? groups.queued[0] ?? groups.published[0] ?? groups.failed[0] ?? null;
}

function transferPercent(transfer) {
  if (transfer.phase === "published") return 100;
  if (transfer.phase === "queued") return 0;
  if (transfer.phase === "processing") return finite(transfer.bytes_received) > 0 ? 100 : null;
  const total = finite(transfer.bytes_total);
  if (total <= 0) return null;
  return Math.min(100, (finite(transfer.bytes_received) / total) * 100);
}

function compareTransfers(left, right) {
  return timestamp(left.started_at) - timestamp(right.started_at)
    || String(left.transfer_id || "").localeCompare(String(right.transfer_id || ""));
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
