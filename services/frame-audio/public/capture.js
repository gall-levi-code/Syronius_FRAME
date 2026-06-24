const streamId = decodeURIComponent(location.pathname.split("/").filter(Boolean).at(-1));
const SETTINGS_PREFIX = `frame-audio-capture:${streamId}:`;
const PROFILES = {
  voice: {
    bitrate: 96000,
    channels: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGain: true,
    description: "Speech-focused mono capture with browser echo cancellation, noise suppression, and automatic gain.",
  },
  music: {
    bitrate: 256000,
    channels: 2,
    echoCancellation: false,
    noiseSuppression: false,
    autoGain: false,
    description: "Full-range stereo with browser voice processing disabled. Recommended for stream mixes and virtual audio cables.",
  },
  maximum: {
    bitrate: 510000,
    channels: 2,
    echoCancellation: false,
    noiseSuppression: false,
    autoGain: false,
    description: "Requests the maximum Opus bitrate from the browser. Best quality, highest LAN upload use, and browsers may cap the request.",
  },
};

let mediaStream;
let mediaRecorder;
let socket;
let audioContext;
let analyser;
let meterFrame;
let settingsKey;
const elementIds = [
  "source-name", "source-id", "publish-status", "notice", "device-select", "profile-select",
  "capture-bitrate-select", "channel-select", "echo-cancellation-input", "noise-suppression-input",
  "auto-gain-input", "profile-description", "live-button", "refresh-devices-button", "meter-fill",
  "level-readout", "capture-state", "socket-state", "relay-state", "target-bitrate", "input-bitrate",
  "capture-format", "browser-processing", "upload-bitrate", "listener-count",
];
const elements = Object.fromEntries(elementIds.map((id) => [id.replaceAll("-", ""), document.getElementById(id)]));
const qualityControls = [
  elements.profileselect,
  elements.capturebitrateselect,
  elements.channelselect,
  elements.echocancellationinput,
  elements.noisesuppressioninput,
  elements.autogaininput,
];
const themeToggle = document.querySelector("#theme-toggle");

setThemeMode(readStoredTheme(), false);
themeToggle.addEventListener("click", toggleTheme);
window.addEventListener("storage", (event) => {
  if (event.key === "frame-theme-profile") {
    setThemeMode(readStoredTheme(), false);
    return;
  }
  if (event.key === "frame-theme" && (event.newValue === "day" || event.newValue === "night")) {
    setThemeMode(event.newValue, false);
  }
});
elements.livebutton.addEventListener("click", () => mediaRecorder?.state === "recording" ? stopCapture() : startCapture());
elements.refreshdevicesbutton.addEventListener("click", () => loadDevices(true));
document.querySelector("#popout-button").addEventListener("click", () => window.open(location.href, "frame-audio-capture", "popup,width=620,height=820"));
elements.profileselect.addEventListener("change", () => {
  if (elements.profileselect.value !== "custom") applyProfile(elements.profileselect.value);
  saveSettings();
});
for (const control of qualityControls.slice(1)) {
  control.addEventListener("change", () => {
    elements.profileselect.value = "custom";
    updateProfileDescription();
    saveSettings();
    updateConfiguredQuality();
  });
}
window.addEventListener("beforeunload", stopCapture);

async function loadDevices(requestAccess = false) {
  try {
    const selectedDevice = elements.deviceselect.value;
    if (requestAccess) {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((track) => track.stop());
    }
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    elements.deviceselect.innerHTML = devices.map((device, index) => `<option value="${escapeAttr(device.deviceId)}">${escapeHtml(device.label || `Audio input ${index + 1}`)}</option>`).join("");
    if (!devices.length) elements.deviceselect.innerHTML = '<option value="">Default audio input</option>';
    if (selectedDevice && devices.some((device) => device.deviceId === selectedDevice)) elements.deviceselect.value = selectedDevice;
    if (requestAccess) showNotice("Audio devices refreshed.", "ok");
  } catch (error) {
    showNotice(`Audio device access failed: ${error.message}`);
  }
}

