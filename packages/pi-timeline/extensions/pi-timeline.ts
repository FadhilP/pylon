import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { complete, type Message } from "@earendil-works/pi-ai/compat";
import { getAgentDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capture, makePortable, worktreeFingerprint, type Snapshot } from "../src/snapshot.ts";
import { restore } from "../src/restore.ts";
import { classifyCompatibility, type GitState } from "../src/compatibility.ts";
import { normalizeGeneratedTitle, promptText, promptTitle, SESSION_TITLE_PROMPT } from "../src/prompts.ts";
import { git } from "../src/git.ts";
import { recordTimelineOwner, startSessionGc } from "../src/session-gc.ts";
import { findRunEntry, isRunEntry, runTimelineId, RUN_ENTRY_TYPE, type RunEntry } from "../src/run.ts";
import { TIMELINE_STATE_VERSION, timelineStateSnapshot } from "../src/state.ts";
import { checkpointChanges, checkpointFileDiff, type TimelineChangeSet } from "../src/changes.ts";
import {
  CHECKPOINT_VERSIONS,
  customEntryData,
  PORTABLE_CHECKPOINT_VERSIONS,
  type Bound,
  type CheckpointRecord,
  type ClearV1,
} from "../src/records.ts";
import { checkpointRow, compatibilityDetail, inspectGitState, shortRef } from "../src/describe.ts";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export default function timelineExtension(
  pi: ExtensionAPI,
  completeTitle: typeof complete = complete,
  options: { artifactRoot?: string } = {},
) {
  const emitTelemetry = (value: unknown) => {
    try {
      pi.events.emit?.("pylon:telemetry", value);
    } catch {
      /* Telemetry must never affect session naming. */
    }
  };
  /** Loaded checkpoints and everything derived from them. */
  const checkpoints = {
    records: new Map<string, Bound>(),
    /** Whether the working tree currently matches the newest prompt's checkpoint. */
    paired: false,
    changeCache: new Map<string, TimelineChangeSet>(),
    changeBases: new Map<string, CheckpointRecord | null>(),
    /** Checkpoint ids the UI already confirmed a fork for. */
    confirmedForks: new Set<string>(),
  };

  /** Session-title generation; `generation` invalidates a naming call that outlived its session. */
  const naming = { decided: false, generation: 0, inFlight: undefined as number | undefined };

  /** Tracks worktree mutations that should trigger an automatic checkpoint. */
  const mutations = {
    automatic: false,
    /** Bumped on every observed mutation, so a capture can tell if the tree moved under it. */
    generation: 0,
    /** Worktree fingerprints taken before a tool call, keyed by toolCallId. */
    pending: new Map<string, string | undefined>(),
    denied: new Set<string>(),
    heartbeatJobs: new Set<string>(),
    checkpoint: undefined as Promise<void> | undefined,
  };

  /** Identity and lifecycle of the session this extension instance is attached to. */
  const session = {
    id: "",
    ephemeral: false,
    agentRunning: false,
    shuttingDown: false,
    releaseLease: undefined as ((cleanupIfLast?: boolean) => Promise<void>) | undefined,
  };

  let stateRevision = 0,
    pendingContext = "",
    suppressNextTreeWarning = false,
    activeRun: RunEntry | undefined,
    latestVerification: any,
    sharedWorktreeObserver = false,
    currentGit: any,
    lastCtx: any,
    enabled = true;
  pi.events.emit?.("pylon:worktree-observer-request", {
    version: 1,
    respond: (value: any) => {
      if (value?.version === 1 && value.owner === "pylon-core") sharedWorktreeObserver = true;
    },
  });
  const markAutomaticMutation = () => {
    mutations.automatic = true;
    mutations.generation++;
  };
  const disposeWorktreeChange = pi.events.on("pylon:worktree-change", (event: any) => {
    if (sharedWorktreeObserver && event?.version === 1 && event.cwd === lastCtx?.cwd && event.changed === true)
      markAutomaticMutation();
  });
  const disposeGuardDecision = pi.events.on("pi-guard:decision", (event: any) => {
    if (
      event?.version === 1 &&
      event.cwd === lastCtx?.cwd &&
      event.decision === "blocked" &&
      typeof event.toolCallId === "string"
    )
      mutations.denied.add(event.toolCallId);
  });
  const artifactRoot = options.artifactRoot ?? join(getAgentDir(), "pi-timeline");
  const key = (sessionId: string, entryId: string) => `${sessionId}:${entryId}`;
  const mutationDetails = (cwd: string, operation: string) => ({
    version: 1,
    cwd,
    changed: true,
    source: "pi-timeline",
    operation,
    mutationId: randomUUID(),
  });
  const publishMutation = (cwd: string, operation: string) =>
    pi.events.emit("pi-worktree:mutation", mutationDetails(cwd, operation));
  const mutationMessage = (cwd: string, operation: string, content: string) => ({
    customType: "pi-worktree-mutation",
    content,
    display: false,
    details: mutationDetails(cwd, operation),
  });
  const stateSnapshot = (available = true) => {
    const branch = lastCtx?.sessionManager.getBranch?.() ?? [];
    const positions = new Map<string, number>(branch.map((entry: any, index: number) => [entry.id, index] as const));
    const compatibleCheckpoints = currentGit
      ? [...checkpoints.records.values()].filter(
          bound =>
            bound.sessionId === session.id &&
            positions.has(bound.record.promptEntryId) &&
            classifyCompatibility(bound.record, currentGit).allowed,
        )
      : [];
    const undoPromptEntryIds = branch
      .filter(
        (entry: any, index: number) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          compatibleCheckpoints.some(
            bound => (positions.get(bound.record.promptEntryId) ?? Number.POSITIVE_INFINITY) < index,
          ),
      )
      .map((entry: any) => entry.id);
    const forkPromptEntryIds = compatibleCheckpoints.map(bound => bound.record.promptEntryId);
    const forkPromptCheckpoints = [...checkpoints.records]
      .filter(([, bound]) => compatibleCheckpoints.includes(bound))
      .map(([checkpointId, bound]) => ({ promptEntryId: bound.record.promptEntryId, checkpointId }));
    return timelineStateSnapshot(
      session.id,
      stateRevision,
      [...checkpoints.records].map(([id, bound]) => ({
        id,
        title: bound.preview.split(/\r?\n/, 1)[0] || "Checkpoint",
        createdAt: bound.record.createdAt,
        ...(bound.record.headRef ? { branch: shortRef(bound.record.headRef) } : {}),
        verified: bound.record.verification?.state === "passed",
        ownerSessionId: bound.record.ownerSessionId,
        ...((bound.record.changes ?? checkpoints.changeCache.get(id))
          ? { changes: bound.record.changes ?? checkpoints.changeCache.get(id) }
          : {}),
      })),
      available && enabled,
      undoPromptEntryIds,
      forkPromptEntryIds,
      forkPromptCheckpoints,
    );
  };
  const publishState = (available = true) => {
    stateRevision++;
    pi.events.emit?.("pi-timeline:state-change", stateSnapshot(available));
  };
  const disposeStateRequest = pi.events.on("pi-timeline:state-request", (request: any) => {
    if (
      request?.version !== TIMELINE_STATE_VERSION ||
      request.sessionId !== session.id ||
      typeof request.respond !== "function"
    )
      return;
    try {
      request.respond(stateSnapshot());
    } catch {
      /* State observers cannot affect Timeline. */
    }
  });
  const disposeRuntimePolicy = pi.events.on("pylon:runtime-policy", (value: any) => {
    if (
      ![1, 2].includes(value?.version) ||
      value.sessionId !== session.id ||
      typeof value.timelineEnabled !== "boolean"
    )
      return;
    enabled = value.timelineEnabled;
    if (!enabled) {
      mutations.automatic = false;
      mutations.pending.clear();
      mutations.heartbeatJobs.clear();
    }
    publishState();
  });
  const disposeEditNavigation = pi.events.on("pi-timeline:edit-navigation", (request: any) => {
    if (
      request?.version !== 1 ||
      request.sessionId !== session.id ||
      typeof request.targetEntryId !== "string" ||
      typeof request.rollbackFiles !== "boolean" ||
      typeof request.respond !== "function" ||
      !lastCtx
    )
      return;
    request.respond(
      (async () => {
        if (request.rollbackFiles && !enabled) throw new Error("Pi Timeline is disabled for this session");
        const previousPaired = checkpoints.paired;
        if (!request.rollbackFiles) {
          suppressNextTreeWarning = true;
          return {
            apply: async () => {
              checkpoints.paired = false;
              refresh(lastCtx);
            },
            rollback: async () => {
              suppressNextTreeWarning = true;
              checkpoints.paired = previousPaired;
              refresh(lastCtx);
            },
            commit: async () => {
              suppressNextTreeWarning = false;
            },
            cancel: async () => {
              suppressNextTreeWarning = false;
            },
          };
        }

        const branch = lastCtx.sessionManager.getBranch();
        const positions = new Map<string, number>(
          branch.map((entry: any, index: number) => [entry.id, index] as const),
        );
        const targetPosition = positions.get(request.targetEntryId);
        const target =
          targetPosition === undefined
            ? undefined
            : [...checkpoints.records.values()]
                .filter(
                  bound =>
                    bound.sessionId === session.id &&
                    (positions.get(bound.record.promptEntryId) ?? Number.POSITIVE_INFINITY) < targetPosition,
                )
                .sort(
                  (left, right) =>
                    (positions.get(right.record.promptEntryId) ?? -1) -
                    (positions.get(left.record.promptEntryId) ?? -1),
                )[0];
        if (!target) throw new Error("No Timeline checkpoint exists before this prompt");

        const current = await inspectGitState(lastCtx.cwd);
        const compatibility = classifyCompatibility(target.record, current);
        if (!compatibility.allowed) {
          throw new Error(compatibilityDetail(target.record, current, compatibility));
        }

        const source = await capture(lastCtx.cwd, session.id, root =>
          recordTimelineOwner(artifactRoot, session.id, root),
        );
        let closed = false;
        suppressNextTreeWarning = true;
        const close = async () => {
          if (closed) return;
          closed = true;
          await deleteRefs(source);
        };
        return {
          apply: async () => {
            await restore(target.record, lastCtx.cwd);
            publishMutation(lastCtx.cwd, "edit-navigation-restore");
            checkpoints.paired = true;
            pendingContext = `Filesystem restored to before edited prompt ${request.targetEntryId}.`;
            refresh(lastCtx);
          },
          rollback: async () => {
            if (!closed) await restore(source, lastCtx.cwd);
            suppressNextTreeWarning = true;
            checkpoints.paired = previousPaired;
            pendingContext = "";
            refresh(lastCtx);
            await close();
          },
          commit: close,
          cancel: async () => {
            suppressNextTreeWarning = false;
            await close();
          },
        };
      })(),
    );
  });
  const disposePromptFork = pi.events.on("pi-timeline:prompt-fork", (request: any) => {
    if (
      request?.version !== 1 ||
      request.sessionId !== session.id ||
      typeof request.checkpointId !== "string" ||
      typeof request.respond !== "function"
    )
      return;
    const available = enabled && checkpoints.records.has(request.checkpointId);
    if (available) checkpoints.confirmedForks.add(request.checkpointId);
    request.respond({ version: 1, available });
  });
  const calculateChanges = async (id: string, bound: Bound) => {
    const candidates = [...checkpoints.records.entries()]
      .filter(
        ([candidateId, candidate]) =>
          candidateId !== id &&
          candidate.sessionId === bound.sessionId &&
          candidate.record.createdAt < bound.record.createdAt,
      )
      .sort((left, right) => right[1].record.createdAt.localeCompare(left[1].record.createdAt));
    for (const [, candidate] of candidates) {
      try {
        return { changes: await checkpointChanges(bound.record, candidate.record), previous: candidate.record };
      } catch {}
    }
    return { changes: await checkpointChanges(bound.record), previous: undefined };
  };
  const changesFor = async (id: string, bound: Bound) => {
    const cached = checkpoints.changeCache.get(id);
    if (cached) return cached;
    const result = await calculateChanges(id, bound);
    checkpoints.changeCache.set(id, result.changes);
    checkpoints.changeBases.set(id, result.previous ?? null);
    return result.changes;
  };
  const previousCompatible = async (id: string, bound: Bound) => {
    await changesFor(id, bound);
    return checkpoints.changeBases.get(id) ?? undefined;
  };
  const disposeFilesRequest = pi.events.on("pi-timeline:files-request", (request: any) => {
    if (
      request?.version !== 1 ||
      request.sessionId !== session.id ||
      typeof request.checkpointId !== "string" ||
      typeof request.respond !== "function"
    )
      return;
    const bound = checkpoints.records.get(request.checkpointId);
    request.respond(
      (async () => {
        if (!enabled) throw Error("Pi Timeline is disabled for this session");
        if (!bound || bound.sessionId !== session.id) throw Error("Timeline checkpoint is unavailable");
        const changes = await changesFor(request.checkpointId, bound);
        return {
          version: 1,
          checkpointId: request.checkpointId,
          files: changes.files,
          totalCount: changes.fileCount,
          truncated: changes.truncated,
        };
      })(),
    );
  });
  const disposeDiffRequest = pi.events.on("pi-timeline:diff-request", (request: any) => {
    if (
      request?.version !== 1 ||
      request.sessionId !== session.id ||
      typeof request.checkpointId !== "string" ||
      typeof request.path !== "string" ||
      typeof request.respond !== "function"
    )
      return;
    const bound = checkpoints.records.get(request.checkpointId);
    request.respond(
      (async () => {
        if (!enabled) throw Error("Pi Timeline is disabled for this session");
        if (!bound || bound.sessionId !== session.id) throw Error("Timeline checkpoint is unavailable");
        return {
          version: 1,
          checkpointId: request.checkpointId,
          ...(await checkpointFileDiff(
            bound.record,
            await previousCompatible(request.checkpointId, bound),
            request.path,
          )),
        };
      })(),
    );
  });
  type ModelCall = { eventId: string; started: number; request: string; result: string };
  type ModelUsage = {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };

  /** One telemetry payload shape for both the completed and failed naming calls. */
  const emitModelCall = (call: ModelCall, status: "completed" | "failed", usage: ModelUsage = {}) =>
    emitTelemetry({
      version: 1,
      eventId: call.eventId,
      package: "pi-timeline",
      kind: "model_call",
      status,
      durationMs: Date.now() - call.started,
      usage: {
        turns: 1,
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        cost: usage.cost?.total ?? 0,
      },
      context: {
        request: { characters: call.request.length, hash: hash(`${call.eventId}:request:${call.request}`) },
        result: { characters: call.result.length, hash: hash(`${call.eventId}:result:${call.result}`) },
      },
    });

  /** Asks the model for a session title, falling back to the first prompt's own text. */
  const generateTitle = async (ctx: any, generation: number, firstUser: any, finalAssistant: any) => {
    const model = ctx.model;
    if (!model) return undefined;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return undefined;
    const request = promptText(firstUser.message);
    const result = finalAssistant ? promptText(finalAssistant.message) : "";
    const sessionId = ctx.sessionManager.getSessionId();
    const call: ModelCall = { eventId: hash(`${sessionId}:${generation}`), started: Date.now(), request, result };
    try {
      const message: Message = {
        role: "user",
        content: [
          { type: "text", text: `<user-request>\n${request}\n</user-request>\n<result>\n${result}\n</result>` },
        ],
        timestamp: Date.now(),
      };
      const response = await completeTitle(
        model,
        { systemPrompt: SESSION_TITLE_PROMPT, messages: [message] },
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 32, timeoutMs: 30_000, sessionId },
      );
      const failed = response.stopReason === "error" || response.stopReason === "aborted";
      emitModelCall(call, failed ? "failed" : "completed", response.usage ?? {});
      const raw = response.content
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .join("\n");
      return normalizeGeneratedTitle(raw) ?? undefined;
    } catch (error) {
      emitModelCall(call, "failed");
      throw error;
    }
  };

  const nameSession = async (ctx: any) => {
    if (naming.decided || naming.inFlight !== undefined) return;
    const generation = naming.generation;
    naming.inFlight = generation;
    const branch = ctx.sessionManager.getBranch(),
      firstUser = branch.find((entry: any) => entry.type === "message" && entry.message.role === "user"),
      finalAssistant = branch.findLast((entry: any) => entry.type === "message" && entry.message.role === "assistant"),
      fallback = firstUser && promptTitle(firstUser.message);
    let name = fallback;
    try {
      if (firstUser) name = (await generateTitle(ctx, generation, firstUser, finalAssistant)) ?? fallback;
    } catch {
      name = fallback;
    } finally {
      if (naming.inFlight === generation) naming.inFlight = undefined;
    }
    // A newer session replaced ours while the model call was in flight.
    if (generation !== naming.generation) return;
    if (!naming.decided && name) {
      naming.decided = true;
      pi.setSessionName(name);
    }
  };
  const worktreeId = async (cwd: string) => {
    const [head, status] = await Promise.all([
      git(cwd, ["rev-parse", "HEAD"]),
      git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    return hash(`${head}\n${status}`).slice(0, 16);
  };
  const loadEntries = (entries: readonly any[], sessionId: string, sessionPath?: string, timelineId?: string) => {
    const byId = new Map(entries.map((entry: any) => [entry.id, entry]));
    // A version-3 record superseded by a portable rewrite of the same snapshot is skipped.
    const portable = new Set(
      entries.flatMap((entry: any) => {
        const data = customEntryData(entry, "pi-prompt-checkpoint", PORTABLE_CHECKPOINT_VERSIONS);
        return data && typeof data.promptEntryId === "string" && typeof data.snapshotId === "string"
          ? [`${data.promptEntryId}:${data.snapshotId}`]
          : [];
      }),
    );

    let checkpointTimelineId: string | undefined;
    for (const entry of entries) {
      const run = customEntryData(entry, RUN_ENTRY_TYPE);
      if (run && isRunEntry(run)) {
        checkpointTimelineId = runTimelineId(run);
        continue;
      }
      const cleared = customEntryData(entry, "pi-timeline-clear", [1]);
      if (cleared) {
        for (const id of cleared.checkpointEntryIds ?? []) checkpoints.records.delete(key(sessionId, id));
        continue;
      }
      const checkpoint = customEntryData(entry, "pi-prompt-checkpoint", CHECKPOINT_VERSIONS);
      if (!checkpoint) continue;
      if (checkpoint.version === 3 && portable.has(`${checkpoint.promptEntryId}:${checkpoint.snapshotId}`)) continue;
      if (checkpoint.headRef !== null && typeof checkpoint.headRef !== "string") continue;
      if (timelineId && checkpointTimelineId !== timelineId) continue;
      const user = byId.get(checkpoint.promptEntryId) as any;
      if (user?.type === "message" && user.message.role === "user")
        checkpoints.records.set(key(sessionId, entry.id), {
          record: checkpoint as CheckpointRecord,
          checkpointEntryId: entry.id,
          preview: promptText(user.message),
          sessionId,
          sessionPath,
        });
    }
  };
  const load = async (ctx: any) => {
    checkpoints.records = new Map();
    checkpoints.changeCache.clear();
    checkpoints.changeBases.clear();
    currentGit = await inspectGitState(ctx.cwd).catch(() => undefined);
    const currentEntries = ctx.sessionManager.getEntries();
    activeRun = findRunEntry(currentEntries);
    if (!activeRun) {
      loadEntries(currentEntries, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile());
      return;
    }
    const timelineId = runTimelineId(activeRun);
    const sessions = await SessionManager.list(ctx.cwd);
    for (const session of sessions) {
      try {
        const manager = SessionManager.open(session.path);
        loadEntries(manager.getEntries(), session.id, session.path, timelineId);
      } catch {}
    }
    if (!sessions.some(session => session.id === ctx.sessionManager.getSessionId()))
      loadEntries(currentEntries, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile(), timelineId);
  };
  const hydrateLegacyChanges = async (sessionId: string) => {
    let changed = false;
    for (const [id, bound] of checkpoints.records) {
      if (session.id !== sessionId || bound.sessionId !== sessionId) continue;
      if (bound.record.changes || checkpoints.changeCache.has(id)) continue;
      try {
        await changesFor(id, bound);
        changed = true;
      } catch {}
    }
    if (changed && session.id === sessionId) publishState();
  };
  const refresh = (ctx: any) => {
    if (ctx.hasUI)
      ctx.ui.setStatus(
        "pi-timeline",
        checkpoints.records.size
          ? `Checkpoints: ${checkpoints.records.size} · Session: ${checkpoints.paired ? "Paired" : "Unpaired"}`
          : undefined,
      );
  };
  const deleteRefs = async (snapshot: Snapshot) => {
    const repositories = [
      { gitRoot: snapshot.gitRoot, worktreeRef: snapshot.worktreeRef, indexRef: snapshot.indexRef },
      ...(snapshot.nested ?? []),
    ];
    for (const repository of repositories) {
      await git(repository.gitRoot, ["update-ref", "-d", repository.worktreeRef]);
      await git(repository.gitRoot, ["update-ref", "-d", repository.indexRef]);
    }
  };
  async function checkpoint(ctx: any): Promise<Snapshot | undefined> {
    if (!enabled) return;
    const branch = ctx.sessionManager.getBranch(),
      user = [...branch].reverse().find((e: any) => e.type === "message" && e.message.role === "user") as any;
    if (!user) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const existing = [...checkpoints.records.values()]
      .reverse()
      .find(bound => bound.sessionId === sessionId && bound.record.promptEntryId === user.id);
    if (checkpoints.paired && existing) return existing.record;
    const continuation = ctx.sessionManager.getLeafId();
    let snap: Snapshot | undefined;
    try {
      snap = await capture(ctx.cwd, sessionId, root => recordTimelineOwner(artifactRoot, sessionId, root));
      currentGit = snap;
      const identity = await worktreeId(ctx.cwd),
        verification =
          latestVerification?.worktreeId === identity && latestVerification.state === "passed"
            ? {
                runId: latestVerification.runId,
                state: latestVerification.state,
                scope: latestVerification.scope,
                worktreeId: identity,
                checks: (latestVerification.results ?? []).map((item: any) => item.label).slice(0, 6),
              }
            : undefined,
        record: CheckpointRecord = {
          version: 5,
          kind: "pi-prompt-checkpoint",
          promptEntryId: user.id,
          ownerSessionId: sessionId,
          continuationEntryId: continuation,
          ...snap,
          createdAt: new Date().toISOString(),
          ...(verification ? { verification } : {}),
        };
      const temporary: Bound = {
        record,
        checkpointEntryId: "",
        preview: promptText(user.message),
        sessionId,
        sessionPath: ctx.sessionManager.getSessionFile(),
      };
      const calculated = await calculateChanges("", temporary);
      const changes = calculated.changes;
      record.changes = {
        fileCount: changes.fileCount,
        additions: changes.additions,
        deletions: changes.deletions,
        binaryCount: changes.binaryCount,
      };
      pi.appendEntry("pi-prompt-checkpoint", record);
      const checkpointEntryId = ctx.sessionManager.getLeafId()!;
      checkpoints.changeCache.set(key(sessionId, checkpointEntryId), changes);
      checkpoints.changeBases.set(key(sessionId, checkpointEntryId), calculated.previous ?? null);
      checkpoints.records.set(key(sessionId, checkpointEntryId), {
        record,
        checkpointEntryId,
        preview: promptText(user.message),
        sessionId,
        sessionPath: ctx.sessionManager.getSessionFile(),
      });
      checkpoints.paired = true;
      refresh(ctx);
      publishState();
      return record;
    } catch (e: any) {
      if (snap) await deleteRefs(snap).catch(() => {});
      if (ctx.hasUI) ctx.ui.notify(`Timeline checkpoint skipped: ${e.message}`, "warning");
    }
  }
  const disposeVerify = pi.events.on("pi-verify:result", (event: any) => {
    if (event?.version === 1 && event.cwd === lastCtx?.cwd) latestVerification = event;
  });
  const disposeCheckpoint = pi.events.on("pi-timeline:checkpoint-request", (event: any) => {
    if (event?.version === 1 && lastCtx && typeof event.respond === "function")
      event.respond(enabled ? checkpoint(lastCtx) : undefined);
  });
  const disposeRelocation = pi.events.on("pi-timeline:relocation-readiness", (request: any) => {
    if (request?.version !== 1 || request.sessionId !== session.id || typeof request.respond !== "function" || !lastCtx)
      return;
    request.respond(
      (async () => {
        const migrating = [...checkpoints.records.entries()].filter(
          ([, bound]) => bound.sessionId === session.id && bound.record.version === 3,
        );
        for (const [recordKey, bound] of migrating) {
          const portable = await makePortable(bound.record, lastCtx.cwd);
          const record: CheckpointRecord = { ...bound.record, ...portable, version: 4 };
          pi.appendEntry("pi-prompt-checkpoint", record);
          const checkpointEntryId = lastCtx.sessionManager.getLeafId()!;
          checkpoints.records.delete(recordKey);
          checkpoints.records.set(key(session.id, checkpointEntryId), { ...bound, record, checkpointEntryId });
        }
        if (migrating.length) {
          refresh(lastCtx);
          publishState();
        }
        return { version: 1, ready: true };
      })(),
    );
  });
  const disposeWorkspaceApplied = pi.events.on("pylon:workspace-applied", (event: any) => {
    if (event?.version !== 1 || event.sessionId !== session.id || !lastCtx) return;
    checkpoints.confirmedForks.clear();
    refresh(lastCtx);
    publishState();
  });
  pi.on("session_start", async (_e, ctx) => {
    lastCtx = ctx;
    latestVerification = undefined;
    mutations.pending.clear();
    mutations.denied.clear();
    mutations.heartbeatJobs.clear();
    checkpoints.confirmedForks.clear();
    mutations.automatic = false;
    mutations.generation = 0;
    session.agentRunning = false;
    session.shuttingDown = false;
    mutations.checkpoint = undefined;
    const nextSessionId = ctx.sessionManager.getSessionId();
    const reuseSessionLease = !!session.releaseLease && session.id === nextSessionId;
    if (session.releaseLease && !reuseSessionLease) await session.releaseLease(session.ephemeral);
    session.id = nextSessionId;
    if (!reuseSessionLease) session.releaseLease = await startSessionGc(artifactRoot, session.id);
    session.ephemeral = !ctx.sessionManager.getSessionFile?.();
    await load(ctx);
    checkpoints.paired = false;
    naming.generation++;
    naming.inFlight = undefined;
    naming.decided = ctx.sessionManager.getEntries().some((entry: any) => entry.type === "session_info");
    refresh(ctx);
    publishState();
    void hydrateLegacyChanges(session.id);
  });
  pi.on("session_shutdown", async () => {
    session.shuttingDown = true;
    naming.generation++;
    naming.inFlight = undefined;
    checkpoints.confirmedForks.clear();
    publishState(false);
    disposeStateRequest();
    disposeEditNavigation();
    disposePromptFork();
    disposeVerify();
    disposeCheckpoint();
    disposeRelocation();
    disposeWorkspaceApplied();
    disposeWorktreeChange();
    disposeGuardDecision();
    disposeHeartbeatJobs();
    disposeFilesRequest();
    disposeDiffRequest();
    disposeRuntimePolicy();
    await mutations.checkpoint?.catch(() => {});
    mutations.checkpoint = undefined;
    await session.releaseLease?.(session.ephemeral);
    session.releaseLease = undefined;
    session.id = "";
  });
  pi.on("session_info_changed", () => {
    naming.decided = true;
  });
  pi.on("input", event => {
    if (event.source !== "extension") checkpoints.paired = false;
  });
  const flushAutomaticCheckpoint = (ctx = lastCtx) => {
    if (
      !ctx ||
      !enabled ||
      session.shuttingDown ||
      session.agentRunning ||
      mutations.heartbeatJobs.size ||
      !mutations.automatic
    )
      return mutations.checkpoint;
    if (!mutations.checkpoint) {
      // Capturing is slow enough that the tree can change under us. Each pass compares the
      // mutation generation across the capture and retries while it moved, so the checkpoint
      // we keep always reflects a tree that held still for one full capture. The loop also
      // exits when the agent or a heartbeat job starts up again, since they will re-trigger it.
      const run = (async () => {
        for (;;) {
          const generation = mutations.generation;
          const captured = await checkpoint(ctx);
          const treeMovedDuringCapture = generation !== mutations.generation;
          if (captured && !treeMovedDuringCapture) mutations.automatic = false;
          if (!treeMovedDuringCapture) return;
          checkpoints.paired = false;
          const busy = session.agentRunning || mutations.heartbeatJobs.size > 0;
          if (busy) return;
        }
      })();
      const tracked = run.finally(() => {
        if (mutations.checkpoint === tracked) mutations.checkpoint = undefined;
      });
      mutations.checkpoint = tracked;
    }
    return mutations.checkpoint;
  };
  const disposeHeartbeatJobs = pi.events.on("pi-heartbeat:job", (event: any) => {
    if (
      event?.version !== 1 ||
      event.cwd !== lastCtx?.cwd ||
      event.sessionId !== session.id ||
      typeof event.id !== "string"
    )
      return;
    if (["running", "cancelling"].includes(event.state)) mutations.heartbeatJobs.add(event.id);
    else {
      mutations.heartbeatJobs.delete(event.id);
      return flushAutomaticCheckpoint();
    }
  });
  pi.on("agent_start", () => {
    session.agentRunning = true;
  });
  pi.on("tool_call", async (event, ctx) => {
    if (enabled && ((event.toolName === "bash" && !sharedWorktreeObserver) || event.toolName === "grunt"))
      mutations.pending.set(event.toolCallId, await worktreeFingerprint(ctx.cwd));
  });
  pi.on("tool_result", async (event, ctx) => {
    if (!enabled) return;
    if (mutations.denied.delete(event.toolCallId)) {
      mutations.pending.delete(event.toolCallId);
      return;
    }
    if ((event.toolName === "bash" && !sharedWorktreeObserver) || event.toolName === "grunt") {
      const before = mutations.pending.get(event.toolCallId);
      mutations.pending.delete(event.toolCallId);
      const after = await worktreeFingerprint(ctx.cwd);
      if (!before || !after || before !== after) markAutomaticMutation();
    } else if (["write", "edit", "heartbeat_start"].includes(event.toolName)) {
      markAutomaticMutation();
    }
  });
  pi.on("agent_settled", async (_e, ctx) => {
    session.agentRunning = false;
    void nameSession(ctx).catch(() => {});
    await flushAutomaticCheckpoint(ctx);
  });
  pi.on("session_tree", (_e, ctx) => {
    if (suppressNextTreeWarning) {
      suppressNextTreeWarning = false;
      return;
    }
    checkpoints.paired = false;
    refresh(ctx);
    ctx.ui.notify("Conversation changed with /tree; files were not restored. Use /timeline.", "warning");
  });
  pi.on("context", event => {
    if (pendingContext) {
      const text = pendingContext;
      pendingContext = "";
      return {
        messages: [
          ...event.messages,
          { role: "custom", customType: "pi-timeline", content: text, display: false, timestamp: Date.now() },
        ],
      };
    }
  });
  const listCheckpoints = async (ctx: any) => {
    const current = await inspectGitState(ctx.cwd);
    ctx.ui.notify(
      [...checkpoints.records].map(([, bound]) => checkpointRow(bound, current)).join("\n") || "No checkpoints.",
      "info",
    );
  };

  const clearCheckpoints = async (ctx: any) => {
    if (
      !ctx.hasUI ||
      !(await ctx.ui.confirm(
        "Clear timeline refs?",
        "Delete refs owned by current session? Git objects are not garbage-collected.",
      ))
    )
      return;
    const owned = [...checkpoints.records].filter(
      ([, bound]) => bound.record.ownerSessionId === ctx.sessionManager.getSessionId(),
    );
    const deletionFailures: string[] = [];
    for (const [, bound] of owned) {
      try {
        await deleteRefs(bound.record);
      } catch (error) {
        deletionFailures.push(error instanceof Error ? error.message : String(error));
      }
    }
    // Leaving the checkpoints.records in place lets the user retry rather than losing the checkpoints.
    if (deletionFailures.length) {
      ctx.ui.notify(`Timeline clear failed; checkpoints remain available for retry. ${deletionFailures[0]}`, "error");
      return;
    }
    const cleared: ClearV1 = {
      version: 1,
      ownerSessionId: ctx.sessionManager.getSessionId(),
      checkpointEntryIds: owned.map(([, bound]) => bound.checkpointEntryId),
    };
    pi.appendEntry("pi-timeline-clear", cleared);
    for (const [id] of owned) checkpoints.records.delete(id);
    refresh(ctx);
    publishState();
  };

  /** Prompts for a checkpoint and what to do with it. */
  const promptForCheckpoint = async (ctx: any) => {
    const current = await inspectGitState(ctx.cwd);
    const choices = [...checkpoints.records].map(([checkpointId, bound]) => ({
      id: checkpointId,
      label: checkpointRow(bound, current),
    }));
    const selected = await ctx.ui.select(
      "Checkpoint",
      choices.map(choice => choice.label),
    );
    const id = choices.find(choice => choice.label === selected)?.id;
    if (!id) return undefined;
    const action = await ctx.ui.select("Action", ["View", "Fork & continue"]);
    return { id, mode: action === "View" ? "jump" : "fork" };
  };

  type RestorePlan = { operation: string; content: string; failure: string; navigateTo?: string; notify?: string };

  /**
   * Restores a checkpoint into a session Pi just opened for us. On any failure the
   * source snapshot is put back so the user never lands on a half-restored tree.
   */
  const restoreIntoSession = async (session: any, target: CheckpointRecord, source: Snapshot, plan: RestorePlan) => {
    try {
      if (plan.navigateTo) await session.navigateTree(plan.navigateTo, { summarize: false });
      await restore(target, session.cwd);
      await session.sendMessage(mutationMessage(session.cwd, plan.operation, plan.content), { deliverAs: "nextTurn" });
      if (plan.notify) session.ui.notify(plan.notify, "info");
    } catch (e: any) {
      await restore(source, session.cwd).catch(() => {});
      session.ui.notify(`${plan.failure}: ${e.message}`, "error");
    }
  };

  /** Restores in place, rewinding both the files and the conversation position on failure. */
  const restoreInCurrentSession = async (ctx: any, target: CheckpointRecord, source: Snapshot, id: string) => {
    const old = ctx.sessionManager.getLeafId();
    try {
      await ctx.navigateTree(target.continuationEntryId, { summarize: false });
      await restore(target, ctx.cwd);
      publishMutation(ctx.cwd, "jump-restore");
      checkpoints.paired = true;
      pendingContext = `Filesystem restored from user prompt ${id}. Later changes may not exist.`;
      refresh(ctx);
    } catch (e: any) {
      await restore(source, ctx.cwd).catch(() => {});
      if (old) await ctx.navigateTree(old, { summarize: false }).catch(() => {});
      ctx.ui.notify(`Timeline restore failed and rollback attempted: ${e.message}`, "error");
    }
  };

  /** Checkpoints the current tree, confirms, then routes to the matching restore path. */
  const restoreCheckpoint = async (ctx: any, id: string, mode: string) => {
    const target = checkpoints.records.get(id);
    if (!target) {
      ctx.ui.notify("Unknown or unavailable checkpoint.", "error");
      return;
    }
    const preconfirmed = mode === "fork" && checkpoints.confirmedForks.delete(id);
    let current: GitState = await inspectGitState(ctx.cwd);
    let compatibility = classifyCompatibility(target.record, current);
    if (!compatibility.allowed) {
      ctx.ui.notify(compatibilityDetail(target.record, current, compatibility), "error");
      return;
    }
    const source = await checkpoint(ctx);
    if (!source) {
      ctx.ui.notify("Unable to checkpoint current state.", "error");
      return;
    }
    // Re-check against the state the rollback checkpoint actually captured.
    current = source;
    compatibility = classifyCompatibility(target.record, current);
    if (!compatibility.allowed) {
      ctx.ui.notify(
        `Git state changed while creating rollback checkpoint. ${compatibilityDetail(target.record, current, compatibility)}`,
        "error",
      );
      return;
    }
    const ok =
      preconfirmed ||
      (await ctx.ui.confirm(
        mode === "fork" ? "Fork and restore?" : "View and restore?",
        `${target.preview}\n${compatibilityDetail(target.record, current, compatibility)}\nCurrent dirty state is checkpointed. Ignored files stay untouched.`,
      ));
    if (!ok) return;

    const foreign = target.sessionId !== ctx.sessionManager.getSessionId() && target.sessionPath;
    if (foreign) {
      await ctx.switchSession(target.sessionPath!, {
        withSession: async (fresh: any) => {
          if (mode === "jump") {
            await restoreIntoSession(fresh, target.record, source, {
              operation: "linked-jump-restore",
              content: `Filesystem restored from linked run checkpoint ${id}.`,
              failure: "Timeline restore failed; source files restored",
              navigateTo: target.record.continuationEntryId,
            });
            return;
          }
          await fresh.fork(target.checkpointEntryId, {
            position: "at",
            withSession: (child: any) =>
              restoreIntoSession(child, target.record, source, {
                operation: "linked-fork-restore",
                content: `Filesystem restored in forked Pi session from linked run checkpoint ${id}.`,
                failure: "Child restore failed; source files restored",
              }),
          });
        },
      });
      return;
    }
    if (mode === "jump") {
      await restoreInCurrentSession(ctx, target.record, source, id);
      return;
    }
    await ctx.fork(target.checkpointEntryId, {
      position: "at",
      withSession: (fresh: any) =>
        restoreIntoSession(fresh, target.record, source, {
          operation: "fork-restore",
          content: `Filesystem restored in forked Pi session from user prompt ${id}.`,
          failure: "Child restore failed; source files restored",
          notify: "Timeline fork restored.",
        }),
    });
  };

  pi.registerCommand("timeline", {
    description: "List, view, fork, or clear Git-backed prompt checkpoints",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      if (!enabled) {
        ctx.ui.notify("Timeline is disabled for this session.", "warning");
        return;
      }
      await load(ctx);
      const [actionRaw, idRaw] = args.trim().split(/\s+/, 2);
      const action = actionRaw || "select";
      if (action === "list") return listCheckpoints(ctx);
      if (action === "clear") return clearCheckpoints(ctx);
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        ctx.ui.notify("Timeline restore requires interactive confirmation.", "error");
        return;
      }
      if (action !== "select") {
        if (!idRaw) {
          ctx.ui.notify("Unknown or unavailable checkpoint.", "error");
          return;
        }
        return restoreCheckpoint(ctx, idRaw, action);
      }
      const selection = await promptForCheckpoint(ctx);
      if (!selection) return;
      return restoreCheckpoint(ctx, selection.id, selection.mode);
    },
  });
}
