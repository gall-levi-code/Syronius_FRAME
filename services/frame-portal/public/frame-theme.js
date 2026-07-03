(() => {
  const THEME_MODE_KEY = "frame-theme";
  const LEGACY_PORTAL_THEME_KEY = "frame-portal-theme";
  const THEME_PROFILE_ID_KEY = "frame-theme-profile-id";
  const THEME_PROFILE_KEY = "frame-theme-profile";
  const THEME_CUSTOM_PROFILES_KEY = "frame-theme-custom-profiles";
  const THEME_API_PATHS = ["/api/theme", "/api/portal/theme"];
  const COMPAT_THEME_KEYS = ["frame-gallery-theme-mode", "frame-audio-bridge-color-mode"];
  const aliases = {
    page: ["page", "bg", "background"],
    panel: ["panel", "topbar"],
    panelStrong: ["panel-2", "surface", "surface-strong", "control"],
    panelMuted: ["panel-muted", "queue"],
    border: ["border", "line"],
    borderSoft: ["border-soft"],
    label: ["label", "muted"],
    text: ["text", "control-text"],
    accent: ["accent"],
    accentStrong: ["accent-strong"],
    accentSoft: ["accent-soft"],
    accentBorder: ["accent-border"],
    accentContrast: ["accent-contrast", "action-text"],
    danger: ["danger", "bad"],
    warning: ["warning", "warn"],
    good: ["good"],
    toggleNightBg: ["toggle-night-bg"],
    toggleNightText: ["toggle-night-text"],
    toggleDayBg: ["toggle-day-bg"],
    toggleDayText: ["toggle-day-text"],
  };
  const defaultProfile = {
    id: "frame-blue",
    name: "Frame Blue",
    themeColor: "#2cb4fb",
    custom: false,
    palettes: {
      day: {
        page: "#eef7fc", panel: "#ffffff", panelStrong: "#e4f4fc", panelMuted: "#f5fbfe",
        border: "#b8d9ea", borderSoft: "#8dc4df", label: "#526d7e", text: "#132634",
        accent: "#087fbd", accentStrong: "#087fbd", accentSoft: "#d8f1fd", accentBorder: "#2cb4fb",
        accentContrast: "#073d5f", danger: "#ad2f45", warning: "#9d6d0c", good: "#20804b",
        toggleNightBg: "#dff4ff", toggleNightText: "#087fc0", toggleDayBg: "#fff6d5", toggleDayText: "#8a5e00",
      },
      night: {
        page: "#07111b", panel: "#0d1824", panelStrong: "#122235", panelMuted: "#101c2a",
        border: "#20364b", borderSoft: "#2a4056", label: "#91a6bb", text: "#f5f7fb",
        accent: "#2cb4fb", accentStrong: "#74d1ff", accentSoft: "#082f49", accentBorder: "#1a85c0",
        accentContrast: "#d9f3ff", danger: "#ff7890", warning: "#ffd36e", good: "#6ee7a4",
        toggleNightBg: "#dff4ff", toggleNightText: "#087fc0", toggleDayBg: "#fff6d5", toggleDayText: "#8a5e00",
      },
    },
  };

  let state = readCachedState() || defaultState();
  let lastSignature = "";
  let refreshTimer = 0;

  window.FrameTheme = {
    apply,
    getState: () => state,
    load,
    save,
    saveMode: (mode) => save({ mode }),
    start,
  };

  apply(state, { persist: false, notify: false });
  start();

  function start(intervalMs = 5000) {
    if (!refreshTimer) {
      load();
      refreshTimer = window.setInterval(load, Math.max(2000, intervalMs));
    }
  }

  function apply(nextModeOrState, options = {}) {
    const next = typeof nextModeOrState === "string" ? { ...state, mode: nextModeOrState } : nextModeOrState;
    state = normalizeState(next);
    const mode = state.mode === "day" ? "day" : "night";
    const palette = state.profile?.palettes?.[mode] || defaultProfile.palettes[mode];
    const root = document.documentElement;
    root.dataset.theme = mode;
    root.dataset.themeMode = mode;
    root.style.colorScheme = mode === "day" ? "light" : "dark";
    for (const [name, color] of Object.entries(palette)) {
      const cssKey = kebab(name);
      root.style.setProperty(`--frame-${cssKey}`, color);
      (aliases[name] || []).forEach((alias) => root.style.setProperty(`--${alias}`, color));
    }
    document.body?.classList.toggle("theme-day", mode === "day");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", palette.page || palette.background || "#07111b");
    if (options.persist !== false) writeCache(state);
    const signature = JSON.stringify([state.mode, state.profileId, state.profile?.id, state.updated_at]);
    if (options.notify !== false && signature !== lastSignature) {
      lastSignature = signature;
      dispatchStorage(THEME_PROFILE_KEY, JSON.stringify(state.profile));
      dispatchStorage(THEME_MODE_KEY, state.mode);
      window.dispatchEvent(new CustomEvent("frame-theme-change", { detail: state }));
    }
    return state;
  }

  async function load() {
    try {
      const payload = await requestTheme({ headers: { Accept: "application/json" }, cache: "no-store" });
      return apply(payload.theme || payload);
    } catch {
      return state;
    }
  }

  async function save(next) {
    const draft = normalizeState({ ...state, ...next, updated_at: new Date().toISOString() });
    apply(draft);
    try {
      const payload = await requestTheme({
        method: "PUT",
        headers: { "content-type": "application/json", Accept: "application/json" },
        body: JSON.stringify(draft),
      });
      return apply(payload.theme || payload);
    } catch {
      return draft;
    }
  }

  async function requestTheme(options) {
    let response = null;
    for (const path of THEME_API_PATHS) {
      response = await fetch(path, options);
      if (response.status !== 404) break;
    }
    if (!response?.ok) throw new Error(`Theme request failed: ${response?.status || "unknown"}`);
    return response.json();
  }

  function normalizeState(value) {
    const profile = normalizeProfile(value?.profile) || defaultProfile;
    return {
      mode: value?.mode === "day" ? "day" : "night",
      profileId: cleanText(value?.profileId, profile.id),
      customProfiles: Array.isArray(value?.customProfiles) ? value.customProfiles.map(normalizeProfile).filter(Boolean) : [],
      profile,
      updated_at: cleanText(value?.updated_at, new Date(0).toISOString()),
    };
  }

  function normalizeProfile(value) {
    if (!value || typeof value !== "object" || !value.palettes?.day || !value.palettes?.night) return null;
    return {
      id: cleanText(value.id, defaultProfile.id),
      name: cleanText(value.name, "Custom Theme"),
      themeColor: cleanText(value.themeColor, defaultProfile.themeColor),
      custom: value.custom === true,
      palettes: value.palettes,
    };
  }

  function defaultState() {
    return { mode: "night", profileId: defaultProfile.id, customProfiles: [], profile: defaultProfile, updated_at: new Date(0).toISOString() };
  }

  function readCachedState() {
    try {
      const profile = JSON.parse(localStorage.getItem(THEME_PROFILE_KEY) || "null");
      const stored = localStorage.getItem(THEME_MODE_KEY)
        || localStorage.getItem(LEGACY_PORTAL_THEME_KEY)
        || COMPAT_THEME_KEYS.map((key) => localStorage.getItem(key)).find(Boolean);
      if (profile?.palettes || stored === "day" || stored === "night") {
        return {
          mode: stored === "day" ? "day" : "night",
          profileId: localStorage.getItem(THEME_PROFILE_ID_KEY) || profile?.id || defaultProfile.id,
          customProfiles: JSON.parse(localStorage.getItem(THEME_CUSTOM_PROFILES_KEY) || "[]"),
          profile: profile?.palettes ? profile : defaultProfile,
        };
      }
    } catch {}
    return null;
  }

  function writeCache(next) {
    try {
      localStorage.setItem(THEME_MODE_KEY, next.mode);
      localStorage.setItem(THEME_PROFILE_ID_KEY, next.profileId);
      localStorage.setItem(THEME_PROFILE_KEY, JSON.stringify(next.profile));
      localStorage.setItem(THEME_CUSTOM_PROFILES_KEY, JSON.stringify(next.customProfiles));
    } catch {}
  }

  function kebab(value) {
    return String(value).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  }

  function cleanText(value, fallback) {
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : fallback;
  }

  function dispatchStorage(key, newValue) {
    try {
      window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
    } catch {
      window.dispatchEvent(new CustomEvent("storage", { detail: { key, newValue } }));
    }
  }
})();
