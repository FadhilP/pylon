import type { WorkspaceFilePage, WorkspaceFileReadModel, WorkspaceReadModel } from "../../shared/protocol/snapshots.ts";

export function workspaceInventoryCacheIsFresh(
  cachedRevision: string | undefined,
  expiresAt: number,
  workspaceRevision: string | undefined,
  now = Date.now(),
): boolean {
  return expiresAt > now && cachedRevision === workspaceRevision;
}

export function workspaceInventoryCacheState(
  cached: { generation: number; mode: WorkspaceReadModel["mode"] | undefined; revision?: string; expiresAt: number },
  current: { generation: number; mode: WorkspaceReadModel["mode"] | undefined; revision?: string },
  now = Date.now(),
): "hidden" | "stale" | "fresh" {
  if (cached.mode !== current.mode) return "hidden";
  return cached.generation === current.generation &&
    workspaceInventoryCacheIsFresh(cached.revision, cached.expiresAt, current.revision, now)
    ? "fresh"
    : "stale";
}

/** Retain equal entries, and the complete array when neither content nor order changed. */
function reuseFiles(files: WorkspaceFileReadModel[], previous?: WorkspaceFileReadModel[]): WorkspaceFileReadModel[] {
  if (!previous) return files;
  const byPath = new Map(previous.map(file => [file.path, file]));
  const next = files.map(file => {
    const old = byPath.get(file.path);
    const keys = Object.keys(file) as Array<keyof WorkspaceFileReadModel>;
    return old && keys.length === Object.keys(old).length && keys.every(key => file[key] === old[key]) ? old : file;
  });
  return next.length === previous.length && next.every((file, index) => file === previous[index]) ? previous : next;
}

export async function drainWorkspaceFiles(
  fetchPage: (cursor?: string) => Promise<WorkspaceFilePage>,
  signal: AbortSignal,
  publish: (files: WorkspaceFileReadModel[], truncated: boolean) => void,
  progress?: (loaded: number, total: number) => void,
  previous?: WorkspaceFileReadModel[],
): Promise<WorkspaceFileReadModel[]> {
  const files = new Map<string, WorkspaceFileReadModel>();
  let cursor: string | undefined;
  let sincePublish = 0;
  let truncated = false;
  let published: WorkspaceFileReadModel[] = [];
  do {
    signal.throwIfAborted();
    const page = await fetchPage(cursor);
    signal.throwIfAborted();
    for (const file of page.files) files.set(file.path, file);
    sincePublish += page.files.length;
    cursor = page.nextCursor;
    truncated ||= page.truncated;
    progress?.(files.size, page.totalCount);
    if (sincePublish >= 1_000 || !cursor) {
      // A refresh keeps its last complete inventory visible; first loads remain progressive.
      if (!previous || !cursor) {
        published = reuseFiles([...files.values()], previous);
        publish(published, truncated);
      }
      sincePublish = 0;
    }
  } while (cursor);
  return published;
}

export interface WorkspaceInventoryResult { files: WorkspaceFileReadModel[]; truncated: boolean }
interface InventoryConsumer {
  publish(files: WorkspaceFileReadModel[], truncated: boolean): void;
  progress(loaded: number, total: number): void;
  resolve(value: WorkspaceInventoryResult): void;
  reject(error: unknown): void;
}
interface InventoryFlight {
  controller: AbortController;
  refresh: boolean;
  finished: boolean;
  predecessor?: InventoryFlight;
  consumers: Set<InventoryConsumer>;
  published?: WorkspaceInventoryResult;
  progress?: [number, number];
  done: Promise<void>;
}

/** Shares one page drain, plus at most one forced successor, for an exact runtime context. */
export class WorkspaceInventoryLoads {
  private readonly latest = new Map<string, InventoryFlight>();
  private readonly active = new Set<InventoryFlight>();

  load(options: {
    key: string;
    refresh: boolean;
    signal: AbortSignal;
    previous?: WorkspaceFileReadModel[];
    checkCurrent(): void;
    fetchPage(cursor: string | undefined, signal: AbortSignal): Promise<WorkspaceFilePage>;
    complete(value: WorkspaceInventoryResult): void;
    publish(files: WorkspaceFileReadModel[], truncated: boolean): void;
    progress(loaded: number, total: number): void;
  }): Promise<WorkspaceInventoryResult> {
    const { key, refresh, signal, checkCurrent, fetchPage, complete, previous } = options;
    if (signal.aborted) return Promise.reject(signal.reason);
    let flight = this.latest.get(key);
    if (!flight || flight.finished || (refresh && !flight.refresh)) {
      const predecessor = flight?.finished ? undefined : flight;
      const created: InventoryFlight = {
        controller: new AbortController(), refresh, finished: false, predecessor,
        consumers: new Set(), done: Promise.resolve(),
      };
      flight = created;
      this.latest.set(key, created);
      this.active.add(created);
      const check = () => { created.controller.signal.throwIfAborted(); checkCurrent(); };
      const notify = (callback: (consumer: InventoryConsumer) => void) => {
        check();
        for (const consumer of [...created.consumers]) {
          if (!created.consumers.has(consumer)) continue;
          check();
          try { callback(consumer); } catch (error) { consumer.reject(error); }
        }
      };
      created.done = (predecessor?.done ?? Promise.resolve()).then(async () => {
        created.predecessor = undefined;
        check();
        let truncated = false;
        const files = await drainWorkspaceFiles(async cursor => {
          check();
          const page = await fetchPage(cursor, created.controller.signal);
          check();
          return page;
        }, created.controller.signal, (files, value) => {
          truncated = value;
          created.published = { files, truncated };
          notify(consumer => consumer.publish(files, truncated));
        }, (loaded, total) => {
          created.progress = [loaded, total];
          notify(consumer => consumer.progress(loaded, total));
        }, previous);
        check();
        const result = { files, truncated };
        if (this.latest.get(key) === created) complete(result);
        created.finished = true;
        for (const consumer of [...created.consumers]) consumer.resolve(result);
      }).catch(error => {
        created.finished = true;
        for (const consumer of [...created.consumers]) consumer.reject(error);
      }).finally(() => {
        this.active.delete(created);
        if (this.latest.get(key) === created) this.latest.delete(key);
      });
    }
    const shared = flight;
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        settled = true;
        signal.removeEventListener("abort", abort);
        shared.consumers.delete(consumer);
        if (!shared.finished && !shared.consumers.size) {
          if (this.latest.get(key) === shared) {
            const predecessor = shared.predecessor;
            if (predecessor && !predecessor.finished && !predecessor.controller.signal.aborted)
              this.latest.set(key, predecessor);
            else this.latest.delete(key);
          }
          shared.controller.abort();
        }
      };
      const consumer: InventoryConsumer = {
        publish: options.publish, progress: options.progress,
        resolve: value => { if (!settled) { cleanup(); resolve(value); } },
        reject: error => { if (!settled) { cleanup(); reject(error); } },
      };
      const abort = () => consumer.reject(signal.reason);
      shared.consumers.add(consumer);
      signal.addEventListener("abort", abort, { once: true });
      try {
        checkCurrent();
        if (shared.published) consumer.publish(shared.published.files, shared.published.truncated);
        if (shared.progress && !settled) consumer.progress(...shared.progress);
      } catch (error) { consumer.reject(error); }
    });
  }

  clear(): void {
    this.latest.clear();
    for (const flight of this.active) {
      flight.controller.abort();
      for (const consumer of [...flight.consumers]) consumer.reject(flight.controller.signal.reason);
    }
  }
}
