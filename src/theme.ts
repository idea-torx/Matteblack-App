import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

// Bumped from "mb-theme" so a stale pre-dark-default "light" value doesn't
// pin the app to light. Dark is now the default (see getStoredTheme).
const STORAGE_KEY = "mb-theme-v2";
const EVENT_NAME = "mb-theme-change";

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    // Dark by default; only an explicit "light" choice opts out. Mirrors the
    // inline boot script in index.html.
    return v === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** Reads the theme actually applied to <html>. Falls back to stored theme.
 *  Used by toggleTheme so toggling stays correct when localStorage is
 *  unavailable (e.g. private browsing / blocked storage). */
function getAppliedTheme(): Theme {
  if (typeof document !== "undefined") {
    const v = document.documentElement.getAttribute("data-theme");
    if (v === "light" || v === "dark") return v;
  }
  return getStoredTheme();
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  // Desktop only: repaint the native window-control overlay so the min/max/close
  // buttons keep matching the panel surface they sit on. No-ops on the web.
  try {
    window.matteblack?.setTitleBarOverlay?.(theme);
  } catch {
    /* bridge unavailable — cosmetic only */
  }
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* localStorage unavailable — still apply for the session. */
  }
  applyTheme(theme);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent<Theme>(EVENT_NAME, { detail: theme }));
  }
}

export function toggleTheme(): void {
  setTheme(getAppliedTheme() === "light" ? "dark" : "light");
}

/** Default fill color for a freshly created canvas Frame node. Pure white
 *  on the light theme so frames read as a clean blank page; mid-dark on
 *  the dark theme so they stand out against the canvas without glare.
 *  Existing frames keep whatever fill was persisted with them. */
export function getDefaultFrameFill(): string {
  return getAppliedTheme() === "light" ? "#ffffff" : "#333333";
}

/** Default text color for a freshly created canvas Text node. Black on
 *  light so type sits cleanly on a white frame; white on dark so type
 *  reads against the dark canvas. Existing text nodes keep whatever
 *  color was persisted with them. */
export function getDefaultTextColor(): string {
  return getAppliedTheme() === "light" ? "#000000" : "#ffffff";
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggleTheme: () => void } {
  const [theme, setLocal] = useState<Theme>(getStoredTheme);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Theme>).detail;
      if (detail === "light" || detail === "dark") setLocal(detail);
    };
    window.addEventListener(EVENT_NAME, handler);
    return () => window.removeEventListener(EVENT_NAME, handler);
  }, []);
  return { theme, setTheme, toggleTheme };
}
