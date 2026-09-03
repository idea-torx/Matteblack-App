import { useEffect, useState } from "react";

/** Theme registry. Adding a theme = one entry here + one token block in
 *  src/index.css (`[data-theme="<id>"]`). `scheme` picks which of the two
 *  shells (light / dark) the theme inherits — every component-level override
 *  in the CSS is keyed on `data-scheme`, not `data-theme`. */
export const THEMES = [
  { id: "dark", label: "Dark", scheme: "dark" },
  { id: "light", label: "Light", scheme: "light" },
  { id: "light-mono", label: "Light Mono", scheme: "light" },
  { id: "fal", label: "Fal", scheme: "dark" },
] as const;

export type Theme = (typeof THEMES)[number]["id"];
export type Scheme = "light" | "dark";

const STORAGE_KEY = "mb-theme-v2";
const EVENT_NAME = "mb-theme-change";

function isTheme(v: string | null): v is Theme {
  return THEMES.some((t) => t.id === v);
}

export function getScheme(theme?: Theme): Scheme {
  const id = theme ?? getAppliedTheme();
  return (THEMES.find((t) => t.id === id)?.scheme ?? "dark") as Scheme;
}

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    // Dark by default; unknown / stale ids fall back to it. Mirrors the inline
    // boot script in index.html.
    return isTheme(v) ? v : "dark";
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
    if (isTheme(v)) return v;
  }
  return getStoredTheme();
}

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-theme", theme);
  document.documentElement.setAttribute("data-scheme", getScheme(theme));
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

/** Cycles through the registry — the quick-settings row is a single button. */
export function toggleTheme(): void {
  const i = THEMES.findIndex((t) => t.id === getAppliedTheme());
  setTheme(THEMES[(i + 1) % THEMES.length].id);
}

/** Default fill color for a freshly created canvas Frame node. Pure white
 *  on light schemes so frames read as a clean blank page; mid-dark on
 *  dark schemes so they stand out against the canvas without glare.
 *  Existing frames keep whatever fill was persisted with them. */
export function getDefaultFrameFill(): string {
  return getScheme() === "light" ? "#ffffff" : "#333333";
}

/** Default text color for a freshly created canvas Text node. Black on
 *  light so type sits cleanly on a white frame; white on dark so type
 *  reads against the dark canvas. Existing text nodes keep whatever
 *  color was persisted with them. */
export function getDefaultTextColor(): string {
  return getScheme() === "light" ? "#000000" : "#ffffff";
}

export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void; toggleTheme: () => void } {
  const [theme, setLocal] = useState<Theme>(getStoredTheme);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<Theme>).detail;
      if (isTheme(detail)) setLocal(detail);
    };
    window.addEventListener(EVENT_NAME, handler);
    return () => window.removeEventListener(EVENT_NAME, handler);
  }, []);
  return { theme, setTheme, toggleTheme };
}
