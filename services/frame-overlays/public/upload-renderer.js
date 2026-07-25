import {
  completionDockPosition,
  deriveJourneyQueue,
  horizontalJourneyLimit,
  formatBytes,
  formatDuration,
  journeyPercent,
  journeyStatusText,
  journeysFromSnapshot,
  journeysWithActiveGrace,
  previewJourneySnapshots,
  stabilizeJourneyOrder,
  unseenCompletedJourneys,
} from "./upload-renderer-core.js?v=upload-editor-v2";
import { ServiceReloadWatchdog, layoutGrowth, previewVisualBounds } from "./renderer-core.js?v=upload-editor-v2";

const PHASES = ["uploading", "staged", "processing", "published"];
const PHASE_LABELS = {
  uploading: "Uploading",
  staged: "Staged",
  processing: "Processing",
  published: "Published",
  failed: "Upload failed",
};
const MOTION_MS = 200;
const REORDER_DELAY_MS = 1000;
const FAILURE_EXIT_MS = 1000;
const COMPLETION_HOLD_MS = 300;
const ACTIVE_JOURNEY_GRACE_MS = 1200;

let payload = window.FRAME_OVERLAY;
let preset = payload.preset;
let config = preset.config || {};
let theme = preset.theme || {};
let eventSource;
let restTimer;
let settingsTimer;
let restInflight = false;
let lastSnapshot;
let latestJourneys = [];
let orderState = { order: [], pending: null, pending_since: null };
let completionTimer;
let completionCount = 0;
let completionExpiresAt = 0;
let completionAnchorRect;
let completionObstacleRect;
const completionSeen = new Map();
const activeJourneyMemory = new Map();
const visibleCompletions = new Map();
const visibleFailures = new Map();
const failureTimers = new Map();
const reloadWatchdog = new ServiceReloadWatchdog();
const query = new URLSearchParams(location.search);
const previewMode = query.has("preview");
const elementPreviewMode = query.has("elementPreview");
const previewScenario = query.get("scenario") || "queue";

const uploadStack = document.querySelector("#upload-stack");
const overlayRoot = document.querySelector(".overlay-root");
const journeyRegion = document.querySelector("#journey-region");
const journeyList = document.querySelector("#journey-list");
const overflow = document.querySelector("#queue-overflow");
const idleBubble = document.querySelector("#idle-bubble");
const idleLabel = document.querySelector("#idle-label");
const idleSource = document.querySelector("#idle-source");
const completionDock = document.querySelector("#completion-dock");
const completionBubble = document.querySelector("#completion-bubble");
const completionTitle = document.querySelector("#completion-title");
const completionFile = document.querySelector("#completion-file");
const journeyMotionAnimations = new WeakSet();

if (previewMode) document.body.classList.add("preview");
if (elementPreviewMode) document.body.classList.add("element-preview");
applyPayload(payload);
if (previewMode) {
  const snapshots = previewJourneySnapshots(previewScenario);
  acceptSnapshot(snapshots[0]);
  snapshots.slice(1).forEach((snapshot, index) => {
    setTimeout(() => acceptSnapshot(snapshot), 400 + index * 400);
  });
} else {
  connectEvents();
}
setInterval(render, MOTION_MS);
if (elementPreviewMode) new ResizeObserver(publishPreviewSize).observe(overlayRoot);
window.addEventListener("resize", () => {
  applyLayout();
  if (!completionBubble.hidden) {
    rememberJourneyAnchor();
    positionCompletionBubble();
  }
});
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.data?.type !== "frame-preview" || !event.data.preset) return;
  applyPayload({ ...payload, ...event.data });
});

function applyPayload(next) {
  if (payload && payload.telemetry_identity !== next.telemetry_identity) resetRuntimeState();
  payload = next;
  preset = payload.preset;
  config = preset.config || {};
  theme = preset.theme || {};
  applyTheme();
  applyLayout();
  render();
  if (!completionBubble.hidden) {
    rememberJourneyAnchor();
    positionCompletionBubble();
  }
  publishPreviewSize();
}

