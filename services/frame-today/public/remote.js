const elements = {
  connection: document.querySelector("#remote-connection"),
  preview: document.querySelector("#remote-preview"),
  image: document.querySelector("#remote-image"),
  empty: document.querySelector("#remote-empty"),
  progress: document.querySelector("#playback-progress"),
  position: document.querySelector("#position"),
  name: document.querySelector("#current-name"),
  camera: document.querySelector("#remote-camera"),
  play: document.querySelector("#play"),
  pause: document.querySelector("#pause"),
  stop: document.querySelector("#stop"),
  autoScroll: document.querySelector("#auto-scroll"),
  interval: document.querySelector("#interval"),
  intervalValue: document.querySelector("#interval-value"),
  exif: document.querySelector("#exif-toggle"),
  thumbnailsToggle: document.querySelector("#thumbnails-toggle"),
  thumbnailSection: document.querySelector("#thumbnail-section"),
  thumbnails: document.querySelector("#thumbnails"),
  count: document.querySelector("#photo-count"),
  message: document.querySelector("#remote-message"),
};

let socket;
let state = null;
let thumbnailsVisible = false;
let previewAnimation = null;
let presentationKey = "";
let stateReceivedAt = 0;

document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => send({ type: button.dataset.command }));
});
elements.play.addEventListener("click", () => send({ type: "PLAY_SLIDESHOW" }));
elements.pause.addEventListener("click", () => send({ type: "PAUSE_SLIDESHOW" }));
elements.stop.addEventListener("click", () => send({ type: "STOP_SLIDESHOW" }));
elements.autoScroll.addEventListener("click", () => send({ type: "AUTO_SCROLL_IMAGE" }));
elements.exif.addEventListener("click", () => send({ type: "SET_SHOW_EXIF", show_exif: !state?.show_exif }));
elements.thumbnailsToggle.addEventListener("click", () => {
  thumbnailsVisible = !thumbnailsVisible;
  elements.thumbnailsToggle.setAttribute("aria-pressed", String(thumbnailsVisible));
  elements.thumbnailSection.hidden = !thumbnailsVisible;
});
elements.interval.addEventListener("input", () => {
  elements.intervalValue.textContent = durationLabel(Number(elements.interval.value) * 1000);
});
elements.interval.addEventListener("change", () => send({ type: "SET_INTERVAL_MS", interval_ms: Number(elements.interval.value) * 1000 }));
elements.image.addEventListener("load", syncPresentation);

connect();
requestAnimationFrame(renderProgress);

function connect() {
  setConnection("Connecting", "");
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/today/ws/control`);
  socket.addEventListener("open", () => setConnection("Connected", "connected"));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "STATE") {
      state = message;
      stateReceivedAt = performance.now();
      render();
      elements.message.textContent = "";
    } else if (message.type === "ERROR") {
      elements.message.textContent = message.error;
    }
  });
  socket.addEventListener("close", () => {
    setConnection("Reconnecting", "error");
    setTimeout(connect, 1200);
  });
  socket.addEventListener("error", () => socket.close());
}

function send(command) {
  if (socket?.readyState !== WebSocket.OPEN) {
    elements.message.textContent = "Remote is reconnecting. Try again in a moment.";
    return;
  }
  socket.send(JSON.stringify(command));
}

function render() {
  const photo = state.current_photo;
  elements.image.hidden = !photo;
  elements.empty.hidden = Boolean(photo);
  if (!photo) {
    elements.image.removeAttribute("src");
  } else if (elements.image.src !== new URL(photo.thumbnail_url, location.href).href) {
    elements.image.src = photo.thumbnail_url;
  }
  elements.name.textContent = photo ? friendlyBase(photo.base) : "No photo selected";
  elements.position.textContent = photo ? `${state.current_index + 1} of ${state.count_today}` : "0 of 0";
  elements.camera.textContent = photo?.camera_text || "";
  for (const [button, mode] of [[elements.play, "playing"], [elements.pause, "paused"], [elements.stop, "stopped"]]) {
    button.setAttribute("aria-pressed", String(state.playback_state === mode));
  }
  elements.autoScroll.disabled = !photo || state.playback_state === "playing" || state.presentation_mode === "auto-scroll";
  elements.autoScroll.textContent = state.presentation_mode === "auto-scroll" ? "Scrolling image..." : "Scroll image once";
  elements.interval.value = String(Math.round(state.interval_ms / 1000));
  elements.intervalValue.textContent = durationLabel(state.interval_ms);
  elements.exif.setAttribute("aria-pressed", String(state.show_exif));
  elements.count.textContent = `${state.count_today} photo${state.count_today === 1 ? "" : "s"}`;
  elements.thumbnails.replaceChildren(...state.photos.map((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thumbnail-button${index === state.current_index ? " active" : ""}`;
    button.title = friendlyBase(item.base);
    button.innerHTML = `<img src="${item.thumbnail_url}" alt="">`;
    button.addEventListener("click", () => send({ type: "GOTO_INDEX", index }));
    return button;
  }));
  syncPresentation();
}

function syncPresentation() {
  const key = state?.presentation_mode === "auto-scroll"
    ? `${state.current_base}:${state.presentation_started_at}`
    : "";
  if (key === presentationKey) return;
  presentationKey = key;
  previewAnimation?.cancel();
  previewAnimation = null;
  elements.image.classList.remove("auto-scroll");
  if (!key || !elements.image.complete) return;
  elements.image.classList.add("auto-scroll");
  requestAnimationFrame(() => {
    const distance = Math.max(0, elements.image.getBoundingClientRect().height - elements.preview.clientHeight);
    previewAnimation = elements.image.animate([
      { transform: "translateY(0)", offset: 0 },
      { transform: "translateY(0)", offset: 1 / 7, easing: "ease-in" },
      { transform: `translateY(-${distance * 0.12}px)`, offset: 2 / 7, easing: "linear" },
      { transform: `translateY(-${distance * 0.88}px)`, offset: 5 / 7, easing: "ease-out" },
      { transform: `translateY(-${distance}px)`, offset: 6 / 7, easing: "linear" },
      { transform: `translateY(-${distance}px)`, offset: 1 },
    ], { duration: state.presentation_duration_ms, fill: "forwards" });
    previewAnimation.currentTime = Math.min(
      elapsedSince(state.presentation_started_at),
      state.presentation_duration_ms,
    );
  });
}

function renderProgress() {
  const start = state?.interval_started_at ? new Date(state.interval_started_at).getTime() : 0;
  const end = state?.next_change_at ? new Date(state.next_change_at).getTime() : 0;
  const visible = state?.playback_state === "playing" && end > start;
  elements.progress.hidden = !visible;
  const progress = visible ? Math.max(0, Math.min(1, elapsedSince(state.interval_started_at) / (end - start))) : 0;
  elements.progress.style.transform = `scaleX(${progress})`;
  requestAnimationFrame(renderProgress);
}

function elapsedSince(timestamp) {
  if (!state?.server_time || !timestamp) return 0;
  const elapsedAtReceipt = new Date(state.server_time).getTime() - new Date(timestamp).getTime();
  return Math.max(0, elapsedAtReceipt + performance.now() - stateReceivedAt);
}

function setConnection(text, className) {
  elements.connection.className = `connection-led ${className}`;
  elements.connection.setAttribute("aria-label", text);
  elements.connection.title = text;
}

function durationLabel(ms) {
  const seconds = Math.round(ms / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function friendlyBase(base) {
  return base.replace(/_\d{4}-\d{2}-\d{2}_\d{2}_\d{2}_\d{2}(?:_\d+)?$/, "").replaceAll("_", " ");
}
