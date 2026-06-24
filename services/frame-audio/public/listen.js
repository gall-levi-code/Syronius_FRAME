const streamId = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1));
const listenerId = createListenerId();
const player = document.querySelector("#player");
const playButton = document.querySelector("#play-button");
const playButtonLabel = document.querySelector("#play-button-label");
const muteButton = document.querySelector("#mute-button");
const volumeSlider = document.querySelector("#volume-slider");
const volumeValue = document.querySelector("#volume-value");
const playbackError = document.querySelector("#playback-error");
const bufferProfileSelect = document.querySelector("#buffer-profile");
const themeToggle = document.querySelector("#theme-toggle");
const timelineAvailable = document.querySelector("#timeline-available");
const timelineBuffer = document.querySelector("#timeline-buffer");
const timelinePlayhead = document.querySelector("#timeline-playhead");
const timelineTarget = document.querySelector("#timeline-target");
const bufferWindowLabel = document.querySelector("#buffer-window-label");
const safeTargetLabel = document.querySelector("#safe-target-label");
const BUFFER_KEY = "frame-audio-listener-buffer";
const TIMELINE_WINDOW_SECONDS = 20;
const DRIFT_SNAP_TOLERANCE_SECONDS = 4;
const AUTO_RESYNC_COOLDOWN_MS = 4_000;
const SEEK_EPSILON_SECONDS = 0.25;
const BUFFER_PROFILES = {
  low: {
    targetDelaySeconds: 3,
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 8,
    maxBufferLength: 12,
    maxMaxBufferLength: 20,
    backBufferLength: 6,
  },
  balanced: {
    targetDelaySeconds: 6,
    liveSyncDurationCount: 6,
    liveMaxLatencyDurationCount: 18,
    maxBufferLength: 30,
    maxMaxBufferLength: 45,
    backBufferLength: 12,
  },
  stable: {
    targetDelaySeconds: 12,
    liveSyncDurationCount: 12,
    liveMaxLatencyDurationCount: 30,
    maxBufferLength: 45,
    maxMaxBufferLength: 60,
    backBufferLength: 20,
  },
};

let hls;
let playlistUrl;
let nativeSourceAttached = false;
let wantsPlayback = false;
let userPaused = true;
let startPending = false;
let pendingLiveSnap = false;
let softwareVolume;
let volume = 1;
let muted = false;
let lastMetrics;
let resyncNoticeUntil = 0;
let lastAutoResyncAt = 0;

setThemeMode(localStorage.getItem("frame-theme") || "night");
bufferProfileSelect.value = BUFFER_PROFILES[localStorage.getItem(BUFFER_KEY)] ? localStorage.getItem(BUFFER_KEY) : "balanced";
volumeSlider.value = String(Math.round(volume * 100));
bufferWindowLabel.textContent = `${TIMELINE_WINDOW_SECONDS} s rolling`;
updateSafeTargetLabel();
applyVolume();
updatePlaybackButton();

themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "day" ? "night" : "day";
  setThemeMode(next);
  localStorage.setItem("frame-theme", next);
});
window.addEventListener("storage", (event) => {
  if (event.key === "frame-theme-profile") {
    setThemeMode(localStorage.getItem("frame-theme") || "night");
    return;
  }
  if (event.key === "frame-theme" && (event.newValue === "day" || event.newValue === "night")) {
    setThemeMode(event.newValue);
  }
});

bufferProfileSelect.addEventListener("change", () => {
  localStorage.setItem(BUFFER_KEY, bufferProfileSelect.value);
  updateSafeTargetLabel();
  pendingLiveSnap = wantsPlayback && !userPaused;
  if (playlistUrl) attach(playlistUrl);
  updateBufferReadout();
});

playButton.addEventListener("click", () => {
  if (wantsPlayback && !userPaused) {
    pausePlayback();
    return;
  }
  void resumePlayback();
});

muteButton.addEventListener("click", () => {
  muted = !muted;
  applyVolume();
});

