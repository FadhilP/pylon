import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IndexProvider } from "./index.ts";
import { boundedError } from "./search-common.ts";

export type IndexLifecycle = {
  /** Queue a background refresh for `ctx.cwd`, coalescing repeat requests. */
  scheduleRefresh(ctx?: { cwd?: string }): void;
  /** Handle a `pi-discover:index-action` rebuild request. */
  handleAction(request: any): void;
  /** Run the `/discover-index` command. */
  runCommand(args: string, ctx: any): Promise<void>;
  healthLine(): string;
  hasError(): boolean;
  /** Stop scheduling and wait for any in-flight refresh. */
  stop(): Promise<void>;
  publishUnavailable(): void;
};

const COMMAND_ACTIONS = ["refresh", "rebuild", "prune", "status"] as const;
type CommandAction = (typeof COMMAND_ACTIONS)[number];

const ACTIVITY: Record<CommandAction, string> = {
  refresh: "Refreshing index...",
  rebuild: "Rebuilding index...",
  prune: "Pruning stale index entries...",
  status: "Reading index status...",
};

/** Owns the background indexing state machine and everything that reports on it. */
export function createIndexLifecycle(pi: ExtensionAPI, indexFor: IndexProvider): IndexLifecycle {
  let latestError: string | undefined;
  let ready = false;
  let activeCwd = "";
  let indexing = false;
  let pendingCwd: string | undefined;
  let background: Promise<void> | undefined;
  let shuttingDown = false;

  const emit = (state: Record<string, unknown>) =>
    pi.events.emit("pi-discover:index-state", { version: 1, available: true, ...state });

  const publishState = async (cwd = activeCwd) => {
    if (!cwd) return;
    if (indexing) return emit({ state: "indexing" });
    if (latestError) return emit({ state: "error", error: latestError });
    try {
      const status = (await indexFor(cwd).status()) as Record<string, unknown>;
      const indexedAt =
        Number.isSafeInteger(status.indexed_at) && (status.indexed_at as number) >= 0
          ? new Date(status.indexed_at as number).toISOString()
          : undefined;
      emit({ state: "idle", files: status.files, symbols: status.symbols, indexedAt });
    } catch (error) {
      latestError = boundedError(error);
      emit({ state: "error", error: latestError });
    }
  };

  /** Run one index operation with the shared indexing flag, state events, and error capture. */
  const withIndexing = async (work: () => Promise<void>): Promise<string | undefined> => {
    indexing = true;
    await publishState();
    try {
      await work();
      latestError = undefined;
      ready = true;
    } catch (error) {
      latestError = boundedError(error);
    } finally {
      indexing = false;
      await publishState();
    }
    return latestError;
  };

  const scheduleRefresh = (ctx?: { cwd?: string }) => {
    if (!ctx?.cwd || shuttingDown) return;
    activeCwd = ctx.cwd;
    pendingCwd = ctx.cwd;
    if (background) return;
    background = (async () => {
      while (pendingCwd && !shuttingDown) {
        const cwd = pendingCwd;
        pendingCwd = undefined;
        activeCwd = cwd;
        await withIndexing(() => indexFor(cwd).refresh());
      }
    })()
      .catch(error => {
        latestError = boundedError(error);
        indexing = false;
        emit({ state: "error", error: latestError });
      })
      .finally(() => {
        background = undefined;
        if (pendingCwd && !shuttingDown) scheduleRefresh({ cwd: pendingCwd });
      });
  };

  return {
    scheduleRefresh,
    hasError: () => Boolean(latestError),
    healthLine: () => `Index: ${latestError ? `refresh failed: ${latestError}` : ready ? "ready" : "not initialized"}`,
    publishUnavailable: () => pi.events.emit("pi-discover:index-state", { version: 1, available: false }),

    async stop() {
      shuttingDown = true;
      pendingCwd = undefined;
      await background;
    },

    handleAction(request: any) {
      if (
        request?.version !== 1 ||
        request.action !== "rebuild" ||
        typeof request.acknowledge !== "function" ||
        typeof request.resolve !== "function" ||
        typeof request.reject !== "function"
      )
        return;
      request.acknowledge();
      void (async () => {
        if (!activeCwd || indexing)
          throw new Error(indexing ? "the index is already rebuilding" : "pi-discover has no active workspace");
        const failure = await withIndexing(() => indexFor(activeCwd).rebuild());
        if (failure) request.reject(new Error(failure));
        else request.resolve();
      })().catch(error => request.reject(error));
    },

    async runCommand(args: string, ctx: any) {
      const action = (args.trim() || "refresh") as CommandAction;
      if (!COMMAND_ACTIONS.includes(action)) {
        ctx.ui.notify("Usage: /discover-index [refresh|rebuild|prune|status]", "error");
        return;
      }
      await ctx.waitForIdle?.();
      if (indexing) {
        ctx.ui.notify("pi-discover indexing is already in progress.", "warning");
        return;
      }
      ctx.ui.setStatus("pi-discover-index", ACTIVITY[action]);
      activeCwd = ctx.cwd;
      indexing = action !== "status";
      await publishState();
      try {
        const index = indexFor(ctx.cwd);
        let result;
        if (action === "prune") result = await index.prune();
        else {
          if (action === "refresh") await index.refresh();
          else if (action === "rebuild") await index.rebuild();
          result = await index.status();
        }
        latestError = undefined;
        ready = true;
        ctx.ui.notify(
          `pi-discover index ${action === "status" ? "status" : `${action} complete`}: ${JSON.stringify(result)}`,
          "info",
        );
      } catch (error) {
        latestError = boundedError(error);
        ctx.ui.notify(`pi-discover index ${action} failed: ${latestError}`, "error");
      } finally {
        indexing = false;
        await publishState();
        ctx.ui.setStatus("pi-discover-index", undefined);
      }
    },
  };
}
