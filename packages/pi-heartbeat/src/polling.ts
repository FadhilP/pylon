import type { Job } from "./jobs.ts";
export const MIN_CHECK_INTERVAL_MS = 30000;
export function checkWaitMs(job: Job, now = Date.now()) {
  if (!["running", "cancelling"].includes(job.state)) return 0;
  return Math.max(0, MIN_CHECK_INTERVAL_MS + 1 - (now - job.lastCheckedAt));
}