async function startCapture() {
  try {
    const deviceId = elements.deviceselect.value;
    const constraints = {
      channelCount: { ideal: Number(elements.channelselect.value) },
      sampleRate: { ideal: 48000 },
      sampleSize: { ideal: 16 },
      echoCancellation: elements.echocancellationinput.checked,
      noiseSuppression: elements.noisesuppressioninput.checked,
      autoGainControl: elements.autogaininput.checked,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    startMeter(mediaStream);
    updateActualCaptureFormat(mediaStream.getAudioTracks()[0]);
    setCaptureControlsDisabled(true);

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/audio/ws/capture/${encodeURIComponent(streamId)}`);
    socket.binaryType = "arraybuffer";
    elements.socketstate.textContent = "Connecting";
    socket.addEventListener("open", () => {
      const mimeType = ["audio/webm;codecs=opus", "audio/webm"].find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const requestedBitrate = Number(elements.capturebitrateselect.value);
      const options = { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: requestedBitrate };
      try {
        mediaRecorder = new MediaRecorder(mediaStream, options);
      } catch {
        mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
        showNotice("This browser ignored the requested Opus bitrate and selected its own encoder settings.");
      }
      elements.uploadbitrate.textContent = `${Math.round((mediaRecorder.audioBitsPerSecond || requestedBitrate) / 1000)} kbps Opus`;
      mediaRecorder.addEventListener("dataavailable", async (event) => {
        if (event.data.size && socket?.readyState === WebSocket.OPEN) socket.send(await event.data.arrayBuffer());
      });
      mediaRecorder.start(250);
      elements.capturestate.textContent = "Recording";
      elements.socketstate.textContent = "Connected";
      elements.livebutton.textContent = "Stop capture";
      elements.publishstatus.textContent = "Publishing";
      elements.publishstatus.className = "status-pill good";
    });
    socket.addEventListener("close", (event) => {
      if (mediaRecorder?.state === "recording") stopCapture();
      elements.socketstate.textContent = event.reason || "Disconnected";
    });
    socket.addEventListener("error", () => showNotice("The publisher connection failed."));
  } catch (error) {
    stopCapture();
    showNotice(`Unable to start capture: ${error.message}`);
  }
}

function stopCapture() {
  if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  mediaRecorder = undefined;
  if (socket?.readyState === WebSocket.OPEN) socket.close(1000, "Capture stopped");
  socket = undefined;
  mediaStream?.getTracks().forEach((track) => track.stop());
  mediaStream = undefined;
  if (meterFrame) cancelAnimationFrame(meterFrame);
  audioContext?.close();
  audioContext = undefined;
  setCaptureControlsDisabled(false);
  elements.meterfill.style.width = "0%";
  elements.levelreadout.textContent = "-60 dB";
  elements.capturestate.textContent = "Stopped";
  elements.socketstate.textContent = "Disconnected";
  elements.livebutton.textContent = "Go live";
  elements.publishstatus.textContent = "Offline";
  elements.publishstatus.className = "status-pill";
  updateConfiguredQuality();
}

function startMeter(stream) {
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  const draw = () => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) { const value = (sample - 128) / 128; sum += value * value; }
    const rms = Math.sqrt(sum / samples.length);
    const db = Math.max(-60, 20 * Math.log10(Math.max(rms, 0.001)));
    elements.meterfill.style.width = `${Math.min(100, Math.max(0, ((db + 60) / 60) * 100))}%`;
    elements.levelreadout.textContent = `${Math.round(db)} dB`;
    meterFrame = requestAnimationFrame(draw);
  };
  draw();
}

async function loadStatus() {
  try {
    const result = await api(`/audio/api/streams/${encodeURIComponent(streamId)}/status`);
    const stream = result.stream;
    initializeSettings(stream.instanceId);
    elements.sourcename.textContent = stream.name;
    elements.sourceid.textContent = stream.streamId;
    elements.relaystate.textContent = stream.mode === "publisher" ? "Live capture" : stream.mode === "silence" ? "Always-on silence" : "Offline";
    elements.targetbitrate.textContent = stream.activeBitrateKbps === stream.bitrateKbps
      ? `${stream.bitrateKbps} kbps AAC`
      : `${stream.activeBitrateKbps} active / ${stream.bitrateKbps} next`;
    elements.inputbitrate.textContent = stream.publisherActive ? `${stream.inputKbps} kbps` : "--";
    elements.listenercount.textContent = `${stream.listenerCount} / ${stream.listenerLimit}`;
  } catch (error) {
    showNotice(error.message);
  }
}

function applyProfile(profileName) {
  const profile = PROFILES[profileName];
  if (!profile) return;
  elements.capturebitrateselect.value = String(profile.bitrate);
  elements.channelselect.value = String(profile.channels);
  elements.echocancellationinput.checked = profile.echoCancellation;
  elements.noisesuppressioninput.checked = profile.noiseSuppression;
  elements.autogaininput.checked = profile.autoGain;
  updateProfileDescription();
  updateConfiguredQuality();
}

function updateProfileDescription() {
  const profile = PROFILES[elements.profileselect.value];
  elements.profiledescription.textContent = profile?.description || "Custom browser capture settings. Voice processing can noticeably alter music and complete stream mixes.";
}

function updateConfiguredQuality() {
  const channels = Number(elements.channelselect.value) === 1 ? "Mono" : "Stereo";
  elements.captureformat.textContent = `${channels} / 48 kHz requested`;
  elements.browserprocessing.textContent = configuredProcessingLabel();
  elements.uploadbitrate.textContent = `${Math.round(Number(elements.capturebitrateselect.value) / 1000)} kbps Opus requested`;
}

function updateActualCaptureFormat(track) {
  const settings = track?.getSettings?.() || {};
  const channels = settings.channelCount === 1 ? "Mono" : settings.channelCount === 2 ? "Stereo" : `${settings.channelCount || Number(elements.channelselect.value)} channels`;
  const sampleRate = settings.sampleRate ? `${Math.round(settings.sampleRate / 100) / 10} kHz` : "48 kHz requested";
  elements.captureformat.textContent = `${channels} / ${sampleRate}`;
  const activeProcessing = [
    settings.echoCancellation ? "Echo" : "",
    settings.noiseSuppression ? "Noise" : "",
    settings.autoGainControl ? "Gain" : "",
  ].filter(Boolean);
  elements.browserprocessing.textContent = activeProcessing.length ? activeProcessing.join(" + ") : "Off";
}

function configuredProcessingLabel() {
  const requested = [
    elements.echocancellationinput.checked ? "Echo" : "",
    elements.noisesuppressioninput.checked ? "Noise" : "",
    elements.autogaininput.checked ? "Gain" : "",
  ].filter(Boolean);
  return requested.length ? `${requested.join(" + ")} requested` : "Off requested";
}

function setCaptureControlsDisabled(disabled) {
  elements.deviceselect.disabled = disabled;
  elements.refreshdevicesbutton.disabled = disabled;
  for (const control of qualityControls) control.disabled = disabled;
}

function loadSettings() {
  let settings;
  try {
    settings = JSON.parse(localStorage.getItem(settingsKey) || "null");
  } catch {
    settings = null;
  }
  const profileName = settings?.profile && (settings.profile === "custom" || PROFILES[settings.profile]) ? settings.profile : "music";
  elements.profileselect.value = profileName;
  if (profileName !== "custom") {
    applyProfile(profileName);
    return;
  }
  elements.capturebitrateselect.value = String(settings.bitrate || 256000);
  elements.channelselect.value = String(settings.channels || 2);
  elements.echocancellationinput.checked = settings.echoCancellation === true;
  elements.noisesuppressioninput.checked = settings.noiseSuppression === true;
  elements.autogaininput.checked = settings.autoGain === true;
  updateProfileDescription();
  updateConfiguredQuality();
}

function saveSettings() {
  if (!settingsKey) return;
  localStorage.setItem(settingsKey, JSON.stringify({
    profile: elements.profileselect.value,
    bitrate: Number(elements.capturebitrateselect.value),
    channels: Number(elements.channelselect.value),
    echoCancellation: elements.echocancellationinput.checked,
    noiseSuppression: elements.noisesuppressioninput.checked,
    autoGain: elements.autogaininput.checked,
  }));
}

function initializeSettings(instanceId) {
  if (settingsKey) return;
  settingsKey = `${SETTINGS_PREFIX}${instanceId}`;
  loadSettings();
}

function toggleTheme() {
  setThemeMode(document.documentElement.dataset.theme === "day" ? "night" : "day", true);
}

function setThemeMode(nextMode, persist) {
  const mode = nextMode === "day" ? "day" : "night";
  document.documentElement.dataset.theme = mode;
  window.FrameTheme?.apply(mode);
  const nextLabel = mode === "day" ? "Switch to night mode" : "Switch to day mode";
  themeToggle.setAttribute("aria-label", nextLabel);
  themeToggle.title = nextLabel;
  themeToggle.setAttribute("aria-pressed", String(mode === "day"));
  if (persist) {
    try {
      localStorage.setItem("frame-theme", mode);
    } catch {}
  }
}

function readStoredTheme() {
  try {
    const stored = localStorage.getItem("frame-theme");
    if (stored === "day" || stored === "night") return stored;
  } catch {}
  return "night";
}
function showNotice(message, kind = "") { elements.notice.textContent = message; elements.notice.className = `notice ${kind}`.trim(); }
async function api(url) { const response = await fetch(url); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`); return body; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function escapeAttr(value) { return escapeHtml(value).replaceAll('"', "&quot;"); }

loadDevices();
loadStatus();
setInterval(loadStatus, 2_000);
