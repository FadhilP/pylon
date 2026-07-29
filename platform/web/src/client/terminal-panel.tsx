import { IconTerminal2, IconX } from "@tabler/icons-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { runtimeStore } from "./runtime/event-store";

function terminalTheme() {
  return document.documentElement.dataset.theme === "dark" ? {
    background: "#12161c",
    foreground: "#e7eaf0",
    cursor: "#b8d5df",
    selectionBackground: "#314853",
    black: "#1b1f27",
    red: "#ff6b6b",
    green: "#5af78e",
    yellow: "#f3d36a",
    blue: "#57adff",
    magenta: "#ff7ab2",
    cyan: "#46d9ff",
    white: "#f1f3f5",
    brightBlack: "#9ba6b2",
    brightRed: "#ff8a8a",
    brightGreen: "#7dffa8",
    brightYellow: "#ffe58a",
    brightBlue: "#7cc4ff",
    brightMagenta: "#ff9dcc",
    brightCyan: "#72e6ff",
    brightWhite: "#ffffff",
  } : {
    background: "#f5f6f7",
    foreground: "#1b1e23",
    cursor: "#456879",
    selectionBackground: "#cddfe7",
    black: "#20242b",
    red: "#c5221f",
    green: "#087a35",
    yellow: "#8a5a00",
    blue: "#075fd8",
    magenta: "#a21973",
    cyan: "#00758a",
    white: "#4a5058",
    brightBlack: "#626b76",
    brightRed: "#cf222e",
    brightGreen: "#087a35",
    brightYellow: "#8f6000",
    brightBlue: "#0969da",
    brightMagenta: "#bf3989",
    brightCyan: "#00758a",
    brightWhite: "#111418",
  };
}

export function TerminalPanel({ open, cwdLabel, onClose }: { open: boolean; cwdLabel?: string; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState("Connecting…");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 5_000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    terminalRef.current = terminal;
    fitRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(host);
    const socket = new WebSocket(runtimeStore.terminalUrl());
    let disposed = false;
    let ready = false;
    const send = (value: object) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
    };
    const fitTerminal = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      try { fit.fit(); } catch { /* Drawer may be between layouts. */ }
    };
    const observer = new ResizeObserver(fitTerminal);
    observer.observe(host);
    const themeObserver = new MutationObserver(() => { terminal.options.theme = terminalTheme(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const input = terminal.onData((data) => send({ type: "input", data }));
    const resize = terminal.onResize(({ cols, rows }) => ready && send({ type: "resize", cols, rows }));
    socket.addEventListener("message", (event) => {
      let message: { type?: string; data?: string; message?: string; code?: number };
      try { message = JSON.parse(String(event.data)); }
      catch { return; }
      if (message.type === "output" && typeof message.data === "string") terminal.write(message.data);
      else if (message.type === "ready") {
        ready = true;
        setStatus("Connected");
        requestAnimationFrame(() => {
          fitTerminal();
          send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
          terminal.focus();
        });
      } else if (message.type === "error") {
        setStatus(message.message || "Terminal unavailable");
        terminal.writeln(`\r\n${message.message || "Terminal unavailable"}`);
      } else if (message.type === "exit") {
        setStatus(`Exited (${message.code ?? 0})`);
      }
    });
    socket.addEventListener("close", (event) => {
      if (disposed) return;
      ready = false;
      const message = event.reason || (event.code === 1000 ? "Terminal closed" : "Terminal disconnected");
      setStatus(message);
      terminal.writeln(`\r\n[${message}]`);
    });
    socket.addEventListener("error", () => setStatus("Connection failed"));
    return () => {
      disposed = true;
      observer.disconnect();
      themeObserver.disconnect();
      input.dispose();
      resize.dispose();
      socket.close(1000, "Terminal disposed");
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      try { fitRef.current?.fit(); } catch { /* Drawer may still be entering layout. */ }
      terminalRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return <section className="terminal-drawer" aria-label="Terminal" hidden={!open}>
    <header>
      <span><IconTerminal2 size={15} /><strong>Terminal</strong>{cwdLabel && <small title={cwdLabel}>{cwdLabel}</small>}</span>
      <span className="terminal-status" role="status">{status}</span>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close terminal"><IconX size={16} /></button>
    </header>
    <div ref={hostRef} className="terminal-host" />
  </section>;
}
