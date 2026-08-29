/**
 * Typed access to the Electron preload bridge (`window.matteblack`).
 *
 * Everything here is optional: the same bundle also runs as a plain web app,
 * where `window.matteblack` is undefined. Callers should treat a missing bridge
 * as "not the desktop app" rather than an error.
 */
declare global {
  interface Window {
    matteblack?: {
      isDesktop?: boolean;
      openDataFolder?: () => Promise<unknown>;
      connectToClaude?: () => Promise<unknown>;
      getMcpConnectInfo?: () => Promise<unknown>;
      checkForUpdates?: () => Promise<unknown>;
      setTitleBarOverlay?: (theme: "light" | "dark") => Promise<boolean>;
    };
  }
}

export function desktopBridge() {
  return typeof window !== "undefined" ? window.matteblack : undefined;
}

/** True only inside the Electron desktop app. */
export function isDesktopApp(): boolean {
  return desktopBridge()?.isDesktop === true;
}
