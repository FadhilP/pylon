import { useEffect, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_SYNTAX_THEME,
  getSyntaxHighlightingRevision,
  isSyntaxTheme,
  setSyntaxTheme,
  subscribeSyntaxHighlighting,
  type SyntaxTheme,
} from "../shared/syntax-highlighting";

export type Theme = "light" | "dark" | "warm";
/** What the theme falls back to, and what "reset to default" restores. */
export const DEFAULT_THEME: Theme = "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "warm";
}

const THEME_KEY = "pylon-theme";
const THEME_COLORS: Record<Theme, string> = { dark: "#111318", light: "#e9eaec", warm: "#eee8dd" };
const SYNTAX_THEME_KEY = "pylon-syntax-theme";

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
  const theme = document.documentElement.dataset.theme;
  return isTheme(theme) ? theme : DEFAULT_THEME;
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

function readInitialSyntaxTheme(): SyntaxTheme {
  const theme = document.documentElement.dataset.syntaxTheme;
  return isSyntaxTheme(theme) ? theme : DEFAULT_SYNTAX_THEME;
}

export function useSyntaxTheme() {
  const [theme, setTheme] = useState<SyntaxTheme>(readInitialSyntaxTheme);
  useEffect(() => {
    document.documentElement.dataset.syntaxTheme = theme;
    setSyntaxTheme(theme);
    rememberSetting(SYNTAX_THEME_KEY, theme);
  }, [theme]);
  return [theme, setTheme] as const;
}

export function useSyntaxHighlightingRevision(): number {
  return useSyncExternalStore(
    subscribeSyntaxHighlighting,
    getSyntaxHighlightingRevision,
    getSyntaxHighlightingRevision,
  );
}

/** Keeps the document title in step with whatever the extension UI has set. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    document.title = title || "Pylon";
  }, [title]);
}
