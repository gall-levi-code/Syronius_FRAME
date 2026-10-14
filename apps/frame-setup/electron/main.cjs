const { app, BrowserWindow, clipboard, dialog, ipcMain, shell, session, Menu, Tray, Notification, nativeImage } = require("electron");
const path = require("node:path");
const { writeFile } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");
const { createLauncherShell, launcherPaths, openHttpExternal } = require("./launcher-shell.cjs");
const metadata = require("../package.json");

const development = !app.isPackaged && process.env.FRAME_SETUP_DEV === "1";
const uiUrl = development ? "http://127.0.0.1:5174/" : pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
let window;
let backend;
let launcher;

// Match the installed shortcut identity without changing the existing executable or Chromium profile.
if (process.platform === "win32") app.setAppUserModelId(metadata.build.appId);

function trustedSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiUrl) {
    throw new Error("Launcher request came from an untrusted page.");
  }
}

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    trustedSender(event);
    return callback(...args);
  });
}

async function createWindow() {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
  window = new BrowserWindow({
    title: "FRAME Launcher", width: 1120, height: 760, minWidth: 900, minHeight: 640,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("close", (event) => launcher.onClose(event));
  await window.loadURL(uiUrl);
  window.show();
}

function emit(event, payload) {
  if (!["install-log", "launcher-status", "launcher-preferences", "launcher-progress", "launcher-updates"].includes(event)) return;
  if (window && !window.isDestroyed() && window.webContents.getURL() === uiUrl) {
    window.webContents.send(`frame:${event}`, payload);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("before-quit", (event) => {
    launcher?.beforeQuit(event);
  });
  app.on("second-instance", () => {
    launcher?.showWindow();
  });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const { createBackend } = await import("./backend.mjs");
    const locations = launcherPaths(app);
    backend = createBackend({
      ...locations,
      resourcesRoot: app.isPackaged ? path.join(process.resourcesPath, "frame") : path.resolve(__dirname, "../../.."),
      nodeExecutable: process.execPath,
      releaseTag: metadata.frameReleaseTag,
      launcherVersion: app.getVersion(),
      emit,
    });
    launcher = await createLauncherShell({ app, backend, Menu, Tray, Notification, nativeImage, shell, dialog,
      getWindow: () => window, reopenWindow: createWindow, emit, preferencesDirectory: locations.userData, appId: metadata.build.appId,
      iconPath: path.join(__dirname, development ? "../public/frame-logo-square.png" : "../dist/frame-logo-square.png"),
    });
    handle("frame:invoke", (command, args = {}) => launcher.invoke(command, args));
    handle("frame:export-report", async (kind) => {
      if (!["copy", "save"].includes(kind)) throw new Error("Choose Copy or Save for the support report.");
      const report = await launcher.invoke("get_diagnostics", {});
      const text = `${JSON.stringify(report, null, 2)}\n`;
      if (kind === "copy") { clipboard.writeText(text); return { report, completed: true }; }
      const result = await dialog.showSaveDialog(window, {
        title: "Save FRAME support report", defaultPath: `FRAME-support-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        filters: [{ name: "JSON support report", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return { report, completed: false };
      try { await writeFile(result.filePath, text, { flag: "wx", mode: 0o600 }); }
      catch { throw new Error("The report could not be saved. Choose a new filename in a writable folder."); }
      return { report, completed: true };
    });
    handle("frame:directory", async (options = {}) => {
      const result = await dialog.showOpenDialog(window, {
        title: options.purpose === "backup" ? "Choose an empty folder for the full backup" : options.purpose === "restore" ? "Choose a completed FRAME backup" : options.purpose === "deployment" ? "Choose the existing FRAME deployment folder" : "Choose FRAME storage folder",
        properties: ["restore", "deployment"].includes(options.purpose) ? ["openDirectory"] : ["openDirectory", "createDirectory"],
        ...(typeof options.defaultPath === "string" ? { defaultPath: options.defaultPath } : {}),
      });
      return result.canceled ? null : result.filePaths[0];
    });
    handle("frame:external", async (value) => {
      await openHttpExternal(shell, value);
    });
    handle("frame:close", () => window.close());
    await createWindow();
    launcher.refresh().catch((error) => emit("install-log", error.message));
  }).catch((error) => {
    dialog.showErrorBox("FRAME Launcher could not start", error.message);
    app.quit();
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
