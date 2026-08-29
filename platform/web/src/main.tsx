import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./client/App";
import "./client/styles.css";

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