function resetRuntimeState() {
  lastSnapshot = undefined;
  latestJourneys = [];
  orderState = { order: [], pending: null, pending_since: null };
  completionSeen.clear();
  activeJourneyMemory.clear();
  for (const completion of visibleCompletions.values()) clearTimeout(completion.timer);
  visibleCompletions.clear();
  visibleFailures.clear();
  for (const timer of failureTimers.values()) clearTimeout(timer);
  failureTimers.clear();
  clearTimeout(completionTimer);
  completionBubble.hidden = true;
  completionDock.removeAttribute("data-direction");
  completionDock.removeAttribute("data-overlap");
  completionCount = 0;
  completionExpiresAt = 0;
  completionAnchorRect = undefined;
  completionObstacleRect = undefined;
  journeyList.replaceChildren();
}

function connectEvents() {
  eventSource?.close();
  if (!payload.events_url || !("EventSource" in window)) return startRestFallback();
  eventSource = new EventSource(payload.events_url);
  eventSource.addEventListener("open", () => {
    reloadWatchdog.markOnline();
    stopRestFallback();
  });
  eventSource.addEventListener("telemetry", (event) => {
    reloadWatchdog.markOnline();
    stopRestFallback();
    acceptSnapshot(JSON.parse(event.data));
  });
  eventSource.addEventListener("config", (event) => applyPayload(JSON.parse(event.data)));
  eventSource.onerror = startRestFallback;
  clearInterval(settingsTimer);
  settingsTimer = setInterval(refreshSettings, 15_000);
}

function startRestFallback() {
  if (restTimer) return;
  void refreshTelemetry();
  restTimer = setInterval(refreshTelemetry, Number(config.active_poll_ms) || 200);
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
    if (response.ok) {
      reloadWatchdog.markOnline();
      acceptSnapshot(await response.json());
    }
  } catch {
    reloadWatchdog.markOffline();
  } finally {
    restInflight = false;
  }
}

async function refreshSettings() {
  try {
    const response = await fetch(payload.settings_url, { cache: "no-store" });
    if (response.ok) {
      reloadWatchdog.markOnline();
      const next = await response.json();
      if (next.revision !== payload.revision) applyPayload(next);
    }
  } catch {
    reloadWatchdog.markOffline();
  }
}

function acceptSnapshot(snapshot) {
  if (lastSnapshot && snapshot.sequence < lastSnapshot.sequence) return;
  const now = Date.now();
  latestJourneys = journeysFromSnapshot(snapshot);
  rememberActiveJourneys(latestJourneys, now);
  const journeys = journeysWithActiveGrace(latestJourneys, activeJourneyMemory, now, ACTIVE_JOURNEY_GRACE_MS);
  const completed = unseenCompletedJourneys(
    lastSnapshot?.journeys,
    journeys,
    completionSeen,
    now,
    completionWindowMs(),
  );
  const previousById = new Map((lastSnapshot?.journeys || []).map((journey) => [journeyId(journey), journey]));

  for (const journey of journeys) {
    const id = journeyId(journey);
    if (journey.phase !== "failed") {
      visibleFailures.delete(id);
      clearTimeout(failureTimers.get(id));
      failureTimers.delete(id);
      journeyList.querySelector(`[data-journey-id="${CSS.escape(id)}"]`)?.classList.remove("failure-exit");
      continue;
    }
    const existingFailure = visibleFailures.get(id);
    if (existingFailure) {
      visibleFailures.set(id, { ...existingFailure, journey });
      continue;
    }
    if (!lastSnapshot || previousById.get(id)?.phase === "failed") continue;
    const element = journeyList.querySelector(`[data-journey-id="${CSS.escape(id)}"]`);
    if (!element) continue;
    visibleFailures.set(id, {
      journey,
      index: [...journeyList.children].indexOf(element),
      failed_at: now,
    });
    scheduleFailureExpiry(id);
  }

  if (completed.length) holdCompletedJourneys(completed);
  lastSnapshot = { ...snapshot, journeys };
  render();

  for (const failure of visibleFailures.values()) {
    if (previousById.get(journeyId(failure.journey))?.phase === "failed") continue;
    if (previewMode && previewScenario === "failed") continue;
    requestAnimationFrame(() => animateFailure(failure.journey));
  }
}

