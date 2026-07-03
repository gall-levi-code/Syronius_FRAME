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
let captureSettings = {};
let availableDevices = [];
let lastDeviceSelection = { matched: false, savedDeviceMissing: false };
let remotePublisherActive = false;
let autoStartAttempted = false;
const elementIds = [
  "source-name", "source-id", "publish-status", "notice", "device-select", "profile-select",
  "capture-bitrate-select", "channel-select", "echo-cancellation-input", "noise-suppression-input",
  "auto-gain-input", "profile-description", "live-button", "live-button-label", "refresh-devices-button", "meter-fill",
  "level-readout", "capture-state", "socket-state", "relay-state", "target-bitrate", "input-bitrate",
  "capture-format", "browser-processing", "upload-bitrate", "listener-count", "resume-on-launch-input",
  "capture-config", "capture-monitor",
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
elements.livebutton.addEventListener("click", () => {
  if (isLocalCaptureActive()) {
    stopCapture();
  } else if (remotePublisherActive) {
    showNotice("This audio source is already publishing from another capture page.", "warn");
  } else {
    void startCapture();
  }
});
elements.refreshdevicesbutton.addEventListener("click", () => loadDevices(true, { reason: "manual" }));
document.querySelector("#popout-button").addEventListener("click", () => window.open(location.href, "frame-audio-capture", "popup,width=620,height=820"));
elements.deviceselect.addEventListener("change", saveSettings);
elements.resumeonlaunchinput.addEventListener("change", saveSettings);
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
navigator.mediaDevices?.addEventListener?.("devicechange", () => {
  void loadDevices(false);
});
window.addEventListener("beforeunload", () => stopCapture({ updateStatus: false }));

async function loadDevices(requestAccess = false, options = {}) {
  const quiet = options.quiet === true;
  const reason = options.reason || (requestAccess ? "manual" : "passive");
  if (!navigator.mediaDevices?.enumerateDevices) {
    availableDevices = [];
    renderDeviceOptions([]);
    showNotice("This browser cannot enumerate audio input devices. Default input will be used if available.", "warn");
    void logClientEvent("warn", "device-enumeration-unavailable", { reason });
    return lastDeviceSelection;
  }

  const selectedDevice = elements.deviceselect.value;
  let permissionError;
  if (requestAccess) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((track) => track.stop());
    } catch (error) {
      permissionError = error;
      void logClientEvent("warn", "device-permission-probe-failed", { ...mediaErrorDetail(error), reason });
    }
  }

  try {
    availableDevices = sortAudioDevices((await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput"));
    const selection = renderDeviceOptions(availableDevices, selectedDevice);
    lastDeviceSelection = selection;

    if (permissionError) {
      showNotice(`${describeMediaError(permissionError)} Device names may be hidden until permission is allowed.`, "warn");
      return selection;
    }
    if (!availableDevices.length) {
      showNotice("No audio input devices were reported. Default input will be used if the browser can access one.", "warn");
      void logClientEvent("warn", "device-refresh-empty", { reason });
      return selection;
    }
    if (selection.savedDeviceMissing) {
      showNotice("Previously selected capture device is unavailable. Default input is selected; choose a device before going live if needed.", "warn");
      void logClientEvent("warn", "saved-device-missing", {
        savedDeviceLabel: captureSettings.deviceLabel || "",
        savedDeviceId: captureSettings.deviceId || "",
        availableDeviceCount: availableDevices.length,
        reason,
      });
      return selection;
    }
    if (requestAccess && !quiet) showNotice("Audio devices refreshed.", "ok");
    return selection;
  } catch (error) {
    availableDevices = [];
    renderDeviceOptions([]);
    showNotice(`Audio device refresh failed: ${describeMediaError(error)}`, "warn");
    void logClientEvent("error", "device-refresh-failed", { ...mediaErrorDetail(error), reason });
    return lastDeviceSelection;
  }
}

async function startCapture() {
  try {
    const current = await loadStatus();
    if (current?.publisherActive && !isLocalCaptureActive()) {
      setRemotePublisherActive(true);
      showNotice("This audio source is already publishing from another capture page.", "warn");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support audio capture.");
    }
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
    saveSettings();
    startMeter(mediaStream);
    updateActualCaptureFormat(mediaStream.getAudioTracks()[0]);
    setCaptureControlsDisabled(true);

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}/audio/ws/capture/${encodeURIComponent(streamId)}`);
    socket.binaryType = "arraybuffer";
    elements.socketstate.textContent = "Connecting";
    socket.addEventListener("open", () => {
      setRemotePublisherActive(false);
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
        try {
          if (event.data.size && socket?.readyState === WebSocket.OPEN) socket.send(await event.data.arrayBuffer());
        } catch (error) {
          showNotice(`Unable to send capture chunk: ${describeMediaError(error)}`, "warn");
          void logClientEvent("error", "capture-chunk-send-failed", mediaErrorDetail(error));
        }
      });
      mediaRecorder.addEventListener("error", (event) => {
        const error = event.error || new Error("MediaRecorder failed.");
        showNotice(`Audio recorder failed: ${describeMediaError(error)}`);
        void logClientEvent("error", "media-recorder-error", mediaErrorDetail(error));
      });
      mediaRecorder.start(250);
      setCaptureMonitorVisible(true);
      elements.capturestate.textContent = "Recording";
      elements.socketstate.textContent = "Connected";
      setLiveButton("pause", "Stop capture");
      elements.publishstatus.textContent = "Publishing";
      elements.publishstatus.className = "status-pill good";
    });
    socket.addEventListener("close", (event) => {
      const wasLocal = isLocalCaptureActive();
      if (mediaRecorder?.state === "recording" || mediaStream) stopCapture({ updateStatus: false });
      elements.socketstate.textContent = event.reason || "Disconnected";
      if (event.code === 1008 && /active publisher/i.test(event.reason || "")) {
        setRemotePublisherActive(true);
        showNotice("This audio source is already publishing from another capture page.", "warn");
      } else if (wasLocal && event.code !== 1000) {
        showNotice(`Publisher connection closed: ${event.reason || `code ${event.code}`}`, "warn");
        void logClientEvent("warn", "publisher-socket-closed", { code: event.code, reason: event.reason || "" });
      }
      void loadStatus();
    });
    socket.addEventListener("error", () => {
      showNotice("The publisher connection failed.");
      void logClientEvent("error", "publisher-socket-error");
    });
  } catch (error) {
    stopCapture();
    if (isMissingSelectedDeviceError(error) && elements.deviceselect.value) {
      elements.deviceselect.value = "";
      saveSettings();
      showNotice("Selected capture device is no longer available. Default input is selected; press Go live again when ready.", "warn");
      void logClientEvent("warn", "selected-device-unavailable", mediaErrorDetail(error));
      return;
    }
    showNotice(`Unable to start capture: ${describeMediaError(error)}`);
    void logClientEvent("error", "capture-start-failed", mediaErrorDetail(error));
  }
}

function stopCapture({ updateStatus = true } = {}) {
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
  setCaptureMonitorVisible(false);
  elements.meterfill.style.width = "0%";
  elements.levelreadout.textContent = "-60 dB";
  elements.capturestate.textContent = "Stopped";
  elements.socketstate.textContent = "Disconnected";
  setLiveButton("play", "Go live");
  elements.livebutton.disabled = remotePublisherActive;
  if (!remotePublisherActive) {
    elements.publishstatus.textContent = "Offline";
    elements.publishstatus.className = "status-pill";
  }
  updateConfiguredQuality();
  if (updateStatus) void loadStatus();
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
    elements.relaystate.textContent = stream.mode === "publisher" ? "Live capture" : stream.mode === "silence" ? "Sending silence" : "Offline";
    elements.targetbitrate.textContent = stream.activeBitrateKbps === stream.bitrateKbps
      ? `${stream.bitrateKbps} kbps AAC`
      : `${stream.activeBitrateKbps} active / ${stream.bitrateKbps} next`;
    elements.inputbitrate.textContent = stream.publisherActive ? `${stream.inputKbps} kbps` : "--";
    elements.listenercount.textContent = `${stream.listenerCount} / ${stream.listenerLimit}`;
    setRemotePublisherActive(stream.publisherActive && !isLocalCaptureActive());
    if (stream.lastError && !remotePublisherActive) {
      elements.socketstate.textContent = isLocalCaptureActive() ? elements.socketstate.textContent : "Last relay error";
    }
    return stream;
  } catch (error) {
    showNotice(error.message);
    void logClientEvent("error", "status-load-failed", mediaErrorDetail(error));
    return undefined;
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

function setCaptureMonitorVisible(visible) {
  elements.captureconfig.classList.toggle("hidden", visible);
  elements.capturemonitor.classList.toggle("hidden", !visible);
}

function loadSettings() {
  try {
    captureSettings = JSON.parse(localStorage.getItem(settingsKey) || "null") || {};
  } catch {
    captureSettings = {};
  }
  const profileName = captureSettings?.profile && (captureSettings.profile === "custom" || PROFILES[captureSettings.profile]) ? captureSettings.profile : "music";
  elements.profileselect.value = profileName;
  elements.resumeonlaunchinput.checked = captureSettings.resumeOnLaunch === true;
  if (profileName !== "custom") {
    applyProfile(profileName);
    return;
  }
  elements.capturebitrateselect.value = String(captureSettings.bitrate || 256000);
  elements.channelselect.value = String(captureSettings.channels || 2);
  elements.echocancellationinput.checked = captureSettings.echoCancellation === true;
  elements.noisesuppressioninput.checked = captureSettings.noiseSuppression === true;
  elements.autogaininput.checked = captureSettings.autoGain === true;
  updateProfileDescription();
  updateConfiguredQuality();
}

function saveSettings() {
  if (!settingsKey) return;
  const device = selectedDevice();
  captureSettings = {
    profile: elements.profileselect.value,
    bitrate: Number(elements.capturebitrateselect.value),
    channels: Number(elements.channelselect.value),
    echoCancellation: elements.echocancellationinput.checked,
    noiseSuppression: elements.noisesuppressioninput.checked,
    autoGain: elements.autogaininput.checked,
    resumeOnLaunch: elements.resumeonlaunchinput.checked,
    deviceId: device?.deviceId || elements.deviceselect.value || "",
    deviceLabel: device?.label || selectedDeviceLabel(),
    deviceGroupId: device?.groupId || "",
  };
  localStorage.setItem(settingsKey, JSON.stringify(captureSettings));
}

function initializeSettings(instanceId) {
  if (settingsKey) return;
  settingsKey = `${SETTINGS_PREFIX}${instanceId}`;
  loadSettings();
}

function renderDeviceOptions(devices, currentDeviceId = "") {
  const options = ['<option value="">Default audio input</option>'];
  options.push(...devices.map((device, index) => {
    const label = deviceDisplayLabel(device, index);
    return `<option value="${escapeAttr(device.deviceId)}">${escapeHtml(label)}</option>`;
  }));
  elements.deviceselect.innerHTML = options.join("");

  let selectedId = "";
  let matched = false;
  if (currentDeviceId && devices.some((device) => device.deviceId === currentDeviceId)) {
    selectedId = currentDeviceId;
    matched = true;
  } else if (captureSettings.deviceId && devices.some((device) => device.deviceId === captureSettings.deviceId)) {
    selectedId = captureSettings.deviceId;
    matched = true;
  } else if (captureSettings.deviceGroupId) {
    const groupMatch = devices.find((device) => device.groupId && device.groupId === captureSettings.deviceGroupId);
    if (groupMatch) {
      selectedId = groupMatch.deviceId;
      matched = true;
    }
  }

  if (!matched && captureSettings.deviceLabel) {
    const normalizedSavedLabel = normalizeDeviceLabel(captureSettings.deviceLabel);
    const labelMatch = devices.find((device) => normalizeDeviceLabel(device.label) === normalizedSavedLabel);
    if (labelMatch) {
      selectedId = labelMatch.deviceId;
      matched = true;
    }
  }

  elements.deviceselect.value = selectedId;
  const hadSavedDevice = Boolean(captureSettings.deviceId || captureSettings.deviceLabel || captureSettings.deviceGroupId);
  return { matched, savedDeviceMissing: hadSavedDevice && !matched };
}

function selectedDevice() {
  const deviceId = elements.deviceselect.value;
  return availableDevices.find((device) => device.deviceId === deviceId);
}

function selectedDeviceLabel() {
  if (!elements.deviceselect.value) return "";
  return elements.deviceselect.selectedOptions?.[0]?.textContent || "";
}

function sortAudioDevices(devices) {
  return devices
    .map((device, index) => ({ device, label: deviceDisplayLabel(device, index) }))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true, sensitivity: "base" }))
    .map(({ device }) => device);
}

function deviceDisplayLabel(device, index) {
  return device.label || `Audio input ${index + 1}`;
}

function normalizeDeviceLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isLocalCaptureActive() {
  return mediaRecorder?.state === "recording" || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING;
}

function setRemotePublisherActive(active) {
  remotePublisherActive = active;
  if (active) {
    elements.publishstatus.textContent = "Publishing elsewhere";
    elements.publishstatus.className = "status-pill warn";
    if (!isLocalCaptureActive()) {
      elements.capturestate.textContent = "Standby";
      elements.socketstate.textContent = "Connected elsewhere";
      setLiveButton("joining", "Live elsewhere");
      elements.livebutton.disabled = true;
    }
    return;
  }

  elements.livebutton.disabled = false;
  if (!isLocalCaptureActive()) {
    elements.publishstatus.textContent = "Offline";
    elements.publishstatus.className = "status-pill";
    if (elements.capturestate.textContent === "Standby") elements.capturestate.textContent = "Stopped";
    if (elements.socketstate.textContent === "Connected elsewhere") elements.socketstate.textContent = "Disconnected";
    setLiveButton("play", "Go live");
  }
}

function setLiveButton(action, label) {
  elements.livebutton.dataset.action = action;
  elements.livebuttonlabel.textContent = label;
}

async function maybeResumeCaptureOnLaunch() {
  if (autoStartAttempted || !elements.resumeonlaunchinput.checked) return;
  autoStartAttempted = true;
  if (remotePublisherActive) {
    void logClientEvent("info", "resume-skipped-publisher-active");
    return;
  }
  if (lastDeviceSelection.savedDeviceMissing) {
    showNotice("Resume capture skipped because the saved device is unavailable. Default input is selected; confirm the device before going live.", "warn");
    void logClientEvent("warn", "resume-skipped-saved-device-missing", {
      savedDeviceLabel: captureSettings.deviceLabel || "",
      savedDeviceId: captureSettings.deviceId || "",
    });
    return;
  }
  await startCapture();
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

function describeMediaError(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone permission is blocked. Allow microphone access for this site, then refresh devices.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No audio input device is available.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "The selected audio input is busy or unavailable.";
  }
  if (name === "OverconstrainedError" || name === "ConstraintNotSatisfiedError") {
    return "The selected audio input cannot satisfy the requested capture settings.";
  }
  if (name === "AbortError") {
    return "The browser stopped audio capture before it could start.";
  }
  return error?.message || String(error);
}

function mediaErrorDetail(error) {
  return {
    name: error?.name || "",
    message: error?.message || String(error || ""),
    constraint: error?.constraint || "",
    deviceId: elements.deviceselect.value || "",
    userAgent: navigator.userAgent,
  };
}

function isMissingSelectedDeviceError(error) {
  return ["NotFoundError", "DevicesNotFoundError", "OverconstrainedError", "ConstraintNotSatisfiedError"].includes(error?.name);
}

async function logClientEvent(level, event, detail = {}) {
  try {
    await fetch(`/audio/api/streams/${encodeURIComponent(streamId)}/client-events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, event, detail }),
    });
  } catch {
    // Server-side diagnostics are best-effort; never block capture controls on logging.
  }
}

function showNotice(message, kind = "") { elements.notice.textContent = message; elements.notice.className = `notice ${kind}`.trim(); }
async function api(url) { const response = await fetch(url); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`); return body; }
function escapeHtml(value) { const div = document.createElement("div"); div.textContent = value; return div.innerHTML; }
function escapeAttr(value) { return escapeHtml(value).replaceAll('"', "&quot;"); }

async function initializeCapturePage() {
  await loadStatus();
  const shouldPrimeDevices = elements.resumeonlaunchinput.checked;
  await loadDevices(shouldPrimeDevices, { quiet: shouldPrimeDevices, reason: shouldPrimeDevices ? "resume-on-launch" : "startup" });
  await maybeResumeCaptureOnLaunch();
}

void initializeCapturePage();
setInterval(loadStatus, 2_000);
