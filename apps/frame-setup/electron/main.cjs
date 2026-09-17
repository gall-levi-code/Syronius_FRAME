const { app, BrowserWindow, dialog, ipcMain, shell, session } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const commands = new Set(["detect_host", "run_preflight", "save_install_plan", "load_install_plan", "apply_install_plan"]);
const development = !app.isPackaged && process.env.FRAME_SETUP_DEV === "1";
const uiUrl = development ? "http://127.0.0.1:5174/" : pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
let window;
let backend;
let showingBusyMessage = false;
let cleanupRunning = false;
let cleanupComplete = false;

function trustedSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiUrl) {
    throw new Error("Installer request came from an untrusted page.");
  }
}

function handle(channel, callback) {
  ipcMain.handle(channel, (event, ...args) => {
    trustedSender(event);
    return callback(...args);
  });
}

async function createWindow() {
  window = new BrowserWindow({
    title: "FRAME Setup", width: 1120, height: 760, minWidth: 900, minHeight: 640,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (!backend.isBusy()) return;
    event.preventDefault();
    if (showingBusyMessage) return;
    showingBusyMessage = true;
    dialog.showMessageBox(window, {
      type: "info", title: "FRAME Setup is working",
      message: "Wait for the current check, installation, or recovery to finish before closing FRAME Setup.",
    }).finally(() => { showingBusyMessage = false; });
  });
  await window.loadURL(uiUrl);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("before-quit", (event) => {
    if (!backend || cleanupComplete) return;
    event.preventDefault();
    if (backend.isBusy() || cleanupRunning) return;
    cleanupRunning = true;
    backend.dispose().catch((error) => {
      dialog.showErrorBox("FRAME Setup cleanup failed", error.message);
    }).finally(() => {
      cleanupComplete = true;
      app.quit();
    });
  });
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const { createBackend } = await import("./backend.mjs");
    backend = createBackend({
      userData: app.getPath("userData"),
      resourcesRoot: app.isPackaged ? path.join(process.resourcesPath, "frame") : path.resolve(__dirname, "../../.."),
      nodeExecutable: process.execPath,
      emit: (event, payload) => {
        if (window && !window.isDestroyed() && window.webContents.getURL() === uiUrl) {
          window.webContents.send("frame:install-log", payload === undefined ? event : payload);
        }
      },
    });
    handle("frame:invoke", (command, args = {}) => {
      if (!commands.has(command)) throw new Error("Unsupported installer command.");
      if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid installer arguments.");
      return backend.invoke(command, args);
    });
    handle("frame:directory", async (options = {}) => {
      const result = await dialog.showOpenDialog(window, {
        title: "Choose FRAME storage folder", properties: ["openDirectory", "createDirectory"],
        ...(typeof options.defaultPath === "string" ? { defaultPath: options.defaultPath } : {}),
      });
      return result.canceled ? null : result.filePaths[0];
    });
    handle("frame:external", async (value) => {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Only HTTP and HTTPS links can be opened.");
      await shell.openExternal(url.href);
    });
    handle("frame:close", () => window.close());
    await createWindow();
  }).catch((error) => {
    dialog.showErrorBox("FRAME Setup could not start", error.message);
    app.quit();
  });
  app.on("window-all-closed", () => app.quit());
}
