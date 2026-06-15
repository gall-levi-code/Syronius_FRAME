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
let currentBase = null;
let latestState = null;
let viewerAnimation = null;
let presentationKey = "";
let stateReceivedAt = 0;
elements.current.addEventListener("load", () => {
  presentationKey = "";
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
    currentBase = null;
    clearPresentation();
    return;
  }
  elements.name.textContent = friendlyBase(photo.base);
  elements.camera.textContent = photo.camera_text || cameraSummary(photo.exif);
  elements.details.textContent = [
    photo.width && photo.height ? `${photo.width} x ${photo.height}` : "",
    new Date(photo.processed_at).toLocaleString(),
    `${state.current_index + 1} of ${state.count_today}`,
  ].filter(Boolean).join("  |  ");
  if (photo.base === currentBase) {
    syncPresentation();
    return;
  }
  clearPresentation();
  currentBase = photo.base;
  elements.next.src = photo.image_url;
  elements.next.onload = () => {
    elements.next.classList.add("reveal");
    setTimeout(() => {
      elements.current.src = photo.image_url;
      elements.next.classList.remove("reveal");
      presentationKey = "";
      syncPresentation();
    }, 440);
  };
}

function syncPresentation() {
  const key = latestState?.presentation_mode === "auto-scroll"
    ? `${latestState.current_base}:${latestState.presentation_started_at}`
    : "";
  if (key === presentationKey) return;
  clearPresentation();
  presentationKey = key;
  if (!key || !elements.current.complete || !elements.current.naturalWidth) return;
  elements.current.classList.add("auto-scroll");
  requestAnimationFrame(() => {
    const distance = Math.max(0, elements.current.getBoundingClientRect().height - window.innerHeight);
    viewerAnimation = elements.current.animate([
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
  viewerAnimation?.cancel();
  viewerAnimation = null;
  presentationKey = "";
  elements.current.classList.remove("auto-scroll");
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
