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
  thumbnailsClose: document.querySelector("#thumbnails-close"),
  backgroundToggle: document.querySelector("#background-toggle"),
  thumbnailSection: document.querySelector("#thumbnail-section"),
  thumbnails: document.querySelector("#thumbnails"),
  count: document.querySelector("#photo-count"),
  message: document.querySelector("#remote-message"),
  themeToggle: document.querySelector("#theme-toggle"),
  headerCollapse: document.querySelector("#header-collapse"),
  playbackState: document.querySelector("#playback-state"),
  remaining: document.querySelector("#playback-remaining"),
  followLatest: document.querySelector("#follow-latest"),
  newPhotos: document.querySelector("#new-photo-count"),
  viewerFeedback: document.querySelector("#viewer-feedback"),
  thumbnailsNewest: document.querySelector("#thumbnails-newest"),
  settings: document.querySelector("#viewer-settings"),
  settingsToggle: document.querySelector("#viewer-settings-toggle"),
  settingsClose: document.querySelector("#viewer-settings-close"),
  settingsMessage: document.querySelector("#settings-message"),
  overlayMode: document.querySelector("#overlay-mode"),
  overlayCorner: document.querySelector("#overlay-corner"),
  overlayAutoHide: document.querySelector("#overlay-auto-hide"),
  cleanOutput: document.querySelector("#clean-output"),
  keepAwake: document.querySelector("#keep-awake"),
  wakeLockStatus: document.querySelector("#wake-lock-status"),
};

let socket;
let state = null;
let thumbnailsVisible = false;
let thumbnailKey = "";
let previewAnimation = null;
let presentationKey = "";
let stateReceivedAt = 0;
let viewerStatus = null;
let wakeLock = null;
let wakeLockWanted = false;
let wakeLockRequest = null;
let wakeLockError = "";
const durationSteps = [1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30, 45, 60, 90, 120];

initializeTheme();
elements.themeToggle.addEventListener("click", toggleTheme);
elements.headerCollapse.addEventListener("click", (event) => {
  const collapsed = !document.body.classList.contains("header-collapsed");
  setHeaderCollapsed(collapsed);
  if (collapsed && event.detail > 0) elements.headerCollapse.blur();
});
window.addEventListener("storage", (event) => {
  if (event.key === "frame-theme-profile") {
    setThemeMode(readStoredTheme(), false);
    return;
  }
  if (event.key === "frame-theme" && (event.newValue === "day" || event.newValue === "night")) {
    setThemeMode(event.newValue, false);
  }
});
document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => send({ type: button.dataset.command }));
});
elements.play.addEventListener("click", () => send({ type: "PLAY_SLIDESHOW" }));
elements.pause.addEventListener("click", () => send({ type: "PAUSE_SLIDESHOW" }));
elements.stop.addEventListener("click", () => send({ type: "STOP_SLIDESHOW" }));
elements.autoScroll.addEventListener("click", () => send({ type: "AUTO_SCROLL_IMAGE" }));
elements.exif.addEventListener("click", () => send({ type: "SET_SHOW_EXIF", show_exif: !state?.show_exif }));
elements.thumbnailsToggle.addEventListener("click", () => {
  setThumbnailsVisible(!thumbnailsVisible);
});
elements.thumbnailsClose.addEventListener("click", () => setThumbnailsVisible(false));
elements.thumbnailSection.addEventListener("cancel", (event) => {
  event.preventDefault();
  setThumbnailsVisible(false);
});
elements.backgroundToggle.addEventListener("click", () => send({
  type: "SET_SHOW_BACKGROUND",
  show_background: !state?.show_background,
}));
elements.interval.addEventListener("input", () => {
  const duration = durationSteps[Number(elements.interval.value)] * 1000;
  elements.intervalValue.textContent = durationLabel(duration);
  elements.interval.setAttribute("aria-valuetext", durationLabel(duration));
});
elements.interval.addEventListener("change", () => send({
  type: "SET_INTERVAL_MS",
  interval_ms: durationSteps[Number(elements.interval.value)] * 1000,
}));
elements.image.addEventListener("load", syncPresentation);
elements.followLatest.addEventListener("click", () => send({ type: "FOLLOW_LATEST" }));
elements.thumbnailsNewest.addEventListener("click", () => {
  elements.thumbnails.scrollTop = 0;
});
elements.settingsToggle.addEventListener("click", () => {
  elements.settings.showModal();
  elements.settingsClose.focus();
});
elements.settingsClose.addEventListener("click", () => elements.settings.close());
elements.settings.addEventListener("close", () => elements.settingsToggle.focus());
for (const input of [elements.overlayMode, elements.overlayCorner, elements.overlayAutoHide]) {
  input.addEventListener("change", () => send({
    type: "SET_OVERLAY",
    mode: elements.overlayMode.value,
    corner: elements.overlayCorner.value,
    auto_hide: elements.overlayAutoHide.checked,
  }));
}
elements.cleanOutput.addEventListener("change", () => send({ type: "SET_CLEAN_OUTPUT", clean_output: elements.cleanOutput.checked }));
elements.keepAwake.addEventListener("change", () => {
  wakeLockWanted = elements.keepAwake.checked;
  wakeLockError = "";
  if (wakeLockWanted) void requestWakeLock();
  else void releaseWakeLock();
  renderWakeLock();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void requestWakeLock();
  else void releaseWakeLock();
});
window.addEventListener("pagehide", () => void releaseWakeLock());
renderWakeLock();

