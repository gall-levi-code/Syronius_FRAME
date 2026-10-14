const { contextBridge, ipcRenderer } = require("electron");

// Expose launcher operations, never Electron's IPC or Node APIs themselves.
contextBridge.exposeInMainWorld("frameDesktop", {
  invoke: (command, args = {}) => ipcRenderer.invoke("frame:invoke", command, args),
  listen: (event, callback) => {
    if (!["install-log", "launcher-status", "launcher-preferences", "launcher-progress", "launcher-updates"].includes(event) || typeof callback !== "function") throw new Error("Unsupported launcher event.");
    const listener = (_event, payload) => callback({ payload });
    ipcRenderer.on(`frame:${event}`, listener);
    return () => ipcRenderer.removeListener(`frame:${event}`, listener);
  },
  pickDirectory: (options = {}) => ipcRenderer.invoke("frame:directory", options),
  openExternal: (url) => ipcRenderer.invoke("frame:external", url),
  exportReport: (kind) => ipcRenderer.invoke("frame:export-report", kind),
  closeWindow: () => ipcRenderer.invoke("frame:close"),
});
