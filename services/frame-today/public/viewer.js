const elements = {
  empty: document.querySelector("#viewer-empty"),
  stage: document.querySelector("#photo-stage"),
  current: document.querySelector("#photo-current"),
  next: document.querySelector("#photo-next"),
  exif: document.querySelector("#exif-panel"),
  name: document.querySelector("#photo-name"),
  camera: document.querySelector("#camera-text"),
  details: document.querySelector("#photo-details"),
  status: document.querySelector("#viewer-status"),
};

let socket;
let currentLayer = elements.current;
let nextLayer = elements.next;
let currentPhotoKey = null;
let latestState = null;
let viewerAnimation = null;
let presentationFrame = null;
let photoSessionController = null;
let transitionTimer = null;
let presentationKey = "";
let stateReceivedAt = 0;
let loadRevision = 0;
const tileBatches = new WeakMap();

window.addEventListener("resize", () => {
  clearPresentation();
  layoutLayer(nextLayer, "default");
  syncPresentation();
});
connect();

function connect() {
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/today/ws/viewer`);
  socket.addEventListener("open", () => setStatus("Connected", true));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "STATE") {
      stateReceivedAt = performance.now();
      render(message);
    }
  });
  socket.addEventListener("close", () => {
    setStatus("Reconnecting", false);
    setTimeout(connect, 1200);
  });
  socket.addEventListener("error", () => socket.close());
}

function render(state) {
  latestState = state;
  document.documentElement.classList.toggle("viewer-transparent", !state.show_background);
  document.body.classList.toggle("viewer-transparent", !state.show_background);
  const photo = state.current_photo;
  elements.empty.hidden = Boolean(photo);
  elements.stage.hidden = !photo;
  elements.exif.hidden = !photo || !state.show_exif || state.presentation_mode === "auto-scroll";
  if (!photo) {
    loadRevision += 1;
    currentPhotoKey = null;
    clearPresentation();
    clearLayers();
    return;
  }

  const photoKey = `${photo.date_folder}/${photo.base}`;
  const accessibleName = friendlyBase(photo.base);
  elements.name.textContent = accessibleName;
  elements.camera.textContent = photo.camera_text || cameraSummary(photo.exif);
  elements.details.textContent = [
    photo.width && photo.height ? `${photo.width} x ${photo.height}` : "",
    new Date(photo.processed_at).toLocaleString(),
    `${state.current_index + 1} of ${state.count_today}`,
  ].filter(Boolean).join("  |  ");
  if (photoKey === currentPhotoKey) {
    if (currentLayer.dataset.photoKey === photoKey) syncPresentation();
    return;
  }

  clearPresentation();
  clearTransition();
  currentPhotoKey = photoKey;
  elements.stage.setAttribute("aria-busy", "true");
  const revision = ++loadRevision;
  void stagePhoto(photo, photoKey, accessibleName, revision);
}

async function stagePhoto(photo, photoKey, accessibleName, revision) {
  const controller = new AbortController();
  photoSessionController?.abort();
  photoSessionController = controller;
  try {
    const response = await fetch("/gallery/api/view-session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ date_folder: photo.date_folder, base: photo.base }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Photo session failed (${response.status}).`);
    const { view } = await response.json();
    if (photoSessionController === controller) photoSessionController = null;
    if (revision !== loadRevision || currentPhotoKey !== photoKey) return;
    await fillLayer(nextLayer, view, photoKey);
    if (revision !== loadRevision || currentPhotoKey !== photoKey) return;

    layoutLayer(nextLayer, "default");
    nextLayer.classList.add("reveal");
    transitionTimer = setTimeout(() => {
      if (revision !== loadRevision || currentPhotoKey !== photoKey) return;
      currentLayer.classList.remove("current");
      nextLayer.classList.remove("reveal");
      nextLayer.classList.add("current");
      const previousLayer = currentLayer;
      currentLayer = nextLayer;
      nextLayer = previousLayer;
      nextLayer.classList.remove("current", "reveal", "auto-scroll");
      nextLayer.replaceChildren();
      delete nextLayer.dataset.photoKey;
      transitionTimer = null;
      layoutLayer(currentLayer, "default");
      elements.stage.setAttribute("aria-label", `Photo: ${accessibleName}`);
      elements.stage.setAttribute("aria-busy", "false");
      presentationKey = "";
      syncPresentation();
      if (socket?.readyState === WebSocket.OPEN) setStatus("Connected", true);
    }, 440);
  } catch (error) {
    if (photoSessionController === controller) photoSessionController = null;
    if (error?.name === "AbortError") return;
    if (revision !== loadRevision || currentPhotoKey !== photoKey) return;
    currentPhotoKey = null;
    elements.stage.setAttribute("aria-busy", "false");
    nextLayer.classList.remove("reveal");
    cancelTileBatch(nextLayer);
    nextLayer.replaceChildren();
    setStatus("Image unavailable", false);
    setTimeout(() => {
      const current = latestState?.current_photo;
      if (current && `${current.date_folder}/${current.base}` === photoKey && currentPhotoKey === null) render(latestState);
    }, 1200);
  }
}

