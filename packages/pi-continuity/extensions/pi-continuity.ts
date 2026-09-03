import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
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
  writeBytesAtomic,
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
  assertStageable,
  directDelete,
  directEdit,
  discardExpiredReviews,
  emptyMemoryState,
  enforceMemoryLimits,
  isMemoryState,
  migrateV5MemoryState,
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
  formatReviewOutcome,
  preflightMemoryProposals,
  reviewedRecord,
  type PreflightProposal,
  userMessageText,
} from "../src/memory-review.ts";
import {
  hasPendingV4Migration,
  isMigrationJournal,
  migrateV4,
  recordPendingV4Migration,
  type MigrationJournal,
} from "../src/memory-migration.ts";
import { assertSafe, assertSafePath, sanitizeAndClip } from "../src/secrets.ts";
import { blocked, planningTools } from "../src/plan-gate.ts";
import { buildContext, shortlistNotes } from "../src/context.ts";
import {
  MEMORY_LEDGER_ENTRY_TYPE,
  activeMemoryForDelivery,
  compileMemorySidecar,
  emptyMemoryLedger,
  eventFrame,
  indexMemorySidecar,
  markActiveMemoryDelivered,
  processMemoryEvent,
  rearmMemoryAfterCompaction,
  restoreMemoryLedger,
  type CompiledMemorySidecar,
  type MemoryIntervention,
  type MemoryLedger,
} from "../src/memory-runtime.ts";
import { validateQuestions } from "../src/questions.ts";
import { askQuestionnaire } from "../src/clarify-ui.ts";
import {
  captureEvidenceRanges,
  currentChangedPaths,
  projectContext,
  worktreeFingerprint,
  type ProjectContext,
} from "../src/worktree.ts";
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  compactionReviewerMaxOutputTokens,
  compactionReviewTimeoutMs,
  continuityPrompt,
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
  isRunEntry,
  runTimelineId,
  RUN_ENTRY_TYPE,
  type RunEntry,
} from "../src/run.ts";
import { CONTINUITY_STATE_VERSION, continuityStateSnapshot } from "../src/state.ts";
import {
  finalizeContinuityCompaction,
  prepareContinuityCompaction,
  type CompactionSupplement,
} from "../src/compaction.ts";
import { buildCompactionReviewPacket, callCompactionReviewer } from "../src/compaction-review.ts";
import { canUseBroadRecall, recallProjectSessions, recallSession } from "../src/recall.ts";
import { loadProjectRecallSessions } from "../src/project-recall.ts";
import { findMovedProjectOwner, reassociateOwnerNotes } from "../src/owner-reassociation.ts";
const continuityTools = ["continuity_recall", "continuity_update", "memory"];
const EXECUTION_ENTRY_TYPE = "pi-continuity-execution";
const COMPACTION_CONTINUATION_CHANNEL = "pi-continuity:compaction-continuation";
const COMPACTION_INTERRUPTION_DIAGNOSTIC = "pi-continuity-compaction-interruption";
const COMPACTION_ABORT_ERROR = /^(?:this operation|request) was aborted\.?$/i;
type CompactionContinuationRequest = {
  id: string;
  sessionGeneration: number;
  taskGeneration: number;
  sessionId: string;
};
type V5MigrationJournal = {
  version: 1;
  status: "prepared" | "activated" | "rolled_back";
  sourceSha256: string;
  stateSha256: string;
  activatedRevision: number;
  backupPath: string;
  preparedAt: string;
  migratedAt?: string;
  rolledBackAt?: string;
};
const isV5MigrationJournal = (value: any): value is V5MigrationJournal =>
  value?.version === 1 &&
  ["prepared", "activated", "rolled_back"].includes(value.status) &&
  [value.sourceSha256, value.stateSha256].every(item => typeof item === "string" && /^[0-9a-f]{64}$/.test(item)) &&
  Number.isSafeInteger(value.activatedRevision) &&
  value.activatedRevision >= 0 &&
  typeof value.backupPath === "string" &&
  value.backupPath.length > 0 &&
  value.backupPath.length <= 500 &&
  typeof value.preparedAt === "string" &&
  !Number.isNaN(Date.parse(value.preparedAt)) &&
  (value.migratedAt === undefined ||
    (typeof value.migratedAt === "string" && !Number.isNaN(Date.parse(value.migratedAt)))) &&
  (value.rolledBackAt === undefined ||
    (typeof value.rolledBackAt === "string" && !Number.isNaN(Date.parse(value.rolledBackAt))));
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
const applyManualIssueUpdate = (active: Work, failure: string | undefined, nextAction: string | undefined) => {
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

const formatPlan = (work: Work) =>
  [
    "Plan",
    "",
    "Goal",
    work.goal.trim() || "Not specified",
    "",
    "Approach",
    work.planSummary?.trim() || "Not specified",
    "",
    "Working Set",
    ...(work.handoff?.workingSet.length ? work.handoff.workingSet.map(value => `- ${value}`) : ["- Not specified"]),
    "",
    "Assumptions / Gaps",
    ...(work.handoff?.assumptions.length ? work.handoff.assumptions.map(value => `- ${value}`) : ["- None stated"]),
    "",
    "Acceptance Criteria",
    ...(work.handoff?.acceptanceCriteria.length
      ? work.handoff.acceptanceCriteria.map(value => `- ${value}`)
      : ["- Not specified"]),
    "",
    "Constraints",
    ...(work.constraints.length ? work.constraints.map(constraint => `- ${constraint}`) : ["- None"]),
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
    details.timelineId === (active.timelineId ?? active.runId),
  );
};

const Status = StringEnum(["pending", "in_progress", "done", "blocked"] as const),
  Action = StringEnum(["clarify", "set_plan", "todo", "state"] as const),
  MemAction = StringEnum(["list", "propose"] as const),
  ScopeName = StringEnum(["user", "project"] as const),
  RecallScopeName = StringEnum(["execution", "lineage", "all", "project_sessions"] as const),
  RecallModeName = StringEnum(["text", "files", "touched", "tools"] as const);