volumeSlider.addEventListener("input", () => {
  volume = clamp(Number(volumeSlider.value) / 100, 0, 1);
  if (volume > 0) muted = false;
  applyVolume();
});

player.addEventListener("playing", () => {
  setPlaybackState("Playing");
  clearPlaybackError();
  updatePlaybackButton();
});
player.addEventListener("waiting", () => {
  if (wantsPlayback && !userPaused) setPlaybackState("Buffering");
});
player.addEventListener("stalled", () => {
  if (wantsPlayback && !userPaused) setPlaybackState("Network stalled");
});
player.addEventListener("pause", () => {
  if (userPaused) setPlaybackState("Paused");
  updatePlaybackButton();
});
player.addEventListener("loadedmetadata", () => {
  if (pendingLiveSnap && snapToLiveTail()) pendingLiveSnap = false;
});
player.addEventListener("canplay", () => {
  if (pendingLiveSnap && snapToLiveTail()) pendingLiveSnap = false;
});
player.addEventListener("error", () => {
  if (nativeSourceAttached && wantsPlayback && !userPaused) {
    setPlaybackState("Reconnecting");
    nativeSourceAttached = false;
    setTimeout(() => {
      if (wantsPlayback && !userPaused && playlistUrl) {
        attachNativeSource();
        void resumePlayback();
      }
    }, 1_000);
    return;
  }
  setPlaybackState("Playback error");
  showPlaybackError(player.error?.message || "The browser could not play this audio stream.");
});

async function update() {
  try {
    const [status] = await Promise.all([
      api(`/audio/public/streams/${encodeURIComponent(streamId)}/status`),
      api(`/audio/public/streams/${encodeURIComponent(streamId)}/listener-heartbeat`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ listenerId }),
      }),
    ]);
    const stream = status.stream;
    document.querySelector("#source-name").textContent = stream.name;
    document.querySelector("#relay-mode").textContent = modeLabel(stream.mode);
    document.querySelector("#bitrate").textContent = `${stream.activeBitrateKbps} kbps AAC`;
    document.querySelector("#listeners").textContent = `${stream.listenerCount} / ${stream.listenerLimit}`;
    document.querySelector("#source-state").textContent = stream.publisherActive ? "Live browser capture" : stream.alwaysOn ? "Capture offline; monitoring silence" : "Capture offline";
    document.querySelector("#status-pill").textContent = stream.playlistReady ? "Ready" : "Waiting";
    document.querySelector("#status-pill").className = `status-pill ${stream.publisherActive ? "good" : stream.playlistReady ? "warn" : "bad"}`;
    if (stream.playlistReady && playlistUrl !== stream.playlistUrl) attach(stream.playlistUrl);
    if (!stream.playlistReady && wantsPlayback && !userPaused) setPlaybackState("Waiting for relay");
  } catch (error) {
    document.querySelector("#status-pill").textContent = error.message;
    document.querySelector("#status-pill").className = "status-pill bad";
  }
}

function attach(url) {
  const shouldResume = wantsPlayback && !userPaused;
  playlistUrl = url;
  pendingLiveSnap = shouldResume;
  if (hls) {
    hls.destroy();
    hls = undefined;
  }
  nativeSourceAttached = false;
  player.playbackRate = 1;
  setPlaybackState(shouldResume ? "Joining live" : "Ready");

  if (window.Hls?.isSupported()) {
    hls = new Hls({
      ...hlsConfigForSelectedProfile(),
      autoStartLoad: shouldResume,
      maxLiveSyncPlaybackRate: 1,
      startFragPrefetch: true,
      maxBufferHole: 0.5,
    });
    hls.loadSource(url);
    hls.attachMedia(player);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setPlaybackState(shouldResume ? "Joining live" : "Ready");
      if (wantsPlayback && !userPaused) void resumePlayback();
      else hls.stopLoad();
    });
    hls.on(Hls.Events.LEVEL_LOADED, () => {
      if (pendingLiveSnap && snapToLiveTail()) pendingLiveSnap = false;
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      pendingLiveSnap = true;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        setPlaybackState("Reconnecting");
        hls.startLoad(-1);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        setPlaybackState("Recovering");
        hls.recoverMediaError();
      } else {
        showPlaybackError(`Audio stream error: ${data.details || data.type}`);
      }
    });
    return;
  }

  if (shouldResume) {
    attachNativeSource();
    void resumePlayback();
  }
}

