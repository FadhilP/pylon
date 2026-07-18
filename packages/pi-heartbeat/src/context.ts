import type { Job } from "./jobs.ts";
import { checkWaitMs } from "./polling.ts";
export function jobContext(jobs: Job[], now = Date.now()) {
  const selected = jobs
    .filter(
      (j) =>
        j.state === "running" ||
        j.state === "cancelling" ||
        !j.completionAnnounced,
    )
    .slice(0, 4);
  if (!selected.length) return "";
  const available = selected.filter((j) => checkWaitMs(j, now) === 0);
  const lines = selected.map((j) => {
    const wait = checkWaitMs(j, now);
    return `- ${j.id} ${j.label}: ${j.state}${j.exitCode !== undefined ? `, exit ${j.exitCode}` : ""} (${wait ? `do not check for ${Math.ceil(wait / 1000)}s` : "status available now"})`;
  });
  const instruction = available.length
    ? "Call heartbeat_status only with a job ID marked status available now."
    : "Do not call heartbeat_status yet; continue other work.";
  return `Background jobs:\n${lines.join("\n")}\n${instruction}`.slice(0, 1200);
}
