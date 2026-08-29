// Preload — runs in an isolated context bridge between the sandboxed renderer
// and Electron. The renderer talks to the backend over HTTP (loopback), so it
// needs almost no privileged surface. We expose only a tiny, explicit API for
// desktop affordances that HTTP can't provide.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("matteblack", {
  isDesktop: true,
  // Reserved for future desktop-only actions wired up in main.cjs via
  // ipcMain.handle(...), e.g. "reveal data folder" / "reset database".
  openDataFolder: () => ipcRenderer.invoke("app:openDataFolder"),
  // MCP bridge: open the guided "Connect to Claude" dialog, or fetch the raw
  // launch details for an in-app Settings panel to render.
  connectToClaude: () => ipcRenderer.invoke("app:connectToClaude"),
  getMcpConnectInfo: () => ipcRenderer.invoke("app:getMcpConnectInfo"),
  // Was File ▸ Check for Updates… before the menu bar was removed.
  checkForUpdates: () => ipcRenderer.invoke("app:checkForUpdates"),
  // Keep the native window-control overlay in sync with the app theme.
  setTitleBarOverlay: (theme) => ipcRenderer.invoke("app:setTitleBarOverlay", theme),
});
