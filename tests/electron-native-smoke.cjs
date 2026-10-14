// Run development Electron on a native runner, never with the real FRAME backend.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, Menu, Tray, Notification, nativeImage } = require("electron");
const { createLauncherShell } = require("../apps/frame-setup/electron/launcher-shell.cjs");
const temporary = process.env.FRAME_SMOKE_ROOT || fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "frame-native-smoke-"));
assert.equal(path.dirname(temporary), fs.realpathSync(os.tmpdir()));
assert.ok(path.basename(temporary).startsWith("frame-native-smoke-"));
const cleanup = () => fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
const appRoot = path.resolve(__dirname, "../apps/frame-setup");
app.setPath("userData", path.join(temporary, "profile"));
app.setName("FRAME Launcher Smoke");
let window, launcher, mutations = 0;
const evidence = [];
const fail = (error) => { console.error(error.stack || error); app.exit(1); };
const deadline = setTimeout(() => fail(new Error("Native launcher smoke timed out.")), 30_000);
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
app.on("before-quit", (event) => launcher?.beforeQuit(event));
app.on("will-quit", () => clearTimeout(deadline));
app.on("quit", () => { if (!process.env.FRAME_SMOKE_ROOT) { try { cleanup(); } catch (error) { console.error(`Could not remove the smoke profile: ${error.message}`); } } });

async function createWindow() {
  if (window && !window.isDestroyed()) return;
  window = new BrowserWindow({ width: 1120, height: 760, show: false,
    webPreferences: { preload: path.join(appRoot, "electron/preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.on("close", (event) => launcher.onClose(event));
  await window.loadFile(path.join(appRoot, "dist/index.html"));
  window.show();
}

async function waitForRenderer() {
  while (!(await window.webContents.executeJavaScript("Boolean(document.querySelector('[data-new-setup]:not(:disabled)'))"))) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

app.whenReady().then(async () => {
  assert.ok(["win32", "darwin", "linux"].includes(process.platform), "run on a supported native host");
  assert.equal(process.arch, process.env.FRAME_EXPECTED_ARCH);
  assert.equal(app.commandLine.hasSwitch("no-sandbox"), false);
  assert.equal(app.commandLine.hasSwitch("disable-setuid-sandbox"), false);
  const status = { installations: [], dockerAvailable: false, detail: "Isolated smoke: Docker is not contacted.",
    platform: process.platform, arch: process.arch,
    defaults: { installRoot: path.join(temporary, "deployment"), dataRoot: path.join(temporary, "data") } };
  const backend = { isBusy: () => false, dispose: async () => {}, invoke: async (command) => {
    if (command === "get_launcher_status") return status;
    if (command === "detect_host") return { ...status, detectedInstallations: [], checks: [], previewMode: false };
    if (command === "load_draft") return { draft: null };
    mutations++;
    throw new Error(`Unexpected backend command in smoke: ${command}`);
  } };
  app.setLoginItemSettings = () => { throw new Error("The smoke must never register a login item."); };
  const options = { app, backend, Menu, Tray, Notification, nativeImage,
    shell: { openExternal: async () => assert.fail("Unexpected external link"), openPath: async () => assert.fail("Unexpected folder open") },
    dialog: { showErrorBox: (_title, message) => {
      if (process.platform === "linux" && message.startsWith("The tray is unavailable.")) { evidence.push("Native Linux tray unavailable; window fallback used"); return; }
      throw new Error(message);
    }, showMessageBox: async () => ({ response: 0 }) },
    getWindow: () => window, reopenWindow: createWindow, emit: () => {}, preferencesDirectory: path.join(temporary, "preferences"),
    iconPath: path.join(appRoot, "public/frame-logo-square.png"), appId: "us.syroni.frame.setup" };
  launcher = await createLauncherShell(options);
  ipcMain.handle("frame:invoke", (_event, command, args) => launcher.invoke(command, args));
  await launcher.invoke("set_launcher_preferences", { preferences: { keepInTray: false, notifications: false } });
  await createWindow();
  await waitForRenderer();
  assert.equal(window.isVisible(), true);
  assert.equal(window.getTitle(), "FRAME Launcher");
  if (process.platform === "darwin") assert.ok(Menu.getApplicationMenu(), "native application menu was created");
  const webPreferences = window.webContents.getLastWebPreferences();
  assert.equal(webPreferences.sandbox, true); assert.equal(webPreferences.contextIsolation, true); assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(await window.webContents.executeJavaScript("typeof window.require"), "undefined");
  window.focus(); window.webContents.focus();
  window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
  window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await window.webContents.executeJavaScript("document.activeElement !== document.body && document.activeElement.matches('button, input, select, a, [tabindex]')"), true, "native Tab reaches an interactive control");
  window.setSize(900, 640);
  window.webContents.setZoomFactor(2);
  await window.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert.equal(await window.webContents.executeJavaScript("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "Home fits at 200% zoom without horizontal scrolling");
  window.webContents.setZoomFactor(1);
  evidence.push("Isolated window and real preload; renderer sandbox and context isolation", "Native Tab navigation on Home", "Home at 900×640 and 200% Chromium zoom");
  const preferences = await window.webContents.executeJavaScript("window.frameDesktop.invoke('get_launcher_preferences')");
  assert.equal(preferences.startAtLoginSupported, false, "development smoke cannot register startup");
  if (process.platform !== "linux") assert.equal(preferences.trayAvailable, true);
  while (launcher.isBusy()) await new Promise((resolve) => setImmediate(resolve));
  const previous = window;
  await new Promise((resolve) => { window.once("closed", resolve); window.close(); });
  assert.equal(previous.isDestroyed(), true);
  if (process.platform === "darwin") app.emit("activate");
  else await launcher.showWindow();
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(window, previous);
  if (window.webContents.isLoading()) await new Promise((resolve) => window.webContents.once("did-finish-load", resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(window.isVisible(), true);
  await waitForRenderer();
  evidence.push(process.platform === "darwin" ? "Native menu and Dock reopening" : "Window reopening through launcher shell");
  const noTray = await createLauncherShell({ ...options, preferencesDirectory: path.join(temporary, "no-tray"),
    Tray: class { constructor() { throw new Error("Simulated missing tray host"); } },
    dialog: { ...options.dialog, showErrorBox: (_title, message) => assert.match(message, /tray is unavailable/) } });
  assert.equal(noTray.getPreferences().trayAvailable, false);
  const close = { prevented: false, preventDefault() { this.prevented = true; } };
  noTray.onClose(close);
  assert.equal(close.prevented, false, "a missing tray never hides the only launcher window");
  assert.equal(window.isVisible(), true);
  evidence.push("Window remains available with simulated tray creation failure");
  assert.equal(mutations, 0);
  while (launcher.isBusy()) await new Promise((resolve) => setImmediate(resolve));
  if (process.env.FRAME_SMOKE_REPORT) {
    const report = path.resolve(process.env.FRAME_SMOKE_REPORT);
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, `${JSON.stringify({ platform: process.platform, arch: process.arch, scope: "Development Electron with simulated backend", evidence,
      unverified: ["Downloaded installer and packaged application", "Signing, notarization and OS trust prompts", "Native display scaling and assistive technology", "Notification delivery and login startup", "Docker and media workflows"] }, null, 2)}\n`);
  }
  console.log(`Native ${process.platform} ${process.arch} smoke passed with sandbox enabled; simulated backend, no Docker or login registration.`);
  app.quit();
}).catch(fail);
