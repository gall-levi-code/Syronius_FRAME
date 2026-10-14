import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createLauncherShell, launcherPaths, openHttpExternal } = require("../apps/frame-setup/electron/launcher-shell.cjs");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const closeEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

async function fixture(t, options = {}) {
  const directory = options.directory || await mkdtemp(path.join(os.tmpdir(), "frame-shell-"));
  if (!options.directory) t.after(() => rm(directory, { recursive: true, force: true }));
  if (options.preferences) await writeFile(path.join(directory, "preferences.json"), JSON.stringify(options.preferences));
  const calls = [], startup = [], notifications = [], errors = [], messages = [], events = [], trays = [], urls = [], folders = [];
  let busy = false, loginEnabled = false, controller, poll, disposed = 0, exited = 0, reopened = 0, applicationMenu;
  let clock = options.now ?? Date.UTC(2026, 9, 1);
  const window = { hidden: false, focused: false, minimized: false, destroyed: false, isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized; }, restore() { this.minimized = false; },
    show() { this.hidden = false; }, hide() { this.hidden = true; }, focus() { this.focused = true; } };
  const app = Object.assign(new EventEmitter(), { isPackaged: options.packaged ?? true,
    getPath: (name) => name === "exe" ? path.join(directory, "FRAME Setup.exe") : directory,
    getLoginItemSettings: () => ({ openAtLogin: loginEnabled, executableWillLaunchAtLogin: loginEnabled,
      ...(options.loginStatus ? { status: options.loginStatus } : {}) }),
    setLoginItemSettings: (value) => { startup.push(value); loginEnabled = value.openAtLogin; },
    quit() { const event = closeEvent(); controller.beforeQuit(event); if (!event.prevented) exited++; } });
  let status;
  function setState(state, extra = {}) {
    status = { installations: [{ installRoot: path.join(directory, "installation"), dataRoot: path.join(directory, "media"),
      dashboardUrl: "http://localhost:18080/dashboard", state, detail: "", version: "test", services: [],
      canStart: state === "stopped", canStop: state === "running", canRecover: state === "needs_attention", canReconfigure: true,
      ...extra }], dockerAvailable: state !== "docker_unavailable", detail: "", observedAt: "now", defaults: { installRoot: path.join(directory, "installation") } };
  }
  setState(options.state || "running");
  const backend = { isBusy: () => busy,
    async invoke(command, args) {
      calls.push({ command, args });
      if (options.invoke) { const result = await options.invoke(command, args); if (result !== undefined) return result; }
      if (command === "start_stack") setState("running");
      if (command === "stop_stack") setState("stopped");
      if (command === "recover_stack") setState("running");
      return structuredClone(status);
    }, async dispose() { disposed++; } };
  class FakeTray extends EventEmitter {
    constructor(icon) { super(); if (options.trayFailure) throw new Error("No tray host"); trays.push(this); this.destroyed = false; this.icon = icon; }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(menu) { if (options.menuFailure) throw new Error("Menu unavailable"); this.menu = menu; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  class FakeNotification extends EventEmitter {
    static isSupported() { return true; }
    constructor(value) { super(); this.value = value; }
    show() { notifications.push(this.value); }
  }
  controller = await createLauncherShell({ app, backend, Menu: { buildFromTemplate: (value) => value, setApplicationMenu: (value) => { applicationMenu = value; } }, Tray: FakeTray,
    Notification: FakeNotification, nativeImage: { createFromPath: () => ({ isEmpty: () => false,
      resize(size) { this.size = size; return this; }, setTemplateImage(value) { this.template = value; } }) },
    shell: { openExternal: async (value) => urls.push(value), openPath: async (value) => { folders.push(value); return options.openPathError || ""; } },
    dialog: { showErrorBox: (title, message) => errors.push({ title, message }),
      showMessageBox: async (_window, value) => { messages.push(value); return { response: 0 }; } },
    getWindow: () => window, reopenWindow: async () => { reopened++; window.destroyed = false; window.show(); },
    emit: (event, payload) => events.push({ event, payload }), preferencesDirectory: directory,
    iconPath: "existing.png", appId: "us.syroni.frame.setup", platform: options.platform || "win32",
    now: () => clock,
    setIntervalImpl: (callback, delay) => { assert.equal(delay, 15_000); poll = callback; return { unref() {} }; }, clearIntervalImpl: () => { poll = null; },
  });
  return { controller, directory, calls, startup, notifications, errors, messages, events, trays, urls, folders, window, app,
    setState, setBusy: (value) => { busy = value; }, poll: () => poll?.(), disposed: () => disposed, exited: () => exited,
    reopened: () => reopened, applicationMenu: () => applicationMenu,
    advance: (milliseconds) => { clock += milliseconds; }, now: () => clock,
    click: (label) => trays.at(-1).menu.find((item) => item.label === label).click(),
    menu: (label) => trays.at(-1).menu.find((item) => item.label === label) };
}

test("launcher paths keep Chromium identity while choosing managed runtime and nonsynced media defaults", () => {
  const home = path.resolve("home"), legacy = path.resolve("old-profile"), local = path.resolve("local-appdata"), xdg = path.resolve("xdg-data");
  const app = { getPath: (name) => name === "home" ? home : legacy };
  const windows = launcherPaths(app, "win32", { LOCALAPPDATA: local });
  assert.equal(windows.managedRoot, path.join(local, "Syronius", "FRAME"));
  assert.equal(windows.userData, path.join(windows.managedRoot, "launcher"));
  assert.equal(windows.defaultDataRoot, path.join(home, "FRAME Data"));
  assert.equal(windows.legacyUserData, legacy);
  assert.equal(launcherPaths(app, "linux", { XDG_DATA_HOME: xdg }).managedRoot, path.join(xdg, "syronius-frame"));
  assert.equal(launcherPaths(app, "linux", { XDG_DATA_HOME: "relative" }).managedRoot, path.join(home, ".local/share/syronius-frame"));
  assert.equal(launcherPaths(app, "darwin", { XDG_DATA_HOME: xdg }).managedRoot, path.join(home, "Library/Application Support/Syronius/FRAME"));
});

test("preferences persist privately and Windows startup changes only on an explicit supported preference", async (t) => {
  const f = await fixture(t);
  assert.equal(f.controller.getPreferences().startAtLogin, false);
  assert.deepEqual(f.startup, [], "starting the app must not change Windows login registration");
  await f.controller.invoke("set_launcher_preferences", { preferences: { notifications: false } });
  assert.deepEqual(f.startup, []);
  const result = await f.controller.invoke("set_launcher_preferences", { preferences: { startAtLogin: true } });
  assert.equal(result.startAtLogin, true);
  assert.equal(f.startup[0].name, "us.syroni.frame.setup");
  assert.deepEqual(f.startup[0].args, [], "opening at sign-in must not start the FRAME stack");
  assert.match(f.startup[0].path, /FRAME Setup\.exe$/);
  await f.controller.invoke("set_launcher_preferences", { preferences: { startAtLogin: false, keepInTray: false } });
  assert.equal(f.startup[1].openAtLogin, false);
  const stored = JSON.parse(await readFile(path.join(f.directory, "preferences.json"), "utf8"));
  assert.equal(stored.notifications, false);
  assert.equal(stored.keepInTray, false);
  assert.equal(f.events.at(-1).event, "launcher-preferences");
  if (process.platform !== "win32") assert.equal((await stat(path.join(f.directory, "preferences.json"))).mode & 0o777, 0o600);
  await assert.rejects(f.controller.invoke("set_launcher_preferences", { preferences: { notifications: "yes" } }), /boolean/);
  await assert.rejects(f.controller.invoke("set_launcher_preferences", { preferences: { arbitrary: true } }), /boolean/);
  assert.equal(f.calls.length, 0, "preferences never invoke container commands");
  for (const settings of [{ platform: "linux" }, { packaged: false }, { platform: "darwin", packaged: false }]) {
    const unsupported = await fixture(t, settings);
    assert.equal(unsupported.controller.getPreferences().startAtLoginSupported, false);
    await assert.rejects(unsupported.controller.invoke("set_launcher_preferences", { preferences: { startAtLogin: true } }), /installed Windows or macOS/);
    assert.deepEqual(unsupported.startup, []);
  }
});

test("macOS uses native login items, template icons, Dock reopening and explicit quit without changing FRAME", async (t) => {
  const f = await fixture(t, { platform: "darwin" });
  assert.deepEqual(f.startup, [], "launching never registers a login item");
  assert.equal(f.controller.getPreferences().startAtLoginSupported, true);
  assert.equal(f.trays[0].icon.template, true, "the transparent existing logo follows menu-bar appearance");
  assert.deepEqual(f.trays[0].icon.size, { width: 18, height: 18 });
  assert.equal(f.applicationMenu()[0].submenu.at(-1).role, "quit");
  const enabled = await f.controller.invoke("set_launcher_preferences", { preferences: { startAtLogin: true, keepInTray: false } });
  assert.equal(enabled.startAtLogin, true);
  assert.deepEqual(f.startup, [{ type: "mainAppService", openAtLogin: true }], "no Windows-only registry options on macOS");
  const closed = closeEvent(); f.controller.onClose(closed);
  assert.equal(closed.prevented, false, "standard close can destroy the window while the Mac app remains in the Dock");
  f.window.destroyed = true;
  f.app.emit("activate"); await tick();
  assert.equal(f.reopened(), 1);
  assert.equal(f.window.hidden, false);
  await f.controller.invoke("set_launcher_preferences", { preferences: { keepInTray: true } });
  const hidden = closeEvent(); f.controller.onClose(hidden);
  while (f.controller.isBusy()) await tick();
  assert.equal(hidden.prevented, true);
  assert.equal(f.window.hidden, true);
  assert.match(f.messages.at(-1).message, /Dock/);
  f.app.emit("activate");
  assert.equal(f.window.hidden, false);
  await f.click("Quit Launcher"); await tick();
  f.app.emit("activate"); await tick();
  assert.equal(f.exited(), 1);
  assert.equal(f.reopened(), 1, "activation cannot reopen a quitting launcher");
  assert.equal(f.calls.length, 0, "login, close, Dock and quit never change the stack");
  const pending = await fixture(t, { platform: "darwin", loginStatus: "requires-approval" });
  const result = await pending.controller.invoke("set_launcher_preferences", { preferences: { startAtLogin: true } });
  assert.equal(result.startAtLogin, false);
  assert.equal(result.startAtLoginStatus, "requires-approval");
  assert.match(pending.messages[0].detail, /System Settings/);
});

test("tray routes through the shared backend and opens only verified URLs and configured data paths", async (t) => {
  const f = await fixture(t, { state: "stopped" });
  const status = await f.controller.refresh();
  assert.equal(f.menu("Start FRAME").enabled, true);
  assert.equal(f.menu("Stop FRAME").enabled, false);
  assert.equal(f.menu("Launch FRAME Portal").enabled, false);
  await f.click("Start FRAME");
  assert.deepEqual(f.calls.at(-1), { command: "start_stack", args: { installRoot: status.installations[0].installRoot } });
  assert.equal(f.menu("Launch FRAME Portal").enabled, true);
  await f.click("Launch FRAME Portal");
  assert.deepEqual(f.urls, ["http://localhost:18080/dashboard"]);
  await f.controller.invoke("open_data_folder", { installRoot: status.installations[0].installRoot, dataRoot: path.parse(f.directory).root });
  assert.deepEqual(f.folders, [status.installations[0].dataRoot], "renderer dataRoot is ignored");
  await assert.rejects(f.controller.invoke("open_data_folder", { installRoot: path.parse(f.directory).root }), /known FRAME/);
  await assert.rejects(f.controller.invoke("run_arbitrary_command", {}), /Unsupported/);
  await assert.rejects(f.controller.invoke("start_stack", []), /Invalid/);
  await f.click("Stop FRAME");
  assert.equal(f.calls.at(-1).command, "stop_stack");
  assert.equal(f.menu("Start FRAME").enabled, true);
  for (const url of ["file:///etc/passwd", "https://user:secret@example.com/"]) {
    await assert.rejects(openHttpExternal({ openExternal: () => assert.fail("unsafe URL opened") }, url), /HTTP and HTTPS/);
  }
});

test("close hides once explained, explicit quit disposes without stopping FRAME, and busy work blocks both", async (t) => {
  const f = await fixture(t);
  await f.controller.refresh();
  f.setBusy(true);
  const busyClose = closeEvent(); f.controller.onClose(busyClose);
  assert.equal(busyClose.prevented, true);
  await tick();
  const busyQuit = closeEvent(); f.controller.beforeQuit(busyQuit);
  assert.equal(busyQuit.prevented, true);
  assert.equal(f.disposed(), 0);
  f.setBusy(false); await tick();
  const firstClose = closeEvent(); f.controller.onClose(firstClose);
  assert.equal(firstClose.prevented, true);
  while (f.controller.isBusy()) await tick();
  assert.equal(f.window.hidden, true);
  const reminders = f.messages.filter((item) => item.title === "FRAME Launcher stays in the tray");
  assert.equal(reminders.length, 1);
  await f.click("Show Launcher");
  assert.equal(f.window.hidden, false);
  f.controller.onClose(closeEvent());
  assert.equal(f.window.hidden, true);
  assert.equal(f.messages.filter((item) => item.title === reminders[0].title).length, 1);
  await f.click("Quit Launcher"); await tick();
  assert.equal(f.disposed(), 1);
  assert.equal(f.exited(), 1);
  assert.equal(f.trays[0].isDestroyed(), true);
  assert.equal(f.calls.some((item) => item.command === "stop_stack"), false);
  const finalClose = closeEvent(); f.controller.onClose(finalClose);
  assert.equal(finalClose.prevented, false, "quit must bypass hide-on-close");
});

test("Linux needs a reachable tray before hiding, tray failure keeps the window usable, and keepInTray can be disabled", async (t) => {
  const linux = await fixture(t, { platform: "linux" });
  assert.equal(linux.controller.getPreferences().trayAvailable, false);
  const unconfirmed = closeEvent(); linux.controller.onClose(unconfirmed);
  assert.equal(unconfirmed.prevented, false);
  await linux.click("Show Launcher");
  assert.equal(linux.controller.getPreferences().trayAvailable, true);
  await linux.controller.invoke("set_launcher_preferences", { preferences: { keepInTray: false } });
  const disabled = closeEvent(); linux.controller.onClose(disabled);
  assert.equal(disabled.prevented, false);
  for (const failure of [{ trayFailure: true }, { menuFailure: true }]) {
    const unavailable = await fixture(t, { platform: "linux", ...failure });
    const event = closeEvent(); unavailable.controller.onClose(event);
    assert.equal(event.prevented, false);
    assert.equal(unavailable.window.hidden, false);
    assert.match(unavailable.errors[0].message, /tray is unavailable/);
  }
});

test("status polling is quiet initially, deduplicates transitions, respects busy/notifications, and reports action failures once", async (t) => {
  const f = await fixture(t);
  await f.controller.refresh();
  await f.controller.refresh();
  assert.equal(f.notifications.length, 0);
  f.setState("needs_attention"); await f.controller.refresh(); await f.controller.refresh();
  assert.equal(f.notifications.length, 1);
  f.setState("docker_unavailable"); await f.controller.refresh(); await f.controller.refresh();
  assert.equal(f.notifications.length, 2);
  await f.controller.invoke("set_launcher_preferences", { preferences: { notifications: false } });
  f.setState("running"); await f.controller.refresh();
  assert.equal(f.notifications.length, 2);
  f.setBusy(true); const previous = f.calls.length; f.poll(); await tick();
  assert.equal(f.calls.length, previous);
  f.setBusy(false); f.poll(); await tick();
  assert.equal(f.calls.length, previous + 1);
  const failure = await fixture(t, { state: "stopped", invoke: async (command) => { if (command === "start_stack") throw new Error("safe failure"); } });
  await failure.controller.refresh();
  await failure.click("Start FRAME");
  assert.equal(failure.notifications.length, 1);
  assert.equal(failure.notifications[0].title, "FRAME operation failed");
  assert.equal(failure.errors.length, 1);
  await failure.controller.refresh();
  assert.equal(failure.notifications.length, 1);
});

test("mutation notifications use the applied plan or default root and preserve success when a later status check fails", async (t) => {
  let failStatus = false;
  const result = { path: "saved-plan.json", dashboardUrl: "http://localhost:18080/dashboard", logs: ["Applied"] };
  const f = await fixture(t, { invoke: async (command) => {
    if (command === "apply_install_plan") return result;
    if (command === "get_launcher_status" && failStatus) throw new Error("Status unavailable");
  } });
  const status = await f.controller.refresh();
  for (const args of [{ request: {} }, { plan: { installRoot: status.installations[0].installRoot } }]) {
    assert.deepEqual(await f.controller.invoke("apply_install_plan", args), result);
    assert.equal(f.notifications.at(-1).title, "FRAME is ready");
  }
  failStatus = true;
  assert.deepEqual(await f.controller.invoke("apply_install_plan", { request: {} }), result);
  assert.equal(f.notifications.at(-1).title, "Check FRAME status");
  assert.equal(f.menu("Stop FRAME").enabled, false, "an unverified snapshot cannot enable lifecycle actions");
  const partial = await fixture(t, { state: "stopped", invoke: async (command) => {
    if (command === "start_stack") return { ...status, installations: status.installations.map((item) => ({ ...item, state: "stopped" })) };
  } });
  await partial.controller.invoke("start_stack", { installRoot: status.installations[0].installRoot });
  assert.equal(partial.notifications.at(-1).title, "FRAME needs attention");
});

test("a repeated lifecycle request is rejected instead of queued after an active operation", async (t) => {
  let releaseStart;
  const f = await fixture(t, { state: "stopped", invoke: (command) => {
    if (command === "start_stack") return new Promise((resolve) => { releaseStart = resolve; });
  } });
  const status = await f.controller.refresh(), args = { installRoot: status.installations[0].installRoot };
  const first = f.controller.invoke("start_stack", args);
  await tick();
  await assert.rejects(f.controller.invoke("start_stack", args), /current FRAME operation/);
  await assert.rejects(f.controller.invoke("stop_stack", args), /current FRAME operation/);
  assert.equal((await f.controller.invoke("get_launcher_status")).busy, true);
  assert.equal(f.menu("Start FRAME").enabled, false);
  releaseStart({ ...status, installations: status.installations.map((item) => ({ ...item, state: "running", canStart: false, canStop: true })) });
  await first;
  assert.equal(f.calls.filter((call) => call.command === "start_stack").length, 1);
  assert.equal(f.calls.some((call) => call.command === "stop_stack"), false);
});

test("preload exposes only allowlisted event payloads and removes the exact listener", async () => {
  let api;
  const listeners = new Map();
  const source = await readFile(new URL("../apps/frame-setup/electron/preload.cjs", import.meta.url), "utf8");
  vm.runInNewContext(source, { require: () => ({
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, "frameDesktop"); api = value; } },
    ipcRenderer: { invoke: () => {}, on: (name, listener) => listeners.set(name, listener),
      removeListener: (name, listener) => { assert.equal(listeners.get(name), listener); listeners.delete(name); } },
  }) });
  for (const name of ["install-log", "launcher-status", "launcher-preferences", "launcher-progress", "launcher-updates"]) {
    let received;
    const unsubscribe = api.listen(name, (value) => { received = value; });
    listeners.get(`frame:${name}`)({ privileged: true }, "payload");
    assert.equal(received.payload, "payload");
    assert.equal(received.privileged, undefined);
    unsubscribe();
  }
  assert.throws(() => api.listen("arbitrary", () => {}), /Unsupported/);
  assert.equal(listeners.size, 0);
});