function render() {
  const enabled = preset.enabled !== false && payload.source?.enabled !== false;
  uploadStack.hidden = !enabled;
  completionDock.hidden = !enabled;
  if (!enabled) return;
  if (lastSnapshot) {
    lastSnapshot.journeys = journeysWithActiveGrace(
      latestJourneys,
      activeJourneyMemory,
      Date.now(),
      ACTIVE_JOURNEY_GRACE_MS,
    );
  }

  const allActive = deriveJourneyQueue(lastSnapshot?.journeys, Number.MAX_SAFE_INTEGER);
  const stabilized = stabilizeJourneyOrder(allActive.active, orderState, Date.now(), REORDER_DELAY_MS);
  orderState = stabilized.state;
  const limit = visibleJourneyLimit();
  const active = stabilized.journeys.slice(0, limit);
  const visible = [...active];
  const completions = [...visibleCompletions.values()].sort((left, right) => left.index - right.index);
  for (const completion of completions) {
    if (visible.some((journey) => journeyId(journey) === journeyId(completion.journey))) continue;
    const index = Math.max(0, Math.min(completion.index, visible.length));
    visible.splice(index, 0, completion.journey);
  }
  const failures = [...visibleFailures.values()].sort((left, right) =>
    left.failed_at - right.failed_at);
  for (const failure of failures) {
    const index = Math.max(0, Math.min(failure.index, visible.length));
    visible.splice(index, 0, failure.journey);
  }
  const hidden = Math.max(0, stabilized.journeys.length - active.length);

  renderJourneyCards(visible);
  if (completionBubble.hidden) rememberJourneyAnchor();
  overflow.hidden = hidden === 0;
  overflow.textContent = hidden ? `+${hidden} more` : "";

  const hasJourneys = visible.length > 0;
  const showIdle = !hasJourneys && (lastSnapshot?.error || config.idle_behavior === "show_idle");
  idleBubble.hidden = !showIdle;
  idleLabel.textContent = lastSnapshot?.error ? "UNAVAILABLE" : config.idle_label || "WAITING FOR UPLOAD";
  idleSource.textContent = lastSnapshot?.error || payload.source?.display_name || preset.name;
  journeyRegion.hidden = !hasJourneys && !showIdle;
  publishPreviewSize();
}

function rememberActiveJourneys(journeys, now) {
  for (const journey of journeys) {
    const id = journeyId(journey);
    if (!id) continue;
    if (journey.phase === "uploading" || journey.phase === "staged" || journey.phase === "processing") {
      activeJourneyMemory.set(id, { journey, last_seen: now });
    } else {
      activeJourneyMemory.delete(id);
    }
  }
}

function renderJourneyCards(journeys) {
  for (const element of journeyList.children) {
    for (const animation of element.getAnimations()) {
      if (journeyMotionAnimations.has(animation)) animation.cancel();
    }
  }
  const before = new Map([...journeyList.children].map((element) => [
    element.dataset.journeyId,
    element.getBoundingClientRect(),
  ]));
  const wanted = new Set(journeys.map(journeyId));
  for (const element of [...journeyList.children]) {
    if (!wanted.has(element.dataset.journeyId)) element.remove();
  }

  journeys.forEach((journey, index) => {
    const id = journeyId(journey);
    let element = [...journeyList.children].find((candidate) => candidate.dataset.journeyId === id);
    const created = !element;
    if (!element) {
      element = createJourneyCard(id);
      journeyList.append(element);
    }
    updateJourneyCard(element, journey, index);
    journeyList.append(element);
    if (created) {
      animateJourneyMotion(element, [
        { opacity: 0, transform: "translateY(10px) scale(.96)" },
        { opacity: Number(element.style.getPropertyValue("--queue-opacity")) || 1, transform: "none" },
      ]);
    }
  });

  for (const element of journeyList.children) {
    if (element.classList.contains("journey-flight")) continue;
    const previous = before.get(element.dataset.journeyId);
    if (!previous) continue;
    const next = element.getBoundingClientRect();
    const x = previous.left - next.left;
    const y = previous.top - next.top;
    if (Math.abs(x) < 1 && Math.abs(y) < 1) continue;
    animateJourneyMotion(element, [
      { transform: `translate(${x}px, ${y}px)` },
      { transform: "translate(0, 0)" },
    ]);
  }
}