async function fillLayer(layer, view, photoKey) {
  const manifest = normalizeTileView(view);
  cancelTileBatch(layer);
  const frame = document.createElement("div");
  const surface = document.createElement("div");
  frame.className = "photo-frame";
  frame.setAttribute("aria-hidden", "true");
  surface.className = "tile-surface";
  surface.style.width = `${manifest.width}px`;
  surface.style.height = `${manifest.height}px`;
  surface.style.gridTemplateColumns = Array.from(
    { length: manifest.columns },
    (_, x) => `${Math.min(manifest.tileSize, manifest.width - x * manifest.tileSize)}px`,
  ).join(" ");
  surface.style.gridTemplateRows = Array.from(
    { length: manifest.rows },
    (_, y) => `${Math.min(manifest.tileSize, manifest.height - y * manifest.tileSize)}px`,
  ).join(" ");
  frame.append(surface);
  layer.replaceChildren(frame);
  Object.assign(layer.dataset, {
    photoKey,
    width: String(manifest.width),
    height: String(manifest.height),
  });
  await loadTileBatch(layer, manifest, surface);
}

function loadTileBatch(layer, manifest, surface) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let remaining = manifest.tiles.length;
    const images = [];
    const finish = (error) => {
      if (settled) return;
      settled = true;
      for (const image of images) {
        image.onload = null;
        image.onerror = null;
        if (error) image.removeAttribute("src");
      }
      if (tileBatches.get(layer) === batch) tileBatches.delete(layer);
      if (error) reject(error);
      else resolve();
    };
    const batch = {
      images,
      cancel() {
        const error = new Error("Photo tile load was cancelled.");
        error.name = "AbortError";
        finish(error);
      },
    };
    tileBatches.set(layer, batch);
    for (const tile of manifest.tiles) {
      const draw = tileDrawRect(tile, manifest);
      const cell = document.createElement("div");
      const image = new Image();
      cell.className = "photo-tile-cell";
      cell.style.gridColumn = String(tile.x + 1);
      cell.style.gridRow = String(tile.y + 1);
      cell.style.width = `${tile.width}px`;
      cell.style.height = `${tile.height}px`;
      image.className = "photo-tile";
      image.alt = "";
      image.draggable = false;
      image.decoding = "async";
      image.style.left = `${-draw.sourceX}px`;
      image.style.top = `${-draw.sourceY}px`;
      image.style.width = `${draw.encodedWidth}px`;
      image.style.height = `${draw.encodedHeight}px`;
      image.onload = () => {
        if (image.naturalWidth !== draw.encodedWidth || image.naturalHeight !== draw.encodedHeight) {
          finish(new Error("Photo tile dimensions do not match the manifest."));
          return;
        }
        image.onload = null;
        image.onerror = null;
        remaining -= 1;
        if (!remaining) finish();
      };
      image.onerror = () => finish(new Error("Photo tile could not be loaded."));
      images.push(image);
      cell.append(image);
      surface.append(cell);
    }
    for (let index = 0; index < images.length; index += 1) images[index].src = manifest.tiles[index].url;
  });
}

function cancelTileBatch(layer) {
  tileBatches.get(layer)?.cancel();
}

function normalizeTileView(view) {
  const width = positiveInteger(view?.width);
  const height = positiveInteger(view?.height);
  const tileSize = positiveInteger(view?.tile_size);
  const overlap = positiveInteger(view?.overlap);
  const columns = positiveInteger(view?.columns);
  const rows = positiveInteger(view?.rows);
  if (!width || !height || tileSize !== 512 || overlap !== 1 || columns !== Math.ceil(width / tileSize) || rows !== Math.ceil(height / tileSize) || !Array.isArray(view.tiles) || view.tiles.length !== columns * rows) {
    throw new Error("Photo session returned an invalid tile manifest.");
  }
  const coordinates = new Set();
  const tiles = view.tiles.map((tile) => {
    const x = Number(tile.x);
    const y = Number(tile.y);
    const tileWidth = positiveInteger(tile.width);
    const tileHeight = positiveInteger(tile.height);
    const url = new URL(tile.url, location.origin);
    const key = `${x}:${y}`;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= columns || y >= rows || tileWidth !== Math.min(tileSize, width - x * tileSize) || tileHeight !== Math.min(tileSize, height - y * tileSize) || coordinates.has(key) || url.origin !== location.origin || !url.pathname.startsWith("/gallery/tile/")) {
      throw new Error("Photo session returned an invalid tile manifest.");
    }
    coordinates.add(key);
    return { x, y, width: tileWidth, height: tileHeight, url: `${url.pathname}${url.search}` };
  });
  return { width, height, tileSize, overlap, columns, rows, tiles };
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function tileDrawRect(tile, manifest) {
  const left = tile.x > 0 ? manifest.overlap : 0;
  const top = tile.y > 0 ? manifest.overlap : 0;
  const right = tile.x + 1 < manifest.columns ? manifest.overlap : 0;
  const bottom = tile.y + 1 < manifest.rows ? manifest.overlap : 0;
  return {
    sourceX: left,
    sourceY: top,
    destinationX: tile.x * manifest.tileSize,
    destinationY: tile.y * manifest.tileSize,
    width: tile.width,
    height: tile.height,
    encodedWidth: tile.width + left + right,
    encodedHeight: tile.height + top + bottom,
  };
}