const day = 24 * 60 * 60 * 1000;
const availableUpdates = (version = "1.2.0") => ({ checkedAt: "2026-10-01T00:00:00Z", installRoot: "/frame",
  launcher: { currentVersion: "1.0.0", version, available: true, notes: "Stable release", url: "https://github.com/example/releases/v1.2.0" },
  frame: { currentVersion: "1.0.0", currentCommit: "a".repeat(40), version, commit: "b".repeat(40), available: true, eligible: true } });

test("automatic update checks default off, run daily while open, persist attempts across relaunch, and stop when disabled", async (t) => {
  const invoke = async (command) => command === "check_updates" ? availableUpdates() : undefined;
  const f = await fixture(t, { invoke });
  assert.equal(f.controller.getPreferences().checkUpdatesAutomatically, false);
  await f.poll(); f.advance(day); await f.poll();
  assert.equal(f.calls.filter((call) => call.command === "check_updates").length, 0);
  await f.controller.invoke("set_launcher_preferences", { preferences: { checkUpdatesAutomatically: true } });
  while (f.controller.isBusy()) await tick();
  assert.equal(f.calls.filter((call) => call.command === "check_updates").length, 1);
  assert.deepEqual(f.events.find((event) => event.event === "launcher-updates").payload, availableUpdates());
  assert.deepEqual((await f.controller.refresh()).updates, undefined, "backend fixture does not itself cache updates");
  assert.deepEqual(f.events.filter((event) => event.event === "launcher-status").at(-1).payload.updates, availableUpdates());
  const historyPath = path.join(f.directory, "update-checks.json");
  const saved = JSON.parse(await readFile(historyPath, "utf8"));
  assert.equal(saved.lastAttemptAt, f.now());
  assert.equal(Object.hasOwn(f.controller.getPreferences(), "lastAttemptAt"), false);
  if (process.platform !== "win32") assert.equal((await stat(historyPath)).mode & 0o777, 0o600);
  f.advance(day - 1); await f.poll();
  assert.equal(f.calls.filter((call) => call.command === "check_updates").length, 1);
  const reopened = await fixture(t, { directory: f.directory, now: f.now(), invoke });
  await reopened.poll();
  assert.equal(reopened.calls.some((call) => call.command === "check_updates"), false);
  reopened.advance(1); await reopened.poll();
  assert.equal(reopened.calls.filter((call) => call.command === "check_updates").length, 1);
  assert.equal(reopened.notifications.length, 0, "same release identities never notify again after relaunch");
  await reopened.controller.invoke("set_launcher_preferences", { preferences: { checkUpdatesAutomatically: false } });
  reopened.advance(day * 3); await reopened.poll();
  assert.equal(reopened.calls.filter((call) => call.command === "check_updates").length, 1);
});