function animateJourneyMotion(element, keyframes) {
  const animation = element.animate(keyframes, motionOptions());
  journeyMotionAnimations.add(animation);
}

function createJourneyCard(id) {
  const element = document.createElement("article");
  element.className = "journey-bubble";
  element.dataset.journeyId = id;
  element.setAttribute("role", "listitem");
  element.innerHTML = `
    <div class="journey-head">
      <div class="journey-copy">
        <strong data-filename>Unnamed photo</strong>
      </div>
    </div>
    <span class="journey-status" data-status></span>
    <div class="journey-progress-head">
      <span data-stage-label>Uploading</span>
      <strong data-percent>--</strong>
    </div>
    <div class="journey-stage-rail" aria-label="Upload lifecycle">
      ${PHASES.map((phase) => `<span class="journey-stage" data-stage="${phase}" title="${PHASE_LABELS[phase]}"><span></span></span>`).join("")}
    </div>
    <div class="journey-details">
      <span data-sent-detail><small>Sent</small><strong data-sent>0 B</strong></span>
      <span data-speed-detail><small>Speed</small><strong data-speed>--</strong></span>
      <span data-elapsed-detail><small>Elapsed</small><strong data-elapsed>--</strong></span>
    </div>
    <div class="journey-error" data-error hidden></div>
  `;
  return element;
}

function updateJourneyCard(element, journey, index) {
  const percent = journeyPercent(journey);
  const color = phaseColor(journey.phase);
  const filename = journey.filename || "Unnamed photo";
  const status = journeyStatusText(journey);
  const statusPosition = ["under_filename", "below_progress", "hidden"].includes(config.status_text_position)
    ? config.status_text_position
    : "under_filename";
  const opacityStep = boundedNumber(config.queue_opacity_step, 0, 1, .18);
  const queueOpacity = Math.max(0, 1 - index * opacityStep);

  element.dataset.phase = journey.phase;
  element.dataset.statusPosition = statusPosition;
  element.classList.toggle("compact", index !== 0);
  element.style.setProperty("--journey-color", color);
  element.style.setProperty("--queue-opacity", String(queueOpacity));
  element.setAttribute("aria-label", `${filename}: ${status}`);
  element.querySelector("[data-filename]").textContent = filename;
  const statusElement = element.querySelector("[data-status]");
  statusElement.textContent = status;
  statusElement.hidden = statusPosition === "hidden";
  element.querySelector("[data-stage-label]").textContent = PHASE_LABELS[journey.phase] || "Uploading";
  element.querySelector("[data-percent]").textContent = percent === null ? "--" : `${Math.round(percent)}%`;

  const currentPhase = PHASES.indexOf(journey.phase);
  for (const stage of element.querySelectorAll("[data-stage]")) {
    const stageIndex = PHASES.indexOf(stage.dataset.stage);
    const fill = stage.querySelector("span");
    const isUploading = journey.phase === "uploading" && stageIndex === 0;
    const indeterminate = isUploading && percent === null;
    const amount = stageIndex < currentPhase
      ? 100
      : stageIndex === currentPhase
        ? isUploading ? percent ?? 38 : 100
        : 0;
    stage.classList.toggle("current", stageIndex === currentPhase);
    stage.classList.toggle("indeterminate", indeterminate);
    stage.style.setProperty("--stage-color", phaseColor(stage.dataset.stage));
    fill.style.setProperty("--stage-fill", `${amount}%`);
  }

  const total = Number(journey.bytes_total);
  const received = Number(journey.bytes_received) || 0;
  element.querySelector("[data-sent]").textContent = Number.isFinite(total) && total > 0
    ? `${formatBytes(received)} / ${formatBytes(total)}`
    : formatBytes(received);
  element.querySelector("[data-speed]").textContent = Number.isFinite(Number(journey.speed_bps)) && Number(journey.speed_bps) > 0
    ? `${formatBytes(journey.speed_bps)}/s`
    : "--";
  element.querySelector("[data-elapsed]").textContent = Number.isFinite(Number(journey.elapsed_ms))
    ? formatDuration(journey.elapsed_ms)
    : "--";
  element.querySelector("[data-sent-detail]").hidden = config.show_sent === false;
  element.querySelector("[data-speed-detail]").hidden = config.show_speed === false || !Number.isFinite(Number(journey.speed_bps)) || Number(journey.speed_bps) <= 0;
  element.querySelector("[data-elapsed-detail]").hidden = config.show_elapsed === false || !Number.isFinite(Number(journey.elapsed_ms));
  const error = element.querySelector("[data-error]");
  error.hidden = journey.phase !== "failed";
  error.textContent = journey.phase === "failed" ? journey.error || "Upload failed" : "";
}

