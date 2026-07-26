import type { Work } from "./active-work.ts";
import type { Fact } from "./memory.ts";

export const CONTINUITY_STATE_VERSION = 2 as const;

export interface ContinuityStateSnapshot {
  version: typeof CONTINUITY_STATE_VERSION;
  revision: number;
  sessionId: string;
  available: boolean;
  memory: Array<Pick<Fact, "key" | "kind" | "text" | "source" | "confidence" | "updatedAt" | "captureCommit" | "branchAtCapture" | "evidencePaths">>;
  work?: Pick<Work, "mode" | "goal" | "approved" | "planSummary" | "currentTodoId" | "latestFailure" | "nextAction" | "runId" | "createdAt" | "updatedAt" | "completedAt"> & {
    todos: Array<Pick<Work["todos"][number], "id" | "text" | "status" | "updatedAt">>;
  };
}

export interface ContinuityStateRequest {
  version: typeof CONTINUITY_STATE_VERSION;
  sessionId: string;
  respond(value: ContinuityStateSnapshot): void;
}

export function continuityStateSnapshot(sessionId: string, revision: number, work?: Work, available = true, memory: Fact[] = []): ContinuityStateSnapshot {
  return {
    version: CONTINUITY_STATE_VERSION,
    revision,
    sessionId,
    available,
    memory: memory.slice(0, 30).map((fact) => ({
      key: fact.key.slice(0, 200),
      kind: fact.kind,
      text: fact.text.slice(0, 1_000),
      source: fact.source.slice(0, 500),
      confidence: fact.confidence,
      updatedAt: fact.updatedAt,
      ...(fact.captureCommit ? { captureCommit: fact.captureCommit.slice(0, 128) } : {}),
      ...(fact.branchAtCapture ? { branchAtCapture: fact.branchAtCapture.slice(0, 240) } : {}),
      ...(fact.evidencePaths?.length ? {
        evidencePaths: fact.evidencePaths.slice(0, 5).map((item) => ({
          path: item.path.slice(0, 500),
          sha256: item.sha256.slice(0, 128),
        })),
      } : {}),
    })),
    ...(work ? {
      work: {
        mode: work.mode,
        goal: work.goal.slice(0, 2_000),
        approved: work.approved,
        planSummary: work.planSummary.slice(0, 4_000),
        ...(work.currentTodoId ? { currentTodoId: work.currentTodoId.slice(0, 120) } : {}),
        ...(work.latestFailure ? { latestFailure: work.latestFailure.slice(0, 1_000) } : {}),
        ...(work.nextAction ? { nextAction: work.nextAction.slice(0, 1_000) } : {}),
        ...(work.runId ? { runId: work.runId.slice(0, 128) } : {}),
        createdAt: work.createdAt,
        updatedAt: work.updatedAt,
        ...(work.completedAt ? { completedAt: work.completedAt } : {}),
        todos: work.todos.slice(0, 12).map((todo) => ({
          id: todo.id.slice(0, 120),
          text: todo.text.slice(0, 500),
          status: todo.status,
          updatedAt: todo.updatedAt,
        })),
      },
    } : {}),
  };
}
