export const THEME_KEY = "pylon-theme";

export const INTERFACE_SCALE_KEY = "pylon-interface-scale";
export const INTERFACE_SCALES = [0.85, 1, 1.15, 1.3] as const;
export type InterfaceScale = (typeof INTERFACE_SCALES)[number];
export const DEFAULT_INTERFACE_SCALE: InterfaceScale = 1;

export const COLOR_THEMES = ["light", "dark", "warm"] as const;
export type ColorTheme = (typeof COLOR_THEMES)[number];
export type Theme = ColorTheme | "system";
export const DEFAULT_THEME: Theme = "system";

export const THEME_COLORS: Record<ColorTheme, string> = {
  dark: "#111318",
  light: "#e9eaec",
  warm: "#eee8dd",
};

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function isColorTheme(value: unknown): value is ColorTheme {
  return typeof value === "string" && COLOR_THEMES.includes(value as ColorTheme);
}

export function isTheme(value: unknown): value is Theme {
  return value === "system" || isColorTheme(value);
}

export function readThemePreference(value: unknown): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}

export function resolveTheme(theme: Theme, prefersLight: boolean): ColorTheme {
  return theme === "system" ? (prefersLight ? "light" : "dark") : theme;
}

/** Applies only resolved colors; preferences are kept separately in storage. */
export function applyTheme(theme: ColorTheme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
}

export function readInterfaceScalePreference(value: unknown): InterfaceScale {
  const scale = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return INTERFACE_SCALES.includes(scale as InterfaceScale) ? (scale as InterfaceScale) : DEFAULT_INTERFACE_SCALE;
}

export function applyInterfaceScale(scale: InterfaceScale): void {
  document.documentElement.style.setProperty("--interface-scale", String(scale));
  document.documentElement.style.setProperty("--interface-viewport-height", `${window.innerHeight / scale}px`);
}

export function readStoredPreference<T>(
  storage: Pick<PreferenceStorage, "getItem"> | undefined,
  key: string,
  read: (value: unknown) => T,
  fallback: T,
): T {
  try {
    return read(storage?.getItem(key));
  } catch {
    return fallback;
  }
}

export function rememberStoredPreference(
  storage: Pick<PreferenceStorage, "setItem"> | undefined,
  key: string,
  value: string,
): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* The setting still applies for the current page. */
  }
}

export function readStoredThemePreference(storage: Pick<PreferenceStorage, "getItem"> | undefined): Theme {
  return readStoredPreference(storage, THEME_KEY, readThemePreference, DEFAULT_THEME);
}

export function rememberThemePreference(storage: Pick<PreferenceStorage, "setItem"> | undefined, theme: Theme): void {
  rememberStoredPreference(storage, THEME_KEY, theme);
}
export function readStoredInterfaceScalePreference(
  storage: Pick<PreferenceStorage, "getItem"> | undefined,
): InterfaceScale {
  return readStoredPreference(
    storage,
    INTERFACE_SCALE_KEY,
    readInterfaceScalePreference,
    DEFAULT_INTERFACE_SCALE,
  );
}

export function rememberInterfaceScalePreference(
  storage: Pick<PreferenceStorage, "setItem"> | undefined,
  scale: InterfaceScale,
): void {
  rememberStoredPreference(storage, INTERFACE_SCALE_KEY, String(scale));
}
