import { accessSync, constants, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import * as pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import type { PiDriver } from "../runtime/pi-driver.ts";
import { requestAllowed, SessionStore, validCsrf, validTabId, type SecurityOptions } from "./security.ts";

const MAX_INPUT_BYTES = 64 * 1024;
const MAX_BUFFERED_OUTPUT = 1024 * 1024;
const MAX_TERMINALS_PER_PAGE = 8;
const MAX_TERMINALS_TOTAL = 32;

export type TerminalClientMessage = { type: "input"; data: string } | { type: "resize"; cols: number; rows: number };

export type TerminalSpawn = typeof pty.spawn;

function executable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function terminalShell(
  platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  canExecute: (path: string) => boolean = executable,
): string {
  if (platform === "win32") return "powershell.exe";
  const configured = env.SHELL?.trim();
  const candidates = [configured, ...(platform === "darwin" ? ["/bin/zsh"] : []), "/bin/sh"];
  return candidates.find((candidate): candidate is string => Boolean(candidate && canExecute(candidate))) ?? "/bin/sh";
}

/** macOS Terminal launches supported shells as interactive login shells. */
export function terminalShellArgs(platform = process.platform, shell: string): string[] {
  return platform === "darwin" && ["zsh", "bash", "sh", "fish"].includes(basename(shell)) ? ["-l", "-i"] : [];
}

export function parseTerminalMessage(value: unknown): TerminalClientMessage | undefined {
  if (!value || typeof value !== "object") return;
  const message = value as Record<string, unknown>;
  if (
    message.type === "input" &&
    typeof message.data === "string" &&
    Buffer.byteLength(message.data) <= MAX_INPUT_BYTES
  ) {
    return { type: "input", data: message.data };
  }
  if (
    message.type === "resize" &&
    Number.isSafeInteger(message.cols) &&
    Number.isSafeInteger(message.rows) &&
    Number(message.cols) >= 2 &&
    Number(message.cols) <= 500 &&
    Number(message.rows) >= 2 &&
    Number(message.rows) <= 300
  ) {
    return { type: "resize", cols: Number(message.cols), rows: Number(message.rows) };
  }
}

interface Connection {
  socket: WebSocket;
  terminal: pty.IPty;
  projectId: string;
  targetCwd: string;
  ownerKey: string;
  owner: symbol;
}

export class TerminalServer {
  private readonly webSockets = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: MAX_INPUT_BYTES + 1024,
  });
  private readonly connections = new Set<Connection>();
  private readonly owners = new Map<string, symbol>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly driver: PiDriver,
    private readonly sessions: SessionStore,
    private readonly options: SecurityOptions,
    private readonly spawnTerminal: TerminalSpawn = pty.spawn,
  ) {
    this.unsubscribe = driver.subscribe(event => {
      if (event.type === "projects.changed") this.closeUnavailableProjects();
    });
  }

  async handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    let reservation: { ownerKey: string; owner: symbol } | undefined;
    try {
      if (!requestAllowed(request, this.options)) return reject(socket, 403, "Forbidden");
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname !== "/api/v1/terminal") return reject(socket, 404, "Not Found");
      const session = this.sessions.get(request);
      const tabId = url.searchParams.get("tabId") ?? undefined;
      const projectId = url.searchParams.get("projectId") ?? undefined;
      const terminalId = url.searchParams.get("terminalId") ?? undefined;
      if (
        !validCsrf(session, url.searchParams.get("csrf") ?? undefined) ||
        !validTabId(tabId) ||
        !validTabId(projectId) ||
        !validTabId(terminalId) ||
        !session?.tabs.has(tabId)
      ) {
        return reject(socket, 403, "Forbidden");
      }
      if (!this.driver.terminalTarget) return reject(socket, 501, "Terminal unavailable");
      const target = this.driver.terminalTarget(projectId);
      if (!target || target.projectId !== projectId) return reject(socket, 409, "Project unavailable");
      const pageKey = `${session.secret}:${tabId}`;
      const ownerKey = `${pageKey}:${projectId}:${terminalId}`;
      if (this.owners.has(ownerKey)) return reject(socket, 409, "Terminal is already open");
      if (this.owners.size >= MAX_TERMINALS_TOTAL || this.pageOwnerCount(pageKey) >= MAX_TERMINALS_PER_PAGE)
        return reject(socket, 429, "Terminal limit reached");
      const owner = Symbol(terminalId);
      reservation = { ownerKey, owner };
      this.owners.set(ownerKey, owner);
      const cwd = await realpath(target.cwd);
      const current = this.driver.terminalTarget(projectId);
      if (!current || current.projectId !== target.projectId || current.cwd !== target.cwd) {
        if (this.owners.get(ownerKey) === owner) this.owners.delete(ownerKey);
        return reject(socket, 409, "Project changed while opening terminal");
      }
      this.webSockets.handleUpgrade(request, socket, head, webSocket =>
        this.connect(webSocket, ownerKey, owner, projectId, target.cwd, cwd),
      );
      reservation = undefined;
    } catch {
      if (reservation && this.owners.get(reservation.ownerKey) === reservation.owner)
        this.owners.delete(reservation.ownerKey);
      reject(socket, 500, "Terminal unavailable");
    }
  }

  dispose(): void {
    this.unsubscribe();
    for (const connection of [...this.connections]) this.close(connection, 1001, "Server closing");
    this.webSockets.close();
  }

  private connect(
    socket: WebSocket,
    ownerKey: string,
    owner: symbol,
    projectId: string,
    targetCwd: string,
    cwd: string,
  ): void {
    let terminal: pty.IPty;
    try {
      const shell = terminalShell();
      terminal = this.spawnTerminal(shell, terminalShellArgs(process.platform, shell), {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: { ...process.env, SHELL: shell, TERM: "xterm-256color", COLORTERM: "truecolor" },
      });
    } catch (error) {
      if (this.owners.get(ownerKey) === owner) this.owners.delete(ownerKey);
      try {
        socket.send(
          JSON.stringify({
            type: "error",
            message: error instanceof Error ? error.message : "Unable to start terminal",
          }),
          () => socket.close(1011, "Unable to start terminal"),
        );
      } catch {
        socket.terminate();
      }
      return;
    }
    const connection = { socket, terminal, projectId, targetCwd, ownerKey, owner };
    this.connections.add(connection);
    socket.once("close", () => this.close(connection));
    socket.once("error", () => this.close(connection));
    if (!this.send(connection, { type: "ready" })) return this.close(connection);
    terminal.onData(data => {
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
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return this.close(connection, 1007, "Invalid terminal message");
      }
      const message = parseTerminalMessage(parsed);
      if (!message) return this.close(connection, 1008, "Invalid terminal message");
      if (message.type === "input") terminal.write(message.data);
      else terminal.resize(message.cols, message.rows);
    });
  }

  private send(connection: Connection, payload: object): boolean {
    if (connection.socket.readyState !== WebSocket.OPEN) return false;
    try {
      connection.socket.send(JSON.stringify(payload), error => {
        if (error) this.close(connection);
      });
      return true;
    } catch {
      this.close(connection);
      return false;
    }
  }

  private pageOwnerCount(pageKey: string): number {
    const prefix = `${pageKey}:`;
    let count = 0;
    for (const key of this.owners.keys()) if (key.startsWith(prefix)) count++;
    return count;
  }

  private closeUnavailableProjects(): void {
    for (const connection of [...this.connections]) {
      let target;
      try {
        target = this.driver.terminalTarget?.(connection.projectId);
      } catch {
        target = undefined;
      }
      if (!target || target.projectId !== connection.projectId || target.cwd !== connection.targetCwd)
        this.close(connection, 1012, "Project unavailable");
    }
  }

  private close(connection: Connection, code?: number, reason?: string, killTerminal = true): void {
    if (!this.connections.delete(connection)) return;
    if (killTerminal)
      try {
        connection.terminal.kill();
      } catch {
        /* Process already exited. */
      }
    if (connection.socket.readyState === WebSocket.OPEN && code) connection.socket.close(code, reason);
    else if (connection.socket.readyState !== WebSocket.CLOSED) connection.socket.terminate();
    if (this.owners.get(connection.ownerKey) === connection.owner) this.owners.delete(connection.ownerKey);
  }
}

function reject(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}