function animateFailure(journey) {
  const id = journeyId(journey);
  const element = journeyList.querySelector(`[data-journey-id="${CSS.escape(id)}"]`);
  if (!element || element.classList.contains("failure-exit")) return;
  element.classList.add("failure-exit");
}

function scheduleFailureExpiry(id) {
  if (previewMode && previewScenario === "failed") return;
  clearTimeout(failureTimers.get(id));
  failureTimers.set(id, setTimeout(() => {
    visibleFailures.delete(id);
    failureTimers.delete(id);
    render();
  }, FAILURE_EXIT_MS));
}

function holdCompletedJourneys(completed) {
  const immediate = [];
  completed.forEach((journey, index) => {
    const id = journeyId(journey);
    const source = journeyList.querySelector(`[data-journey-id="${CSS.escape(id)}"]`);
    if (!source) {
      immediate.push(journey);
      return;
    }
    clearTimeout(visibleCompletions.get(id)?.timer);
    const timer = setTimeout(() => showCompletionBubble([journey]), COMPLETION_HOLD_MS + index * 45);
    visibleCompletions.set(id, {
      journey,
      index: [...journeyList.children].indexOf(source),
      timer,
    });
  });
  if (immediate.length) showCompletionBubble(immediate);
}

function showCompletionBubble(completed) {
  const now = Date.now();
  const windowMs = completionWindowMs();
  completionCount = now < completionExpiresAt ? completionCount + completed.length : completed.length;
  completionExpiresAt = now + windowMs;
  const latest = [...completed].sort((left, right) =>
    Date.parse(left.updated_at) - Date.parse(right.updated_at)).at(-1);

  completionTitle.textContent = completionCount === 1 ? "1 completed" : `${completionCount} completed`;
  completionFile.textContent = latest?.filename || "Photo ready in FRAME";
  completionBubble.hidden = false;
  completionBubble.classList.remove("fading", "pulse");
  positionCompletionBubble(journeyId(latest));
  void completionBubble.offsetWidth;
  completionBubble.classList.add("pulse");

  const target = completionBubble.getBoundingClientRect();
  completed.forEach((journey) => animateJourneyFlight(journey, target));
  clearTimeout(completionTimer);
  if (!(previewMode && previewScenario === "completed")) {
    completionTimer = setTimeout(hideCompletionBubble, windowMs);
  }
}

function animateJourneyFlight(journey, target) {
  const id = journeyId(journey);
  const source = journeyList.querySelector(`[data-journey-id="${CSS.escape(id)}"]`);
  if (!source) {
    visibleCompletions.delete(id);
    render();
    return;
  }
  const rect = source.getBoundingClientRect();
  const rootRect = overlayRoot.getBoundingClientRect();
  const scale = boundedNumber(preset.layout.scale, .5, 3, 1);
  const flightDock = document.createElement("div");
  flightDock.className = "journey-flight-dock";
  Object.assign(flightDock.style, {
    left: `${rect.left - rootRect.left}px`,
    top: `${rect.top - rootRect.top}px`,
  });
  const flight = source.cloneNode(true);
  flight.classList.add("journey-flight");
  flight.setAttribute("aria-hidden", "true");
  Object.assign(flight.style, {
    width: `${rect.width / scale}px`,
    height: `${rect.height / scale}px`,
  });
  flightDock.append(flight);
  overlayRoot.append(flightDock);
  visibleCompletions.delete(id);
  render();
  const x = (target.left + target.width / 2 - (rect.left + rect.width / 2)) / scale;
  const y = (target.top + target.height / 2 - (rect.top + rect.height / 2)) / scale;
  flight.animate([
    { transform: "translate(0, 0) scale(1)", opacity: 1 },
    { transform: `translate(${x}px, ${y}px) scale(.28)`, opacity: .1 },
  ], {
    duration: reducedMotion() ? 1 : 420,
    easing: "cubic-bezier(.2,.75,.3,1)",
    fill: "forwards",
  }).finished.finally(() => {
    flightDock.remove();
  });
}

