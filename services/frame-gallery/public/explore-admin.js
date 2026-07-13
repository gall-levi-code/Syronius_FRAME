import {
  captureTimestamp,
  inferTimeShiftSeconds,
  matchExplorePhotos,
  routeSegments,
  simulatedRouteSegments,
  splitTrackPoints,
} from "./explore.js?v=gallery-explore-7";

const PRIVACY_ACK_KEY = "frame-gallery-explore-privacy-acknowledged";
const MAX_GPX_BYTES = 5 * 1024 * 1024;
const MAX_ROUTES = 20;
const MAX_SEGMENTS = 2_000;
const MAX_POINTS = 50_000;
const MAX_JSON_BYTES = 5 * 1024 * 1024;
const dateFolder = new URL(location.href).searchParams.get("date") || "";
const elements = Object.fromEntries([
  "page-title", "page-summary", "status", "open-gallery", "gpx-input", "route-list", "no-routes",
  "time-shift", "time-adjustment", "auto-align", "alignment-summary", "photo-list", "map-summary",
  "explore-map", "delete-explore", "save-explore", "privacy-warning", "dismiss-privacy-warning",
  "photo-previous", "photo-next", "unpublish-dialog",
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));
const state = {
  photos: [],
  explore: freshExplore(),
  selectedBase: null,
  map: null,
  layers: null,
  published: false,
  dirty: false,
  busy: false,
};

elements.gpx_input.addEventListener("change", importGpxFiles);
elements.time_shift.addEventListener("change", updateAlignment);
elements.time_adjustment.addEventListener("input", updateAlignment);
elements.auto_align.addEventListener("click", autoAlign);
elements.dismiss_privacy_warning.addEventListener("click", acknowledgePrivacyWarning);
elements.photo_previous.addEventListener("click", () => movePhoto(-1));
elements.photo_next.addEventListener("click", () => movePhoto(1));
elements.save_explore.addEventListener("click", saveExplore);
elements.delete_explore.addEventListener("click", showUnpublishDialog);
elements.unpublish_dialog.addEventListener("close", () => {
  if (elements.unpublish_dialog.returnValue === "unpublish") deleteExplore();
});
try {
  elements.privacy_warning.hidden = localStorage.getItem(PRIVACY_ACK_KEY) === "true";
} catch {}
window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFolder)) {
  setStatus("Choose an album in Gallery Admin first", "error");
  setBusy(true);
} else {
  await load();
}

async function load() {
  setStatus("Loading Explore", "working");
  try {
    const [photoBody, exploreBody] = await Promise.all([
      requestJson(`/gallery/api/photos?date=${encodeURIComponent(dateFolder)}`),
      requestJson(`/gallery/admin/api/explore?date=${encodeURIComponent(dateFolder)}`),
    ]);
    state.photos = Array.isArray(photoBody.photos) ? photoBody.photos : [];
    state.published = Boolean(exploreBody.explore);
    state.explore = exploreBody.explore || freshExplore();
    elements.page_title.textContent = `Explore · ${formatDate(dateFolder)}`;
    elements.page_summary.textContent = `${state.photos.length} published photo${state.photos.length === 1 ? "" : "s"}`;
    elements.open_gallery.href = `/gallery/${encodeURIComponent(dateFolder)}/?view=explore`;
    const mapReady = initMap();
    render({ fit: true });
    setStatus(mapReady ? "Ready" : "Map unavailable — GPX editing still works", mapReady ? "ready" : "error");
  } catch (error) {
    setStatus(error.message || "Explore failed to load", "error");
  }
}

function freshExplore() {
  return {
    schema_version: 1,
    time_shift_seconds: 0,
    time_adjustment_seconds: 0,
    routes: [],
    placements: {},
  };
}

function initMap() {
  if (state.map) return true;
  if (!window.L) return showMapUnavailable();
  try {
    state.map = L.map(elements.explore_map, { preferCanvas: true }).setView([39, -98], 4);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(state.map);
    state.layers = L.layerGroup().addTo(state.map);
    state.map.on("click", ({ latlng }) => setManualPlacement(latlng.lat, latlng.lng));
    return true;
  } catch {
    state.map = null;
    state.layers = null;
    return showMapUnavailable();
  }
}

