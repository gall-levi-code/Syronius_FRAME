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
let transitionTimer = null;
let presentationKey = "";
let stateReceivedAt = 0;
let loadRevision = 0;
let displayedPhoto = null;
let displayedAt = 0;
let activeLoad = null;
let preload = null;
let overlayTimer = null;
let viewerReport = { type: "VIEWER_REPORT", photo_key: null, status: "empty" };

window.addEventListener("resize", () => {
  clearPresentation();
  layoutLayer(nextLayer, "default");
  syncPresentation();
});
connect();

function connect() {
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/today/ws/viewer`);
  socket.addEventListener("open", () => {
    setStatus(viewerReport.status === "error" ? "Image unavailable" : "Connected", viewerReport.status !== "error");
    reportViewer(viewerReport.photo_key, viewerReport.status, true);
  });
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
  elements.empty.hidden = Boolean(photo) || Boolean(state.clean_output);
  elements.stage.hidden = !photo;
  elements.status.hidden = Boolean(state.clean_output);
  if (!photo) {
    loadRevision += 1;
    currentPhotoKey = null;
    displayedPhoto = null;
    activeLoad?.cancel();
    activeLoad = null;
    preload?.cancel();
    preload = null;
    clearPresentation();
    clearLayers();
    syncOverlay();
    reportViewer(null, "empty");
    return;
  }

  const photoKey = `${photo.date_folder}/${photo.base}`;
  syncOverlay();
  if (photoKey === currentPhotoKey) {
    if (currentLayer.dataset.photoKey === photoKey) {
      syncPresentation();
      preloadNext();
    }
    return;
  }

  clearPresentation();
  clearTransition();
  syncOverlay();
  activeLoad?.cancel();
  activeLoad = null;
  currentPhotoKey = photoKey;
  const revision = ++loadRevision;
  if (currentLayer.dataset.photoKey === photoKey) {
    elements.stage.setAttribute("aria-busy", "false");
    syncPresentation();
    reportViewer(photoKey, "displayed");
    if (socket?.readyState === WebSocket.OPEN) setStatus("Connected", true);
    preloadNext();
    return;
  }
  elements.stage.setAttribute("aria-busy", "true");
  setStatus("Loading photo", true);
  reportViewer(photoKey, "loading");
  activeLoad = preload?.key === photoKey ? preload : loadPhoto(photo);
  if (preload !== activeLoad) preload?.cancel();
  preload = null;
  void stagePhoto(photo, photoKey, revision, activeLoad);
}

async function stagePhoto(photo, photoKey, revision, loading) {
  try {
    const image = await loading.promise;
    if (revision !== loadRevision || currentPhotoKey !== photoKey) return;
    activeLoad = null;
    const frame = document.createElement("div");
    frame.className = "photo-frame";
    frame.setAttribute("aria-hidden", "true");
    frame.append(image);
    nextLayer.replaceChildren(frame);
    Object.assign(nextLayer.dataset, {
      photoKey, width: String(image.naturalWidth), height: String(image.naturalHeight),
    });
    layoutLayer(nextLayer, "default");
    currentLayer.classList.remove("current");
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
      elements.stage.setAttribute("aria-label", `Photo: ${friendlyBase(photo.base)}`);
      elements.stage.setAttribute("aria-busy", "false");
      displayedPhoto = photo;
      displayedAt = performance.now();
      elements.name.textContent = friendlyBase(photo.base);
      elements.details.textContent = [
        photo.width && photo.height ? `${photo.width} x ${photo.height}` : "",
        new Date(photo.processed_at).toLocaleString(),
        `${latestState.current_index + 1} of ${latestState.count_today}`,
      ].filter(Boolean).join("  |  ");
      syncOverlay();
      presentationKey = "";
      syncPresentation();
      reportViewer(photoKey, "displayed");
      preloadNext();
      if (socket?.readyState === WebSocket.OPEN) setStatus("Connected", true);
    }, 440);
    syncOverlay();
  } catch (error) {
    if (revision !== loadRevision || currentPhotoKey !== photoKey) return;
    activeLoad = null;
    currentPhotoKey = null;
    elements.stage.setAttribute("aria-busy", "false");
    nextLayer.classList.remove("reveal");
    nextLayer.replaceChildren();
    syncOverlay();
    setStatus("Image unavailable", false);
    reportViewer(photoKey, "error");
    setTimeout(() => {
      const current = latestState?.current_photo;
      if (current && `${current.date_folder}/${current.base}` === photoKey && currentPhotoKey === null) render(latestState);
    }, 1200);
  }
}

function loadPhoto(photo) {
  const image = new Image();
  image.className = "photo-image";
  image.alt = "";
  image.draggable = false;
  image.decoding = "async";
  let cancel;
  const promise = new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("Photo could not be loaded."));
    cancel = () => {
      image.onload = null;
      image.onerror = null;
      image.removeAttribute("src");
      reject(new Error("Photo load was replaced."));
    };
    image.src = `/today/image/${photo.date_folder}/${photo.base}.jpg`;
  }).then(async () => {
    image.onload = null;
    image.onerror = null;
    if (image.decode) await image.decode();
    return image;
  });
  // A speculative preload can fail before it is selected; selecting it uses the normal retry path.
  void promise.catch(() => {});
  return { key: `${photo.date_folder}/${photo.base}`, promise, cancel };
}

function preloadNext() {
  const photos = latestState.photos;
  const next = latestState.slideshow_running && photos.length > 1
    ? photos[(latestState.current_index + 1) % photos.length]
    : null;
  const key = next ? `${latestState.date_folder}/${next.base}` : null;
  if (preload?.key === key) return;
  preload?.cancel();
  preload = next ? loadPhoto({ ...next, date_folder: latestState.date_folder }) : null;
}

function syncOverlay() {
  if (overlayTimer !== null) clearTimeout(overlayTimer);
  overlayTimer = null;
  const mode = latestState.overlay_mode || "full";
  elements.exif.dataset.mode = mode;
  elements.exif.dataset.corner = latestState.overlay_corner || "bottom-left";
  elements.exif.hidden = !displayedPhoto || transitionTimer !== null || !latestState.show_exif || mode === "hidden" || latestState.presentation_mode === "auto-scroll";
  const text = displayedPhoto?.camera_text || cameraSummary(displayedPhoto?.exif);
  elements.camera.textContent = mode === "compact" ? text.trim().split(/\r?\n/).filter(Boolean).at(-1) || "" : text;
  const remaining = 5000 - (performance.now() - displayedAt);
  elements.exif.classList.toggle("faded", Boolean(latestState.overlay_auto_hide) && remaining <= 0);
  if (!elements.exif.hidden && latestState.overlay_auto_hide && remaining > 0) {
    overlayTimer = setTimeout(() => {
      overlayTimer = null;
      elements.exif.classList.add("faded");
    }, remaining);
  }
}

function reportViewer(photoKey, status, force = false) {
  if (!force && viewerReport.photo_key === photoKey && viewerReport.status === status) return;
  viewerReport = { type: "VIEWER_REPORT", photo_key: photoKey, status };
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(viewerReport));
}

function layoutLayer(layer, mode) {
  const frame = layer.querySelector(".photo-frame");
  const image = layer.querySelector(".photo-image");
  const width = Number(layer.dataset.width);
  const height = Number(layer.dataset.height);
  if (!frame || !image || !width || !height) return;

  const stageWidth = elements.stage.clientWidth || window.innerWidth;
  const stageHeight = elements.stage.clientHeight || window.innerHeight;
  const scale = mode === "auto-scroll" ? stageWidth / width : Math.min(stageWidth / width, stageHeight / height);
  const displayWidth = width * scale;
  const displayHeight = height * scale;
  frame.style.left = `${mode === "auto-scroll" ? 0 : (stageWidth - displayWidth) / 2}px`;
  frame.style.top = `${mode === "auto-scroll" ? 0 : (stageHeight - displayHeight) / 2}px`;
  frame.style.width = `${displayWidth}px`;
  frame.style.height = `${displayHeight}px`;
  image.style.transform = `scale(${scale})`;
  layer.classList.toggle("auto-scroll", mode === "auto-scroll");
}

function syncPresentation() {
  if (currentLayer.dataset.photoKey !== currentPhotoKey) return;
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
  if (transitionTimer) clearTimeout(transitionTimer);
  transitionTimer = null;
  currentLayer.classList.add("current");
  nextLayer.classList.remove("reveal");
  nextLayer.replaceChildren();
}

function clearLayers() {
  clearTransition();
  for (const layer of [elements.current, elements.next]) {
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