function hideCompletionBubble() {
  const remaining = completionExpiresAt - Date.now();
  if (remaining > 0) {
    completionTimer = setTimeout(hideCompletionBubble, remaining);
    return;
  }
  completionBubble.classList.add("fading");
  completionTimer = setTimeout(() => {
    completionBubble.hidden = true;
    completionBubble.classList.remove("fading", "pulse");
    completionCount = 0;
    render();
  }, reducedMotion() ? 1 : MOTION_MS);
}

function applyTheme() {
  const root = document.documentElement;
  const variables = {
    "--text": theme.text_color || "#eef8ff",
    "--muted": theme.muted_color || "#9fc6dc",
    "--uploading-color": theme.uploading_color || "#38bdf8",
    "--staged-color": theme.staged_color || "#f59e0b",
    "--processing-color": theme.processing_color || "#facc15",
    "--completed-color": theme.completed_color || "#22c55e",
    "--failed-color": theme.failed_color || "#ef4444",
    "--completion-bg": colorWithAlpha(theme.completion_bg_color || theme.panel_bg_color || "#000000", completionAlpha(panelAlpha(.78))),
    "--completion-border": theme.completion_border_color || theme.completed_color || "#22c55e",
    "--completion-text": theme.completion_text_color || theme.text_color || "#eef8ff",
    "--completion-muted": theme.completion_muted_color || theme.muted_color || "#9fc6dc",
    "--completion-glow": theme.completion_glow_color || theme.panel_glow_color || "#000000",
    "--completion-border-width": `${theme.completion_border_width_px ?? theme.panel_border_width_px ?? 1}px`,
    "--completion-radius": `${theme.completion_radius_px ?? 24}px`,
    "--completion-blur": `${theme.completion_backdrop_blur_px ?? theme.backdrop_blur_px ?? 4}px`,
    "--completion-padding-x": `${theme.completion_padding_x_px ?? 12}px`,
    "--completion-padding-y": `${theme.completion_padding_y_px ?? 8}px`,
    "--completion-glow-blur": `${theme.completion_glow_blur_px ?? theme.glow_blur_px ?? 50}px`,
    "--completion-shadow-spread": `${theme.completion_glow_spread_px ?? theme.glow_spread_px ?? 0}px`,
    "--completion-shadow-x": `${theme.completion_glow_offset_x_px ?? theme.glow_offset_x_px ?? 0}px`,
    "--completion-shadow-y": `${theme.completion_glow_offset_y_px ?? theme.glow_offset_y_px ?? 16}px`,
    "--completion-font-family": theme.completion_font_family || theme.font_family || "Inter, system-ui, sans-serif",
    "--completion-font-size": `${theme.completion_font_size_px ?? theme.font_size_base_px ?? 16}px`,
    "--completion-font-weight": String(theme.completion_font_weight ?? theme.font_weight ?? 400),
    "--plot-primary": theme.plot_primary || theme.uploading_color || "#38bdf8",
    "--panel-bg": colorWithAlpha(theme.panel_bg_color || "#000000", panelAlpha(.78)),
    "--panel-border": theme.panel_border_color || theme.uploading_color || "#38bdf8",
    "--panel-glow": theme.panel_glow_color || "#000000",
    "--block-bg": colorWithAlpha(theme.block_bg_color || "#132f3d", blockAlpha(1)),
    "--block-border": theme.block_border_color || "transparent",
    "--radius": `${theme.border_radius_px ?? 10}px`,
    "--blur": `${theme.backdrop_blur_px ?? 4}px`,
    "--panel-padding": `${theme.panel_padding_px ?? 14}px`,
    "--block-padding": `${theme.block_padding_px ?? 8}px`,
    "--block-gap": `${theme.block_gap_px ?? 7}px`,
    "--journey-gap": `${theme.journey_gap_px ?? 8}px`,
    "--panel-border-width": `${theme.panel_border_width_px ?? 1}px`,
    "--block-border-width": `${theme.block_border_width_px ?? 0}px`,
    "--glow-blur": `${theme.glow_blur_px ?? 50}px`,
    "--shadow-spread": `${theme.glow_spread_px ?? 0}px`,
    "--shadow-x": `${theme.glow_offset_x_px ?? 0}px`,
    "--shadow-y": `${theme.glow_offset_y_px ?? 16}px`,
    "--font-size": `${theme.font_size_base_px ?? 16}px`,
    "--font-family": theme.font_family || "Inter, system-ui, sans-serif",
    "--font-weight": String(theme.font_weight ?? 400),
    "--subheader-font-family": theme.subheader_font_family || theme.font_family || "Inter, system-ui, sans-serif",
    "--subheader-font-size": `${theme.subheader_font_size_px ?? 12}px`,
    "--subheader-font-weight": String(theme.subheader_font_weight ?? 500),
    "--scale": String(preset.layout.scale ?? 1),
  };
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
}

