const ACTIVE_PHASE_RANK = new Map([
  ["processing", 0],
  ["staged", 1],
  ["uploading", 2],
]);
const JOURNEY_STATUS = {
  uploading: "File transfer in progress",
  staged: "Upload received; waiting for processing",
  processing: "Preparing photo for publication",
  published: "Photo published",
};

export function previewJourneySnapshots(scenario = "queue", now = Date.now()) {
  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const journey = (id, phase, filename, received, total, speed, age, error = null) => ({
    journey_id: `preview-${id}`,
    transfer_id: `preview-${id}`,
    adapter: "web_upload",
    adapters: ["web_upload"],
    phase,
    filename,
    bytes_received: received,
    bytes_total: total,
    speed_bps: speed,
    elapsed_ms: age,
    started_at: new Date(timestamp - age).toISOString(),
    updated_at: new Date(timestamp).toISOString(),
    status_text: JOURNEY_STATUS[phase] || "Upload failed",
    transfer_completed_at: phase === "published" ? new Date(timestamp).toISOString() : null,
    error,
    stages: [],
  });
  const snapshot = (sequence, journeys) => ({
    schema_version: "2.0",
    sequence,
    observed_at: new Date(timestamp).toISOString(),
    received_at: new Date(timestamp).toISOString(),
    stale: false,
    journeys,
  });
  const active = journey("focus", "uploading", "FRAME_Adventure_001.jpg", 9_437_184, 12_582_912, 1_572_864, 6200);

  if (scenario === "uploading") return [snapshot(1, [active])];
  if (scenario === "staged") return [snapshot(1, [{ ...active, phase:"staged", bytes_received:active.bytes_total, speed_bps:null, status_text:JOURNEY_STATUS.staged }])];
  if (scenario === "processing") return [snapshot(1, [{ ...active, phase:"processing", bytes_received:active.bytes_total, speed_bps:null, status_text:JOURNEY_STATUS.processing }])];
  if (scenario === "failed") return [
    snapshot(1, [active]),
    snapshot(2, [{ ...active, phase:"failed", updated_at:new Date(timestamp + 400).toISOString(), status_text:"Upload failed", error:"Transfer interrupted" }]),
  ];
  if (scenario === "completed") return [
    snapshot(1, [{ ...active, phase:"processing", bytes_received:active.bytes_total, speed_bps:null, status_text:JOURNEY_STATUS.processing }]),
    snapshot(2, [{ ...active, phase:"published", bytes_received:active.bytes_total, speed_bps:null, updated_at:new Date(timestamp + 400).toISOString(), transfer_completed_at:new Date(timestamp + 400).toISOString(), status_text:JOURNEY_STATUS.published }]),
  ];
  if (scenario === "idle") return [snapshot(1, [])];
  return [snapshot(1, [
    journey("processing", "processing", "FRAME_Adventure_001.jpg", 12_582_912, 12_582_912, null, 6200),
    journey("staged", "staged", "FRAME_Adventure_002.jpg", 8_388_608, 8_388_608, null, 5100),
    journey("near", "uploading", "FRAME_Adventure_003.jpg", 18_874_368, 20_971_520, 1_572_864, 4700),
    journey("middle", "uploading", "Mobile_Camera_Roll_004.jpg", 6_291_456, 12_582_912, 786_432, 3900),
    journey("early", "uploading", "Long_Camera_Filename_That_Ellipsizes_005.jpg", 2_097_152, 15_728_640, 524_288, 2600),
  ])];
}

export function deriveJourneyQueue(journeys, maxVisible = 5) {
  const source = Array.isArray(journeys) ? journeys : [];
  const ranked = source.filter((journey) => ACTIVE_PHASE_RANK.has(journey?.phase)).sort(compareActiveJourneys);
  const limit = Number.isFinite(Number(maxVisible)) ? Math.max(0, Math.floor(Number(maxVisible))) : 5;
  return {
    active: ranked.slice(0, limit),
    active_total: ranked.length,
    hidden_active: Math.max(0, ranked.length - limit),
  };
}

export function stabilizeJourneyOrder(journeys, previousState, now = Date.now(), delayMs = 1000) {
  const next = Array.isArray(journeys) ? journeys : [];
  const candidate = next.map(journeyIdentity);
  const current = Array.isArray(previousState?.order) ? previousState.order : [];
  const committed = { order: candidate, pending: null, pending_since: null };

  if (!sameMembers(current, candidate)) return { journeys: next, state: committed };
  if (sameOrder(current, candidate)) return { journeys: next, state: committed };

  const pending = Array.isArray(previousState?.pending) ? previousState.pending : [];
  const pendingSince = Number(previousState?.pending_since);
  if (!sameOrder(pending, candidate) || !Number.isFinite(pendingSince)) {
    return {
      journeys: orderByIdentity(next, current),
      state: { order: current, pending: candidate, pending_since: now },
    };
  }
  if (now - pendingSince < Math.max(0, Number(delayMs) || 0)) {
    return { journeys: orderByIdentity(next, current), state: previousState };
  }
  return { journeys: next, state: committed };
}

