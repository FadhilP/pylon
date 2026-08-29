import { createHash } from "node:crypto";
import type { SpawnKind, SpawnThreadInfo } from "./sessions.ts";
import type { SpawnRun } from "./runner.ts";

const SCIENTIST_NAMES = [
  "Ada",
  "Marie",
  "Charles",
  "Jane",
  "Alan",
  "Grace",
  "Emmy",
  "Vera",
  "Carl",
  "Tu",
  "Rosalind",
  "Katherine",
  "Ibn",
  "Srinivasa",
  "Chien-Shiung",
  "Dorothy",
  "Rachel",
  "Jagadish",
] as const;

/** How a spawned child is named in text shown to the parent model and the user. */
export const label = (kind: SpawnKind): string => (kind === "agent" ? "Subagent" : "Session");

export const scientistName = (id: string): string =>
  SCIENTIST_NAMES[createHash("sha256").update(id).digest().readUInt32BE(0) % SCIENTIST_NAMES.length];

export const preview = (value: string, max = 72): string => {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

export const defaultName = (prompt: string): string => preview(prompt, 100);

export type ToolFailure = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };

export const failure = (code: string, text: string, details?: Record<string, unknown>): ToolFailure => ({
  content: [{ type: "text" as const, text }],
  details: { ...details, failureCode: code },
});

export const isFailure = (value: unknown): value is ToolFailure =>
  typeof value === "object" && value !== null && "content" in value;

export const missingThread = (kind: SpawnKind): ToolFailure =>
  failure(
    "not_found",
    kind === "agent"
      ? "Private subagent thread is unavailable from this parent branch."
      : "Spawned session is unavailable from this parent branch.",
  );

export const threadListResult = (kind: SpawnKind, threads: SpawnThreadInfo[]) => ({
  content: [
    {
      type: "text" as const,
      text: threads.length
        ? threads.map(item => `${item.id} ${item.name ?? label(kind)} (${item.messageCount} messages)`).join("\n")
        : kind === "agent"
          ? "No private subagent threads on this parent branch."
          : "No spawned sessions on this parent branch.",
    },
  ],
  details: { threads },
});

export function runText(kind: SpawnKind, id: string, name: string, run: SpawnRun): string {
  const status = run.error
    ? `${label(kind)} ${name} (${id}) turn failed: ${run.error}`
    : `${label(kind)} ${name} (${id}):`;
  return `${status}${run.text ? `\n${run.text}` : ""}${run.truncated ? "\n[Response truncated.]" : ""}`;
}
