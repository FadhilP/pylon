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
  directDelete,
  directEdit,
  discardExpiredReviews,
  emptyMemoryState,
  enforceMemoryLimits,
  exactDuplicate,
  isMemoryState,
  migrateV5MemoryState,
  notesForOwners,
  normalizeMemoryState,
  semanticIdentity,
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
  isRunEntry,
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
const EXECUTION_ENTRY_TYPE = "pi-continuity-execution";
const COMPACTION_CONTINUATION_CHANNEL = "pi-continuity:compaction-continuation";
const COMPACTION_INTERRUPTION_DIAGNOSTIC = "pi-continuity-compaction-interruption";
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
const isV5MigrationJournal = (value: any): value is V5MigrationJournal => value?.version === 1
  && ["prepared", "activated", "rolled_back"].includes(value.status)
  && [value.sourceSha256, value.stateSha256].every((item) => typeof item === "string" && /^[0-9a-f]{64}$/.test(item))
  && Number.isSafeInteger(value.activatedRevision) && value.activatedRevision >= 0
  && typeof value.backupPath === "string" && value.backupPath.length > 0 && value.backupPath.length <= 500
  && typeof value.preparedAt === "string" && !Number.isNaN(Date.parse(value.preparedAt))
  && (value.migratedAt === undefined || typeof value.migratedAt === "string" && !Number.isNaN(Date.parse(value.migratedAt)))
  && (value.rolledBackAt === undefined || typeof value.rolledBackAt === "string" && !Number.isNaN(Date.parse(value.rolledBackAt)));
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
  "Working Set",
  ...(work.handoff?.workingSet.length
    ? work.handoff.workingSet.map((value) => `- ${value}`)
    : ["- Not specified"]),
  "",
  "Assumptions / Gaps",
  ...(work.handoff?.assumptions.length
    ? work.handoff.assumptions.map((value) => `- ${value}`)
    : ["- None stated"]),
  "",
  "Acceptance Criteria",
  ...(work.handoff?.acceptanceCriteria.length
    ? work.handoff.acceptanceCriteria.map((value) => `- ${value}`)
    : ["- Not specified"]),
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
  RecallModeName = StringEnum(["text", "files", "touched", "tools"] as const);
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
    memorySidecar: CompiledMemorySidecar = compileMemorySidecar([], 0),
    memoryRuleIndex = indexMemorySidecar(memorySidecar),
    memoryLedger: MemoryLedger = emptyMemoryLedger("unleased"),
    reviewCalledThisTask = false,
    memoryProposalToken: string | undefined,
    memoryTaskGeneration = 0,
    project: ProjectContext | undefined,
    savedTools: string[] | undefined,
    lastPrompt = "",
    memoryEnabled = true,
    memoryActivationEnabled = true,
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
    automaticCompaction: CompactionContinuationRequest | undefined,
    sharedWorktreeObserver = false,
    pendingApproval: { runId?: string; revision: number } | undefined,
    approvalContext: any,
    approvalSelection: object | undefined,
    clarifyTimeoutSeconds: number | null | undefined,
    sessionGeneration = 0,
    stateRevision = 0,
    releaseSessionLease: ((cleanupIfLast?: () => Promise<void>) => Promise<void>) | undefined,
    leasedSessionId = "",
    ephemeralSession = false,
    schedulePlanApproval = (_ctx: any) => {},
    resumeApproval = async (_ctx: any) => false,
    disposePlanAction = () => {};
  let memoryLifecycleQueue = Promise.resolve(), planMutationQueue = Promise.resolve();
  const withMemoryLifecycle = async <T>(task: () => Promise<T>): Promise<T> => {
    const previous = memoryLifecycleQueue; let release = () => {};
    memoryLifecycleQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await task(); } finally { release(); }
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
    if (event?.version !== 1 || event.action !== "cancel" || !request
      || event.requestId !== request.id || event.sessionId !== request.sessionId
      || event.sessionGeneration !== request.sessionGeneration || event.taskGeneration !== request.taskGeneration) return;
    abandonAutomaticCompaction(request);
  });
  const withPlanMutation = async <T>(task: () => Promise<T>): Promise<T> => {
    const previous = planMutationQueue; let release = () => {};
    planMutationQueue = new Promise<void>((resolve) => { release = resolve; });
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
  const scopedMemoryNotes = (notes = memoryNotes) => project ? notesForOwners(notes, project.owner) : notes.filter((note) => note.scope === "user" && note.owner === "default");
  const pruneMemoryLedger = () => {
    const compiled = new Set(memorySidecar.rules.map((rule) => `${rule.memoryId}\0${rule.noteRevision}`));
    memoryLedger = { ...memoryLedger, active: memoryLedger.active.filter((item) => compiled.has(`${item.memoryId}\0${item.noteRevision}`)) };
  };
  const refreshMemoryCompilation = async (state: MemoryStateFile, persist = true) => {
    const scoped = scopedMemoryNotes(state.notes), compilable: NotebookNote[] = [], stale: CompiledMemorySidecar["failures"] = [];
    for (const note of scoped) {
      if (note.disposition !== "eligible_advisory" || note.authority !== "project_contract") { compilable.push(note); continue; }
      const review = state.reviews.find((item) => item.reviewId === note.sourceReviewId);
      const refs = note.sourceRefs.filter((ref): ref is Extract<NotebookNote["sourceRefs"][number], { type: "repository" }> => ref.type === "repository");
      const ranges = (review?.evidenceBatches?.flat() ?? []).filter((range) => refs.some((ref) => ref.path === range.path && ref.excerptSha256 === range.excerptSha256));
      try {
        const captured = ranges.length ? await captureEvidenceRanges(currentCwd, ranges.map(({ path, start, end }) => ({ path, start, end }))) : [];
        if (!refs.length || !refs.every((ref) => captured.some((item) => item.path === ref.path && item.excerptSha256 === ref.excerptSha256))) throw Error("stale");
        compilable.push(note);
      } catch { stale.push({ memoryId: note.id, noteRevision: note.revision, reason: "source_stale" }); }
    }
    memorySidecar = compileMemorySidecar(compilable, state.revision);
    memorySidecar.failures.push(...stale);
    memoryRuleIndex = indexMemorySidecar(memorySidecar);
    pruneMemoryLedger();
    if (persist) await writeJsonAtomic(paths().compiledMemory, memorySidecar).catch(() => {});
  };
  const readMemory = async () => {
    try {
      await readFile(paths().memory, "utf8");
      const state = normalizeMemoryState(await readVersionedJson(paths().memory, emptyMemoryState(), isMemoryState))!;
      const journal = await readV5MigrationJournal();
      if (journal?.status === "prepared") {
        if (journal.activatedRevision !== state.revision || journal.stateSha256 !== sha256(JSON.stringify(state))) throw Error("Memory V5 migration is incomplete and does not match V6 state");
        await writeJsonAtomic(paths().v6Migration, { ...journal, status: "activated", migratedAt: new Date().toISOString() } satisfies V5MigrationJournal);
      }
      await refreshMemoryCompilation(state);
      return state;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const existingJournal = await readV5MigrationJournal();
    if (existingJournal?.status === "rolled_back") throw Error("Memory V5 migration was rolled back; restore or remove its journal before migrating again");
    if (existingJournal?.status === "activated") throw Error("Memory V6 state is missing after an activated V5 migration");
    let rawV5: string;
    try { rawV5 = await readFile(paths().v5Memory, "utf8"); }
    catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const state = emptyMemoryState(); await refreshMemoryCompilation(state); return state;
    }
    let legacy: unknown;
    try { legacy = JSON.parse(rawV5); } catch { throw Error("Memory V5 state is malformed; migration stopped without modifying it"); }
    const migrated = migrateV5MemoryState(legacy);
    if (!migrated) throw Error("Memory V5 state is unsupported; migration stopped without modifying it");
    const sourceSha256 = sha256(rawV5), stateSha256 = sha256(JSON.stringify(migrated));
    if (existingJournal?.status === "prepared" && (existingJournal.sourceSha256 !== sourceSha256 || existingJournal.stateSha256 !== stateSha256 || existingJournal.activatedRevision !== migrated.revision)) throw Error("Memory V5 changed after migration preparation");
    const backupPath = join(memoryDirectory(), "backups", `state-v5-${sourceSha256}.json`), preparedAt = new Date().toISOString();
    await writeBytesAtomic(backupPath, rawV5);
    const prepared: V5MigrationJournal = { version: 1, status: "prepared", sourceSha256, stateSha256, activatedRevision: migrated.revision, backupPath, preparedAt };
    await writeJsonAtomic(paths().v6Migration, prepared);
    await writeMemory(migrated);
    await writeJsonAtomic(paths().v6Migration, { ...prepared, status: "activated", migratedAt: new Date().toISOString() });
    return migrated;
  };
  const writeMemory = async (state: MemoryStateFile) => { await writeJsonAtomic(paths().memory, state); await refreshMemoryCompilation(state); };
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
  const persistMemoryLedger = () => pi.appendEntry(MEMORY_LEDGER_ENTRY_TYPE, memoryLedger);
  const interventionText = (interventions: readonly MemoryIntervention[]) => {
    const byId = new Map(scopedMemoryNotes().map((note) => [note.id, note]));
    const lines = interventions.flatMap((intervention) => {
      const note = byId.get(intervention.memoryId);
      return note && note.revision === intervention.noteRevision ? [`Applicable working rule [${note.id}]: When ${note.trigger}, ${note.guidance}`] : [];
    });
    return lines.join("\n");
  };
  const queueMemoryInterventions = (interventions: readonly MemoryIntervention[]) => {
    const text = interventionText(interventions);
    if (!text) return;
    persistMemoryLedger();
    pi.sendMessage({ customType: "pi-continuity-memory", content: text, display: false, details: { version: 2, contextEpoch: memoryLedger.contextEpoch, memoryIds: interventions.map((item) => item.memoryId) } }, { deliverAs: "steer" });
    pi.events.emit("pi-continuity:memory-activation", { version: 1, outcome: "delivered", memoryIds: interventions.map((item) => item.memoryId), contextEpoch: memoryLedger.contextEpoch });
  };
  const processProspectiveMemory = (frame: ReturnType<typeof eventFrame>) => {
    const processed = processMemoryEvent(memoryRuleIndex, frame, memoryLedger);
    memoryLedger = processed.ledger;
    if (processed.uncertain.length) pi.events.emit("pi-continuity:memory-activation", { version: 1, outcome: "abstained", memoryIds: processed.uncertain, contextEpoch: memoryLedger.contextEpoch });
    queueMemoryInterventions(processed.interventions);
    return processed.interventions;
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
    const path = paths().work;
    try {
      if (!work) return;
      if (!isWork(work)) throw Error("Continuity Work invariants are invalid.");
      assertSafe(
        work.goal,
        work.planSummary,
        ...work.constraints,
        ...(work.handoff?.workingSet ?? []).flatMap((value) => value.split(/[\\/]/)),
        ...(work.handoff?.assumptions ?? []),
        ...(work.handoff?.acceptanceCriteria ?? []),
        work.revisionFeedback?.text,
        work.latestFailure,
        work.nextAction,
        ...work.todos.map((t) => t.text),
      );
      await writeJson(path, work);
      publishState();
    } catch (error) {
      work = undefined;
      try {
        work = await readJson<Work | undefined>(path, undefined, (value) => value === undefined || isWork(value));
      } catch { /* Preserve the save error and fail closed if durable state cannot be restored. */ }
      throw error;
    }
  };
  const refresh = (ctx: any) => {
    if (ctx.hasUI)
      ctx.ui.setStatus(
        "pi-continuity",
        work?.mode === "planning"
          ? (ctx.mode === "tui" && ctx.ui.theme?.fg
              ? ctx.ui.theme.fg("warning", "Plan mode")
              : "Plan mode")
          : undefined,
      );
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
        try { latest = applyReview(latest, original); changed = true; emitMemoryOutcome("committed"); }
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
    abandonAutomaticCompaction();
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
    approvalContext = ctx;
    memoryEnabled = (await loadConfig()).memoryEnabled !== false;
    recentCalls.clear();
    pendingMutations.clear();
    deniedToolCalls.clear();
    seenMutationMessages.clear();
    terminatingToolCalls.clear();
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
    memoryTaskGeneration++;
    memoryLedger = restoreMemoryLedger(ctx.sessionManager.getBranch?.() ?? [], sessionId, memoryTaskGeneration);
    pruneMemoryLedger();
    reviewCalledThisTask = false;
    memoryProposalToken = undefined;
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
    if (work?.approval)
      queueMicrotask(() => void resumeApproval(ctx).catch((error: any) =>
        ctx.ui?.notify?.(`Plan approval recovery is pending: ${error?.message ?? String(error)}`, "warning")));
  }));
  pi.on("session_shutdown", async () => withMemoryLifecycle(async () => {
    if (memoryEnabled) persistMemoryLedger();
    abandonAutomaticCompaction();
    sessionGeneration++;
    activeSessionContext = undefined;
    terminatingToolCalls.clear();
    legacyMigrationAvailable = false;
    pendingApproval = undefined;
    approvalContext = undefined;
    approvalSelection = undefined;
    publishState(false);
    disposeStateRequest();
    disposeMemoryMutation();
    disposePlanAction();
    disposeInstanceClaim();
    disposeVerify();
    disposeHeartbeat();
    disposeWorktreeChange();
    disposePackageMutation();
    disposeGuardDecision();
    disposeCompactionCancel();
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
    schedulePlanApproval(ctx);
  });
  pi.on("message_end", async (event, ctx) => {
    const message = event.message as any;
    const request = automaticCompaction;
    if (request && message.role === "assistant" && message.stopReason === "aborted") {
      return {
        message: {
          ...message,
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
    if (memoryEnabled && memoryActivationEnabled && project) {
      const rawPath = typeof (event.input as any)?.path === "string" ? String((event.input as any).path).replace(/^@/, "").replace(/\\/g, "/") : undefined;
      const rawCommand = event.toolName === "bash" && typeof (event.input as any)?.command === "string" ? sanitizeAndClip((event.input as any).command, 500).slice(0, 500) : undefined;
      processProspectiveMemory(eventFrame({
        kind: "before_tool_call",
        ledger: memoryLedger,
        repository: project.owner,
        taskPhase: work?.mode ?? "idle",
        toolCallId: event.toolCallId,
        facts: { "tool.name": event.toolName, ...(rawCommand ? { "tool.command": rawCommand } : {}), ...(rawPath ? { "file.path": rawPath } : {}), "attempt.count": 1 },
      }));
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
    if (memoryEnabled && memoryActivationEnabled && project && event.isError !== true && observedMutation) await refreshMemoryCompilation(memoryState, false);
    if (memoryEnabled && memoryActivationEnabled && project) {
      const content = Array.isArray(event.content) ? event.content.filter((part: any) => part?.type === "text" && typeof part.text === "string").map((part: any) => part.text).join("\n").slice(0, 8_000) : "";
      const signature = content.match(/\b(?:E[A-Z]{3,}|[A-Z][A-Z0-9_]{4,})\b/)?.[0];
      const rawPath = typeof (event.input as any)?.path === "string" ? String((event.input as any).path).replace(/^@/, "").replace(/\\/g, "/") : undefined;
      const rawCommand = event.toolName === "bash" && typeof (event.input as any)?.command === "string" ? sanitizeAndClip((event.input as any).command, 500).slice(0, 500) : undefined;
      processProspectiveMemory(eventFrame({
        kind: "after_tool_result",
        ledger: memoryLedger,
        repository: project.owner,
        taskPhase: work?.mode ?? "idle",
        toolCallId: event.toolCallId,
        facts: {
          "tool.name": event.toolName,
          ...(rawCommand ? { "tool.command": rawCommand } : {}),
          "tool.isError": event.isError === true,
          ...((event.details as any)?.exitCode !== undefined ? { "tool.exitCode": Number((event.details as any).exitCode) } : {}),
          ...(signature ? { "tool.errorSignature": signature } : {}),
          ...(rawPath ? { "file.path": rawPath } : {}),
        },
      }));
    }

  });
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      abandonAutomaticCompaction();
      lastPrompt = event.text;
      memoryTaskGeneration++;
      memoryLedger = { ...memoryLedger, taskGeneration: memoryTaskGeneration };
      reviewCalledThisTask = false;
      if (memoryEnabled && memoryActivationEnabled && project) processProspectiveMemory(eventFrame({ kind: "task_started", ledger: memoryLedger, repository: project.owner, taskPhase: work?.mode ?? "idle" }));
    }
  });
  pi.on("turn_end", (event, ctx) => {
    const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
    const hasToolCalls = Array.isArray((event.message as any)?.content) &&
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
    if (usage?.tokens == null || !Number.isFinite(usage.tokens) || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return;
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted?.() ?? false,
    }).getCompactionSettings();
    if (!settings.enabled || usage.tokens <= usage.contextWindow - settings.reserveTokens) return;

    const request: CompactionContinuationRequest = {
      id: randomUUID(),
      sessionGeneration,
      taskGeneration: memoryTaskGeneration,
      sessionId: ctx.sessionManager.getSessionId(),
    };
    automaticCompaction = request;
    emitCompactionContinuation("begin", request);
    try {
      ctx.compact({
        onComplete: () => {
          if (automaticCompaction !== request) return;
          if (
            sessionGeneration !== request.sessionGeneration ||
            memoryTaskGeneration !== request.taskGeneration ||
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
            pi.sendMessage({
              customType: "pi-continuity-resume",
              content: "Continue the unfinished task from the compaction checkpoint. Do not repeat completed work or wait for another user prompt.",
              display: false,
              details: { version: 1, reason: "mid-task-compaction", requestId: request.id },
            }, { triggerTurn: true });
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
  pi.on("session_tree", (_event, ctx) => {
    if (!memoryEnabled || !memoryActivationEnabled) return;
    memoryTaskGeneration++;
    memoryLedger = restoreMemoryLedger(ctx.sessionManager.getBranch?.() ?? [], leasedSessionId, memoryTaskGeneration);
    pruneMemoryLedger();
  });
  pi.on("session_compact", () => {
    if (!memoryEnabled || !memoryActivationEnabled) return;
    memoryLedger = rearmMemoryAfterCompaction(memoryLedger);
    const active = activeMemoryForDelivery(memoryLedger);
    if (!active.length) { persistMemoryLedger(); return; }
    const interventions = active.map((item) => ({ memoryId: item.memoryId, noteRevision: item.noteRevision, mode: "inject_once" as const, cause: "context_compacted" }));
    memoryLedger = markActiveMemoryDelivered(memoryLedger, active);
    queueMemoryInterventions(interventions);
  });
  pi.on("before_agent_start", async () => {
    if (!memoryEnabled || !memoryActivationEnabled) return;
    const active = activeMemoryForDelivery(memoryLedger);
    if (!active.length) return;
    const interventions = active.map((item) => ({ memoryId: item.memoryId, noteRevision: item.noteRevision, mode: "inject_once" as const, cause: "active" }));
    const text = interventionText(interventions);
    if (!text) return;
    memoryLedger = markActiveMemoryDelivered(memoryLedger, active);
    persistMemoryLedger();
    return { message: { customType: "pi-continuity-memory", content: text, display: false, details: { version: 2, contextEpoch: memoryLedger.contextEpoch, memoryIds: active.map((item) => item.memoryId) } } };
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
    const messages = boundedMessages.filter((message: any) => message?.role !== "custom" || message.customType !== "pi-continuity-memory" || message.details?.version === 2);
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
    description: "Search bounded historical evidence from the current Pi session or, with explicit project_sessions scope, other persisted sessions in the current project. Use tools mode to retrieve sanitized assistant tool calls and exact stored-result expansions. This is not an exact historical session-ID lookup; use search_sessions for explicit session IDs. Project-session results can be filtered by inclusive ISO-8601 UTC entry timestamps.",
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
      since: Type.Optional(Type.String({ maxLength: 64, description: "Inclusive ISO-8601 UTC entry timestamp; project_sessions only." })),
      before: Type.Optional(Type.String({ maxLength: 64, description: "Inclusive ISO-8601 UTC entry timestamp; project_sessions only." })),
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
      "Propose clear, potentially reusable, explicitly stated user preferences or instructions, and intentional project conventions or contracts, when they could plausibly guide a future session. Do not require certainty of admission: the Memory Reviewer may accept, rewrite, merge, defer, or reject. Never propose progress, implementation summaries, guesses, generic advice, one-off details, duplicates, or secrets.",
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
        return { content: [{ type: "text", text }], details: { memoryList: true, notes: shown.map((note) => ({ id: note.id, revision: note.revision, scope: note.scope, trigger: note.trigger, guidance: note.guidance, state: note.disposition })) } };
      }
      if (reviewCalledThisTask || memoryProposalToken) return failure("Only one memory proposal call is allowed per task.");
      const reservationToken = randomUUID(); memoryProposalToken = reservationToken;
      const proposalTask = memoryTaskGeneration, proposalGeneration = sessionGeneration, proposalSession = leasedSessionId, proposalCwd = ctx.cwd;
      let reviewerInvoked = false, proposalCompleted = false;
      try {
        const resolved = await resolveProject(proposalCwd), config = await loadConfig(), profile = config.memoryReviewer;
        if (!profile) return failure("Memory Reviewer unavailable: configure a dedicated reviewer model.");
        const model = await configuredModel(ctx, profile);
        if (!model) return failure("Memory Reviewer unavailable: configured model or credentials are unavailable.");
        const state = await readMemory();
        const preflight = await preflightMemoryProposals({ rawProposals: p.proposals, state, cwd: proposalCwd, activeBranch: ctx.sessionManager.getBranch?.() ?? [], sessionId: proposalSession, projectOwner: resolved.owner });
        const covered = preflight.proposals.map((proposal, proposalIndex) => proposal.coveredBy ? { proposalIndex, note: proposal.coveredBy } : undefined).filter((item): item is { proposalIndex: number; note: NotebookNote } => Boolean(item));
        if (covered.length === preflight.proposals.length) {
          proposalCompleted = reviewCalledThisTask = true;
          return { content: [{ type: "text", text: `Memory review:\n${covered.map((item) => `- already covered by ${item.note.scope}/${item.note.id}: proposal ${item.proposalIndex + 1}`).join("\n")}` }], details: { memoryReview: true, outcomes: covered.map((item) => ({ proposalIndex: item.proposalIndex, status: "covered", reasonCodes: ["duplicate"], memoryId: item.note.id })) } };
        }
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
        if (!auth.ok || !auth.apiKey) return failure("Memory Reviewer unavailable: configured model has no credentials.");
        reviewerInvoked = true;
        const reviewed = await callMemoryReviewer({ model, auth: { apiKey: auth.apiKey, headers: auth.headers, env: auth.env }, profile, packet: preflight.packet, sessionId: proposalSession, signal });
        const record = reviewedRecord({ decisions: reviewed.decisions, preflight: preflight.proposals, packet: preflight.packet, sessionId: proposalSession, toolCallId: id, generation: proposalGeneration, taskGeneration: proposalTask });
        proposalCompleted = reviewCalledThisTask = true;
        for (const prepared of preflight.proposals) if (prepared.evidence) {
          const freshEvidence = await captureEvidenceRanges(proposalCwd, prepared.proposal.basis.type === "project_contract" ? prepared.proposal.basis.evidence : []);
          if (freshEvidence.some((item, index) => item.excerptSha256 !== prepared.evidence![index]?.excerptSha256)) throw Error("memory evidence changed during review");
        }
        await withMemoryLifecycle(() => withStateLock(memoryDirectory(), async () => {
          if (proposalGeneration !== sessionGeneration || proposalTask !== memoryTaskGeneration || proposalSession !== leasedSessionId || proposalCwd !== currentCwd || project?.owner !== resolved.owner) throw Error("memory review became stale after a task or session change");
          const latest = await readMemory(), reviewedIdentities = new Set<string>();
          for (const operation of record.operations) {
            if (operation.operation === "add") {
              if (exactDuplicate(latest.notes, operation.scope, operation.owner, operation.trigger, operation.guidance)) throw Error("memory review became a duplicate");
              const identity = `${operation.scope}\0${operation.owner}\0${semanticIdentity(operation.trigger, operation.guidance)}`;
              if (reviewedIdentities.has(identity)) throw Error("memory review produced duplicate operations");
              reviewedIdentities.add(identity);
            } else {
              const target = latest.notes.find((note) => note.id === operation.targetId);
              if (!target || target.revision !== operation.expectedRevision) throw Error("memory review became stale");
              if (operation.operation === "replace") {
                if (exactDuplicate(latest.notes, target.scope, target.owner, operation.trigger, operation.guidance, target.id)) throw Error("memory review became a duplicate");
                const identity = `${target.scope}\0${target.owner}\0${semanticIdentity(operation.trigger, operation.guidance)}`;
                if (reviewedIdentities.has(identity)) throw Error("memory review produced duplicate operations");
                reviewedIdentities.add(identity);
              }
            }
          }
          const next = stageReview(latest, record);
          if (proposalGeneration !== sessionGeneration || proposalTask !== memoryTaskGeneration || proposalSession !== leasedSessionId || proposalCwd !== currentCwd || project?.owner !== resolved.owner) throw Error("memory review became stale before staging");
          await writeMemory(next); memoryState = next; memoryNotes = next.notes;
        }));
        emitMemoryOutcome("staged");
        pi.events.emit("pi-continuity:memory-review-telemetry", { version: 1, ...reviewed.telemetry, proposalCount: preflight.proposals.length, verdicts: reviewed.decisions.map((decision) => decision.verdict) });
        let operationIndex = 0;
        const operationByProposal = reviewed.decisions.map((decision, proposalIndex) => {
          const existing = preflight.proposals[proposalIndex]?.coveredBy;
          if (existing) return existing.id;
          if (decision.verdict === "reject" || decision.verdict === "defer") return;
          const operation = record.operations[operationIndex++];
          return operation?.operation === "add" ? operation.noteId : operation?.targetId;
        });
        const lines = reviewed.decisions.map((decision, index) => preflight.proposals[index]?.coveredBy
          ? `- already covered by ${preflight.proposals[index]!.coveredBy!.scope}/${preflight.proposals[index]!.coveredBy!.id}: proposal ${index + 1}`
          : decision.verdict === "reject" || decision.verdict === "defer" ? `- ${decision.verdict}red [${decision.reasonCode}]: proposal ${index + 1}` : `- ${decision.verdict === "accept" ? "accepted" : decision.verdict} and staged: proposal ${index + 1}`);
        const outcomes = reviewed.decisions.map((decision, proposalIndex) => ({ proposalIndex, status: preflight.proposals[proposalIndex]?.coveredBy ? "covered" : decision.verdict === "reject" ? "rejected" : decision.verdict === "defer" ? "deferred" : "trigger" in decision && decision.activationDraft.classification === "archival" ? "archival" : "active_advisory", reasonCodes: [preflight.proposals[proposalIndex]?.coveredBy ? "duplicate" : decision.reasonCode], ...(operationByProposal[proposalIndex] ? { memoryId: operationByProposal[proposalIndex] } : {}) }));
        return { content: [{ type: "text", text: `Memory review:\n${lines.join("\n")}` }], details: { memoryReview: true, reviewId: record.reviewId, outcomes } };
      } catch (error: any) { emitMemoryOutcome(reviewerInvoked ? "reviewer_failed" : "preflight_rejected"); return failure(error?.message ?? "Memory review failed; nothing was staged."); }
      finally { if (memoryProposalToken === reservationToken) memoryProposalToken = undefined; if (!proposalCompleted && memoryTaskGeneration === proposalTask) reviewCalledThisTask = false; }
    },
  });
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
        workingSet: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 240 }), { maxItems: 20 })),
        assumptions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 })),
        acceptanceCriteria: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 })),
        todos: Type.Optional(
          Type.Array(Type.String({ maxLength: 120 }), { maxItems: 12 }),
        ),
        planTodos: Type.Optional(Type.Array(Type.Object({
          id: Type.Optional(Type.String({
            maxLength: 120,
            description: "Omit when creating a plan; on revisions, use only an exact ID from the current plan.",
          })),
          text: Type.String({ minLength: 1, maxLength: 120 }),
        }, { additionalProperties: false }), { maxItems: 12 })),
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
        currentTodoId: Type.Optional(Type.String({
          description: "Used only by action state; ignored by set_plan, which generates todo IDs and normally starts the first todo when execution begins.",
        })),
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
        if (p.todos !== undefined && p.planTodos !== undefined)
          throw Error("Use either todos or planTodos, not both.");
        const planItems = p.planTodos ?? (p.todos || []).map((text) => ({ text }));
        const todos = planItems.map((todo) => ({ ...todo, text: todo.text.trim() })).filter((todo) => todo.text);
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
        work.planSummary = p.planSummary?.trim() || todos.map((todo) => todo.text).join("; ") || work.goal;
        if (p.workingSet !== undefined || p.assumptions !== undefined || p.acceptanceCriteria !== undefined)
          work.handoff = {
            workingSet: (p.workingSet || []).map((value) => value.trim()).filter(Boolean).slice(0, 20),
            assumptions: (p.assumptions || []).map((value) => value.trim()).filter(Boolean).slice(0, 12),
            acceptanceCriteria: (p.acceptanceCriteria || []).map((value) => value.trim()).filter(Boolean).slice(0, 12),
          };
        setPlan(work, todos, now);
        if (!planning && !work.currentTodoId) {
          const first = work.todos.find((todo) => todo.status !== "done");
          if (first) updateTodo(work, first.id, "in_progress", now);
        }
        if (planning) {
          work.planRevision = (work.planRevision ?? 0) + 1;
          delete work.approval;
          delete work.revisionFeedback;
        }
        work.updatedAt = now;
        await saveWork();
        if (planning)
          pendingApproval = { runId: work.runId, revision: work.planRevision! };
        tasksVisible = true;
        refresh(ctx);
        return {
          content: [
            {
              type: "text",
              text: planning ? "Plan stored. Await explicit /plan approve." : "Executing task list stored.",
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
  const approvalEntry = (ctx: any, customType: string, token: string) =>
    (ctx.sessionManager.getEntries?.() ?? []).find((entry: any) =>
      entry.customType === customType && (entry.data?.approvalToken === token || entry.details?.approvalToken === token));
  const executionInstruction = "Execute the approved Continuity plan now.";
  const planDialogOptions = { timeout: 0 };
  resumeApproval = async (ctx: any) => {
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
          approvalToken: transition.token,
          model: transition.executorModel,
          ...(transition.thinking ? { thinking: transition.thinking } : {}),
        },
      }, { triggerTurn: false });
    work.mode = "executing";
    work.approved = true;
    work.runId = runId;
    work.timelineId = timelineId;
    work.updatedAt = new Date().toISOString();
    await saveWork();
    pendingApproval = undefined;
    gate(false);
    tasksVisible = true;
    refresh(ctx);
    if (!approvalEntry(ctx, EXECUTION_ENTRY_TYPE, transition.token))
      pi.sendMessage({
        customType: EXECUTION_ENTRY_TYPE,
        content: executionInstruction,
        display: false,
        details: { version: 1, approvalToken: transition.token, runId, timelineId },
      }, { triggerTurn: true });
    return true;
  };
  const approvePlan = (ctx: any, resetContext: boolean, expectedRevision?: number) => withPlanMutation(async () => {
    if (!work?.planSummary || work.mode !== "planning" || !work.todos.length) {
      ctx.ui?.notify?.("No pending stored plan.", "error");
      return false;
    }
    if (expectedRevision !== undefined && work.planRevision !== expectedRevision)
      throw Error("Plan revision changed; refresh and review the latest plan.");
    if (work.approval) return resumeApproval(ctx);
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
      ...(config.executor?.thinking ?? work.baseThinking ? { thinking: config.executor?.thinking ?? work.baseThinking } : {}),
      createdAt: now,
    };
    work.updatedAt = now;
    await saveWork();
    return resumeApproval(ctx);
  });
  const requestPlanChanges = (feedback: string, expectedRevision?: number) => withPlanMutation(async () => {
    const text = feedback.trim();
    if (!work || work.mode !== "planning" || !work.planRevision || !text) throw Error("Plan feedback is unavailable or empty.");
    if (expectedRevision !== undefined && work.planRevision !== expectedRevision)
      throw Error("Plan revision changed; refresh and review the latest plan.");
    if (work.approval) throw Error("Plan approval is already pending.");
    work.revisionFeedback = { revision: work.planRevision, text: text.slice(0, 1_000), createdAt: new Date().toISOString() };
    work.offeredPlanRevision = work.planRevision;
    work.updatedAt = new Date().toISOString();
    pendingApproval = undefined;
    await saveWork();
    refresh(activeSessionContext);
    pi.sendUserMessage(`Plan changes requested for revision ${work.planRevision}:\n${work.revisionFeedback.text}`);
  });
  disposePlanAction = pi.events.on("pi-continuity:plan-action", (request: any) => {
    if (request?.version !== 1 || typeof request.respond !== "function") return;
    if (request.sessionId !== leasedSessionId || request.expectedGeneration !== sessionGeneration || !activeSessionContext) {
      request.respond(Promise.reject(new Error("Continuity plan action is stale or belongs to another session")));
      return;
    }
    const operation = request.action === "approve"
      ? approvePlan(activeSessionContext, request.resetContext === true, request.expectedRevision)
      : request.action === "requestChanges" && typeof request.feedback === "string"
        ? requestPlanChanges(request.feedback, request.expectedRevision)
        : Promise.reject(new Error("Invalid Continuity plan action"));
    request.respond(operation);
  });
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
          delete work.approval;
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
        await requestPlanChanges(feedback);
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
          `Plan this task without modifying project files. Use continuity_update set_plan; put the approach in planSummary, concrete paths/symbols in workingSet, unresolved assumptions or gaps in assumptions, and completion checks in acceptanceCriteria. Keep todos outcome-level: ${value}`,
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
      !["tui", "rpc"].includes(settledCtx.mode) ||
      approvalSelection ||
      work?.mode !== "planning" ||
      work.runId !== token.runId ||
      work.planRevision !== token.revision ||
      work.approval ||
      work.revisionFeedback?.revision === token.revision ||
      !work.planSummary ||
      !work.todos.length
    ) return;
    pendingApproval = undefined;
    const selection = {};
    approvalSelection = selection;
    queueMicrotask(async () => {
      const previousOfferedRevision = work?.offeredPlanRevision;
      const isCurrentPending = () =>
        sessionGeneration === generation &&
        work?.mode === "planning" &&
        work.runId === token.runId &&
        work.planRevision === token.revision &&
        !work.approval &&
        work.revisionFeedback?.revision !== token.revision;
      const requeue = async () => {
        if (!isCurrentPending()) return;
        work!.offeredPlanRevision = previousOfferedRevision;
        pendingApproval = token;
        await saveWork();
      };
      try {
        if (!isCurrentPending()) return;
        work!.offeredPlanRevision = token.revision;
        await saveWork();
        const choice = await settledCtx.ui.select("Plan ready — review structured plan above", [
          "Approve — reset context",
          "Approve — continue current session",
          "Request changes",
        ], planDialogOptions);
        if (!isCurrentPending()) return;
        if (!choice) {
          await requeue();
          return;
        }
        if (choice === "Approve — reset context") {
          if (await approvePlan(actionCtx, true) === false) await requeue();
        } else if (choice === "Approve — continue current session") {
          if (await approvePlan(actionCtx, false) === false) await requeue();
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
        if (approvalSelection === selection) approvalSelection = undefined;
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
        memoryActivationEnabled = sub === "on";
        return void ctx.ui.notify(`Prospective memory activation ${sub} for this session.`, "info");
      }
      project = await resolveProject(ctx.cwd); memoryState = await readMemory(); memoryNotes = memoryState.notes;
      if (sub === "migrate-v4") {
        if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for V4 memory migration.", "error");
        if (!(await ctx.ui.confirm("Migrate Memory V4 to V6?", "A configured Memory Reviewer will normalize preserved V4 facts as archival V6 notes. Backups are retained and /memory rollback remains available until the next V6 write."))) return;
        try {
          const migration = await withMemoryLifecycle(() => runV4Migration(ctx, leasedSessionId));
          legacyMigrationAvailable = await hasPendingV4Migration(root); publishState();
          if (!migration.migrated) return void ctx.ui.notify("No V4 migration was performed; the source is absent, already migrated, or the migration was previously rolled back.", "info");
          emitMemoryOutcome("migration_committed");
          return void ctx.ui.notify(`Memory V4 migrated to V6. ${migration.rejected} record(s) were rejected; use /memory rollback before another V6 write to restore the prior notebook.`, "info");
        } catch (error: any) {
          emitMemoryOutcome("migration_failed");
          legacyMigrationAvailable = await hasPendingV4Migration(root); publishState();
          return void ctx.ui.notify(`Memory V4 migration failed: ${error?.message ?? error}`, "error");
        }
      }
      if (sub === "backups") {
        const directories = [memoryDirectory(), join(root, "memory-v4")], backups: string[] = [];
        for (const directory of directories) for (const name of await readdir(directory, { recursive: true }).catch(() => [] as string[])) if (name.includes("backup") || name.includes("reset-unsupported") || name.includes("corrupt") || name.includes("pre-migration") || name.startsWith("state-v5-") || name.startsWith("memory-v4") || name.startsWith("candidates-v4")) backups.push(join(directory, name));
        return void ctx.ui.notify(backups.join("\n") || "No memory backups.", "info");
      }
      if (sub === "rollback") {
        const journal = await readJson<MigrationJournal | undefined>(paths().migration, undefined, (value) => value === undefined || isMigrationJournal(value));
        const v5Journal = await readV5MigrationJournal();
        if ((!journal || journal.status !== "activated" || journal.activatedStateRevision !== memoryState.revision || !journal.preMigrationBackup)
          && v5Journal?.status === "activated" && v5Journal.activatedRevision === memoryState.revision) {
          if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory rollback.", "error");
          if (!(await ctx.ui.confirm("Rollback Memory V5 migration?", "This removes the generated V6 notebook while preserving the byte-exact V5 source and backup."))) return;
          await withMemoryLifecycle(() => withStateLock(memoryDirectory(), async () => {
            const latest = await readMemory();
            if (latest.revision !== v5Journal.activatedRevision) throw Error("Memory changed after V5 migration; rollback requires manual reconciliation.");
            const backupRoot = resolve(memoryDirectory(), "backups"), backupPath = resolve(v5Journal.backupPath), rel = relative(backupRoot, backupPath);
            if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw Error("V5 migration backup path is outside the protected backup directory.");
            const raw = await readFile(backupPath, "utf8");
            if (sha256(raw) !== v5Journal.sourceSha256) throw Error("V5 migration backup is stale or corrupt; rollback aborted.");
            const next = { ...emptyMemoryState(), revision: latest.revision + 1, updatedAt: new Date().toISOString() };
            await writeMemory(next); memoryState = next; memoryNotes = [];
            await writeJsonAtomic(paths().v6Migration, { ...v5Journal, status: "rolled_back", rolledBackAt: new Date().toISOString() } satisfies V5MigrationJournal);
          }));
          publishState(); return void ctx.ui.notify("Memory V5 migration rolled back; the original V5 state remains recoverable.", "info");
        }
        if (!journal || journal.status !== "activated" || journal.activatedStateRevision !== memoryState.revision || !journal.preMigrationBackup) return void ctx.ui.notify("Migration rollback is unavailable after new V6 writes or without an activated migration.", "error");
        if (!ctx.hasUI) return void ctx.ui.notify("Interactive UI required for memory rollback.", "error");
        if (!(await ctx.ui.confirm("Rollback Memory V6 migration?", "This restores the notebook from immediately before migration."))) return;
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
      ctx.ui.notify(`Activation ${memoryActivationEnabled ? "on" : "off"}; ${notesForOwners(memoryNotes, project.owner).length} current-owner notes. Usage: /memory show|migrate-v4|edit user <id>|edit project <id>|forget user <id>|forget project <id>|forget project|owners|backups|rollback|on|off`, "info");
    },
  });
}
