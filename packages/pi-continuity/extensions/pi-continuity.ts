import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  fresh,
  setPlan,
  updateTodo,
  hasRemainingTodos,
  sessionWorkFile,
  isWork,
  type Work,
} from "../src/active-work.ts";
import {
  readJson,
  readVersionedJson,
  writeJson,
  writeJsonAtomic,
  updateJson,
  withFileLock,
  withStateLock,
  rm,
  defaultRoot,
} from "../src/storage.ts";
import { isWorkspace, registerWorkspace, type Workspace } from "../src/workspace.ts";
import { pruneOrphanWorkFiles, startSessionGc } from "../src/session-gc.ts";
import {
  applyReview,
  directDelete,
  directEdit,
  discardExpiredReviews,
  emptyMemoryState,
  enforceMemoryLimits,
  exactDuplicate,
  isMemoryState,
  notesForOwners,
  normalizeMemoryState,
  stageReview,
  sha256,
  strongDuplicate,
  type MemoryScope,
  type MemoryStateFile,
  type NotebookNote,
  type ReviewRecord,
} from "../src/memory.ts";
import {
  callMemoryReviewer,
  preflightMemoryProposals,
  reviewedRecord,
  userMessageText,
} from "../src/memory-review.ts";
import { hasPendingV4Migration, isMigrationJournal, migrateV4, recordPendingV4Migration, type MigrationJournal } from "../src/memory-migration.ts";
import { assertSafe, sanitizeAndClip } from "../src/secrets.ts";
import { blocked, planningTools } from "../src/plan-gate.ts";
import { buildContext, buildMemoryInjection, retrievalQueries, shortlistNotes } from "../src/context.ts";
import { validateQuestions } from "../src/questions.ts";
import { askQuestionnaire } from "../src/clarify-ui.ts";
import { captureEvidenceRanges, currentChangedPaths, projectContext, worktreeFingerprint, type ProjectContext } from "../src/worktree.ts";
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  loadConfig,
  parseModelRef,
  saveConfig,
  updateConfig,
  thinkingLevels,
  type ModelProfile,
  type ThinkingLevel,
} from "../src/config.ts";
import {
  findRunEntry,
  HANDOFF_ENTRY_TYPE,
  runTimelineId,
  RUN_ENTRY_TYPE,
  type RunEntry,
} from "../src/run.ts";
import { CONTINUITY_STATE_VERSION, continuityStateSnapshot } from "../src/state.ts";
import { finalizeContinuityCompaction, prepareContinuityCompaction, type CompactionSupplement } from "../src/compaction.ts";
import { buildCompactionReviewPacket, callCompactionReviewer } from "../src/compaction-review.ts";
import { canUseBroadRecall, recallProjectSessions, recallSession } from "../src/recall.ts";
import { loadProjectRecallSessions } from "../src/project-recall.ts";
import { findMovedProjectOwner, reassociateOwnerNotes } from "../src/owner-reassociation.ts";
const continuityTools = ["continuity_recall", "continuity_update", "memory"];
const memoryPreflightTools = new Set(["bash", "edit", "grunt", "heartbeat_start", "write"]);
const memoryActionFields = ["action", "checkCommands", "command", "label", "operation", "package", "packages", "path", "paths", "query", "sql", "suggestedPaths", "target", "targetedContext", "task"];
const memoryAction = (toolName: string, input: any) => {
  if (!memoryPreflightTools.has(toolName)) return;
  const fields: Array<[string, string]> = [];
  for (const field of memoryActionFields) {
    const value = input?.[field];
    if (typeof value === "string") fields.push([field, value]);
    else if (Array.isArray(value))
      fields.push(...value.filter((item): item is string => typeof item === "string").map((item) => [field, item] as [string, string]));
  }
  const raw = `${toolName.replaceAll("_", " ")} ${fields.map(([, value]) => value).join(" ")}`;
  const signals = [
    /\b(?:npm|pnpm|yarn|bun)\b[^\n]*\b(?:add|install|remove|uninstall)\b|\b(?:pip|cargo|go)\s+(?:install|get)\b/i.test(raw) ? "dependency package" : "",
    /\b(?:migrat\w*|schema)\b/i.test(raw) ? "database migration" : "",
    /\b(?:deploy|publish|release)\w*\b/i.test(raw) ? "deploy publish release" : "",
  ].filter(Boolean);
  const query = sanitizeAndClip(`${raw} ${signals.join(" ")}`, 2_000).trim();
  const signatureFields = fields.map(([field, value]) => [field, sanitizeAndClip(value, 500).toLowerCase().replace(/\s+/g, " ").trim()]);
  return { query, signature: sha256(JSON.stringify([toolName, signatureFields])) };
};
const isVerificationOnlyTodo = (text: string) =>
  /\b(?:verify|verification|tests?|testing|lint|typecheck|checks?)\b/i.test(text) &&
  !/\b(?:implement|fix|add|update|change|refactor|write|remove|migrate)\b/i.test(text);
const setIssue = (
  active: Work,
  kind: NonNullable<Work["issue"]>["kind"],
  failure: string,
  nextAction: string,
  id?: string,
) => {
  active.latestFailure = failure;
  active.nextAction = nextAction;
  active.issue = { kind, ...(id ? { id } : {}) };
};
const clearIssue = (active: Work) => {
  delete active.latestFailure;
  delete active.nextAction;
  delete active.issue;
};
const applyManualIssueUpdate = (
  active: Work,
  failure: string | undefined,
  nextAction: string | undefined,
) => {
  if (failure !== undefined) {
    if (failure) active.latestFailure = failure;
    else delete active.latestFailure;
  }
  if (nextAction !== undefined) {
    if (nextAction) active.nextAction = nextAction;
    else delete active.nextAction;
  }
  if (failure !== undefined || nextAction !== undefined) {
    if (active.latestFailure || active.nextAction) active.issue = { kind: "manual" };
    else delete active.issue;
  }
};

const formatPlan = (work: Work) => [
  "Plan",
  "",
  "Goal",
  work.goal.trim() || "Not specified",
  "",
  "Approach",
  work.planSummary?.trim() || "Not specified",
  "",
  "Constraints",
  ...(work.constraints.length
    ? work.constraints.map((constraint) => `- ${constraint}`)
    : ["- None"]),
  "",
  "Steps",
  ...work.todos.map((todo, index) => `${index + 1}. ${todo.text}`),
].join("\n");

const isCurrentHandoffBoundary = (message: any, active: Work | undefined) => {
  const details = message?.details;
  return Boolean(
    active?.runId &&
    (active.mode === "executing" || active.mode === "completed") &&
    message?.role === "custom" &&
    message.customType === HANDOFF_ENTRY_TYPE &&
    details?.version === 1 &&
    details.runId === active.runId &&
    details.timelineId === (active.timelineId ?? active.runId)
  );
};

const Status = StringEnum(["pending", "in_progress", "done", "blocked"] as const),
  Action = StringEnum([
    "clarify",
    "set_plan",
    "todo",
    "state",
  ] as const),
  MemAction = StringEnum(["list", "propose"] as const),
  ScopeName = StringEnum(["user", "project"] as const),
  RecallScopeName = StringEnum(["execution", "lineage", "all", "project_sessions"] as const),
  RecallModeName = StringEnum(["text", "files", "touched"] as const);
