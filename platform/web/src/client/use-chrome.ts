import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

const THEME_KEY = "pylon-theme";
const THEME_COLORS: Record<Theme, string> = { dark: "#111318", light: "#e9eaec" };

/**
 * localStorage is unavailable in hardened browser contexts, so every read falls
 * back to a default and every write is best effort — the setting still applies
 * to the current page either way.
 */
export function readStoredNumber(key: string, fallback: number): number {
  let stored = Number.NaN;
  try {
    stored = Number(localStorage.getItem(key));
  } catch {
    /* Fall back to the default below. */
  }
  return Number.isFinite(stored) && stored > 0 ? stored : fallback;
}

export function rememberSetting(key: string, value: string | number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* The setting still applies for the current page. */
  }
}

function readInitialTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Applies the theme to the document and the browser chrome, and remembers it. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    rememberSetting(THEME_KEY, theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
  }, [theme]);
  return [theme, setTheme] as const;
}

/** Keeps the document title in step with whatever the extension UI has set. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title || "Pylon";
  }, [title]);
}
