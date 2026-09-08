import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./client/app/app";
import "./client/app/styles.css";
import {
  applyTheme,
  readStoredPreference,
  readStoredThemePreference,
  resolveTheme,
  type PreferenceStorage,
} from "./client/app/appearance";
import {
  DEFAULT_SYNTAX_THEME_PREFERENCE,
  readSyntaxThemePreference,
  resolveSyntaxTheme,
  setSyntaxTheme,
  startSyntaxHighlighting,
  SYNTAX_THEME_KEY,
} from "./client/rendering/syntax-highlighting";

function storage(): PreferenceStorage | undefined {
  try {
    return localStorage;
  } catch {
    return undefined;
  }
}

const colorTheme = resolveTheme(readStoredThemePreference(storage()), matchMedia("(prefers-color-scheme: light)").matches);
applyTheme(colorTheme);

const syntaxTheme = resolveSyntaxTheme(
  readStoredPreference(storage(), SYNTAX_THEME_KEY, readSyntaxThemePreference, DEFAULT_SYNTAX_THEME_PREFERENCE),
  colorTheme,
);
document.documentElement.dataset.syntaxTheme = syntaxTheme;
setSyntaxTheme(syntaxTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void startSyntaxHighlighting();
