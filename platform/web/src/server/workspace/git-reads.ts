import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

interface ReadBudget {
  signal: AbortSignal;
  deadline: number;
  remaining: number;
  jobs: Set<Promise<unknown>>;
}
const context = new AsyncLocalStorage<ReadBudget>();

/** Only read requests enter this scope. Mutation lifetimes never follow browser cancellation. */
export function gitReadBudget(): ReadBudget | undefined {
  const budget = context.getStore();
  budget?.signal.throwIfAborted();
  if (budget && (Date.now() >= budget.deadline || budget.remaining <= 0))
    throw Error("Git inspection exceeded its aggregate work limit. Select a smaller comparison.");
  return budget;
}

/** In-flight sharing only: completed state must never authorize a later mutation. */
export class GitReadPool {
  private epoch = 0;
  private disposed = false;
  private pending = new Map<string, { promise: Promise<unknown>; users: number; controller: AbortController }>();
  constructor(
    private timeoutMs = 12_000,
    private maxBytes = 24 * 1024 * 1024,
  ) {}

  invalidate(): void {
    this.epoch++;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const entry of this.pending.values()) entry.controller.abort();
    await Promise.allSettled([...this.pending.values()].map(entry => entry.promise));
  }

  async read<T>(cwd: string, query: unknown, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) throw Error("Git reader is disposed.");
    signal?.throwIfAborted();
    const key = JSON.stringify([this.epoch, resolve(cwd), query]);
    let entry = this.pending.get(key);
    if (!entry) {
      if (this.pending.size >= 4) throw Error("Git inspection is busy; try again.");
      const controller = new AbortController();
      const budget: ReadBudget = {
        signal: controller.signal,
        deadline: Date.now() + this.timeoutMs,
        remaining: this.maxBytes,
        jobs: new Set(),
      };
      const timer = setTimeout(() => controller.abort(Error("Git inspection deadline exceeded.")), this.timeoutMs);
      const promise = context
        .run(budget, async () => {
          const result = await load();
          gitReadBudget();
          return result;
        })
        .finally(async () => {
          controller.abort();
          await Promise.allSettled([...budget.jobs]);
          clearTimeout(timer);
          this.pending.delete(key);
        });
      entry = { promise, controller, users: 0 };
      this.pending.set(key, entry);
    }
    if (entry.users >= 32 || entry.controller.signal.aborted) throw Error("Git inspection is busy; try again.");
    entry.users++;
    let abort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal?.reason ?? Error("Git request cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      return (await (signal ? Promise.race([entry.promise, cancelled]) : entry.promise)) as T;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (--entry.users === 0) {
        entry.controller.abort();
        await entry.promise.catch(() => {});
      }
    }
  }
}
