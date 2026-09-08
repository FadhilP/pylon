import type { FileHistoryContext, HistoryTree } from "pylon-core/src/file-history.ts";
import type { Bound } from "./records.ts";
import type { Snapshot } from "./snapshot.ts";

const describeTree = (snapshot: Snapshot): HistoryTree => ({
  path: "",
  commonDir: snapshot.commonDir,
  tree: snapshot.worktreeTree,
  head: snapshot.head,
  repositories: snapshot.nested?.map(repository => ({
    path: repository.prefix.replace(/\/$/, ""),
    commonDir: repository.commonDir,
    tree: repository.worktreeTree,
    head: repository.head,
  })),
});

/** A prompt may survive a rewind while its old checkpoint does not. Use entry membership, not timestamps. */
export function fileHistoryContext(
  sessionId: string,
  branch: readonly { id: string }[],
  records: ReadonlyMap<string, Bound>,
  baseline?: Snapshot,
): FileHistoryContext {
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  const eligible = [...records]
    .filter(
      ([, bound]) =>
        bound.sessionId === sessionId &&
        bound.record.ownerSessionId === sessionId &&
        positions.has(bound.checkpointEntryId) &&
        positions.has(bound.record.promptEntryId),
    )
    .sort((a, b) => positions.get(a[1].checkpointEntryId)! - positions.get(b[1].checkpointEntryId)!);
  const start = Math.max(0, eligible.length - 200);
  const initial = eligible[0]?.[1].record.baseline ?? baseline;
  return {
    sessionId,
    ...(initial ? { baseline: describeTree(initial) } : {}),
    ...(start ? { seed: describeTree(eligible[start - 1][1].record) } : {}),
    partial: start > 0,
    checkpoints: eligible
      .slice(start)
      .map(([id, bound]) => ({
        id,
        title: bound.preview.split(/\r?\n/, 1)[0].slice(0, 300) || "Checkpoint",
        createdAt: bound.record.createdAt,
        verification: bound.record.verification?.state ?? "unverified",
        snapshot: describeTree(bound.record),
      })),
  };
}