function showMapUnavailable() {
  elements.explore_map.classList.add("map-unavailable");
  elements.explore_map.textContent = "Map preview unavailable. Check this device's internet connection; GPX import and time alignment remain available.";
  return false;
}

function render({ fit = false } = {}) {
  renderRoutes();
  renderPhotos();
  renderMap(fit);
  elements.time_shift.value = String(state.explore.time_shift_seconds || 0);
  elements.time_adjustment.value = String(state.explore.time_adjustment_seconds || 0);
  elements.delete_explore.hidden = !state.published;
  elements.delete_explore.disabled = state.busy;
  elements.save_explore.disabled = state.busy || !state.explore.routes.length;
}

function renderRoutes() {
  elements.route_list.replaceChildren(...state.explore.routes.map((route) => {
    const item = document.createElement("li");
    item.className = "route-item";
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    const summary = document.createElement("small");
    const remove = document.createElement("button");
    const points = route.segments.reduce((sum, segment) => sum + segment.length, 0);
    name.textContent = route.name;
    summary.textContent = `${points.toLocaleString()} points · ${route.segments.length} segment${route.segments.length === 1 ? "" : "s"} · ${routeTimeLabel(route)}`;
    remove.type = "button";
    remove.className = "danger-button compact-button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${route.name}`);
    remove.addEventListener("click", () => {
      state.explore.routes = state.explore.routes.filter((candidate) => candidate.id !== route.id);
      state.dirty = true;
      render({ fit: true });
      setStatus("Route removed — save to publish", "working");
    });
    copy.append(name, summary);
    item.append(copy, remove);
    return item;
  }));
  elements.no_routes.hidden = state.explore.routes.length > 0;
}

function renderPhotos() {
  const matches = matchExplorePhotos(state.photos, state.explore);
  const photos = state.photos.map((photo, index) => {
    const match = matches.get(photo.base);
    return {
      photo,
      index,
      match,
      time: Number.isFinite(match?.time) ? match.time : captureTimestamp(photo.capture_clock),
    };
  }).sort((left, right) =>
    Number(Boolean(left.match)) - Number(Boolean(right.match))
    || (Number.isFinite(left.time) ? left.time : Infinity) - (Number.isFinite(right.time) ? right.time : Infinity)
    || left.index - right.index);
  elements.photo_list.replaceChildren(...photos.map(({ photo, match }) => {
    const card = document.createElement("article");
    const button = document.createElement("button");
    const visual = document.createElement("span");
    const image = document.createElement("img");
    const name = document.createElement("strong");
    const badge = document.createElement("span");
    card.className = "explore-photo";
    card.dataset.mapped = String(Boolean(match));
    button.type = "button";
    button.className = "explore-photo-select";
    button.dataset.base = photo.base;
    button.setAttribute("aria-pressed", String(state.selectedBase === photo.base));
    visual.className = "explore-photo-image";
    image.src = photo.thumbnail_url;
    image.alt = "";
    image.loading = "lazy";
    name.textContent = friendlyBase(photo.base);
    name.title = photo.base;
    badge.className = "map-state";
    badge.dataset.mapped = String(Boolean(match));
    badge.dataset.manual = String(match?.source === "manual");
    badge.textContent = match?.source === "manual" ? "Manual" : match ? "Mapped" : "Unmapped";
    button.addEventListener("click", () => selectPhoto(photo.base));
    visual.append(image, badge);
    button.append(visual, name);
    card.append(button);
    if (match?.source === "manual") {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "explore-photo-reset";
      reset.textContent = "\u21ba";
      reset.title = "Reset to automatic placement";
      reset.setAttribute("aria-label", `Reset ${friendlyBase(photo.base)} to automatic placement`);
      reset.addEventListener("click", () => resetPlacement(photo.base));
      card.append(reset);
    }
    return card;
  }));
  elements.photo_previous.disabled = state.busy || photos.length < 2;
  elements.photo_next.disabled = state.busy || photos.length < 2;
  elements.explore_map.classList.toggle("is-placing", Boolean(state.selectedBase));
  elements.photo_list.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: "nearest", inline: "center" });
}

