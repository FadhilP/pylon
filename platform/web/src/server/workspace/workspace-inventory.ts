import { resolve } from "node:path";
import type { WorkspaceFileDelta, WorkspaceFileInventory } from "pylon-core/src/worktree.ts";

export const WORKSPACE_TOUCH_LIMIT = 100;
const INVENTORY_TTL_MS = 60_000;
const MAX_INVENTORIES = 25;
const FILE_LIMIT = 10_000;

type Inventory = Pick<WorkspaceFileInventory, "revision" | "files" | "truncated">;
interface InventoryState {
  inventory?: Inventory;
  expiresAt: number;
  pending: Set<string>;
  invalidation: number;
  reconciled: number;
  running?: Promise<void>;
  readers: number;
}

interface CollectionContext {
  isCurrent(): boolean;
  collect(): Promise<Inventory>;
  collectDelta?: (paths: string[]) => Promise<WorkspaceFileDelta>;
}

export function workspaceInventoryKey(cwd: string, baselineTree?: string): string {
  const root = resolve(cwd);
  return `${process.platform === "win32" ? root.toLowerCase() : root}\0${baselineTree ?? ""}`;
}

/** Request-driven Phase 2 cache: one writer and one bounded pending batch per inventory key. */
export class WorkspaceInventories {
  private readonly states = new Map<string, InventoryState>();

  constructor(private readonly now: () => number = Date.now) {}

  hint(key: string, path: string): void {
    const state = this.state(key);
    if (state.pending.has(path)) return;
    if (state.pending.size < WORKSPACE_TOUCH_LIMIT) state.pending.add(path);
    else state.invalidation++;
    this.prune();
  }

  invalidate(key: string): void {
    // Keep the writer in place: deleting an active entry would allow a second writer.
    this.state(key).invalidation++;
    this.prune();
  }

  clear(): void {
    this.states.clear();
  }

  async read(key: string, context: CollectionContext, refresh = false): Promise<Inventory> {
    const state = this.state(key);
    state.readers++;
    if (refresh) state.invalidation++;
    try {
      for (;;) {
        if (this.states.get(key) !== state || !context.isCurrent()) {
          throw new Error("Workspace inventory belongs to an obsolete context.");
        }
        if (!state.running) {
          const full = !state.inventory || state.invalidation !== state.reconciled || state.expiresAt <= this.now();
          if (!full && !state.pending.size) return state.inventory!;
          // Detach before awaiting. A repeated hint for an in-flight path is new work.
          const paths = [...state.pending];
          state.pending.clear();
          const invalidation = state.invalidation;
          const running = this.collect(key, state, context, paths, full || !context.collectDelta, invalidation);
          state.running = running;
          void running
            .finally(() => {
              if (state.running === running) state.running = undefined;
            })
            .catch(() => undefined);
        }
        await state.running;
        // Joiners re-evaluate using their own context, including after a stale origin was discarded.
      }
    } finally {
      state.readers--;
      this.prune();
    }
  }

  private async collect(
    key: string,
    state: InventoryState,
    context: CollectionContext,
    paths: string[],
    full: boolean,
    invalidation: number,
  ): Promise<void> {
    try {
      let inventory: Inventory;
      if (full) {
        inventory = await context.collect();
      } else {
        const delta = await context.collectDelta!(paths);
        if (delta.reconcileRequired || (state.inventory!.truncated && delta.removed.length)) {
          state.invalidation++;
          return;
        }
        const files = new Map(state.inventory!.files.map(file => [file.path, file]));
        for (const path of delta.removed) files.delete(path);
        for (const file of delta.upserted) files.set(file.path, file);
        const patched = [...files.values()].sort(
          (left, right) =>
            Number(Boolean(right.status)) - Number(Boolean(left.status)) || left.path.localeCompare(right.path),
        );
        inventory = {
          revision: delta.revision,
          files: patched.slice(0, FILE_LIMIT),
          truncated: state.inventory!.truncated || patched.length > FILE_LIMIT,
        };
      }
      if (this.states.get(key) !== state || !context.isCurrent()) {
        state.invalidation++;
        return;
      }
      // Neither a delta nor a full scan may acknowledge a later broad invalidation.
      if (state.invalidation !== invalidation) return;
      state.inventory = inventory;
      if (full) {
        state.reconciled = invalidation;
        state.expiresAt = this.now() + INVENTORY_TTL_MS;
      }
    } catch (error) {
      // The detached batch may have been only partially observed. Keep the old cache and repair next read.
      state.invalidation++;
      if (!context.isCurrent()) return;
      throw error;
    }
  }

  private state(key: string): InventoryState {
    let state = this.states.get(key);
    if (!state) state = { expiresAt: 0, pending: new Set(), invalidation: 0, reconciled: -1, readers: 0 };
    this.states.delete(key);
    this.states.set(key, state);
    return state;
  }

  private prune(): void {
    for (const [key, state] of this.states) {
      if (this.states.size <= MAX_INVENTORIES) break;
      // Active keys may temporarily exceed the cache limit; never split their writer or their waiters.
      if (!state.running && !state.readers) this.states.delete(key);
    }
  }
}
