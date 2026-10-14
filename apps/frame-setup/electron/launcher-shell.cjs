const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { mkdir, readFile, writeFile, rename, rm } = require("node:fs/promises");

const backendCommands = new Set([
  "detect_host", "run_preflight", "save_install_plan", "load_install_plan", "apply_install_plan",
  "get_launcher_status", "start_stack", "stop_stack", "recover_stack", "save_draft", "load_draft", "clear_draft",
  "check_updates", "update_stack", "repair_stack", "get_diagnostics", "backup_stack", "inspect_backup", "restore_backup", "remove_stack", "locate_installation",
]);
const mutations = new Set(["apply_install_plan", "start_stack", "stop_stack", "recover_stack", "update_stack", "repair_stack", "backup_stack", "restore_backup", "remove_stack"]);
const preferenceKeys = ["keepInTray", "notifications", "startAtLogin", "checkUpdatesAutomatically"];
const UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;

function launcherPaths(app, platform = process.platform, env = process.env) {
  const home = app.getPath("home");
  const managedRoot = platform === "win32"
    ? path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Syronius", "FRAME")
    : platform === "darwin" ? path.join(home, "Library", "Application Support", "Syronius", "FRAME")
    : path.join(env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share"), "syronius-frame");
  return { managedRoot, userData: path.join(managedRoot, "launcher"), defaultDataRoot: path.join(home, "FRAME Data"), legacyUserData: app.getPath("userData") };
}

async function openHttpExternal(shell, value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Only HTTP and HTTPS links can be opened.");
  await shell.openExternal(url.href);
}

async function createLauncherShell({ app, backend, Menu, Tray, Notification, nativeImage, shell, dialog,
  getWindow, reopenWindow, emit, preferencesDirectory, iconPath, appId, platform = process.platform,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, now = Date.now }) {
  const preferencesPath = path.join(preferencesDirectory, "preferences.json");
  const updateChecksPath = path.join(preferencesDirectory, "update-checks.json");
  let preferences = { keepInTray: true, notifications: true, startAtLogin: false, checkUpdatesAutomatically: false, trayReminderShown: false };
  let tray, trayConfirmed = platform !== "linux", snapshot, refreshing, operation = false, saving = false;
  let quitting = false, cleanupComplete = false, showingMessage = false, pollTimer;
  let checkingUpdates, updates, updateChecks = { lastAttemptAt: null, notified: {} };
  const startAtLoginSupported = ["win32", "darwin"].includes(platform) && app.isPackaged;
  const loginOptions = () => platform === "darwin" ? { type: "mainAppService" } : { path: app.getPath("exe"), args: [] };
  const trayAvailable = () => Boolean(tray && !tray.isDestroyed() && trayConfirmed);
  const isBusy = () => operation || saving || backend.isBusy();
  const primary = () => snapshot?.installations?.length === 1 ? snapshot.installations[0] : null;

  function showWindow() {
    if (quitting) return;
    const window = getWindow();
    if (!window || window.isDestroyed()) {
      return Promise.resolve().then(() => reopenWindow?.()).catch((error) => dialog.showErrorBox("FRAME Launcher", error.message || String(error)));
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  function showError(error) {
    showWindow();
    dialog.showErrorBox("FRAME Launcher", error.message || String(error));
  }

  function getPreferences() {
    let startAtLogin = false, startAtLoginStatus = "unsupported";
    if (startAtLoginSupported) {
      const current = app.getLoginItemSettings(loginOptions());
      startAtLogin = current.openAtLogin && current.executableWillLaunchAtLogin !== false && !["requires-approval", "not-found"].includes(current.status);
      startAtLoginStatus = current.status || (startAtLogin ? "enabled" : "not-registered");
    }
    return { ...Object.fromEntries(preferenceKeys.map((key) => [key, preferences[key]])), startAtLogin,
      startAtLoginSupported, startAtLoginStatus, trayAvailable: trayAvailable() };
  }

  async function persist(next, file = preferencesPath) {
    await mkdir(preferencesDirectory, { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }

  async function setPreferences(changes) {
    if (!changes || typeof changes !== "object" || Array.isArray(changes)
      || Object.entries(changes).some(([key, value]) => !preferenceKeys.includes(key) || typeof value !== "boolean")) {
      throw new Error("Launcher preferences must contain only supported boolean settings.");
    }
    if (saving || quitting) throw new Error("Launcher preferences are already being saved or the launcher is closing.");
    if (changes.startAtLogin === true && !startAtLoginSupported) throw new Error("Open at sign-in is available only in the installed Windows or macOS launcher.");
    saving = true;
    updateTray();
    const previous = preferences;
    try {
      const next = { ...preferences, ...changes };
      await persist(next);
      try {
        // Never register startup on launch, in development, or on Linux. This opens the launcher only.
        if (startAtLoginSupported && Object.hasOwn(changes, "startAtLogin") && getPreferences().startAtLogin !== changes.startAtLogin) {
          app.setLoginItemSettings({ ...loginOptions(), openAtLogin: changes.startAtLogin,
            ...(platform === "win32" ? { name: appId, enabled: changes.startAtLogin } : {}) });
        }
      } catch (error) {
        await persist(previous);
        throw error;
      }
      preferences = next;
      const result = getPreferences();
      emit("launcher-preferences", result);
      if (platform === "darwin" && changes.startAtLogin && !result.startAtLogin) {
        await dialog.showMessageBox(getWindow(), { type: "info", title: "Allow FRAME at sign-in",
          message: "macOS has not enabled this login item.",
          detail: "Check System Settings > General > Login Items & Extensions. If FRAME is not listed, use the signed, notarized FRAME app installed in Applications." });
      }
      return result;
    } finally {
      saving = false;
      updateTray();
      if (changes.checkUpdatesAutomatically === true) checkUpdates({}, true).catch(() => {});
    }
  }

  function updateCheckDue() {
    const current = now();
    return preferences.checkUpdatesAutomatically && (updateChecks.lastAttemptAt === null || current < updateChecks.lastAttemptAt
      || current - updateChecks.lastAttemptAt >= UPDATE_CHECK_INTERVAL);
  }

  function checkUpdates(args = {}, periodic = false) {
    if (checkingUpdates) return checkingUpdates;
    if (periodic && (!updateCheckDue() || isBusy() || refreshing || quitting)) return Promise.resolve(null);
    checkingUpdates = (async () => {
      if (refreshing) {
        try { await refreshing; }
        catch { throw new Error("Could not check for updates. Recheck FRAME status and try again."); }
      }
      if (isBusy() || quitting) throw new Error("Wait for the current FRAME operation to finish.");
      operation = true;
      updateTray();
      if (snapshot) emit("launcher-status", { ...snapshot, busy: true });
      try {
        // Persist attempts before the request so failed checks and relaunches cannot create a retry loop.
        updateChecks.lastAttemptAt = now();
        await persist(updateChecks, updateChecksPath);
        updates = await backend.invoke("check_updates", args.installRoot ? args : primary() ? { ...args, installRoot: primary().installRoot } : args);
        if (snapshot) snapshot = { ...snapshot, updates };
        emit("launcher-updates", updates);
        if (preferences.notifications && (!periodic || preferences.checkUpdatesAutomatically) && Notification.isSupported()) {
          const available = ["launcher", "frame"].filter((kind) => {
            const release = updates?.[kind];
            return release?.available && typeof release.version === "string" && release.version
              && updateChecks.notified[kind] !== `${release.version}:${release.commit || ""}`;
          });
          if (available.length) {
            for (const kind of available) updateChecks.notified[kind] = `${updates[kind].version}:${updates[kind].commit || ""}`;
            await persist(updateChecks, updateChecksPath);
            notify("FRAME updates available", `A new ${available.map((kind) => kind === "launcher" ? "launcher" : "FRAME").join(" and ")} release is available. Open FRAME Launcher to review it.`);
          }
        }
        return updates;
      } catch {
        throw new Error("Could not check for updates. Check your internet connection and try again.");
      } finally {
        operation = false;
        updateTray();
        if (snapshot) emit("launcher-status", { ...snapshot, busy: false });
      }
    })().finally(() => { checkingUpdates = null; });
    return checkingUpdates;
  }

  function notify(title, body) {
    if (!preferences.notifications || quitting || !Notification.isSupported()) return;
    try {
      const notification = new Notification({ title, body, icon: iconPath });
      notification.on("click", showWindow);
      notification.on("failed", () => emit("install-log", "Desktop notification delivery failed. FRAME status remains available in the launcher."));
      notification.show();
    } catch { emit("install-log", "Desktop notifications are unavailable. FRAME status remains available in the launcher."); }
  }

  function acceptStatus(next, announce = true) {
    const previous = snapshot;
    if (Object.hasOwn(next, "updates")) updates = next.updates;
    snapshot = updates ? { ...next, updates } : next;
    updateTray();
    emit("launcher-status", { ...snapshot, busy: isBusy() });
    if (!previous || !announce) return;
    if (previous.dockerAvailable && !next.dockerAvailable) {
      notify("Docker is unavailable", "Open FRAME Launcher to check Docker. FRAME's last state cannot be verified.");
      return;
    }
    const messages = { running: "FRAME is running", stopped: "FRAME is stopped", needs_attention: "FRAME needs attention" };
    for (const installation of next.installations) {
      const old = previous.installations.find((item) => item.installRoot === installation.installRoot);
      if (old && old.state !== installation.state && messages[installation.state]) {
        notify(messages[installation.state], "Open FRAME Launcher for the current service status.");
      }
    }
  }

  function statusUnavailable(announce) {
    if (snapshot) acceptStatus({ ...snapshot, dockerAvailable: false,
      detail: "Could not refresh FRAME status. Recheck in the launcher.", observedAt: new Date().toISOString(),
      installations: snapshot.installations.map((item) => ({ ...item, state: "needs_attention",
        detail: "Could not refresh status.", canStart: false, canStop: false, canRecover: false, canReconfigure: false })) }, announce);
  }

  async function refresh(announce = true) {
    if (refreshing) return refreshing;
    if (isBusy() || quitting) {
      if (snapshot) return { ...snapshot, busy: isBusy() };
      throw new Error("Wait for the current FRAME operation to finish.");
    }
    refreshing = (async () => {
      try {
        const result = await backend.invoke("get_launcher_status", {});
        acceptStatus(result, announce);
        return result;
      } catch (error) {
        statusUnavailable(announce);
        throw error;
      } finally { refreshing = null; updateTray(); }
    })();
    updateTray();
    return refreshing;
  }

  async function invoke(command, args = {}) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid launcher arguments.");
    if (command === "get_launcher_preferences") return getPreferences();
    if (command === "set_launcher_preferences") return setPreferences(args.preferences);
    if (command === "open_data_folder") {
      const status = await refresh();
      const installation = status.installations.find((item) => item.installRoot === args.installRoot);
      if (!installation || !path.isAbsolute(installation.dataRoot || "")) throw new Error("Choose a known FRAME installation with a configured data folder.");
      const error = await shell.openPath(installation.dataRoot);
      if (error) throw new Error(error);
      return;
    }
    if (!backendCommands.has(command)) throw new Error("Unsupported launcher command.");
    if (command === "get_launcher_status") return refresh();
    if (command === "check_updates") return checkUpdates(args);
    if (refreshing) await refreshing;
    if (isBusy() || quitting) throw new Error("Wait for the current FRAME operation to finish.");
    operation = true;
    updateTray();
    if (snapshot) emit("launcher-status", { ...snapshot, busy: true });
    try {
      const result = await backend.invoke(command, args);
      if (mutations.has(command)) {
        let status;
        try { status = result?.installations ? result : await backend.invoke("get_launcher_status", {}); }
        catch {
          statusUnavailable(false);
          notify("Check FRAME status", "The operation completed, but its current state could not be checked. Open FRAME Launcher before retrying.");
          return result;
        }
        acceptStatus(status, false);
        if (result?.protection) {
          notify(result.protection.success ? "FRAME operation completed" : "FRAME needs attention", result.protection.detail);
          return result;
        }
        const targetRoot = command === "apply_install_plan" ? (args.request || args.plan)?.installRoot || status.defaults?.installRoot : args.installRoot;
        const comparable = (root) => platform === "win32" ? path.resolve(root).toLowerCase() : path.resolve(root);
        const target = targetRoot && status.installations.find((item) => item.installRoot && comparable(item.installRoot) === comparable(targetRoot));
        const expected = command === "stop_stack" ? ["stopped"] : ["recover_stack", "update_stack", "repair_stack"].includes(command) ? ["running", "stopped"] : ["running"];
        const maintenance = result?.maintenance || status.maintenance;
        const needsAttention = !status.dockerAvailable || !target || !expected.includes(target.state);
        if (maintenance?.success === false) {
          notify(command === "update_stack" ? "FRAME update failed" : "FRAME repair failed", maintenance.recovered
            ? "The operation failed and the previous deployment was restored. Open FRAME Launcher for details."
            : "The operation failed. Open FRAME Launcher to review the result before retrying.");
        } else {
          notify(needsAttention ? "FRAME needs attention" : target.state === "stopped" ? "FRAME is stopped" : "FRAME is ready",
            needsAttention ? "The operation finished, but FRAME's expected state needs checking. Open the launcher." : "The requested operation completed. Check FRAME Launcher for details.");
        }
      }
      return result;
    } catch (error) {
      if (mutations.has(command)) {
        try { acceptStatus(await backend.invoke("get_launcher_status", {}), false); } catch { statusUnavailable(false); }
        notify("FRAME operation failed", "Open FRAME Launcher to review the result before retrying.");
      }
      throw error;
    } finally {
      operation = false;
      updateTray();
      if (snapshot) emit("launcher-status", { ...snapshot, busy: false });
    }
  }

  const action = (callback) => () => Promise.resolve().then(() => {
    trayConfirmed = true;
    emit("launcher-preferences", getPreferences());
    return callback();
  }).catch(showError);
  function updateTray() {
    if (!tray || tray.isDestroyed()) return;
    const installation = primary(), idle = !isBusy() && !refreshing && !quitting;
    try {
      tray.setToolTip(`FRAME Launcher${installation ? ` — ${installation.state.replaceAll("_", " ")}` : ""}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Launch FRAME Portal", enabled: idle && installation?.state === "running", click: action(async () => {
          const status = await refresh();
          const current = status.installations.find((item) => item.installRoot === installation.installRoot);
          if (current?.state !== "running") throw new Error("FRAME is not running. Open the launcher to check its state.");
          await openHttpExternal(shell, current.dashboardUrl);
        }) },
        { label: "Show Launcher", click: action(showWindow) },
        { type: "separator" },
        { label: "Start FRAME", enabled: idle && Boolean(installation?.canStart), click: action(() => invoke("start_stack", { installRoot: installation?.installRoot })) },
        { label: "Stop FRAME", enabled: idle && Boolean(installation?.canStop), click: action(() => invoke("stop_stack", { installRoot: installation?.installRoot })) },
        { label: "Open Data Folder", enabled: idle && Boolean(installation?.dataRoot), click: action(() => invoke("open_data_folder", { installRoot: installation?.installRoot })) },
        { type: "separator" },
        { label: "Notifications", type: "checkbox", checked: preferences.notifications, enabled: !saving && !quitting,
          click: action(() => setPreferences({ notifications: !preferences.notifications })) },
        { label: "Quit Launcher", enabled: idle, click: action(() => app.quit()) },
      ]));
    } catch (error) {
      tray.destroy(); tray = null;
      emit("launcher-preferences", getPreferences());
      showError(new Error(`The tray is unavailable. Keep using the launcher window. ${error.message}`));
    }
  }

  function busyMessage() {
    if (showingMessage) return;
    showWindow();
    showingMessage = true;
    dialog.showMessageBox(getWindow(), { type: "info", title: "FRAME Launcher is working",
      message: "Wait for the current check, installation, or recovery to finish before closing FRAME Launcher." })
      .catch(showError).finally(() => { showingMessage = false; });
  }

  function onClose(event) {
    if (quitting) return;
    if (isBusy()) { event.preventDefault(); busyMessage(); return; }
    if (!preferences.keepInTray || !trayAvailable()) return;
    event.preventDefault();
    if (showingMessage) return;
    if (preferences.trayReminderShown) { getWindow().hide(); return; }
    showingMessage = true;
    saving = true;
    updateTray();
    dialog.showMessageBox(getWindow(), { type: "info", title: platform === "darwin" ? "FRAME Launcher stays in the menu bar" : "FRAME Launcher stays in the tray",
      message: platform === "darwin" ? "Use the FRAME menu-bar or Dock icon to reopen the launcher." : "Use the FRAME tray icon to reopen the launcher.",
      detail: "Quit Launcher exits this application without stopping FRAME. Use Stop FRAME when you want to stop its services." })
      .then(async () => {
        preferences = { ...preferences, trayReminderShown: true };
        await persist(preferences);
        saving = false;
        if (!quitting && !isBusy() && trayAvailable()) getWindow().hide();
      }).catch(showError).finally(() => { showingMessage = false; saving = false; updateTray(); });
  }

  function beforeQuit(event) {
    if (cleanupComplete) return;
    event.preventDefault();
    if (quitting) return;
    if (isBusy()) { busyMessage(); return; }
    quitting = true;
    clearIntervalImpl(pollTimer);
    if (tray && !tray.isDestroyed()) tray.destroy();
    backend.dispose().catch(showError).finally(() => { cleanupComplete = true; app.quit(); });
  }

  try {
    const stored = JSON.parse(await readFile(preferencesPath, "utf8"));
    if (!stored || typeof stored !== "object" || Array.isArray(stored)
      || [...preferenceKeys, "trayReminderShown"].some((key) => Object.hasOwn(stored, key) && typeof stored[key] !== "boolean")) throw new Error("Invalid saved preferences.");
    for (const key of [...preferenceKeys, "trayReminderShown"]) if (Object.hasOwn(stored, key)) preferences[key] = stored[key];
  } catch (error) { if (error.code !== "ENOENT") showError(new Error(`Could not read launcher preferences. ${error.message}`)); }
  try {
    const stored = JSON.parse(await readFile(updateChecksPath, "utf8"));
    if (Number.isFinite(stored?.lastAttemptAt) && stored.lastAttemptAt >= 0) updateChecks.lastAttemptAt = stored.lastAttemptAt;
    for (const kind of ["launcher", "frame"]) {
      if (typeof stored?.notified?.[kind] === "string" && stored.notified[kind].length <= 256) updateChecks.notified[kind] = stored.notified[kind];
    }
  } catch { /* Optional check history cannot prevent the launcher from opening. */ }

  try {
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("The launcher icon could not be loaded.");
    const trayIcon = icon.resize({ width: platform === "darwin" ? 18 : 24, height: platform === "darwin" ? 18 : 24 });
    if (platform === "darwin") trayIcon.setTemplateImage(true);
    tray = new Tray(trayIcon);
    tray.on("click", action(showWindow));
    updateTray();
  } catch (error) { tray = null; showError(new Error(`The tray is unavailable. Keep using the launcher window. ${error.message}`)); }
  if (platform === "darwin") {
    app.on("activate", showWindow);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: "FRAME Launcher", submenu: [{ role: "about" }, { type: "separator" }, { role: "services" },
        { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" },
        { type: "separator" }, { role: "quit", label: "Quit Launcher" }] },
      { label: "File", submenu: [{ label: "Show Launcher", accelerator: "CmdOrCtrl+1", click: action(showWindow) }, { role: "close" }] },
      { role: "editMenu" }, { role: "windowMenu" },
    ]));
  }
  pollTimer = setIntervalImpl(() => {
    if (isBusy() || refreshing || quitting) return;
    if (updateCheckDue()) return checkUpdates({}, true).catch(() => {});
    return refresh().catch((error) => emit("install-log", error.message));
  }, 15_000);
  pollTimer.unref?.();

  return { invoke, refresh, onClose, beforeQuit, showWindow, getPreferences, isBusy };
}

module.exports = { createLauncherShell, launcherPaths, openHttpExternal };
