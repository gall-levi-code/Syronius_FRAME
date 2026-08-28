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
  try {
    await fillLayer(nextLayer, photo, photoKey);
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
    if (revision !== loadRevision || currentPhotoKey !== photoKey) return;
    currentPhotoKey = null;
    elements.stage.setAttribute("aria-busy", "false");
    nextLayer.classList.remove("reveal");
    nextLayer.replaceChildren();
    setStatus("Image unavailable", false);
    setTimeout(() => {
      const current = latestState?.current_photo;
      if (current && `${current.date_folder}/${current.base}` === photoKey && currentPhotoKey === null) render(latestState);
    }, 1200);
  }
}

async function fillLayer(layer, photo, photoKey) {
  const frame = document.createElement("div");
  const image = new Image();
  frame.className = "photo-frame";
  frame.setAttribute("aria-hidden", "true");
  image.className = "photo-image";
  image.alt = "";
  image.draggable = false;
  image.decoding = "async";
  frame.append(image);
  layer.replaceChildren(frame);
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error("Photo could not be loaded."));
    image.src = `/today/image/${photo.date_folder}/${photo.base}.jpg`;
  });
  image.onload = null;
  image.onerror = null;
  Object.assign(layer.dataset, {
    photoKey,
    width: String(image.naturalWidth),
    height: String(image.naturalHeight),
  });
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
