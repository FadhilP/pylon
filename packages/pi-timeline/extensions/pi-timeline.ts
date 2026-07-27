import { createHash } from "node:crypto";
import { join } from "node:path";
import { complete, type Message } from "@earendil-works/pi-ai/compat";
import {
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  capture,
  makePortable,
  worktreeFingerprint,
  type Snapshot,
} from "../src/snapshot.ts";
import { restore } from "../src/restore.ts";
import {
  classifyCompatibility,
  type Compatibility,
  type GitState,
} from "../src/compatibility.ts";
import {
  normalizeGeneratedTitle,
  promptText,
  promptTitle,
  SESSION_TITLE_PROMPT,
} from "../src/prompts.ts";
import { git, symbolicHead } from "../src/git.ts";
import {
  recordTimelineOwner,
  startSessionGc,
} from "../src/session-gc.ts";
import {
  findRunEntry,
  hasTimeline,
  isRunEntry,
  runTimelineId,
  RUN_ENTRY_TYPE,
  type RunEntry,
} from "../src/run.ts";
import { TIMELINE_STATE_VERSION, timelineStateSnapshot } from "../src/state.ts";
import {
  checkpointChanges,
  checkpointFileDiff,
  type TimelineChangeSet,
} from "../src/changes.ts";
type CheckpointRecord = Snapshot & {
  version: 3 | 4 | 5;
  kind: "pi-prompt-checkpoint";
  promptEntryId: string;
  ownerSessionId: string;
  continuationEntryId: string;
  createdAt: string;
  changes?: Pick<TimelineChangeSet, "fileCount" | "additions" | "deletions" | "binaryCount">;
  verification?: {
    runId: string;
    state: "passed";
    scope: "changed" | "project";
    worktreeId: string;
    checks: string[];
  };
};
type Bound = {
  record: CheckpointRecord;
  checkpointEntryId: string;
  preview: string;
  sessionId: string;
  sessionPath?: string;
};
type ClearV1 = {
  version: 1;
  ownerSessionId: string;
  checkpointEntryIds: string[];
};
const inspectGitState = async (cwd: string): Promise<GitState> => {
  const [gitRoot, commonDir, head, headRef] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(cwd, ["rev-parse", "HEAD"]),
    symbolicHead(cwd),
  ]);
  return { gitRoot, commonDir, head, headRef };
};
const shortRef = (ref: string) => ref.replace(/^refs\/heads\//, "");
const compatibilityLabel = (
  target: Snapshot,
  current: GitState,
  result = classifyCompatibility(target, current),
) => {
  if (!result.allowed)
    return result.reason === "repository-mismatch"
      ? "[blocked:repository]"
      : "[blocked:HEAD]";
  if (result.refState === "target-detached") return "[checkpoint:detached]";
  if (result.refState === "current-detached") return "[current:detached]";
  if (result.refState === "ref-mismatch")
    return `[branch:${shortRef(target.headRef!)}; current:${shortRef(current.headRef!)}]`;
  return target.headRef === null
    ? "[detached]"
    : `[branch:${shortRef(target.headRef!)}]`;
};
const checkpointRow = (bound: Bound, current: GitState) =>
  `${compatibilityLabel(bound.record, current)} ${bound.record.createdAt.replace(/\.\d{3}Z$/, "Z")} ${bound.preview}`;

const compatibilityDetail = (
  target: Snapshot,
  current: GitState,
  result: Compatibility,
) => {
  if (!result.allowed)
    return result.reason === "repository-mismatch"
      ? "Checkpoint belongs to a different repository."
      : "Checkpoint HEAD commit differs from current HEAD.";
  if (result.refState === "same")
    return target.headRef === null
      ? "Checkpoint and current state use detached HEAD at the same commit."
      : `Checkpoint branch: ${shortRef(target.headRef!)}. HEAD commit matches.`;
  const checkpoint = target.headRef === null ? "detached HEAD" : shortRef(target.headRef!),
    now = current.headRef === null ? "detached HEAD" : shortRef(current.headRef!);
  return `HEAD commit matches, but checkpoint used ${checkpoint} and current state uses ${now}. Restore updates index and working tree only; it does not switch branches.`;
};
export default function timelineExtension(
  pi: ExtensionAPI,
  completeTitle: typeof complete = complete,
  options: { artifactRoot?: string } = {},
) {
  const emitTelemetry = (value: unknown) => {
    try { pi.events.emit?.("pylon:telemetry", value); }
    catch { /* Telemetry must never affect session naming. */ }
  };
  let records = new Map<string, Bound>(),
    paired = false,
    namingDecided = false,
    namingGeneration = 0,
    stateRevision = 0,
    namingInFlight: number | undefined,
    pendingContext = "",
    suppressNextTreeWarning = false,
    activeRun: RunEntry | undefined,
    latestVerification: any,
    pendingBash = new Map<string, string | undefined>(),
    sharedWorktreeObserver = false,
    automaticMutation = false,
    releaseSessionLease: ((cleanupIfLast?: boolean) => Promise<void>) | undefined,
    ephemeralSession = false,
    currentSessionId = "",
    currentGit: any,
    lastCtx: any;
  const changeCache = new Map<string, TimelineChangeSet>();
  const changeBases = new Map<string, CheckpointRecord | null>();
  pi.events.emit?.("pylon:worktree-observer-request", {
    version: 1,
    respond: (value: any) => {
      if (value?.version === 1 && value.owner === "pylon-core") sharedWorktreeObserver = true;
    },
  });
  const disposeWorktreeChange = pi.events.on("pylon:worktree-change", (event: any) => {
    if (sharedWorktreeObserver && event?.version === 1 && event.cwd === lastCtx?.cwd && event.changed === true)
      automaticMutation = true;
  });
  const artifactRoot = options.artifactRoot ?? join(getAgentDir(), "pi-timeline");
  const key = (sessionId: string, entryId: string) => `${sessionId}:${entryId}`;
  const stateSnapshot = (available = true) => {
    const branch = lastCtx?.sessionManager.getBranch?.() ?? [];
    const positions = new Map<string, number>(
      branch.map((entry: any, index: number) => [entry.id, index] as const),
    );
    const compatibleCheckpoints = currentGit
      ? [...records.values()].filter((bound) =>
          bound.sessionId === currentSessionId
          && positions.has(bound.record.promptEntryId)
          && classifyCompatibility(bound.record, currentGit).allowed)
      : [];
    const undoPromptEntryIds = branch
      .filter((entry: any, index: number) =>
        entry.type === "message"
        && entry.message.role === "user"
        && compatibleCheckpoints.some((bound) =>
          (positions.get(bound.record.promptEntryId) ?? Number.POSITIVE_INFINITY) < index))
      .map((entry: any) => entry.id);
    return timelineStateSnapshot(
      currentSessionId,
      stateRevision,
      [...records].map(([id, bound]) => ({
        id,
        title: bound.preview.split(/\r?\n/, 1)[0] || "Checkpoint",
        createdAt: bound.record.createdAt,
        ...(bound.record.headRef ? { branch: shortRef(bound.record.headRef) } : {}),
        verified: bound.record.verification?.state === "passed",
        ownerSessionId: bound.record.ownerSessionId,
        ...(bound.record.changes ?? changeCache.get(id)
          ? { changes: bound.record.changes ?? changeCache.get(id) }
          : {}),
      })),
      available,
      undoPromptEntryIds,
    );
  };
  const publishState = (available = true) => {
    stateRevision++;
    pi.events.emit?.("pi-timeline:state-change", stateSnapshot(available));
  };
  const disposeStateRequest = pi.events.on("pi-timeline:state-request", (request: any) => {
    if (request?.version !== TIMELINE_STATE_VERSION || request.sessionId !== currentSessionId || typeof request.respond !== "function") return;
    try { request.respond(stateSnapshot()); } catch { /* State observers cannot affect Timeline. */ }
  });
  const disposeEditNavigation = pi.events.on("pi-timeline:edit-navigation", (request: any) => {
    if (request?.version !== 1
      || request.sessionId !== currentSessionId
      || typeof request.targetEntryId !== "string"
      || typeof request.rollbackFiles !== "boolean"
      || typeof request.respond !== "function"
      || !lastCtx) return;
    request.respond((async () => {
      const previousPaired = paired;
      if (!request.rollbackFiles) {
        suppressNextTreeWarning = true;
        return {
          apply: async () => { paired = false; refresh(lastCtx); },
          rollback: async () => { suppressNextTreeWarning = true; paired = previousPaired; refresh(lastCtx); },
          commit: async () => { suppressNextTreeWarning = false; },
          cancel: async () => { suppressNextTreeWarning = false; },
        };
      }

      const branch = lastCtx.sessionManager.getBranch();
      const positions = new Map<string, number>(
        branch.map((entry: any, index: number) => [entry.id, index] as const),
      );
      const targetPosition = positions.get(request.targetEntryId);
      const target = targetPosition === undefined ? undefined : [...records.values()]
        .filter((bound) => bound.sessionId === currentSessionId
          && (positions.get(bound.record.promptEntryId) ?? Number.POSITIVE_INFINITY) < targetPosition)
        .sort((left, right) =>
          (positions.get(right.record.promptEntryId) ?? -1) - (positions.get(left.record.promptEntryId) ?? -1))[0];
      if (!target) throw new Error("No Timeline checkpoint exists before this prompt");

      const current = await inspectGitState(lastCtx.cwd);
      const compatibility = classifyCompatibility(target.record, current);
      if (!compatibility.allowed) {
        throw new Error(compatibilityDetail(target.record, current, compatibility));
      }

      const source = await capture(lastCtx.cwd, currentSessionId, (root) =>
        recordTimelineOwner(artifactRoot, currentSessionId, root));
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
          paired = true;
          pendingContext = `Filesystem restored to before edited prompt ${request.targetEntryId}.`;
          refresh(lastCtx);
        },
        rollback: async () => {
          if (!closed) await restore(source, lastCtx.cwd);
          suppressNextTreeWarning = true;
          paired = previousPaired;
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
    })());
  });
  const calculateChanges = async (id: string, bound: Bound) => {
    const candidates = [...records.entries()]
      .filter(([candidateId, candidate]) =>
        candidateId !== id
        && candidate.sessionId === bound.sessionId
        && candidate.record.createdAt < bound.record.createdAt)
      .sort((left, right) => right[1].record.createdAt.localeCompare(left[1].record.createdAt));
    for (const [, candidate] of candidates) {
      try {
        return {
          changes: await checkpointChanges(bound.record, candidate.record),
          previous: candidate.record,
        };
      } catch {}
    }
    return { changes: await checkpointChanges(bound.record), previous: undefined };
  };
  const changesFor = async (id: string, bound: Bound) => {
    const cached = changeCache.get(id);
    if (cached) return cached;
    const result = await calculateChanges(id, bound);
    changeCache.set(id, result.changes);
    changeBases.set(id, result.previous ?? null);
    return result.changes;
  };
  const previousCompatible = async (id: string, bound: Bound) => {
    await changesFor(id, bound);
    return changeBases.get(id) ?? undefined;
  };
  const disposeFilesRequest = pi.events.on("pi-timeline:files-request", (request: any) => {
    if (request?.version !== 1
      || request.sessionId !== currentSessionId
      || typeof request.checkpointId !== "string"
      || typeof request.respond !== "function") return;
    const bound = records.get(request.checkpointId);
    request.respond((async () => {
      if (!bound || bound.sessionId !== currentSessionId)
        throw Error("Timeline checkpoint is unavailable");
      const changes = await changesFor(request.checkpointId, bound);
      return {
        version: 1,
        checkpointId: request.checkpointId,
        files: changes.files,
        totalCount: changes.fileCount,
        truncated: changes.truncated,
      };
    })());
  });
  const disposeDiffRequest = pi.events.on("pi-timeline:diff-request", (request: any) => {
    if (request?.version !== 1
      || request.sessionId !== currentSessionId
      || typeof request.checkpointId !== "string"
      || typeof request.path !== "string"
      || typeof request.respond !== "function") return;
    const bound = records.get(request.checkpointId);
    request.respond((async () => {
      if (!bound || bound.sessionId !== currentSessionId)
        throw Error("Timeline checkpoint is unavailable");
      return {
        version: 1,
        checkpointId: request.checkpointId,
        ...await checkpointFileDiff(
          bound.record,
          await previousCompatible(request.checkpointId, bound),
          request.path,
        ),
      };
    })());
  });
  const nameSession = async (ctx: any) => {
    if (namingDecided || namingInFlight !== undefined) return;
    const generation = namingGeneration;
    namingInFlight = generation;
    const branch = ctx.sessionManager.getBranch(),
      firstUser = branch.find(
        (entry: any) =>
          entry.type === "message" && entry.message.role === "user",
      ),
      finalAssistant = branch.findLast(
        (entry: any) =>
          entry.type === "message" && entry.message.role === "assistant",
      ),
      fallback = firstUser && promptTitle(firstUser.message);
    let name = fallback;
    let modelCall: { eventId: string; started: number; request: string; result: string } | undefined;
    try {
      const model = ctx.model;
      if (firstUser && model) {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (auth.ok && auth.apiKey) {
          const request = promptText(firstUser.message);
          const result = finalAssistant ? promptText(finalAssistant.message) : "";
          const sessionId = ctx.sessionManager.getSessionId();
          modelCall = {
            eventId: createHash("sha256").update(`${sessionId}:${generation}`).digest("hex"),
            started: Date.now(), request, result,
          };
          const message: Message = {
            role: "user",
            content: [{
              type: "text",
              text: `<user-request>\n${request}\n</user-request>\n<result>\n${result}\n</result>`,
            }],
            timestamp: Date.now(),
          };
          const response = await completeTitle(
            model,
            {
              systemPrompt: SESSION_TITLE_PROMPT,
              messages: [message],
            },
            {
              apiKey: auth.apiKey,
              headers: auth.headers,
              env: auth.env,
              maxTokens: 32,
              timeoutMs: 10_000,
              sessionId,
            },
          );
          const usage = response.usage ?? {};
          emitTelemetry({
            version: 1, eventId: modelCall.eventId, package: "pi-timeline", kind: "model_call",
            status: response.stopReason === "error" || response.stopReason === "aborted" ? "failed" : "completed",
            durationMs: Date.now() - modelCall.started,
            usage: { turns: 1, input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cost: usage.cost?.total ?? 0 },
            context: {
              request: { characters: request.length, hash: createHash("sha256").update(`${modelCall.eventId}:request:${request}`).digest("hex") },
              result: { characters: result.length, hash: createHash("sha256").update(`${modelCall.eventId}:result:${result}`).digest("hex") },
            },
          });
          const raw = response.content
            .filter((part: any) => part.type === "text")
            .map((part: any) => part.text)
            .join("\n");
          name = normalizeGeneratedTitle(raw) ?? fallback;
        }
      }
    } catch {
      if (modelCall)
        emitTelemetry({
          version: 1, eventId: modelCall.eventId, package: "pi-timeline", kind: "model_call", status: "failed",
          durationMs: Date.now() - modelCall.started,
          usage: { turns: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          context: {
            request: { characters: modelCall.request.length, hash: createHash("sha256").update(`${modelCall.eventId}:request:${modelCall.request}`).digest("hex") },
            result: { characters: modelCall.result.length, hash: createHash("sha256").update(`${modelCall.eventId}:result:${modelCall.result}`).digest("hex") },
          },
        });
      name = fallback;
    } finally {
      if (namingInFlight === generation) namingInFlight = undefined;
    }
    if (generation !== namingGeneration) return;
    if (!namingDecided && name) {
      namingDecided = true;
      pi.setSessionName(name);
    }
  };
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
    timelineId?: string,
  ) => {
    const byId = new Map(entries.map((entry: any) => [entry.id, entry]));
    const portable = new Set(entries.flatMap((entry: any) =>
      entry.type === "custom"
        && entry.customType === "pi-prompt-checkpoint"
        && (entry.data?.version === 4 || entry.data?.version === 5)
        && typeof entry.data.promptEntryId === "string"
        && typeof entry.data.snapshotId === "string"
        ? [`${entry.data.promptEntryId}:${entry.data.snapshotId}`]
        : []));
    let checkpointTimelineId: string | undefined;
    for (const entry of entries) {
      if (
        entry.type === "custom" &&
        entry.customType === RUN_ENTRY_TYPE &&
        isRunEntry(entry.data)
      ) {
        checkpointTimelineId = runTimelineId(entry.data);
      } else if (
        entry.type === "custom" &&
        entry.customType === "pi-prompt-checkpoint" &&
        (entry.data?.version === 3 || entry.data?.version === 4 || entry.data?.version === 5)
      ) {
        if (entry.data.version === 3
          && portable.has(`${entry.data.promptEntryId}:${entry.data.snapshotId}`)) continue;
        if (entry.data.headRef !== null && typeof entry.data.headRef !== "string") continue;
        if (timelineId && checkpointTimelineId !== timelineId) continue;
        const user = byId.get(entry.data.promptEntryId) as any;
        if (user?.type === "message" && user.message.role === "user")
          records.set(key(sessionId, entry.id), {
            record: entry.data,
            checkpointEntryId: entry.id,
            preview: promptText(user.message),
            sessionId,
            sessionPath,
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
    changeCache.clear();
    changeBases.clear();
    currentGit = await inspectGitState(ctx.cwd).catch(() => undefined);
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
    const timelineId = runTimelineId(activeRun);
    const sessions = await SessionManager.list(ctx.cwd);
    for (const session of sessions) {
      try {
        const manager = SessionManager.open(session.path);
        const entries = manager.getEntries();
        if (hasTimeline(entries, timelineId))
          loadEntries(entries, session.id, session.path, timelineId);
      } catch {}
    }
    if (!sessions.some((session) => session.id === ctx.sessionManager.getSessionId()))
      loadEntries(
        currentEntries,
        ctx.sessionManager.getSessionId(),
        ctx.sessionManager.getSessionFile(),
        timelineId,
      );
  };
  const hydrateLegacyChanges = async (sessionId: string) => {
    let changed = false;
    for (const [id, bound] of records) {
      if (currentSessionId !== sessionId || bound.sessionId !== sessionId) continue;
      if (bound.record.changes || changeCache.has(id)) continue;
      try {
        await changesFor(id, bound);
        changed = true;
      } catch {}
    }
    if (changed && currentSessionId === sessionId) publishState();
  };
  const refresh = (ctx: any) => {
    if (ctx.hasUI)
      ctx.ui.setStatus(
        "pi-timeline",
        records.size
          ? `Checkpoints: ${records.size} · Session: ${paired ? "Paired" : "Unpaired"}`
          : undefined,
      );
  };
  const deleteRefs = async (snapshot: Snapshot) => {
    const repositories = [{
      gitRoot: snapshot.gitRoot,
      worktreeRef: snapshot.worktreeRef,
      indexRef: snapshot.indexRef,
    }, ...(snapshot.nested ?? [])];
    for (const repository of repositories) {
      await git(repository.gitRoot, ["update-ref", "-d", repository.worktreeRef]);
      await git(repository.gitRoot, ["update-ref", "-d", repository.indexRef]);
    }
  };
  async function checkpoint(ctx: any): Promise<Snapshot | undefined> {
    const branch = ctx.sessionManager.getBranch(),
      user = [...branch]
        .reverse()
        .find(
          (e: any) => e.type === "message" && e.message.role === "user",
        ) as any;
    if (!user) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const existing = [...records.values()]
      .reverse()
      .find(
        (bound) =>
          bound.sessionId === sessionId &&
          bound.record.promptEntryId === user.id,
      );
    if (paired && existing) return existing.record;
    const continuation = ctx.sessionManager.getLeafId();
    let snap: Snapshot | undefined;
    try {
      snap = await capture(ctx.cwd, sessionId, (root) =>
        recordTimelineOwner(artifactRoot, sessionId, root));
      currentGit = snap;
      const identity = await worktreeId(ctx.cwd),
        verification = latestVerification?.worktreeId === identity && latestVerification.state === "passed"
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
      changeCache.set(key(sessionId, checkpointEntryId), changes);
      changeBases.set(key(sessionId, checkpointEntryId), calculated.previous ?? null);
      records.set(key(sessionId, checkpointEntryId), {
        record,
        checkpointEntryId,
        preview: promptText(user.message),
        sessionId,
        sessionPath: ctx.sessionManager.getSessionFile(),
      });
      paired = true;
      refresh(ctx);
      publishState();
      return record;
    } catch (e: any) {
      if (snap) await deleteRefs(snap).catch(() => {});
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
  const disposeRelocation = pi.events.on("pi-timeline:relocation-readiness", (request: any) => {
    if (request?.version !== 1
      || request.sessionId !== currentSessionId
      || typeof request.respond !== "function"
      || !lastCtx) return;
    request.respond((async () => {
      const migrating = [...records.entries()].filter(([, bound]) =>
        bound.sessionId === currentSessionId && bound.record.version === 3);
      for (const [recordKey, bound] of migrating) {
        const portable = await makePortable(bound.record, lastCtx.cwd);
        const record: CheckpointRecord = { ...bound.record, ...portable, version: 4 };
        pi.appendEntry("pi-prompt-checkpoint", record);
        const checkpointEntryId = lastCtx.sessionManager.getLeafId()!;
        records.delete(recordKey);
        records.set(key(currentSessionId, checkpointEntryId), {
          ...bound,
          record,
          checkpointEntryId,
        });
      }
      if (migrating.length) {
        refresh(lastCtx);
        publishState();
      }
      return { version: 1, ready: true };
    })());
  });
  pi.on("session_start", async (_e, ctx) => {
    lastCtx = ctx;
    latestVerification = undefined;
    pendingBash.clear();
    automaticMutation = false;
    const nextSessionId = ctx.sessionManager.getSessionId();
    const reuseSessionLease = !!releaseSessionLease && currentSessionId === nextSessionId;
    if (releaseSessionLease && !reuseSessionLease)
      await releaseSessionLease(ephemeralSession);
    currentSessionId = nextSessionId;
    if (!reuseSessionLease)
      releaseSessionLease = await startSessionGc(artifactRoot, currentSessionId);
    ephemeralSession = !ctx.sessionManager.getSessionFile?.();
    await load(ctx);
    paired = false;
    namingGeneration++;
    namingInFlight = undefined;
    namingDecided = ctx.sessionManager
      .getEntries()
      .some((entry: any) => entry.type === "session_info");
    refresh(ctx);
    publishState();
    void hydrateLegacyChanges(currentSessionId);
  });
  pi.on("session_shutdown", async () => {
    namingGeneration++;
    namingInFlight = undefined;
    publishState(false);
    disposeStateRequest();
    disposeEditNavigation();
    disposeVerify();
    disposeCheckpoint();
    disposeRelocation();
    disposeWorktreeChange();
    disposeFilesRequest();
    disposeDiffRequest();
    await releaseSessionLease?.(ephemeralSession);
    releaseSessionLease = undefined;
    currentSessionId = "";
  });
  pi.on("session_info_changed", () => {
    namingDecided = true;
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") paired = false;
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && !sharedWorktreeObserver)
      pendingBash.set(event.toolCallId, await worktreeFingerprint(ctx.cwd));
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "bash" && !sharedWorktreeObserver) {
      const before = pendingBash.get(event.toolCallId);
      pendingBash.delete(event.toolCallId);
      const after = await worktreeFingerprint(ctx.cwd);
      if (!before || !after || before !== after) automaticMutation = true;
    } else if (["write", "edit", "heartbeat_start"].includes(event.toolName)) {
      automaticMutation = true;
    }
  });
  pi.on("agent_settled", async (_e, ctx) => {
    if (automaticMutation && await checkpoint(ctx)) automaticMutation = false;
    await nameSession(ctx);
  });
  pi.on("session_tree", (_e, ctx) => {
    if (suppressNextTreeWarning) {
      suppressNextTreeWarning = false;
      return;
    }
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
        const current = await inspectGitState(ctx.cwd);
        ctx.ui.notify(
          [...records]
            .map(([, bound]) => checkpointRow(bound, current))
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
        publishState();
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
        const current = await inspectGitState(ctx.cwd);
        const choices = [...records].map(([checkpointId, bound]) => ({
          id: checkpointId,
          label: checkpointRow(bound, current),
        }));
        const selected = await ctx.ui.select(
          "Checkpoint",
          choices.map((choice) => choice.label),
        );
        id = choices.find((choice) => choice.label === selected)?.id;
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
      let current = await inspectGitState(ctx.cwd),
        compatibility = classifyCompatibility(target.record, current);
      if (!compatibility.allowed) {
        ctx.ui.notify(compatibilityDetail(target.record, current, compatibility), "error");
        return;
      }
      const source = await checkpoint(ctx);
      if (!source) {
        ctx.ui.notify("Unable to checkpoint current state.", "error");
        return;
      }
      current = source;
      compatibility = classifyCompatibility(target.record, current);
      if (!compatibility.allowed) {
        ctx.ui.notify(
          `Git state changed while creating rollback checkpoint. ${compatibilityDetail(target.record, current, compatibility)}`,
          "error",
        );
        return;
      }
      const ok = await ctx.ui.confirm(
        mode === "fork" ? "Fork and restore?" : "View and restore?",
        `${target.preview}\n${compatibilityDetail(target.record, current, compatibility)}\nCurrent dirty state is checkpointed. Ignored files stay untouched.`,
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
