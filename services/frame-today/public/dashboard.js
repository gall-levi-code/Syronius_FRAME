const elements = {
  status: document.querySelector("#dashboard-status"),
  albums: document.querySelector("#total-albums"),
  images: document.querySelector("#total-images"),
  currentImages: document.querySelector("#current-images"),
  duration: document.querySelector("#current-duration"),
  name: document.querySelector("#latest-name"),
  time: document.querySelector("#latest-time"),
  image: document.querySelector("#latest-image"),
  empty: document.querySelector("#latest-empty"),
  galleryLink: document.querySelector("#today-gallery-link"),
  galleryCopy: document.querySelector("#today-gallery-copy"),
  galleryCopyButton: document.querySelector("#today-gallery-copy-button"),
  toolLinks: document.querySelector("#tool-links"),
  latestDate: document.querySelector("#latest-date"),
  latestBase: document.querySelector("#latest-base"),
  latestCount: document.querySelector("#latest-count"),
  latestUpdated: document.querySelector("#latest-updated"),
  pipelineStatus: document.querySelector("#pipeline-status"),
  pipelineWorkers: document.querySelector("#pipeline-workers"),
  pipelineQueued: document.querySelector("#pipeline-queued"),
  pipelineCompleted: document.querySelector("#pipeline-completed"),
  pipelinePublished: document.querySelector("#pipeline-published"),
  pipelineQuarantined: document.querySelector("#pipeline-quarantined"),
  pipelineRate: document.querySelector("#pipeline-rate"),
  pipelineThroughput: document.querySelector("#pipeline-throughput"),
  pipelineJobs: document.querySelector("#pipeline-jobs"),
  pipelineJobsCount: document.querySelector("#pipeline-jobs-count"),
  pipelineJobsEmpty: document.querySelector("#pipeline-jobs-empty"),
  pipelineLastBatch: document.querySelector("#pipeline-last-batch"),
  pipelineLastBatchTitle: document.querySelector("#pipeline-last-batch-title"),
  pipelineLastBatchDetail: document.querySelector("#pipeline-last-batch-detail"),
  pipelinePerformanceSamples: document.querySelector("#pipeline-performance-samples"),
  pipelinePerformanceRows: document.querySelector("#pipeline-performance-rows"),
  message: document.querySelector("#dashboard-message"),
  themeToggle: document.querySelector("#theme-toggle"),
};
const dashboardConfig = { publicBaseUrl: "" };
let pipelineRefreshTimer = 0;

initializeTheme();
elements.themeToggle.addEventListener("click", toggleTheme);
window.addEventListener("storage", (event) => {
  if (event.key === "frame-theme-profile") {
    setThemeMode(readStoredTheme(), false);
    return;
  }
  if (event.key === "frame-theme" && (event.newValue === "day" || event.newValue === "night")) {
    setThemeMode(event.newValue, false);
  }
});

elements.toolLinks.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-path]");
  if (!(button instanceof HTMLButtonElement)) return;
  const label = button.dataset.copyLabel;
  try {
    await copyText(publicUrl(button.dataset.copyPath), button);
    elements.message.textContent = "";
    button.innerHTML = checkIcon();
    button.setAttribute("aria-label", `${label} URL copied`);
    button.title = `${label} URL copied`;
    setTimeout(() => {
      button.innerHTML = copyIcon();
      button.setAttribute("aria-label", `Copy ${label} URL`);
      button.title = `Copy ${label} URL`;
    }, 1800);
  } catch {
    elements.message.textContent = `Automatic copy was blocked. Press and hold the ${label} open-link button to copy its URL.`;
  }
});

async function copyText(value, button) {
  const previousFocus = document.activeElement;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
    }
  }
  const temporary = document.createElement("textarea");
  temporary.value = value;
  temporary.readOnly = true;
  temporary.tabIndex = -1;
  temporary.style.position = "fixed";
  temporary.style.left = "-9999px";
  temporary.style.top = "0";
  temporary.style.opacity = "0";
  (button.closest("dialog[open]") || document.body).append(temporary);
  let copied = false;
  const onCopy = (event) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/plain", value);
    event.preventDefault();
    copied = true;
  };
  document.addEventListener("copy", onCopy, { once: true });
  try {
    temporary.focus({ preventScroll: true });
    temporary.select();
    temporary.setSelectionRange(0, value.length);
    if (document.execCommand("copy") && copied) return;
  } catch {
  } finally {
    document.removeEventListener("copy", onCopy);
    temporary.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
  throw new Error("Copy unavailable");
}

