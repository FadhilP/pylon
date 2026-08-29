import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatTokenMeter,
  meterFromBranch,
  recordTelemetryEvent,
  recordToolResult,
  recordVerificationOutcome,
} from "./token-meter.ts";

const USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "cost"];

const boundedText = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : undefined);
const count = (value: unknown, max: number) =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const validUsage = (usage: any) =>
  Boolean(usage) &&
  USAGE_KEYS.every(key => typeof usage[key] === "number" && Number.isFinite(usage[key]) && usage[key] >= 0);

/** Persisting telemetry must never disrupt the task, so every append is best-effort. */
const appendQuietly = (pi: ExtensionAPI, type: string, entry: unknown) => {
  try {
    pi.appendEntry?.(type, entry);
  } catch {
    /* ignored */
  }
};

function memoryEntry(kind: "review" | "migration", value: any) {
  if (
    value?.version !== 1 ||
    !count(value.durationMs, Number.MAX_SAFE_INTEGER) ||
    !count(value.proposalCount, 2) ||
    !Array.isArray(value.verdicts) ||
    value.verdicts.length > 2 ||
    !value.verdicts.every((item: unknown) => typeof item === "string" && item.length <= 32) ||
    !validUsage(value.usage)
  )
    return;
  return {
    version: 1,
    kind,
    model: boundedText(value.model, 200),
    thinking: boundedText(value.thinking, 20),
    durationMs: value.durationMs,
    proposalCount: value.proposalCount,
    verdicts: value.verdicts,
    usage: value.usage,
  };
}

function compactionReviewEntry(value: any) {
  if (
    value?.version !== 1 ||
    !["reviewed", "failed"].includes(value.outcome) ||
    typeof value.model !== "string" ||
    !value.model ||
    value.model.length > 200
  )
    return;
  if (value.outcome === "failed") return { version: 1, outcome: "failed", model: value.model };
  const complete =
    count(value.durationMs, Number.MAX_SAFE_INTEGER) &&
    count(value.candidateCount, 6) &&
    count(value.acceptedCount, value.candidateCount) &&
    validUsage(value.usage);
  if (!complete) return;
  return {
    version: 1,
    outcome: "reviewed",
    model: value.model,
    thinking: boundedText(value.thinking, 20),
    durationMs: value.durationMs,
    candidateCount: value.candidateCount,
    acceptedCount: value.acceptedCount,
    usage: value.usage,
  };
}

/**
 * Owns the session's token meter and the telemetry other Pylon packages report into it.
 * The meter is rebuilt from the branch whenever the session tree changes.
 */
export function createTelemetry(pi: ExtensionAPI) {
  let meter = meterFromBranch([]);

  const disposers = [
    pi.events.on("pylon:telemetry", (value: unknown) => {
      const event = recordTelemetryEvent(meter, value);
      if (event) appendQuietly(pi, "pylon-telemetry", event);
    }),
    pi.events.on("pi-verify:result", (value: unknown) => recordVerificationOutcome(meter, value)),
    pi.events.on("pi-continuity:memory-review-telemetry", (value: any) => {
      const entry = memoryEntry("review", value);
      if (entry) appendQuietly(pi, "pi-continuity-memory-telemetry", entry);
    }),
    pi.events.on("pi-continuity:memory-migration-telemetry", (value: any) => {
      const entry = memoryEntry("migration", value);
      if (entry) appendQuietly(pi, "pi-continuity-memory-telemetry", entry);
    }),
    pi.events.on("pi-continuity:compaction-review-telemetry", (value: any) => {
      const entry = compactionReviewEntry(value);
      if (entry) appendQuietly(pi, "pi-continuity-compaction-review-telemetry", entry);
    }),
  ];

  return {
    rebuild(ctx: any) {
      meter = meterFromBranch(ctx.sessionManager?.getBranch?.() ?? []);
    },
    recordToolResult(event: any) {
      recordToolResult(meter, event);
    },
    format() {
      return formatTokenMeter(meter);
    },
    dispose() {
      for (const dispose of disposers) dispose();
    },
  };
}
