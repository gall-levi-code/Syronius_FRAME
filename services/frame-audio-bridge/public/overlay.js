(() => {
  const root = document.getElementById("overlay-root");
  const guildKey = location.pathname.split("/")[2];
  const params = new URLSearchParams(location.search);
  const obsToken = params.get("obsToken");
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const testRoster = [
    ["Mira Vale", 152],
    ["Juno Slate", 204],
    ["Kade Nova", 42],
    ["Sana Byte", 286],
    ["Riven Echo", 18],
    ["Talia Frame", 328],
    ["Owen Flux", 112],
    ["Niko Pulse", 248],
    ["Lena Signal", 72],
    ["Ash Relay", 188],
  ];
  const fontFamilies = {
    system: `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`,
    rounded: `"Trebuchet MS", "Arial Rounded MT Bold", ui-sans-serif, system-ui, sans-serif`,
    display: `Impact, "Arial Black", "Segoe UI Black", ui-sans-serif, system-ui, sans-serif`,
    condensed: `"Arial Narrow", "Roboto Condensed", "Segoe UI", ui-sans-serif, system-ui, sans-serif`,
    wide: `Verdana, "Trebuchet MS", ui-sans-serif, system-ui, sans-serif`,
    serif: `Georgia, "Times New Roman", ui-serif, serif`,
    mono: `"SFMono-Regular", Consolas, "Liberation Mono", monospace`,
  };
  const bubbleRadii = {
    pill: "999px",
    rounded: "14px",
    square: "2px",
  };

  let socket;
  let reconnectTimer;
  let reconnectDelay = 500;
  let latestSnapshot = null;
  let testUsers = [];
  let nextTestShuffleAt = 0;

  function connect() {
    const wsParams = new URLSearchParams({
      client: "overlay",
      guildKey,
    });

    if (obsToken) {
      wsParams.set("obsToken", obsToken);
    }

    socket = new WebSocket(`${scheme}//${location.host}/bridge/ws?${wsParams.toString()}`);

    socket.addEventListener("open", () => {
      reconnectDelay = 500;
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type === "overlay-state") {
        latestSnapshot = message.snapshot;
        render(message.snapshot);
      }
    });

    socket.addEventListener("close", scheduleReconnect);
    socket.addEventListener("error", () => socket.close());
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 5000);
  }

  function render(snapshot) {
    const settings = snapshot.overlaySettings;
    const users = selectUsers(snapshot, settings);
    const direction = resolveGrowthDirection(settings);

    root.className = `overlay-root position-${
      settings.position ?? "bottom-center"
    }`;
    root.style.setProperty("--fade-ms", `${settings.fadeMs ?? 0}ms`);
    root.style.setProperty("--overlay-padding", `${settings.paddingPx ?? 24}px`);
    root.style.setProperty("--avatar-size", `${settings.avatarSizePx ?? 42}px`);
    root.style.setProperty("--name-size", `${settings.nameFontSizePx ?? 18}px`);
    root.style.setProperty("--accent-color", settings.accentColor ?? "#2cb4fb");
    root.style.setProperty("--card-color", settings.backgroundColor ?? "#07111b");
    root.style.setProperty("--name-color", settings.nameColor ?? "#ffffff");
    root.style.setProperty("--inactive-opacity", `${(settings.inactiveOpacity ?? 56) / 100}`);
    root.style.setProperty(
      "--bubble-radius",
      bubbleRadii[settings.bubbleShape] ?? bubbleRadii.pill,
    );
    root.style.setProperty(
      "--bubble-stroke-width",
      settings.bubbleStroke ? `${settings.bubbleStrokeWidthPx ?? 1}px` : "0px",
    );
    root.style.setProperty("--bubble-stroke-color", settings.accentColor ?? "#2cb4fb");
    root.style.setProperty(
      "--bubble-shadow",
      settings.bubbleShadow === false
        ? "0 0 0 rgb(0 0 0 / 0)"
        : "0 10px 30px rgb(0 0 0 / 30%)",
    );
    root.style.setProperty(
      "--text-shadow",
      settings.textShadow ? "0 2px 8px rgb(0 0 0 / 75%)" : "none",
    );
    root.style.setProperty(
      "--text-stroke-width",
      settings.textStroke ? `${settings.textStrokeWidthPx ?? 1}px` : "0px",
    );
    root.style.setProperty("--text-stroke-color", settings.backgroundColor ?? "#07111b");
    root.style.setProperty(
      "--overlay-font",
      fontFamilies[settings.fontFamily] ?? fontFamilies.system,
    );
    const glowScale = settings.glowEnabled === false ? 0 : (settings.glowIntensity ?? 42) / 100;
    root.style.setProperty("--glow-size", `${52 * glowScale}px`);
    root.innerHTML = "";

    if (users.length === 0) {
      return;
    }

    const stack = document.createElement("section");
    stack.className = `speaker-stack layout-${settings.layout} flow-${direction}${
      settings.testMode ? " test-stack" : ""
    }`;
    stack.setAttribute("aria-label", "FRAME Audio Bridge speakers");

    for (const user of users) {
      stack.append(renderSpeakerCard(user, settings));
    }

    root.append(stack);
  }

  function selectUsers(snapshot, settings) {
    if (settings.testMode) {
      const users = getTestUsers();
      if (settings.layout === "active-only") {
        return [users.find((user) => user.speaking) ?? users[0]].filter(Boolean);
      }

      return users;
    }

    if (settings.layout === "persistent") {
      return snapshot.users.filter((user) => !user.hidden);
    }

    const visibleUsers = snapshot.active
      ? snapshot.users.filter((user) => user.speaking && !user.hidden)
      : [];

    if (settings.layout === "active-only" && visibleUsers.length > 0) {
      return [visibleUsers[0]];
    }

    return visibleUsers;
  }

  function renderSpeakerCard(user, settings) {
    const item = document.createElement("article");
    item.className = `speaker-card avatar-${
      settings.avatarPosition ?? "left"
    } bubble-${settings.bubbleShape ?? "pill"}${user.speaking ? " speaking" : " silent"}`;
    item.style.setProperty("--audio-level", String(user.audioLevel ?? 0));
    item.title = `${user.displayName} - ${user.speaking ? "speaking" : "silent"}`;

    if (settings.showAvatars) {
      item.append(renderAvatar(user));
    }

    if (settings.showNames) {
      const name = document.createElement("span");
      name.className = "speaker-name";
      name.textContent = user.displayName;
      item.append(name);
    }

    return item;
  }

  function renderAvatar(user) {
    if (user.avatarUrl) {
      const image = document.createElement("img");
      image.src = user.avatarUrl;
      image.alt = "";
      image.className = "speaker-avatar";
      return image;
    }

    const fallback = document.createElement("span");
    fallback.className = "speaker-avatar speaker-avatar-fallback";
    fallback.textContent = getInitials(user.displayName);
    fallback.style.setProperty("--avatar-hue", String(user.avatarHue ?? 155));
    return fallback;
  }

  function getInitials(displayName) {
    return displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("");
  }

  function getTestUsers() {
    const now = Date.now();
    if (testUsers.length > 0 && now < nextTestShuffleAt) {
      return testUsers;
    }

    nextTestShuffleAt = now + 850;
    const activeCount = 2 + Math.floor(Math.random() * 4);
    const activeIndexes = new Set();

    while (activeIndexes.size < activeCount) {
      activeIndexes.add(Math.floor(Math.random() * testRoster.length));
    }

    testUsers = testRoster.map(([displayName, avatarHue], index) => {
      const speaking = activeIndexes.has(index);
      return {
        discordUserId: `test-${index}`,
        displayName,
        avatarUrl: "",
        avatarHue,
        speaking,
        audioLevel: speaking ? 0.45 + Math.random() * 0.55 : Math.random() * 0.12,
        muted: false,
        volume: 1,
        hidden: false,
      };
    });

    return testUsers;
  }

  function resolveGrowthDirection(settings) {
    const explicit = settings.growthDirection ?? "auto";
    if (explicit !== "auto") {
      return explicit;
    }

    const position = settings.position ?? "bottom-center";
    if (settings.layout === "vertical") {
      return position.startsWith("bottom") ? "up" : "down";
    }

    if (settings.layout === "active-only") {
      return "right";
    }

    return position === "right" || position.endsWith("right") ? "left" : "right";
  }

  setInterval(() => {
    if (latestSnapshot?.overlaySettings.testMode) {
      render(latestSnapshot);
    }
  }, 850);

  connect();
})();