refresh();
refreshPipeline();
setInterval(refresh, 5000);

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
  elements.themeToggle.setAttribute("aria-label", nextLabel);
  elements.themeToggle.title = nextLabel;
  elements.themeToggle.setAttribute("aria-pressed", String(mode === "day"));
  if (persist) {
    writeStoredTheme(mode);
    window.FrameTheme?.saveMode?.(mode);
  }
}

function readStoredTheme() {
  try {
    const stored = localStorage.getItem("frame-theme");
    if (stored === "day" || stored === "night") return stored;
  } catch {}
  return "night";
}

function writeStoredTheme(mode) {
  try {
    localStorage.setItem("frame-theme", mode);
  } catch {}
}

async function refresh() {
  try {
    const response = await fetch("/today/api/dashboard", { cache: "no-store" });
    if (!response.ok) throw new Error(`Dashboard request failed (${response.status}).`);
    const summary = await response.json();
    dashboardConfig.publicBaseUrl = summary.public_base_url || "";
    render(summary);
    elements.status.textContent = "Library connected";
    elements.status.className = "status-pill good";
    elements.message.textContent = "";
  } catch (error) {
    elements.status.textContent = "Library unavailable";
    elements.status.className = "status-pill bad";
    elements.message.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function refreshPipeline() {
  window.clearTimeout(pipelineRefreshTimer);
  let nextRefreshMs = 5000;
  try {
    const response = await fetch("/today/api/pipeline", { cache: "no-store" });
    const pipeline = await response.json().catch(() => null);
    if (!response.ok || !pipeline || pipeline.available === false) throw new Error("Photo Pipeline is unavailable.");
    if (renderPipeline(pipeline)) nextRefreshMs = 1000;
  } catch {
    renderPipelineUnavailable();
  } finally {
    pipelineRefreshTimer = window.setTimeout(refreshPipeline, nextRefreshMs);
  }
}

function renderPipeline(pipeline) {
  const jobs = Array.isArray(pipeline.active_jobs) ? pipeline.active_jobs : [];
  const workers = record(pipeline.workers);
  const activeWorkers = wholeNumber(workers?.active, wholeNumber(pipeline.processing));
  const configuredWorkers = wholeNumber(workers?.configured, wholeNumber(pipeline.concurrency));
  const queued = wholeNumber(pipeline.queue_depth);
  const active = activeWorkers > 0 || queued > 0 || jobs.length > 0;
  const batch = active ? record(pipeline.current_batch) : record(pipeline.last_batch);
  const rolling = record(pipeline.rolling);
  const headline = batch || rolling;

  elements.pipelineWorkers.textContent = `${activeWorkers} / ${configuredWorkers}`;
  elements.pipelineQueued.textContent = String(queued);
  elements.pipelineCompleted.textContent = String(wholeNumber(batch?.completed, wholeNumber(rolling?.completed)));
  elements.pipelinePublished.textContent = String(wholeNumber(batch?.published, wholeNumber(pipeline.published)));
  elements.pipelineQuarantined.textContent = String(wholeNumber(batch?.quarantined, wholeNumber(pipeline.quarantined)));
  elements.pipelineRate.textContent = `${formatNumber(headline?.images_per_second)} img/s`;
  elements.pipelineThroughput.textContent = `${formatNumber(headline?.mib_per_second)} MiB/s`;

  if (pipeline.processing_paused) setPipelineStatus("Paused", "bad");
  else if (activeWorkers > 0 || jobs.length > 0) setPipelineStatus("Processing", "busy");
  else if (queued > 0) setPipelineStatus("Queued", "busy");
  else if (pipeline.running === false) setPipelineStatus("Stopped", "bad");
  else setPipelineStatus("Idle", "good");

  renderPipelineJobs(jobs);
  elements.pipelineJobsEmpty.textContent = "No photos are processing.";
  renderLastBatch(record(pipeline.last_batch), !active);
  renderPerformance(record(pipeline.performance), rolling);
  return active;
}

function renderPipelineUnavailable() {
  setPipelineStatus("Unavailable", "bad");
  for (const element of [
    elements.pipelineWorkers,
    elements.pipelineQueued,
    elements.pipelineCompleted,
    elements.pipelinePublished,
    elements.pipelineQuarantined,
    elements.pipelineRate,
    elements.pipelineThroughput,
  ]) element.textContent = "—";
  renderPipelineJobs([]);
  elements.pipelineJobsEmpty.textContent = "Job details are unavailable.";
  renderLastBatch(null, true);
  renderPerformance(null, null);
}

function setPipelineStatus(label, tone) {
  const className = `status-pill ${tone}`;
  if (elements.pipelineStatus.textContent !== label) elements.pipelineStatus.textContent = label;
  if (elements.pipelineStatus.className !== className) elements.pipelineStatus.className = className;
}

function renderPipelineJobs(jobs) {
  elements.pipelineJobs.replaceChildren(...jobs.map((job) => {
    const row = document.createElement("div");
    row.className = "pipeline-job";
    const filename = document.createElement("span");
    filename.className = "pipeline-job-name";
    filename.textContent = job?.filename || "Photo";
    const stage = document.createElement("strong");
    stage.className = "pipeline-job-stage";
    stage.textContent = stageLabel(job?.stage);
    const elapsed = document.createElement("time");
    elapsed.className = "pipeline-job-elapsed";
    elapsed.textContent = formatDuration(jobElapsedMs(job));
    row.append(filename, stage, elapsed);
    return row;
  }));
  elements.pipelineJobsCount.textContent = `${jobs.length} active`;
  elements.pipelineJobsEmpty.hidden = jobs.length > 0;
}

function renderLastBatch(batch, idle) {
  elements.pipelineLastBatch.hidden = !idle || !batch;
  if (!idle || !batch) return;
  const completed = wholeNumber(batch.completed);
  const lastIngestAt = batch.last_ingest_at || batch.completed_at;
  elements.pipelineLastBatchTitle.textContent = lastIngestAt
    ? `${completed} completed · ${formatDate(lastIngestAt)}`
    : `${completed} completed`;
  const detail = [
    `${wholeNumber(batch.published)} published`,
    `${wholeNumber(batch.quarantined)} quarantined`,
    formatDuration(batch.duration_ms),
    `${formatNumber(batch.images_per_second)} img/s`,
    `${formatNumber(batch.mib_per_second)} MiB/s`,
  ];
  if (numberOrNull(batch.bytes) !== null) detail.splice(3, 0, formatBytes(batch.bytes));
  elements.pipelineLastBatchDetail.textContent = detail.join(" · ");
}

function renderPerformance(performance, rolling) {
  const sampleSize = wholeNumber(performance?.sample_size);
  const windowSeconds = numberOrNull(rolling?.window_seconds);
  const rollingSummary = rolling
    ? `${windowSeconds ? `${formatNumber(windowSeconds)}s ` : ""}rolling: ${formatNumber(rolling.images_per_second)} img/s · ${formatNumber(rolling.mib_per_second)} MiB/s`
    : "";
  elements.pipelinePerformanceSamples.textContent = [
    sampleSize ? `${sampleSize} timing sample${sampleSize === 1 ? "" : "s"}` : "No timing samples yet.",
    rollingSummary,
  ].filter(Boolean).join(" · ");
  if (!sampleSize) {
    elements.pipelinePerformanceRows.replaceChildren();
    return;
  }
  const stages = record(performance?.stages) || record(performance?.stages_ms) || {};
  const timings = [
    ["Queue wait", performance?.queue_wait_ms],
    ["Total processing", performance?.processing_ms],
    ...Object.entries(stages).map(([name, timing]) => [stageLabel(name.replace(/_ms$/, "")), timing]),
    ["Publish lock wait", performance?.publish_lock_wait_ms],
    ["Publish lock hold", performance?.publish_lock_hold_ms],
  ].filter(([, timing]) => record(timing));
  elements.pipelinePerformanceRows.replaceChildren(...timings.map(([label, timing]) => timingRow(label, timing)));
}

function timingRow(label, timing) {
  const row = document.createElement("tr");
  const heading = document.createElement("th");
  heading.scope = "row";
  heading.textContent = label;
  row.append(heading);
  for (const key of ["avg", "p50", "p95"]) {
    const cell = document.createElement("td");
    cell.textContent = formatTiming(timing?.[`${key}_ms`] ?? timing?.[key]);
    row.append(cell);
  }
  return row;
}

function jobElapsedMs(job) {
  return numberOrNull(job?.elapsed_ms) ?? 0;
}

function stageLabel(value) {
  const words = String(value || "processing").replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Processing";
}

function publicUrl(path) {
  try {
    const url = new URL(dashboardConfig.publicBaseUrl || location.origin);
    if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) url.protocol = "https:";
    return new URL(path, url.origin).href;
  } catch {
    return new URL(path, location.origin).href;
  }
}

function checkIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';
}

function copyIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/></svg>';
}

function render(summary) {
  const gallery = summary.current_gallery;
  const latest = summary.latest;
  const photo = summary.latest_photo;
  elements.albums.textContent = String(summary.total_albums);
  elements.images.textContent = String(summary.total_images);
  elements.currentImages.textContent = String(gallery?.count ?? 0);
  elements.duration.textContent = durationLabel(gallery?.duration_ms ?? 0);
  elements.name.textContent = photo ? friendlyBase(photo.base) : "Waiting for a photo";
  elements.time.textContent = photo ? formatDate(photo.processed_at) : "No publication yet";
  elements.image.hidden = !photo;
  elements.empty.hidden = Boolean(photo);
  if (photo) elements.image.src = photo.thumbnail_url;
  else elements.image.removeAttribute("src");
  if (gallery) {
    const galleryPath = `/today/gallery/${gallery.date_folder}/`;
    elements.galleryLink.href = galleryPath;
    elements.galleryLink.removeAttribute("aria-disabled");
    elements.galleryLink.removeAttribute("tabindex");
    elements.galleryLink.title = "Open Current Gallery in a new tab";
    elements.galleryCopyButton.dataset.copyPath = galleryPath;
    elements.galleryCopyButton.disabled = false;
    elements.galleryCopyButton.title = "Copy Current Gallery URL";
    elements.galleryCopy.textContent = `${gallery.date_folder} · ${gallery.count} photo${gallery.count === 1 ? "" : "s"}`;
  } else {
    elements.galleryLink.removeAttribute("href");
    elements.galleryLink.setAttribute("aria-disabled", "true");
    elements.galleryLink.setAttribute("tabindex", "-1");
    elements.galleryLink.title = "No current gallery available";
    delete elements.galleryCopyButton.dataset.copyPath;
    elements.galleryCopyButton.disabled = true;
    elements.galleryCopyButton.title = "No current gallery available";
    elements.galleryCopy.textContent = "No current album";
  }
  elements.latestDate.textContent = latest?.date_folder ?? "None";
  elements.latestBase.textContent = latest?.latest_base ?? "None";
  elements.latestCount.textContent = String(latest?.count_today ?? 0);
  elements.latestUpdated.textContent = latest?.updated_at ? formatDate(latest.updated_at) : "Never";
}

function durationLabel(ms) {
  if (ms < 60_000) return ms > 0 ? "< 1 min" : "0 min";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes} min`;
}

function formatDuration(value) {
  const ms = numberOrNull(value) ?? 0;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${formatNumber(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function formatTiming(value) {
  const ms = numberOrNull(value);
  if (ms === null) return "—";
  return ms < 1000 ? `${formatNumber(ms)} ms` : `${formatNumber(ms / 1000)} s`;
}

function formatBytes(value) {
  return `${formatNumber((numberOrNull(value) ?? 0) / 1024 ** 2)} MiB`;
}

function formatNumber(value) {
  return (numberOrNull(value) ?? 0).toLocaleString([], { maximumFractionDigits: 2 });
}

function wholeNumber(value, fallback = 0) {
  const number = numberOrNull(value);
  return number === null ? fallback : Math.max(0, Math.floor(number));
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function friendlyBase(base) {
  return base.replace(/_\d{4}-\d{2}-\d{2}_\d{2}_\d{2}_\d{2}(?:_\d+)?$/, "").replaceAll("_", " ");
}
