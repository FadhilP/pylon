import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";

type Collection = () => Promise<void>;
type Request = { collect: Collection };
type Job = { requests: Set<Request>; done: Promise<void> };
const jobs = new Map<string, Job>();

/** Coalesce root-scoped maintenance; callers schedule only after their startup hooks finish. */
export function createSessionMaintenance(root: string, collect: Collection) {
  const key = resolve(root);
  const request = { collect };
  let closed = false;
  let pending: Job | undefined;

  const cancel = () => {
    pending?.requests.delete(request);
  };
  return {
    cancel,
    collect(): Promise<void> {
      if (closed) return Promise.resolve();
      let job = jobs.get(key);
      if (!job) {
        const requests = new Set<Request>();
        job = {
          requests,
          done: setImmediate()
            .then(async () => {
              // Cancellation removes only this registration's request, not other live sessions'.
              const task = requests.values().next().value;
              if (task) await task.collect();
            })
            .finally(() => {
              requests.clear();
              if (jobs.get(key) === job) jobs.delete(key);
            }),
        };
        jobs.set(key, job);
      }
      job.requests.add(request);
      pending = job;
      return job.done;
    },
    async stop() {
      closed = true;
      cancel();
      // Never remove a lease while its collection may still be using the root.
      // A failed maintenance pass must not prevent mandatory lease release.
      await pending?.done.catch(() => {});
    },
  };
}
