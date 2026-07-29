import { realpath } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import type { PiDriver } from "../pi/pi-driver.ts";
import { requestAllowed, SessionStore, validCsrf, validTabId, type SecurityOptions } from "./security.ts";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_BUFFERED_OUTPUT = 1024 * 1024;

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export function terminalShell(platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  return platform === "win32" ? "powershell.exe" : env.SHELL?.trim() || "/bin/sh";
}

export function parseTerminalMessage(value: unknown): TerminalClientMessage | undefined {
  if (!value || typeof value !== "object") return;
  const message = value as Record<string, unknown>;
  if (message.type === "input" && typeof message.data === "string" && Buffer.byteLength(message.data) <= MAX_INPUT_BYTES) {
    return { type: "input", data: message.data };
  }
  if (message.type === "resize" && Number.isSafeInteger(message.cols) && Number.isSafeInteger(message.rows)
    && Number(message.cols) >= 2 && Number(message.cols) <= 500 && Number(message.rows) >= 2 && Number(message.rows) <= 300) {
    return { type: "resize", cols: Number(message.cols), rows: Number(message.rows) };
  }
}

interface Connection {
  socket: WebSocket;
  terminal: pty.IPty;
  sessionId: string;
  generation: number;
  owner: symbol;
}

export class TerminalServer {
  private readonly webSockets = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: MAX_INPUT_BYTES + 1024 });
  private readonly connections = new Set<Connection>();
  private owner?: symbol;
  private readonly unsubscribe: () => void;

  constructor(private readonly driver: PiDriver, private readonly sessions: SessionStore, private readonly options: SecurityOptions) {
    this.unsubscribe = driver.subscribe((event) => {
      if (event.type !== "session.replaced" && event.type !== "session.unavailable") return;
      this.owner = undefined;
      for (const connection of [...this.connections]) this.close(connection, 1012, "Session changed");
    });
  }

  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let reservation: symbol | undefined;
    try {
      if (!requestAllowed(request, this.options)) return reject(socket, 403, "Forbidden");
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname !== "/api/v1/terminal") return reject(socket, 404, "Not Found");
      const session = this.sessions.get(request);
      const tabId = url.searchParams.get("tabId") ?? undefined;
      const generation = Number(url.searchParams.get("generation"));
      if (!validCsrf(session, url.searchParams.get("csrf") ?? undefined) || !validTabId(tabId) || !session?.tabs.has(tabId)) {
        return reject(socket, 403, "Forbidden");
      }
      if (!Number.isSafeInteger(generation) || generation < 1) return reject(socket, 400, "Invalid generation");
      if (this.owner) return reject(socket, 409, "Terminal is already open");
      if (!this.driver.terminalTarget) return reject(socket, 501, "Terminal unavailable");
      const target = this.driver.terminalTarget();
      if (target.sessionGeneration !== generation) return reject(socket, 409, "Stale session generation");
      reservation = Symbol(tabId);
      this.owner = reservation;
      const cwd = await realpath(target.cwd);
      const current = this.driver.terminalTarget();
      if (current.sessionId !== target.sessionId || current.sessionGeneration !== generation || current.cwd !== target.cwd) {
        if (this.owner === reservation) this.owner = undefined;
        return reject(socket, 409, "Session changed while opening terminal");
      }
      const owner = reservation;
      this.webSockets.handleUpgrade(request, socket, head, (webSocket) => this.connect(webSocket, owner, target.sessionId, generation, cwd));
      reservation = undefined;
    } catch {
      if (this.owner === reservation) this.owner = undefined;
      reject(socket, 500, "Terminal unavailable");
    }
  }

  dispose(): void {
    this.unsubscribe();
    for (const connection of [...this.connections]) this.close(connection, 1001, "Server closing");
    this.webSockets.close();
  }

  private connect(socket: WebSocket, owner: symbol, sessionId: string, generation: number, cwd: string): void {
    let terminal: pty.IPty;
    try {
      terminal = pty.spawn(terminalShell(), [], {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
    } catch (error) {
      if (this.owner === owner) this.owner = undefined;
      try {
        socket.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : "Unable to start terminal" }), () => socket.close(1011, "Unable to start terminal"));
      } catch { socket.terminate(); }
      return;
    }
    const connection = { socket, terminal, sessionId, generation, owner };
    this.connections.add(connection);
    if (!this.send(connection, { type: "ready" })) return;
    terminal.onData((data) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_OUTPUT) return this.close(connection, 1013, "Terminal output overflow");
      this.send(connection, { type: "output", data });
    });
    terminal.onExit(({ exitCode }) => {
      if (socket.readyState === WebSocket.OPEN) this.send(connection, { type: "exit", code: exitCode });
      this.close(connection, 1000, "Terminal exited");
    });
    socket.on("message", (data, binary) => {
      if (binary) return this.close(connection, 1003, "Text messages required");
      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); }
      catch { return this.close(connection, 1007, "Invalid terminal message"); }
      const message = parseTerminalMessage(parsed);
      if (!message) return this.close(connection, 1008, "Invalid terminal message");
      if (message.type === "input") terminal.write(message.data);
      else terminal.resize(message.cols, message.rows);
    });
    socket.once("close", () => this.close(connection));
    socket.once("error", () => this.close(connection));
  }

  private send(connection: Connection, payload: object): boolean {
    if (connection.socket.readyState !== WebSocket.OPEN) return false;
    try {
      connection.socket.send(JSON.stringify(payload), (error) => { if (error) this.close(connection); });
      return true;
    } catch {
      this.close(connection);
      return false;
    }
  }

  private close(connection: Connection, code?: number, reason?: string, killTerminal = true): void {
    if (!this.connections.delete(connection)) return;
    if (killTerminal) try { connection.terminal.kill(); } catch { /* Process already exited. */ }
    if (connection.socket.readyState === WebSocket.OPEN && code) connection.socket.close(code, reason);
    else if (connection.socket.readyState !== WebSocket.CLOSED) connection.socket.terminate();
    if (this.owner === connection.owner) this.owner = undefined;
  }
}

function reject(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