async function resumePlayback() {
  wantsPlayback = true;
  userPaused = false;
  startPending = true;
  clearPlaybackError();
  setPlaybackState(playlistUrl ? "Joining live" : "Waiting for relay");
  updatePlaybackButton();

  try {
    if (!playlistUrl && !hls) return;
    await ensureVolumePipeline();
    if (hls) hls.startLoad(-1);
    else if (playlistUrl) attachNativeSource();
    pendingLiveSnap = true;
    snapToLiveTail();
    await player.play();
    snapToLiveTail();
  } catch (error) {
    wantsPlayback = false;
    userPaused = true;
    showPlaybackError(error instanceof Error ? error.message : "This browser could not start audio playback.");
  } finally {
    startPending = false;
    updatePlaybackButton();
  }
}

function pausePlayback() {
  wantsPlayback = false;
  userPaused = true;
  pendingLiveSnap = false;
  player.pause();
  stopLoading();
  setPlaybackState("Paused");
  updatePlaybackButton();
}

function stopLoading() {
  if (hls) {
    hls.stopLoad();
    return;
  }
  if (nativeSourceAttached) {
    player.removeAttribute("src");
    player.load();
    nativeSourceAttached = false;
  }
}

function attachNativeSource() {
  if (!playlistUrl) return;
  if (player.getAttribute("src") !== playlistUrl) {
    player.src = playlistUrl;
    player.load();
  }
  nativeSourceAttached = true;
}

async function ensureVolumePipeline() {
  if (softwareVolume?.gain) {
    if (softwareVolume.context.state === "suspended") await softwareVolume.context.resume();
    return;
  }
  if (softwareVolume?.disabled) return;
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    softwareVolume = { disabled: true };
    applyVolume();
    return;
  }
  try {
    const context = new AudioContextCtor();
    const source = context.createMediaElementSource(player);
    const gain = context.createGain();
    source.connect(gain);
    gain.connect(context.destination);
    softwareVolume = { context, gain };
    player.volume = 1;
    applyVolume();
    if (context.state === "suspended") await context.resume();
  } catch {
    softwareVolume = { disabled: true };
    applyVolume();
  }
}

function applyVolume() {
  const effectiveVolume = muted ? 0 : volume;
  if (softwareVolume?.gain) {
    const context = softwareVolume.context;
    softwareVolume.gain.gain.setTargetAtTime(effectiveVolume, context.currentTime, 0.01);
    player.muted = false;
    player.volume = 1;
  } else {
    player.muted = muted || effectiveVolume === 0;
    try {
      player.volume = volume;
    } catch {
      // Some mobile browsers expose hardware-only volume. Mute still works there.
    }
  }
  volumeSlider.value = String(Math.round(volume * 100));
  volumeValue.textContent = `${Math.round(volume * 100)}%`;
  const effectivelyMuted = muted || effectiveVolume === 0;
  muteButton.textContent = effectivelyMuted ? "Unmute" : "Mute";
  muteButton.setAttribute("aria-pressed", String(effectivelyMuted));
}

function updateBufferReadout() {
  const metrics = readLiveMetrics();
  if (metrics) {
    lastMetrics = metrics;
    document.querySelector("#buffered-seconds").textContent = `${metrics.bufferAhead.toFixed(1)} s`;
    document.querySelector("#live-latency").textContent = `${metrics.latency.toFixed(1)} s`;
  } else if (!lastMetrics) {
    document.querySelector("#buffered-seconds").textContent = "0.0 s";
    document.querySelector("#live-latency").textContent = "--";
  }
  document.querySelector("#safe-delay").textContent = `${targetDelaySeconds().toFixed(0)} s`;
  renderTimeline(metrics || lastMetrics);
  if (wantsPlayback && !userPaused) {
    if (pendingLiveSnap && snapToLiveTail()) pendingLiveSnap = false;
    correctDrift();
  }
}