export default function continuityExtension(pi: ExtensionAPI) {
  let duplicate = false;
  pi.events.emit("pi-continuity:instance-claim", {
    version: 1,
    respond: () => { duplicate = true; },
  });
  if (duplicate) return;
  const instanceId = randomUUID();
  const disposeInstanceClaim = pi.events.on(
    "pi-continuity:instance-claim",
    (request: any) => {
      if (request?.version === 1) request.respond?.(instanceId);
    },
  );
  let root = defaultRoot(),
    dir = "",
    workFile = "",
    workspace: Workspace | undefined,
    all: Workspace[] = [],
    work: Work | undefined,
    memoryState: MemoryStateFile = emptyMemoryState(),
    memoryNotes: NotebookNote[] = [],
    reviewCalledThisTask = false,
    memoryProposalToken: string | undefined,
    memoryTaskGeneration = 0,
    project: ProjectContext | undefined,
    savedTools: string[] | undefined,
    lastPrompt = "",
    memoryEnabled = true,
    memoryInjectionEnabled = true,
    memoryContextToken: string | undefined,
    surfacedMemoryIds = new Set<string>(),
    pendingPreflightMemoryIds = new Set<string>(),
    preflightedMemoryActions = new Set<string>(),
    legacyMigrationAvailable = false,
    activeSessionContext: any,
    tasksVisible = true,
    currentCwd = "",
    latestVerification: any,
    needsVerification = false,
    awaitingClarificationProse = false,
    recentCalls = new Map<string, number[]>(),
    pendingMutations = new Map<string, string | undefined>(),
    deniedToolCalls = new Set<string>(),
    seenMutationMessages = new Set<string>(),
    terminatingToolCalls = new Set<string>(),
    automaticCompaction: { sessionGeneration: number; taskGeneration: number; sessionId: string } | undefined,
    sharedWorktreeObserver = false,
    pendingApproval: { runId?: string; revision: number } | undefined,
    approvalContext: any,
    approvalSelectionOpen = false,
    clarifyTimeoutSeconds: number | null | undefined,
    sessionGeneration = 0,
    stateRevision = 0,
    releaseSessionLease: ((cleanupIfLast?: () => Promise<void>) => Promise<void>) | undefined,
    leasedSessionId = "",
    ephemeralSession = false,
    schedulePlanApproval = (_ctx: any) => {};
  let memoryLifecycleQueue = Promise.resolve();
  const withMemoryLifecycle = async <T>(task: () => Promise<T>): Promise<T> => {
    const previous = memoryLifecycleQueue; let release = () => {};
    memoryLifecycleQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await task(); } finally { release(); }
  };
  pi.events.emit("pylon:worktree-observer-request", {
    version: 1,
    respond: (value: any) => {
      if (value?.version === 1 && value.owner === "pylon-core") sharedWorktreeObserver = true;
    },
  });
  const invalidateVerification = () => {
    latestVerification = undefined;
    needsVerification = true;
  };
  const disposeWorktreeChange = pi.events.on("pylon:worktree-change", (event: any) => {
    if (!sharedWorktreeObserver || event?.version !== 1 || event.cwd !== currentCwd || event.changed !== true) return;
    invalidateVerification();
  });
  const disposePackageMutation = pi.events.on("pi-worktree:mutation", (event: any) => {
    if (event?.version !== 1 || event.cwd !== currentCwd || event.changed !== true) return;
    invalidateVerification();
  });
  const disposeGuardDecision = pi.events.on("pi-guard:decision", (event: any) => {
    if (event?.version === 1 && event.cwd === currentCwd && event.decision === "blocked" && typeof event.toolCallId === "string")
      deniedToolCalls.add(event.toolCallId);
  });
  const modelName = (model: any) => `${model.provider}/${model.id}`;
  const assistantContent = (ctx: any) => {
    const entry = ctx.sessionManager?.getLeafEntry?.();
    const content = entry?.type === "message" && entry.message?.role === "assistant"
      ? entry.message.content
      : undefined;
    return Array.isArray(content) ? content : [];
  };
  const hasReplyBeforeCompletion = (event: any, ctx: any) => {
    const content = assistantContent(ctx);
    const callIndex = content.findIndex(
      (part: any) => part?.type === "toolCall" && part.id === event.toolCallId,
    );
    return callIndex > 0 && content
      .slice(0, callIndex)
      .some((part: any) => part?.type === "text" && part.text.trim());
  };
  const hasUnsafeClarificationBatch = (ctx: any) => {
    const calls = assistantContent(ctx).filter((part: any) => part?.type === "toolCall");
    return calls.length > 1 && calls.some(
      (part: any) =>
        part.name === "continuity_update" && part.arguments?.action === "clarify",
    );
  };
  const disposeRuntimePolicy = pi.events.on?.("pylon:runtime-policy", (event: any) => {
    if (event?.version !== 2) return;
    const value = event.dialogTimeouts?.clarify;
    if (value === null || Number.isInteger(value) && value >= 15 && value <= 86_400) {
      clarifyTimeoutSeconds = value;
    }
  });
  const clarifyDialogOptions = () => clarifyTimeoutSeconds === undefined
    ? undefined
    : { timeout: clarifyTimeoutSeconds === null ? 0 : clarifyTimeoutSeconds * 1_000 };
  const tripsCircuitBreaker = (params: unknown) => {
    const now = Date.now(), cutoff = now - 30_000;
    for (const [key, times] of recentCalls) {
      const fresh = times.filter((time) => time > cutoff);
      if (fresh.length) recentCalls.set(key, fresh);
      else recentCalls.delete(key);
    }
    const key = JSON.stringify([
      params,
      latestVerification?.state,
      work?.mode,
      work?.currentTodoId,
      work?.todos.map((todo) => [todo.id, todo.status]),
    ]);
    const times = [...(recentCalls.get(key) ?? []), now];
    recentCalls.set(key, times);
    if (times.length < 3) return false;
    recentCalls.delete(key);
    return true;
  };
  const configuredModel = async (
    ctx: any,
    profile: ModelProfile | undefined,
    fallback?: { provider: string; id: string },
  ) => {
    const ref = profile ? parseModelRef(profile.model) : fallback;
    const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
    return model;
  };
  const applyProfile = async (
    ctx: any,
    profile: ModelProfile | undefined,
  ) => {
    if (!profile) return true;
    const model = await configuredModel(ctx, profile);
    if (!model || !(await pi.setModel(model))) return false;
    if (profile.thinking) pi.setThinkingLevel(profile.thinking);
    return true;
  };
  const paths = () => ({
    work: workFile,
    memory: join(root, "memory-v5", "state.json"),
    migration: join(root, "memory-v5", "migration.json"),
    legacyMemory: join(root, "memory-v4", "memory.json"),
    legacyCandidates: join(root, "memory-v4", "candidates.json"),
  });
  const memoryDirectory = () => join(root, "memory-v5");
  const readMemory = async () => normalizeMemoryState(await readVersionedJson(paths().memory, emptyMemoryState(), isMemoryState))!;
  const writeMemory = async (state: MemoryStateFile) => writeJsonAtomic(paths().memory, state);
  const ownerFor = (scope: MemoryScope) => scope === "user" ? "default" : project?.owner;
  const resolveProject = async (cwd: string) => {
    const resolved = await projectContext(cwd, workspace?.projectOwner ?? project?.owner ?? workspace!.id);
    project = resolved;
    if (workspace && resolved.owner !== workspace.id && workspace.projectOwner !== resolved.owner) {
      workspace.projectOwner = resolved.owner;
      all = await updateJson<Workspace[]>(join(root, "workspaces.json"), [], (items) =>
        items.map((item) => item.id === workspace!.id ? { ...item, projectOwner: resolved.owner } : item), Array.isArray);
    }
    return resolved;
  };
  const reassociateProjectMemory = async (latest: MemoryStateFile) => {
    if (!project) return latest;
    const workspaces = await readJson<Workspace[]>(join(root, "workspaces.json"), [], (items) => Array.isArray(items) && items.every(isWorkspace));
    const oldOwner = await findMovedProjectOwner(currentCwd, project.owner, workspaces, latest.notes);
    if (!oldOwner) return latest;
    const at = new Date().toISOString(), migrationId = randomUUID();
    const reassociated = reassociateOwnerNotes(oldOwner, project.owner, latest.notes, at);
    const affected = [...reassociated.moved, ...reassociated.suppressed];
    if (!affected.length) return latest;
    const backup = {
      version: 1, migrationId, oldOwner, currentOwner: project.owner, createdAt: at,
      fromRevision: latest.revision, movedNoteIds: reassociated.moved.map((note) => note.id),
      suppressedNoteIds: reassociated.suppressed.map((note) => note.id), notes: affected,
    };
    const audit = { type: "owner_reassociation" as const, migrationId, oldOwner, owner: project.owner, at,
      movedNoteIds: backup.movedNoteIds, suppressedNoteIds: backup.suppressedNoteIds, fromRevision: latest.revision };
    const next = { ...latest, revision: latest.revision + 1, notes: reassociated.notes, audits: [...(latest.audits ?? []), audit].slice(-100), updatedAt: at };
    enforceMemoryLimits(next);
    await writeJsonAtomic(join(memoryDirectory(), "backups", `owner-reassociation-${migrationId}.json`), backup);
    return next;
  };
  const newlyRelevantMemory = async (queries: string[], markSurfaced = true) => {
    if (!queries.length) return { text: "", notes: [] as NotebookNote[] };
    project = await resolveProject(currentCwd);
    const injection = buildMemoryInjection(
      notesForOwners(memoryNotes, project.owner),
      queries,
      100,
      surfacedMemoryIds,
    );
    if (markSurfaced) for (const note of injection.notes) surfacedMemoryIds.add(note.id);
    return injection;
  };
  const projectMemory = () => project
    ? memoryNotes.filter((note) => note.scope === "project" && note.owner === project!.owner)
    : [];
  const globalMemory = () => memoryNotes.filter((note) => note.scope === "user" && note.owner === "default");
  const stateSnapshot = (available = true) =>
    continuityStateSnapshot(
      leasedSessionId,
      stateRevision,
      work,
      available,
      projectMemory(),
      globalMemory(),
      legacyMigrationAvailable,
    );
  const publishState = (available = true) => {
    stateRevision++;
    pi.events.emit("pi-continuity:state-change", stateSnapshot(available));
  };
  const emitMemoryOutcome = (outcome: "preflight_rejected" | "reviewer_failed" | "staged" | "committed" | "discarded" | "migration_failed" | "migration_committed") =>
    pi.events.emit("pi-continuity:memory-outcome", { version: 1, outcome, at: new Date().toISOString() });
  const disposeStateRequest = pi.events.on("pi-continuity:state-request", (request: any) => {
    if (request?.version !== CONTINUITY_STATE_VERSION || request.sessionId !== leasedSessionId || typeof request.respond !== "function") return;
    try { request.respond(stateSnapshot()); } catch { /* State observers cannot affect Continuity. */ }
  });
  const disposeMemoryMutation = pi.events.on("pi-continuity:memory-mutation", (request: any) => {
    if (request?.version !== 2 && typeof request?.respond === "function") {
      request.respond(Promise.reject(new Error("Continuity memory mutation version 1 is no longer supported")));
      return;
    }
    if (request?.version !== 2 || typeof request.respond !== "function") return;
    if (request.sessionId !== leasedSessionId || request.expectedGeneration !== sessionGeneration) {
      request.respond(Promise.reject(new Error("Continuity memory mutation is stale or belongs to another session")));
      return;
    }
    const operation = withMemoryLifecycle(async () => {
      if (!memoryEnabled) throw Error("Continuity memory is disabled in package settings");
      const requestedSession = request.sessionId, requestedGeneration = request.expectedGeneration, requestedCwd = currentCwd;
      if (request.action === "migrate") {
        const allowed = new Set(["version", "sessionId", "expectedGeneration", "action", "respond"]);
        if (Object.keys(request).some((key) => !allowed.has(key))) throw Error("invalid memory migration fields");
        if (!activeSessionContext || !legacyMigrationAvailable) throw Error("V4 memory migration is unavailable or already changed");
        const migration = await runV4Migration(activeSessionContext, requestedSession);
        if (leasedSessionId !== requestedSession || sessionGeneration !== requestedGeneration || currentCwd !== requestedCwd) throw Error("Continuity memory migration became stale");
        legacyMigrationAvailable = await hasPendingV4Migration(root);
        if (migration.migrated) emitMemoryOutcome("migration_committed");
        publishState();
        return migration;
      }
      if (request.action !== "update" && request.action !== "delete") throw Error("invalid memory action");
      const allowed = request.action === "update" ? new Set(["version", "sessionId", "expectedGeneration", "action", "scope", "id", "trigger", "guidance", "expectedRevision", "respond"]) : new Set(["version", "sessionId", "expectedGeneration", "action", "scope", "id", "expectedRevision", "respond"]);
      if (Object.keys(request).some((key) => !allowed.has(key))) throw Error("invalid memory mutation fields");
      if ((request.scope !== "user" && request.scope !== "project") || typeof request.id !== "string" || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) throw Error("invalid memory target");
      const resolved = await resolveProject(requestedCwd), owner = request.scope === "user" ? "default" : resolved.owner;
      await withStateLock(memoryDirectory(), async () => {
        if (leasedSessionId !== requestedSession || sessionGeneration !== requestedGeneration || currentCwd !== requestedCwd || project?.owner !== resolved.owner) throw Error("Continuity memory mutation became stale");
        const latest = await readMemory();
        const next = request.action === "delete"
          ? directDelete(latest, request.scope, owner, request.id, request.expectedRevision)
          : directEdit(latest, request.scope, owner, request.id, request.expectedRevision, request.trigger, request.guidance);
        await writeMemory(next);
        memoryState = next;
        memoryNotes = next.notes;
      });
      publishState();
      return { updated: true, revision: memoryState.revision };
    });
    request.respond(operation);
  });
  const saveWork = async () => {
    if (work) {
      assertSafe(
        work.goal,
        work.planSummary,
        ...work.constraints,
        work.latestFailure,
        work.nextAction,
        ...work.todos.map((t) => t.text),
      );
      await writeJson(paths().work, work);
      publishState();
    }
  };
  const refresh = (ctx: any) => {
    if (ctx.hasUI) ctx.ui.setStatus("pi-continuity", undefined);
    if (ctx.mode === "tui")
      ctx.ui.setWidget(
        "pi-continuity",
        work && !["handed_off", "completed", "cancelled"].includes(work.mode)
          ? (_tui: unknown, theme: any) =>
              new Text(
                [
                  "Tasks",
                  ...work!.todos.map((t) =>
                    t.status === "done"
                      ? `● ${theme.fg("muted", theme.strikethrough(t.text))}`
                      : `${t.status === "in_progress" ? "●" : "○"} ${t.text}`,
                  ),
                ].join("\n"),
                0,
                0,
              )
          : undefined,
      );
  };
  const hideTasks = (ctx: any) => {
    if (ctx.mode === "tui") ctx.ui.setWidget("pi-continuity", undefined);
  };
  const activeBranchHasToolResult = (ctx: any, toolCallId: string) => (ctx.sessionManager.getBranch?.() ?? []).some((entry: any) => entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId);
  const settleMemoryReviews = async (ctx: any) => withMemoryLifecycle(async () => {
    if (!memoryEnabled || !project) return;
    const expectedSession = leasedSessionId, expectedGeneration = sessionGeneration, expectedOwner = project.owner, expectedCwd = currentCwd;
    await withStateLock(memoryDirectory(), async () => {
      if (leasedSessionId !== expectedSession || sessionGeneration !== expectedGeneration || currentCwd !== expectedCwd || project?.owner !== expectedOwner) return;
      let latest = await readMemory(), changed = false;
      const reconciled = discardExpiredReviews(latest);
      if (reconciled !== latest) { latest = reconciled; changed = true; }
      for (const original of latest.reviews.filter((item) => item.status === "approved_pending" && item.sessionId === expectedSession && item.projectOwner === expectedOwner)) {
        const discard = (reason: string) => {
          const now = new Date().toISOString();
          latest = { ...latest, revision: latest.revision + 1, updatedAt: now, reviews: latest.reviews.map((item) => item.reviewId === original.reviewId ? { ...item, status: "discarded" as const, discardReason: reason, settledAt: now } : item) };
          changed = true; emitMemoryOutcome("discarded");
        };
        if (original.generation !== expectedGeneration || original.taskGeneration !== memoryTaskGeneration) { discard("session or task generation changed"); continue; }
        if (!activeBranchHasToolResult(ctx, original.toolCallId)) { discard("proposal tool result is not on the active branch"); continue; }
        const branch = ctx.sessionManager.getBranch?.() ?? [], byId = new Map(branch.map((entry: any) => [entry?.id, entry]));
        if (original.quoteRefs?.some((ref) => {
          const entry = byId.get(ref.entryId);
          return !entry || sha256(userMessageText(entry)) !== ref.entrySha256;
        })) { discard("quoted user instruction changed or left the active branch"); continue; }
        let evidenceValid = true;
        for (const batch of original.evidenceBatches ?? []) {
          try {
            const fresh = await captureEvidenceRanges(expectedCwd, batch.map(({ path, start, end }) => ({ path, start, end })));
            if (fresh.some((range, index) => range.excerptSha256 !== batch[index]?.excerptSha256)) evidenceValid = false;
          } catch { evidenceValid = false; }
        }
        if (!evidenceValid) { discard("cited evidence changed or is unavailable after memory review"); continue; }
        const currentIdentity = original.requiresVerification ? await worktreeFingerprint(expectedCwd) : undefined;
        if (original.requiresVerification && (!currentIdentity || original.worktreeIdentity !== currentIdentity)) { discard("worktree changed after memory review"); continue; }
        if (original.requiresVerification) {
          if (["failed", "stale", "cancelled", "error"].includes(latestVerification?.state)) { discard(`verification ${latestVerification.state}`); continue; }
          if (latestVerification?.state !== "passed") continue;
          if (latestVerification.sessionId !== expectedSession || latestVerification.worktreeId !== currentIdentity) { discard("verification does not cover the reviewed worktree"); continue; }
        }
        const record = original.requiresVerification ? { ...original, verificationRevision: latestVerification.runId } : original;
        try { latest = applyReview(latest, record); changed = true; emitMemoryOutcome("committed"); }
        catch (error: any) { discard(error?.message ?? "review conflict"); }
      }
      if (changed) await writeMemory(latest);
      memoryState = latest;
      memoryNotes = latest.notes;
    });
    publishState();
  });
  const runV4Migration = async (ctx: any, expectedSession: string) => {
    const expectedGeneration = sessionGeneration, expectedTaskGeneration = memoryTaskGeneration, expectedCwd = currentCwd;
    const resolved = await resolveProject(expectedCwd), expectedOwner = resolved.owner, expectedWorkspaceId = workspace?.id;
    if (!expectedWorkspaceId) throw Error("migration workspace identity is unavailable");
    const config = await loadConfig(), profile = config.memoryReviewer;
    if (!profile) throw Error("Memory Reviewer is not configured");
    const model = await configuredModel(ctx, profile);
    if (!model) throw Error("Memory Reviewer model or credentials are unavailable");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok || !auth.apiKey) throw Error("Memory Reviewer model or credentials are unavailable");
    const ownerRoots = new Map<string, string>();
    for (const item of all) if (item.projectOwner) ownerRoots.set(item.projectOwner, item.canonicalPath);
    ownerRoots.set(expectedOwner, expectedCwd);
    return migrateV4({
      root, ownerRoots, model, auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env }, profile, sessionId: expectedSession,
      onTelemetry: (value) => pi.events.emit("pi-continuity:memory-migration-telemetry", { version: 1, model: modelName(model), thinking: profile.thinking, ...value }),
      commitAll: async (imported) => withStateLock(memoryDirectory(), async () => {
        if (leasedSessionId !== expectedSession || sessionGeneration !== expectedGeneration || memoryTaskGeneration !== expectedTaskGeneration || currentCwd !== expectedCwd
          || workspace?.id !== expectedWorkspaceId || project?.owner !== expectedOwner || (await projectContext(expectedCwd, expectedWorkspaceId)).owner !== expectedOwner) throw Error("migration activation became stale");
        const latest = await readMemory(), byId = new Map(latest.notes.map((note) => [note.id, note])), missing = imported.filter((note) => !byId.has(note.id));
        if (!missing.length) { memoryState = latest; memoryNotes = latest.notes; return latest.revision; }
        if (missing.length !== imported.length) throw Error("migration activation is partially present; manual reconciliation required");
        for (const note of imported) if (strongDuplicate(latest.notes, note.scope, note.owner, note.trigger, note.guidance)) throw Error(`migration duplicates existing note ${note.id}`);
        let next = { ...latest, revision: latest.revision + 1, notes: [...latest.notes, ...imported], updatedAt: new Date().toISOString() };
        next = await reassociateProjectMemory(next);
        enforceMemoryLimits(next); await writeMemory(next); memoryState = next; memoryNotes = next.notes; return next.revision;
      }),
    });
  };
  const enabledContinuityTools = () => memoryEnabled ? continuityTools : continuityTools.filter((tool) => tool !== "memory");
  const gate = (on: boolean) => {
    if (on) savedTools ??= pi.getActiveTools();
    let coordinated = false;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-continuity",
      managedTools: continuityTools,
      enabledTools: enabledContinuityTools(),
      ...(on ? { allowOnly: planningTools() } : {}),
      ...(!on && savedTools ? { restoreTools: [...new Set([
        ...savedTools.filter((tool) => memoryEnabled || tool !== "memory"),
        ...enabledContinuityTools(),
      ])] } : {}),
      acknowledge: () => { coordinated = true; },
    });
    if (coordinated) {
      if (!on) savedTools = undefined;
      return;
    }
    if (on) {
      const allowed = new Set(planningTools());
      pi.setActiveTools([...new Set([
        ...pi.getActiveTools().filter((tool) => allowed.has(tool) && (memoryEnabled || tool !== "memory")),
        ...enabledContinuityTools(),
      ])]);
    } else if (savedTools) {
      pi.setActiveTools([...new Set([
        ...pi.getActiveTools().filter((tool) => memoryEnabled || tool !== "memory"),
        ...savedTools.filter((tool) => memoryEnabled || tool !== "memory"),
        ...enabledContinuityTools(),
      ])]);
      savedTools = undefined;
    } else if (!memoryEnabled) {
      pi.setActiveTools(pi.getActiveTools().filter((tool) => tool !== "memory"));
    }
  };
  const completeWork = async (ctx: any) => {
    if (!work || work.mode === "completed") return false;
    const previous = {
      mode: work.mode,
      currentTodoId: work.currentTodoId,
      completedAt: work.completedAt,
      updatedAt: work.updatedAt,
    };
    work.mode = "completed";
    work.currentTodoId = undefined;
    work.completedAt = new Date().toISOString();
    work.updatedAt = new Date().toISOString();
    try {
      await saveWork();
    } catch (error) {
      Object.assign(work, previous);
      throw error;
    }
    gate(false);
    refresh(ctx);
    return true;
  };
  const readyForAutomaticCompletion = () =>
    !!work &&
    work.mode === "executing" &&
    !awaitingClarificationProse &&
    !hasRemainingTodos(work) &&
    !needsVerification &&
    latestVerification?.state !== "failed";
  const disposeVerify = pi.events.on("pi-verify:result", (event: any) => {
    if (event?.version !== 1 || event.cwd !== currentCwd || event.sessionId !== leasedSessionId) return;
    latestVerification = event;
    let changed = false;
    if (["passed", "clean", "no_checks"].includes(event.state) && work?.issue?.kind === "verification") {
      clearIssue(work);
      changed = true;
    }
    if (event.state === "passed") {
      needsVerification = false;
      const remaining = work?.mode === "executing"
        ? work.todos.filter((todo) => todo.status !== "done")
        : [];
      if (work && remaining.length === 1 && isVerificationOnlyTodo(remaining[0].text)) {
        updateTodo(work, remaining[0].id, "done");
        changed = true;
      }
    }
    if (work && event.state === "failed") {
      setIssue(
        work,
        "verification",
        `Verification failed (${event.results?.find((item: any) => item.code !== 0)?.command ?? "unknown check"}).`,
        "Inspect bounded verification failure; use Scout then Advisor if root cause or approach remains unclear.",
      );
      changed = true;
    }
    if (work && changed) {
      work.updatedAt = new Date().toISOString();
      void saveWork();
    }
  });
  const disposeHeartbeat = pi.events.on("pi-heartbeat:job", (event: any) => {
    if (event?.version !== 1 || event.cwd !== currentCwd
      || event.sessionId !== leasedSessionId
      || !event.todoId || !work) return;
    const todo = work.todos.find((item) => item.id === event.todoId);
    if (!todo) return;
    if (event.state === "running") updateTodo(work, todo.id, "in_progress");
    else if (event.state === "completed") {
      updateTodo(work, todo.id, "done");
      if (work.issue?.kind === "background" && work.issue.id === event.id) clearIssue(work);
    } else if (["failed", "cancelled", "timed_out"].includes(event.state)) {
      updateTodo(work, todo.id, "blocked");
      setIssue(
        work,
        "background",
        `Background job ${event.id} ${event.state}.`,
        "Inspect heartbeat status and retry or revise task.",
        event.id,
      );
    }
    work.updatedAt = new Date().toISOString();
    void saveWork();
  });
  pi.on("session_start", async (_e, ctx) => withMemoryLifecycle(async () => {
    gate(false);
    sessionGeneration++;
    const sessionId = ctx.sessionManager.getSessionId();
    const reuseSessionLease = !!releaseSessionLease && leasedSessionId === sessionId;
    if (releaseSessionLease && !reuseSessionLease) {
      const previousWorkFile = workFile;
      await releaseSessionLease(ephemeralSession && previousWorkFile
        ? () => rm(previousWorkFile, { force: true })
        : undefined);
      releaseSessionLease = undefined;
    }
    currentCwd = ctx.cwd;
    activeSessionContext = ctx;
    memoryEnabled = (await loadConfig()).memoryEnabled !== false;
    memoryInjectionEnabled = memoryEnabled;
    recentCalls.clear();
    pendingMutations.clear();
    deniedToolCalls.clear();
    surfacedMemoryIds.clear();
    pendingPreflightMemoryIds.clear();
    preflightedMemoryActions.clear();
    seenMutationMessages.clear();
    terminatingToolCalls.clear();
    automaticCompaction = undefined;
    latestVerification = ([...(ctx.sessionManager.getEntries?.() ?? [])]
      .reverse()
      .find((entry: any) => entry.type === "custom" && entry.customType === "pi-verify-result" && entry.data?.version === 1 && entry.data.sessionId === sessionId) as any)
      ?.data;
    const reg = await registerWorkspace(root, ctx.cwd);
    workspace = reg.workspace;
    all = reg.all;
    dir = reg.dir;
    workFile = join(
      dir,
      "sessions",
      sessionWorkFile(sessionId),
    );
    if (!reuseSessionLease) {
      releaseSessionLease = await startSessionGc(root, sessionId, (live) =>
        pruneOrphanWorkFiles(root, live));
      leasedSessionId = sessionId;
    }
    ephemeralSession = !ctx.sessionManager.getSessionFile?.();
    const p = paths();
    work = await readJson<Work | undefined>(
      p.work,
      undefined,
      (value) => value === undefined || isWork(value),
    );
    const handoff = [...(ctx.sessionManager.getEntries?.() ?? [])]
      .reverse()
      .find(
        (entry: any) =>
          entry.type === "custom" &&
          entry.customType === HANDOFF_ENTRY_TYPE &&
          isWork(entry.data?.work),
      ) as any;
    if (!work && handoff) {
      work = handoff.data.work;
      const requested = handoff.data.model;
      const model =
        requested &&
        ctx.modelRegistry.find(requested.provider, requested.id);
      if (model && ctx.modelRegistry.hasConfiguredAuth(model))
        await pi.setModel(model);
      if (thinkingLevels.includes(handoff.data.thinking))
        pi.setThinkingLevel(handoff.data.thinking);
      await saveWork();
    }
    if (work && !work.issue && (work.latestFailure || work.nextAction)) {
      work.issue = { kind: "manual" };
      await saveWork();
    }
    if (work?.mode === "executing" && !work.currentTodoId) {
      const first = work.todos.find((todo) => todo.status !== "done");
      if (first) {
        updateTodo(work, first.id, "in_progress");
        await saveWork();
      }
    }
    if (work?.mode === "planning" && work.todos.length) {
      let changed = false;
      if (!work.planSummary?.trim()) {
        work.planSummary = work.todos.map((todo) => todo.text).join("; ") || work.goal;
        changed = true;
      }
      if (!work.planRevision) {
        work.planRevision = 1;
        changed = true;
      }
      if ((work.offeredPlanRevision ?? 0) < work.planRevision)
        pendingApproval = { runId: work.runId, revision: work.planRevision };
      if (changed) await saveWork();
    }
    project = await resolveProject(ctx.cwd);
    memoryState = memoryEnabled ? await withStateLock(memoryDirectory(), async () => {
      const latest = await readMemory();
      let reconciled = discardExpiredReviews(latest);
      reconciled = await reassociateProjectMemory(reconciled);
      if (reconciled !== latest) await writeMemory(reconciled);
      return reconciled;
    }) : emptyMemoryState();
    memoryNotes = memoryState.notes;
    reviewCalledThisTask = false;
    memoryProposalToken = undefined;
    memoryTaskGeneration++;
    const startupIdentity = await worktreeFingerprint(ctx.cwd), startupChanges = await currentChangedPaths(ctx.cwd);
    needsVerification = work?.mode === "executing" && (startupChanges === undefined || startupChanges.size > 0)
      && !(latestVerification?.state === "passed" && latestVerification.sessionId === sessionId && latestVerification.worktreeId === startupIdentity);
    if (memoryEnabled) {
      try {
        const migration = await runV4Migration(ctx, sessionId);
        if (migration.migrated) emitMemoryOutcome("migration_committed");
      } catch (error: any) {
        emitMemoryOutcome("migration_failed");
        const reason = error?.message ?? "automatic migration unavailable";
        await recordPendingV4Migration(root, reason).catch(() => {});
        if (!/Memory Reviewer/.test(reason)) ctx.ui?.notify?.(`Memory V4 migration deferred: ${reason}`, "warning");
      }
      legacyMigrationAvailable = await hasPendingV4Migration(root);
    } else legacyMigrationAvailable = false;
    gate(work?.mode === "planning");
    tasksVisible = true;
    refresh(ctx);
    publishState();
  }));
  pi.on("session_shutdown", async () => withMemoryLifecycle(async () => {
    sessionGeneration++;
    activeSessionContext = undefined;
    automaticCompaction = undefined;
    terminatingToolCalls.clear();
    legacyMigrationAvailable = false;
    pendingApproval = undefined;
    approvalContext = undefined;
    publishState(false);
    disposeStateRequest();
    disposeMemoryMutation();
    disposeInstanceClaim();
    disposeVerify();
    disposeHeartbeat();
    disposeWorktreeChange();
    disposePackageMutation();
    disposeGuardDecision();
    disposeRuntimePolicy?.();
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "unregister",
      owner: "pi-continuity",
    });
    await releaseSessionLease?.(ephemeralSession && workFile
      ? () => rm(workFile, { force: true })
      : undefined);
    releaseSessionLease = undefined;
    leasedSessionId = "";
  }));
  pi.on("agent_start", (_e, ctx) => {
    awaitingClarificationProse = false;
    terminatingToolCalls.clear();
    tasksVisible ? refresh(ctx) : hideTasks(ctx);
  });
  pi.on("agent_end", () => {
    if (!pendingPreflightMemoryIds.size) return;
    pendingPreflightMemoryIds.clear();
    preflightedMemoryActions.clear();
  });
  pi.on("agent_settled", async (_e, ctx) => {
    tasksVisible = false;
    hideTasks(ctx);
    await settleMemoryReviews(ctx);
    schedulePlanApproval(ctx);
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message as any;
    if (
      message.role !== "assistant" ||
      message.stopReason !== "stop" ||
      !readyForAutomaticCompletion() ||
      !Array.isArray(message.content) ||
      message.content.some((part: any) => part?.type === "toolCall") ||
      !message.content.some((part: any) => part?.type === "text" && part.text.trim())
    ) return;
    await completeWork(ctx);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (awaitingClarificationProse && work?.mode === "executing")
      return {
        block: true,
        reason: "Ask the pending clarification in prose and stop. Do not call more tools until the user answers.",
      };
    if (hasUnsafeClarificationBatch(ctx))
      return {
        block: true,
        reason: "Clarification must be the only tool call at a safe checkpoint. Retry it alone.",
      };
    if (blocked(work?.mode === "planning", event.toolName))
      return {
        block: true,
        reason: "Plan mode is read-only. Approve or cancel plan first.",
      };
    const input = (event.input ?? {}) as { action?: string; completion?: boolean };
    if (work?.mode === "planning" && event.toolName === "memory" && input.action !== "list")
      return {
        block: true,
        reason: "Plan mode is read-only. Memory mutations are blocked; use memory list only.",
      };
    if (memoryEnabled && memoryInjectionEnabled) {
      const action = memoryAction(event.toolName, event.input);
      if (action && pendingPreflightMemoryIds.size) {
        deniedToolCalls.add(event.toolCallId);
        return {
          block: true,
          reason: "A sibling consequential action was deferred because Continuity surfaced relevant memory in this tool batch. Reconsider the batch, then retry appropriate actions.",
        };
      }
      if (action && !preflightedMemoryActions.has(action.signature)) {
        const injection = await newlyRelevantMemory([...retrievalQueries("", activeWork()), action.query], false);
        if (injection.text) {
          preflightedMemoryActions.add(action.signature);
          for (const note of injection.notes) pendingPreflightMemoryIds.add(note.id);
          deniedToolCalls.add(event.toolCallId);
          return {
            block: true,
            reason: `Continuity surfaced relevant memory before this action. Reconsider it, then retry if still appropriate.\n${injection.text}`,
          };
        }
      }
    }
    if ((event.toolName === "bash" && !sharedWorktreeObserver) || event.toolName === "grunt")
      pendingMutations.set(event.toolCallId, await worktreeFingerprint(ctx.cwd));
  });
  pi.on("tool_execution_end", (event) => {
    if ((event.result as any)?.terminate === true) terminatingToolCalls.add(event.toolCallId);
    else terminatingToolCalls.delete(event.toolCallId);
  });
  pi.on("tool_result", async (event, ctx) => {
    if (deniedToolCalls.delete(event.toolCallId)) {
      pendingMutations.delete(event.toolCallId);
      return;
    }
    if ((event.toolName === "bash" && !sharedWorktreeObserver) || event.toolName === "grunt") {
      const before = pendingMutations.get(event.toolCallId);
      pendingMutations.delete(event.toolCallId);
      const after = await worktreeFingerprint(ctx.cwd);
      if (!before || !after || before !== after) invalidateVerification();
      return;
    }
    if (["write", "edit", "heartbeat_start"].includes(event.toolName)) invalidateVerification();
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      lastPrompt = event.text;
      memoryTaskGeneration++;
      reviewCalledThisTask = false;
      surfacedMemoryIds.clear();
      pendingPreflightMemoryIds.clear();
      preflightedMemoryActions.clear();
    }
  });
  pi.on("turn_end", (event, ctx) => {
    for (const id of pendingPreflightMemoryIds) surfacedMemoryIds.add(id);
    pendingPreflightMemoryIds.clear();
    const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
    const hasToolCalls = Array.isArray((event.message as any)?.content) &&
      (event.message as any).content.some((part: any) => part?.type === "toolCall");
    if (!toolResults.length || !hasToolCalls) return;
    const allTerminating = toolResults.every((result: any) => terminatingToolCalls.has(result.toolCallId));
    for (const result of toolResults as any[]) terminatingToolCalls.delete(result.toolCallId);
    if (allTerminating || automaticCompaction || ctx.signal?.aborted || ctx.hasPendingMessages()) return;

    const usage = ctx.getContextUsage();
    if (usage?.tokens == null || !Number.isFinite(usage.tokens) || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return;
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted?.() ?? false,
    }).getCompactionSettings();
    if (!settings.enabled || usage.tokens <= usage.contextWindow - settings.reserveTokens) return;

    const request = {
      sessionGeneration,
      taskGeneration: memoryTaskGeneration,
      sessionId: ctx.sessionManager.getSessionId(),
    };
    automaticCompaction = request;
    try {
      ctx.compact({
        onComplete: () => {
          if (automaticCompaction !== request) return;
          automaticCompaction = undefined;
          if (
            sessionGeneration !== request.sessionGeneration ||
            memoryTaskGeneration !== request.taskGeneration ||
            ctx.sessionManager.getSessionId() !== request.sessionId ||
            !ctx.isIdle() ||
            ctx.hasPendingMessages()
          ) return;
          pi.sendMessage({
            customType: "pi-continuity-resume",
            content: "Continue the unfinished task from the compaction checkpoint. Do not repeat completed work or wait for another user prompt.",
            display: false,
            details: { version: 1, reason: "mid-task-compaction" },
          }, { triggerTurn: true });
        },
        onError: () => {
          if (automaticCompaction === request) automaticCompaction = undefined;
        },
      });
    } catch {
      if (automaticCompaction === request) automaticCompaction = undefined;
    }
  });
  const activeWork = () =>
    work && !["handed_off", "completed", "cancelled"].includes(work.mode)
      ? work
      : undefined;
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      // Manual compaction is already waiting for the run to settle. Cancel Pi's
      // duplicate post-run auto-compaction so the manual callback can resume work.
      if (automaticCompaction && event.reason !== "manual") return { cancel: true };
      const active = activeWork();
    if (active) {
      const missingIdentity = !active.runId || !active.timelineId;
      if (!active.runId) active.runId = randomUUID();
      if (!active.timelineId) active.timelineId = active.runId;
      if (missingIdentity) await saveWork();
    }
    const identity = active && latestVerification ? await worktreeFingerprint(currentCwd) : undefined;
    const verification = identity && latestVerification?.worktreeId === identity ? latestVerification : undefined;
    const config = await loadConfig();
    const preparation = {
      ...event.preparation,
      settings: { ...event.preparation.settings, keepRecentTokens: config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS },
    };
    const draft = prepareContinuityCompaction({
      branchEntries: event.branchEntries,
      preparation,
      ...(active ? { work: active, verification } : {}),
    });
    if (!draft) return { cancel: true };

    const focus = event.customInstructions?.trim();
    const profile = config.compactionReviewer;
    if (focus && !profile) throw Error("Compaction review instructions require a configured Compaction Reviewer.");
    let additions: CompactionSupplement[] = [];
    if (profile) {
      try {
        const packet = buildCompactionReviewPacket({
          canonicalSummary: draft.canonical.summary,
          sources: draft.reviewSources,
          ...(focus ? { focus } : {}),
        });
        if (packet) {
          const model = await configuredModel(ctx, profile);
          if (!model) throw Error("configured model or credentials are unavailable");
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (!auth.ok || !auth.apiKey) throw Error("configured model has no credentials");
          const reviewed = await callCompactionReviewer({
            model,
            auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
            profile,
            packet,
            sessionId: leasedSessionId,
            signal: event.signal,
          });
          additions = reviewed.supplements;
          pi.events.emit("pi-continuity:compaction-review-telemetry", {
            version: 1,
            outcome: "reviewed",
            ...reviewed.telemetry,
          });
        } else if (focus) {
          ctx.ui?.notify?.("Compaction used deterministic output; no discarded transcript was available for review.", "warning");
        }
      } catch (error: any) {
        if (event.signal?.aborted) throw error;
        pi.events.emit("pi-continuity:compaction-review-telemetry", {
          version: 1,
          outcome: "failed",
          model: profile.model,
        });
        if (focus) ctx.ui?.notify?.("Compaction reviewer failed; deterministic output was used without review focus.", "warning");
      }
    }
      if (event.signal?.aborted) return { cancel: true };
      return { compaction: finalizeContinuityCompaction(draft.canonical, [...draft.priorSupplements, ...additions]) };
    } catch {
      if (!event.signal?.aborted)
        ctx.ui?.notify?.("Compaction cancelled because Continuity could not produce deterministic output.", "error");
      return { cancel: true };
    }
  });
  pi.on("before_agent_start", async (event) => {
    memoryContextToken = undefined;
    if (!memoryEnabled || !memoryInjectionEnabled) return;
    const injection = await newlyRelevantMemory(retrievalQueries(event.prompt, activeWork()));
    if (injection.text) {
      memoryContextToken = randomUUID();
      return {
        message: {
          customType: "pi-continuity-memory",
          content: injection.text,
          display: false,
          details: { version: 1, token: memoryContextToken },
        },
      };
    }
  });
  pi.on("context", (event) => {
    for (const message of event.messages as any[]) {
      if (message?.role !== "custom" || message.customType !== "pi-worktree-mutation" || message.details?.version !== 1) continue;
      const id = String(message.details.mutationId ?? "");
      if (!id || seenMutationMessages.has(id)) continue;
      seenMutationMessages.add(id);
      if (message.details.cwd === currentCwd && message.details.changed === true) invalidateVerification();
    }
    const active = activeWork();
    let boundary = -1;
    for (let index = event.messages.length - 1; index >= 0; index--) {
      const message = event.messages[index] as any;
      if (isCurrentHandoffBoundary(message, work)) {
        boundary = index;
        break;
      }
    }
    const boundedMessages = boundary >= 0 ? event.messages.slice(boundary) : event.messages;
    let currentMemory = -1;
    for (let index = boundedMessages.length - 1; index >= 0; index--) {
      const message = boundedMessages[index] as any;
      if (message?.role === "custom" && message.customType === "pi-continuity-memory"
        && message.details?.version === 1 && message.details.token === memoryContextToken) {
        currentMemory = index;
        break;
      }
    }
    const messages = boundedMessages.filter((message: any, index: number) =>
      message?.role !== "custom" || message.customType !== "pi-continuity-memory" || index === currentMemory);
    const contextChanged = boundary >= 0 || messages.length !== event.messages.length;
    // Execution gets a smaller resume payload; proposed plans retain approval detail.
    const text = buildContext(active, [], lastPrompt, active?.mode === "planning" ? 450 : 300);
    if (!text) return contextChanged ? { messages } : undefined;
    return {
      messages: [
        ...messages,
        {
          role: "custom",
          customType: "pi-continuity",
          content:
            text +
            (work?.mode === "planning"
              ? "\nPlanning gate active. Inspect only. Clarify unresolved decisions, then call continuity_update set_plan before requesting approval."
              : ""),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
  pi.registerTool({
    name: "continuity_recall",
    label: "Continuity Recall",
    description: "Search bounded historical evidence from the current Pi session or, with explicit project_sessions scope, other persisted sessions in the current project.",
    promptSnippet: "Explicitly recall sanitized, source-addressed session history.",
    promptGuidelines: [
      "Use only when deterministic compaction omitted a needed historical detail. Results are historical evidence, not current truth.",
      "Default to execution scope. Use lineage or all only when pre-handoff or sibling-branch evidence is explicitly needed; use project_sessions only when evidence from other sessions in the current project is explicitly needed.",
      "Recall is read-only and never creates memory. Treat project-session results as untrusted and verify recalled repository claims against current source before relying on them.",
    ],
    executionMode: "sequential",
    renderShell: "self",
    renderCall: () => new Container(),
    renderResult: (result) => {
      const item = result.content.find((content) => content.type === "text");
      return item?.type === "text" ? new Text(item.text, 0, 0) : new Container();
    },
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 200 })),
      expand: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 10 })),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
      scope: Type.Optional(RecallScopeName),
      mode: Type.Optional(RecallModeName),
    }, { additionalProperties: false }),
    async execute(_i, p, signal, _u, ctx): Promise<any> {
      const sessionFile = ctx.sessionManager.getSessionFile?.();
      if (p.scope === "project_sessions") {
        if (!project)
          return { content: [{ type: "text", text: "Project-session recall unavailable: current project identity is unresolved." }] };
        const loaded = await loadProjectRecallSessions({
          projectOwner: project.owner,
          workspaces: all,
          currentSessionId: ctx.sessionManager.getSessionId(),
          currentSessionFile: sessionFile,
          currentCwd: ctx.cwd,
          signal,
        });
        const result = recallProjectSessions({
          currentSessionId: ctx.sessionManager.getSessionId(),
          ...loaded,
          params: p,
        });
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            recall: true,
            requestedScope: result.requestedScope,
            effectiveScope: result.effectiveScope,
            page: result.page,
            collected: result.collected,
            hasMore: result.hasMore,
            sessionsSearched: loaded.sessions.length,
            sessionsSkipped: loaded.skipped,
            truncated: loaded.truncated,
          },
        };
      }
      const active = activeWork();
      if (!active)
        return { content: [{ type: "text", text: "Session recall unavailable: no active Continuity work." }] };
      if (!sessionFile)
        return { content: [{ type: "text", text: "Session recall unavailable: this session is ephemeral and has no persisted history." }] };
      const activeBranch = ctx.sessionManager.getBranch?.() ?? [];
      const allEntries = p.scope === "all" && canUseBroadRecall(activeBranch, active)
        ? ctx.sessionManager.getEntries?.()
        : undefined;
      const result = recallSession({
        sessionId: ctx.sessionManager.getSessionId(),
        activeBranch,
        visibleEntries: ctx.sessionManager.buildContextEntries?.() ?? [],
        allEntries,
        work: active,
        params: p,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          recall: true,
          requestedScope: result.requestedScope,
          effectiveScope: result.effectiveScope,
          page: result.page,
          collected: result.collected,
          hasMore: result.hasMore,
        },
      };
    },
  });
  const EvidenceRangeSchema = Type.Object({ path: Type.String({ minLength: 1, maxLength: 240 }), start: Type.Integer({ minimum: 1 }), end: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
  const BasisSchema = Type.Union([
    Type.Object({ type: Type.Literal("user_instruction"), quote: Type.String({ minLength: 1, maxLength: 2_000 }) }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal("project_contract"), evidence: Type.Array(EvidenceRangeSchema, { minItems: 1, maxItems: 3 }) }, { additionalProperties: false }),
  ]);
  const ProposalSchema = Type.Union([
    Type.Object({ operation: Type.Literal("add"), scope: ScopeName, trigger: Type.String({ minLength: 1, maxLength: 240 }), guidance: Type.String({ minLength: 1, maxLength: 800 }), basis: BasisSchema }, { additionalProperties: false }),
    Type.Object({ operation: Type.Literal("replace"), scope: ScopeName, targetId: Type.String({ minLength: 36, maxLength: 36 }), expectedRevision: Type.Integer({ minimum: 1 }), trigger: Type.String({ minLength: 1, maxLength: 240 }), guidance: Type.String({ minLength: 1, maxLength: 800 }), basis: BasisSchema }, { additionalProperties: false }),
    Type.Object({ operation: Type.Literal("remove"), scope: ScopeName, targetId: Type.String({ minLength: 36, maxLength: 36 }), expectedRevision: Type.Integer({ minimum: 1 }), reason: Type.String({ minLength: 1, maxLength: 500 }), basis: BasisSchema }, { additionalProperties: false }),
  ]);
  pi.registerTool({
    name: "memory", label: "Memory",
    description: "List or query durable notebook notes, or submit up to two grounded proposals for immediate Memory Reviewer editing.",
    promptSnippet: "Inspect durable notes or propose bounded reviewer-gated changes.", executionMode: "sequential", renderShell: "self", renderCall: () => new Container(),
    promptGuidelines: [
      "Propose clear, potentially reusable, explicitly stated user preferences or instructions, and intentional project conventions or contracts, when they could plausibly guide a future session. Do not require certainty of admission: the Memory Reviewer may accept, rewrite, merge, or reject. Never propose progress, implementation summaries, guesses, generic advice, one-off details, duplicates, or secrets.",
      "Use memory list first when duplication is uncertain. Submit at most two proposals in one call. User scope requires an exact quote from the current active branch; project contracts require at most three exact repository ranges totaling at most 120 lines.",
    ],
    renderResult: (result, _options, theme) => {
      const item = result.content.find((content) => content.type === "text"), value = item?.type === "text" ? item.text : "";
      return new Text((result.details as any)?.memoryError ? theme.fg("warning", `⚠ ${value}`) : value, 0, 0);
    },
    parameters: Type.Object({ action: MemAction, query: Type.Optional(Type.String({ maxLength: 500 })), proposals: Type.Optional(Type.Array(ProposalSchema, { minItems: 1, maxItems: 2 })) }, { additionalProperties: false }),
    async execute(id, p, signal, _onUpdate, ctx): Promise<any> {
      const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], details: { memoryError: true } });
      if (!memoryEnabled) return failure("Continuity memory is disabled in package settings.");
      if (p.action === "list") {
        const resolved = await resolveProject(ctx.cwd);
        memoryState = await readMemory(); memoryNotes = memoryState.notes;
        const owned = notesForOwners(memoryNotes, resolved.owner), shown = p.query?.trim() ? shortlistNotes(owned, p.query, undefined, 100) : owned;
        const pending = memoryState.reviews.filter((review) => review.sessionId === leasedSessionId && review.status === "approved_pending");
        const text = !shown.length && !pending.length ? "No current-owner notebook notes or pending reviewed operations." : [
          ...shown.map((note) => `- ${note.scope}/${note.id} r${note.revision} [${note.authority}/${note.origin}] When ${note.trigger}: ${note.guidance}`),
          ...pending.map((review) => `- pending review ${review.reviewId}: ${review.operations.length} approved operation(s)`),
        ].join("\n");
        return { content: [{ type: "text", text }], details: { memoryList: true } };
      }
      if (reviewCalledThisTask || memoryProposalToken) return failure("Only one memory proposal call is allowed per task.");
      const reservationToken = randomUUID(); memoryProposalToken = reservationToken;
      const proposalTask = memoryTaskGeneration, proposalGeneration = sessionGeneration, proposalSession = leasedSessionId, proposalCwd = ctx.cwd;
      let reviewerInvoked = false;
      try {
        const resolved = await resolveProject(proposalCwd), config = await loadConfig(), profile = config.memoryReviewer;
        if (!profile) return failure("Memory Reviewer unavailable: configure a dedicated reviewer model.");
        const model = await configuredModel(ctx, profile);
        if (!model) return failure("Memory Reviewer unavailable: configured model or credentials are unavailable.");
        const state = await readMemory();
        const preflight = await preflightMemoryProposals({ rawProposals: p.proposals, state, cwd: proposalCwd, activeBranch: ctx.sessionManager.getBranch?.() ?? [], sessionId: proposalSession, projectOwner: resolved.owner });
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) return failure("Memory Reviewer unavailable: configured model has no credentials.");
        reviewerInvoked = true; reviewCalledThisTask = true;
        const needsWorktreeIdentity = preflight.proposals.some((proposal) => Boolean(proposal.evidence));
        const fingerprint = needsWorktreeIdentity ? await worktreeFingerprint(proposalCwd) : undefined;
        if (needsWorktreeIdentity && !fingerprint) throw Error("Memory review unavailable: worktree identity cannot be proven.");
        const reviewed = await callMemoryReviewer({ model, auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env }, profile, packet: preflight.packet, sessionId: proposalSession, signal });
        const record = reviewedRecord({ decisions: reviewed.decisions, preflight: preflight.proposals, packet: preflight.packet, sessionId: proposalSession, toolCallId: id, generation: proposalGeneration, taskGeneration: proposalTask, worktreeIdentity: fingerprint });
        for (const prepared of preflight.proposals) if (prepared.evidence) {
          const freshEvidence = await captureEvidenceRanges(proposalCwd, prepared.proposal.basis.type === "project_contract" ? prepared.proposal.basis.evidence : []);
          if (freshEvidence.some((item, index) => item.excerptSha256 !== prepared.evidence![index]?.excerptSha256)) throw Error("memory evidence changed during review");
        }
        await withMemoryLifecycle(() => withStateLock(memoryDirectory(), async () => {
          if (proposalGeneration !== sessionGeneration || proposalTask !== memoryTaskGeneration || proposalSession !== leasedSessionId || proposalCwd !== currentCwd || project?.owner !== resolved.owner) throw Error("memory review became stale after a task or session change");
          if (record.requiresVerification && fingerprint && await worktreeFingerprint(proposalCwd) !== fingerprint) throw Error("worktree changed during memory review");
          const latest = await readMemory();
          for (const operation of record.operations) {
            if (operation.operation === "add") {
              if (strongDuplicate(latest.notes, operation.scope, operation.owner, operation.trigger, operation.guidance)) throw Error("memory review became a duplicate");
            } else {
              const target = latest.notes.find((note) => note.id === operation.targetId);
              if (!target || target.revision !== operation.expectedRevision) throw Error("memory review became stale");
            }
          }
          const next = stageReview(latest, record);
          if (proposalGeneration !== sessionGeneration || proposalTask !== memoryTaskGeneration || proposalSession !== leasedSessionId || proposalCwd !== currentCwd || project?.owner !== resolved.owner) throw Error("memory review became stale before staging");
          await writeMemory(next); memoryState = next; memoryNotes = next.notes;
        }));
        emitMemoryOutcome("staged");
        pi.events.emit("pi-continuity:memory-review-telemetry", { version: 1, ...reviewed.telemetry, proposalCount: preflight.proposals.length, verdicts: reviewed.decisions.map((decision) => decision.verdict) });
        const lines = reviewed.decisions.map((decision, index) => decision.verdict === "reject" ? `- rejected [${decision.reasonCode}]: proposal ${index + 1}` : `- ${decision.verdict === "accept" ? "accepted" : decision.verdict} and staged: proposal ${index + 1}`);
        return { content: [{ type: "text", text: `Memory review:\n${lines.join("\n")}` }], details: { memoryReview: true, reviewId: record.reviewId } };
      } catch (error: any) { emitMemoryOutcome(reviewerInvoked ? "reviewer_failed" : "preflight_rejected"); return failure(error?.message ?? "Memory review failed; nothing was staged."); }
      finally { if (memoryProposalToken === reservationToken) memoryProposalToken = undefined; if (!reviewerInvoked && memoryTaskGeneration === proposalTask) reviewCalledThisTask = false; }
    },
  });
  pi.registerTool({
    name: "continuity_update",
    label: "Continuity Update",
    description: "Update plan, todos, state, or clarification.",
    promptSnippet: "Planning, todo/state tracking, and clarification capability.",
    executionMode: "sequential",
    promptGuidelines: [
      "Use set_plan for explicit /plan, handoffs, or blockers; skip it for straightforward read-only work and one-shot local fixes. Prefer 2–4 outcome-level todos. Explicit planSummary is the compact executor handoff: approach, concrete paths/symbols, assumptions or gaps, acceptance criteria. Continuity owns plan presentation; internal task list otherwise.",
      "Clarify only a blocking user decision, recommended option first, as the sole tool call at a safe checkpoint; never re-ask an answered question without new evidence. Use exact IDs atomically.",
      "Keep verification out of new todo lists; a sole verification-only todo completes automatically. Keep every Continuity update tool-only and before final text.",
      "Never call a completion tool. Write exactly one text-only final response. For clean/no_checks, acknowledge allowUnverified tool-only; disclose the limitation.",
      "After failed, stale, cancelled, or error Verify results, write one caveated text-only final response and stop without another tool call.",
    ],
    renderShell: "self",
    renderCall: () => new Container(),
    renderResult: (result, _options, theme) => {
      const item = result.content.find((content) => content.type === "text");
      const text = item?.type === "text" ? item.text : undefined;
      const details = result.details as any;
      const clarification = details?.clarification;
      const plan = details?.plan;
      if (clarification)
        return new Text(
          `${theme.fg("muted", `? ${clarification.question}`)}\n${theme.fg("accent", clarification.answer)}`,
          0,
          0,
        );
      if (plan) return new Text(plan, 0, 0);
      if (text?.startsWith("Continuity circuit breaker"))
        return new Text(theme.fg("warning", "⚠ Continuity loop stopped"), 0, 0);
      if (text && /^(?:Cannot |Verification is unavailable|allowUnverified requires)/.test(text))
        return new Text(theme.fg("warning", `⚠ ${text}`), 0, 0);
      return text?.startsWith("Work completed") || text?.startsWith("Work already completed")
        ? new Text(theme.fg("success", "✓ Task completed"), 0, 0)
        : new Container();
    },
    parameters: Type.Object(
      {
        action: Action,
        question: Type.Optional(Type.String({
          maxLength: 500,
          description: "One concrete decision in plain language. Include one short sentence of decision-relevant context only when needed.",
        })),
        options: Type.Optional(
          Type.Array(
            Type.Object({
              label: Type.String({
                maxLength: 120,
                description: "Short, distinct answer label. Put the recommended option first.",
              }),
              description: Type.Optional(Type.String({
                maxLength: 240,
                description: "Practical outcome or tradeoff; for the recommended option, include why it is recommended.",
              })),
            }),
          ),
        ),
        questions: Type.Optional(Type.Array(Type.Object({
          question: Type.String({ maxLength: 500 }),
          options: Type.Array(Type.Object({
            label: Type.String({ maxLength: 120 }),
            description: Type.Optional(Type.String({ maxLength: 240 })),
          }), { minItems: 2, maxItems: 4 }),
        }), { minItems: 2, maxItems: 6 })),
        goal: Type.Optional(Type.String({ maxLength: 2000 })),
        constraints: Type.Optional(
          Type.Array(Type.String({ maxLength: 500 }), { maxItems: 12 }),
        ),
        planSummary: Type.Optional(Type.String({ maxLength: 4000 })),
        todos: Type.Optional(
          Type.Array(Type.String({ maxLength: 120 }), { maxItems: 12 }),
        ),
        todoId: Type.Optional(
          Type.String({
            description:
              "Exact todo ID shown in Continuity context, such as todo_1",
          }),
        ),
        todoIds: Type.Optional(
          Type.Array(Type.String(), {
            minItems: 1,
            maxItems: 12,
            description: "Complete these independent todo IDs together. Bulk updates only support status done.",
          }),
        ),
        nextTodoId: Type.Optional(
          Type.String({
            description:
              "Pending todo to start atomically when marking current todo done",
          }),
        ),
        status: Type.Optional(Status),
        currentTodoId: Type.Optional(Type.String()),
        latestFailure: Type.Optional(Type.String({ maxLength: 1000 })),
        nextAction: Type.Optional(Type.String({ maxLength: 1000 })),
        allowUnverified: Type.Optional(Type.Boolean({ description: "Acknowledge clean or no_checks in a tool-only state update; disclose the limitation in the final response." })),
      },
      { additionalProperties: false },
    ),
    async execute(_i, input, _s, _u, ctx): Promise<any> {
      // Keep direct legacy callers working without advertising explicit completion to models.
      const p = input as typeof input & { completion?: boolean };
      const legacyCompletionWithReply = p.completion === true &&
        hasReplyBeforeCompletion({ toolCallId: _i }, ctx);
      if (p.allowUnverified && p.action !== "state")
        return {
          content: [{ type: "text", text: "allowUnverified requires action \"state\"." }],
        };
      if (p.action === "state") {
        const todoFields = (["todoId", "todoIds", "status", "nextTodoId"] as const)
          .filter((field) => p[field] !== undefined);
        if (todoFields.length)
          return {
            content: [{
              type: "text",
              text: `${todoFields.join(", ")} require action \"todo\"; complete todos before updating state.`,
            }],
          };
      }
      if (tripsCircuitBreaker(p)) {
        ctx.abort();
        return {
          content: [{ type: "text", text: "Continuity circuit breaker stopped 3 identical calls within 30 seconds." }],
          details: { circuitBreaker: true },
          terminate: true,
        };
      }
      if (p.action === "clarify") {
        const executing = work?.mode === "executing";
        if (p.questions !== undefined && (p.question !== undefined || p.options !== undefined))
          throw Error("Use either questions or question/options, not both.");
        const questions = p.questions ?? [{ question: p.question || "", options: p.options || [] }];
        validateQuestions(questions);
        if (process.env.PI_SPAWN_AUTONOMOUS === "1" && (process.env.PI_SPAWN_CHILD === "agent" || process.env.PI_SPAWN_CHILD === "session")) {
          return {
            content: [{
              type: "text",
              text: "No interactive answer is available in this autonomous spawned thread. Reassess every question and all listed options using the available context, choose any justified option, state the assumptions you made, and continue the task.",
            }],
            details: { autonomousClarification: true },
          };
        }
        if (!ctx.hasUI) {
          if (executing) awaitingClarificationProse = true;
          const prose = questions.map((item, questionIndex) => {
            const options = item.options.map((option, optionIndex) =>
              `${optionIndex + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
            );
            return questions.length === 1
              ? `${item.question}\n${options.join("\n")}`
              : `Question ${questionIndex + 1}: ${item.question}\n${options.join("\n")}`;
          }).join("\n\n");
          return {
            content: [{ type: "text", text: `Ask user in prose and wait: ${prose}` }],
          };
        }
        const answers = await askQuestionnaire(
          ctx.ui,
          ctx.mode,
          questions,
          clarifyDialogOptions(),
        );
        if (!answers) {
          if (executing) {
            ctx.abort();
            return {
              content: [{ type: "text", text: "No answers submitted. Execution stopped." }],
              terminate: true,
            };
          }
          return { content: [{ type: "text", text: "No answers submitted." }] };
        }
        if (questions.length === 1) {
          const [answer] = answers;
          return {
            content: [{ type: "text", text: answer.answer }],
            details: { clarification: answer },
          };
        }
        return {
          content: [{
            type: "text",
            text: answers.map((answer, index) =>
              `${index + 1}. ${answer.question}\nAnswer: ${answer.answer}`).join("\n"),
          }],
          details: { clarifications: answers },
        };
      }
      if (p.action === "set_plan") {
        const planning = work?.mode === "planning";
        const todos = (p.todos || []).map((todo) => todo.trim()).filter(Boolean);
        if (!todos.length)
          return {
            content: [
              {
                type: "text",
                text: "At least one non-empty todo is required.",
              },
            ],
          };
        if (!work || work.mode === "completed" || work.mode === "cancelled") {
          work = fresh(p.goal?.trim() || lastPrompt);
          work.mode = "executing";
          work.approved = true;
        }
        const now = new Date().toISOString();
        work.goal = p.goal?.trim() || work.goal;
        work.constraints = (p.constraints || [])
          .map((constraint) => constraint.trim())
          .filter(Boolean)
          .slice(0, 12);
        work.planSummary = p.planSummary?.trim() || todos.join("; ") || work.goal;
        setPlan(work, todos, now);
        if (!planning && !work.currentTodoId) {
          const first = work.todos.find((todo) => todo.status !== "done");
          if (first) updateTodo(work, first.id, "in_progress", now);
        }
        if (planning) work.planRevision = (work.planRevision ?? 0) + 1;
        work.updatedAt = now;
        await saveWork();
        if (planning)
          pendingApproval = { runId: work.runId, revision: work.planRevision! };
        tasksVisible = true;
        refresh(ctx);
        const memory = memoryEnabled && memoryInjectionEnabled
          ? await newlyRelevantMemory(retrievalQueries("", work))
          : { text: "" };
        return {
          content: [
            {
              type: "text",
              text: (planning
                ? "Plan stored. Await explicit /plan approve."
                : "Executing task list stored.") + (memory.text ? `\n\nRelevant memory for the stored plan:\n${memory.text}` : ""),
            },
          ],
          ...(planning ? { details: { plan: formatPlan(work) } } : {}),
        };
      }
      if (!work)
        return { content: [{ type: "text", text: "No active work." }] };
      if (p.action === "todo") {
        const bulkIds = p.todoIds;
        const validIds = work.todos.map((todo) => todo.id).join(", ") || "none";
        // Validate every participant before changing work so rejected bulk calls are atomic.
        if (bulkIds) {
          const ids = new Set(bulkIds);
          const completed = bulkIds.map((id) => work!.todos.find((item) => item.id === id));
          const next = p.nextTodoId && work.todos.find((item) => item.id === p.nextTodoId);
          if (
            p.todoId !== undefined ||
            p.status !== "done" ||
            !bulkIds.length ||
            ids.size !== bulkIds.length ||
            completed.some((todo) => !todo) ||
            (p.nextTodoId !== undefined && (
              !next || ids.has(p.nextTodoId) || next.status !== "pending"
            ))
          ) return {
            content: [{
              type: "text",
              text: `Unknown or invalid todo transition. Valid IDs: ${validIds}.`,
            }],
          };
          const now = new Date().toISOString();
          for (const id of bulkIds) updateTodo(work, id, "done", now);
          if (next) updateTodo(work, next.id, "in_progress", now);
        } else {
          const todo = p.todoId && work.todos.find((item) => item.id === p.todoId),
            next = p.nextTodoId && work.todos.find((item) => item.id === p.nextTodoId);
          if (!todo || !p.status || (p.nextTodoId && (
            p.status !== "done" ||
            !next ||
            next.id === todo.id ||
            next.status !== "pending"
          ))) return {
            content: [{
              text: `Unknown or invalid todo transition. Valid IDs: ${validIds}.`,
              type: "text",
            }],
          };
          const now = new Date().toISOString();
          updateTodo(work, todo.id, p.status, now);
          if (next) updateTodo(work, next.id, "in_progress", now);
        }
        applyManualIssueUpdate(work, p.latestFailure, p.nextAction);
      } else if (p.action === "state") {
        work.currentTodoId = p.currentTodoId ?? work.currentTodoId;
        applyManualIssueUpdate(work, p.latestFailure, p.nextAction);
        if (p.completion) {
          if (work.mode === "completed")
            return {
              content: [
                { type: "text", text: "Work already completed. No further continuity updates needed." },
              ],
              terminate: true,
            };
          if (hasRemainingTodos(work))
            return {
              content: [
                { type: "text", text: "Cannot complete while todos remain." },
              ],
              ...(legacyCompletionWithReply ? { terminate: true } : {}),
            };
          if (needsVerification && latestVerification?.state !== "passed") {
            const explicitlyAllowed = p.allowUnverified && ["clean", "no_checks"].includes(latestVerification?.state);
            if (!explicitlyAllowed)
              return {
                content: [
                  {
                    type: "text",
                    text: ["clean", "no_checks"].includes(latestVerification?.state)
                      ? "Verification is unavailable for this worktree. Acknowledge allowUnverified in a tool-only state update after reviewing that limitation."
                      : "Cannot complete until current-session verification passes.",
                  },
                ],
                ...(legacyCompletionWithReply ? { terminate: true } : {}),
              };
          }
          await completeWork(ctx);
          return {
            content: [
              { type: "text", text: "Work completed. No further continuity updates needed." },
            ],
            terminate: true,
          };
        }
        if (p.allowUnverified) {
          if (hasRemainingTodos(work))
            return {
              content: [{ type: "text", text: "Cannot acknowledge verification while todos remain." }],
            };
          if (!needsVerification)
            return {
              content: [{ type: "text", text: "No verification acknowledgement is required." }],
            };
          if (!["clean", "no_checks"].includes(latestVerification?.state))
            return {
              content: [{ type: "text", text: "allowUnverified requires a current clean or no_checks Verify result." }],
            };
          needsVerification = false;
        }
      }
      work.updatedAt = new Date().toISOString();
      await saveWork();
      refresh(ctx);
      return { content: [{ type: "text", text: "Continuity state updated." }] };
    },
  });
  const approvePlan = async (ctx: any, resetContext: boolean) => {
    if (!work?.planSummary) {
      ctx.ui.notify("No stored plan.", "error");
      return false;
    }
    const config = await loadConfig();
    const executor = await configuredModel(ctx, config.executor, work.baseModel);
    if (!executor || !(await pi.setModel(executor))) {
      ctx.ui.notify("Executor model unavailable.", "error");
      return false;
    }
    const previousWork = work;
    const previousPendingApproval = pendingApproval;
    const now = new Date().toISOString();
    const runId = work.runId ?? randomUUID();
    const timelineId = work.timelineId ?? runId;
    const thinking = config.executor?.thinking ?? work.baseThinking;
    if (thinking) pi.setThinkingLevel(thinking as ThinkingLevel);
    work = {
      ...work,
      mode: "executing",
      approved: true,
      runId,
      timelineId,
      updatedAt: now,
    };
    let gateReleased = false;
    try {
      await saveWork();
      pi.appendEntry(RUN_ENTRY_TYPE, {
        version: 1,
        runId,
        timelineId,
        role: "executor",
        parentSessionId: ctx.sessionManager.getSessionId(),
        createdAt: now,
      } satisfies RunEntry);
      if (resetContext)
        pi.sendMessage({
          customType: HANDOFF_ENTRY_TYPE,
          content: [
            "Continuity execution boundary. Earlier messages remain visible but are excluded from model context.",
            buildContext({ ...work, mode: "planning" }, [], "", 600),
          ].filter(Boolean).join("\n"),
          display: false,
          details: {
            version: 1,
            runId,
            timelineId,
            model: { provider: executor.provider, id: executor.id },
            ...(thinking ? { thinking } : {}),
          },
        }, { triggerTurn: false });
      gate(false);
      gateReleased = true;
      tasksVisible = true;
      refresh(ctx);
      pi.sendUserMessage(resetContext
        ? "Inspect the current workspace and validate the approved plan's assumptions before editing. Treat paths, symbols, and line ranges in the approved plan as the working set: check them with narrow reads, and call Scout only when repository state changed, anchors are missing, or an unresolved gap requires broader tracing. Execute the plan, track todos, and run fresh verification."
        : "Execute approved stored plan in current session. Track and verify todos.");
      pendingApproval = undefined;
      return true;
    } catch (error) {
      work = previousWork;
      pendingApproval = previousPendingApproval;
      if (gateReleased) gate(true);
      await saveWork().catch(() => {});
      refresh(ctx);
      throw error;
    }
  };
  const planCommand = {
    description: "Start, approve, cancel, or inspect plan",
    handler: async (args: string, ctx: any) => {
      const value = args.trim();
      if (value === "review") {
        if (!work?.runId)
          return void ctx.ui.notify("No active pylon run.", "error");
        pi.appendEntry(RUN_ENTRY_TYPE, {
          version: 1,
          runId: work.runId,
          timelineId: work.timelineId ?? work.runId,
          role: "reviewer",
          parentSessionId: ctx.sessionManager.getSessionId(),
          createdAt: new Date().toISOString(),
        } satisfies RunEntry);
        pi.sendUserMessage(
          "Review completed implementation. Inspect Verify result, Scout evidence, changed files, and Timeline checkpoints. Use Advisor only for consequential unresolved findings.",
        );
        return;
      }
      if (value === "approve-current") {
        await approvePlan(ctx, false);
        return;
      }
      if (value === "approve") {
        await approvePlan(ctx, true);
        return;
      }
      if (value === "cancel") {
        pendingApproval = undefined;
        if (work) {
          work.mode = "cancelled";
          await saveWork();
        }
        gate(false);
        refresh(ctx);
        return;
      }
      if (value.startsWith("deny")) {
        const feedback = value.slice("deny".length).trim();
        if (!feedback)
          return void ctx.ui.notify("Plan feedback required.", "error");
        pi.sendUserMessage(`Plan changes requested:\n${feedback}`);
        return;
      }
      if (value === "status") {
        ctx.ui.notify(
          work ? `${work.mode}: ${work.goal}` : "No active work.",
          "info",
        );
        return;
      }
      if (ctx.isIdle?.() === false) {
        ctx.ui.notify("Wait for the current response before starting a plan.", "warning");
        return;
      }
      approvalContext = ctx;
      const config = await loadConfig();
      const baseModel = ctx.model && {
        provider: ctx.model.provider,
        id: ctx.model.id,
      };
      const baseThinking = pi.getThinkingLevel();
      if (!(await applyProfile(ctx, config.planner))) {
        ctx.ui.notify("Planner model unavailable.", "error");
        return;
      }
      const previousRun = findRunEntry(ctx.sessionManager.getEntries?.() ?? []);
      work = fresh(value);
      work.runId = randomUUID();
      work.timelineId = previousRun ? runTimelineId(previousRun) : work.runId;
      work.baseModel = baseModel;
      work.baseThinking = baseThinking;
      const run: RunEntry = {
        version: 1,
        runId: work.runId,
        timelineId: work.timelineId,
        role: "planner",
        createdAt: new Date().toISOString(),
      };
      pi.appendEntry(RUN_ENTRY_TYPE, run);
      savedTools = pi.getActiveTools();
      gate(true);
      await saveWork();
      refresh(ctx);
      if (value)
        pi.sendUserMessage(
          `Plan this task without modifying project files. Use continuity_update set_plan; make planSummary a compact executor handoff with the approach, concrete paths/symbols, assumptions or unresolved gaps, and acceptance criteria. Keep todos outcome-level: ${value}`,
        );
    },
  };
  schedulePlanApproval = (settledCtx: any) => {
    const token = pendingApproval;
    const actionCtx = approvalContext;
    const generation = sessionGeneration;
    if (
      !token ||
      !actionCtx ||
      settledCtx.mode !== "tui" ||
      approvalSelectionOpen ||
      work?.mode !== "planning" ||
      work.runId !== token.runId ||
      work.planRevision !== token.revision ||
      !work.planSummary ||
      !work.todos.length
    ) return;
    pendingApproval = undefined;
    approvalSelectionOpen = true;
    queueMicrotask(async () => {
      const previousOfferedRevision = work?.offeredPlanRevision;
      const requeue = async () => {
        if (
          sessionGeneration !== generation ||
          work?.mode !== "planning" ||
          work.runId !== token.runId ||
          work.planRevision !== token.revision
        ) return;
        work.offeredPlanRevision = previousOfferedRevision;
        pendingApproval = token;
        await saveWork();
      };
      try {
        if (
          sessionGeneration !== generation ||
          work?.mode !== "planning" ||
          work.runId !== token.runId ||
          work.planRevision !== token.revision
        ) return;
        work.offeredPlanRevision = token.revision;
        await saveWork();
        const choice = await settledCtx.ui.select("Plan ready — review structured plan above", [
          "Approve — reset context",
          "Approve — continue current session",
          "Request changes",
        ]);
        if (sessionGeneration !== generation) return;
        if (!choice) {
          await requeue();
          return;
        }
        if (choice === "Approve — reset context") {
          if (await approvePlan(actionCtx, true) === false) await requeue();
        } else if (choice === "Approve — continue current session") {
          if (await approvePlan(actionCtx, false) === false) await requeue();
        } else if (choice === "Request changes") {
          const feedback = await settledCtx.ui.editor("Plan feedback", "");
          if (!feedback?.trim()) {
            await requeue();
            return;
          }
          if (sessionGeneration === generation)
            pi.sendUserMessage(`Plan changes requested:\n${feedback.trim()}`);
        }
      } catch (error: any) {
        await requeue().catch(() => {});
        settledCtx.ui.notify(error?.message ?? String(error), "error");
      } finally {
        approvalSelectionOpen = false;
      }
    });
  };
  pi.registerCommand("plan", planCommand);
  pi.registerCommand("continuity", {
    description: "Configure Continuity models or show status",
    handler: async (args, ctx) => {
      const [roleRaw, ...rest] = args.trim().split(/\s+/);
      const role = roleRaw as "planner" | "executor" | "memoryReviewer" | "compactionReviewer";
      const value = rest.join(" ");
      const config = await loadConfig();
      if (!roleRaw || roleRaw === "status") {
        ctx.ui.notify(
          `Planner: ${config.planner?.model ?? "current session model"} · thinking: ${config.planner?.thinking ?? "current session level"}\nExecutor: ${config.executor?.model ?? "current session model"} · thinking: ${config.executor?.thinking ?? "current session level"}\nMemory Reviewer: ${config.memoryReviewer?.model ?? "not configured"} · thinking: ${config.memoryReviewer?.thinking ?? "default"}\nCompaction Reviewer: ${config.compactionReviewer?.model ?? "not configured"} · thinking: ${config.compactionReviewer?.thinking ?? "default"}`,
          "info",
        );
        return;
      }
      if (!(["planner", "executor", "memoryReviewer", "compactionReviewer"] as string[]).includes(role)) {
        ctx.ui.notify(
          "Usage: /continuity [status|planner|executor|memoryReviewer|compactionReviewer] [provider/model[:thinking]|reset]",
          "info",
        );
        return;
      }
      if (value === "reset") {
        await updateConfig((current) => { const next = { ...current }; delete next[role]; return next; });
        ctx.ui.notify(
          role === "memoryReviewer"
            ? "Memory Reviewer reset; memory proposals are unavailable."
            : role === "compactionReviewer"
              ? "Compaction Reviewer reset; compaction remains deterministic without supplemental review."
              : `${role} reset; uses current session model and thinking.`,
          "info",
        );
        return;
      }
      let selected = value;
      if (!selected && ctx.mode === "tui")
        selected =
          (await ctx.ui.select(
            `${role} model`,
            (ctx.scopedModels.length
              ? ctx.scopedModels.map(({ model }) => model)
              : ctx.modelRegistry.getAvailable()
            ).map(modelName),
          )) ?? "";
      if (!selected) {
        ctx.ui.notify(
          `Usage: /continuity ${role} <provider/model[:thinking]>|reset`,
          "info",
        );
        return;
      }
      const ref = parseModelRef(selected);
      const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
        ctx.ui.notify(`Unavailable model: ${selected}`, "error");
        return;
      }
      let thinking: ThinkingLevel | undefined = ref.thinking;
      if (!value && ctx.mode === "tui") {
        thinking = (await ctx.ui.select(
          `${role} thinking level`,
          [...thinkingLevels],
        )) as ThinkingLevel | undefined;
        if (!thinking) return;
      }
      await updateConfig((current) => ({
        ...current,
        [role]: { model: modelName(model), ...(thinking ? { thinking } : {}) },
      }));
      ctx.ui.notify(
        `${role}: ${modelName(model)} · thinking: ${thinking ?? "current session level"}`,
        "info",
      );
    },
  });
  pi.registerCommand("todos", {
    description: "Show continuity todos",
    handler: async (_a, ctx) =>
      ctx.ui.notify(
        work?.todos.map((t) => `${t.id} ${t.status} ${t.text}`).join("\n") ||
          "No todos.",
        "info",
      ),
  });
  pi.registerCommand("memory", {
    description: "Show, edit, or forget user and project notebook notes",
    handler: async (args, ctx) => {
      if (!memoryEnabled) return void ctx.ui.notify("Continuity memory is disabled in package settings.", "info");
      const sub = args.trim();
      if (sub === "off" || sub === "on") {
        memoryInjectionEnabled = sub === "on";
        return void ctx.ui.notify(`Memory injection ${sub} for this session.`, "info");
      }
      project = await resolveProject(ctx.cwd); memoryState = await readMemory(); memoryNotes = memoryState.notes;
      if (sub === "migrate-v4") {
        if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for V4 memory migration.", "error");
        if (!(await ctx.ui.confirm("Migrate Memory V4 to V5?", "A configured Memory Reviewer will normalize the preserved V4 facts. Backups are retained and /memory rollback remains available until the next V5 write."))) return;
        try {
          const migration = await withMemoryLifecycle(() => runV4Migration(ctx, leasedSessionId));
          legacyMigrationAvailable = await hasPendingV4Migration(root); publishState();
          if (!migration.migrated) return void ctx.ui.notify("No V4 migration was performed; the source is absent, already migrated, or the migration was previously rolled back.", "info");
          emitMemoryOutcome("migration_committed");
          return void ctx.ui.notify(`Memory V4 migrated to V5. ${migration.rejected} record(s) were rejected; use /memory rollback before another V5 write to restore the prior notebook.`, "info");
        } catch (error: any) {
          emitMemoryOutcome("migration_failed");
          legacyMigrationAvailable = await hasPendingV4Migration(root); publishState();
          return void ctx.ui.notify(`Memory V4 migration failed: ${error?.message ?? error}`, "error");
        }
      }
      if (sub === "backups") {
        const directories = [memoryDirectory(), join(root, "memory-v4")], backups: string[] = [];
        for (const directory of directories) for (const name of await readdir(directory, { recursive: true }).catch(() => [] as string[])) if (name.includes("backup") || name.includes("reset-unsupported") || name.includes("corrupt") || name.includes("pre-migration") || name.startsWith("memory-v4") || name.startsWith("candidates-v4")) backups.push(join(directory, name));
        return void ctx.ui.notify(backups.join("\n") || "No memory backups.", "info");
      }
      if (sub === "rollback") {
        const journal = await readJson<MigrationJournal | undefined>(paths().migration, undefined, (value) => value === undefined || isMigrationJournal(value));
        if (!journal || journal.status !== "activated" || journal.activatedStateRevision !== memoryState.revision || !journal.preMigrationBackup) return void ctx.ui.notify("Migration rollback is unavailable after new V5 writes or without an activated migration.", "error");
        if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory rollback.", "error");
        if (!(await ctx.ui.confirm("Rollback Memory V5 migration?", "This restores the notebook from immediately before migration."))) return;
        const backup = journal.preMigrationBackup;
        await withMemoryLifecycle(() => withFileLock(join(memoryDirectory(), "migration-operation"), async () => {
          await withStateLock(memoryDirectory(), async () => {
            const latest = await readMemory();
            if (latest.revision !== journal.activatedStateRevision) throw Error("Memory changed after migration; rollback requires manual reconciliation.");
            let restored: MemoryStateFile;
            if (backup === "empty") restored = emptyMemoryState();
            else {
              const backupRoot = resolve(memoryDirectory(), "backups"), backupPath = resolve(backup), rel = relative(backupRoot, backupPath);
              if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw Error("Migration backup path is outside the protected backup directory.");
              const parsed = JSON.parse(await readFile(backupPath, "utf8"));
              if (!isMemoryState(parsed)) throw Error("Migration backup is missing or invalid; rollback aborted.");
              restored = parsed;
            }
            const next = { ...restored, revision: latest.revision + 1, updatedAt: new Date().toISOString() };
            enforceMemoryLimits(next); await writeMemory(next); memoryState = next; memoryNotes = next.notes;
          });
          await writeJsonAtomic(paths().migration, { ...journal, status: "rolled_back", activatedStateRevision: undefined });
        }));
        publishState(); return void ctx.ui.notify("Memory migration rolled back.", "info");
      }
      if (sub === "owners") {
        const counts = new Map<string, number>();
        for (const note of memoryNotes) counts.set(note.owner, (counts.get(note.owner) ?? 0) + 1);
        return void ctx.ui.notify([...counts].map(([owner, count]) => `${owner}${owner === project!.owner || owner === "default" ? " (current)" : ""}: ${count}`).join("\n") || "No owners.", "info");
      }
      if (sub === "show") {
        const owned = notesForOwners(memoryNotes, project.owner);
        return void ctx.ui.notify(owned.map((note) => `${note.scope}/${note.id} r${note.revision} [${note.authority}/${note.origin}]\nWhen ${note.trigger}\n${note.guidance}`).join("\n\n") || "No notes.", "info");
      }
      if (sub === "forget project") {
        if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory deletion.", "error");
        if (!(await ctx.ui.confirm("Forget all project memory?", "These rules will be removed from this project."))) return;
        await withMemoryLifecycle(() => withStateLock(memoryDirectory(), async () => {
          let latest = await readMemory();
          for (const note of latest.notes.filter((item) => item.scope === "project" && item.owner === project!.owner)) latest = directDelete(latest, "project", project!.owner, note.id, note.revision);
          await writeMemory(latest); memoryState = latest; memoryNotes = latest.notes;
        }));
        publishState(); return void ctx.ui.notify("Project memory removed.", "info");
      }
      const editMatch = /^edit\s+(user|project)\s+([0-9a-f-]+)$/i.exec(sub);
      if (editMatch) {
        if (!ctx.hasUI || ctx.mode !== "tui") return void ctx.ui.notify("Interactive UI required for memory edit.", "error");
        const scope = editMatch[1] as MemoryScope, owner = scope === "user" ? "default" : project.owner;
        const note = memoryNotes.find((item) => item.id === editMatch[2] && item.scope === scope && item.owner === owner);
        if (!note) return void ctx.ui.notify("Memory note not found.", "error");
        const value = await ctx.ui.editor(`Edit ${scope} memory`, `Trigger:\n${note.trigger}\n\nGuidance:\n${note.guidance}`);
        const parsed = /^Trigger:\s*\n([\s\S]*?)\n\s*Guidance:\s*\n([\s\S]+)$/i.exec(value ?? "");
        if (!parsed) return void ctx.ui.notify("Keep Trigger and Guidance headings.", "error");
        if (!(await ctx.ui.confirm(`Save ${scope} memory?`, scope === "user" ? "This rule applies across every project." : "This rule applies to this project."))) return;
        try {
          await withMemoryLifecycle(() => withStateLock(memoryDirectory(), async () => { const next = directEdit(await readMemory(), scope, owner, note.id, note.revision, parsed[1]!, parsed[2]!); await writeMemory(next); memoryState = next; memoryNotes = next.notes; }));
          publishState(); ctx.ui.notify("Memory note updated.", "info");
        } catch (error: any) { ctx.ui.notify(error?.message ?? "Memory update failed.", "error"); }
        return;
      }
      const forgetMatch = /^forget\s+(user|project)\s+([0-9a-f-]+)$/i.exec(sub);
      if (forgetMatch) {
        const scope = forgetMatch[1] as MemoryScope, owner = scope === "user" ? "default" : project.owner;
        const note = memoryNotes.find((item) => item.id === forgetMatch[2] && item.scope === scope && item.owner === owner);
        if (!note) return void ctx.ui.notify("Memory note not found.", "error");
        if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory deletion.", "error");
        if (!(await ctx.ui.confirm(`Forget ${scope} memory?`, scope === "user" ? "This rule will be removed from every project." : "This rule will be removed from this project."))) return;
        try {
          await withMemoryLifecycle(() => withStateLock(memoryDirectory(), async () => { const next = directDelete(await readMemory(), scope, owner, note.id, note.revision); await writeMemory(next); memoryState = next; memoryNotes = next.notes; }));
          publishState(); ctx.ui.notify("Memory note removed.", "info");
        } catch (error: any) { ctx.ui.notify(error?.message ?? "Memory delete failed.", "error"); }
        return;
      }
      ctx.ui.notify(`Injection ${memoryInjectionEnabled ? "on" : "off"}; ${notesForOwners(memoryNotes, project.owner).length} current-owner notes. Usage: /memory show|migrate-v4|edit user <id>|edit project <id>|forget user <id>|forget project <id>|forget project|owners|backups|rollback|on|off`, "info");
    },
  });
}
