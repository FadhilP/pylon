import type { Work } from "./active-work.ts";
import type { NotebookNote } from "./memory.ts";

export const CONTINUITY_STATE_VERSION = 4 as const;
export type ContinuityMemoryNoteReadModel = Pick<
  NotebookNote,
  | "id"
  | "scope"
  | "trigger"
  | "guidance"
  | "authority"
  | "origin"
  | "disposition"
  | "enforcementAuthority"
  | "revision"
  | "updatedAt"
> & {
  relatedPaths?: string[];
  sourceSummary: string;
};
export interface ContinuityStateSnapshot {
  version: typeof CONTINUITY_STATE_VERSION;
  revision: number;
  sessionId: string;
  available: boolean;
  memory: ContinuityMemoryNoteReadModel[];
  globalMemory: ContinuityMemoryNoteReadModel[];
  v4MigrationAvailable: boolean;
  work?: Pick<
    Work,
    | "mode"
    | "goal"
    | "approved"
    | "planSummary"
    | "handoff"
    | "planRevision"
    | "revisionFeedback"
    | "currentTodoId"
    | "latestFailure"
    | "nextAction"
    | "runId"
    | "createdAt"
    | "updatedAt"
    | "completedAt"
  > & {
    approvalPending: boolean;
    todos: Array<
      Pick<Work["todos"][number], "id" | "text" | "status" | "updatedAt">
    >;
  };
}
export interface ContinuityStateRequest {
  version: typeof CONTINUITY_STATE_VERSION;
  sessionId: string;
  respond(value: ContinuityStateSnapshot): void;
}
const sourceSummary = (note: NotebookNote) => {
  const repository = note.sourceRefs.filter(
    (ref) => ref.type === "repository",
  ).length;
  if (repository)
    return `${repository} repository source${repository === 1 ? "" : "s"}`;
  if (note.sourceRefs.some((ref) => ref.type === "user_message"))
    return "user instruction";
  if (note.sourceRefs.some((ref) => ref.type === "direct_user_edit"))
    return "direct user edit";
  return "migration";
};
const memoryNote = (note: NotebookNote): ContinuityMemoryNoteReadModel => ({
  id: note.id,
  scope: note.scope,
  trigger: note.trigger,
  guidance: note.guidance,
  authority: note.authority,
  origin: note.origin,
  disposition: note.disposition,
  enforcementAuthority: note.enforcementAuthority,
  ...(note.relatedPaths?.length
    ? { relatedPaths: note.relatedPaths.slice(0, 5) }
    : {}),
  revision: note.revision,
  updatedAt: note.updatedAt,
  sourceSummary: sourceSummary(note),
});
export function continuityStateSnapshot(
  sessionId: string,
  revision: number,
  work?: Work,
  available = true,
  memory: NotebookNote[] = [],
  globalMemory: NotebookNote[] = [],
  v4MigrationAvailable = false,
): ContinuityStateSnapshot {
  return {
    version: 4,
    revision,
    sessionId,
    available,
    memory: memory.slice(0, 1_000).map(memoryNote),
    globalMemory: globalMemory.slice(0, 1_000).map(memoryNote),
    v4MigrationAvailable,
    ...(work
      ? {
          work: {
            mode: work.mode,
            goal: work.goal.slice(0, 2_000),
            approved: work.approved,
            approvalPending: !!work.approval,
            planSummary: work.planSummary.slice(0, 4_000),
            ...(work.handoff
              ? {
                  handoff: {
                    workingSet: work.handoff.workingSet
                      .slice(0, 20)
                      .map((value) => value.slice(0, 240)),
                    assumptions: work.handoff.assumptions
                      .slice(0, 12)
                      .map((value) => value.slice(0, 500)),
                    acceptanceCriteria: work.handoff.acceptanceCriteria
                      .slice(0, 12)
                      .map((value) => value.slice(0, 500)),
                  },
                }
              : {}),
            ...(work.planRevision ? { planRevision: work.planRevision } : {}),
            ...(work.revisionFeedback
              ? {
                  revisionFeedback: {
                    revision: work.revisionFeedback.revision,
                    text: work.revisionFeedback.text.slice(0, 1_000),
                    createdAt: work.revisionFeedback.createdAt,
                  },
                }
              : {}),
            ...(work.currentTodoId
              ? { currentTodoId: work.currentTodoId.slice(0, 120) }
              : {}),
            ...(work.latestFailure
              ? { latestFailure: work.latestFailure.slice(0, 1_000) }
              : {}),
            ...(work.nextAction
              ? { nextAction: work.nextAction.slice(0, 1_000) }
              : {}),
            ...(work.runId ? { runId: work.runId.slice(0, 128) } : {}),
            createdAt: work.createdAt,
            updatedAt: work.updatedAt,
            ...(work.completedAt ? { completedAt: work.completedAt } : {}),
            todos: work.todos
              .slice(0, 12)
              .map((todo) => ({
                id: todo.id.slice(0, 120),
                text: todo.text.slice(0, 500),
                status: todo.status,
                updatedAt: todo.updatedAt,
              })),
          },
        }
      : {}),
  };
}