function readLiveMetrics() {
  const liveEdge = liveEdgeTime();
  if (!Number.isFinite(liveEdge)) return undefined;
  const targetTime = liveTargetTime(liveEdge);
  const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : targetTime;
  const bufferedRange = lastRange(player.buffered);
  const seekableRange = lastRange(player.seekable);
  const bufferAhead = bufferedRange ? Math.max(0, bufferedRange.end - currentTime) : 0;
  return {
    liveEdge,
    targetTime,
    currentTime,
    bufferAhead,
    latency: Math.max(0, liveEdge - currentTime),
    bufferedRange,
    seekableRange,
  };
}

function renderTimeline(metrics) {
  const targetDelay = targetDelaySeconds();
  const targetPercent = secondsBehindToPercent(targetDelay);
  timelineTarget.style.left = `${targetPercent}%`;
  safeTargetLabel.textContent = `${targetDelay.toFixed(0)} s safe`;

  if (!metrics) {
    timelineAvailable.style.left = "0%";
    timelineAvailable.style.width = "0%";
    timelineBuffer.style.left = "0%";
    timelineBuffer.style.width = "0%";
    timelinePlayhead.style.left = `${targetPercent}%`;
    return;
  }

  const windowStart = metrics.liveEdge - TIMELINE_WINDOW_SECONDS;
  placeRange(timelineAvailable, metrics.seekableRange, windowStart);
  placeRange(timelineBuffer, metrics.bufferedRange, windowStart);
  timelinePlayhead.style.left = `${timeToPercent(metrics.currentTime, windowStart)}%`;
}

function placeRange(element, range, windowStart) {
  if (!range) {
    element.style.left = "0%";
    element.style.width = "0%";
    return;
  }
  const start = clamp(range.start, windowStart, windowStart + TIMELINE_WINDOW_SECONDS);
  const end = clamp(range.end, windowStart, windowStart + TIMELINE_WINDOW_SECONDS);
  const left = timeToPercent(start, windowStart);
  const right = timeToPercent(end, windowStart);
  element.style.left = `${left}%`;
  element.style.width = `${Math.max(0, right - left)}%`;
}

function correctDrift() {
  const liveEdge = liveEdgeTime();
  if (!Number.isFinite(liveEdge)) return;
  const target = safeTargetTime(liveEdge);
  if (!Number.isFinite(target)) return;
  const latency = liveEdge - player.currentTime;
  const maxSafeLatency = targetDelaySeconds() + DRIFT_SNAP_TOLERANCE_SECONDS;
  const now = Date.now();
  if (latency > maxSafeLatency && now - lastAutoResyncAt > AUTO_RESYNC_COOLDOWN_MS) {
    lastAutoResyncAt = now;
    player.currentTime = target;
    resyncNoticeUntil = Date.now() + 1_000;
    setPlaybackState("Re-synced");
  } else if (!player.paused && Date.now() > resyncNoticeUntil && document.querySelector("#playback-state").textContent === "Re-synced") {
    setPlaybackState("Playing");
  }
}

function snapToLiveTail() {
  const liveEdge = liveEdgeTime();
  if (!Number.isFinite(liveEdge)) return false;
  const target = safeTargetTime(liveEdge);
  if (!Number.isFinite(target)) return false;
  if (!Number.isFinite(player.currentTime) || Math.abs(player.currentTime - target) > SEEK_EPSILON_SECONDS) {
    player.currentTime = target;
  }
  lastAutoResyncAt = Date.now();
  return true;
}

function liveTargetTime(liveEdge = liveEdgeTime()) {
  const hlsTarget = Number(hls?.liveSyncPosition);
  if (Number.isFinite(hlsTarget)) return clampToSeekable(hlsTarget);
  return safeTargetTime(liveEdge);
}