connect();
requestAnimationFrame(renderProgress);

function initializeTheme() {
  setThemeMode(readStoredTheme(), false);
}

function setHeaderCollapsed(collapsed) {
  document.body.classList.toggle("header-collapsed", collapsed);
  elements.headerCollapse.setAttribute("aria-expanded", String(!collapsed));
  const label = collapsed ? "Expand header" : "Collapse header";
  elements.headerCollapse.setAttribute("aria-label", label);
  elements.headerCollapse.title = label;
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
      elements.settingsMessage.textContent = message.error;
    } else if (message.type === "VIEWER_STATUS") {
      viewerStatus = message;
      renderViewerStatus();
    }
  });
  socket.addEventListener("close", () => {
    viewerStatus = null;
    setConnection("Reconnecting", "error");
    renderViewerStatus();
    setTimeout(connect, 1200);
  });
  socket.addEventListener("error", () => socket.close());
}

function send(command) {
  if (socket?.readyState !== WebSocket.OPEN) {
    elements.message.textContent = "Remote is reconnecting. Try again in a moment.";
    elements.settingsMessage.textContent = elements.message.textContent;
    return;
  }
  elements.settingsMessage.textContent = "";
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
  const scrollLabel = state.presentation_mode === "auto-scroll" ? "Scrolling image" : "Scroll image once";
  elements.autoScroll.setAttribute("aria-label", scrollLabel);
  elements.autoScroll.title = scrollLabel;
  elements.autoScroll.setAttribute("aria-pressed", String(state.presentation_mode === "auto-scroll"));
  elements.interval.value = String(nearestDurationIndex(state.interval_ms));
  elements.intervalValue.textContent = durationLabel(state.interval_ms);
  elements.interval.setAttribute("aria-valuetext", durationLabel(state.interval_ms));
  elements.exif.setAttribute("aria-pressed", String(state.show_exif));
  elements.backgroundToggle.setAttribute("aria-pressed", String(state.show_background));
  elements.playbackState.textContent = state.following_latest ? "Following latest" : state.playback_state === "playing" ? "Playing" : "Paused";
  elements.followLatest.hidden = Boolean(state.following_latest);
  const newCount = state.new_photos_count || 0;
  elements.newPhotos.hidden = !newCount;
  elements.newPhotos.textContent = `${newCount} new`;
  elements.newPhotos.setAttribute("aria-label", `${newCount} new photo${newCount === 1 ? "" : "s"}`);
  elements.overlayMode.value = state.overlay_mode || (state.show_exif ? "full" : "hidden");
  elements.overlayCorner.value = state.overlay_corner || "bottom-left";
  elements.overlayAutoHide.checked = Boolean(state.overlay_auto_hide);
  elements.cleanOutput.checked = Boolean(state.clean_output);
  renderViewerStatus();
  renderThumbnails();
  syncPresentation();
}