test("a backward clock adjustment permits one new attempt and resets the daily interval", async (t) => {
  const f = await fixture(t, { preferences: { checkUpdatesAutomatically: true }, invoke: async (command) => command === "check_updates" ? availableUpdates() : undefined });
  await f.poll();
  f.advance(-day * 2); await f.poll(); await f.poll();
  assert.equal(f.calls.filter((call) => call.command === "check_updates").length, 2);
  const stored = JSON.parse(await readFile(path.join(f.directory, "update-checks.json"), "utf8"));
  assert.equal(stored.lastAttemptAt, f.now());
  f.advance(day - 1); await f.poll();
  assert.equal(f.calls.filter((call) => call.command === "check_updates").length, 2);
  f.advance(1); await f.poll();
  assert.equal(f.calls.filter((call) => call.command === "check_updates").length, 3);
});

test("manual and periodic checks coalesce, exclude FRAME mutations, and publish a cached result", async (t) => {
  let release;
  const f = await fixture(t, { preferences: { checkUpdatesAutomatically: true }, invoke: (command) => {
    if (command === "check_updates") return new Promise((resolve) => { release = resolve; });
  } });
  await f.controller.refresh();
  const periodic = f.poll();
  while (!release) await tick();
  const manual = f.controller.invoke("check_updates");
  f.advance(day); await f.poll();
  for (const command of ["start_stack", "stop_stack", "update_stack", "repair_stack"]) {
    await assert.rejects(f.controller.invoke(command, { installRoot: "/frame" }), /current FRAME operation/);
  }
  assert.equal((await f.controller.invoke("get_launcher_status")).busy, true);
  release(availableUpdates());
  assert.deepEqual(await periodic, availableUpdates()); assert.deepEqual(await manual, availableUpdates());
  assert.equal(f.calls.filter((call) => call.command === "check_updates").length, 1);
  assert.equal(f.events.filter((event) => event.event === "launcher-updates").length, 1);
  assert.equal(f.controller.isBusy(), false);
});