export default function continuityExtension(pi: ExtensionAPI) {
  let duplicate = false;
  pi.events.emit("pi-continuity:instance-claim", {
    version: 1,
    respond: () => {
      duplicate = true;
    },
  });
  if (duplicate) return;
  const instanceId = randomUUID();
  const disposeInstanceClaim = pi.events.on("pi-continuity:instance-claim", (request: any) => {
    if (request?.version === 1) request.respond?.(instanceId);
  });
  let root = defaultRoot(),
    dir = "",
    workFile = "",
    workspace: Workspace | undefined,
    all: Workspace[] = [],
    work: Work | undefined,
    project: ProjectContext | undefined,
    savedTools: string[] | undefined,
    lastPrompt = "",
    tasksVisible = true,
    awaitingClarificationProse = false,
    recentCalls = new Map<string, number[]>(),
    pendingMutations = new Map<string, string | undefined>(),
    deniedToolCalls = new Set<string>(),
    seenMutationMessages = new Set<string>(),
    terminatingToolCalls = new Set<string>(),
    automaticCompaction: CompactionContinuationRequest | undefined,
    sharedWorktreeObserver = false,
    stateRevision = 0,
    clarifyTimeoutSeconds: number | null | undefined;

  // The notebook for the current owner, plus the per-task guards that keep proposals single-shot.
  const initialSidecar = compileMemorySidecar([], 0);
  const memory = {
    state: emptyMemoryState(),
    notes: [] as NotebookNote[],
    sidecar: initialSidecar,
    ruleIndex: indexMemorySidecar(initialSidecar),
    ledger: emptyMemoryLedger("unleased") as MemoryLedger,
    enabled: true,
    reviewerConfigured: false,
    activationEnabled: true,
    legacyMigrationAvailable: false,
    taskGeneration: 0,
    proposalToken: undefined as string | undefined,
    reviewCalledThisTask: false,
  };

  // Identity of the leased session. Every unlocked await re-checks these before writing.
  const session = {
    id: "",
    generation: 0,
    ephemeral: false,
    cwd: "",
    context: undefined as any,
    releaseLease: undefined as ((cleanupIfLast?: () => Promise<void>) => Promise<void>) | undefined,
  };

  // The /plan approval handshake; the last three are installed once the plan action is registered.
  const planApproval = {
    pending: undefined as { runId?: string; revision: number } | undefined,
    context: undefined as any,
    selection: undefined as object | undefined,
    schedule: (_ctx: any) => {},
    resume: async (_ctx: any) => false,
    dispose: () => {},
  };

  // Latest Verify result for this worktree, and whether completion still requires one.
  const verifyState = { latest: undefined as any, needed: false };

  let memoryLifecycleQueue = Promise.resolve(),
    planMutationQueue = Promise.resolve();
  const withMemoryLifecycle = async <T>(task: () => Promise<T>): Promise<T> => {
    const previous = memoryLifecycleQueue;
    let release = () => {};
    memoryLifecycleQueue = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };
  const emitCompactionContinuation = (action: "begin" | "resume" | "abandon", request: CompactionContinuationRequest) =>
    pi.events.emit(COMPACTION_CONTINUATION_CHANNEL, { version: 1, action, requestId: request.id, ...request });
  const abandonAutomaticCompaction = (request = automaticCompaction) => {
    if (!request || automaticCompaction !== request) return;
    automaticCompaction = undefined;
    emitCompactionContinuation("abandon", request);
  };
  const disposeCompactionCancel = pi.events.on(COMPACTION_CONTINUATION_CHANNEL, (event: any) => {
    const request = automaticCompaction;
    if (
      event?.version !== 1 ||
      event.action !== "cancel" ||
      !request ||
      event.requestId !== request.id ||
      event.sessionId !== request.sessionId ||
      event.sessionGeneration !== request.sessionGeneration ||
      event.taskGeneration !== request.taskGeneration
    )
      return;
    abandonAutomaticCompaction(request);
  });
  const withPlanMutation = async <T>(task: () => Promise<T>): Promise<T> => {
    const previous = planMutationQueue;
    let release = () => {};
    planMutationQueue = new Promise<void>(resolve => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };
  pi.events.emit("pylon:worktree-observer-request", {
    version: 1,
    respond: (value: any) => {
      if (value?.version === 1 && value.owner === "pylon-core") sharedWorktreeObserver = true;
    },
  });
  const invalidateVerification = () => {
    verifyState.latest = undefined;
    verifyState.needed = true;
  };
  const disposeWorktreeChange = pi.events.on("pylon:worktree-change", (event: any) => {
    if (!sharedWorktreeObserver || event?.version !== 1 || event.cwd !== session.cwd || event.changed !== true) return;
    invalidateVerification();
  });
  const disposePackageMutation = pi.events.on("pi-worktree:mutation", (event: any) => {
    if (event?.version !== 1 || event.cwd !== session.cwd || event.changed !== true) return;
    invalidateVerification();
  });
  const disposeGuardDecision = pi.events.on("pi-guard:decision", (event: any) => {
    if (
      event?.version === 1 &&
      event.cwd === session.cwd &&
      event.decision === "blocked" &&
      typeof event.toolCallId === "string"
    )
      deniedToolCalls.add(event.toolCallId);
  });
  const modelName = (model: any) => `${model.provider}/${model.id}`;
  const assistantContent = (ctx: any) => {
    const entry = ctx.sessionManager?.getLeafEntry?.();
    const content =
      entry?.type === "message" && entry.message?.role === "assistant" ? entry.message.content : undefined;
    return Array.isArray(content) ? content : [];
  };
  const hasReplyBeforeCompletion = (event: any, ctx: any) => {
    const content = assistantContent(ctx);
    const callIndex = content.findIndex((part: any) => part?.type === "toolCall" && part.id === event.toolCallId);
    return callIndex > 0 && content.slice(0, callIndex).some((part: any) => part?.type === "text" && part.text.trim());
  };
  const hasUnsafeClarificationBatch = (ctx: any) => {
    const calls = assistantContent(ctx).filter((part: any) => part?.type === "toolCall");
    return (
      calls.length > 1 &&
      calls.some((part: any) => part.name === "continuity_update" && part.arguments?.action === "clarify")
    );
  };
  const disposeRuntimePolicy = pi.events.on?.("pylon:runtime-policy", (event: any) => {
    if (event?.version !== 2) return;
    const value = event.dialogTimeouts?.clarify;
    if (value === null || (Number.isInteger(value) && value >= 15 && value <= 86_400)) {
      clarifyTimeoutSeconds = value;
    }
  });
  const clarifyDialogOptions = () =>
    clarifyTimeoutSeconds === undefined
      ? undefined
      : { timeout: clarifyTimeoutSeconds === null ? 0 : clarifyTimeoutSeconds * 1_000 };
  const tripsCircuitBreaker = (params: unknown) => {
    const now = Date.now(),
      cutoff = now - 30_000;
    for (const [key, times] of recentCalls) {
      const fresh = times.filter(time => time > cutoff);
      if (fresh.length) recentCalls.set(key, fresh);
      else recentCalls.delete(key);
    }
    const key = JSON.stringify([
      params,
      verifyState.latest?.state,
      work?.mode,
      work?.currentTodoId,
      work?.todos.map(todo => [todo.id, todo.status]),
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
  const applyProfile = async (ctx: any, profile: ModelProfile | undefined) => {
    if (!profile) return true;
    const model = await configuredModel(ctx, profile);
    if (!model || !(await pi.setModel(model))) return false;
    if (profile.thinking) pi.setThinkingLevel(profile.thinking);
    return true;
  };
  const paths = () => ({
    work: workFile,
    memory: join(root, "memory-v6", "state.json"),
    compiledMemory: join(root, "memory-v6", "compiled.json"),
    v6Migration: join(root, "memory-v6", "migration-v5.json"),
    v5Memory: join(root, "memory-v5", "state.json"),
    migration: join(root, "memory-v6", "migration.json"),
    legacyMemory: join(root, "memory-v4", "memory.json"),
    legacyCandidates: join(root, "memory-v4", "candidates.json"),
  });
  const memoryDirectory = () => join(root, "memory-v6");
  const readV5MigrationJournal = async () => {
    try {
      const value = JSON.parse(await readFile(paths().v6Migration, "utf8"));
      if (!isV5MigrationJournal(value)) throw Error("Memory V5 migration journal is invalid");
      return value;
    } catch (error: any) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  };
  const scopedMemoryNotes = (notes = memory.notes) =>
    project
      ? notesForOwners(notes, project.owner)
      : notes.filter(note => note.scope === "user" && note.owner === "default");
  const pruneMemoryLedger = () => {
    const compiled = new Set(memory.sidecar.rules.map(rule => `${rule.memoryId}\0${rule.noteRevision}`));
    memory.ledger = {
      ...memory.ledger,
      active: memory.ledger.active.filter(item => compiled.has(`${item.memoryId}\0${item.noteRevision}`)),
    };
  };
  const refreshMemoryCompilation = async (state: MemoryStateFile, persist = true) => {
    const scoped = scopedMemoryNotes(state.notes),
      compilable: NotebookNote[] = [],
      stale: CompiledMemorySidecar["failures"] = [];
    for (const note of scoped) {
      if (note.disposition !== "eligible_advisory" || note.authority !== "project_contract") {
        compilable.push(note);
        continue;
      }
      const review = state.reviews.find(item => item.reviewId === note.sourceReviewId);
      const refs = note.sourceRefs.filter(
        (ref): ref is Extract<NotebookNote["sourceRefs"][number], { type: "repository" }> => ref.type === "repository",
      );
      const ranges = (review?.evidenceBatches?.flat() ?? []).filter(range =>
        refs.some(ref => ref.path === range.path && ref.excerptSha256 === range.excerptSha256),
      );
      try {
        const captured = ranges.length
          ? await captureEvidenceRanges(
              session.cwd,
              ranges.map(({ path, start, end }) => ({ path, start, end })),
            )
          : [];
        if (
          !refs.length ||
          !refs.every(ref => captured.some(item => item.path === ref.path && item.excerptSha256 === ref.excerptSha256))
        )
          throw Error("stale");
        compilable.push(note);
      } catch {
        stale.push({ memoryId: note.id, noteRevision: note.revision, reason: "source_stale" });
      }
    }
    memory.sidecar = compileMemorySidecar(compilable, state.revision);
    memory.sidecar.failures.push(...stale);
    memory.ruleIndex = indexMemorySidecar(memory.sidecar);
    pruneMemoryLedger();
    if (persist) await writeJsonAtomic(paths().compiledMemory, memory.sidecar).catch(() => {});
  };
  const readMemory = async () => {
    try {
      await readFile(paths().memory, "utf8");
      const state = normalizeMemoryState(await readVersionedJson(paths().memory, emptyMemoryState(), isMemoryState))!;
      const journal = await readV5MigrationJournal();
      if (journal?.status === "prepared") {
        if (journal.activatedRevision !== state.revision || journal.stateSha256 !== sha256(JSON.stringify(state)))
          throw Error("Memory V5 migration is incomplete and does not match V6 state");
        await writeJsonAtomic(paths().v6Migration, {
          ...journal,
          status: "activated",
          migratedAt: new Date().toISOString(),
        } satisfies V5MigrationJournal);
      }
      await refreshMemoryCompilation(state);
      return state;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const existingJournal = await readV5MigrationJournal();
    if (existingJournal?.status === "rolled_back")
      throw Error("Memory V5 migration was rolled back; restore or remove its journal before migrating again");
    if (existingJournal?.status === "activated")
      throw Error("Memory V6 state is missing after an activated V5 migration");
    let rawV5: string;
    try {
      rawV5 = await readFile(paths().v5Memory, "utf8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const state = emptyMemoryState();
      await refreshMemoryCompilation(state);
      return state;
    }
    let legacy: unknown;
    try {
      legacy = JSON.parse(rawV5);
    } catch {
      throw Error("Memory V5 state is malformed; migration stopped without modifying it");
    }
    const migrated = migrateV5MemoryState(legacy);
    if (!migrated) throw Error("Memory V5 state is unsupported; migration stopped without modifying it");
    const sourceSha256 = sha256(rawV5),
      stateSha256 = sha256(JSON.stringify(migrated));
    if (
      existingJournal?.status === "prepared" &&
      (existingJournal.sourceSha256 !== sourceSha256 ||
        existingJournal.stateSha256 !== stateSha256 ||
        existingJournal.activatedRevision !== migrated.revision)
    )
      throw Error("Memory V5 changed after migration preparation");
    const backupPath = join(memoryDirectory(), "backups", `state-v5-${sourceSha256}.json`),
      preparedAt = new Date().toISOString();
    await writeBytesAtomic(backupPath, rawV5);
    const prepared: V5MigrationJournal = {
      version: 1,
      status: "prepared",
      sourceSha256,
      stateSha256,
      activatedRevision: migrated.revision,
      backupPath,
      preparedAt,
    };
    await writeJsonAtomic(paths().v6Migration, prepared);
    await writeMemory(migrated);
    await writeJsonAtomic(paths().v6Migration, {
      ...prepared,
      status: "activated",
      migratedAt: new Date().toISOString(),
    });
    return migrated;
  };
  const writeMemory = async (state: MemoryStateFile) => {
    await writeJsonAtomic(paths().memory, state);
    await refreshMemoryCompilation(state);
  };
  const ownerFor = (scope: MemoryScope) => (scope === "user" ? "default" : project?.owner);
  const resolveProject = async (cwd: string) => {
    const resolved = await projectContext(cwd, workspace?.projectOwner ?? project?.owner ?? workspace!.id);
    project = resolved;
    if (workspace && resolved.owner !== workspace.id && workspace.projectOwner !== resolved.owner) {
      workspace.projectOwner = resolved.owner;
      all = await updateJson<Workspace[]>(
        join(root, "workspaces.json"),
        [],
        items => items.map(item => (item.id === workspace!.id ? { ...item, projectOwner: resolved.owner } : item)),
        Array.isArray,
      );
    }
    return resolved;
  };
  const reassociateProjectMemory = async (latest: MemoryStateFile) => {
    if (!project) return latest;
    const workspaces = await readJson<Workspace[]>(
      join(root, "workspaces.json"),
      [],
      items => Array.isArray(items) && items.every(isWorkspace),
    );
    const oldOwner = await findMovedProjectOwner(session.cwd, project.owner, workspaces, latest.notes);
    if (!oldOwner) return latest;
    const at = new Date().toISOString(),
      migrationId = randomUUID();
    const reassociated = reassociateOwnerNotes(oldOwner, project.owner, latest.notes, at);
    const affected = [...reassociated.moved, ...reassociated.suppressed];
    if (!affected.length) return latest;
    const backup = {
      version: 1,
      migrationId,
      oldOwner,
      currentOwner: project.owner,
      createdAt: at,
      fromRevision: latest.revision,
      movedNoteIds: reassociated.moved.map(note => note.id),
      suppressedNoteIds: reassociated.suppressed.map(note => note.id),
      notes: affected,
    };
    const audit = {
      type: "owner_reassociation" as const,
      migrationId,
      oldOwner,
      owner: project.owner,
      at,
      movedNoteIds: backup.movedNoteIds,
      suppressedNoteIds: backup.suppressedNoteIds,
      fromRevision: latest.revision,
    };
    const next = {
      ...latest,
      revision: latest.revision + 1,
      notes: reassociated.notes,
      audits: [...(latest.audits ?? []), audit].slice(-100),
      updatedAt: at,
    };
    enforceMemoryLimits(next);
    await writeJsonAtomic(join(memoryDirectory(), "backups", `owner-reassociation-${migrationId}.json`), backup);
    return next;
  };
  const persistMemoryLedger = () => pi.appendEntry(MEMORY_LEDGER_ENTRY_TYPE, memory.ledger);
  const interventionText = (interventions: readonly MemoryIntervention[]) => {
    const byId = new Map(scopedMemoryNotes().map(note => [note.id, note]));
    const lines = interventions.flatMap(intervention => {
      const note = byId.get(intervention.memoryId);
      return note && note.revision === intervention.noteRevision
        ? [`Applicable working rule [${note.id}]: When ${note.trigger}, ${note.guidance}`]
        : [];
    });
    return lines.join("\n");
  };
  const queueMemoryInterventions = (interventions: readonly MemoryIntervention[]) => {
    const text = interventionText(interventions);
    if (!text) return;
    persistMemoryLedger();
    pi.sendMessage(
      {
        customType: "pi-continuity-memory",
        content: text,
        display: false,
        details: {
          version: 2,
          contextEpoch: memory.ledger.contextEpoch,
          memoryIds: interventions.map(item => item.memoryId),
        },
      },
      { deliverAs: "steer" },
    );
    pi.events.emit("pi-continuity:memory-activation", {
      version: 1,
      outcome: "delivered",
      memoryIds: interventions.map(item => item.memoryId),
      contextEpoch: memory.ledger.contextEpoch,
    });
  };
  const processProspectiveMemory = (frame: ReturnType<typeof eventFrame>) => {
    const processed = processMemoryEvent(memory.ruleIndex, frame, memory.ledger);
    memory.ledger = processed.ledger;
    if (processed.uncertain.length)
      pi.events.emit("pi-continuity:memory-activation", {
        version: 1,
        outcome: "abstained",
        memoryIds: processed.uncertain,
        contextEpoch: memory.ledger.contextEpoch,
      });
    queueMemoryInterventions(processed.interventions);
    return processed.interventions;
  };
  const projectMemory = () =>
    project ? memory.notes.filter(note => note.scope === "project" && note.owner === project!.owner) : [];
  const globalMemory = () => memory.notes.filter(note => note.scope === "user" && note.owner === "default");
  const stateSnapshot = (available = true) =>
    continuityStateSnapshot(
      session.id,
      stateRevision,
      work,
      available,
      projectMemory(),
      globalMemory(),
      memory.legacyMigrationAvailable,
    );
  const publishState = (available = true) => {
    stateRevision++;
    pi.events.emit("pi-continuity:state-change", stateSnapshot(available));
  };
  const emitMemoryOutcome = (
    outcome:
      | "preflight_rejected"
      | "reviewer_failed"
      | "staged"
      | "committed"
      | "discarded"
      | "migration_failed"
      | "migration_committed",
  ) => pi.events.emit("pi-continuity:memory-outcome", { version: 1, outcome, at: new Date().toISOString() });
  const disposeStateRequest = pi.events.on("pi-continuity:state-request", (request: any) => {
    if (
      request?.version !== CONTINUITY_STATE_VERSION ||
      request.sessionId !== session.id ||
      typeof request.respond !== "function"
    )
      return;
    try {
      request.respond(stateSnapshot());
    } catch {
      /* State observers cannot affect Continuity. */
    }
  });
  const disposeMemoryMutation = pi.events.on("pi-continuity:memory-mutation", (request: any) => {
    if (request?.version !== 2 && typeof request?.respond === "function") {
      request.respond(Promise.reject(new Error("Continuity memory mutation version 1 is no longer supported")));
      return;
    }
    if (request?.version !== 2 || typeof request.respond !== "function") return;
    if (request.sessionId !== session.id || request.expectedGeneration !== session.generation) {
      request.respond(Promise.reject(new Error("Continuity memory mutation is stale or belongs to another session")));
      return;
    }
    const operation = withMemoryLifecycle(async () => {
      if (!memory.enabled) throw Error("Continuity memory is disabled in package settings");
      const requestedSession = request.sessionId,
        requestedGeneration = request.expectedGeneration,
        requestedCwd = session.cwd;
      if (request.action === "migrate") {
        const allowed = new Set(["version", "sessionId", "expectedGeneration", "action", "respond"]);
        if (Object.keys(request).some(key => !allowed.has(key))) throw Error("invalid memory migration fields");
        if (!session.context || !memory.legacyMigrationAvailable)
          throw Error("V4 memory migration is unavailable or already changed");
        const migration = await runV4Migration(session.context, requestedSession);
        if (
          session.id !== requestedSession ||
          session.generation !== requestedGeneration ||
          session.cwd !== requestedCwd
        )
          throw Error("Continuity memory migration became stale");
        memory.legacyMigrationAvailable = await hasPendingV4Migration(root);
        if (migration.migrated) emitMemoryOutcome("migration_committed");
        publishState();
        return migration;
      }
      if (request.action !== "update" && request.action !== "delete") throw Error("invalid memory action");
      const allowed =
        request.action === "update"
          ? new Set([
              "version",
              "sessionId",
              "expectedGeneration",
              "action",
              "scope",
              "id",
              "trigger",
              "guidance",
              "expectedRevision",
              "respond",
            ])
          : new Set([
              "version",
              "sessionId",
              "expectedGeneration",
              "action",
              "scope",
              "id",
              "expectedRevision",
              "respond",
            ]);
      if (Object.keys(request).some(key => !allowed.has(key))) throw Error("invalid memory mutation fields");
      if (
        (request.scope !== "user" && request.scope !== "project") ||
        typeof request.id !== "string" ||
        !Number.isSafeInteger(request.expectedRevision) ||
        request.expectedRevision < 1
      )
        throw Error("invalid memory target");
      const resolved = await resolveProject(requestedCwd),
        owner = request.scope === "user" ? "default" : resolved.owner;
      await withStateLock(memoryDirectory(), async () => {
        if (
          session.id !== requestedSession ||
          session.generation !== requestedGeneration ||
          session.cwd !== requestedCwd ||
          project?.owner !== resolved.owner
        )
          throw Error("Continuity memory mutation became stale");
        const latest = await readMemory();
        const next =
          request.action === "delete"
            ? directDelete(latest, request.scope, owner, request.id, request.expectedRevision)
            : directEdit(
                latest,
                request.scope,
                owner,
                request.id,
                request.expectedRevision,
                request.trigger,
                request.guidance,
              );
        await writeMemory(next);
        memory.state = next;
        memory.notes = next.notes;
      });
      publishState();
      return { updated: true, revision: memory.state.revision };
    });
    request.respond(operation);
  });
  const saveWork = async () => {
    const path = paths().work;
    try {
      if (!work) return;
      if (!isWork(work)) throw Error("Continuity Work invariants are invalid.");
      assertSafe(
        work.goal,
        work.planSummary,
        ...work.constraints,
        ...(work.handoff?.assumptions ?? []),
        ...(work.handoff?.acceptanceCriteria ?? []),
        work.revisionFeedback?.text,
        work.latestFailure,
        work.nextAction,
        ...work.todos.map(t => t.text),
      );
      assertSafePath(...(work.handoff?.workingSet ?? []));
      await writeJson(path, work);
      publishState();
    } catch (error) {
      work = undefined;
      try {
        work = await readJson<Work | undefined>(path, undefined, value => value === undefined || isWork(value));
      } catch {
        /* Preserve the save error and fail closed if durable state cannot be restored. */
      }
      throw error;
    }
  };
  const refresh = (ctx: any) => {
    if (ctx.hasUI)
      ctx.ui.setStatus(
        "pi-continuity",
        work?.mode === "planning"
          ? ctx.mode === "tui" && ctx.ui.theme?.fg
            ? ctx.ui.theme.fg("warning", "Plan mode")
            : "Plan mode"
          : undefined,
      );
    if (ctx.mode === "tui")
      ctx.ui.setWidget(
        "pi-continuity",
        work && !["handed_off", "completed", "cancelled"].includes(work.mode)
          ? (_tui: unknown, theme: any) =>
              new Text(
                [
                  theme.fg("muted", "Tasks"),
                  ...work!.todos.map(t =>
                    t.status === "done"
                      ? `${theme.fg("success", "●")} ${theme.fg("muted", theme.strikethrough(t.text))}`
                      : t.status === "in_progress"
                        ? `${theme.fg("accent", "●")} ${theme.fg("text", t.text)}`
                        : `${theme.fg("dim", "○")} ${theme.fg("muted", t.text)}`,
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
  const activeBranchHasToolResult = (ctx: any, toolCallId: string) =>
    (ctx.sessionManager.getBranch?.() ?? []).some(
      (entry: any) =>
        entry?.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId === toolCallId,
    );
  const settleMemoryReviews = async (ctx: any) =>
    withMemoryLifecycle(async () => {
      if (!memory.enabled || !project) return;
      const expectedSession = session.id,
        expectedGeneration = session.generation,
        expectedOwner = project.owner,
        expectedCwd = session.cwd;
      await withStateLock(memoryDirectory(), async () => {
        if (
          session.id !== expectedSession ||
          session.generation !== expectedGeneration ||
          session.cwd !== expectedCwd ||
          project?.owner !== expectedOwner
        )
          return;
        let latest = await readMemory(),
          changed = false;
        const reconciled = discardExpiredReviews(latest);
        if (reconciled !== latest) {
          latest = reconciled;
          changed = true;
        }
        for (const original of latest.reviews.filter(
          item =>
            item.status === "approved_pending" &&
            item.sessionId === expectedSession &&
            item.projectOwner === expectedOwner,
        )) {
          const discard = (reason: string) => {
            const now = new Date().toISOString();
            latest = {
              ...latest,
              revision: latest.revision + 1,
              updatedAt: now,
              reviews: latest.reviews.map(item =>
                item.reviewId === original.reviewId
                  ? { ...item, status: "discarded" as const, discardReason: reason, settledAt: now }
                  : item,
              ),
            };
            changed = true;
            emitMemoryOutcome("discarded");
          };
          if (original.generation !== expectedGeneration || original.taskGeneration !== memory.taskGeneration) {
            discard("session or task generation changed");
            continue;
          }
          if (!activeBranchHasToolResult(ctx, original.toolCallId)) {
            discard("proposal tool result is not on the active branch");
            continue;
          }
          const branch = ctx.sessionManager.getBranch?.() ?? [],
            byId = new Map(branch.map((entry: any) => [entry?.id, entry]));
          if (
            original.quoteRefs?.some(ref => {
              const entry = byId.get(ref.entryId);
              return !entry || sha256(userMessageText(entry)) !== ref.entrySha256;
            })
          ) {
            discard("quoted user instruction changed or left the active branch");
            continue;
          }
          let evidenceValid = true;
          for (const batch of original.evidenceBatches ?? []) {
            try {
              const fresh = await captureEvidenceRanges(
                expectedCwd,
                batch.map(({ path, start, end }) => ({ path, start, end })),
              );
              if (fresh.some((range, index) => range.excerptSha256 !== batch[index]?.excerptSha256))
                evidenceValid = false;
            } catch {
              evidenceValid = false;
            }
          }
          if (!evidenceValid) {
            discard("cited evidence changed or is unavailable after memory review");
            continue;
          }
          try {
            latest = applyReview(latest, original);
            changed = true;
            emitMemoryOutcome("committed");
          } catch (error: any) {
            discard(error?.message ?? "review conflict");
          }
        }
        if (changed) await writeMemory(latest);
        memory.state = latest;
        memory.notes = latest.notes;
      });
      publishState();
    });
  const runV4Migration = async (ctx: any, expectedSession: string) => {
    const expectedGeneration = session.generation,
      expectedTaskGeneration = memory.taskGeneration,
      expectedCwd = session.cwd;
    const resolved = await resolveProject(expectedCwd),
      expectedOwner = resolved.owner,
      expectedWorkspaceId = workspace?.id;
    if (!expectedWorkspaceId) throw Error("migration workspace identity is unavailable");
    const config = await loadConfig(),
      profile = config.memoryReviewer;
    if (!profile) throw Error("Memory Reviewer is not configured");
    const model = await configuredModel(ctx, profile);
    if (!model) throw Error("Memory Reviewer model or credentials are unavailable");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth?.ok || !auth.apiKey) throw Error("Memory Reviewer model or credentials are unavailable");
    const ownerRoots = new Map<string, string>();
    for (const item of all) if (item.projectOwner) ownerRoots.set(item.projectOwner, item.canonicalPath);
    ownerRoots.set(expectedOwner, expectedCwd);
    return migrateV4({
      root,
      ownerRoots,
      model,
      auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
      profile,
      prompt: continuityPrompt(config.prompt),
      sessionId: expectedSession,
      onTelemetry: value =>
        pi.events.emit("pi-continuity:memory-migration-telemetry", {
          version: 1,
          model: modelName(model),
          thinking: profile.thinking,
          ...value,
        }),
      commitAll: async imported =>
        withStateLock(memoryDirectory(), async () => {
          if (
            session.id !== expectedSession ||
            session.generation !== expectedGeneration ||
            memory.taskGeneration !== expectedTaskGeneration ||
            session.cwd !== expectedCwd ||
            workspace?.id !== expectedWorkspaceId ||
            project?.owner !== expectedOwner ||
            (await projectContext(expectedCwd, expectedWorkspaceId)).owner !== expectedOwner
          )
            throw Error("migration activation became stale");
          const latest = await readMemory(),
            byId = new Map(latest.notes.map(note => [note.id, note])),
            missing = imported.filter(note => !byId.has(note.id));
          if (!missing.length) {
            memory.state = latest;
            memory.notes = latest.notes;
            return latest.revision;
          }
          if (missing.length !== imported.length)
            throw Error("migration activation is partially present; manual reconciliation required");
          for (const note of imported)
            if (strongDuplicate(latest.notes, note.scope, note.owner, note.trigger, note.guidance))
              throw Error(`migration duplicates existing note ${note.id}`);
          let next = {
            ...latest,
            revision: latest.revision + 1,
            notes: [...latest.notes, ...imported],
            updatedAt: new Date().toISOString(),
          };
          next = await reassociateProjectMemory(next);
          enforceMemoryLimits(next);
          await writeMemory(next);
          memory.state = next;
          memory.notes = next.notes;
          return next.revision;
        }),
    });
  };
  const enabledContinuityTools = () =>
    memory.enabled ? continuityTools : continuityTools.filter(tool => tool !== "memory");
  const gate = (on: boolean) => {
    if (on) savedTools ??= pi.getActiveTools();
    let coordinated = false;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-continuity",
      managedTools: continuityTools,
      enabledTools: enabledContinuityTools(),
      deferredTools: enabledContinuityTools().filter(
        tool => tool === "continuity_recall" || (tool === "memory" && !memory.reviewerConfigured),
      ),
      toolUsage: Object.fromEntries(
        enabledContinuityTools().map(tool => [
          tool,
          tool === "continuity_recall"
            ? "recall bounded historical evidence omitted from the active context"
            : tool === "memory"
              ? "inspect durable notes or propose grounded reviewer-gated memory changes"
              : "update planning, todo, execution state, or request structured clarification",
        ]),
      ),

      ...(on ? { allowOnly: planningTools() } : {}),
      ...(!on && savedTools
        ? {
            restoreTools: [
              ...new Set([
                ...savedTools.filter(tool => memory.enabled || tool !== "memory"),
                ...enabledContinuityTools(),
              ]),
            ],
          }
        : {}),
      acknowledge: () => {
        coordinated = true;
      },
    });
    if (coordinated) {
      if (!on) savedTools = undefined;
      return;
    }
    if (on) {
      const allowed = new Set(planningTools());
      pi.setActiveTools([
        ...new Set([
          ...pi.getActiveTools().filter(tool => allowed.has(tool) && (memory.enabled || tool !== "memory")),
          ...enabledContinuityTools(),
        ]),
      ]);
    } else if (savedTools) {
      pi.setActiveTools([
        ...new Set([
          ...pi.getActiveTools().filter(tool => memory.enabled || tool !== "memory"),
          ...savedTools.filter(tool => memory.enabled || tool !== "memory"),
          ...enabledContinuityTools(),
        ]),
      ]);
      savedTools = undefined;
    } else if (!memory.enabled) {
      pi.setActiveTools(pi.getActiveTools().filter(tool => tool !== "memory"));
    }
  };
  const completeWork = async (ctx: any) => {
    if (!work || work.mode === "completed") return false;
    clearIssue(work);
    work.mode = "completed";
    work.currentTodoId = undefined;
    work.completedAt = new Date().toISOString();
    work.updatedAt = new Date().toISOString();
    await saveWork();
    gate(false);
    refresh(ctx);
    return true;
  };
  const readyForAutomaticCompletion = () =>
    !!work &&
    work.mode === "executing" &&
    !awaitingClarificationProse &&
    !hasRemainingTodos(work) &&
    !verifyState.needed &&
    verifyState.latest?.state !== "failed";
  const disposeVerify = pi.events.on("pi-verify:result", (event: any) => {
    if (event?.version !== 1 || event.cwd !== session.cwd || event.sessionId !== session.id) return;
    verifyState.latest = event;
    let changed = false;
    if (["passed", "clean", "no_checks", "stale"].includes(event.state) && work?.issue?.kind === "verification") {
      clearIssue(work);
      changed = true;
    }
    if (["passed", "stale"].includes(event.state)) {
      verifyState.needed = false;
      const remaining = work?.mode === "executing" ? work.todos.filter(todo => todo.status !== "done") : [];
      if (work && remaining.length === 1 && isVerificationOnlyTodo(remaining[0].text)) {
        updateTodo(work, remaining[0].id, "done");
        changed = true;
      }
    }
    if (work && ["failed", "error"].includes(event.state)) {
      setIssue(
        work,
        "verification",
        `Verification ${event.state} (${event.results?.find((item: any) => item.code !== 0)?.command ?? "unknown check"}).`,
        "Inspect the bounded verification problem and repair it only when attributable to current changes; otherwise report it.",
      );
      changed = true;
    }
    if (work && changed) {
      work.updatedAt = new Date().toISOString();
      void saveWork();
    }
  });
  const disposeHeartbeat = pi.events.on("pi-heartbeat:job", (event: any) => {
    if (event?.version !== 1 || event.cwd !== session.cwd || event.sessionId !== session.id || !event.todoId || !work)
      return;
    const todo = work.todos.find(item => item.id === event.todoId);
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
  pi.on("session_start", async (_e, ctx) =>
    withMemoryLifecycle(async () => {
      abandonAutomaticCompaction();
      gate(false);
      session.generation++;
      const sessionId = ctx.sessionManager.getSessionId();
      const reuseSessionLease = !!session.releaseLease && session.id === sessionId;
      if (session.releaseLease && !reuseSessionLease) {
        const previousWorkFile = workFile;
        await session.releaseLease(
          session.ephemeral && previousWorkFile ? () => rm(previousWorkFile, { force: true }) : undefined,
        );
        session.releaseLease = undefined;
      }
      session.cwd = ctx.cwd;
      session.context = ctx;
      planApproval.context = ctx;
      const config = await loadConfig();
      memory.enabled = config.memoryEnabled !== false;
      memory.reviewerConfigured = Boolean(config.memoryReviewer);
      recentCalls.clear();
      pendingMutations.clear();
      deniedToolCalls.clear();
      seenMutationMessages.clear();
      terminatingToolCalls.clear();
      verifyState.latest = (
        [...(ctx.sessionManager.getEntries?.() ?? [])]
          .reverse()
          .find(
            (entry: any) =>
              entry.type === "custom" &&
              entry.customType === "pi-verify-result" &&
              entry.data?.version === 1 &&
              entry.data.sessionId === sessionId,
          ) as any
      )?.data;
      const reg = await registerWorkspace(root, ctx.cwd);
      workspace = reg.workspace;
      all = reg.all;
      dir = reg.dir;
      workFile = join(dir, "sessions", sessionWorkFile(sessionId));
      if (!reuseSessionLease) {
        session.releaseLease = await startSessionGc(root, sessionId, live => pruneOrphanWorkFiles(root, live));
        session.id = sessionId;
      }
      session.ephemeral = !ctx.sessionManager.getSessionFile?.();
      const p = paths();
      work = await readJson<Work | undefined>(p.work, undefined, value => value === undefined || isWork(value));
      const handoff = [...(ctx.sessionManager.getEntries?.() ?? [])]
        .reverse()
        .find(
          (entry: any) =>
            entry.type === "custom" && entry.customType === HANDOFF_ENTRY_TYPE && isWork(entry.data?.work),
        ) as any;
      if (!work && handoff) {
        work = handoff.data.work;
        const requested = handoff.data.model;
        const model = requested && ctx.modelRegistry.find(requested.provider, requested.id);
        if (model && ctx.modelRegistry.hasConfiguredAuth(model)) await pi.setModel(model);
        if (thinkingLevels.includes(handoff.data.thinking)) pi.setThinkingLevel(handoff.data.thinking);
        await saveWork();
      }
      if (work && !work.issue && (work.latestFailure || work.nextAction)) {
        work.issue = { kind: "manual" };
        await saveWork();
      }
      if (work?.mode === "executing" && !work.currentTodoId) {
        const first = work.todos.find(todo => todo.status !== "done");
        if (first) {
          updateTodo(work, first.id, "in_progress");
          await saveWork();
        }
      }
      if (work?.mode === "planning" && work.todos.length) {
        let changed = false;
        if (!work.planSummary?.trim()) {
          work.planSummary = work.todos.map(todo => todo.text).join("; ") || work.goal;
          changed = true;
        }
        if (!work.planRevision) {
          work.planRevision = 1;
          changed = true;
        }
        if ((work.offeredPlanRevision ?? 0) < work.planRevision)
          planApproval.pending = { runId: work.runId, revision: work.planRevision };
        if (changed) await saveWork();
      }
      project = await resolveProject(ctx.cwd);
      memory.state = memory.enabled
        ? await withStateLock(memoryDirectory(), async () => {
            const latest = await readMemory();
            let reconciled = discardExpiredReviews(latest);
            reconciled = await reassociateProjectMemory(reconciled);
            if (reconciled !== latest) await writeMemory(reconciled);
            return reconciled;
          })
        : emptyMemoryState();
      memory.notes = memory.state.notes;
      memory.taskGeneration++;
      memory.ledger = restoreMemoryLedger(ctx.sessionManager.getBranch?.() ?? [], sessionId, memory.taskGeneration);
      pruneMemoryLedger();
      memory.reviewCalledThisTask = false;
      memory.proposalToken = undefined;
      const startupIdentity = await worktreeFingerprint(ctx.cwd),
        startupChanges = await currentChangedPaths(ctx.cwd);
      verifyState.needed =
        work?.mode === "executing" &&
        (startupChanges === undefined || startupChanges.size > 0) &&
        !(
          verifyState.latest?.sessionId === sessionId &&
          (verifyState.latest.state === "stale" ||
            (verifyState.latest.state === "passed" && verifyState.latest.worktreeId === startupIdentity))
        );
      if (memory.enabled) {
        try {
          const migration = await runV4Migration(ctx, sessionId);
          if (migration.migrated) emitMemoryOutcome("migration_committed");
        } catch (error: any) {
          emitMemoryOutcome("migration_failed");
          const reason = error?.message ?? "automatic migration unavailable";
          await recordPendingV4Migration(root, reason).catch(() => {});
          if (!/Memory Reviewer/.test(reason)) ctx.ui?.notify?.(`Memory V4 migration deferred: ${reason}`, "warning");
        }
        memory.legacyMigrationAvailable = await hasPendingV4Migration(root);
      } else memory.legacyMigrationAvailable = false;
      gate(work?.mode === "planning");
      tasksVisible = true;
      refresh(ctx);
      publishState();
      if (work?.approval)
        queueMicrotask(
          () =>
            void planApproval
              .resume(ctx)
              .catch((error: any) =>
                ctx.ui?.notify?.(`Plan approval recovery is pending: ${error?.message ?? String(error)}`, "warning"),
              ),
        );
    }),
  );
  pi.on("session_shutdown", async () =>
    withMemoryLifecycle(async () => {
      if (memory.enabled) persistMemoryLedger();
      abandonAutomaticCompaction();
      session.generation++;
      session.context = undefined;
      terminatingToolCalls.clear();
      memory.legacyMigrationAvailable = false;
      planApproval.pending = undefined;
      planApproval.context = undefined;
      planApproval.selection = undefined;
      publishState(false);
      disposeStateRequest();
      disposeMemoryMutation();
      planApproval.dispose();
      disposeInstanceClaim();
      disposeVerify();
      disposeHeartbeat();
      disposeWorktreeChange();
      disposePackageMutation();
      disposeGuardDecision();
      disposeCompactionCancel();
      disposeRuntimePolicy?.();
      pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-continuity" });
      await session.releaseLease?.(session.ephemeral && workFile ? () => rm(workFile, { force: true }) : undefined);
      session.releaseLease = undefined;
      session.id = "";
    }),
  );
  pi.on("agent_start", async (_e, ctx) => {
    awaitingClarificationProse = false;
    terminatingToolCalls.clear();
    if (work?.mode === "executing" && work.approval) {
      delete work.approval;
      work.updatedAt = new Date().toISOString();
      await saveWork();
    }
    tasksVisible ? refresh(ctx) : hideTasks(ctx);
  });
  pi.on("agent_end", () => {});
  pi.on("agent_settled", async (_e, ctx) => {
    tasksVisible = false;
    hideTasks(ctx);
    await settleMemoryReviews(ctx);
    planApproval.schedule(ctx);
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message as any;
    const request = automaticCompaction;
    const compactionInterruption =
      request &&
      message.role === "assistant" &&
      (message.stopReason === "aborted" ||
        (message.stopReason === "error" &&
          typeof message.errorMessage === "string" &&
          COMPACTION_ABORT_ERROR.test(message.errorMessage.trim())));
    if (compactionInterruption) {
      return {
        message: {
          ...message,
          stopReason: "aborted",
          diagnostics: [
            ...(Array.isArray(message.diagnostics) ? message.diagnostics : []),
            {
              type: COMPACTION_INTERRUPTION_DIAGNOSTIC,
              timestamp: Date.now(),
              details: { version: 1, requestId: request.id, sessionId: request.sessionId },
            },
          ],
        },
      };
    }
    if (
      message.role !== "assistant" ||
      message.stopReason !== "stop" ||
      !readyForAutomaticCompletion() ||
      !Array.isArray(message.content) ||
      message.content.some((part: any) => part?.type === "toolCall") ||
      !message.content.some((part: any) => part?.type === "text" && part.text.trim())
    )
      return;
    await completeWork(ctx);
  });
  pi.on("tool_call", async (event, ctx) => {
    if (awaitingClarificationProse && work?.mode === "executing")
      return {
        block: true,
        reason: "Ask the pending clarification in prose and stop. Do not call more tools until the user answers.",
      };
    if (hasUnsafeClarificationBatch(ctx))
      return { block: true, reason: "Clarification must be the only tool call at a safe checkpoint. Retry it alone." };
    if (blocked(work?.mode === "planning", event.toolName))
      return { block: true, reason: "Plan mode is read-only. Approve or cancel plan first." };
    const input = (event.input ?? {}) as { action?: string; completion?: boolean };
    if (work?.mode === "planning" && event.toolName === "memory" && input.action !== "list")
      return { block: true, reason: "Plan mode is read-only. Memory mutations are blocked; use memory list only." };
    if (memory.enabled && memory.activationEnabled && project) {
      const rawPath =
        typeof (event.input as any)?.path === "string"
          ? String((event.input as any).path)
              .replace(/^@/, "")
              .replace(/\\/g, "/")
          : undefined;
      const rawCommand =
        event.toolName === "bash" && typeof (event.input as any)?.command === "string"
          ? sanitizeAndClip((event.input as any).command, 500).slice(0, 500)
          : undefined;
      processProspectiveMemory(
        eventFrame({
          kind: "before_tool_call",
          ledger: memory.ledger,
          repository: project.owner,
          taskPhase: work?.mode ?? "idle",
          toolCallId: event.toolCallId,
          facts: {
            "tool.name": event.toolName,
            ...(rawCommand ? { "tool.command": rawCommand } : {}),
            ...(rawPath ? { "file.path": rawPath } : {}),
            "attempt.count": 1,
          },
        }),
      );
    }
    if ((event.toolName === "bash" && !sharedWorktreeObserver) || event.toolName === "grunt")
      pendingMutations.set(event.toolCallId, await worktreeFingerprint(ctx.cwd));
  });
  pi.on("tool_execution_end", event => {
    if ((event.result as any)?.terminate === true) terminatingToolCalls.add(event.toolCallId);
    else terminatingToolCalls.delete(event.toolCallId);
  });
  pi.on("tool_result", async (event, ctx) => {
    if (deniedToolCalls.delete(event.toolCallId)) {
      pendingMutations.delete(event.toolCallId);
      return;
    }
    let observedMutation = event.toolName === "bash" && sharedWorktreeObserver;
    if ((event.toolName === "bash" && !sharedWorktreeObserver) || event.toolName === "grunt") {
      const before = pendingMutations.get(event.toolCallId);
      pendingMutations.delete(event.toolCallId);
      const after = await worktreeFingerprint(ctx.cwd);
      observedMutation = !before || !after || before !== after;
      if (observedMutation) invalidateVerification();
    } else if (["write", "edit", "heartbeat_start"].includes(event.toolName)) {
      observedMutation = true;
      invalidateVerification();
    }
    if (memory.enabled && memory.activationEnabled && project && event.isError !== true && observedMutation)
      await refreshMemoryCompilation(memory.state, false);
    if (memory.enabled && memory.activationEnabled && project) {
      const content = Array.isArray(event.content)
        ? event.content
            .filter((part: any) => part?.type === "text" && typeof part.text === "string")
            .map((part: any) => part.text)
            .join("\n")
            .slice(0, 8_000)
        : "";
      const signature = content.match(/\b(?:E[A-Z]{3,}|[A-Z][A-Z0-9_]{4,})\b/)?.[0];
      const rawPath =
        typeof (event.input as any)?.path === "string"
          ? String((event.input as any).path)
              .replace(/^@/, "")
              .replace(/\\/g, "/")
          : undefined;
      const rawCommand =
        event.toolName === "bash" && typeof (event.input as any)?.command === "string"
          ? sanitizeAndClip((event.input as any).command, 500).slice(0, 500)
          : undefined;
      processProspectiveMemory(
        eventFrame({
          kind: "after_tool_result",
          ledger: memory.ledger,
          repository: project.owner,
          taskPhase: work?.mode ?? "idle",
          toolCallId: event.toolCallId,
          facts: {
            "tool.name": event.toolName,
            ...(rawCommand ? { "tool.command": rawCommand } : {}),
            "tool.isError": event.isError === true,
            ...((event.details as any)?.exitCode !== undefined
              ? { "tool.exitCode": Number((event.details as any).exitCode) }
              : {}),
            ...(signature ? { "tool.errorSignature": signature } : {}),
            ...(rawPath ? { "file.path": rawPath } : {}),
          },
        }),
      );
    }
  });
  pi.on("input", event => {
    if (event.source !== "extension") {
      abandonAutomaticCompaction();
      lastPrompt = event.text;
      memory.taskGeneration++;
      memory.ledger = { ...memory.ledger, taskGeneration: memory.taskGeneration };
      memory.reviewCalledThisTask = false;
      if (memory.enabled && memory.activationEnabled && project)
        processProspectiveMemory(
          eventFrame({
            kind: "task_started",
            ledger: memory.ledger,
            repository: project.owner,
            taskPhase: work?.mode ?? "idle",
          }),
        );
    }
  });
  pi.on("turn_end", (event, ctx) => {
    const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
    const hasToolCalls =
      Array.isArray((event.message as any)?.content) &&
      (event.message as any).content.some((part: any) => part?.type === "toolCall");
    if (!toolResults.length || !hasToolCalls) return;
    const allTerminating = toolResults.every((result: any) => terminatingToolCalls.has(result.toolCallId));
    for (const result of toolResults as any[]) terminatingToolCalls.delete(result.toolCallId);
    if (allTerminating || ctx.signal?.aborted || ctx.hasPendingMessages()) {
      abandonAutomaticCompaction();
      return;
    }
    if (automaticCompaction) return;

    const usage = ctx.getContextUsage();
    if (
      usage?.tokens == null ||
      !Number.isFinite(usage.tokens) ||
      !Number.isFinite(usage.contextWindow) ||
      usage.contextWindow <= 0
    )
      return;
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted?.() ?? false,
    }).getCompactionSettings();
    if (!settings.enabled || usage.tokens <= usage.contextWindow - settings.reserveTokens) return;

    const request: CompactionContinuationRequest = {
      id: randomUUID(),
      sessionGeneration: session.generation,
      taskGeneration: memory.taskGeneration,
      sessionId: ctx.sessionManager.getSessionId(),
    };
    automaticCompaction = request;
    emitCompactionContinuation("begin", request);
    try {
      ctx.compact({
        onComplete: () => {
          if (automaticCompaction !== request) return;
          if (
            session.generation !== request.sessionGeneration ||
            memory.taskGeneration !== request.taskGeneration ||
            ctx.sessionManager.getSessionId() !== request.sessionId ||
            !ctx.isIdle() ||
            ctx.hasPendingMessages()
          ) {
            abandonAutomaticCompaction(request);
            return;
          }
          emitCompactionContinuation("resume", request);
          if (automaticCompaction !== request) return;
          try {
            pi.sendMessage(
              {
                customType: "pi-continuity-resume",
                content:
                  "Continue the unfinished task from the compaction checkpoint. Do not repeat completed work or wait for another user prompt.",
                display: false,
                details: { version: 1, reason: "mid-task-compaction", requestId: request.id },
              },
              { triggerTurn: true },
            );
            automaticCompaction = undefined;
          } catch {
            abandonAutomaticCompaction(request);
          }
        },
        onError: () => abandonAutomaticCompaction(request),
      });
    } catch {
      abandonAutomaticCompaction(request);
    }
  });
  const activeWork = () => (work && !["handed_off", "completed", "cancelled"].includes(work.mode) ? work : undefined);
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
      const identity = active && verifyState.latest ? await worktreeFingerprint(session.cwd) : undefined;
      const verification = identity && verifyState.latest?.worktreeId === identity ? verifyState.latest : undefined;
      const config = await loadConfig();
      const preparation = {
        ...event.preparation,
        settings: {
          ...event.preparation.settings,
          keepRecentTokens: config.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
        },
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
            safePaths: draft.safePaths,
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
              sessionId: session.id,
              timeoutMs: compactionReviewTimeoutMs(config.compactionReviewTimeoutMs),
              maxOutputTokens: compactionReviewerMaxOutputTokens(config.compactionReviewerMaxOutputTokens),
              signal: event.signal,
            });
            additions = reviewed.supplements;
            pi.events.emit("pi-continuity:compaction-review-telemetry", {
              version: 1,
              outcome: "reviewed",
              ...reviewed.telemetry,
            });
          } else if (focus) {
            ctx.ui?.notify?.(
              "Compaction used deterministic output; no discarded transcript was available for review.",
              "warning",
            );
          }
        } catch (error: any) {
          if (event.signal?.aborted) throw error;
          pi.events.emit("pi-continuity:compaction-review-telemetry", {
            version: 1,
            outcome: "failed",
            model: profile.model,
          });
          if (focus)
            ctx.ui?.notify?.(
              "Compaction reviewer failed; deterministic output was used without review focus.",
              "warning",
            );
        }
      }
      if (event.signal?.aborted) return { cancel: true };
      return {
        compaction: finalizeContinuityCompaction(
          draft.canonical,
          [...draft.priorSupplements, ...additions],
          draft.safePaths,
        ),
      };
    } catch {
      if (!event.signal?.aborted)
        ctx.ui?.notify?.("Compaction cancelled because Continuity could not produce deterministic output.", "error");
      return { cancel: true };
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    if (!memory.enabled || !memory.activationEnabled) return;
    memory.taskGeneration++;
    memory.ledger = restoreMemoryLedger(ctx.sessionManager.getBranch?.() ?? [], session.id, memory.taskGeneration);
    pruneMemoryLedger();
  });
  pi.on("session_compact", () => {
    if (!memory.enabled || !memory.activationEnabled) return;
    memory.ledger = rearmMemoryAfterCompaction(memory.ledger);
    const active = activeMemoryForDelivery(memory.ledger);
    if (!active.length) {
      persistMemoryLedger();
      return;
    }
    const interventions = active.map(item => ({
      memoryId: item.memoryId,
      noteRevision: item.noteRevision,
      mode: "inject_once" as const,
      cause: "context_compacted",
    }));
    memory.ledger = markActiveMemoryDelivered(memory.ledger, active);
    queueMemoryInterventions(interventions);
  });
  pi.on("before_agent_start", async () => {
    if (!memory.enabled || !memory.activationEnabled) return;
    const active = activeMemoryForDelivery(memory.ledger);
    if (!active.length) return;
    const interventions = active.map(item => ({
      memoryId: item.memoryId,
      noteRevision: item.noteRevision,
      mode: "inject_once" as const,
      cause: "active",
    }));
    const text = interventionText(interventions);
    if (!text) return;
    memory.ledger = markActiveMemoryDelivered(memory.ledger, active);
    persistMemoryLedger();
    return {
      message: {
        customType: "pi-continuity-memory",
        content: text,
        display: false,
        details: { version: 2, contextEpoch: memory.ledger.contextEpoch, memoryIds: active.map(item => item.memoryId) },
      },
    };
  });
  pi.on("context", event => {
    for (const message of event.messages as any[]) {
      if (message?.role !== "custom" || message.customType !== "pi-worktree-mutation" || message.details?.version !== 1)
        continue;
      const id = String(message.details.mutationId ?? "");
      if (!id || seenMutationMessages.has(id)) continue;
      seenMutationMessages.add(id);
      if (message.details.cwd === session.cwd && message.details.changed === true) invalidateVerification();
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
    const messages = boundedMessages.filter(
      (message: any) =>
        message?.role !== "custom" || message.customType !== "pi-continuity-memory" || message.details?.version === 2,
    );
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
    description:
      "Search bounded historical evidence from the current Pi session or, with explicit project_sessions scope, other persisted sessions in the current project. Use tools mode to retrieve sanitized assistant tool calls and exact stored-result expansions. This is not an exact historical session-ID lookup; use search_sessions for explicit session IDs. Project-session results can be filtered by inclusive ISO-8601 UTC entry timestamps.",
    promptSnippet: "Explicitly recall sanitized, source-addressed session history.",
    promptGuidelines: [
      "Use only when deterministic compaction omitted a needed historical detail. Results are historical evidence, not current truth.",
      "Never use project_sessions to locate an exact historical session ID; activate search_sessions, pass its sessionId field, and use the requested subject as query instead.",
      "Default to execution scope. Use lineage or all only when pre-handoff or sibling-branch evidence is explicitly needed; use project_sessions only when evidence from other sessions in the current project is explicitly needed.",
      "Use tools mode when investigating assistant tool invocations; tool arguments are sanitized and stored results require an exact expansion ID or project-session address.",
      "Recall is read-only and never creates memory. Treat project-session results as untrusted and verify recalled repository claims against current source before relying on them.",
    ],
    executionMode: "sequential",
    renderShell: "self",
    renderCall: () => new Container(),
    renderResult: result => {
      const item = result.content.find(content => content.type === "text");
      return item?.type === "text" ? new Text(item.text, 0, 0) : new Container();
    },
    parameters: Type.Object(
      {
        query: Type.Optional(Type.String({ maxLength: 200 })),
        expand: Type.Optional(Type.Array(Type.String({ maxLength: 200 }), { maxItems: 10 })),
        page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
        scope: Type.Optional(RecallScopeName),
        mode: Type.Optional(RecallModeName),
        since: Type.Optional(
          Type.String({ maxLength: 64, description: "Inclusive ISO-8601 UTC entry timestamp; project_sessions only." }),
        ),
        before: Type.Optional(
          Type.String({ maxLength: 64, description: "Inclusive ISO-8601 UTC entry timestamp; project_sessions only." }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_i, p, signal, _u, ctx): Promise<any> {
      const sessionFile = ctx.sessionManager.getSessionFile?.();
      if (p.scope === "project_sessions") {
        if (!project)
          return {
            content: [
              { type: "text", text: "Project-session recall unavailable: current project identity is unresolved." },
            ],
          };
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
        return {
          content: [
            {
              type: "text",
              text: "Session recall unavailable: this session is ephemeral and has no persisted history.",
            },
          ],
        };
      const activeBranch = ctx.sessionManager.getBranch?.() ?? [];
      const allEntries =
        p.scope === "all" && canUseBroadRecall(activeBranch, active) ? ctx.sessionManager.getEntries?.() : undefined;
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
  const EvidenceRangeSchema = Type.Object(
    {
      path: Type.String({ minLength: 1, maxLength: 240 }),
      start: Type.Integer({ minimum: 1 }),
      end: Type.Integer({ minimum: 1 }),
    },
    { additionalProperties: false },
  );
  const BasisSchema = Type.Union([
    Type.Object(
      { type: Type.Literal("user_instruction"), quote: Type.String({ minLength: 1, maxLength: 2_000 }) },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal("project_contract"),
        evidence: Type.Array(EvidenceRangeSchema, { minItems: 1, maxItems: 3 }),
      },
      { additionalProperties: false },
    ),
  ]);
  const ProposalSchema = Type.Union([
    Type.Object(
      {
        operation: Type.Literal("add"),
        scope: ScopeName,
        trigger: Type.String({ minLength: 1, maxLength: 240 }),
        guidance: Type.String({ minLength: 1, maxLength: 800 }),
        basis: BasisSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        operation: Type.Literal("replace"),
        scope: ScopeName,
        targetId: Type.String({ minLength: 36, maxLength: 36 }),
        expectedRevision: Type.Integer({ minimum: 1 }),
        trigger: Type.String({ minLength: 1, maxLength: 240 }),
        guidance: Type.String({ minLength: 1, maxLength: 800 }),
        basis: BasisSchema,
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        operation: Type.Literal("remove"),
        scope: ScopeName,
        targetId: Type.String({ minLength: 36, maxLength: 36 }),
        expectedRevision: Type.Integer({ minimum: 1 }),
        reason: Type.String({ minLength: 1, maxLength: 500 }),
        basis: BasisSchema,
      },
      { additionalProperties: false },
    ),
  ]);
  const memoryFailure = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    details: { memoryError: true },
  });

  const listMemoryNotes = async (query: string | undefined, ctx: any) => {
    const resolved = await resolveProject(ctx.cwd);
    memory.state = await readMemory();
    memory.notes = memory.state.notes;
    const owned = notesForOwners(memory.notes, resolved.owner);
    const shown = query?.trim() ? shortlistNotes(owned, query, undefined, 100) : owned;
    const pending = memory.state.reviews.filter(
      review => review.sessionId === session.id && review.status === "approved_pending",
    );
    const text =
      !shown.length && !pending.length
        ? "No current-owner notebook notes or pending reviewed operations."
        : [
            ...shown.map(
              note =>
                `- ${note.scope}/${note.id} r${note.revision} [${note.authority}/${note.origin}] When ${note.trigger}: ${note.guidance}`,
            ),
            ...pending.map(
              review => `- pending review ${review.reviewId}: ${review.operations.length} approved operation(s)`,
            ),
          ].join("\n");
    return {
      content: [{ type: "text", text }],
      details: {
        memoryList: true,
        notes: shown.map(note => ({
          id: note.id,
          revision: note.revision,
          scope: note.scope,
          trigger: note.trigger,
          guidance: note.guidance,
          state: note.disposition,
        })),
      },
    };
  };

  /** Reviewer evidence is re-read after the review: a file that changed mid-review invalidates the whole batch. */
  const assertEvidenceUnchanged = async (cwd: string, proposals: PreflightProposal[]) => {
    for (const prepared of proposals) {
      if (!prepared.evidence) continue;
      const fresh = await captureEvidenceRanges(
        cwd,
        prepared.proposal.basis.type === "project_contract" ? prepared.proposal.basis.evidence : [],
      );
      if (fresh.some((item, index) => item.excerptSha256 !== prepared.evidence![index]?.excerptSha256))
        throw Error("memory evidence changed during review");
    }
  };

  const stageReviewedRecord = async (
    record: ReviewRecord,
    context: { generation: number; task: number; session: string; cwd: string; owner: string },
  ) => {
    // The reviewer ran unlocked; a task, session, project, or cwd change since then invalidates its verdicts.
    const stale = () =>
      context.generation !== session.generation ||
      context.task !== memory.taskGeneration ||
      context.session !== session.id ||
      context.cwd !== session.cwd ||
      project?.owner !== context.owner;
    await withMemoryLifecycle(() =>
      withStateLock(memoryDirectory(), async () => {
        if (stale()) throw Error("memory review became stale after a task or session change");
        const latest = await readMemory();
        assertStageable(latest, record);
        const next = stageReview(latest, record);
        if (stale()) throw Error("memory review became stale before staging");
        await writeMemory(next);
        memory.state = next;
        memory.notes = next.notes;
      }),
    );
  };
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "List or query durable notebook notes, or submit up to two grounded proposals for immediate Memory Reviewer editing.",
    promptSnippet: "Inspect durable notes or propose bounded reviewer-gated changes.",
    executionMode: "sequential",
    renderShell: "self",
    renderCall: () => new Container(),
    promptGuidelines: [
      "At the end of each task, explicitly check whether the user stated a durable preference or instruction, or the repository revealed an intentional, recurring project convention or contract. If concrete evidence could plausibly help a future session, prefer proposing it over silently skipping it; do not require certainty because the Memory Reviewer may accept, rewrite, merge, defer, or reject. Never propose progress, implementation summaries, guesses, generic advice, one-off details, duplicates, or secrets.",
      "Use memory list first when duplication is uncertain. Submit at most two proposals in one call. User scope requires an exact quote from the current active branch; project contracts require at most three exact repository ranges totaling at most 120 lines.",
    ],
    renderResult: (result, _options, theme) => {
      const item = result.content.find(content => content.type === "text"),
        value = item?.type === "text" ? item.text : "";
      return new Text((result.details as any)?.memoryError ? theme.fg("warning", `⚠ ${value}`) : value, 0, 0);
    },
    parameters: Type.Object(
      {
        action: MemAction,
        query: Type.Optional(Type.String({ maxLength: 500 })),
        proposals: Type.Optional(Type.Array(ProposalSchema, { minItems: 1, maxItems: 2 })),
      },
      { additionalProperties: false },
    ),
    async execute(id, p, signal, _onUpdate, ctx): Promise<any> {
      if (!memory.enabled) return memoryFailure("Continuity memory is disabled in package settings.");
      if (p.action === "list") return listMemoryNotes(p.query, ctx);
      if (memory.reviewCalledThisTask || memory.proposalToken)
        return memoryFailure("Only one memory proposal call is allowed per task.");
      const reservationToken = randomUUID();
      memory.proposalToken = reservationToken;
      const proposalTask = memory.taskGeneration,
        proposalGeneration = session.generation,
        proposalSession = session.id,
        proposalCwd = ctx.cwd;
      let reviewerInvoked = false,
        proposalCompleted = false;
      try {
        const resolved = await resolveProject(proposalCwd),
          config = await loadConfig(),
          profile = config.memoryReviewer;
        if (!profile) return memoryFailure("Memory Reviewer unavailable: configure a dedicated reviewer model.");
        const model = await configuredModel(ctx, profile);
        if (!model)
          return memoryFailure("Memory Reviewer unavailable: configured model or credentials are unavailable.");
        const state = await readMemory();
        const preflight = await preflightMemoryProposals({
          rawProposals: p.proposals,
          state,
          cwd: proposalCwd,
          activeBranch: ctx.sessionManager.getBranch?.() ?? [],
          sessionId: proposalSession,
          projectOwner: resolved.owner,
        });
        const covered = preflight.proposals
          .map((proposal, proposalIndex) =>
            proposal.coveredBy ? { proposalIndex, note: proposal.coveredBy } : undefined,
          )
          .filter((item): item is { proposalIndex: number; note: NotebookNote } => Boolean(item));
        if (covered.length === preflight.proposals.length) {
          proposalCompleted = memory.reviewCalledThisTask = true;
          return {
            content: [
              {
                type: "text",
                text: `Memory review:\n${covered.map(item => `- already covered by ${item.note.scope}/${item.note.id}: proposal ${item.proposalIndex + 1}`).join("\n")}`,
              },
            ],
            details: {
              memoryReview: true,
              outcomes: covered.map(item => ({
                proposalIndex: item.proposalIndex,
                status: "covered",
                reasonCodes: ["duplicate"],
                memoryId: item.note.id,
              })),
            },
          };
        }
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey)
          return memoryFailure("Memory Reviewer unavailable: configured model has no credentials.");
        reviewerInvoked = true;
        const reviewed = await callMemoryReviewer({
          model,
          auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
          profile,
          prompt: continuityPrompt(config.prompt),
          packet: preflight.packet,
          sessionId: proposalSession,
          signal,
        });
        const record = reviewedRecord({
          decisions: reviewed.decisions,
          preflight: preflight.proposals,
          packet: preflight.packet,
          sessionId: proposalSession,
          toolCallId: id,
          generation: proposalGeneration,
          taskGeneration: proposalTask,
        });
        proposalCompleted = memory.reviewCalledThisTask = true;
        await assertEvidenceUnchanged(proposalCwd, preflight.proposals);
        await stageReviewedRecord(record, {
          generation: proposalGeneration,
          task: proposalTask,
          session: proposalSession,
          cwd: proposalCwd,
          owner: resolved.owner,
        });
        emitMemoryOutcome("staged");
        pi.events.emit("pi-continuity:memory-review-telemetry", {
          version: 1,
          ...reviewed.telemetry,
          proposalCount: preflight.proposals.length,
          verdicts: reviewed.decisions.map(decision => decision.verdict),
        });
        const { lines, outcomes } = formatReviewOutcome(reviewed.decisions, preflight.proposals, record);
        return {
          content: [{ type: "text", text: `Memory review:\n${lines.join("\n")}` }],
          details: { memoryReview: true, reviewId: record.reviewId, outcomes },
        };
      } catch (error: any) {
        emitMemoryOutcome(reviewerInvoked ? "reviewer_failed" : "preflight_rejected");
        return memoryFailure(error?.message ?? "Memory review failed; nothing was staged.");
      } finally {
        if (memory.proposalToken === reservationToken) memory.proposalToken = undefined;
        if (!proposalCompleted && memory.taskGeneration === proposalTask) memory.reviewCalledThisTask = false;
      }
    },
  });
  const continuityUpdateSchema = Type.Object(
    {
      action: Action,
      question: Type.Optional(
        Type.String({
          maxLength: 500,
          description:
            "One concrete decision in plain language. Include one short sentence of decision-relevant context only when needed.",
        }),
      ),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            label: Type.String({
              maxLength: 120,
              description: "Short, distinct answer label. Put the recommended option first.",
            }),
            description: Type.Optional(
              Type.String({
                maxLength: 240,
                description:
                  "Practical outcome or tradeoff; for the recommended option, include why it is recommended.",
              }),
            ),
          }),
        ),
      ),
      questions: Type.Optional(
        Type.Array(
          Type.Object({
            question: Type.String({ maxLength: 500 }),
            options: Type.Array(
              Type.Object({
                label: Type.String({ maxLength: 120 }),
                description: Type.Optional(Type.String({ maxLength: 240 })),
              }),
              { minItems: 2, maxItems: 4 },
            ),
          }),
          { minItems: 2, maxItems: 6 },
        ),
      ),
      goal: Type.Optional(Type.String({ maxLength: 2000 })),
      constraints: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 12 })),
      planSummary: Type.Optional(Type.String({ maxLength: 4000 })),
      workingSet: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 20 })),
      assumptions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 })),
      acceptanceCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 })),
      todos: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 12 })),
      planTodos: Type.Optional(
        Type.Array(
          Type.Object(
            {
              id: Type.Optional(
                Type.String({
                  maxLength: 120,
                  description: "Omit when creating a plan; on revisions, use only an exact ID from the current plan.",
                }),
              ),
              text: Type.String({ minLength: 1, maxLength: 120 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 12 },
        ),
      ),
      todoId: Type.Optional(Type.String({ description: "Exact todo ID shown in Continuity context, such as todo_1" })),
      todoIds: Type.Optional(
        Type.Array(Type.String(), {
          minItems: 1,
          maxItems: 12,
          description: "Complete these independent todo IDs together. Bulk updates only support status done.",
        }),
      ),
      nextTodoId: Type.Optional(
        Type.String({ description: "Pending todo to start atomically when marking current todo done" }),
      ),
      status: Type.Optional(Status),
      currentTodoId: Type.Optional(
        Type.String({
          description:
            "Used only by action state; ignored by set_plan, which generates todo IDs and normally starts the first todo when execution begins.",
        }),
      ),
      latestFailure: Type.Optional(Type.String({ maxLength: 1000 })),
      nextAction: Type.Optional(Type.String({ maxLength: 1000 })),
      allowUnverified: Type.Optional(
        Type.Boolean({
          description:
            "Acknowledge clean or no_checks in a tool-only state update; disclose the limitation in the final response.",
        }),
      ),
    },
    { additionalProperties: false },
  );

  type ContinuityUpdateParams = Static<typeof continuityUpdateSchema> & { completion?: boolean };
  const reply = (text: string, extras: Record<string, unknown> = {}) => ({
    content: [{ type: "text", text }],
    ...extras,
  });

  /** Cross-cutting argument checks; returns the refusal text, or undefined when the call is well-formed. */
  const rejectedCall = (p: ContinuityUpdateParams) => {
    if (p.allowUnverified && p.action !== "state") return 'allowUnverified requires action "state".';
    if (p.action !== "state") return undefined;
    const todoFields = (["todoId", "todoIds", "status", "nextTodoId"] as const).filter(field => p[field] !== undefined);
    return todoFields.length
      ? `${todoFields.join(", ")} require action \"todo\"; complete todos before updating state.`
      : undefined;
  };

  const handleClarify = async (p: ContinuityUpdateParams, ctx: any) => {
    const executing = work?.mode === "executing";
    if (p.questions !== undefined && (p.question !== undefined || p.options !== undefined))
      throw Error("Use either questions or question/options, not both.");
    const questions = p.questions ?? [{ question: p.question || "", options: p.options || [] }];
    validateQuestions(questions);
    if (
      process.env.PI_SPAWN_AUTONOMOUS === "1" &&
      (process.env.PI_SPAWN_CHILD === "agent" || process.env.PI_SPAWN_CHILD === "session")
    )
      return reply(
        "No interactive answer is available in this autonomous spawned thread. Reassess every question and all listed options using the available context, choose any justified option, state the assumptions you made, and continue the task.",
        { details: { autonomousClarification: true } },
      );
    if (!ctx.hasUI) {
      if (executing) awaitingClarificationProse = true;
      const prose = questions
        .map((item, questionIndex) => {
          const options = item.options.map(
            (option, optionIndex) =>
              `${optionIndex + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
          );
          return questions.length === 1
            ? `${item.question}\n${options.join("\n")}`
            : `Question ${questionIndex + 1}: ${item.question}\n${options.join("\n")}`;
        })
        .join("\n\n");
      return reply(`Ask user in prose and wait: ${prose}`);
    }
    const answers = await askQuestionnaire(ctx.ui, ctx.mode, questions, clarifyDialogOptions());
    if (!answers) {
      if (!executing) return reply("No answers submitted.");
      ctx.abort();
      return reply("No answers submitted. Execution stopped.", { terminate: true });
    }
    if (questions.length === 1) {
      const [answer] = answers;
      return reply(
        `${answer.answer}\n\nThe user answered the clarification. Continue the current task now without waiting for another user message.`,
        { details: { clarification: answer } },
      );
    }
    return reply(
      `${answers.map((answer, index) => `${index + 1}. ${answer.question}\nAnswer: ${answer.answer}`).join("\n")}\n\nThe user answered the clarifications. Continue the current task now without waiting for another user message.`,
      { details: { clarifications: answers } },
    );
  };

  const handleSetPlan = async (p: ContinuityUpdateParams, ctx: any) => {
    const planning = work?.mode === "planning";
    if (p.todos !== undefined && p.planTodos !== undefined) throw Error("Use either todos or planTodos, not both.");
    const planItems = p.planTodos ?? (p.todos || []).map(text => ({ text }));
    const todos = planItems.map(todo => ({ ...todo, text: todo.text.trim() })).filter(todo => todo.text);
    if (!todos.length) return reply("At least one non-empty todo is required.");
    if (!work || work.mode === "completed" || work.mode === "cancelled") {
      work = fresh(p.goal?.trim() || lastPrompt);
      work.mode = "executing";
      work.approved = true;
    }
    const now = new Date().toISOString();
    work.goal = p.goal?.trim() || work.goal;
    work.constraints = (p.constraints || [])
      .map(constraint => constraint.trim())
      .filter(Boolean)
      .slice(0, 12);
    work.planSummary = p.planSummary?.trim() || todos.map(todo => todo.text).join("; ") || work.goal;
    if (p.workingSet !== undefined || p.assumptions !== undefined || p.acceptanceCriteria !== undefined)
      work.handoff = {
        workingSet: (p.workingSet || [])
          .map(value => value.trim())
          .filter(Boolean)
          .slice(0, 20),
        assumptions: (p.assumptions || [])
          .map(value => value.trim())
          .filter(Boolean)
          .slice(0, 12),
        acceptanceCriteria: (p.acceptanceCriteria || [])
          .map(value => value.trim())
          .filter(Boolean)
          .slice(0, 12),
      };
    clearIssue(work);
    setPlan(work, todos, now);
    if (!planning && !work.currentTodoId) {
      const first = work.todos.find(todo => todo.status !== "done");
      if (first) updateTodo(work, first.id, "in_progress", now);
    }
    if (planning) {
      work.planRevision = (work.planRevision ?? 0) + 1;
      delete work.approval;
      delete work.revisionFeedback;
    }
    work.updatedAt = now;
    await saveWork();
    if (planning) planApproval.pending = { runId: work.runId, revision: work.planRevision! };
    tasksVisible = true;
    refresh(ctx);
    return reply(
      planning ? "Plan stored. Await explicit /plan approve." : "Executing task list stored.",
      planning ? { details: { plan: formatPlan(work) } } : {},
    );
  };

  /** Applies a single or bulk todo transition; returns the refusal text when the transition is invalid. */
  const applyTodoAction = (p: ContinuityUpdateParams, active: Work) => {
    const validIds = active.todos.map(todo => todo.id).join(", ") || "none";
    const invalid = `Unknown or invalid todo transition. Valid IDs: ${validIds}.`;
    const now = new Date().toISOString();
    const bulkIds = p.todoIds;
    // Validate every participant before changing work so rejected bulk calls are atomic.
    if (bulkIds) {
      const ids = new Set(bulkIds);
      const completed = bulkIds.map(id => active.todos.find(item => item.id === id));
      const next = p.nextTodoId && active.todos.find(item => item.id === p.nextTodoId);
      if (
        p.todoId !== undefined ||
        p.status !== "done" ||
        !bulkIds.length ||
        ids.size !== bulkIds.length ||
        completed.some(todo => !todo) ||
        (p.nextTodoId !== undefined && (!next || ids.has(p.nextTodoId) || next.status !== "pending"))
      )
        return invalid;
      for (const id of bulkIds) updateTodo(active, id, "done", now);
      if (next) updateTodo(active, next.id, "in_progress", now);
    } else {
      const todo = p.todoId && active.todos.find(item => item.id === p.todoId);
      const next = p.nextTodoId && active.todos.find(item => item.id === p.nextTodoId);
      if (
        !todo ||
        !p.status ||
        (p.nextTodoId && (p.status !== "done" || !next || next.id === todo.id || next.status !== "pending"))
      )
        return invalid;
      updateTodo(active, todo.id, p.status, now);
      if (next) updateTodo(active, next.id, "in_progress", now);
    }
    if (active.issue?.kind === "manual" && (bulkIds || p.status === "done" || p.status === "in_progress"))
      clearIssue(active);
    applyManualIssueUpdate(active, p.latestFailure, p.nextAction);
    return undefined;
  };

  /** Completion is the one state transition that settles the call itself; other updates fall through to the common save. */
  const handleCompletion = async (
    p: ContinuityUpdateParams,
    active: Work,
    ctx: any,
    legacyCompletionWithReply: boolean,
  ) => {
    const legacyTerminate = legacyCompletionWithReply ? { terminate: true } : {};
    if (active.mode === "completed")
      return reply("Work already completed. No further continuity updates needed.", { terminate: true });
    if (hasRemainingTodos(active)) return reply("Cannot complete while todos remain.", legacyTerminate);
    const acknowledgeable = ["clean", "no_checks"].includes(verifyState.latest?.state);
    if (verifyState.needed && verifyState.latest?.state !== "passed" && !(p.allowUnverified && acknowledgeable))
      return reply(
        acknowledgeable
          ? "Verification is unavailable for this worktree. Acknowledge allowUnverified in a tool-only state update after reviewing that limitation."
          : "Cannot complete until current-session verification passes.",
        legacyTerminate,
      );
    await completeWork(ctx);
    return reply("Work completed. No further continuity updates needed.", { terminate: true });
  };

  /** Returns a settled response, or undefined to fall through to the common save. */
  const handleState = async (p: ContinuityUpdateParams, active: Work, ctx: any, legacyCompletionWithReply: boolean) => {
    active.currentTodoId = p.currentTodoId ?? active.currentTodoId;
    applyManualIssueUpdate(active, p.latestFailure, p.nextAction);
    if (p.completion) return handleCompletion(p, active, ctx, legacyCompletionWithReply);
    if (!p.allowUnverified) return undefined;
    if (hasRemainingTodos(active)) return reply("Cannot acknowledge verification while todos remain.");
    if (!verifyState.needed) return reply("No verification acknowledgement is required.");
    if (!["clean", "no_checks"].includes(verifyState.latest?.state))
      return reply("allowUnverified requires a current clean or no_checks Verify result.");
    verifyState.needed = false;
    return undefined;
  };
  pi.registerTool({
    name: "continuity_update",
    label: "Continuity Update",
    description: "Update plan, todos, state, or clarification.",
    promptSnippet: "Planning, todo/state tracking, and clarification capability.",
    executionMode: "sequential",
    promptGuidelines: [
      "Use set_plan for explicit /plan; skip it for straightforward read-only work and one-shot local fixes. Prefer 2–4 outcome-level todos. planSummary is the compact executor handoff; add concrete paths/symbols, assumptions or gaps, and acceptance criteria in structured fields. Revise via planTodos IDs. Continuity owns plan presentation; otherwise use internal task list.",
      "Clarify only a blocking user decision, recommended option first, as the sole tool call at a safe checkpoint. Never re-ask an answered question without new evidence. Use IDs.",
      "Keep verification out of new todo lists; a sole verification-only todo completes automatically. Keep every Continuity update tool-only and before final text.",
      "Never call a completion tool. Write exactly one text-only final response. For clean/no_checks, acknowledge allowUnverified tool-only; disclose the limitation.",
      "After passed, stale, or cancelled Verify results, write one caveated text-only final response and stop without another tool call; stale does not require another Verify. After failed or error results caused by current changes, diagnose and repair them, then Verify again; report unrelated failures without modifying them.",
    ],
    renderShell: "self",
    renderCall: () => new Container(),
    renderResult: (result, _options, theme) => {
      const item = result.content.find(content => content.type === "text");
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
    parameters: continuityUpdateSchema,
    async execute(_i, input, _s, _u, ctx): Promise<any> {
      // Keep direct legacy callers working without advertising explicit completion to models.
      const p = input as ContinuityUpdateParams;
      const legacyCompletionWithReply = p.completion === true && hasReplyBeforeCompletion({ toolCallId: _i }, ctx);
      const rejection = rejectedCall(p);
      if (rejection) return reply(rejection);
      if (tripsCircuitBreaker(p)) {
        ctx.abort();
        return reply("Continuity circuit breaker stopped 3 identical calls within 30 seconds.", {
          details: { circuitBreaker: true },
          terminate: true,
        });
      }
      if (p.action === "clarify") return handleClarify(p, ctx);
      if (p.action === "set_plan") return handleSetPlan(p, ctx);
      if (!work) return reply("No active work.");
      if (p.action === "todo") {
        const refusal = applyTodoAction(p, work);
        if (refusal) return reply(refusal);
      } else if (p.action === "state") {
        const settled = await handleState(p, work, ctx, legacyCompletionWithReply);
        if (settled) return settled;
      }
      work.updatedAt = new Date().toISOString();
      await saveWork();
      refresh(ctx);
      return reply("Continuity state updated.");
    },
  });
  const approvalEntry = (ctx: any, customType: string, token: string) =>
    (ctx.sessionManager.getEntries?.() ?? []).find(
      (entry: any) =>
        entry.customType === customType &&
        (entry.data?.approvalToken === token || entry.details?.approvalToken === token),
    );
  const executionInstruction = "Execute the approved Continuity plan now.";
  const planDialogOptions = { timeout: 0 };
  planApproval.resume = async (ctx: any) => {
    const transition = work?.approval;
    if (!work || !transition || !["planning", "executing"].includes(work.mode)) return false;
    if (work.planRevision !== transition.revision) throw Error("Approval revision is stale.");
    const executor = ctx.modelRegistry.find(transition.executorModel.provider, transition.executorModel.id);
    if (!executor || !(await pi.setModel(executor))) throw Error("Executor model unavailable.");
    if (transition.thinking) pi.setThinkingLevel(transition.thinking as ThinkingLevel);
    const priorRunEntry = approvalEntry(ctx, RUN_ENTRY_TYPE, transition.token);
    const priorRun = isRunEntry(priorRunEntry?.data) ? priorRunEntry.data : undefined;
    const runId = work.runId ?? priorRun?.runId ?? randomUUID();
    const timelineId = work.timelineId ?? priorRun?.timelineId ?? runId;
    if (!priorRunEntry)
      pi.appendEntry(RUN_ENTRY_TYPE, {
        version: 1,
        runId,
        timelineId,
        role: "executor",
        parentSessionId: ctx.sessionManager.getSessionId(),
        approvalToken: transition.token,
        createdAt: transition.createdAt,
      } satisfies RunEntry);
    if (transition.resetContext && !approvalEntry(ctx, HANDOFF_ENTRY_TYPE, transition.token))
      pi.sendMessage(
        {
          customType: HANDOFF_ENTRY_TYPE,
          content: [
            "Continuity execution boundary. Earlier messages remain visible but are excluded from model context.",
            buildContext({ ...work, mode: "planning" }, [], "", 600),
          ]
            .filter(Boolean)
            .join("\n"),
          display: false,
          details: {
            version: 1,
            runId,
            timelineId,
            approvalToken: transition.token,
            model: transition.executorModel,
            ...(transition.thinking ? { thinking: transition.thinking } : {}),
          },
        },
        { triggerTurn: false },
      );
    work.mode = "executing";
    work.approved = true;
    work.runId = runId;
    work.timelineId = timelineId;
    work.updatedAt = new Date().toISOString();
    await saveWork();
    planApproval.pending = undefined;
    gate(false);
    tasksVisible = true;
    refresh(ctx);
    if (!approvalEntry(ctx, EXECUTION_ENTRY_TYPE, transition.token))
      pi.sendMessage(
        {
          customType: EXECUTION_ENTRY_TYPE,
          content: executionInstruction,
          display: false,
          details: { version: 1, approvalToken: transition.token, runId, timelineId },
        },
        { triggerTurn: true },
      );
    return true;
  };
  const approvePlan = (ctx: any, resetContext: boolean, expectedRevision?: number) =>
    withPlanMutation(async () => {
      if (!work?.planSummary || work.mode !== "planning" || !work.todos.length) {
        ctx.ui?.notify?.("No pending stored plan.", "error");
        return false;
      }
      if (expectedRevision !== undefined && work.planRevision !== expectedRevision)
        throw Error("Plan revision changed; refresh and review the latest plan.");
      if (work.approval) return planApproval.resume(ctx);
      if (work.revisionFeedback?.revision === work.planRevision)
        throw Error("Plan has requested changes; review the next revision before approval.");
      const config = await loadConfig();
      const executor = await configuredModel(ctx, config.executor, work.baseModel);
      if (!executor) {
        ctx.ui?.notify?.("Executor model unavailable.", "error");
        return false;
      }
      const now = new Date().toISOString();
      work.approval = {
        token: randomUUID(),
        revision: work.planRevision ?? 1,
        resetContext,
        executorModel: { provider: executor.provider, id: executor.id },
        ...((config.executor?.thinking ?? work.baseThinking)
          ? { thinking: config.executor?.thinking ?? work.baseThinking }
          : {}),
        createdAt: now,
      };
      work.updatedAt = now;
      await saveWork();
      return planApproval.resume(ctx);
    });
  const requestPlanChanges = (feedback: string, expectedRevision?: number) =>
    withPlanMutation(async () => {
      const text = feedback.trim();
      if (!work || work.mode !== "planning" || !work.planRevision || !text)
        throw Error("Plan feedback is unavailable or empty.");
      if (expectedRevision !== undefined && work.planRevision !== expectedRevision)
        throw Error("Plan revision changed; refresh and review the latest plan.");
      if (work.approval) throw Error("Plan approval is already pending.");
      work.revisionFeedback = {
        revision: work.planRevision,
        text: text.slice(0, 1_000),
        createdAt: new Date().toISOString(),
      };
      work.offeredPlanRevision = work.planRevision;
      work.updatedAt = new Date().toISOString();
      planApproval.pending = undefined;
      await saveWork();
      refresh(session.context);
      pi.sendUserMessage(`Plan changes requested for revision ${work.planRevision}:\n${work.revisionFeedback.text}`);
    });
  planApproval.dispose = pi.events.on("pi-continuity:plan-action", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    if (request.sessionId !== session.id || request.expectedGeneration !== session.generation || !session.context) {
      request.respond(Promise.reject(new Error("Continuity plan action is stale or belongs to another session")));
      return;
    }
    const operation =
      request.action === "approve"
        ? approvePlan(session.context, request.resetContext === true, request.expectedRevision)
        : request.action === "requestChanges" && typeof request.feedback === "string"
          ? requestPlanChanges(request.feedback, request.expectedRevision)
          : Promise.reject(new Error("Invalid Continuity plan action"));
    request.respond(operation);
  });
  const planCommand = {
    description: "Start, approve, cancel, review, or inspect a plan",
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "status";
      const usage =
        "Usage: /plan [status|start [goal]|approve|approve-current|changes <feedback>|cancel|review|help]";
      if (action === "help" && parts.length === 1) {
        ctx.ui.notify(usage, "info");
        return;
      }
      if (action === "review" && parts.length === 1) {
        if (!work?.runId) return void ctx.ui.notify("No active Pylon run.", "error");
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
        ctx.ui.notify("Implementation review started.", "info");
        return;
      }
      if (action === "approve-current" && parts.length === 1) {
        if (await approvePlan(ctx, false)) ctx.ui.notify("Plan approved using the current context.", "info");
        return;
      }
      if (action === "approve" && parts.length === 1) {
        if (await approvePlan(ctx, true)) ctx.ui.notify("Plan approved with a fresh execution context.", "info");
        return;
      }
      if (action === "cancel" && parts.length === 1) {
        if (!work) {
          ctx.ui.notify("No active plan to cancel.", "warning");
          return;
        }
        planApproval.pending = undefined;
        work.mode = "cancelled";
        delete work.approval;
        await saveWork();
        gate(false);
        refresh(ctx);
        ctx.ui.notify("Plan cancelled. Execution tools restored.", "info");
        return;
      }
      if (action === "changes") {
        const feedback = parts.slice(1).join(" ").trim();
        if (!feedback) {
          ctx.ui.notify("Plan feedback is required. Usage: /plan changes <feedback>", "warning");
          return;
        }
        await requestPlanChanges(feedback);
        ctx.ui.notify("Plan changes requested.", "info");
        return;
      }
      if (action === "status" && parts.length === 1) {
        ctx.ui.notify(
          work
            ? `Plan: ${work.mode}\nGoal: ${work.goal || "not set"}\nRevision: ${work.planRevision ?? "not submitted"}\nTodos: ${work.todos.filter(todo => todo.status === "done").length}/${work.todos.length} complete`
            : "No active work.",
          "info",
        );
        return;
      }
      if (action !== "start") {
        ctx.ui.notify(usage, "warning");
        return;
      }
      if (ctx.isIdle?.() === false) {
        ctx.ui.notify("Wait for the current response before starting a plan.", "warning");
        return;
      }
      const goal = parts.slice(1).join(" ");
      planApproval.context = ctx;
      const config = await loadConfig();
      const baseModel = ctx.model && { provider: ctx.model.provider, id: ctx.model.id };
      const baseThinking = pi.getThinkingLevel();
      if (!(await applyProfile(ctx, config.planner))) {
        ctx.ui.notify("Planner model unavailable.", "error");
        return;
      }
      const previousRun = findRunEntry(ctx.sessionManager.getEntries?.() ?? []);
      work = fresh(goal);
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
      ctx.ui.notify(goal ? `Planning started: ${goal}` : "Planning started.", "info");
      if (goal)
        pi.sendUserMessage(
          `Plan this task without modifying project files. Use continuity_update set_plan; put the approach in planSummary, concrete paths/symbols in workingSet, unresolved assumptions or gaps in assumptions, and completion checks in acceptanceCriteria. Keep todos outcome-level: ${goal}`,
        );
    },
  };
  planApproval.schedule = (settledCtx: any) => {
    const token = planApproval.pending;
    const actionCtx = planApproval.context;
    const generation = session.generation;
    if (
      !token ||
      !actionCtx ||
      !["tui", "rpc"].includes(settledCtx.mode) ||
      planApproval.selection ||
      work?.mode !== "planning" ||
      work.runId !== token.runId ||
      work.planRevision !== token.revision ||
      work.approval ||
      work.revisionFeedback?.revision === token.revision ||
      !work.planSummary ||
      !work.todos.length
    )
      return;
    planApproval.pending = undefined;
    const selection = {};
    planApproval.selection = selection;
    queueMicrotask(async () => {
      const previousOfferedRevision = work?.offeredPlanRevision;
      const isCurrentPending = () =>
        session.generation === generation &&
        work?.mode === "planning" &&
        work.runId === token.runId &&
        work.planRevision === token.revision &&
        !work.approval &&
        work.revisionFeedback?.revision !== token.revision;
      const requeue = async () => {
        if (!isCurrentPending()) return;
        work!.offeredPlanRevision = previousOfferedRevision;
        planApproval.pending = token;
        await saveWork();
      };
      try {
        if (!isCurrentPending()) return;
        work!.offeredPlanRevision = token.revision;
        await saveWork();
        const choice = await settledCtx.ui.select(
          "Plan ready — review structured plan above",
          ["Approve — reset context", "Approve — continue current session", "Request changes"],
          planDialogOptions,
        );
        if (!isCurrentPending()) return;
        if (!choice) {
          await requeue();
          return;
        }
        if (choice === "Approve — reset context") {
          if ((await approvePlan(actionCtx, true)) === false) await requeue();
        } else if (choice === "Approve — continue current session") {
          if ((await approvePlan(actionCtx, false)) === false) await requeue();
        } else if (choice === "Request changes") {
          const feedback = await settledCtx.ui.editor("Plan feedback", "", planDialogOptions);
          if (!feedback?.trim()) {
            await requeue();
            return;
          }
          if (isCurrentPending()) await requestPlanChanges(feedback.trim());
        }
      } catch (error: any) {
        await requeue().catch(() => {});
        settledCtx.ui.notify(error?.message ?? String(error), "error");
      } finally {
        if (planApproval.selection === selection) planApproval.selection = undefined;
      }
    });
  };
  pi.registerCommand("plan", planCommand);
  pi.registerCommand("continuity", {
    description: "Show or configure Continuity model profiles",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "status";
      const usage =
        "Usage: /continuity [status|set <role> <provider/model[:thinking]>|select <role>|reset <role>|help]\nRoles: planner, executor, memory-reviewer, compaction-reviewer";
      const roles = {
        planner: "planner",
        executor: "executor",
        "memory-reviewer": "memoryReviewer",
        "compaction-reviewer": "compactionReviewer",
      } as const;
      const config = await loadConfig();
      if ((action === "status" && parts.length === 1) || parts.length === 0) {
        ctx.ui.notify(
          `Planner: ${config.planner?.model ?? "current session model"} · thinking: ${config.planner?.thinking ?? "current session level"}\nExecutor: ${config.executor?.model ?? "current session model"} · thinking: ${config.executor?.thinking ?? "current session level"}\nMemory Reviewer: ${config.memoryReviewer?.model ?? "not configured"} · thinking: ${config.memoryReviewer?.thinking ?? "default"}\nCompaction Reviewer: ${config.compactionReviewer?.model ?? "not configured"} · thinking: ${config.compactionReviewer?.thinking ?? "default"}`,
          "info",
        );
        return;
      }
      if (action === "help" && parts.length === 1) {
        ctx.ui.notify(usage, "info");
        return;
      }
      const roleName = parts[1] as keyof typeof roles | undefined;
      const role = roleName && roles[roleName];
      if (!role) {
        ctx.ui.notify(usage, "warning");
        return;
      }
      if (action === "reset" && parts.length === 2) {
        await updateConfig(current => {
          const next = { ...current };
          delete next[role];
          return next;
        });
        if (role === "memoryReviewer") {
          memory.reviewerConfigured = false;
          gate(work?.mode === "planning");
        }
        ctx.ui.notify(
          role === "memoryReviewer"
            ? "Memory Reviewer reset; memory proposals are unavailable."
            : role === "compactionReviewer"
              ? "Compaction Reviewer reset; compaction remains deterministic without supplemental review."
              : `${roleName} reset; uses current session model and thinking.`,
          "info",
        );
        return;
      }
      let selected: string | undefined;
      let interactive = false;
      if (action === "set" && parts.length === 3) selected = parts[2];
      else if (action === "select" && parts.length === 2) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("Continuity model selection is available only in Pi TUI.", "error");
          return;
        }
        interactive = true;
        selected =
          (await ctx.ui.select(
            `${roleName} model`,
            (ctx.scopedModels.length
              ? ctx.scopedModels.map(({ model }) => model)
              : ctx.modelRegistry.getAvailable()
            ).map(modelName),
          )) ?? undefined;
        if (!selected) return;
      } else {
        ctx.ui.notify(usage, "warning");
        return;
      }
      const ref = parseModelRef(selected);
      const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
      if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
        ctx.ui.notify(`Unavailable model: ${selected}`, "error");
        return;
      }
      let thinking: ThinkingLevel | undefined = ref.thinking;
      if (interactive) {
        thinking = (await ctx.ui.select(`${roleName} thinking level`, [...thinkingLevels])) as ThinkingLevel | undefined;
        if (!thinking) return;
      }
      await updateConfig(current => ({
        ...current,
        [role]: { model: modelName(model), ...(thinking ? { thinking } : {}) },
      }));
      if (role === "memoryReviewer") {
        memory.reviewerConfigured = true;
        gate(work?.mode === "planning");
      }
      ctx.ui.notify(`${roleName}: ${modelName(model)} · thinking: ${thinking ?? "current session level"}`, "info");
    },
  });
  pi.registerCommand("todos", {
    description: "Show Continuity todos",
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "help") {
        ctx.ui.notify("Usage: /todos [help]", "info");
        return;
      }
      if (value) {
        ctx.ui.notify("Usage: /todos [help]", "warning");
        return;
      }
      const todos = work?.todos ?? [];
      const done = todos.filter(todo => todo.status === "done").length;
      ctx.ui.notify(
        todos.length
          ? `Todos: ${done}/${todos.length} complete\n${todos.map(todo => `${todo.id}  ${todo.status}  ${todo.text}`).join("\n")}`
          : "No todos.",
        "info",
      );
    },
  });
  /** Rollback may only restore from inside the protected backup directory; anything else is refused. */
  const assertInsideBackupRoot = (backup: string, label: string) => {
    const backupRoot = resolve(memoryDirectory(), "backups"),
      backupPath = resolve(backup);
    const rel = relative(backupRoot, backupPath);
    if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel))
      throw Error(`${label} backup path is outside the protected backup directory.`);
    return backupPath;
  };

  const runMigrateV4 = async (ctx: any) => {
    if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for V4 memory migration.", "error");
    if (
      !(await ctx.ui.confirm(
        "Migrate Memory V4 to V6?",
        "A configured Memory Reviewer will normalize preserved V4 facts as archival V6 notes. Backups are retained and /memory rollback remains available until the next V6 write.",
      ))
    )
      return;
    try {
      const migration = await withMemoryLifecycle(() => runV4Migration(ctx, session.id));
      memory.legacyMigrationAvailable = await hasPendingV4Migration(root);
      publishState();
      if (!migration.migrated)
        return void ctx.ui.notify(
          "No V4 migration was performed; the source is absent, already migrated, or the migration was previously rolled back.",
          "info",
        );
      emitMemoryOutcome("migration_committed");
      return void ctx.ui.notify(
        `Memory V4 migrated to V6. ${migration.rejected} record(s) were rejected; use /memory rollback before another V6 write to restore the prior notebook.`,
        "info",
      );
    } catch (error: any) {
      emitMemoryOutcome("migration_failed");
      memory.legacyMigrationAvailable = await hasPendingV4Migration(root);
      publishState();
      return void ctx.ui.notify(`Memory V4 migration failed: ${error?.message ?? error}`, "error");
    }
  };

  const listMemoryBackups = async (ctx: any) => {
    const directories = [memoryDirectory(), join(root, "memory-v4")],
      backups: string[] = [];
    for (const directory of directories)
      for (const name of await readdir(directory, { recursive: true }).catch(() => [] as string[]))
        if (
          name.includes("backup") ||
          name.includes("reset-unsupported") ||
          name.includes("corrupt") ||
          name.includes("pre-migration") ||
          name.startsWith("state-v5-") ||
          name.startsWith("memory-v4") ||
          name.startsWith("candidates-v4")
        )
          backups.push(join(directory, name));
    return void ctx.ui.notify(backups.join("\n") || "No memory backups.", "info");
  };

  /** Discards the generated V6 notebook; the byte-exact V5 source and its backup stay on disk. */
  const rollbackV5Migration = async (ctx: any, v5Journal: V5MigrationJournal) => {
    if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory rollback.", "error");
    if (
      !(await ctx.ui.confirm(
        "Rollback Memory V5 migration?",
        "This removes the generated V6 notebook while preserving the byte-exact V5 source and backup.",
      ))
    )
      return;
    await withMemoryLifecycle(() =>
      withStateLock(memoryDirectory(), async () => {
        const latest = await readMemory();
        if (latest.revision !== v5Journal.activatedRevision)
          throw Error("Memory changed after V5 migration; rollback requires manual reconciliation.");
        const raw = await readFile(assertInsideBackupRoot(v5Journal.backupPath, "V5 migration"), "utf8");
        if (sha256(raw) !== v5Journal.sourceSha256)
          throw Error("V5 migration backup is stale or corrupt; rollback aborted.");
        const next = { ...emptyMemoryState(), revision: latest.revision + 1, updatedAt: new Date().toISOString() };
        await writeMemory(next);
        memory.state = next;
        memory.notes = [];
        await writeJsonAtomic(paths().v6Migration, {
          ...v5Journal,
          status: "rolled_back",
          rolledBackAt: new Date().toISOString(),
        } satisfies V5MigrationJournal);
      }),
    );
    publishState();
    return void ctx.ui.notify("Memory V5 migration rolled back; the original V5 state remains recoverable.", "info");
  };

  /** Restores the notebook captured immediately before the V6 migration ran. */
  const rollbackV6Migration = async (ctx: any, journal: MigrationJournal & { preMigrationBackup: string }) => {
    if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory rollback.", "error");
    if (
      !(await ctx.ui.confirm(
        "Rollback Memory V6 migration?",
        "This restores the notebook from immediately before migration.",
      ))
    )
      return;
    const backup = journal.preMigrationBackup;
    await withMemoryLifecycle(() =>
      withFileLock(join(memoryDirectory(), "migration-operation"), async () => {
        await withStateLock(memoryDirectory(), async () => {
          const latest = await readMemory();
          if (latest.revision !== journal.activatedStateRevision)
            throw Error("Memory changed after migration; rollback requires manual reconciliation.");
          let restored: MemoryStateFile;
          if (backup === "empty") restored = emptyMemoryState();
          else {
            const parsed = JSON.parse(await readFile(assertInsideBackupRoot(backup, "Migration"), "utf8"));
            if (!isMemoryState(parsed)) throw Error("Migration backup is missing or invalid; rollback aborted.");
            restored = parsed;
          }
          const next = { ...restored, revision: latest.revision + 1, updatedAt: new Date().toISOString() };
          enforceMemoryLimits(next);
          await writeMemory(next);
          memory.state = next;
          memory.notes = next.notes;
        });
        await writeJsonAtomic(paths().migration, {
          ...journal,
          status: "rolled_back",
          activatedStateRevision: undefined,
        });
      }),
    );
    publishState();
    return void ctx.ui.notify("Memory migration rolled back.", "info");
  };

  const rollbackMigration = async (ctx: any) => {
    const journal = await readJson<MigrationJournal | undefined>(
      paths().migration,
      undefined,
      value => value === undefined || isMigrationJournal(value),
    );
    const v6Restorable = Boolean(
      journal &&
      journal.status === "activated" &&
      journal.activatedStateRevision === memory.state.revision &&
      journal.preMigrationBackup,
    );
    const v5Journal = await readV5MigrationJournal();
    if (!v6Restorable && v5Journal?.status === "activated" && v5Journal.activatedRevision === memory.state.revision)
      return rollbackV5Migration(ctx, v5Journal);
    if (!v6Restorable)
      return void ctx.ui.notify(
        "Migration rollback is unavailable after new V6 writes or without an activated migration.",
        "error",
      );
    return rollbackV6Migration(ctx, journal as MigrationJournal & { preMigrationBackup: string });
  };

  const showMemoryOwners = async (ctx: any) => {
    const counts = new Map<string, number>();
    for (const note of memory.notes) counts.set(note.owner, (counts.get(note.owner) ?? 0) + 1);
    return void ctx.ui.notify(
      [...counts]
        .map(
          ([owner, count]) =>
            `${owner}${owner === project!.owner || owner === "default" ? " (current)" : ""}: ${count}`,
        )
        .join("\n") || "No owners.",
      "info",
    );
  };

  const showMemoryNotes = async (ctx: any, scope?: MemoryScope) => {
    const all = notesForOwners(memory.notes, project!.owner).filter(note => !scope || note.scope === scope);
    const shown = all.slice(0, 20);
    return void ctx.ui.notify(
      shown.length
        ? `${shown
            .map(
              note =>
                `${note.scope}/${note.id} r${note.revision} [${note.authority}/${note.origin}]\nWhen ${note.trigger}\n${note.guidance}`,
            )
            .join("\n\n")}${shown.length < all.length ? `\n\n… ${all.length - shown.length} more notes` : ""}`
        : "No notes.",
      "info",
    );
  };

  const forgetProjectMemory = async (ctx: any) => {
    if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory deletion.", "error");
    if (!(await ctx.ui.confirm("Forget all project memory?", "These rules will be removed from this project."))) return;
    await withMemoryLifecycle(() =>
      withStateLock(memoryDirectory(), async () => {
        let latest = await readMemory();
        for (const note of latest.notes.filter(item => item.scope === "project" && item.owner === project!.owner))
          latest = directDelete(latest, "project", project!.owner, note.id, note.revision);
        await writeMemory(latest);
        memory.state = latest;
        memory.notes = latest.notes;
      }),
    );
    publishState();
    return void ctx.ui.notify("Project memory removed.", "info");
  };


  /** Resolves the note a scoped `edit`/`forget <id>` subcommand names, or notifies and returns undefined. */
  const scopedNote = (ctx: any, scope: MemoryScope, id: string) => {
    const owner = scope === "user" ? "default" : project!.owner;
    const note = memory.notes.find(item => item.id === id && item.scope === scope && item.owner === owner);
    if (!note) ctx.ui.notify("Memory note not found.", "error");
    return note && { note, owner };
  };

  const editMemoryNote = async (ctx: any, scope: MemoryScope, id: string) => {
    if (!ctx.hasUI || ctx.mode !== "tui")
      return void ctx.ui.notify("Interactive UI required for memory edit.", "error");
    const found = scopedNote(ctx, scope, id);
    if (!found) return;
    const { note, owner } = found;
    const value = await ctx.ui.editor(
      `Edit ${scope} memory`,
      `Trigger:\n${note.trigger}\n\nGuidance:\n${note.guidance}`,
    );
    const parsed = /^Trigger:\s*\n([\s\S]*?)\n\s*Guidance:\s*\n([\s\S]+)$/i.exec(value ?? "");
    if (!parsed) return void ctx.ui.notify("Keep Trigger and Guidance headings.", "error");
    if (
      !(await ctx.ui.confirm(
        `Save ${scope} memory?`,
        scope === "user" ? "This rule applies across every project." : "This rule applies to this project.",
      ))
    )
      return;
    try {
      await withMemoryLifecycle(() =>
        withStateLock(memoryDirectory(), async () => {
          const next = directEdit(await readMemory(), scope, owner, note.id, note.revision, parsed[1]!, parsed[2]!);
          await writeMemory(next);
          memory.state = next;
          memory.notes = next.notes;
        }),
      );
      publishState();
      ctx.ui.notify("Memory note updated.", "info");
    } catch (error: any) {
      ctx.ui.notify(error?.message ?? "Memory update failed.", "error");
    }
  };

  const forgetMemoryNote = async (ctx: any, scope: MemoryScope, id: string) => {
    const found = scopedNote(ctx, scope, id);
    if (!found) return;
    const { note, owner } = found;
    if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory deletion.", "error");
    if (
      !(await ctx.ui.confirm(
        `Forget ${scope} memory?`,
        scope === "user"
          ? "This rule will be removed from every project."
          : "This rule will be removed from this project.",
      ))
    )
      return;
    try {
      await withMemoryLifecycle(() =>
        withStateLock(memoryDirectory(), async () => {
          const next = directDelete(await readMemory(), scope, owner, note.id, note.revision);
          await writeMemory(next);
          memory.state = next;
          memory.notes = next.notes;
        }),
      );
      publishState();
      ctx.ui.notify("Memory note removed.", "info");
    } catch (error: any) {
      ctx.ui.notify(error?.message ?? "Memory delete failed.", "error");
    }
  };

  pi.registerCommand("memory", {
    description: "Show and manage user or project notebook notes",
    handler: async (args, ctx) => {
      if (!memory.enabled) return void ctx.ui.notify("Continuity memory is disabled in package settings.", "info");
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const action = parts[0] ?? "status";
      const usage =
        "Usage: /memory [status|list [user|project]|edit <user|project> <id>|forget <user|project> [id]|owners|backups|migrate|rollback|activation <on|off>|help]";
      if (action === "help" && parts.length === 1) {
        ctx.ui.notify(usage, "info");
        return;
      }
      if (action === "activation" && parts.length === 2 && ["on", "off"].includes(parts[1]!)) {
        memory.activationEnabled = parts[1] === "on";
        ctx.ui.notify(`Prospective memory activation ${parts[1]} for this session.`, "info");
        return;
      }
      project = await resolveProject(ctx.cwd);
      memory.state = await readMemory();
      memory.notes = memory.state.notes;
      if ((action === "status" && parts.length === 1) || parts.length === 0) {
        const owned = notesForOwners(memory.notes, project.owner);
        ctx.ui.notify(
          `Memory: enabled\nActivation: ${memory.activationEnabled ? "on" : "off"}\nNotes: ${owned.length} (${owned.filter(note => note.scope === "user").length} user · ${owned.filter(note => note.scope === "project").length} project)`,
          "info",
        );
        return;
      }
      if (action === "list" && parts.length <= 2) {
        const scope = parts[1];
        if (scope && scope !== "user" && scope !== "project") {
          ctx.ui.notify(usage, "warning");
          return;
        }
        return showMemoryNotes(ctx, scope as MemoryScope | undefined);
      }
      if (action === "owners" && parts.length === 1) return showMemoryOwners(ctx);
      if (action === "backups" && parts.length === 1) return listMemoryBackups(ctx);
      if (action === "migrate" && parts.length === 1) return runMigrateV4(ctx);
      if (action === "rollback" && parts.length === 1) return rollbackMigration(ctx);
      if (action === "forget" && parts.length === 2 && parts[1] === "project") return forgetProjectMemory(ctx);
      if ((action === "edit" || action === "forget") && parts.length === 3) {
        const scope = parts[1];
        const id = parts[2]!;
        if ((scope === "user" || scope === "project") && /^[0-9a-f-]+$/i.test(id))
          return action === "edit"
            ? editMemoryNote(ctx, scope, id)
            : forgetMemoryNote(ctx, scope, id);
      }
      ctx.ui.notify(usage, "warning");
    },
  });
}
