// Electron main process — the desktop shell for Fal Forge (local build; codename Matteblack).
//
// Responsibilities:
//   1. Boot the existing Express server (server/) as an ISOLATED child process
//      in LOCAL_MODE, bound to loopback on an OS-assigned ephemeral port.
//   2. Wait for the server's "[server-ready]" handshake, then load the built
//      React SPA (served by that same server) into a BrowserWindow over http.
//   3. Point all persistent state at Electron's per-user userData dir so the
//      packaged app writes nowhere near its (read-only) program files.
//
// The server is run as a child (Electron `utilityProcess`) rather than in-main
// so a server crash can be surfaced/restarted without taking down the window,
// and so its heavy Node deps (PGlite WASM, ffmpeg, image probing) stay off the
// UI process. The renderer talks to it purely over HTTP (loopback), exactly as
// in the web build — so the entire /api surface works unchanged.

const { app, BrowserWindow, shell, utilityProcess, ipcMain, session, Menu } = require("electron");
const path = require("node:path");

// Brand the per-user data path: app.getPath("userData") derives from app.name,
// which otherwise defaults to the npm package name ("interface-unified"). Set it
// before any getPath("userData") call so state lives under
// AppData/Roaming/Matteblack — the internal project name, deliberately NOT the
// public "Fal Forge" brand, so the data dir stays stable across brand changes.
app.setName("Matteblack");

// Content-Security-Policy for the renderer document.
//
// COOP/COEP are intentionally NOT set: the app loads the SINGLE-THREADED
// @ffmpeg/core (ffmpeg.load() with no core-mt URL), so SharedArrayBuffer isn't
// required — and require-corp would break cross-origin <img>/<video> loads from
// fal.media for no gain. Revisit only if a multi-threaded ffmpeg core is added.
//
// connect-src/img/media allow https broadly because the app legitimately talks
// to many hosts (fal.ai, fal.media, Anthropic, AWS Rekognition) and pulls the
// ffmpeg core from a CDN. script-src is the meaningful restriction: self + wasm
// + the ffmpeg-core CDNs only. Set MB_DISABLE_CSP=1 to bypass while debugging a
// content-blocking issue.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob: https://unpkg.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss: data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
].join("; ");

function installCsp() {
  if (process.env.MB_DISABLE_CSP === "1") {
    console.warn("[electron] CSP disabled via MB_DISABLE_CSP=1");
    return;
  }
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Only stamp the top-level HTML document — CSP on subresource responses is
    // ignored by the browser anyway, so this keeps it tidy.
    if (details.resourceType !== "mainFrame") {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP],
      },
    });
  });
}

// Single-instance: a second launch just focuses the existing window. Without
// this, two instances would race on the same PGlite data directory.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

const isDev = !app.isPackaged;
// In dev the server is run from the freshly-built dist-server/ next to source;
// when packaged, dist-server/ ships inside the app resources (unpacked from the
// asar so PGlite's .wasm/.data and other native assets are readable on disk).
const APP_ROOT = isDev ? path.join(__dirname, "..") : path.join(process.resourcesPath, "app");
const SERVER_ENTRY = path.join(APP_ROOT, "dist-server", "index.js");

let serverProcess = null;
let mainWindow = null;
let serverInfo = null; // { port, host }

