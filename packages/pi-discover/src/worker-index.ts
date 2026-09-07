import { Worker } from "node:worker_threads";
import type { WorkspaceIndex } from "./index.ts";
import type { IndexExecutor } from "./repository-scanner.ts";

type Method = "refresh" | "rebuild" | "prune" | "ensureFresh" | "searchSymbols" | "searchCode" | "status" | "close";
type Pending = { resolve(value: any): void; reject(error: Error): void };

/** Keep SQLite and symbol extraction off the host event loop, including reads and close. */
export class WorkerIndex {
  private readonly worker: Worker;
  private readonly exec: IndexExecutor;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private failure?: Error;
  private closing?: Promise<void>;

  constructor(cwd: string, exec: IndexExecutor, path: string, timeout: number, filesystemVerifyIntervalMs?: number) {
    this.exec = exec;
    this.worker = new Worker(new URL("./index-worker.mjs", import.meta.url), {
      workerData: { cwd, path, timeout, filesystemVerifyIntervalMs },
      // The bootstrap supplies its own TS loader; do not inherit host test, profiler or loader hooks.
      execArgv: [],
    });
    this.worker.on("message", message => {
      if (message.type === "exec") {
        void this.execute(message);
        return;
      }
      if (message.type !== "result") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
      else {
        if (Array.isArray(message.value) && message.moreAvailable) message.value.moreAvailable = true;
        pending.resolve(message.value);
      }
    });
    this.worker.on("error", error => this.fail(error instanceof Error ? error : new Error(String(error))));
    this.worker.on("exit", code => this.fail(new Error(`Index worker exited (${code})`)));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  private async execute(message: { id: number; command: string; args: string[]; options: { timeout: number } }) {
    try {
      // Only the scanner's bounded Git executor crosses this boundary.
      if (
        message.command !== "git" ||
        !Array.isArray(message.args) ||
        !message.args.every(arg => typeof arg === "string") ||
        !Number.isFinite(message.options?.timeout) ||
        message.options.timeout <= 0
      )
        throw new Error("Invalid index execution request");
      const value = await this.exec(message.command, message.args, message.options);
      if (!this.failure) this.worker.postMessage({ type: "exec-result", id: message.id, value });
    } catch (error: any) {
      if (!this.failure)
        this.worker.postMessage({
          type: "exec-result",
          id: message.id,
          error: { message: String(error?.message ?? error), code: error?.code },
        });
    }
  }

  private call<M extends Method>(method: M, args: Parameters<WorkspaceIndex[M]>): ReturnType<WorkspaceIndex[M]> {
    const result = new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      if (this.closing && method !== "close") return reject(new Error("Index worker is closing"));
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ type: "call", id, method, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
    return result as ReturnType<WorkspaceIndex[M]>;
  }

  refresh() {
    return this.call("refresh", []);
  }
  rebuild() {
    return this.call("rebuild", []);
  }
  prune() {
    return this.call("prune", []);
  }
  ensureFresh() {
    return this.call("ensureFresh", []);
  }
  searchSymbols(...args: Parameters<WorkspaceIndex["searchSymbols"]>) {
    return this.call("searchSymbols", args);
  }
  searchCode(...args: Parameters<WorkspaceIndex["searchCode"]>) {
    return this.call("searchCode", args);
  }
  status() {
    return this.call("status", []);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    // All accepted calls must finish, including search's asynchronous preparation.
    const accepted = [...this.pending.values()].map(
      pending =>
        new Promise<void>(resolve => {
          const done = pending.resolve,
            failed = pending.reject;
          pending.resolve = value => {
            done(value);
            resolve();
          };
          pending.reject = error => {
            failed(error);
            resolve();
          };
        }),
    );
    this.closing = (async () => {
      try {
        await Promise.all(accepted);
        if (!this.failure) await this.call("close", []);
      } finally {
        await this.worker.terminate();
      }
    })();
    return this.closing;
  }
}