function safeTargetTime(liveEdge = liveEdgeTime()) {
  return clampToSeekable(liveEdge - targetDelaySeconds());
}

function liveEdgeTime() {
  const seekableRange = lastRange(player.seekable);
  if (seekableRange) return seekableRange.end;
  const hlsLatency = Number(hls?.latency);
  if (Number.isFinite(hlsLatency) && Number.isFinite(player.currentTime)) return player.currentTime + hlsLatency;
  return undefined;
}

function clampToSeekable(time) {
  const seekableRange = lastRange(player.seekable);
  if (!seekableRange) return time;
  return clamp(time, seekableRange.start, seekableRange.end);
}

function lastRange(ranges) {
  if (!ranges.length) return undefined;
  const index = ranges.length - 1;
  return { start: ranges.start(index), end: ranges.end(index) };
}

function secondsBehindToPercent(seconds) {
  return clamp(((TIMELINE_WINDOW_SECONDS - seconds) / TIMELINE_WINDOW_SECONDS) * 100, 0, 100);
}

function timeToPercent(time, windowStart) {
  return clamp(((time - windowStart) / TIMELINE_WINDOW_SECONDS) * 100, 0, 100);
}

function hlsConfigForSelectedProfile() {
  const { targetDelaySeconds: _targetDelaySeconds, ...hlsConfig } = BUFFER_PROFILES[bufferProfileSelect.value];
  return hlsConfig;
}

function targetDelaySeconds() {
  return BUFFER_PROFILES[bufferProfileSelect.value].targetDelaySeconds;
}

function updateSafeTargetLabel() {
  const delay = targetDelaySeconds();
  safeTargetLabel.textContent = `${delay.toFixed(0)} s safe`;
  document.querySelector("#safe-delay").textContent = `${delay.toFixed(0)} s`;
}

function updatePlaybackButton() {
  playButton.disabled = false;
  if (startPending) {
    playButton.dataset.action = "joining";
    playButtonLabel.textContent = "Joining";
  } else if (wantsPlayback && !player.paused) {
    playButton.dataset.action = "pause";
    playButtonLabel.textContent = "Pause";
  } else if (wantsPlayback && !userPaused) {
    playButton.dataset.action = "pause";
    playButtonLabel.textContent = "Pause";
  } else if (playlistUrl || lastMetrics) {
    playButton.dataset.action = "resume";
    playButtonLabel.textContent = "Resume";
  } else {
    playButton.dataset.action = "play";
    playButtonLabel.textContent = "Play";
  }
}

function setThemeMode(nextMode) {
  const mode = nextMode === "day" ? "day" : "night";
  document.documentElement.dataset.theme = mode;
  window.FrameTheme?.apply(mode);
  const nextLabel = mode === "day" ? "Switch to night mode" : "Switch to day mode";
  themeToggle.setAttribute("aria-label", nextLabel);
  themeToggle.title = nextLabel;
  themeToggle.setAttribute("aria-pressed", String(mode === "day"));
}

function createListenerId() {
  const uuid = window.crypto?.randomUUID?.();
  if (uuid) return `listener_${uuid.replaceAll("-", "")}`;
  const bytes = new Uint8Array(16);
  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
    return `listener_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `listener_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function setPlaybackState(value) {
  document.querySelector("#playback-state").textContent = value;
}

function showPlaybackError(message) {
  playbackError.textContent = message;
  playbackError.classList.remove("hidden");
  updatePlaybackButton();
}

function clearPlaybackError() {
  playbackError.textContent = "";
  playbackError.classList.add("hidden");
}

function modeLabel(mode) { return mode === "publisher" ? "Live capture" : mode === "silence" ? "Always-on silence" : "Offline"; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
async function api(url, init) { const response = await fetch(url, init); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`); return body; }

update();
updateBufferReadout();
setInterval(update, 3_000);
setInterval(updateBufferReadout, 500);