function layoutLayer(layer, mode) {
  const frame = layer.querySelector(".photo-frame");
  const surface = layer.querySelector(".tile-surface");
  const width = Number(layer.dataset.width);
  const height = Number(layer.dataset.height);
  if (!frame || !surface || !width || !height) return;

  const stageWidth = elements.stage.clientWidth || window.innerWidth;
  const stageHeight = elements.stage.clientHeight || window.innerHeight;
  const scale = mode === "auto-scroll" ? stageWidth / width : Math.min(stageWidth / width, stageHeight / height);
  const displayWidth = width * scale;
  const displayHeight = height * scale;
  frame.style.left = `${mode === "auto-scroll" ? 0 : (stageWidth - displayWidth) / 2}px`;
  frame.style.top = `${mode === "auto-scroll" ? 0 : (stageHeight - displayHeight) / 2}px`;
  frame.style.width = `${displayWidth}px`;
  frame.style.height = `${displayHeight}px`;
  surface.style.transform = `scale(${scale})`;
  layer.classList.toggle("auto-scroll", mode === "auto-scroll");
}

function syncPresentation() {
  const key = latestState?.presentation_mode === "auto-scroll"
    ? `${latestState.current_base}:${latestState.presentation_started_at}`
    : "";
  if (key === presentationKey || !currentLayer.dataset.photoKey) return;
  clearPresentation();
  presentationKey = key;
  if (!key) return;
  layoutLayer(currentLayer, "auto-scroll");
  const layer = currentLayer;
  const photoKey = layer.dataset.photoKey;
  presentationFrame = requestAnimationFrame(() => {
    presentationFrame = null;
    if (presentationKey !== key || currentLayer !== layer || layer.dataset.photoKey !== photoKey) return;
    const frame = layer.querySelector(".photo-frame");
    if (!frame) return;
    const distance = Math.max(0, frame.getBoundingClientRect().height - window.innerHeight);
    viewerAnimation = frame.animate([
      { transform: "translateY(0)", offset: 0 },
      { transform: "translateY(0)", offset: 1 / 7, easing: "ease-in" },
      { transform: `translateY(-${distance * 0.12}px)`, offset: 2 / 7, easing: "linear" },
      { transform: `translateY(-${distance * 0.88}px)`, offset: 5 / 7, easing: "ease-out" },
      { transform: `translateY(-${distance}px)`, offset: 6 / 7, easing: "linear" },
      { transform: `translateY(-${distance}px)`, offset: 1 },
    ], { duration: latestState.presentation_duration_ms, fill: "forwards" });
    viewerAnimation.currentTime = Math.min(
      elapsedSince(latestState.presentation_started_at),
      latestState.presentation_duration_ms,
    );
  });
}

function elapsedSince(timestamp) {
  if (!latestState?.server_time || !timestamp) return 0;
  const elapsedAtReceipt = new Date(latestState.server_time).getTime() - new Date(timestamp).getTime();
  return Math.max(0, elapsedAtReceipt + performance.now() - stateReceivedAt);
}

function clearPresentation() {
  if (presentationFrame !== null) cancelAnimationFrame(presentationFrame);
  presentationFrame = null;
  viewerAnimation?.cancel();
  viewerAnimation = null;
  presentationKey = "";
  layoutLayer(currentLayer, "default");
}

function clearTransition() {
  photoSessionController?.abort();
  photoSessionController = null;
  if (transitionTimer) clearTimeout(transitionTimer);
  transitionTimer = null;
  cancelTileBatch(nextLayer);
  nextLayer.classList.remove("reveal");
  nextLayer.replaceChildren();
}

function clearLayers() {
  clearTransition();
  for (const layer of [elements.current, elements.next]) {
    cancelTileBatch(layer);
    layer.replaceChildren();
    layer.classList.remove("current", "reveal", "auto-scroll");
    for (const key of Object.keys(layer.dataset)) delete layer.dataset[key];
  }
  currentLayer = elements.current;
  nextLayer = elements.next;
  currentLayer.classList.add("current");
  elements.stage.removeAttribute("aria-label");
  elements.stage.removeAttribute("aria-busy");
}

function cameraSummary(exif) {
  const pairs = Object.entries(exif || {}).slice(0, 5);
  return pairs.length ? pairs.map(([key, value]) => `${key}: ${String(value)}`).join("\n") : "Camera information unavailable";
}

function friendlyBase(base) {
  return base.replace(/_\d{4}-\d{2}-\d{2}_\d{2}_\d{2}_\d{2}(?:_\d+)?$/, "").replaceAll("_", " ");
}

function setStatus(text, connected) {
  elements.status.textContent = text;
  elements.status.classList.toggle("connected", connected);
}
