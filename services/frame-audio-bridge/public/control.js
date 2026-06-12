(() => {
  const guildKey = location.pathname.split("/")[2];
  const query = new URLSearchParams(location.search);
  const token = query.get("token");
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";

  const icons = {
    speaker: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`,
    speakerOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M11 5 7.5 7.8M6 9H3v6h3l5 4v-6.5"/><path d="M16 9.5c.7.8 1 1.6 1 2.5 0 .7-.2 1.4-.6 2"/></svg>`,
    eye: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>`,
    eyeOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-2.3 3.3"/><path d="M14.1 14.1A3 3 0 0 1 9.9 9.9"/><path d="M6.6 6.6C3.6 8.6 2 12 2 12s3.5 7 10 7a10.6 10.6 0 0 0 5.4-1.6"/></svg>`,
    avatar: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`,
    avatarOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M10.6 4.2A4 4 0 0 1 16 8c0 1-.4 2-1 2.7"/><path d="M6.8 17.4A8 8 0 0 0 4 21h13.6"/></svg>`,
    name: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7v10"/><path d="M15 7v10"/><path d="M7 17h10"/></svg>`,
    nameOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M4 7h3"/><path d="M12 7h8"/><path d="M9 10v7"/><path d="M7 17h10"/></svg>`,
    test: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 2v6l-5 9a3 3 0 0 0 2.6 4h8.8A3 3 0 0 0 19 17l-5-9V2"/><path d="M8 2h8"/><path d="M7.5 15h9"/></svg>`,
    testOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M10 2v4"/><path d="M14 2v6l5 9a3 3 0 0 1-.4 3.4"/><path d="M8 2h8"/><path d="M6.7 14 5 17a3 3 0 0 0 2.6 4h8.8"/></svg>`,
    reset: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v6h6"/></svg>`,
    delay: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2"/><path d="M9 2h6"/></svg>`,
    delayOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M9 2h6"/><path d="M7.7 7.7A8 8 0 0 0 18.3 18.3"/><path d="M19.7 14.6A8 8 0 0 0 9.4 5.3"/><path d="M12 9v3"/></svg>`,
    glow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v4"/><path d="M12 18v4"/><path d="m4.9 4.9 2.8 2.8"/><path d="m16.3 16.3 2.8 2.8"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.9 19.1 2.8-2.8"/><path d="m16.3 7.7 2.8-2.8"/><circle cx="12" cy="12" r="3"/></svg>`,
    glowOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/><path d="m4.9 19.1 2.8-2.8"/><path d="m16.3 7.7 2.8-2.8"/><path d="M10.1 10.1a3 3 0 0 0 3.8 3.8"/></svg>`,
    textShadow: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14"/><path d="M12 6v10"/><path d="M9 16h6"/><path d="M8 19h8"/></svg>`,
    textShadowOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M5 6h6"/><path d="M15 6h4"/><path d="M12 8v8"/><path d="M9 16h6"/><path d="M8 19h8"/></svg>`,
    textStroke: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14"/><path d="M12 6v11"/><path d="M8 17h8"/><path d="M4 4h16v16H4z"/></svg>`,
    textStrokeOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><path d="M5 6h7"/><path d="M16 6h3"/><path d="M12 8v9"/><path d="M8 17h8"/><path d="M4 4h16v16H4z"/></svg>`,
    bubbleShadow: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="12" height="10" rx="4"/><path d="M5 11v6a3 3 0 0 0 3 3h8"/></svg>`,
    bubbleShadowOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><rect x="7" y="7" width="12" height="10" rx="4"/><path d="M5 11v6a3 3 0 0 0 3 3h8"/></svg>`,
    bubbleStroke: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="6"/><path d="M8 12h8"/></svg>`,
    bubbleStrokeOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 2 20 20"/><rect x="4" y="6" width="16" height="12" rx="6"/><path d="M8 12h8"/></svg>`,
    arrowUp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5-7 7"/><path d="m12 5 7 7"/><path d="M12 5v14"/></svg>`,
    arrowDown: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 19-7-7"/><path d="m12 19 7-7"/><path d="M12 5v14"/></svg>`,
    arrowLeft: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 7-7"/><path d="m5 12 7 7"/><path d="M5 12h14"/></svg>`,
    arrowRight: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m19 12-7-7"/><path d="m19 12-7 7"/><path d="M5 12h14"/></svg>`,
    auto: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h16"/><path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/><path d="M12 4v16"/></svg>`,
    moon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.4 15.1A8.4 8.4 0 0 1 8.9 3.6 8.5 8.5 0 1 0 20.4 15.1Z"/></svg>`,
    sun: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/></svg>`,
    lock: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`,
    unlock: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.3-2.3"/></svg>`,
    grip: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/></svg>`,
  };

  const anchorOptions = [
    ["top-left", "Top left"],
    ["top-center", "Top center"],
    ["top-right", "Top right"],
    ["left", "Left"],
    ["center", "Center"],
    ["right", "Right"],
    ["bottom-left", "Bottom left"],
    ["bottom-center", "Bottom center"],
    ["bottom-right", "Bottom right"],
  ];

  const layoutOptions = [
    ["horizontal", "Horizontal"],
    ["vertical", "Vertical"],
    ["active-only", "Active only"],
    ["persistent", "Persistent"],
  ];

  const growthOptions = [
    ["up", "Up", icons.arrowUp, "up"],
    ["left", "Left", icons.arrowLeft, "left"],
    ["auto", "Auto", icons.auto, "middle"],
    ["right", "Right", icons.arrowRight, "right"],
    ["down", "Down", icons.arrowDown, "down"],
  ];

  function anchorIcon(value) {
    const targets = {
      "top-left": [5, 5],
      "top-center": [12, 4],
      "top-right": [19, 5],
      left: [4, 12],
      center: [12, 12],
      right: [20, 12],
      "bottom-left": [5, 19],
      "bottom-center": [12, 20],
      "bottom-right": [19, 19],
    };
    const [x, y] = targets[value] ?? targets.center;

    if (value === "center") {
      return `<svg class="anchor-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/><circle cx="12" cy="12" r="3"/></svg>`;
    }

    const markerId = `anchor-arrow-${value}`;
    return `<svg class="anchor-icon" viewBox="0 0 24 24" aria-hidden="true"><defs><marker id="${markerId}" markerWidth="6" markerHeight="6" refX="5.4" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0 0 6 3 0 6Z" fill="currentColor"/></marker></defs><path class="anchor-arrow" d="M12 12 L${x} ${y}" marker-end="url(#${markerId})"/></svg>`;
  }

  const elements = {
    controlTitle: document.getElementById("control-title"),
    controlTitleName: document.getElementById("control-title-name"),
    controlTitleSuffix: document.getElementById("control-title-suffix"),
    pill: document.getElementById("connection-pill"),
    enginePill: document.getElementById("engine-pill"),
    engineDetails: document.getElementById("engine-details"),
    globalLockToggle: document.getElementById("global-lock-toggle"),
    themeToggle: document.getElementById("theme-toggle"),
    status: document.getElementById("session-status"),
    audioSourceStatus: document.getElementById("audio-source-status"),
    overlaySourceStatus: document.getElementById("overlay-source-status"),
    channelId: document.getElementById("channel-id"),
    channelBitrate: document.getElementById("channel-bitrate"),
    bridgeSessionToggle: document.getElementById("bridge-session-toggle"),
    bridgeSessionFeedback: document.getElementById("bridge-session-feedback"),
    activeSpeakerCount: document.getElementById("active-speaker-count"),
    activeMixCount: document.getElementById("active-mix-count"),
    copyAudio: document.getElementById("copy-audio"),
    copyOverlay: document.getElementById("copy-overlay"),
    delayToggle: document.getElementById("delay-toggle"),
    delaySlider: document.getElementById("delay-slider"),
    delayOutput: document.getElementById("delay-output"),
    delayMinus100: document.getElementById("delay-minus-100"),
    delayMinus50: document.getElementById("delay-minus-50"),
    resetDelay: document.getElementById("reset-delay"),
    delayPlus50: document.getElementById("delay-plus-50"),
    delayPlus100: document.getElementById("delay-plus-100"),
    layoutGrid: document.getElementById("layout-grid"),
    anchorGrid: document.getElementById("anchor-grid"),
    growthGrid: document.getElementById("growth-grid"),
    showAvatarsToggle: document.getElementById("show-avatars-toggle"),
    showNamesToggle: document.getElementById("show-names-toggle"),
    testOverlayToggle: document.getElementById("test-overlay-toggle"),
    avatarSize: document.getElementById("avatar-size"),
    avatarSizeOutput: document.getElementById("avatar-size-output"),
    nameSize: document.getElementById("name-size"),
    nameSizeOutput: document.getElementById("name-size-output"),
    overlayPadding: document.getElementById("overlay-padding"),
    overlayPaddingOutput: document.getElementById("overlay-padding-output"),
    fontSelect: document.getElementById("font-select"),
    bubbleShapeSelect: document.getElementById("bubble-shape-select"),
    avatarPositionSelect: document.getElementById("avatar-position-select"),
    glowToggle: document.getElementById("glow-toggle"),
    textShadowToggle: document.getElementById("text-shadow-toggle"),
    textStrokeToggle: document.getElementById("text-stroke-toggle"),
    bubbleShadowToggle: document.getElementById("bubble-shadow-toggle"),
    bubbleStrokeToggle: document.getElementById("bubble-stroke-toggle"),
    glowIntensity: document.getElementById("glow-intensity"),
    glowOutput: document.getElementById("glow-output"),
    inactiveOpacity: document.getElementById("inactive-opacity"),
    inactiveOpacityOutput: document.getElementById("inactive-opacity-output"),
    textStrokeWidth: document.getElementById("text-stroke-width"),
    textStrokeWidthOutput: document.getElementById("text-stroke-width-output"),
    bubbleStrokeWidth: document.getElementById("bubble-stroke-width"),
    bubbleStrokeWidthOutput: document.getElementById("bubble-stroke-width-output"),
    accentColor: document.getElementById("accent-color"),
    backgroundColor: document.getElementById("background-color"),
    backgroundAlpha: document.getElementById("background-alpha"),
    backgroundAlphaOutput: document.getElementById("background-alpha-output"),
    nameColor: document.getElementById("name-color"),
    fadeMs: document.getElementById("fade-ms"),
    fadeMsOutput: document.getElementById("fade-ms-output"),
    resetFade: document.getElementById("reset-fade"),
    overlayHelpToggle: document.getElementById("overlay-help-toggle"),
    overlayHelp: document.getElementById("overlay-help"),
    activeSpeakers: document.getElementById("active-speakers"),
    activeMixes: document.getElementById("active-mixes"),
    userList: document.getElementById("user-list"),
    muteToggleAll: document.getElementById("mute-toggle-all"),
    hideToggleAll: document.getElementById("hide-toggle-all"),
    resetAllVolumes: document.getElementById("reset-all-volumes"),
    toast: document.getElementById("toast"),
  };
  const sectionToggles = [...document.querySelectorAll("[data-collapse-section]")];
  const sectionLockButtons = [...document.querySelectorAll("[data-lock-section]")];
  const sectionDragHandles = [...document.querySelectorAll("[data-drag-section]")];
  const sectionMoveButtons = [...document.querySelectorAll("[data-move-section]")];
  const helpToggleButtons = [...document.querySelectorAll("[data-help-toggle]")];
  const defaultSectionOrder = ["info", "overlay", "stream"];

  let socket;
  let reconnectTimer;
  let reconnectDelay = 500;
  let snapshot = null;
  let clientCounts = { audio: 0, overlay: 0, control: 0 };
  let delaySendTimer;
  let overlaySendTimer;
  let bridgeActionTimer;
  const inputHoldTimers = new Map();
  let bridgeActionPending = null;
  let bridgeActionRetry = false;
  let bridgeActionMessage = "";
  let bridgeActionTone = "muted";
  let lastSnapshotActive = null;
  let colorMode = readColorMode();
  let globalLocked = readGlobalLock();
  const sectionLocks = readSectionLocks();
  const collapsedSections = readCollapsedSections();
  let sectionOrder = readSectionOrder();
  let draggingSection = null;
  let dragPointerId = null;
  const userRows = new Map();
  const maxControlTitleSizePx = 28;
  const minControlTitleSizePx = 9;

  function readColorMode() {
    try {
      return localStorage.getItem("frame-audio-bridge-color-mode") === "day"
        ? "day"
        : "night";
    } catch {
      return "night";
    }
  }

  function readGlobalLock() {
    try {
      return localStorage.getItem("frame-audio-bridge-global-lock") === "locked";
    } catch {
      return false;
    }
  }

  function writeGlobalLock() {
    try {
      localStorage.setItem("frame-audio-bridge-global-lock", globalLocked ? "locked" : "unlocked");
    } catch {
      // Local storage can be unavailable in hardened embedded browsers.
    }
  }

  function readSectionLocks() {
    try {
      const raw = JSON.parse(localStorage.getItem("frame-audio-bridge-section-locks") ?? "[]");
      return new Set(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  }

  function writeSectionLocks() {
    try {
      localStorage.setItem(
        "frame-audio-bridge-section-locks",
        JSON.stringify([...sectionLocks]),
      );
    } catch {
      // Local storage can be unavailable in hardened embedded browsers.
    }
  }

  function readCollapsedSections() {
    try {
      const raw = JSON.parse(localStorage.getItem("frame-audio-bridge-collapsed-sections") ?? "[]");
      return new Set(Array.isArray(raw) ? raw : []);
    } catch {
      return new Set();
    }
  }

  function writeCollapsedSections() {
    try {
      localStorage.setItem(
        "frame-audio-bridge-collapsed-sections",
        JSON.stringify([...collapsedSections]),
      );
    } catch {
      // Local storage can be unavailable in hardened embedded browsers.
    }
  }

  function readSectionOrder() {
    try {
      const raw = JSON.parse(localStorage.getItem("frame-audio-bridge-section-order") ?? "[]");
      if (!Array.isArray(raw)) {
        return [...defaultSectionOrder];
      }

      const known = raw.filter((sectionName) => defaultSectionOrder.includes(sectionName));
      const missing = defaultSectionOrder.filter((sectionName) => !known.includes(sectionName));
      return [...known, ...missing];
    } catch {
      return [...defaultSectionOrder];
    }
  }

  function writeSectionOrder() {
    sectionOrder = [...document.querySelectorAll("[data-section]")].map(
      (section) => section.dataset.section,
    );

    try {
      localStorage.setItem("frame-audio-bridge-section-order", JSON.stringify(sectionOrder));
    } catch {
      // Local storage can be unavailable in hardened embedded browsers.
    }

    renderSectionMoveButtons();
  }

  function setColorMode(nextMode) {
    colorMode = nextMode === "day" ? "day" : "night";
    document.body.classList.toggle("theme-day", colorMode === "day");
    elements.themeToggle.innerHTML = colorMode === "day" ? icons.sun : icons.moon;
    const nextLabel = colorMode === "day" ? "Switch to night mode" : "Switch to day mode";
    elements.themeToggle.setAttribute("aria-label", nextLabel);
    elements.themeToggle.title = nextLabel;
    elements.themeToggle.setAttribute("aria-pressed", String(colorMode === "day"));

    try {
      localStorage.setItem("frame-audio-bridge-color-mode", colorMode);
    } catch {
      // Local storage can be unavailable in hardened embedded browsers.
    }
  }

  function buildOverlayButtons() {
    elements.layoutGrid.innerHTML = "";
    for (const [value, label] of layoutOptions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "icon-toggle layout-button positive-toggle";
      button.dataset.layout = value;
      button.title = label;
      button.setAttribute("aria-label", `Layout ${label}`);
      button.setAttribute("aria-pressed", "false");
      button.innerHTML = `<span>${label}</span>`;
      button.addEventListener("click", () => sendOverlayPatch({ layout: value }));
      elements.layoutGrid.append(button);
    }

    elements.anchorGrid.innerHTML = "";
    for (const [value, label] of anchorOptions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "anchor-button";
      button.dataset.position = value;
      button.title = label;
      button.setAttribute("aria-label", `Anchor ${label}`);
      button.setAttribute("aria-pressed", "false");
      button.innerHTML = anchorIcon(value);
      button.addEventListener("click", () => sendOverlayPatch({ position: value }));
      elements.anchorGrid.append(button);
    }

    elements.growthGrid.innerHTML = "";
    for (const [value, label, icon, area] of growthOptions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "icon-toggle growth-button";
      button.dataset.growth = value;
      button.style.gridArea = area;
      button.title = label === "Auto" ? "Auto growth from anchor" : `Grow ${label.toLowerCase()}`;
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", "false");
      button.innerHTML = `${icon}<span>${label}</span>`;
      button.addEventListener("click", () => sendOverlayPatch({ growthDirection: value }));
      elements.growthGrid.append(button);
    }
  }

  function setupStaticIcons() {
    elements.resetDelay.innerHTML = icons.reset;
    elements.resetFade.innerHTML = icons.reset;
    elements.resetAllVolumes.innerHTML = icons.reset;
    for (const handle of sectionDragHandles) {
      handle.innerHTML = icons.grip;
    }
    for (const button of sectionMoveButtons) {
      button.innerHTML = button.dataset.moveDirection === "-1" ? icons.arrowUp : icons.arrowDown;
    }
    renderLockState();
  }

  function sectionTitle(sectionName) {
    return {
      info: "Info",
      overlay: "Overlay",
      stream: "Stream Control",
    }[sectionName] ?? "Section";
  }

  function isLockExempt(control) {
    return (
      control === elements.globalLockToggle ||
      control === elements.themeToggle ||
      control === elements.enginePill ||
      control.classList.contains("section-toggle") ||
      control.classList.contains("section-lock") ||
      control.classList.contains("help-bubble")
    );
  }

  function controlSectionName(control) {
    return control.closest("[data-section]")?.dataset.section;
  }

  function sectionIsLocked(sectionName) {
    return globalLocked || Boolean(sectionName && sectionLocks.has(sectionName));
  }

  function setControlDisabled(control, disabled) {
    control.dataset.baseDisabled = String(disabled);
    control.disabled = Boolean(
      disabled || (!isLockExempt(control) && sectionIsLocked(controlSectionName(control))),
    );
  }

  function renderLockState() {
    const globalLabel = globalLocked ? "Unlock all controls" : "Lock all controls";
    elements.globalLockToggle.innerHTML = globalLocked ? icons.lock : icons.unlock;
    elements.globalLockToggle.title = globalLabel;
    elements.globalLockToggle.setAttribute("aria-label", globalLabel);
    elements.globalLockToggle.setAttribute("aria-pressed", String(globalLocked));
    elements.globalLockToggle.classList.toggle("active", globalLocked);

    for (const button of sectionLockButtons) {
      const sectionName = button.dataset.lockSection;
      const locked = sectionLocks.has(sectionName);
      const label = locked
        ? `Unlock ${sectionTitle(sectionName)} controls`
        : `Lock ${sectionTitle(sectionName)} controls`;
      button.innerHTML = locked ? icons.lock : icons.unlock;
      button.title = label;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(locked));
      button.classList.toggle("active", locked);
    }
  }

  function applyControlLocks() {
    for (const section of document.querySelectorAll("[data-section]")) {
      const sectionName = section.dataset.section;
      section.classList.toggle("locked", sectionIsLocked(sectionName));
      section.classList.toggle("section-locked", sectionLocks.has(sectionName));
      section.classList.toggle("global-locked", globalLocked);
    }

    for (const control of document.querySelectorAll("button,input,select,textarea")) {
      if (!("baseDisabled" in control.dataset)) {
        control.dataset.baseDisabled = String(control.disabled);
      }

      if (isLockExempt(control)) {
        continue;
      }

      const baseDisabled = control.dataset.baseDisabled === "true";
      control.disabled = baseDisabled || sectionIsLocked(controlSectionName(control));
    }

    renderSectionMoveButtons();
    renderLockState();
  }

  function setSectionCollapsed(sectionName, collapsed) {
    const toggle = document.querySelector(`[data-collapse-section="${sectionName}"]`);
    const section = document.querySelector(`[data-section="${sectionName}"]`);
    const content = section?.querySelector(".section-content");
    if (!toggle || !section || !content) {
      return;
    }

    content.hidden = collapsed;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    section.classList.toggle("collapsed", collapsed);

    if (collapsed) {
      collapsedSections.add(sectionName);
    } else {
      collapsedSections.delete(sectionName);
    }
  }

  function setupCollapsibleSections() {
    for (const toggle of sectionToggles) {
      const sectionName = toggle.dataset.collapseSection;
      setSectionCollapsed(sectionName, collapsedSections.has(sectionName));
      toggle.addEventListener("click", () => {
        const nextCollapsed = !collapsedSections.has(sectionName);
        setSectionCollapsed(sectionName, nextCollapsed);
        writeCollapsedSections();
      });
    }
  }

  function applySectionOrder() {
    const shell = document.querySelector(".control-shell");
    if (!shell) {
      return;
    }

    for (const sectionName of sectionOrder) {
      const section = document.querySelector(`[data-section="${sectionName}"]`);
      if (section) {
        shell.append(section);
      }
    }
    renderSectionMoveButtons();
  }

  function renderSectionMoveButtons() {
    const currentOrder = [...document.querySelectorAll("[data-section]")].map(
      (section) => section.dataset.section,
    );

    for (const button of sectionMoveButtons) {
      const sectionName = button.dataset.moveSection;
      const direction = Number(button.dataset.moveDirection);
      const index = currentOrder.indexOf(sectionName);
      const disabled =
        index < 0 ||
        !Number.isFinite(direction) ||
        index + direction < 0 ||
        index + direction >= currentOrder.length;
      setControlDisabled(button, disabled);
    }
  }

  function moveSection(sectionName, direction) {
    const section = document.querySelector(`[data-section="${sectionName}"]`);
    const shell = document.querySelector(".control-shell");
    if (!section || !shell || sectionIsLocked(sectionName)) {
      return;
    }

    const sections = [...shell.querySelectorAll("[data-section]")];
    const index = sections.indexOf(section);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= sections.length) {
      return;
    }

    if (direction < 0) {
      shell.insertBefore(section, sections[targetIndex]);
    } else {
      shell.insertBefore(sections[targetIndex], section);
    }

    writeSectionOrder();
    applyControlLocks();
  }

  function sectionAfterPointer(pointerY) {
    return [...document.querySelectorAll("[data-section]:not(.section-dragging)")].find(
      (section) => {
        const rect = section.getBoundingClientRect();
        return pointerY < rect.top + rect.height / 2;
      },
    );
  }

  function finishSectionDrag(handle) {
    if (!draggingSection) {
      return;
    }

    draggingSection.classList.remove("section-dragging");
    draggingSection = null;
    dragPointerId = null;
    document.body.classList.remove("section-reorder-active");
    writeSectionOrder();

    if (handle) {
      try {
        handle.releasePointerCapture?.(Number(handle.dataset.pointerId));
      } catch {
        // Pointer capture may already be gone after a cancelled touch.
      }
      delete handle.dataset.pointerId;
    }
  }

  function setupSectionReorder() {
    applySectionOrder();

    for (const button of sectionMoveButtons) {
      button.addEventListener("click", () => {
        moveSection(button.dataset.moveSection, Number(button.dataset.moveDirection));
      });
    }

    for (const handle of sectionDragHandles) {
      handle.addEventListener("pointerdown", (event) => {
        if (handle.disabled || event.button > 0) {
          return;
        }

        draggingSection = handle.closest("[data-section]");
        if (!draggingSection) {
          return;
        }

        event.preventDefault();
        dragPointerId = event.pointerId;
        handle.dataset.pointerId = String(event.pointerId);
        handle.setPointerCapture?.(event.pointerId);
        draggingSection.classList.add("section-dragging");
        document.body.classList.add("section-reorder-active");
      });

      handle.addEventListener("pointermove", (event) => {
        if (!draggingSection || dragPointerId !== event.pointerId) {
          return;
        }

        event.preventDefault();
        const afterSection = sectionAfterPointer(event.clientY);
        const shell = document.querySelector(".control-shell");
        if (!shell) {
          return;
        }

        if (afterSection) {
          shell.insertBefore(draggingSection, afterSection);
        } else {
          shell.append(draggingSection);
        }
      });

      handle.addEventListener("pointerup", (event) => {
        if (dragPointerId === event.pointerId) {
          finishSectionDrag(handle);
        }
      });

      handle.addEventListener("pointercancel", (event) => {
        if (dragPointerId === event.pointerId) {
          finishSectionDrag(handle);
        }
      });
    }
  }

  function setupControlLocks() {
    elements.globalLockToggle.addEventListener("click", () => {
      globalLocked = !globalLocked;
      writeGlobalLock();
      applyControlLocks();
    });

    for (const button of sectionLockButtons) {
      button.addEventListener("click", () => {
        const sectionName = button.dataset.lockSection;
        if (sectionLocks.has(sectionName)) {
          sectionLocks.delete(sectionName);
        } else {
          sectionLocks.add(sectionName);
        }

        writeSectionLocks();
        applyControlLocks();
      });
    }

    applyControlLocks();
  }

  function connect() {
    setConnection("Connecting", "warn");
    const params = new URLSearchParams({
      client: "control",
      guildKey,
      token,
    });

    socket = new WebSocket(`${scheme}//${location.host}/bridge/ws?${params.toString()}`);

    socket.addEventListener("open", () => {
      reconnectDelay = 500;
      setConnection("Connected", "ok");
      renderBridgeAction();
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "snapshot") {
        snapshot = message.snapshot;
        render();
      }

      if (message.type === "client-state") {
        clientCounts = message.counts;
        renderSourceStatus();
      }

      if (message.type === "error") {
        showToast(message.message || "Bridge error");
      }

      if (message.type === "bridge-action") {
        clearTimeout(bridgeActionTimer);
        bridgeActionPending = null;
        bridgeActionRetry = !message.ok && message.state === "retry";
        bridgeActionMessage = message.message || (message.ok ? "Bridge updated." : "Bridge action failed.");
        bridgeActionTone = message.ok ? "ok" : "bad";
        renderBridgeAction();
        showToast(bridgeActionMessage);
      }
    });

    socket.addEventListener("close", () => {
      setConnection("Reconnecting", "warn");
      clearTimeout(bridgeActionTimer);
      if (bridgeActionPending) {
        bridgeActionPending = null;
        bridgeActionRetry = true;
        bridgeActionMessage = "Connection lost before the bridge action completed.";
        bridgeActionTone = "bad";
        renderBridgeAction();
      }
      renderBridgeAction();
      scheduleReconnect();
    });

    socket.addEventListener("error", () => socket.close());
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 5000);
  }

  function send(payload) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  function isEditingInput(element) {
    return document.activeElement === element || element.dataset.dragging === "true";
  }

  function isUserSliderActive() {
    return [...elements.userList.querySelectorAll(".volume-control input[type='range']")].some(
      isEditingInput,
    );
  }

  function setInputValue(element, value) {
    if (!element || isEditingInput(element)) {
      return;
    }

    element.value = String(value);
  }

  function holdInputValue(element, durationMs = 800) {
    if (!element) {
      return;
    }

    element.dataset.dragging = "true";
    clearTimeout(inputHoldTimers.get(element));
    inputHoldTimers.set(
      element,
      setTimeout(() => {
        delete element.dataset.dragging;
        inputHoldTimers.delete(element);
      }, durationMs),
    );
  }

  function colorBase(hexColor, fallback) {
    if (typeof hexColor !== "string" || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hexColor)) {
      return fallback;
    }

    return hexColor.slice(0, 7).toLowerCase();
  }

  function colorAlphaPercent(hexColor) {
    if (typeof hexColor !== "string" || !/^#[0-9a-fA-F]{8}$/.test(hexColor)) {
      return 100;
    }

    return Math.round((parseInt(hexColor.slice(7, 9), 16) / 255) * 100);
  }

  function colorWithAlpha(hexColor, alphaPercent) {
    const base = colorBase(hexColor, "#07111b");
    const alpha = Math.round(Math.max(0, Math.min(100, Number(alphaPercent))) * 2.55);
    return `${base}${alpha.toString(16).padStart(2, "0")}`;
  }

  function setCheckboxValue(element, checked) {
    if (!element || document.activeElement === element) {
      return;
    }

    element.checked = Boolean(checked);
  }

  function formatDb(level) {
    if (!Number.isFinite(level) || level <= 0.001) {
      return "-inf dB";
    }

    return `${Math.max(-60, Math.round(20 * Math.log10(level)))} dB`;
  }

  function meterClass(level) {
    if (level >= 0.9) {
      return "level-meter level-hot";
    }

    if (level >= 0.7) {
      return "level-meter level-warn";
    }

    return "level-meter";
  }

  function controlNameFromProfile(profileLabel) {
    const label = String(profileLabel ?? "").trim();
    const generatedLabel = label.match(/^(.+)'s bridge$/i);
    if (generatedLabel?.[1]) {
      return generatedLabel[1].trim();
    }

    if (!label || label === "Guild bridge" || label === "Streamer bridge") {
      return "FRAME";
    }

    return label;
  }

  function fitControlTitle() {
    if (!elements.controlTitle || !elements.controlTitleName || !elements.controlTitleSuffix) {
      return;
    }

    elements.controlTitle.style.fontSize = `${maxControlTitleSizePx}px`;
    requestAnimationFrame(() => {
      const availableWidth = elements.controlTitle.clientWidth;
      if (availableWidth <= 0) {
        return;
      }

      const widestLine = Math.max(
        elements.controlTitleName.scrollWidth,
        elements.controlTitleSuffix.scrollWidth,
        1,
      );
      const nextSize = Math.max(
        minControlTitleSizePx,
        Math.min(
          maxControlTitleSizePx,
          Math.floor((maxControlTitleSizePx * (availableWidth - 1)) / widestLine),
        ),
      );

      elements.controlTitle.style.fontSize = `${nextSize}px`;
    });
  }

  function renderControlTitle() {
    const name = controlNameFromProfile(snapshot?.profileLabel);
    if (elements.controlTitleName.textContent !== name) {
      elements.controlTitleName.textContent = name;
    }

    fitControlTitle();
  }

  function render() {
    if (!snapshot) {
      return;
    }

    renderControlTitle();
    elements.status.textContent = snapshot.active ? "Active" : "Inactive";
    elements.channelId.textContent = snapshot.channelName ?? snapshot.channelId ?? "None";
    elements.channelBitrate.textContent = snapshot.channelBitrate
      ? `${Math.round(snapshot.channelBitrate / 1000)} kbps`
      : "Unknown";
    const activeUsers = snapshot.users.filter((user) => user.speaking);
    renderActiveSpeakers(activeUsers);
    renderActiveMixes(snapshot.activeProfiles ?? []);
    syncBridgeActionFromSnapshot();

    elements.delaySlider.max = String(snapshot.maxDelayMs);
    setInputValue(elements.delaySlider, snapshot.defaultDelayMs ?? snapshot.delayMs);
    renderDelayControl();

    setInputValue(elements.avatarSize, snapshot.overlaySettings.avatarSizePx ?? 42);
    setInputValue(elements.nameSize, snapshot.overlaySettings.nameFontSizePx ?? 18);
    setInputValue(elements.overlayPadding, snapshot.overlaySettings.paddingPx ?? 24);
    setInputValue(elements.fontSelect, snapshot.overlaySettings.fontFamily ?? "system");
    setInputValue(elements.bubbleShapeSelect, snapshot.overlaySettings.bubbleShape ?? "pill");
    setInputValue(elements.avatarPositionSelect, snapshot.overlaySettings.avatarPosition ?? "left");
    setInputValue(elements.glowIntensity, snapshot.overlaySettings.glowIntensity ?? 42);
    setInputValue(elements.inactiveOpacity, snapshot.overlaySettings.inactiveOpacity ?? 56);
    setInputValue(elements.textStrokeWidth, snapshot.overlaySettings.textStrokeWidthPx ?? 1);
    setInputValue(elements.bubbleStrokeWidth, snapshot.overlaySettings.bubbleStrokeWidthPx ?? 1);
    setInputValue(elements.accentColor, snapshot.overlaySettings.accentColor ?? "#2cb4fb");
    const cardColor = snapshot.overlaySettings.backgroundColor ?? "#07111b";
    setInputValue(elements.backgroundColor, colorBase(cardColor, "#07111b"));
    setInputValue(elements.backgroundAlpha, colorAlphaPercent(cardColor));
    setInputValue(elements.nameColor, snapshot.overlaySettings.nameColor ?? "#ffffff");
    setInputValue(elements.fadeMs, snapshot.overlaySettings.fadeMs);
    setCheckboxValue(elements.textShadowToggle, snapshot.overlaySettings.textShadow ?? false);
    setCheckboxValue(elements.textStrokeToggle, snapshot.overlaySettings.textStroke ?? false);
    updateRangeOutputs();

    renderSourceStatus();
    renderEngineStatus();
    renderBridgeAction();
    renderLayoutButtons();
    renderPlacementButtons();
    renderOverlayToggles();
    renderBulkActions();
    renderUsers();
    applyControlLocks();
  }

  function renderDelayControl() {
    if (!elements.delayToggle || !elements.delaySlider || !elements.delayOutput) {
      return;
    }

    const delayEnabled = snapshot?.delayEnabled !== false;
    const savedDelayMs = Number(elements.delaySlider.value || snapshot?.defaultDelayMs || 0);
    elements.delayOutput.textContent = delayEnabled
      ? `${savedDelayMs}ms`
      : `${savedDelayMs}ms saved, off`;

    configureToggleButton(
      elements.delayToggle,
      delayEnabled ? icons.delay : icons.delayOff,
      delayEnabled,
      delayEnabled ? "Delay on" : "Delay off",
      () => {
        if (!snapshot) {
          return;
        }

        const nextDelayEnabled = !(snapshot.delayEnabled !== false);
        snapshot.delayEnabled = nextDelayEnabled;
        renderDelayControl();
        send({ type: "set-delay-enabled", delayEnabled: nextDelayEnabled });
      },
      !snapshot,
      true,
    );
  }

  function renderBridgeAction() {
    if (!elements.bridgeSessionToggle || !elements.bridgeSessionFeedback) {
      return;
    }

    if (snapshot?.active) {
      bridgeActionRetry = false;
    }

    const socketReady = socket?.readyState === WebSocket.OPEN;
    const pending = Boolean(bridgeActionPending);
    const active = Boolean(snapshot?.active);
    const buttonText = pending
      ? bridgeActionPending === "start" ? "Starting..." : "Stopping..."
      : active ? "Stop Bridge"
      : bridgeActionRetry ? "Retry Start"
      : "Start Bridge";
    const label = pending
      ? buttonText
      : active ? "Stop bridge"
      : bridgeActionRetry ? "Retry starting bridge"
      : "Start bridge";
    const disabled = pending || !socketReady || !snapshot;

    elements.bridgeSessionToggle.textContent = buttonText;
    elements.bridgeSessionToggle.title = label;
    elements.bridgeSessionToggle.setAttribute("aria-label", label);
    elements.bridgeSessionToggle.classList.toggle("danger", active && !pending);
    elements.bridgeSessionToggle.classList.toggle("retry", bridgeActionRetry && !active && !pending);
    setControlDisabled(elements.bridgeSessionToggle, disabled);

    const defaultMessage = active
      ? `Bridge is active${snapshot.channelName ? ` in ${snapshot.channelName}` : ""}.`
      : socketReady
        ? "Join a Discord voice channel, then start your bridge from here."
        : "Control socket is reconnecting.";
    elements.bridgeSessionFeedback.textContent = bridgeActionMessage || defaultMessage;
    elements.bridgeSessionFeedback.className = `bridge-session-feedback bridge-session-feedback-${bridgeActionTone}`;
  }

  function syncBridgeActionFromSnapshot() {
    if (!snapshot) {
      return;
    }

    const active = Boolean(snapshot.active);
    if (
      (bridgeActionPending === "start" && active) ||
      (bridgeActionPending === "stop" && !active)
    ) {
      clearTimeout(bridgeActionTimer);
      bridgeActionPending = null;
      bridgeActionRetry = false;
      bridgeActionMessage = active
        ? `Bridge is active${snapshot.channelName ? ` in ${snapshot.channelName}` : ""}.`
        : "Bridge stopped.";
      bridgeActionTone = "ok";
    } else if (lastSnapshotActive !== null && lastSnapshotActive !== active && !bridgeActionPending) {
      bridgeActionRetry = false;
      bridgeActionMessage = "";
      bridgeActionTone = "muted";
    }

    lastSnapshotActive = active;
  }

  function sendBridgeAction() {
    if (!snapshot || bridgeActionPending) {
      return;
    }

    if (socket?.readyState !== WebSocket.OPEN) {
      bridgeActionRetry = true;
      bridgeActionMessage = "Control socket is disconnected. Reconnect, then retry.";
      bridgeActionTone = "bad";
      renderBridgeAction();
      return;
    }

    const action = snapshot.active ? "stop" : "start";
    bridgeActionPending = action;
    bridgeActionRetry = false;
    bridgeActionMessage = action === "start"
      ? "Asking the bot to join your voice channel..."
      : "Stopping your bridge mix...";
    bridgeActionTone = "muted";
    renderBridgeAction();
    send({ type: action === "start" ? "start-bridge" : "stop-bridge" });

    clearTimeout(bridgeActionTimer);
    bridgeActionTimer = setTimeout(() => {
      if (!bridgeActionPending) {
        return;
      }

      bridgeActionPending = null;
      bridgeActionRetry = true;
      bridgeActionMessage = "No response from the bot yet. Try again.";
      bridgeActionTone = "bad";
      renderBridgeAction();
    }, 15_000);
  }

  function renderActiveSpeakers(activeUsers) {
    elements.activeSpeakerCount.textContent = String(activeUsers.length);
    elements.activeSpeakers.innerHTML = "";

    if (activeUsers.length === 0) {
      elements.activeSpeakers.className = "active-speaker-list muted";
      elements.activeSpeakers.textContent = "None";
      return;
    }

    elements.activeSpeakers.className = "active-speaker-list";
    for (const user of activeUsers) {
      const chip = document.createElement("span");
      chip.className = "speaker-chip";
      chip.textContent = user.displayName;
      elements.activeSpeakers.append(chip);
    }
  }

  function renderActiveMixes(activeProfiles) {
    if (!elements.activeMixCount || !elements.activeMixes) {
      return;
    }

    elements.activeMixCount.textContent = String(activeProfiles.length);
    elements.activeMixes.innerHTML = "";

    if (activeProfiles.length === 0) {
      elements.activeMixes.className = "active-mix-list muted";
      elements.activeMixes.textContent = "None";
      return;
    }

    elements.activeMixes.className = "active-mix-list";
    for (const profile of activeProfiles) {
      const chip = document.createElement("span");
      chip.className = "speaker-chip mix-chip";
      chip.textContent = mixNameFromProfile(profile);
      elements.activeMixes.append(chip);
    }
  }

  function mixNameFromProfile(profile) {
    const label = String(profile?.label ?? "").trim();
    const name = controlNameFromProfile(label);
    return name === "FRAME" ? label || "Unnamed bridge" : name;
  }

  function renderSourceStatus() {
    renderSource(elements.audioSourceStatus, clientCounts.audio, "Connected", "Offline");
    renderSource(elements.overlaySourceStatus, clientCounts.overlay, "Connected", "Offline");
    renderEngineStatus();
  }

  function renderSource(element, count, onlineText, offlineText) {
    element.textContent = count > 0 ? `${onlineText} (${count})` : offlineText;
    element.classList.toggle("source-online", count > 0);
    element.classList.toggle("source-offline", count === 0);
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function engineChecklist(state) {
    if (state !== "warn" && state !== "bad") {
      return "";
    }

    return [
      "<ul class=\"engine-checklist\">",
      "<li>Confirm `/frame start` is active for your mix.</li>",
      "<li>Check the OBS audio Browser Source is connected and has <strong>Control audio via OBS</strong> enabled.</li>",
      "<li>Check the OBS overlay Browser Source is connected if you use the speaker overlay.</li>",
      "<li>Make sure Discord users are actually speaking and the bot is still in the intended voice channel.</li>",
      "<li>If operator invites or role access fail, run `/frame info` and check the role hierarchy warning.</li>",
      "</ul>",
    ].join("");
  }

  function renderEngineStatus() {
    if (!elements.enginePill) {
      return;
    }

    const health = snapshot?.engineHealth ?? {
      state: "idle",
      label: "Engine idle",
      details: "Waiting for bridge state.",
    };
    let state = health.state;
    let label = health.label;
    let details = health.details;

    if (snapshot?.active && clientCounts.audio === 0) {
      state = "warn";
      label = "Audio OBS offline";
      details = `${details} Audio browser source is not connected.`;
    } else if (snapshot?.active && clientCounts.overlay === 0) {
      state = health.state === "bad" ? "bad" : "warn";
      label = health.state === "bad" ? health.label : "Overlay offline";
      details = `${details} Overlay browser source is not connected.`;
    }

    elements.enginePill.textContent = label;
    elements.enginePill.title = details;
    elements.enginePill.setAttribute("aria-label", `${label}. Tap for details.`);
    elements.enginePill.className = `pill engine-pill pill-${state}`;

    if (elements.engineDetails) {
      elements.engineDetails.className = `engine-details engine-details-${state}`;
      elements.engineDetails.innerHTML = [
        `<strong>${escapeHtml(label)}</strong>`,
        `<span>${escapeHtml(details)}</span>`,
        engineChecklist(state),
      ].join("");
    }
  }

  function renderBulkActions() {
    const users = snapshot?.users ?? [];
    const disabled = users.length === 0;
    const allMuted = users.length > 0 && users.every((user) => user.muted);
    const allHidden = users.length > 0 && users.every((user) => user.hidden);

    configureToggleButton(
      elements.muteToggleAll,
      allMuted ? icons.speakerOff : icons.speaker,
      allMuted,
      allMuted ? "Unmute all" : "Mute all",
      () => send({ type: "set-users", muted: !allMuted }),
      disabled,
      true,
    );

    configureToggleButton(
      elements.hideToggleAll,
      allHidden ? icons.eyeOff : icons.eye,
      allHidden,
      allHidden ? "Show all" : "Hide all",
      () => send({ type: "set-users", hidden: !allHidden }),
      disabled,
      true,
    );

    setControlDisabled(elements.resetAllVolumes, disabled);
  }

  function renderLayoutButtons() {
    const settings = snapshot?.overlaySettings;
    if (!settings) {
      return;
    }

    for (const button of elements.layoutGrid.querySelectorAll("button")) {
      const active = button.dataset.layout === settings.layout;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  function renderPlacementButtons() {
    const settings = snapshot?.overlaySettings;
    if (!settings) {
      return;
    }

    for (const button of elements.anchorGrid.querySelectorAll("button")) {
      const active = button.dataset.position === (settings.position ?? "bottom-center");
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }

    for (const button of elements.growthGrid.querySelectorAll("button")) {
      const active = button.dataset.growth === (settings.growthDirection ?? "auto");
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }

  function renderOverlayToggles() {
    const settings = snapshot?.overlaySettings;
    if (!settings) {
      return;
    }

    configureToggleButton(
      elements.showAvatarsToggle,
      settings.showAvatars ? icons.avatar : icons.avatarOff,
      settings.showAvatars,
      settings.showAvatars ? "Hide avatars" : "Show avatars",
      () => sendOverlayPatch({ showAvatars: !settings.showAvatars }),
      false,
      true,
    );

    configureToggleButton(
      elements.showNamesToggle,
      settings.showNames ? icons.name : icons.nameOff,
      settings.showNames,
      settings.showNames ? "Hide names" : "Show names",
      () => sendOverlayPatch({ showNames: !settings.showNames }),
      false,
      true,
    );

    configureToggleButton(
      elements.testOverlayToggle,
      settings.testMode ? icons.test : icons.testOff,
      settings.testMode ?? false,
      settings.testMode ? "Hide test overlay" : "Show test overlay",
      () => sendOverlayPatch({ testMode: !(settings.testMode ?? false) }),
      false,
      true,
    );

    configureToggleButton(
      elements.glowToggle,
      settings.glowEnabled ? icons.glow : icons.glowOff,
      settings.glowEnabled ?? true,
      settings.glowEnabled ? "Disable glow" : "Enable glow",
      () => sendOverlayPatch({ glowEnabled: !(settings.glowEnabled ?? true) }),
      false,
      true,
    );

    configureToggleButton(
      elements.bubbleShadowToggle,
      (settings.bubbleShadow ?? true) ? icons.bubbleShadow : icons.bubbleShadowOff,
      settings.bubbleShadow ?? true,
      (settings.bubbleShadow ?? true) ? "Disable bubble shadow" : "Enable bubble shadow",
      () => sendOverlayPatch({ bubbleShadow: !(settings.bubbleShadow ?? true) }),
      false,
      true,
    );

    configureToggleButton(
      elements.bubbleStrokeToggle,
      settings.bubbleStroke ? icons.bubbleStroke : icons.bubbleStrokeOff,
      settings.bubbleStroke ?? false,
      settings.bubbleStroke ? "Disable bubble outline" : "Enable bubble outline",
      () => sendOverlayPatch({ bubbleStroke: !(settings.bubbleStroke ?? false) }),
      false,
      true,
    );
  }

  function renderUsers() {
    if (!snapshot.users.length) {
      userRows.clear();
      elements.userList.className = "user-list empty";
      elements.userList.textContent = "No users tracked yet.";
      return;
    }

    elements.userList.className = "user-list";
    if (elements.userList.textContent === "No users tracked yet.") {
      elements.userList.textContent = "";
    }

    const seenUserIds = new Set();
    const allowReorder = !isUserSliderActive();
    snapshot.users.forEach((user, index) => {
      seenUserIds.add(user.discordUserId);
      const row = getUserRow(user);
      updateUserRow(row, user);
      const target = elements.userList.children[index] ?? null;
      if (row.root.parentElement !== elements.userList) {
        elements.userList.insertBefore(row.root, target);
      } else if (allowReorder && row.root !== target) {
        elements.userList.insertBefore(row.root, target);
      }
    });

    for (const [discordUserId, row] of userRows) {
      if (!seenUserIds.has(discordUserId)) {
        row.root.remove();
        userRows.delete(discordUserId);
      }
    }
  }

  function getUserRow(user) {
    const existing = userRows.get(user.discordUserId);
    if (existing) {
      return existing;
    }

    const root = document.createElement("article");
    root.className = "user-row";
    const identity = document.createElement("div");
    identity.className = "user-identity";

    const avatar = document.createElement("img");
    avatar.alt = "";
    avatar.hidden = true;

    const label = document.createElement("div");
    label.className = "user-label";
    const name = document.createElement("strong");
    const state = document.createElement("span");

    const meterRow = document.createElement("div");
    meterRow.className = "voice-meter-row";

    const meter = document.createElement("div");
    meter.className = "level-meter";
    const fill = document.createElement("span");
    fill.className = "level-meter-fill";
    const peak = document.createElement("span");
    peak.className = "level-meter-peak";
    meter.append(fill, peak);

    const readout = document.createElement("span");
    readout.className = "level-readout";
    readout.textContent = "-inf dB";

    meterRow.append(meter, readout);
    label.append(name, state, meterRow);
    identity.append(avatar, label);

    const controls = document.createElement("div");
    controls.className = "user-controls";

    const muteButton = document.createElement("button");
    muteButton.type = "button";
    muteButton.className = "icon-toggle";

    const hideButton = document.createElement("button");
    hideButton.type = "button";
    hideButton.className = "icon-toggle";

    const volume = volumeControl(user.discordUserId);
    controls.append(muteButton, hideButton, volume.root);
    root.append(identity, controls);

    const row = {
      root,
      avatar,
      name,
      state,
      meter,
      fill,
      peak,
      readout,
      muteButton,
      hideButton,
      volume,
      peakLevel: 0,
    };
    userRows.set(user.discordUserId, row);
    return row;
  }

  function updateUserRow(row, user) {
    const disabled = false;
    const level = Math.max(0, Math.min(1, user.audioLevel ?? 0));
    row.peakLevel = Math.max(level, row.peakLevel * 0.96);

    row.root.classList.toggle("speaking", user.speaking);
    row.name.textContent = user.displayName;
    row.state.textContent = user.speaking ? "Speaking" : "Silent";

    if (user.avatarUrl) {
      row.avatar.hidden = false;
      if (row.avatar.src !== user.avatarUrl) {
        row.avatar.src = user.avatarUrl;
      }
    } else {
      row.avatar.hidden = true;
      row.avatar.removeAttribute("src");
    }

    row.meter.className = meterClass(level);
    row.meter.setAttribute("aria-label", `Level ${formatDb(level)}, peak ${formatDb(row.peakLevel)}`);
    row.fill.style.width = `${Math.round(level * 100)}%`;
    row.peak.style.left = `${Math.round(row.peakLevel * 100)}%`;
    row.readout.textContent = formatDb(level);

    configureToggleButton(
      row.muteButton,
      user.muted ? icons.speakerOff : icons.speaker,
      user.muted,
      user.muted ? "Unmute" : "Mute",
      () => {
        user.muted = !user.muted;
        updateUserRow(row, user);
        renderBulkActions();
        send({ type: "set-user", discordUserId: user.discordUserId, muted: user.muted });
      },
      disabled,
      false,
    );

    configureToggleButton(
      row.hideButton,
      user.hidden ? icons.eyeOff : icons.eye,
      user.hidden,
      user.hidden ? "Show" : "Hide",
      () => {
        user.hidden = !user.hidden;
        updateUserRow(row, user);
        renderBulkActions();
        send({ type: "set-user", discordUserId: user.discordUserId, hidden: user.hidden });
      },
      disabled,
      false,
    );

    updateVolumeControl(row.volume, user, disabled);
  }

  function iconToggle(svg, pressed, labelText, onClick, disabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-toggle";
    configureToggleButton(button, svg, pressed, labelText, onClick, disabled, false);
    return button;
  }

  function configureToggleButton(button, svg, pressed, labelText, onClick, disabled, showText) {
    button.innerHTML = `${svg}${showText ? `<span>${labelText}</span>` : ""}`;
    button.title = labelText;
    button.setAttribute("aria-label", labelText);
    button.setAttribute("aria-pressed", String(pressed));
    button.classList.toggle("active", pressed);
    setControlDisabled(button, disabled);
    button.onclick = onClick;
  }

  function volumeControl(discordUserId) {
    const container = document.createElement("div");
    container.className = "volume-control";

    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "200";
    input.step = "10";

    const value = document.createElement("span");
    value.className = "volume-value";

    const decreaseButton = document.createElement("button");
    decreaseButton.type = "button";
    decreaseButton.className = "range-nudge volume-nudge";
    decreaseButton.textContent = "-";
    decreaseButton.setAttribute("aria-label", "Decrease volume by 10%");
    decreaseButton.title = "Decrease volume by 10%";

    const increaseButton = document.createElement("button");
    increaseButton.type = "button";
    increaseButton.className = "range-nudge volume-nudge";
    increaseButton.textContent = "+";
    increaseButton.setAttribute("aria-label", "Increase volume by 10%");
    increaseButton.title = "Increase volume by 10%";

    function setVolumePercent(nextPercent, sendNow) {
      const clampedPercent = Math.max(0, Math.min(200, Math.round(nextPercent / 10) * 10));
      if (sendNow) {
        holdInputValue(input);
      }
      input.value = String(clampedPercent);
      input.title = `Volume ${clampedPercent}%`;
      value.textContent = `${clampedPercent}%`;
      const user = snapshot?.users.find((entry) => entry.discordUserId === discordUserId);
      if (user) {
        user.volume = clampedPercent / 100;
      }

      if (sendNow) {
        send({
          type: "set-user",
          discordUserId,
          volume: clampedPercent / 100,
        });
      }
    }

    input.addEventListener("input", () => {
      setVolumePercent(Number(input.value), false);
    });
    input.addEventListener("pointerdown", () => {
      input.dataset.dragging = "true";
    });
    input.addEventListener("pointerup", () => {
      delete input.dataset.dragging;
    });
    input.addEventListener("blur", () => {
      delete input.dataset.dragging;
    });
    input.addEventListener("change", () => {
      setVolumePercent(Number(input.value), true);
    });

    decreaseButton.addEventListener("click", () => {
      setVolumePercent(Number(input.value) - 10, true);
    });

    increaseButton.addEventListener("click", () => {
      setVolumePercent(Number(input.value) + 10, true);
    });

    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "icon-toggle reset-button";
    resetButton.innerHTML = icons.reset;
    resetButton.setAttribute("aria-label", "Reset volume");
    resetButton.title = "Reset volume";
    resetButton.addEventListener("click", () => {
      setVolumePercent(100, true);
    });

    container.append(decreaseButton, input, increaseButton, value, resetButton);
    return {
      root: container,
      input,
      value,
      decreaseButton,
      increaseButton,
      resetButton,
    };
  }

  function updateVolumeControl(control, user, disabled) {
    const volumePercent = Math.max(0, Math.min(200, Math.round((user.volume * 100) / 10) * 10));
    if (!isEditingInput(control.input)) {
      control.input.value = String(volumePercent);
      control.input.title = `Volume ${volumePercent}%`;
      control.value.textContent = `${volumePercent}%`;
    }

    setControlDisabled(control.input, disabled);
    setControlDisabled(control.decreaseButton, disabled);
    setControlDisabled(control.increaseButton, disabled);
    setControlDisabled(control.resetButton, disabled);
  }

  function setConnection(text, state) {
    elements.pill.textContent = text;
    elements.pill.className = `pill pill-${state}`;
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    setTimeout(() => elements.toast.classList.remove("show"), 2000);
  }

  async function copyText(text) {
    if (!text) {
      return;
    }

    await navigator.clipboard.writeText(text);
    showToast("Copied");
  }

  function clampDelay(delayMs) {
    const maxDelay = Number(elements.delaySlider.max || snapshot?.maxDelayMs || 10000);
    return Math.max(0, Math.min(maxDelay, Math.round(delayMs / 50) * 50));
  }

  function setDelayValue(delayMs, sendNow) {
    const nextDelayMs = clampDelay(delayMs);
    if (sendNow) {
      holdInputValue(elements.delaySlider);
    }
    elements.delaySlider.value = String(nextDelayMs);
    if (snapshot) {
      snapshot.defaultDelayMs = nextDelayMs;
      snapshot.delayMs = snapshot.delayEnabled === false ? 0 : nextDelayMs;
    }
    renderDelayControl();

    if (sendNow) {
      clearTimeout(delaySendTimer);
      send({ type: "set-delay", delayMs: nextDelayMs });
    }
  }

  elements.copyAudio.addEventListener("click", () => copyText(snapshot?.urls.audio));
  elements.copyOverlay.addEventListener("click", () => copyText(snapshot?.urls.overlay));
  elements.bridgeSessionToggle.addEventListener("click", sendBridgeAction);

  elements.delaySlider.addEventListener("input", () => {
    if (snapshot) {
      const nextDelayMs = clampDelay(Number(elements.delaySlider.value));
      snapshot.defaultDelayMs = nextDelayMs;
      snapshot.delayMs = snapshot.delayEnabled === false ? 0 : nextDelayMs;
    }
    renderDelayControl();
    clearTimeout(delaySendTimer);
    delaySendTimer = setTimeout(() => {
      send({ type: "set-delay", delayMs: clampDelay(Number(elements.delaySlider.value)) });
    }, 150);
  });

  elements.resetDelay.addEventListener("click", () => {
    setDelayValue(snapshot?.resetDelayMs ?? 0, true);
  });

  elements.delayMinus100.addEventListener("click", () => {
    setDelayValue(Number(elements.delaySlider.value) - 100, true);
  });

  elements.delayMinus50.addEventListener("click", () => {
    setDelayValue(Number(elements.delaySlider.value) - 50, true);
  });

  elements.delayPlus50.addEventListener("click", () => {
    setDelayValue(Number(elements.delaySlider.value) + 50, true);
  });

  elements.delayPlus100.addEventListener("click", () => {
    setDelayValue(Number(elements.delaySlider.value) + 100, true);
  });

  for (const range of document.querySelectorAll("input[type='range']")) {
    range.addEventListener("pointerdown", () => {
      range.dataset.dragging = "true";
    });
    range.addEventListener("pointerup", () => {
      delete range.dataset.dragging;
    });
    range.addEventListener("blur", () => {
      delete range.dataset.dragging;
    });
  }

  function updateRangeOutputs() {
    elements.avatarSizeOutput.textContent = `${elements.avatarSize.value}px`;
    elements.nameSizeOutput.textContent = `${elements.nameSize.value}px`;
    elements.overlayPaddingOutput.textContent = `${elements.overlayPadding.value}px`;
    elements.backgroundAlphaOutput.textContent = `${elements.backgroundAlpha.value}%`;
    elements.glowOutput.textContent = `${elements.glowIntensity.value}%`;
    elements.inactiveOpacityOutput.textContent = `${elements.inactiveOpacity.value}%`;
    elements.textStrokeWidthOutput.textContent = `${elements.textStrokeWidth.value}px`;
    elements.bubbleStrokeWidthOutput.textContent = `${elements.bubbleStrokeWidth.value}px`;
    elements.fadeMsOutput.textContent = `${elements.fadeMs.value}ms`;
  }

  function sendOverlayPatch(patch) {
    if (!snapshot) {
      return;
    }

    snapshot.overlaySettings = {
      ...snapshot.overlaySettings,
      ...patch,
    };
    renderLayoutButtons();
    renderPlacementButtons();
    renderOverlayToggles();
    updateRangeOutputs();
    send({
      type: "set-overlay",
      overlaySettings: patch,
    });
  }

  function readOverlayPatchFromControls() {
    return {
      layout: snapshot.overlaySettings.layout,
      position: snapshot.overlaySettings.position,
      growthDirection: snapshot.overlaySettings.growthDirection ?? "auto",
      showAvatars: snapshot.overlaySettings.showAvatars,
      showNames: snapshot.overlaySettings.showNames,
      testMode: snapshot.overlaySettings.testMode ?? false,
      avatarSizePx: Number(elements.avatarSize.value),
      nameFontSizePx: Number(elements.nameSize.value),
      paddingPx: Number(elements.overlayPadding.value),
      fontFamily: elements.fontSelect.value,
      bubbleShape: elements.bubbleShapeSelect.value,
      avatarPosition: elements.avatarPositionSelect.value,
      glowEnabled: snapshot.overlaySettings.glowEnabled ?? true,
      glowIntensity: Number(elements.glowIntensity.value),
      inactiveOpacity: Number(elements.inactiveOpacity.value),
      textShadow: elements.textShadowToggle.checked,
      textStroke: elements.textStrokeToggle.checked,
      textStrokeWidthPx: Number(elements.textStrokeWidth.value),
      bubbleShadow: snapshot.overlaySettings.bubbleShadow ?? true,
      bubbleStroke: snapshot.overlaySettings.bubbleStroke ?? false,
      bubbleStrokeWidthPx: Number(elements.bubbleStrokeWidth.value),
      accentColor: elements.accentColor.value,
      backgroundColor: colorWithAlpha(
        elements.backgroundColor.value,
        elements.backgroundAlpha.value,
      ),
      nameColor: elements.nameColor.value,
      fadeMs: Number(elements.fadeMs.value),
    };
  }

  function queueOverlayUpdate() {
    if (!snapshot) {
      return;
    }

    const patch = readOverlayPatchFromControls();
    snapshot.overlaySettings = {
      ...snapshot.overlaySettings,
      ...patch,
    };
    updateRangeOutputs();
    clearTimeout(overlaySendTimer);
    overlaySendTimer = setTimeout(() => {
      send({
        type: "set-overlay",
        overlaySettings: patch,
      });
    }, 100);
  }

  elements.avatarSize.addEventListener("input", queueOverlayUpdate);
  elements.nameSize.addEventListener("input", queueOverlayUpdate);
  elements.overlayPadding.addEventListener("input", queueOverlayUpdate);
  elements.fontSelect.addEventListener("change", queueOverlayUpdate);
  elements.bubbleShapeSelect.addEventListener("change", queueOverlayUpdate);
  elements.avatarPositionSelect.addEventListener("change", queueOverlayUpdate);
  elements.glowIntensity.addEventListener("input", queueOverlayUpdate);
  elements.inactiveOpacity.addEventListener("input", queueOverlayUpdate);
  elements.textStrokeWidth.addEventListener("input", queueOverlayUpdate);
  elements.bubbleStrokeWidth.addEventListener("input", queueOverlayUpdate);
  elements.accentColor.addEventListener("input", queueOverlayUpdate);
  elements.backgroundColor.addEventListener("input", queueOverlayUpdate);
  elements.backgroundAlpha.addEventListener("input", queueOverlayUpdate);
  elements.nameColor.addEventListener("input", queueOverlayUpdate);
  elements.fadeMs.addEventListener("input", queueOverlayUpdate);
  elements.resetFade.addEventListener("click", () => {
    holdInputValue(elements.fadeMs);
    elements.fadeMs.value = "0";
    elements.fadeMs.dispatchEvent(new Event("input", { bubbles: true }));
  });
  elements.textShadowToggle.addEventListener("change", () => {
    sendOverlayPatch({ textShadow: elements.textShadowToggle.checked });
  });
  elements.textStrokeToggle.addEventListener("change", () => {
    sendOverlayPatch({ textStroke: elements.textStrokeToggle.checked });
  });

  for (const button of document.querySelectorAll("[data-range-target]")) {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.rangeTarget);
      if (!input) {
        return;
      }

      holdInputValue(input);
      const delta = Number(button.dataset.rangeStep ?? input.step ?? 1);
      const min = Number(input.min || 0);
      const max = Number(input.max || 100);
      const current = Number(input.value || 0);
      input.value = String(Math.max(min, Math.min(max, current + delta)));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  for (const button of helpToggleButtons) {
    button.addEventListener("click", () => {
      const panel = document.getElementById(button.dataset.helpToggle);
      if (!panel) {
        return;
      }

      const isHidden = panel.hidden;
      panel.hidden = !isHidden;
      button.setAttribute("aria-expanded", String(isHidden));
    });
  }

  elements.resetAllVolumes.addEventListener("click", () => {
    for (const user of snapshot?.users ?? []) {
      user.volume = 1;
    }
    renderUsers();
    send({ type: "set-users", volume: 1 });
  });

  elements.themeToggle.addEventListener("click", () => {
    setColorMode(colorMode === "day" ? "night" : "day");
  });

  elements.enginePill.addEventListener("click", () => {
    const isHidden = elements.engineDetails.hidden;
    elements.engineDetails.hidden = !isHidden;
    elements.enginePill.setAttribute("aria-expanded", String(isHidden));
  });

  elements.enginePill.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    elements.enginePill.click();
  });

  if ("ResizeObserver" in window && elements.controlTitle) {
    const titleObserver = new ResizeObserver(() => fitControlTitle());
    titleObserver.observe(elements.controlTitle.closest(".control-brand") ?? elements.controlTitle);
  }

  window.addEventListener("resize", fitControlTitle);

  buildOverlayButtons();
  setupSectionReorder();
  setupCollapsibleSections();
  setupControlLocks();
  setupStaticIcons();
  setColorMode(colorMode);
  connect();
})();
