const streamId = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1));
const listenerId = createListenerId();
const player = document.querySelector("#player");
const listenButton = document.querySelector("#listen-button");
const playbackError = document.querySelector("#playback-error");
const bufferProfileSelect = document.querySelector("#buffer-profile");
const BUFFER_KEY = "frame-audio-listener-buffer";
const BUFFER_PROFILES = {
  low: {
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 8,
    maxBufferLength: 12,
    maxMaxBufferLength: 20,
    backBufferLength: 6,
  },
  balanced: {
    liveSyncDurationCount: 6,
    liveMaxLatencyDurationCount: 18,
    maxBufferLength: 30,
    maxMaxBufferLength: 45,
    backBufferLength: 12,
  },
  stable: {
    liveSyncDurationCount: 12,
    liveMaxLatencyDurationCount: 30,
    maxBufferLength: 45,
    maxMaxBufferLength: 60,
    backBufferLength: 20,
  },
};
let hls;
let playlistUrl;

document.documentElement.dataset.theme = localStorage.getItem("frame-theme") || "night";
bufferProfileSelect.value = BUFFER_PROFILES[localStorage.getItem(BUFFER_KEY)] ? localStorage.getItem(BUFFER_KEY) : "balanced";
document.querySelector("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "day" ? "night" : "day";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("frame-theme", next);
});
bufferProfileSelect.addEventListener("change", () => {
  localStorage.setItem(BUFFER_KEY, bufferProfileSelect.value);
  if (playlistUrl) attach(playlistUrl);
});
listenButton.addEventListener("click", async () => {
  try {
    player.playbackRate = 1;
    await player.play();
    clearPlaybackError();
    listenButton.classList.add("hidden");
  } catch (error) {
    showPlaybackError(error instanceof Error ? error.message : "This browser could not start audio playback.");
  }
});
player.addEventListener("playing", () => {
  setPlaybackState("Playing");
  clearPlaybackError();
  listenButton.classList.add("hidden");
});
player.addEventListener("waiting", () => setPlaybackState("Buffering"));
player.addEventListener("stalled", () => setPlaybackState("Network stalled"));
player.addEventListener("pause", () => setPlaybackState("Paused"));
player.addEventListener("error", () => {
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
  } catch (error) {
    document.querySelector("#status-pill").textContent = error.message;
    document.querySelector("#status-pill").className = "status-pill bad";
  }
}

function attach(url) {
  playlistUrl = url;
  const wasPlaying = !player.paused;
  if (hls) hls.destroy();
  player.playbackRate = 1;
  setPlaybackState("Connecting");
  if (window.Hls?.isSupported()) {
    hls = new Hls({
      ...BUFFER_PROFILES[bufferProfileSelect.value],
      maxLiveSyncPlaybackRate: 1,
      startFragPrefetch: true,
      maxBufferHole: 0.5,
    });
    hls.loadSource(url);
    hls.attachMedia(player);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setPlaybackState("Ready");
      if (wasPlaying) player.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        setPlaybackState("Reconnecting");
        hls.startLoad();
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        setPlaybackState("Recovering");
        hls.recoverMediaError();
      } else {
        showPlaybackError(`Audio stream error: ${data.details || data.type}`);
      }
    });
  } else {
    player.src = url;
    player.load();
    if (wasPlaying) player.play().catch(() => {});
  }
}

function updateBufferReadout() {
  const currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;
  let buffered = 0;
  if (player.buffered.length) buffered = Math.max(0, player.buffered.end(player.buffered.length - 1) - currentTime);
  let latency;
  if (player.seekable.length) latency = Math.max(0, player.seekable.end(player.seekable.length - 1) - currentTime);
  document.querySelector("#buffered-seconds").textContent = `${buffered.toFixed(1)} s`;
  document.querySelector("#live-latency").textContent = Number.isFinite(latency) ? `${latency.toFixed(1)} s` : "--";
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
  listenButton.textContent = "Tap to retry";
  listenButton.classList.remove("hidden");
}

function clearPlaybackError() {
  playbackError.textContent = "";
  playbackError.classList.add("hidden");
}

function modeLabel(mode) { return mode === "publisher" ? "Live capture" : mode === "silence" ? "Always-on silence" : "Offline"; }
async function api(url, init) { const response = await fetch(url, init); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`); return body; }

update();
updateBufferReadout();
setInterval(update, 3_000);
setInterval(updateBufferReadout, 500);
