import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./client/App";
import "./client/styles.css";

const savedTheme = localStorage.getItem("pylon-theme");
document.documentElement.dataset.theme = savedTheme === "light" || savedTheme === "dark"
  ? savedTheme
  : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
