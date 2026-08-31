import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./client/App";
import "./client/styles.css";
import {
  DEFAULT_SYNTAX_THEME,
  isSyntaxTheme,
  setSyntaxTheme,
  startSyntaxHighlighting,
} from "./shared/syntax-highlighting";

let savedTheme: string | null = null;
try {
  savedTheme = localStorage.getItem("pylon-theme");
} catch {
  /* Use the system theme when storage is unavailable. */
}
document.documentElement.dataset.theme =
  savedTheme === "light" || savedTheme === "dark"
    ? savedTheme
    : matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";

let savedSyntaxTheme: string | null = null;
try {
  savedSyntaxTheme = localStorage.getItem("pylon-syntax-theme");
} catch {
  /* Use One Dark Pro when storage is unavailable. */
}
const syntaxTheme = isSyntaxTheme(savedSyntaxTheme) ? savedSyntaxTheme : DEFAULT_SYNTAX_THEME;
document.documentElement.dataset.syntaxTheme = syntaxTheme;
setSyntaxTheme(syntaxTheme);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

void startSyntaxHighlighting();
