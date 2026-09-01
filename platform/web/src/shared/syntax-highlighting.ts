export const SYNTAX_THEMES = [
  { id: "one-dark-pro", label: "One Dark Pro" },
  { id: "github-dark", label: "GitHub Dark" },
  { id: "dracula", label: "Dracula" },
  { id: "nord", label: "Nord" },
  { id: "github-light", label: "GitHub Light" },
] as const;

export type SyntaxTheme = (typeof SYNTAX_THEMES)[number]["id"];

export const DEFAULT_SYNTAX_THEME: SyntaxTheme = "one-dark-pro";

type SyntaxRuntime = typeof import("./syntax-highlighting-runtime.ts");
type Listener = () => void;

let activeTheme: SyntaxTheme = DEFAULT_SYNTAX_THEME;
let runtime: SyntaxRuntime | undefined;
let loading: Promise<void> | undefined;
let revision = 0;
const listeners = new Set<Listener>();

export function isSyntaxTheme(value: string | undefined | null): value is SyntaxTheme {
  return SYNTAX_THEMES.some(theme => theme.id === value);
}

export function getSyntaxTheme(): SyntaxTheme {
  return activeTheme;
}

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

function installTokenStyles(css: string): void {
  if (typeof document === "undefined" || document.getElementById("pylon-syntax-token-colors")) return;
  const style = document.createElement("style");
  style.id = "pylon-syntax-token-colors";
  style.textContent = css;
  document.head.append(style);
}