function renderThumbnails() {
  const recent = state.photos.slice(-60).reverse();
  elements.count.textContent = `Latest ${recent.length} of ${state.count_today} photos · Newest first`;
  const key = JSON.stringify([state.date_folder, recent.map((photo) => [photo.base, photo.thumbnail_url])]);
  if (key !== thumbnailKey) {
    const scrollTop = elements.thumbnails.scrollTop;
    const focusedBase = elements.thumbnails.contains(document.activeElement) ? document.activeElement.dataset.base : null;
    elements.thumbnails.replaceChildren(...recent.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "thumbnail-button";
      button.dataset.base = item.base;
      button.title = friendlyBase(item.base);
      button.setAttribute("aria-label", `Show ${friendlyBase(item.base)}`);
      const image = document.createElement("img");
      image.src = item.thumbnail_url;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      button.append(image);
      const badge = document.createElement("span");
      badge.className = "thumbnail-current";
      badge.textContent = "Current";
      badge.setAttribute("aria-hidden", "true");
      button.append(badge);
      button.addEventListener("click", () => {
        const index = state.photos.findIndex((photo) => photo.base === item.base);
        if (index < 0) return;
        send({ type: "GOTO_INDEX", index });
        setThumbnailsVisible(false);
      });
      return button;
    }));
    thumbnailKey = key;
    elements.thumbnails.scrollTop = scrollTop;
    if (focusedBase) {
      ([...elements.thumbnails.children].find((button) => button.dataset.base === focusedBase) || elements.thumbnailsClose).focus({ preventScroll: true });
    }
  }
  for (const button of elements.thumbnails.children) {
    const active = button.dataset.base === state.current_base;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function setThumbnailsVisible(visible) {
  thumbnailsVisible = visible;
  elements.thumbnailsToggle.setAttribute("aria-pressed", String(visible));
  if (visible) {
    if (!elements.thumbnailSection.open) elements.thumbnailSection.showModal();
    elements.thumbnails.scrollTop = 0;
    elements.thumbnailsClose.focus();
  } else {
    elements.thumbnailSection.close();
    elements.thumbnailsToggle.focus();
  }
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
  elements.remaining.hidden = !visible;
  const remaining = visible ? Math.max(0, Math.ceil((end - start - elapsedSince(state.interval_started_at)) / 1000)) : 0;
  const remainingText = `${remaining}s remaining`;
  if (elements.remaining.textContent !== remainingText) elements.remaining.textContent = remainingText;
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

function renderViewerStatus() {
  const key = state?.current_photo ? `${state.date_folder}/${state.current_base}` : null;
  let text = "Checking viewer…";
  let level = "waiting";
  if (socket?.readyState !== WebSocket.OPEN) {
    text = "Remote reconnecting · viewer status unavailable";
  } else if (viewerStatus?.photo_key === key) {
    const { viewers, displayed, failed } = viewerStatus;
    if (!viewers) text = "No viewer connected";
    else if (!key) text = "Viewer connected · waiting for a photo";
    else if (failed) {
      text = `Image unavailable on ${failed} of ${viewers} viewer${viewers === 1 ? "" : "s"}`;
      level = "error";
    } else if (displayed === viewers) {
      text = viewers === 1 ? "Photo displayed" : `Photo displayed on ${viewers} viewers`;
      level = "ready";
    } else text = `Loading photo${displayed ? ` · ${displayed}/${viewers} ready` : "…"}`;
  }
  elements.viewerFeedback.textContent = text;
  elements.viewerFeedback.dataset.level = level;
}

async function requestWakeLock() {
  if (!wakeLockWanted || document.visibilityState !== "visible" || wakeLock || wakeLockRequest || !window.isSecureContext || !navigator.wakeLock) return;
  wakeLockError = "";
  let releasedBeforeUse = false;
  try {
    wakeLockRequest = navigator.wakeLock.request("screen");
    renderWakeLock();
    const lock = await wakeLockRequest;
    if (!wakeLockWanted || document.visibilityState !== "visible") {
      releasedBeforeUse = true;
      await lock.release();
      return;
    }
    wakeLock = lock;
    lock.addEventListener("release", () => {
      if (wakeLock === lock) {
        wakeLock = null;
        renderWakeLock();
      }
    });
  } catch {
    wakeLockError = "Not active — your browser or battery settings prevented keeping the screen awake.";
  } finally {
    wakeLockRequest = null;
    renderWakeLock();
    if (releasedBeforeUse && wakeLockWanted && document.visibilityState === "visible") void requestWakeLock();
  }
}

async function releaseWakeLock() {
  const lock = wakeLock;
  wakeLock = null;
  if (lock && !lock.released) {
    try { await lock.release(); } catch {}
  }
  renderWakeLock();
}

function renderWakeLock() {
  const supported = window.isSecureContext && Boolean(navigator.wakeLock);
  elements.keepAwake.disabled = !supported;
  elements.keepAwake.checked = wakeLockWanted;
  elements.wakeLockStatus.textContent = !window.isSecureContext ? "Requires a secure HTTPS connection."
    : !supported ? "This browser does not support keeping the screen awake."
    : !wakeLockWanted ? "Screen may sleep"
    : document.visibilityState !== "visible" ? "Paused while this remote is in the background"
    : wakeLock && !wakeLock.released ? "Active — screen will stay awake"
    : wakeLockRequest ? "Requesting screen wake lock…"
    : wakeLockError || "Not active — toggle off and on to retry.";
}

function nearestDurationIndex(ms) {
  const seconds = ms / 1000;
  return durationSteps.reduce((best, value, index) => (
    Math.abs(value - seconds) < Math.abs(durationSteps[best] - seconds) ? index : best
  ), 0);
}

function friendlyBase(base) {
  return base.replace(/_\d{4}-\d{2}-\d{2}_\d{2}_\d{2}_\d{2}(?:_\d+)?$/, "").replaceAll("_", " ");
}