function applyLayout() {
  const dock = preset.layout.dock || "bl";
  const growth = layoutGrowth(preset.layout);
  const padValue = boundedNumber(preset.layout.pad, 0, 200, 20);
  const pad = `${padValue}px`;
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
  const horizontal = growth.y === "center" && growth.x !== "center";
  uploadStack.dataset.dock = dock;
  uploadStack.dataset.axis = horizontal ? "x" : "y";
  uploadStack.dataset.growthX = growth.x;
  uploadStack.dataset.growthY = growth.y === "center" ? (dock.startsWith("t") ? "down" : "up") : growth.y;
  uploadStack.style.setProperty("--card-width", `${safeCardWidth()}px`);
  const direction = completionDirection(dock, growth, horizontal);
  uploadStack.style.setProperty("--failure-x", direction === "right" ? "-54px" : "54px");
  uploadStack.style.setProperty("--failure-rotate", direction === "right" ? "-4deg" : "4deg");

  if (elementPreviewMode) {
    Object.assign(uploadStack.style, { top: "", right: "", bottom: "", left: "", width: horizontal ? "max-content" : "var(--card-width)" });
    uploadStack.style.transform = "scale(var(--scale, 1))";
    uploadStack.style.transformOrigin = "top left";
  } else {
    Object.assign(uploadStack.style, { top: "", right: "", bottom: "", left: "", width: horizontal ? "max-content" : "min(var(--card-width), calc(100vw - 20px))" }, position);
    uploadStack.style.transform = `${transform} scale(var(--scale, 1))`.trim();
    uploadStack.style.transformOrigin = origin;
  }
}

function publishPreviewSize() {
  if (!elementPreviewMode || window.parent === window) return;
  requestAnimationFrame(() => {
    const size = previewVisualBounds([
      uploadStack,
      completionDock,
      ...journeyList.children,
      ...overlayRoot.querySelectorAll(".journey-flight-dock"),
    ]);
    if (!size.content_width || !size.content_height) return;
    window.parent.postMessage({ type: "frame-preview-size", ...size }, "*");
  });
}

function rememberJourneyAnchor(preferredId = "") {
  const preferred = preferredId
    ? journeyList.querySelector(`[data-journey-id="${CSS.escape(preferredId)}"]`)
    : null;
  const lead = preferred || journeyList.firstElementChild;
  if (!lead) return;
  completionAnchorRect = rectangle(lead.getBoundingClientRect());
  const obstacle = rectangle(journeyList.getBoundingClientRect());
  completionObstacleRect = obstacle.width > 0 && obstacle.height > 0 ? obstacle : completionAnchorRect;
}