function resolveDataDir() {
  // All mutable state (PGlite db, uploads, config.json) lives here. runtime.ts
  // honours MATTEBLACK_DATA_DIR, so this is the single switch that relocates
  // everything into Electron's userData.
  return path.join(app.getPath("userData"), "data");
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      LOCAL_MODE: "true",
      SERVER_HOST: "127.0.0.1",
      PORT: "0", // ephemeral — OS picks a free port, reported back via stdout
      MATTEBLACK_DATA_DIR: resolveDataDir(),
      NODE_ENV: isDev ? "development" : "production",
      // Phase K operator: how to launch the bundled MCP server for the spawned
      // `claude` (the app's own binary as Node + the packaged dist-mcp bundle).
      MB_APP_EXEC: process.execPath,
      MB_MCP_SCRIPT: mcpScriptPath(),
    };

    const child = utilityProcess.fork(SERVER_ENTRY, [], {
      cwd: APP_ROOT,
      env,
      stdio: "pipe", // capture stdout so we can read the ready handshake
      serviceName: "matteblack-server",
    });
    serverProcess = child;

    let settled = false;
    let buffer = "";
    const READY_PREFIX = "[server-ready] ";

    const onLine = (line) => {
      if (!settled && line.startsWith(READY_PREFIX)) {
        try {
          const info = JSON.parse(line.slice(READY_PREFIX.length));
          settled = true;
          resolve(info);
        } catch {
          /* keep scanning — malformed handshake line */
        }
      }
    };

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trimEnd();
          buffer = buffer.slice(nl + 1);
          if (line) { console.log(`[server] ${line}`); onLine(line); }
        }
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => process.stderr.write(`[server:err] ${chunk}`));
    }

    child.on("exit", (code) => {
      serverProcess = null;
      if (!settled) {
        settled = true;
        reject(new Error(`Server exited before becoming ready (code ${code})`));
      } else if (!app.isQuitting) {
        // Crashed after a healthy start — for a single-user desktop app the
        // safest response is to surface it and quit rather than silently run a
        // window with no backend.
        console.error(`[electron] Server process exited unexpectedly (code ${code}); quitting.`);
        app.quit();
      }
    });

    // Fail fast if the server never signals readiness (e.g. DB init hangs).
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("Timed out waiting for server readiness (60s)"));
      }
    }, 60_000);
  });
}

// Native window-control overlay colors per theme. `color` is the strip the
// buttons sit on — it matches the app's right-panel surface so the controls read
// as part of the panel rather than as OS chrome. `height` must match the
// renderer's --titlebar-h (see index.css).
// `color` is fully transparent so the controls have no strip of their own — the
// app's surface (the right panel backdrop) shows straight through and the
// buttons read as floating on it. Only `symbolColor` flips with the theme so the
// glyphs keep contrast. `height` must match --titlebar-h in index.css; 32px is
// the native caption-button height, so there's no dead space around them.
const TITLEBAR_OVERLAY = {
  dark: { color: "#00000000", symbolColor: "#e8e8ed", height: 32 },
  light: { color: "#00000000", symbolColor: "#18181b", height: 32 },
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#000000",
    show: false,
    // Frameless: no OS title bar and no application menu (see the null menu in
    // whenReady). The window controls are drawn by the OS as an *overlay* in the
    // top-right corner, so they keep native behaviour (including Windows 11
    // snap-layouts on maximize hover) while sitting inside the app's own chrome.
    // The renderer reserves --titlebar-h at the top and paints a drag strip
    // there; TITLEBAR_OVERLAY colors are kept in sync with the app theme via
    // the app:setTitleBarOverlay IPC.
    titleBarStyle: "hidden",
    titleBarOverlay: TITLEBAR_OVERLAY.dark,
    // macOS ignores titleBarOverlay and draws its own traffic lights top-LEFT,
    // inside the content area. Centre them in the 32px drag strip.
    // ponytail: x=16 is a guess — the left rail starts at the very top edge
    // (App.css only insets the right-hand panels), so if the lights collide with
    // it on a real Mac, nudge x here or inset the rail by ~78px on darwin.
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 16, y: 9 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  installDevShortcuts(mainWindow);

  // Open target=_blank / external links in the user's real browser, never in
  // a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  const { port, host } = serverInfo;
  mainWindow.loadURL(`http://${host}:${port}/`);

  mainWindow.on("closed", () => { mainWindow = null; });
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

ipcMain.handle("app:openDataFolder", () => shell.openPath(resolveDataDir()));

// Manual update check — previously File ▸ Check for Updates…, now reachable
// from Settings since the app has no menu bar.
ipcMain.handle("app:checkForUpdates", () => checkForUpdatesManually());

// Repaint the native window-control overlay when the app theme changes, so the
// controls keep matching the panel surface they sit on.
ipcMain.handle("app:setTitleBarOverlay", (_e, theme) => {
  if (!mainWindow || typeof mainWindow.setTitleBarOverlay !== "function") return false;
  try {
    mainWindow.setTitleBarOverlay(theme === "light" ? TITLEBAR_OVERLAY.light : TITLEBAR_OVERLAY.dark);
    return true;
  } catch {
    return false; // platform without overlay support (macOS)
  }
});

// MCP "Connect to Claude": open the guided dialog, or (for a future in-app
// Settings button) return the launch details without any UI.
ipcMain.handle("app:connectToClaude", () => connectToClaude());
ipcMain.handle("app:getMcpConnectInfo", () => ({
  claudeCodeCommand: claudeCodeCommand(),
  desktopConfigPath: claudeDesktopConfigPath(),
  launch: mcpLaunchConfig(),
}));

// Auto-update via electron-updater against the GitHub Releases feed configured
// in electron-builder.yml. Only meaningful in a packaged, installed build — in
// dev there's no app-update.yml and no installer to swap in, so we no-op. All
// failures are swallowed: a missing/again-unreachable update feed must never
// block the app from running.
let autoUpdater = null;
function initAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    ({ autoUpdater } = require("electron-updater"));
    autoUpdater.autoDownload = true;
    autoUpdater.on("error", (e) => console.error("[updater] error:", e && e.message ? e.message : e));
    autoUpdater.on("update-available", (i) => console.log(`[updater] update available: ${i && i.version}`));
    autoUpdater.on("update-downloaded", (i) => console.log(`[updater] update downloaded: ${i && i.version} (installs on quit)`));
    autoUpdater.checkForUpdatesAndNotify().catch(() => { /* offline / no feed */ });
  } catch (e) {
    console.error("[updater] init skipped:", e && e.message ? e.message : e);
  }
}

