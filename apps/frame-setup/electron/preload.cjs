const { contextBridge, ipcRenderer } = require("electron");

// Expose installer operations, never Electron's IPC or Node APIs themselves.
contextBridge.exposeInMainWorld("frameDesktop", {
  invoke: (command, args = {}) => ipcRenderer.invoke("frame:invoke", command, args),
  listen: (event, callback) => {
    if (event !== "install-log" || typeof callback !== "function") throw new Error("Unsupported installer event.");
    const listener = (_event, payload) => callback({ payload });
    ipcRenderer.on("frame:install-log", listener);
    return () => ipcRenderer.removeListener("frame:install-log", listener);
  },
  pickDirectory: (options = {}) => ipcRenderer.invoke("frame:directory", options),
  openExternal: (url) => ipcRenderer.invoke("frame:external", url),
  closeWindow: () => ipcRenderer.invoke("frame:close"),
});
