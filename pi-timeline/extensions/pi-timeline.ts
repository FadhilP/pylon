import { createHash } from "node:crypto";
import {
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { capture, type Snapshot } from "../src/snapshot.ts";
import { restore } from "../src/restore.ts";
import { promptText, promptTitle } from "../src/prompts.ts";
import { git } from "../src/git.ts";
import {
  findRunEntry,
  isRunEntry,
  RUN_ENTRY_TYPE,
  type RunEntry,
} from "../src/run.ts";
type RecordV3 = Snapshot & {
  version: 3;
  kind: "pi-prompt-checkpoint";
  promptEntryId: string;
  ownerSessionId: string;
  continuationEntryId: string;
  createdAt: string;
  verification?: {
    runId: string;
    state: "passed";
    scope: "changed" | "project";
    worktreeId: string;
    checks: string[];
  };
};
type Bound = {
  record: RecordV3;
  checkpointEntryId: string;
  preview: string;
  sessionId: string;
  sessionPath?: string;
  role?: RunEntry["role"];
};
type ClearV1 = {
  version: 1;
  ownerSessionId: string;
  checkpointEntryIds: string[];
};
export default function (pi: ExtensionAPI) {
  let records = new Map<string, Bound>(),
    paired = false,
    namingDecided = false,
    pendingContext = "",
    activeRun: RunEntry | undefined,
    latestVerification: any,
    lastCtx: any;
  const key = (sessionId: string, entryId: string) => `${sessionId}:${entryId}`;
  const worktreeId = async (cwd: string) => {
    const [head, status] = await Promise.all([
      git(cwd, ["rev-parse", "HEAD"]),
      git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    return createHash("sha256")
      .update(`${head}\n${status}`)
      .digest("hex")
      .slice(0, 16);
  };
  const loadEntries = (
    entries: readonly any[],
    sessionId: string,
    sessionPath?: string,
    role?: RunEntry["role"],
  ) => {
    const byId = new Map(entries.map((entry: any) => [entry.id, entry]));
    let checkpointRole = role;
    for (const entry of entries) {
      if (
        entry.type === "custom" &&
        entry.customType === RUN_ENTRY_TYPE &&
        isRunEntry(entry.data)
      ) {
        checkpointRole = entry.data.role;
      } else if (
        entry.type === "custom" &&
        entry.customType === "pi-prompt-checkpoint" &&
        entry.data?.version === 3
      ) {
        const user = byId.get(entry.data.promptEntryId) as any;
        if (user?.type === "message" && user.message.role === "user")
          records.set(key(sessionId, entry.id), {
            record: entry.data,
            checkpointEntryId: entry.id,
            preview: promptText(user.message),
            sessionId,
            sessionPath,
            role: checkpointRole,
          });
      } else if (
        entry.type === "custom" &&
        entry.customType === "pi-timeline-clear" &&
        entry.data?.version === 1
      )
        for (const id of entry.data.checkpointEntryIds ?? [])
          records.delete(key(sessionId, id));
    }
  };
  const load = async (ctx: any) => {
    records = new Map();
    const currentEntries = ctx.sessionManager.getEntries();
    activeRun = findRunEntry(currentEntries);
    if (!activeRun) {
      loadEntries(
        currentEntries,
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getSessionFile(),
      );
      return;
    }
    const sessions = await SessionManager.list(ctx.cwd);
    for (const session of sessions) {
      try {
        const manager = SessionManager.open(session.path);
        const entries = manager.getEntries();
        const run = findRunEntry(entries);
        if (run?.runId === activeRun.runId)
          loadEntries(entries, session.id, session.path);
      } catch {}
    }
    if (!sessions.some((session) => session.id === ctx.sessionManager.getSessionId()))
      loadEntries(
        currentEntries,
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getSessionFile(),
        activeRun.role,
      );
  };
  const refresh = (ctx: any) => {
    if (ctx.hasUI)
      ctx.ui.setStatus(
        "pi-timeline",
        records.size
          ? `checkpoints: ${records.size} · session: ${paired ? "paired" : "unpaired"}`
          : undefined,
      );
  };
  const deleteRefs = async (snapshot: Snapshot) => {
    await git(snapshot.gitRoot, ["update-ref", "-d", snapshot.worktreeRef]);
    await git(snapshot.gitRoot, ["update-ref", "-d", snapshot.indexRef]);
  };
  async function checkpoint(ctx: any): Promise<Snapshot | undefined> {
    const branch = ctx.sessionManager.getBranch(),
      user = [...branch]
        .reverse()
        .find(
          (e: any) => e.type === "message" && e.message.role === "user",
        ) as any;
    if (!user) return;
    const currentSessionId = ctx.sessionManager.getSessionId();
    const existing = [...records.values()]
      .reverse()
      .find(
        (bound) =>
          bound.sessionId === currentSessionId &&
          bound.record.promptEntryId === user.id,
      );
    if (paired && existing) return existing.record;
    const continuation = ctx.sessionManager.getLeafId();
    try {
      const snap = await capture(ctx.cwd, ctx.sessionManager.getSessionId()),
        identity = await worktreeId(ctx.cwd),
        verification = latestVerification?.worktreeId === identity && latestVerification.state === "passed"
          ? {
              runId: latestVerification.runId,
              state: latestVerification.state,
              scope: latestVerification.scope,
              worktreeId: identity,
              checks: (latestVerification.results ?? []).map((item: any) => item.label).slice(0, 6),
            }
          : undefined,
        record: RecordV3 = {
          version: 3,
          kind: "pi-prompt-checkpoint",
          promptEntryId: user.id,
          ownerSessionId: ctx.sessionManager.getSessionId(),
          continuationEntryId: continuation,
          ...snap,
          createdAt: new Date().toISOString(),
          ...(verification ? { verification } : {}),
        };
      pi.appendEntry("pi-prompt-checkpoint", record);
      const checkpointEntryId = ctx.sessionManager.getLeafId()!;
      records.set(key(currentSessionId, checkpointEntryId), {
        record,
        checkpointEntryId,
        preview: promptText(user.message),
        sessionId: currentSessionId,
        sessionPath: ctx.sessionManager.getSessionFile(),
        role: activeRun?.role,
      });
      paired = true;
      refresh(ctx);
      return record;
    } catch (e: any) {
      if (ctx.hasUI)
        ctx.ui.notify(`Timeline checkpoint skipped: ${e.message}`, "warning");
    }
  }
  const disposeVerify = pi.events.on("pi-verify:result", (event: any) => {
    if (event?.version === 1 && event.cwd === lastCtx?.cwd) latestVerification = event;
  });
  const disposeCheckpoint = pi.events.on("pi-timeline:checkpoint-request", (event: any) => {
    if (event?.version === 1 && lastCtx && typeof event.respond === "function")
      event.respond(checkpoint(lastCtx));
  });
  pi.on("session_start", async (_e, ctx) => {
    lastCtx = ctx;
    latestVerification = undefined;
    await load(ctx);
    paired = false;
    namingDecided = ctx.sessionManager
      .getEntries()
      .some((entry: any) => entry.type === "session_info");
    refresh(ctx);
  });
  pi.on("session_shutdown", () => {
    disposeVerify();
    disposeCheckpoint();
  });
  pi.on("session_info_changed", () => {
    namingDecided = true;
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") paired = false;
  });
  pi.on("agent_settled", async (_e, ctx) => {
    if (!namingDecided) {
      namingDecided = true;
      const firstUser = ctx.sessionManager
        .getBranch()
        .find(
          (entry: any) =>
            entry.type === "message" && entry.message.role === "user",
        ) as any;
      const name = firstUser && promptTitle(firstUser.message);
      if (name) pi.setSessionName(name);
    }
    await checkpoint(ctx);
  });
  pi.on("session_tree", (_e, ctx) => {
    paired = false;
    refresh(ctx);
    ctx.ui.notify(
      "Conversation changed with /tree; files were not restored. Use /timeline.",
      "warning",
    );
  });
  pi.on("context", (event) => {
    if (pendingContext) {
      const text = pendingContext;
      pendingContext = "";
      return {
        messages: [
          ...event.messages,
          {
            role: "custom",
            customType: "pi-timeline",
            content: text,
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
    }
  });
  pi.registerCommand("timeline", {
    description: "List, view, fork, or clear Git-backed prompt checkpoints",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      await load(ctx);
      const [actionRaw, idRaw] = args.trim().split(/\s+/, 2),
        action = actionRaw || "select";
      if (action === "list") {
        ctx.ui.notify(
          [...records]
            .map(
              ([id, bound]) =>
                `${id} ${bound.role ? `[${bound.role}] ` : ""}${bound.record.verification ? `[verified:${bound.record.verification.scope}] ` : ""}${bound.preview}`,
            )
            .join("\n") ||
            "No checkpoints.",
          "info",
        );
        return;
      }
      if (action === "clear") {
        if (
          !ctx.hasUI ||
          !(await ctx.ui.confirm(
            "Clear timeline refs?",
            "Delete refs owned by current session? Git objects are not garbage-collected.",
          ))
        )
          return;
        const owned = [...records].filter(
          ([, bound]) =>
            bound.record.ownerSessionId === ctx.sessionManager.getSessionId(),
        );
        for (const [, bound] of owned)
          await deleteRefs(bound.record).catch(() => {});
        const cleared: ClearV1 = {
          version: 1,
          ownerSessionId: ctx.sessionManager.getSessionId(),
          checkpointEntryIds: owned.map(([, bound]) => bound.checkpointEntryId),
        };
        pi.appendEntry("pi-timeline-clear", cleared);
        for (const [id] of owned) records.delete(id);
        refresh(ctx);
        return;
      }
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        ctx.ui.notify(
          "Timeline restore requires interactive confirmation.",
          "error",
        );
        return;
      }
      let mode = action;
      let id: string | undefined = idRaw;
      if (action === "select") {
        id = await ctx.ui.select(
          "Checkpoint",
          [...records].map(
            ([id, bound]) =>
              `${id} ${bound.role ? `[${bound.role}] ` : ""}${bound.record.verification ? "[verified] " : ""}${bound.preview}`,
          ),
        );
        id = id?.split(" ")[0];
        if (!id) return;
        mode =
          (await ctx.ui.select("Action", ["View", "Fork & continue"])) ===
          "View"
            ? "jump"
            : "fork";
      }
      const target = id && records.get(id);
      if (!target) {
        ctx.ui.notify("Unknown or unavailable checkpoint.", "error");
        return;
      }
      const source = await checkpoint(ctx);
      if (!source) {
        ctx.ui.notify("Unable to checkpoint current state.", "error");
        return;
      }
      const ok = await ctx.ui.confirm(
        mode === "fork" ? "Fork and restore?" : "View and restore?",
        `${target.preview}\nCurrent dirty state is checkpointed. Ignored files stay untouched.`,
      );
      if (!ok) return;
      const foreign =
        target.sessionId !== ctx.sessionManager.getSessionId() &&
        target.sessionPath;
      if (foreign) {
        await ctx.switchSession(target.sessionPath!, {
          withSession: async (fresh) => {
            if (mode === "jump") {
              try {
                await fresh.navigateTree(target.record.continuationEntryId, {
                  summarize: false,
                });
                await restore(target.record, fresh.cwd);
                await fresh.sendMessage(
                  {
                    customType: "pi-timeline",
                    content: `Filesystem restored from linked run checkpoint ${id}.`,
                    display: false,
                  },
                  { deliverAs: "nextTurn" },
                );
              } catch (e: any) {
                await restore(source, fresh.cwd).catch(() => {});
                fresh.ui.notify(
                  `Timeline restore failed; source files restored: ${e.message}`,
                  "error",
                );
              }
            } else {
              await fresh.fork(target.checkpointEntryId, {
                position: "at",
                withSession: async (child) => {
                  try {
                    await restore(target.record, child.cwd);
                    await child.sendMessage(
                      {
                        customType: "pi-timeline",
                        content: `Filesystem restored in forked Pi session from linked run checkpoint ${id}.`,
                        display: false,
                      },
                      { deliverAs: "nextTurn" },
                    );
                  } catch (e: any) {
                    await restore(source, child.cwd).catch(() => {});
                    child.ui.notify(
                      `Child restore failed; source files restored: ${e.message}`,
                      "error",
                    );
                  }
                },
              });
            }
          },
        });
      } else if (mode === "jump") {
        const old = ctx.sessionManager.getLeafId();
        try {
          await ctx.navigateTree(target.record.continuationEntryId, {
            summarize: false,
          });
          await restore(target.record, ctx.cwd);
          paired = true;
          pendingContext = `Filesystem restored from user prompt ${id}. Later changes may not exist.`;
          refresh(ctx);
        } catch (e: any) {
          await restore(source, ctx.cwd).catch(() => {});
          if (old)
            await ctx.navigateTree(old, { summarize: false }).catch(() => {});
          ctx.ui.notify(
            `Timeline restore failed and rollback attempted: ${e.message}`,
            "error",
          );
        }
      } else {
        await ctx.fork(target.checkpointEntryId, {
          position: "at",
          withSession: async (fresh) => {
            try {
              await restore(target.record, fresh.cwd);
              await fresh.sendMessage(
                {
                  customType: "pi-timeline",
                  content: `Filesystem restored in forked Pi session from user prompt ${id}.`,
                  display: false,
                },
                { deliverAs: "nextTurn" },
              );
              fresh.ui.notify("Timeline fork restored.", "info");
            } catch (e: any) {
              await restore(source, fresh.cwd).catch(() => {});
              fresh.ui.notify(
                `Child restore failed; source files restored: ${e.message}`,
                "error",
              );
            }
          },
        });
      }
    },
  });
}