function movePhoto(offset) {
  const bases = [...elements.photo_list.querySelectorAll("button[data-base]")].map((button) => button.dataset.base);
  if (!bases.length) return;
  const current = bases.indexOf(state.selectedBase);
  const index = current < 0 ? (offset > 0 ? 0 : bases.length - 1) : (current + offset + bases.length) % bases.length;
  selectPhoto(bases[index]);
}

function renderMap(fit = false) {
  const matches = matchExplorePhotos(state.photos, state.explore);
  elements.map_summary.textContent = `${state.explore.routes.length} route${state.explore.routes.length === 1 ? "" : "s"} · ${matches.size} of ${state.photos.length} photos mapped`;
  elements.alignment_summary.textContent = `${matches.size} photos align at ${signedSeconds(state.explore.time_shift_seconds)} coarse and ${signedSeconds(state.explore.time_adjustment_seconds)} fine.`;
  if (!state.map || !state.layers) return;
  state.layers.clearLayers();
  const bounds = L.latLngBounds([]);
  const colors = ["#2cb4fb", "#2cfbb3", "#f0b429", "#fa6d9a", "#9e7bff"];
  state.explore.routes.forEach((route, routeIndex) => {
    for (const segment of route.segments) {
      const latLngs = segment.map(([, lat, lon]) => [lat, lon]);
      if (latLngs.length < 2) continue;
      L.polyline(latLngs, { color: colors[routeIndex % colors.length], weight: 4, opacity: 0.82 })
        .bindTooltip(tooltipText(route.name))
        .addTo(state.layers);
      bounds.extend(L.latLngBounds(latLngs));
    }
  });
  for (const segment of simulatedRouteSegments(state.photos, state.explore)) {
    const latLngs = segment.map(([, lat, lon]) => [lat, lon]);
    L.polyline(latLngs, { color: "#f0b429", weight: 3, opacity: 0.9, dashArray: "7 7", interactive: false })
      .addTo(state.layers);
    bounds.extend(L.latLngBounds(latLngs));
  }

  for (const photo of state.photos) {
    const match = matches.get(photo.base);
    if (!match) continue;
    const selected = photo.base === state.selectedBase;
    const marker = L.circleMarker([match.lat, match.lon], {
      radius: selected ? 9 : 6,
      color: "#ffffff",
      weight: selected ? 3 : 2,
      fillColor: match.source === "manual" ? "#f0b429" : "#2cb4fb",
      fillOpacity: 0.95,
      bubblingMouseEvents: false,
    }).bindTooltip(tooltipText(friendlyBase(photo.base)));
    marker.on("click", () => selectPhoto(photo.base, false));
    marker.addTo(state.layers);
    bounds.extend([match.lat, match.lon]);
  }
  if (fit && bounds.isValid()) state.map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
  requestAnimationFrame(() => state.map.invalidateSize());
}

function selectPhoto(base, moveMap = true) {
  state.selectedBase = base;
  renderPhotos();
  renderMap();
  if (!moveMap) return;
  const match = matchExplorePhotos(state.photos, state.explore).get(base);
  if (match && state.map) state.map.panTo([match.lat, match.lon]);
}

function updateAlignment() {
  const shift = boundedInteger(elements.time_shift.value);
  const adjustment = boundedInteger(elements.time_adjustment.value);
  if (shift === null || adjustment === null) {
    setStatus("Time offsets must be whole seconds between -86,400 and 86,400", "error");
    return;
  }
  state.explore.time_shift_seconds = shift;
  state.explore.time_adjustment_seconds = adjustment;
  state.dirty = true;
  render();
  setStatus("Alignment changed — save to publish", "working");
}

function autoAlign() {
  if (!routeSegments(state.explore).length) {
    setStatus("Attach a GPX route before auto-aligning", "error");
    return;
  }
  if (!state.photos.some((photo) => photo.capture_clock)) {
    setStatus("This album has no camera capture timestamps to auto-align", "error");
    return;
  }
  state.explore.time_shift_seconds = inferTimeShiftSeconds(state.photos, state.explore.routes);
  state.dirty = true;
  render();
  setStatus("Camera time auto-aligned — fine-tune if needed", "working");
}