function checkForUpdatesManually() {
  if (!app.isPackaged || !autoUpdater) {
    const { dialog } = require("electron");
    dialog.showMessageBox({ message: "Updates are only available in the installed desktop build.", buttons: ["OK"] });
    return;
  }
  autoUpdater.checkForUpdates().catch((e) => console.error("[updater] manual check failed:", e && e.message ? e.message : e));
}

// ── Connect to Claude (MCP bridge) ────────────────────────────────────────
// The stdio MCP server (dist-mcp/index.js) is spawned BY the Claude client, not
// by us. We hand the user the exact command to register it. We run it via the
// app's own binary as Node (ELECTRON_RUN_AS_NODE) so no separate Node install is
// required, and pass MATTEBLACK_DATA_DIR so it finds this app's discovery file
// (userData/data/mcp-endpoint.json).
function mcpScriptPath() {
  return path.join(APP_ROOT, "dist-mcp", "index.js");
}

function mcpLaunchConfig() {
  return {
    command: process.execPath, // Fal Forge.exe (packaged) / electron (dev)
    args: [mcpScriptPath()],
    env: { ELECTRON_RUN_AS_NODE: "1", MATTEBLACK_DATA_DIR: resolveDataDir() },
  };
}

function claudeCodeCommand() {
  const c = mcpLaunchConfig();
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  const envFlags = Object.entries(c.env).map(([k, v]) => `--env ${k}=${q(v)}`).join(" ");
  return `claude mcp add falforge ${envFlags} -- ${q(c.command)} ${c.args.map(q).join(" ")}`;
}

