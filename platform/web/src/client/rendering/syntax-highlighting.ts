import type { ColorTheme } from "../app/appearance.ts";

export const SYNTAX_THEMES = [
  { id: "one-dark-pro", label: "One Dark Pro" },
  { id: "github-dark", label: "GitHub Dark" },
  { id: "dracula", label: "Dracula" },
  { id: "nord", label: "Nord" },
  { id: "github-light", label: "GitHub Light" },
] as const;

export const SYNTAX_THEME_PREFERENCES = [{ id: "auto", label: "Auto" }, ...SYNTAX_THEMES] as const;

export type SyntaxTheme = (typeof SYNTAX_THEMES)[number]["id"];
export type SyntaxThemePreference = (typeof SYNTAX_THEME_PREFERENCES)[number]["id"];
export interface SyntaxToken {
  content: string;
  className: string;
}

/** Runtime fallback when a syntax preference cannot be resolved. */
export const DEFAULT_SYNTAX_THEME: SyntaxTheme = "one-dark-pro";
/** New and reset syntax preferences follow the color theme. */
export const DEFAULT_SYNTAX_THEME_PREFERENCE: SyntaxThemePreference = "auto";

export function isSyntaxTheme(value: string | undefined | null): value is SyntaxTheme {
  return SYNTAX_THEMES.some(theme => theme.id === value);
}

export function isSyntaxThemePreference(value: unknown): value is SyntaxThemePreference {
  return value === "auto" || isSyntaxTheme(value as string | undefined | null);
}

export function readSyntaxThemePreference(value: unknown): SyntaxThemePreference {
  return isSyntaxThemePreference(value) ? value : DEFAULT_SYNTAX_THEME_PREFERENCE;
}

export function resolveSyntaxTheme(preference: SyntaxThemePreference, colorTheme: ColorTheme): SyntaxTheme {
  if (preference !== "auto") return preference;
  return colorTheme === "dark" ? "one-dark-pro" : "github-light";
}
export const SYNTAX_THEME_KEY = "pylon-syntax-theme";

type SyntaxRuntime = typeof import("./syntax-highlighting-runtime.ts");
type Listener = () => void;

let activeTheme: SyntaxTheme = DEFAULT_SYNTAX_THEME;
let runtime: SyntaxRuntime | undefined;
let loading: Promise<void> | undefined;
let revision = 0;
const listeners = new Set<Listener>();
export const getSyntaxTheme = (): SyntaxTheme => activeTheme;
export function setSyntaxTheme(theme: SyntaxTheme): void {
  if (theme === activeTheme) return;
  activeTheme = theme;
  notify();
}

export function startSyntaxHighlighting(): Promise<void> {
  loading ??= import("./syntax-highlighting-runtime.ts")
    .then(loaded => {
      runtime = loaded;
      installTokenStyles(loaded.syntaxThemeTokenCss);
      notify();
    })
    .catch(() => {
      // Safe escaped code remains readable when the optional highlighter fails to load.
    });
  return loading;
}

export function highlightSyntax(text: string, language: string): string | undefined {
  return runtime?.highlightSyntax(text, language, activeTheme);
}

export function syntaxTokens(text: string, language: string): SyntaxToken[][] {
  return (
    runtime?.syntaxTokens(text, language, activeTheme) ?? text.split("\n").map(content => [{ content, className: "" }])
  );
}

export async function loadSyntaxLanguage(language: string): Promise<void> {
  await startSyntaxHighlighting();
  if (await runtime?.loadSyntaxLanguage(language)) notify();
}

export function subscribeSyntaxHighlighting(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSyntaxHighlightingRevision(): number {
  return revision;
}

function notify(): void {
  revision++;
  for (const listener of listeners) listener();
}

export function installTokenStyles(css: string): void {
  if (typeof document === "undefined" || document.getElementById("pylon-syntax-token-colors")) return;
  const style = document.createElement("style");
  style.id = "pylon-syntax-token-colors";
  style.textContent = css;
  document.head.append(style);
}