function newlyPublishedJourneys(previousJourneys, nextJourneys) {
  const previouslyPublished = new Set((Array.isArray(previousJourneys) ? previousJourneys : [])
    .filter((journey) => journey?.phase === "published")
    .map(journeyIdentity));
  const emitted = new Set();
  return (Array.isArray(nextJourneys) ? nextJourneys : []).filter((journey) => {
    const id = journeyIdentity(journey);
    if (!id || journey?.phase !== "published" || previouslyPublished.has(id) || emitted.has(id)) return false;
    emitted.add(id);
    return true;
  });
}

export function unseenCompletedJourneys(
  previousJourneys,
  nextJourneys,
  seen,
  now = Date.now(),
  completionWindowMs = Number.POSITIVE_INFINITY,
) {
  const completed = Array.isArray(previousJourneys)
    ? newlyPublishedJourneys(previousJourneys, nextJourneys).filter((journey) => !seen.has(journeyIdentity(journey)))
    : [];
  for (const journey of Array.isArray(nextJourneys) ? nextJourneys : []) {
    const id = journeyIdentity(journey);
    if (id && journey?.phase === "published") seen.set(id, now);
  }
  return completed.filter((journey) => {
    const completedAt = Date.parse(journey.transfer_completed_at || journey.updated_at);
    return Number.isFinite(completedAt) && now - completedAt <= Math.max(0, completionWindowMs);
  });
}

export function journeysFromSnapshot(snapshot) {
  if (Array.isArray(snapshot?.journeys)) return snapshot.journeys;
  return [];
}

export function journeysWithActiveGrace(journeys, memory, now = Date.now(), graceMs = 1200) {
  const current = Array.isArray(journeys) ? journeys : [];
  const currentIds = new Set(current.map((journey) => String(journey?.journey_id || "")).filter(Boolean));
  const retained = [];
  for (const [id, entry] of memory) {
    if (currentIds.has(id)) continue;
    if (now - entry.last_seen < Math.max(0, graceMs)) retained.push(entry.journey);
    else memory.delete(id);
  }
  return [...current, ...retained];
}

export function completionDockPosition({
  anchor,
  obstacle = anchor,
  bubble,
  viewport,
  direction = "right",
  alignment = "start",
  gap = 0,
  margin = 0,
  allowOverlap = false,
}) {
  const side = ["left", "right", "up", "down"].includes(direction) ? direction : "right";
  const opposite = { left: "right", right: "left", up: "down", down: "up" };
  const primary = [side, opposite[side]].map((value) =>
    outsideCompletionPosition(anchor, obstacle, bubble, value, alignment, gap));
  const fallback = ["left", "right", "up", "down"]
    .filter((value) => value !== side && value !== opposite[side])
    .map((value) => outsideCompletionPosition(anchor, obstacle, bubble, value, alignment, gap));
  const fitting = primary.find((position) => completionFitsViewport(position, bubble, viewport, margin))
    || (!allowOverlap && fallback.find((position) => completionFitsViewport(position, bubble, viewport, margin)));
  if (fitting) return { ...fitting, overlap: false };

  if (allowOverlap) {
    return {
      ...clampCompletionPosition(
        insideCompletionPosition(anchor, bubble, side, alignment),
        bubble,
        viewport,
        margin,
      ),
      direction: side,
      overlap: true,
    };
  }

  const candidates = [...primary, ...fallback];
  const best = candidates.sort((left, right) =>
    completionOverflow(left, bubble, viewport, margin) - completionOverflow(right, bubble, viewport, margin))[0];
  const clamped = clampCompletionPosition(best, bubble, viewport, margin);
  return { ...clamped, direction: best.direction, overlap: rectanglesOverlap(clamped, bubble, obstacle) };
}

export function horizontalJourneyLimit(maxVisible, viewportWidth, cardWidth, gap = 0, margin = 0) {
  const configured = Math.max(1, Math.floor(Number(maxVisible) || 1));
  const available = Math.max(1, Number(viewportWidth) - Math.max(0, Number(margin) || 0) * 2);
  const itemWidth = Math.max(1, Number(cardWidth) || 1);
  const itemGap = Math.max(0, Number(gap) || 0);
  return Math.max(1, Math.min(configured, Math.floor((available + itemGap) / (itemWidth + itemGap))));
}