test("periodic checks skip busy work without consuming the due attempt, fail quietly, and sanitize manual failures", async (t) => {
  const f = await fixture(t, { preferences: { checkUpdatesAutomatically: true }, invoke: async (command) => {
    if (command === "check_updates") throw new Error("private token and network diagnostic");
  } });
  f.setBusy(true); await f.poll();
  assert.equal(f.calls.length, 0);
  await assert.rejects(readFile(path.join(f.directory, "update-checks.json")), { code: "ENOENT" });
  f.setBusy(false); await f.poll();
  assert.equal(f.calls.filter((call) => call.command === "check_updates").length, 1);
  assert.deepEqual(f.errors, []); assert.deepEqual(f.notifications, []);
  assert.equal(f.events.some((event) => event.event === "install-log"), false);
  f.advance(60_000); await f.poll();
  assert.equal(f.calls.filter((call) => call.command === "check_updates").length, 1);
  await assert.rejects(f.controller.invoke("check_updates"), (error) => {
    assert.match(error.message, /Check your internet connection/); assert.doesNotMatch(error.message, /private token/); return true;
  });
  const saved = JSON.parse(await readFile(path.join(f.directory, "update-checks.json"), "utf8"));
  assert.equal(saved.lastAttemptAt, f.now());
});

test("release notifications respect preferences and notify only new release identities", async (t) => {
  let version = "1.2.0";
  const f = await fixture(t, { preferences: { notifications: false }, invoke: async (command) => command === "check_updates" ? availableUpdates(version) : undefined });
  assert.equal(f.controller.getPreferences().checkUpdatesAutomatically, false);
  await f.controller.invoke("check_updates");
  assert.equal(f.calls.filter((call) => call.command === "check_updates").length, 1, "manual checks work with periodic checks disabled");
  assert.deepEqual(f.notifications, []);
  await f.controller.invoke("set_launcher_preferences", { preferences: { notifications: true } });
  await f.controller.invoke("check_updates"); await f.controller.invoke("check_updates");
  assert.equal(f.notifications.length, 1);
  version = "1.3.0"; await f.controller.invoke("check_updates");
  assert.equal(f.notifications.length, 2);
  assert.equal(f.notifications.at(-1).title, "FRAME updates available");
});