function resetPlacement(base = state.selectedBase) {
  if (!base || !Object.hasOwn(state.explore.placements, base)) return;
  state.selectedBase = base;
  delete state.explore.placements[base];
  state.dirty = true;
  render();
  setStatus("Manual placement cleared — save to publish", "working");
}

function setManualPlacement(lat, lon) {
  if (!state.selectedBase) {
    setStatus("Select a photo before placing it", "error");
    return;
  }
  const photo = state.photos.find((candidate) => candidate.base === state.selectedBase);
  const savedTimestamp = state.explore.placements[state.selectedBase]?.timestamp;
  const captureTime = captureTimestamp(photo?.capture_clock);
  const timestamp = Number.isInteger(savedTimestamp) ? savedTimestamp : captureTime;
  state.explore.placements = {
    ...state.explore.placements,
    [state.selectedBase]: {
      lat,
      lon,
      ...(Number.isFinite(timestamp) ? { timestamp } : {}),
      updated_at: new Date().toISOString(),
    },
  };
  state.dirty = true;
  render();
  setStatus("Manual placement set — save to publish", "working");
}

async function importGpxFiles() {
  const files = [...elements.gpx_input.files];
  elements.gpx_input.value = "";
  if (!files.length) return;
  if (state.explore.routes.length + files.length > MAX_ROUTES) {
    setStatus(`Explore supports up to ${MAX_ROUTES} GPX files`, "error");
    return;
  }
  setBusy(true);
  setStatus("Reading GPX files", "working");
  try {
    const routes = [];
    for (const file of files) routes.push(await parseGpx(file));
    const next = [...state.explore.routes, ...routes];
    const segments = routeSegments(next);
    const points = segments.reduce((sum, segment) => sum + segment.length, 0);
    if (segments.length > MAX_SEGMENTS) throw new Error(`GPX import exceeds ${MAX_SEGMENTS.toLocaleString()} route segments`);
    if (points > MAX_POINTS) throw new Error(`GPX import exceeds ${MAX_POINTS.toLocaleString()} points`);
    const nextExplore = {
      ...state.explore,
      routes: next,
      time_shift_seconds: inferTimeShiftSeconds(state.photos, next),
    };
    assertPayloadSize(nextExplore);
    state.explore = nextExplore;
    state.dirty = true;
    render({ fit: true });
    setStatus(`${routes.length} GPX file${routes.length === 1 ? "" : "s"} added — save to publish`, "working");
  } catch (error) {
    setStatus(error.message || "GPX import failed", "error");
  } finally {
    setBusy(false);
    render();
  }
}

async function parseGpx(file) {
  if (file.size > MAX_GPX_BYTES) throw new Error(`${file.name} is larger than 5 MB`);
  const source = await file.text();
  if (/<\s*!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) throw new Error(`${file.name} contains a disallowed XML declaration`);
  const documentNode = new DOMParser().parseFromString(source, "application/xml");
  if (documentNode.querySelector("parsererror") || documentNode.documentElement?.localName.toLowerCase() !== "gpx") {
    throw new Error(`${file.name} is not valid GPX XML`);
  }

  const segments = [];
  let parsedPointCount = 0;
  for (const trackSegment of documentNode.getElementsByTagNameNS("*", "trkseg")) {
    const points = [];
    for (const trackPoint of trackSegment.getElementsByTagNameNS("*", "trkpt")) {
      const latText = trackPoint.getAttribute("lat");
      const lonText = trackPoint.getAttribute("lon");
      const timeNode = [...trackPoint.children].find((child) => child.localName === "time");
      const timeText = timeNode?.textContent?.trim() || "";
      const lat = latText?.trim() ? Number(latText) : NaN;
      const lon = lonText?.trim() ? Number(lonText) : NaN;
      const time = Date.parse(timeText);
      const hasTimeZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(timeText);
      if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180 || !hasTimeZone || !Number.isInteger(time) || time < 0) {
        throw new Error(`${file.name} has a track point with invalid coordinates or time`);
      }
      points.push([time, lat, lon]);
      parsedPointCount += 1;
      if (parsedPointCount > MAX_POINTS) throw new Error(`${file.name} exceeds ${MAX_POINTS.toLocaleString()} points`);
    }
    segments.push(...splitTrackPoints(points));
  }
  if (!segments.length) throw new Error(`${file.name} has no usable timestamped track segments`);
  return {
    id: routeId(),
    name: file.name.trim().slice(0, 240) || "Imported route.gpx",
    imported_at: new Date().toISOString(),
    segments,
  };
}