export function journeyPercent(journey) {
  if (journey?.phase === "staged" || journey?.phase === "processing" || journey?.phase === "published") return 100;
  const total = positiveNumber(journey?.bytes_total);
  if (total === null) return null;
  return Math.min(100, (nonNegativeNumber(journey?.bytes_received) / total) * 100);
}

export function journeyEtaMs(journey) {
  if (journey?.phase !== "uploading") return null;
  const total = positiveNumber(journey.bytes_total);
  const speed = positiveNumber(journey.speed_bps);
  if (total === null || speed === null) return null;
  return (Math.max(0, total - nonNegativeNumber(journey.bytes_received)) / speed) * 1000;
}

export function journeyStatusText(journey) {
  if (journey?.phase === "failed") return journey.error || "Upload failed";
  return JOURNEY_STATUS[journey?.phase] || "File transfer in progress";
}

export function formatBytes(bytes) {
  const value = nonNegativeNumber(bytes);
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(nonNegativeNumber(milliseconds) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function compareActiveJourneys(left, right) {
  const phase = ACTIVE_PHASE_RANK.get(left.phase) - ACTIVE_PHASE_RANK.get(right.phase);
  if (phase) return phase;
  if (left.phase === "uploading") {
    const leftEta = journeyEtaMs(left);
    const rightEta = journeyEtaMs(right);
    if (leftEta !== null || rightEta !== null) {
      if (leftEta === null) return 1;
      if (rightEta === null) return -1;
      if (leftEta !== rightEta) return leftEta - rightEta;
    } else {
      const leftPercent = journeyPercent(left);
      const rightPercent = journeyPercent(right);
      if (leftPercent !== null || rightPercent !== null) {
        if (leftPercent === null) return 1;
        if (rightPercent === null) return -1;
        if (leftPercent !== rightPercent) return rightPercent - leftPercent;
      }
    }
  }
  return compareOldest(left, right);
}

function compareOldest(left, right) {
  return timestamp(left.started_at) - timestamp(right.started_at)
    || journeyIdentity(left).localeCompare(journeyIdentity(right));
}

function orderByIdentity(journeys, order) {
  const byId = new Map(journeys.map((journey) => [journeyIdentity(journey), journey]));
  return order.flatMap((id) => byId.has(id) ? [byId.get(id)] : []);
}

function sameMembers(left, right) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function sameOrder(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function outsideCompletionPosition(anchor, obstacle, bubble, direction, alignment, gap) {
  const end = alignment === "end";
  if (direction === "left" || direction === "right") {
    return {
      direction,
      left: direction === "left" ? obstacle.left - gap - bubble.width : obstacle.right + gap,
      top: end ? anchor.bottom - bubble.height : anchor.top,
    };
  }
  return {
    direction,
    left: end ? anchor.right - bubble.width : anchor.left,
    top: direction === "up" ? obstacle.top - gap - bubble.height : obstacle.bottom + gap,
  };
}

function insideCompletionPosition(anchor, bubble, direction, alignment) {
  const end = alignment === "end";
  if (direction === "left" || direction === "right") {
    return {
      left: direction === "left" ? anchor.left : anchor.right - bubble.width,
      top: end ? anchor.bottom - bubble.height : anchor.top,
    };
  }
  return {
    left: end ? anchor.right - bubble.width : anchor.left,
    top: direction === "up" ? anchor.top : anchor.bottom - bubble.height,
  };
}

function completionFitsViewport(position, bubble, viewport, margin) {
  return position.left >= margin
    && position.top >= margin
    && position.left + bubble.width <= viewport.width - margin
    && position.top + bubble.height <= viewport.height - margin;
}

function completionOverflow(position, bubble, viewport, margin) {
  return Math.max(0, margin - position.left)
    + Math.max(0, margin - position.top)
    + Math.max(0, position.left + bubble.width - (viewport.width - margin))
    + Math.max(0, position.top + bubble.height - (viewport.height - margin));
}

function clampCompletionPosition(position, bubble, viewport, margin) {
  return {
    left: Math.max(margin, Math.min(position.left, Math.max(margin, viewport.width - margin - bubble.width))),
    top: Math.max(margin, Math.min(position.top, Math.max(margin, viewport.height - margin - bubble.height))),
  };
}

function rectanglesOverlap(position, bubble, obstacle) {
  return position.left < obstacle.right
    && position.left + bubble.width > obstacle.left
    && position.top < obstacle.bottom
    && position.top + bubble.height > obstacle.top;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function journeyIdentity(journey) {
  return String(journey?.journey_id || journey?.transfer_id || "");
}

function timestamp(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}