test("update and repair are guarded mutations that can succeed with FRAME running or stopped", async (t) => {
  for (const state of ["running", "stopped"]) {
    const f = await fixture(t, { state });
    const status = await f.controller.refresh();
    for (const command of ["update_stack", "repair_stack"]) {
      await f.controller.invoke(command, { installRoot: status.installations[0].installRoot, releaseTag: "v1.2.0" });
      assert.equal(f.notifications.at(-1).title, state === "running" ? "FRAME is ready" : "FRAME is stopped");
    }
  }
});

test("a restored running state after failed maintenance still reports an update or repair failure", async (t) => {
  let status;
  const f = await fixture(t, { invoke: async (command) => {
    if (["update_stack", "repair_stack"].includes(command)) return { ...status,
      maintenance: { action: command === "update_stack" ? "update" : "repair", success: false, recovered: true, detail: "Previous deployment restored." } };
  } });
  status = await f.controller.refresh();
  for (const command of ["update_stack", "repair_stack"]) {
    const result = await f.controller.invoke(command, { installRoot: status.installations[0].installRoot });
    assert.equal(result.installations[0].state, "running");
    assert.equal(f.notifications.at(-1).title, command === "update_stack" ? "FRAME update failed" : "FRAME repair failed");
    assert.match(f.notifications.at(-1).body, /previous deployment was restored/);
  }
});

