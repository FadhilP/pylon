import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { terminateProcessTree } from "./process.ts";

const HELPER_PATH = fileURLToPath(new URL("./playwright-client-helper.mjs", import.meta.url));
const SUPPORTED_CLI_VERSION = "0.1.18";
const MAX_PROTOCOL_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const START_TIMEOUT_MS = 5_000;

type FailureReason = "cancelled" | "timeout" | "unavailable" | "protocol";

export class PlaywrightClientError extends Error {
  readonly dispatched: boolean;
  readonly reason: FailureReason;

  constructor(reason: FailureReason, dispatched: boolean, message: string) {
    super(message);
    this.name = "PlaywrightClientError";
    this.reason = reason;
    this.dispatched = dispatched;
  }
}

interface PendingRequest {
  id: number;
  dispatched: boolean;
  resolve(result: ExecResult): void;
  reject(error: PlaywrightClientError): void;
  cleanup(): void;
}

function validResult(value: unknown): value is ExecResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return Number.isInteger(result.code) && typeof result.stdout === "string" && typeof result.stderr === "string" && typeof result.killed === "boolean";
}

export class PlaywrightClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending?: PendingRequest;
  private nextId = 1;
  private stdout = "";
  private stderr = "";
  private dead = false;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  private constructor(directory: string) {
    this.child = spawn(process.execPath, [HELPER_PATH], {
      cwd: directory,
      detached: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr += chunk;
      if (Buffer.byteLength(this.stderr) > MAX_STDERR_BYTES) this.fail("protocol", "Playwright helper error output exceeded its limit");
    });
    this.child.once("error", () => this.fail("unavailable", "Could not start Playwright helper"));
    this.child.once("exit", () => this.fail("unavailable", "Playwright helper exited"));
  }

  static async create(directory: string): Promise<PlaywrightClient> {
    const client = new PlaywrightClient(directory);
    const timeout = setTimeout(() => client.fail("timeout", "Playwright helper startup timed out"), START_TIMEOUT_MS);
    timeout.unref?.();
    try {
      await client.ready;
      return client;
    } catch (error) {
      await client.dispose().catch(() => {});
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async run(sessionName: string, command: string, args: string[], signal: AbortSignal | undefined, timeoutMs: number): Promise<ExecResult> {
    if (this.pending) throw new PlaywrightClientError("protocol", false, "Playwright helper already has an active request");
    if (this.dead || !this.child.stdin.writable) throw new PlaywrightClientError("unavailable", false, "Playwright helper is unavailable");
    if (signal?.aborted) throw new PlaywrightClientError("cancelled", false, "Browser action cancelled");
    const id = this.nextId++;
    const payload = `${JSON.stringify({ id, sessionName, command, args })}\n`;
    return new Promise<ExecResult>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const abort = () => {
        const pending = this.pending;
        if (!pending || pending.id !== id) return;
        pending.reject(new PlaywrightClientError("cancelled", pending.dispatched, "Browser action cancelled"));
        void this.dispose();
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.pending?.id === id) this.pending = undefined;
      };
      this.pending = {
        id,
        dispatched: false,
        resolve: (result) => { cleanup(); resolve(result); },
        reject: (error) => { cleanup(); reject(error); },
        cleanup,
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => {
        const pending = this.pending;
        if (!pending || pending.id !== id) return;
        pending.reject(new PlaywrightClientError("timeout", pending.dispatched, "Playwright helper command timed out"));
        void this.dispose();
      }, timeoutMs);
      timer.unref?.();
      try {
        this.child.stdin.write(payload, (error) => {
          if (!error) return;
          const pending = this.pending;
          if (pending?.id === id) pending.reject(new PlaywrightClientError("unavailable", pending.dispatched, "Could not write to Playwright helper"));
        });
        this.pending.dispatched = true;
      } catch {
        this.pending?.reject(new PlaywrightClientError("unavailable", false, "Could not write to Playwright helper"));
      }
    });
  }

  async dispose(): Promise<void> {
    if (!this.dead) {
      this.dead = true;
      this.pending?.reject(new PlaywrightClientError("unavailable", this.pending.dispatched, "Playwright helper stopped"));
      this.rejectReady(new Error("Playwright helper stopped"));
    }
    this.child.stdin.destroy();
    await terminateProcessTree(this.child, "Playwright helper", 500, 2_000).catch(() => {});
  }

  private consume(chunk: string): void {
    this.stdout += chunk;
    if (Buffer.byteLength(this.stdout) > MAX_PROTOCOL_BYTES) return this.fail("protocol", "Playwright helper output exceeded its limit");
    let newline: number;
    while ((newline = this.stdout.indexOf("\n")) !== -1) {
      const line = this.stdout.slice(0, newline);
      this.stdout = this.stdout.slice(newline + 1);
      if (line) this.message(line);
    }
  }

  private message(line: string): void {
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { return this.fail("protocol", "Playwright helper returned malformed output"); }
    if (!message || typeof message !== "object" || Array.isArray(message)) return this.fail("protocol", "Playwright helper returned invalid output");
    const value = message as Record<string, unknown>;
    if (value.type === "ready") {
      if (value.version !== SUPPORTED_CLI_VERSION) return this.fail("protocol", "Playwright helper version is incompatible");
      this.resolveReady();
      return;
    }
    if (value.type === "fatal") return this.fail("protocol", "Playwright helper compatibility check failed");
    if (value.type !== "result" || !Number.isSafeInteger(value.id) || !validResult(value.result)) return this.fail("protocol", "Playwright helper returned invalid output");
    if (!this.pending || value.id !== this.pending.id) return this.fail("protocol", "Playwright helper returned an unexpected response");
    this.pending.resolve(value.result);
  }

  private fail(reason: FailureReason, message: string): void {
    if (this.dead) return;
    this.dead = true;
    this.rejectReady(new Error(message));
    this.pending?.reject(new PlaywrightClientError(reason, this.pending.dispatched, message));
    this.child.stdin.destroy();
    void terminateProcessTree(this.child, "Playwright helper", 500, 2_000).catch(() => {});
  }
}