async function saveExplore() {
  if (!state.explore.routes.length) {
    setStatus("Attach at least one GPX route before publishing", "error");
    return;
  }
  setBusy(true);
  elements.save_explore.textContent = "Publishing...";
  setStatus("Publishing Explore", "working");
  let published = false;
  try {
    assertPayloadSize();
    const body = await requestJson(`/gallery/admin/api/explore?date=${encodeURIComponent(dateFolder)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state.explore),
    });
    state.explore = body.explore;
    state.published = true;
    state.dirty = false;
    render();
    published = true;
    elements.save_explore.textContent = "Published";
    setStatus("Explore published", "ready");
    await new Promise((resolve) => setTimeout(resolve, 700));
    location.assign(`/gallery/${encodeURIComponent(dateFolder)}/?view=explore`);
  } catch (error) {
    elements.save_explore.textContent = "Save and publish Explore";
    setStatus(error.message || "Explore could not be saved", "error");
  } finally {
    setBusy(false);
    if (!published) render();
  }
}

function acknowledgePrivacyWarning() {
  elements.privacy_warning.hidden = true;
  try { localStorage.setItem(PRIVACY_ACK_KEY, "true"); } catch {}
  setStatus("Privacy warning acknowledged", "ready");
}

function showUnpublishDialog() {
  if (!state.published || state.busy) return;
  elements.unpublish_dialog.returnValue = "";
  elements.unpublish_dialog.showModal();
}

async function deleteExplore() {
  if (!state.published) return;
  setBusy(true);
  setStatus("Unpublishing Explore", "working");
  try {
    await requestJson(`/gallery/admin/api/explore?date=${encodeURIComponent(dateFolder)}`, { method: "DELETE" });
    state.explore = freshExplore();
    state.published = false;
    state.selectedBase = null;
    state.dirty = false;
    render({ fit: true });
    setStatus("Explore unpublished", "ready");
  } catch (error) {
    setStatus(error.message || "Explore could not be unpublished", "error");
  } finally {
    setBusy(false);
    render();
  }
}

function assertPayloadSize(explore = state.explore) {
  if (new TextEncoder().encode(JSON.stringify(explore)).byteLength > MAX_JSON_BYTES) {
    throw new Error("Explore data exceeds the 5 MB publish limit; remove or simplify a route");
  }
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll("button, input").forEach((control) => { control.disabled = busy; });
}

function setStatus(message, kind) {
  elements.status.textContent = message;
  elements.status.dataset.kind = kind;
}

async function requestJson(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function routeId() {
  return crypto.randomUUID?.() || `route_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function boundedInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && Math.abs(number) <= 86_400 ? number : null;
}

function signedSeconds(value) {
  const number = Number(value) || 0;
  return `${number >= 0 ? "+" : ""}${number}s`;
}

function formatDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}

function routeTimeLabel(route) {
  const starts = route.segments.map((segment) => segment[0]?.[0]).filter(Number.isFinite);
  const ends = route.segments.map((segment) => segment.at(-1)?.[0]).filter(Number.isFinite);
  if (!starts.length || !ends.length) return "unknown time";
  const options = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" };
  return `${new Date(Math.min(...starts)).toLocaleString([], options)}–${new Date(Math.max(...ends)).toLocaleString([], options)}`;
}

function friendlyBase(base) {
  return base.replace(/_\d{4}-\d{2}-\d{2}_\d{2}_\d{2}_\d{2}(?:_\d+)?$/, "").replaceAll("_", " ");
}

function tooltipText(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span;
}