test("explicit backend cache invalidation removes stale update availability from status events", async (t) => {
  let status;
  const f = await fixture(t, { invoke: async (command) => {
    if (command === "check_updates") return availableUpdates();
    if (command === "get_launcher_status" && status) return { ...status, updates: null };
  } });
  status = await f.controller.refresh();
  await f.controller.invoke("check_updates");
  await f.controller.refresh();
  assert.equal(f.events.filter((event) => event.event === "launcher-status").at(-1).payload.updates, null);
});

test("backup, restore and removal notifications use their explicit outcome even when containers need repair", async (t) => {
  for (const command of ["backup_stack", "restore_backup", "remove_stack"]) {
    let complete;
    const f = await fixture(t, { invoke: (name) => name === command ? new Promise((resolve) => { complete = resolve; }) : undefined });
    await f.controller.refresh(false);
    const pending = f.controller.invoke(command, { confirmed: true });
    await tick();
    await assert.rejects(f.controller.invoke("start_stack"), /Wait for/);
    const result = { installations: [], dockerAvailable: true, protection: { success: command !== "backup_stack", detail: command === "backup_stack" ? "Backup completed but resume failed." : "Files retained. Repair before starting." } };
    complete(result); await pending;
    assert.equal(f.notifications.at(-1).body, result.protection.detail);
    assert.equal(f.notifications.at(-1).title, result.protection.success ? "FRAME operation completed" : "FRAME needs attention");
  }
});