function claudeDesktopConfigPath() {
  if (process.platform === "darwin") {
    return path.join(app.getPath("home"), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return path.join(app.getPath("appData"), "Claude", "claude_desktop_config.json");
  }
  return path.join(app.getPath("home"), ".config", "Claude", "claude_desktop_config.json");
}

function desktopEntry() {
  const c = mcpLaunchConfig();
  return { command: c.command, args: c.args, env: c.env };
}

// Merge the matteblack server into claude_desktop_config.json, preserving any
// existing servers. Never called without an explicit user confirm (see below).
function writeClaudeDesktopConfig() {
  const fs = require("node:fs");
  const p = claudeDesktopConfigPath();
  let cfg = {};
  try {
    if (fs.existsSync(p)) cfg = JSON.parse(fs.readFileSync(p, "utf8")) || {};
  } catch (e) {
    return { ok: false, error: `existing config is not valid JSON (${e.message})`, path: p };
  }
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
  cfg.mcpServers.falforge = desktopEntry();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2), "utf8");
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message, path: p };
  }
}

async function connectToClaude() {
  const { dialog, clipboard } = require("electron");
  const cmd = claudeCodeCommand();
  const detail = [
    "Claude Code — run this in a terminal:",
    "",
    cmd,
    "",
    'Claude Desktop — add the "falforge" server to:',
    claudeDesktopConfigPath(),
    "",
    "Keep the Fal Forge app open while you use the tools from Claude.",
  ].join("\n");
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Connect to Claude",
    message: "Drive Fal Forge from your Claude subscription",
    detail,
    buttons: ["Copy Claude Code command", "Write Claude Desktop config…", "Close"],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 0) {
    clipboard.writeText(cmd);
    dialog.showMessageBox(mainWindow, { message: "Copied the `claude mcp add` command to your clipboard.", buttons: ["OK"] });
  } else if (response === 1) {
    const preview = JSON.stringify({ mcpServers: { falforge: desktopEntry() } }, null, 2);
    const confirm = await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "Write Claude Desktop config?",
      message: 'Add the "falforge" MCP server to Claude Desktop?',
      detail: `This merges the following into:\n${claudeDesktopConfigPath()}\n\n${preview}\n\nExisting servers are preserved. Restart Claude Desktop afterward.`,
      buttons: ["Write config", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (confirm.response === 0) {
      const r = writeClaudeDesktopConfig();
      dialog.showMessageBox(mainWindow, r.ok
        ? { message: `Wrote Fal Forge into:\n${r.path}\n\nRestart Claude Desktop to load it.`, buttons: ["OK"] }
        : { type: "error", message: `Couldn't write config: ${r.error}\n${r.path}`, buttons: ["OK"] });
    }
  }
}

// No application menu: the app owns its chrome (frameless window + native
// control overlay), so an OS menu bar would just be a redundant strip above it.
// Nothing is lost — the three real actions that lived under File are reachable
// from Settings via the preload API (openDataFolder / connectToClaude /
// checkForUpdates), and the Edit-menu roles (copy/paste/undo/select-all) are
// handled natively by Chromium in text fields without a menu to host them.
function removeApplicationMenu() {
  Menu.setApplicationMenu(null);
}

// The View menu also carried the devtools/reload accelerators. Keep those as
// plain key handlers so debugging a packaged build is still possible.
function installDevShortcuts(win) {
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const key = (input.key || "").toLowerCase();
    const toggleDevtools = key === "f12" || (input.control && input.shift && key === "i");
    const reload = (input.control && key === "r") || key === "f5";
    if (toggleDevtools) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    } else if (reload) {
      win.webContents.reload();
      event.preventDefault();
    }
  });
}

app.whenReady().then(async () => {
  try {
    removeApplicationMenu();
    installCsp();
    serverInfo = await startServer();
    console.log(`[electron] Server ready on http://${serverInfo.host}:${serverInfo.port}`);
    createWindow();
    initAutoUpdater();
  } catch (err) {
    console.error("[electron] Failed to start:", err);
    const { dialog } = require("electron");
    dialog.showErrorBox("Fal Forge failed to start", String(err && err.message ? err.message : err));
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverInfo) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  if (serverProcess) {
    try { serverProcess.kill(); } catch { /* already gone */ }
    serverProcess = null;
  }
});
