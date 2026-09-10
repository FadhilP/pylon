import { useEffect, useState, useSyncExternalStore } from "react";
import {
  applyTheme,
  applyInterfaceScale,
  DEFAULT_THEME,
  DEFAULT_INTERFACE_SCALE,
  readStoredPreference,
  readStoredThemePreference,
  readStoredInterfaceScalePreference,
  rememberStoredPreference,
  rememberThemePreference,
  rememberInterfaceScalePreference,
  resolveTheme,
  type ColorTheme,
  type InterfaceScale,
  type PreferenceStorage,
  type Theme,
} from "./appearance";
import {
  DEFAULT_SYNTAX_THEME_PREFERENCE,
  readSyntaxThemePreference,
  resolveSyntaxTheme,
  setSyntaxTheme,
  SYNTAX_THEME_KEY,
  subscribeSyntaxHighlighting,
  getSyntaxHighlightingRevision,
  type SyntaxThemePreference,
} from "../rendering/syntax-highlighting";

export {
  DEFAULT_INTERFACE_SCALE,
  DEFAULT_THEME,
  INTERFACE_SCALES,
  isTheme,
  readInterfaceScalePreference,
  type InterfaceScale,
  type Theme,
} from "./appearance";

const SYSTEM_COLOR_SCHEME = "(prefers-color-scheme: light)";

/**
 * localStorage is unavailable in hardened browser contexts, so every read falls
 * back to a default and every write is best effort — the setting still applies
 * to the current page either way.
 */
function storage(): PreferenceStorage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

function prefersLightColorScheme(): boolean {
  return matchMedia(SYSTEM_COLOR_SCHEME).matches;
}

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

/** Keeps a stored preference separate from the color applied to the document. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => readStoredThemePreference(storage()));
  const [prefersLight, setPrefersLight] = useState(prefersLightColorScheme);
  const resolvedTheme = resolveTheme(theme, prefersLight);

  useEffect(() => {
    if (theme !== "system") return;
    const media = matchMedia(SYSTEM_COLOR_SCHEME);
    const update = () => setPrefersLight(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  useEffect(() => {
    rememberThemePreference(storage(), theme);
  }, [theme]);

  return [theme, setTheme, resolvedTheme] as const;
}

export function useInterfaceScale() {
  const [scale, setScale] = useState<InterfaceScale>(() => readStoredInterfaceScalePreference(storage()));
  useEffect(() => {
    const apply = () => applyInterfaceScale(scale);
    apply();
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [scale]);
  useEffect(() => {
    rememberInterfaceScalePreference(storage(), scale);
  }, [scale]);
  return [scale, setScale] as const;
}

function readInitialSyntaxTheme(): SyntaxThemePreference {
  return readStoredPreference(
    storage(),
    SYNTAX_THEME_KEY,
    readSyntaxThemePreference,
    DEFAULT_SYNTAX_THEME_PREFERENCE,
  );
}

export function useSyntaxTheme(colorTheme: ColorTheme) {
  const [theme, setTheme] = useState<SyntaxThemePreference>(readInitialSyntaxTheme);
  const resolvedTheme = resolveSyntaxTheme(theme, colorTheme);
  useEffect(() => {
    document.documentElement.dataset.syntaxTheme = resolvedTheme;
    setSyntaxTheme(resolvedTheme);
  }, [resolvedTheme]);
  useEffect(() => {
    rememberStoredPreference(storage(), SYNTAX_THEME_KEY, theme);
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
