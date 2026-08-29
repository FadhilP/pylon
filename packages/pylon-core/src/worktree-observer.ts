import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  appendTurnCommit,
  createWorktreeSummary,
  WORKTREE_SUMMARY_ENTRY_TYPE,
  turnsBranchForSession,
  worktreeDiff,
  worktreeFingerprint,
  worktreeSnapshot,
  type WorktreeSnapshot,
} from "./worktree.ts";

const lastAssistantEntryId = (ctx: any): string | undefined =>
  [...(ctx.sessionManager?.getBranch?.() ?? [])]
    .reverse()
    .find(
      (entry: any) =>
        entry?.type === "message" && entry.message?.role === "assistant",
    )?.id;

/**
 * Anchors both boundary trees on a per-session branch so the turn's diff survives `git gc`.
 * The before-tree is anchored first because external edits between turns can orphan it; identical
 * trees short-circuit inside `appendTurnCommit`, and failures degrade to an unanchored summary.
 */
async function anchorTurn(
  before: WorktreeSnapshot,
  after: WorktreeSnapshot,
  ctx: any,
) {
  const branch = turnsBranchForSession(
    String(ctx.sessionManager?.getSessionId?.() ?? ""),
  );
  if (!branch) return;
  if (!(await appendTurnCommit(before.root, branch, before.tree))) return;
  if (!(await appendTurnCommit(before.root, branch, after.tree))) return;
  return { root: before.root, beforeTree: before.tree, afterTree: after.tree };
}

/**
 * Watches the workspace across two spans: a whole model turn (reported as a file-level summary)
 * and any run of bash tool calls within a turn (reported as a coarse changed/unchanged signal).
 */
export function createWorktreeObserver(pi: ExtensionAPI) {
  let runBaseline: Promise<WorktreeSnapshot | undefined> | undefined;
  let runCwd = "";
  let shellBaseline: Promise<string | undefined> | undefined;
  let shellCwd = "";
  let shellToolCallIds: string[] = [];

  const reset = () => {
    runBaseline = undefined;
    runCwd = "";
    shellBaseline = undefined;
    shellCwd = "";
    shellToolCallIds = [];
  };

  return {
    reset,

    async agentStart(ctx: any) {
      runCwd = ctx.cwd;
      runBaseline = worktreeSnapshot(ctx.cwd);
      await runBaseline;
    },

    async agentSettled(ctx: any) {
      const beforePromise = runBaseline;
      const cwd = runCwd || ctx.cwd;
      runBaseline = undefined;
      runCwd = "";
      if (!beforePromise) return;

      const [before, after] = await Promise.all([
        beforePromise,
        worktreeSnapshot(cwd),
      ]);
      const files =
        before && after ? await worktreeDiff(before, after) : undefined;
      const assistantEntryId = lastAssistantEntryId(ctx);
      const anchor =
        files?.length && before && after && typeof assistantEntryId === "string"
          ? await anchorTurn(before, after, ctx)
          : undefined;
      const summary =
        files && typeof assistantEntryId === "string"
          ? createWorktreeSummary(assistantEntryId, files, anchor)
          : undefined;
      if (summary?.files.length) {
        try {
          pi.appendEntry(WORKTREE_SUMMARY_ENTRY_TYPE, summary);
        } catch {
          /* Summary persistence must not disrupt a completed model turn. */
        }
      }
      pi.events.emit("pylon:worktree-summary", {
        version: 1,
        cwd,
        known: Boolean(files),
        assistantEntryId: summary?.assistantEntryId,
        files: summary?.files ?? [],
      });
    },

    async toolCall(event: any, ctx: any) {
      if (event.toolName !== "bash") return;
      if (!shellBaseline) {
        shellCwd = ctx.cwd;
        shellBaseline = worktreeFingerprint(ctx.cwd);
      }
      shellToolCallIds.push(event.toolCallId);
      await shellBaseline;
    },

    async turnEnd(ctx: any) {
      const beforePromise = shellBaseline;
      if (!beforePromise) return;
      const cwd = shellCwd || ctx.cwd;
      const toolCallIds = shellToolCallIds;
      shellBaseline = undefined;
      shellCwd = "";
      shellToolCallIds = [];
      const [before, after] = await Promise.all([
        beforePromise,
        worktreeFingerprint(cwd),
      ]);
      pi.events.emit("pylon:worktree-change", {
        version: 1,
        cwd,
        changed: !before || !after || before !== after,
        known: Boolean(before && after),
        toolCallIds,
      });
    },
  };
}