function positionCompletionBubble(preferredId = "") {
  if (preferredId || !completionAnchorRect) rememberJourneyAnchor(preferredId);
  if (!completionAnchorRect) return;
  const scale = boundedNumber(preset.layout.scale, .5, 3, 1);
  const margin = boundedNumber(preset.layout.pad, 0, 200, 20);
  const maxWidth = elementPreviewMode
    ? 420
    : Math.max(1, Math.min(420, (window.innerWidth - margin * 2) / scale));
  completionBubble.style.maxWidth = `${maxWidth}px`;
  const bubbleRect = completionBubble.getBoundingClientRect();
  const growth = layoutGrowth(preset.layout);
  const horizontal = growth.y === "center" && growth.x !== "center";
  const position = completionDockPosition({
    anchor: completionAnchorRect,
    obstacle: completionObstacleRect || completionAnchorRect,
    bubble: { width: bubbleRect.width, height: bubbleRect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    direction: completionDirection(preset.layout.dock || "bl", growth, horizontal),
    alignment: config.completion_alignment === "end" ? "end" : "start",
    gap: boundedNumber(theme.block_gap_px, 0, 40, 7) * scale,
    margin,
    allowOverlap: config.completion_overlap === true,
  });
  const rootRect = overlayRoot.getBoundingClientRect();
  completionDock.style.left = `${position.left - rootRect.left}px`;
  completionDock.style.top = `${position.top - rootRect.top}px`;
  completionDock.dataset.direction = position.direction;
  completionDock.dataset.overlap = String(position.overlap);
}

function completionDirection(dock, growth, horizontal) {
  const configured = ["left", "right", "up", "down"].includes(config.completion_direction)
    ? config.completion_direction
    : null;
  if (horizontal) {
    if (configured === "up" || configured === "down") return configured;
    return dock.startsWith("b") ? "up" : "down";
  }
  if (configured === "left" || configured === "right") return configured;
  if (dock === "tr" || dock === "r" || dock === "br") return "left";
  return "right";
}

function phaseColor(phase) {
  if (phase === "staged") return theme.staged_color || "#f59e0b";
  if (phase === "processing") return theme.processing_color || "#facc15";
  if (phase === "published") return theme.completed_color || "#22c55e";
  if (phase === "failed") return theme.failed_color || "#ef4444";
  return theme.uploading_color || "#38bdf8";
}

function completionWindowMs() {
  return boundedNumber(config.completion_window_seconds, 1, 30, 3) * 1000;
}

function visibleJourneyLimit() {
  const configured = Math.round(boundedNumber(config.max_visible_journeys, 1, 5, 5));
  const growth = layoutGrowth(preset.layout);
  const horizontal = growth.y === "center" && growth.x !== "center";
  if (!horizontal || elementPreviewMode) return configured;
  const scale = boundedNumber(preset.layout.scale, .5, 3, 1);
  const margin = boundedNumber(preset.layout.pad, 0, 200, 20);
  const gap = boundedNumber(theme.journey_gap_px, 0, 40, 8) * scale;
  return horizontalJourneyLimit(configured, window.innerWidth, safeCardWidth() * scale, gap, margin);
}

function safeCardWidth() {
  const requested = boundedNumber(config.width_px || preset.layout.width_px, 1, 1200, 520);
  if (elementPreviewMode) return requested;
  const scale = boundedNumber(preset.layout.scale, .5, 3, 1);
  const margin = boundedNumber(preset.layout.pad, 0, 200, 20);
  return Math.max(1, Math.min(requested, (window.innerWidth - margin * 2) / scale));
}

function panelAlpha(fallback) {
  return Number.isFinite(Number(theme.panel_bg_alpha)) ? Number(theme.panel_bg_alpha) : fallback;
}

function completionAlpha(fallback) {
  return Number.isFinite(Number(theme.completion_bg_alpha)) ? Number(theme.completion_bg_alpha) : fallback;
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

function boundedNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function rectangle(rect) {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function journeyId(journey) {
  return String(journey?.journey_id || journey?.transfer_id || "");
}

function motionOptions() {
  return {
    duration: reducedMotion() ? 1 : MOTION_MS,
    easing: "ease",
  };
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
