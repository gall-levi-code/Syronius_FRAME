export function deriveUploadView(transfers, completeHideMs = 5000, now = Date.now()) {
  const visible = (Array.isArray(transfers) ? transfers : []).filter((transfer) => {
    if (transfer.phase !== "queued" && transfer.phase !== "published") return true;
    return now - Date.parse(transfer.updated_at) <= Math.max(0, completeHideMs);
  });
  const phase = (name) => visible.filter((transfer) => transfer.phase === name);
  const receiving = phase("receiving");
  const focus = receiving[0] ?? phase("processing")[0] ?? phase("queued")[0] ?? phase("failed")[0] ?? null;
  const knownTotals = receiving.length > 0 && receiving.every((transfer) => Number.isFinite(transfer.bytes_total));
  const bytesReceived = receiving.reduce((total, transfer) => total + finite(transfer.bytes_received), 0);
  const bytesTotal = knownTotals ? receiving.reduce((total, transfer) => total + finite(transfer.bytes_total), 0) : null;
  const speeds = receiving.map((transfer) => transfer.speed_bps).filter(Number.isFinite);
  return {
    transfers: visible,
    focus,
    receiving: receiving.length,
    queued: phase("queued").length,
    processing: phase("processing").length,
    failed: phase("failed").length,
    bytes_received: bytesReceived,
    bytes_total: bytesTotal,
    percent: bytesTotal > 0 ? Math.min(100, (bytesReceived / bytesTotal) * 100) : null,
    speed_bps: speeds.length ? speeds.reduce((total, value) => total + value, 0) : null,
  };
}

export function uploadSummary(view) {
  const parts = [];
  if (view.receiving) parts.push(`${view.receiving} uploading`);
  if (view.processing) parts.push(`${view.processing} processing`);
  if (view.queued) parts.push(`${view.queued} queued`);
  if (view.failed) parts.push(`${view.failed} failed`);
  return parts.join(" · ");
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
