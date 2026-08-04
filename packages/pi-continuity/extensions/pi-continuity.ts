import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import {
  getAgentDir,
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
  withStateLock,
  rm,
  defaultRoot,
} from "../src/storage.ts";
import { isWorkspace, registerWorkspace, type Workspace } from "../src/workspace.ts";
import { pruneOrphanWorkFiles, startSessionGc } from "../src/session-gc.ts";
import {
  candidate,
  compact,
  normalizeCandidatesFile,
  normalizeMemoryFile,
  factsForOwners,
  isMemoryFile,
  MEMORY_SCHEMA_VERSION,
  type PendingCandidate,
  type Fact,
  type Scope,
  type FactStatus,
  factIdentity,
} from "../src/memory.ts";
import { assertSafe } from "../src/secrets.ts";
import { blocked, planningTools } from "../src/plan-gate.ts";
import { buildContext, promptQuery, shortlistFacts, shortlistResolvedFacts } from "../src/context.ts";
import { validateQuestions } from "../src/questions.ts";
import { askQuestionnaire } from "../src/clarify-ui.ts";
import { captureEvidence, classifyProjectFacts, projectContext, worktreeFingerprint, type ProjectContext } from "../src/worktree.ts";
import {
  loadConfig,
  parseModelRef,
  saveConfig,
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
import { buildContinuityCompaction } from "../src/compaction.ts";
import { canUseBroadRecall, recallSession } from "../src/recall.ts";
import {
  findMovedProjectOwner,
  isOwnerReassociationMarker,
  reassociateOwnerRecords,
  type OwnerReassociationMarker,
} from "../src/owner-reassociation.ts";
const continuityTools = ["continuity_recall", "continuity_update", "memory"];
const isVerificationOnlyTodo = (text: string) =>
  /\b(?:verify|verification|tests?|testing|lint|typecheck|checks?)\b/i.test(text) &&
  !/\b(?:implement|fix|add|update|change|refactor|write|remove|migrate)\b/i.test(text);

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

const Kind = StringEnum([
    "workflow",
    "structure",
    "architecture",
    "warning",
    "preference",
  ] as const),
  Status = StringEnum(["pending", "in_progress", "done", "blocked"] as const),
  Action = StringEnum([
    "clarify",
    "set_plan",
    "todo",
    "state",
  ] as const),
  MemAction = StringEnum(["list", "add", "replace", "remove"] as const),
  ScopeName = StringEnum(["user", "project"] as const),
  RecallScopeName = StringEnum(["execution", "lineage", "all"] as const),
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
    facts: Fact[] = [],
    memoryFacts: Fact[] = [],
    candidates: PendingCandidate[] = [],
    project: ProjectContext | undefined,
    savedTools: string[] | undefined,
    lastPrompt = "",
    memoryEnabled = true,
    memoryInjectionEnabled = true,
    tasksVisible = true,
    currentCwd = "",
    latestVerification: any,
    needsVerification = false,
    awaitingClarificationProse = false,
    recentCalls = new Map<string, number[]>(),
    pendingMutations = new Map<string, string | undefined>(),
    deniedToolCalls = new Set<string>(),
    seenMutationMessages = new Set<string>(),
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
    memory: join(root, "memory-v4", "memory.json"),
    candidates: join(root, "memory-v4", "candidates.json"),
  });
  const memoryDirectory = () => join(root, "memory-v4");
  const validCandidatesFile = (value: any) => normalizeCandidatesFile(value) !== undefined;
  const readCandidateQueue = async () => {
    const fallback = { schemaVersion: MEMORY_SCHEMA_VERSION, candidates: [] as PendingCandidate[] };
    return normalizeCandidatesFile(await readVersionedJson(paths().candidates, fallback, validCandidatesFile))!;
  };
  const readMemory = async () => {
    const fallback = { schemaVersion: MEMORY_SCHEMA_VERSION, facts: [] as Fact[] };
    return normalizeMemoryFile(await readVersionedJson(paths().memory, fallback, isMemoryFile))!;
  };
  const ownerFor = (scope: Scope) =>
    scope === "user" ? "default" : project?.owner;
  const candidatesForOwners = (items: PendingCandidate[], projectOwner: string) =>
    items.filter((item) =>
      (item.scope === "user" && item.owner === "default") ||
      (item.scope === "project" && item.owner === projectOwner),
    );
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
  const visibleFacts = async (latest: string, active?: Work) => {
    project = await resolveProject(currentCwd);
    const query = promptQuery(latest, active);
    if (!query) return { query, facts: [] as Fact[] };
    // Prefilter permissively, classify only relevant project facts, then apply the stricter unchecked gate.
    const owned = factsForOwners(memoryFacts, project.owner), projectFacts = shortlistResolvedFacts(
      owned.filter((fact) => fact.scope === "project"), query, Number.MAX_SAFE_INTEGER,
    );
    const classified = await classifyProjectFacts(currentCwd, projectFacts);
    const statuses = new Map(classified.map((item) => [factIdentity(item.fact), item.status]));
    const applicable = [
      ...owned.filter((fact) => fact.scope === "user"),
      ...classified.filter((item) => item.status === "active" || item.status === "unchecked").map((item) => item.fact),
    ];
    return {
      query,
      facts: shortlistResolvedFacts(applicable, query, 2, (fact) =>
        fact.scope === "project" && statuses.get(factIdentity(fact)) === "active" ? "active" : "unchecked"),
    };
  };
  const reassociateProjectMemory = async () => {
    if (!project || !workspace) return;
    const workspaceFile = join(root, "workspaces.json");
    const markerNames = (await readdir(memoryDirectory()).catch(() => []))
      .filter((name) => name.startsWith("owner-reassociation-") && name.endsWith(".json"))
      .sort()
      .reverse();
    let markerPath: string | undefined;
    let marker: OwnerReassociationMarker | undefined;
    for (const name of markerNames) {
      const path = join(memoryDirectory(), name);
      const value = await readJson<OwnerReassociationMarker | undefined>(
        path,
        undefined,
        (item) => item === undefined || isOwnerReassociationMarker(item),
      );
      if (value && value.status !== "complete" && value.currentOwner === project.owner) {
        markerPath = path;
        marker = value;
        break;
      }
    }
    await withStateLock(memoryDirectory(), async () => {
      const latestFacts = (await readMemory()).facts;
      const latestCandidates = (await readCandidateQueue()).candidates;
      const latestWorkspaces = await readJson<Workspace[]>(workspaceFile, [], (items) =>
        Array.isArray(items) && items.every(isWorkspace));
      if (!marker) {
        const oldOwner = await findMovedProjectOwner(
          currentCwd,
          project!.owner,
          latestWorkspaces,
          latestFacts,
          latestCandidates,
        );
        if (!oldOwner) return;
        const moved = reassociateOwnerRecords(oldOwner, project!.owner, latestFacts, latestCandidates);
        if (!moved.backup.facts.length && !moved.backup.candidates.length) return;
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        markerPath = join(memoryDirectory(), `owner-reassociation-${stamp}-${randomUUID()}.json`);
        marker = {
          ...moved.backup,
          version: 1,
          status: "prepared",
          createdAt: new Date().toISOString(),
        };
        await writeJsonAtomic(markerPath, marker);
      }
      const moved = reassociateOwnerRecords(
        marker.oldOwner,
        marker.currentOwner,
        latestFacts,
        latestCandidates,
      );
      await writeJsonAtomic(paths().memory, {
        schemaVersion: MEMORY_SCHEMA_VERSION,
        facts: moved.facts,
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(paths().candidates, {
        schemaVersion: MEMORY_SCHEMA_VERSION,
        candidates: moved.candidates,
      });
      marker = { ...marker, status: "records-moved" };
      await writeJsonAtomic(markerPath!, marker);
      memoryFacts = moved.facts;
      candidates = moved.candidates;
      facts = memoryFacts;
    });
    if (!marker || marker.status !== "records-moved") return;
    try {
      all = await updateJson<Workspace[]>(workspaceFile, [], (items) =>
        items.map((item) => item.projectOwner === marker!.oldOwner
          ? { ...item, projectOwner: marker!.currentOwner }
          : item), (items) => Array.isArray(items) && items.every(isWorkspace));
      marker = { ...marker, status: "complete" };
      await writeJsonAtomic(markerPath!, marker);
    } catch {
      // The records-moved marker makes workspace remapping retryable on the next startup.
    }
  };
  const projectMemory = () => project
    ? memoryFacts.filter((fact) => fact.scope === "project" && fact.owner === project!.owner)
    : [];
  const globalMemory = () => memoryFacts.filter((fact) =>
    fact.scope === "user" && fact.owner === "default");
  const stateSnapshot = (available = true) =>
    continuityStateSnapshot(
      leasedSessionId,
      stateRevision,
      work,
      available,
      projectMemory(),
      globalMemory(),
    );
  const publishState = (available = true) => {
    stateRevision++;
    pi.events.emit("pi-continuity:state-change", stateSnapshot(available));
  };
  const disposeStateRequest = pi.events.on("pi-continuity:state-request", (request: any) => {
    if (request?.version !== CONTINUITY_STATE_VERSION || request.sessionId !== leasedSessionId || typeof request.respond !== "function") return;
    try { request.respond(stateSnapshot()); } catch { /* State observers cannot affect Continuity. */ }
  });
  const disposeMemoryMutation = pi.events.on("pi-continuity:memory-mutation", (request: any) => {
    if (request?.version !== 1 || request.sessionId !== leasedSessionId || typeof request.respond !== "function") return;
    const operation = (async () => {
      if (!memoryEnabled) throw new Error("Continuity memory is disabled in package settings");
      if (request.action !== "update" && request.action !== "delete") throw new Error("invalid memory action");
      if (typeof request.key !== "string" || !request.key.trim() || request.key.length > 200
        || typeof request.expectedUpdatedAt !== "string") throw new Error("invalid memory target");
      project = await resolveProject(currentCwd);
      await withStateLock(memoryDirectory(), async () => {
        const latest = await readMemory();
        const index = latest.facts.findIndex((fact) =>
          fact.scope === "project" && fact.owner === project!.owner && fact.key === request.key,
        );
        if (index < 0) {
          memoryFacts = latest.facts;
          facts = memoryFacts;
          publishState();
          throw new Error("memory fact is unavailable");
        }
        const existing = latest.facts[index]!;
        if (existing.updatedAt !== request.expectedUpdatedAt) {
          memoryFacts = latest.facts;
          facts = memoryFacts;
          publishState();
          throw new Error("memory fact changed; review the latest value");
        }
        if (request.action === "delete") {
          latest.facts.splice(index, 1);
        } else {
          const checked = candidate({
            action: "replace",
            scope: "project",
            key: existing.key,
            kind: request.kind,
            text: request.text,
            source: existing.source,
            confidence: existing.confidence,
          }, {
            owner: existing.owner,
            scope: "project",
            captureCommit: existing.captureCommit,
            branchAtCapture: existing.branchAtCapture,
            evidencePaths: existing.evidencePaths,
          });
          latest.facts[index] = {
            ...existing,
            kind: checked.kind!,
            text: checked.text!,
            updatedAt: new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString(),
          };
        }
        memoryFacts = latest.facts;
        facts = memoryFacts;
        await writeJson(paths().memory, {
          schemaVersion: MEMORY_SCHEMA_VERSION,
          facts: memoryFacts,
          updatedAt: new Date().toISOString(),
        });
      });
      publishState();
      return { updated: true };
    })();
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
  const compactMemory = async () => {
    if (!memoryEnabled) return;
    return withStateLock(memoryDirectory(), async () => {
      const latestFacts = (await readMemory()).facts,
        latestCandidates = (await readCandidateQueue()).candidates;
      memoryFacts = latestFacts;
      candidates = latestCandidates;
      if (!candidates.length) return;
      project = await resolveProject(currentCwd);
      const currentCandidates = candidatesForOwners(candidates, project!.owner);
      if (!currentCandidates.length) return;
      // Never compact or inspect another owner's project against the current repository.
      const provisional = compact(memoryFacts, currentCandidates, Number.MAX_SAFE_INTEGER).facts;
      const priority = new Map<string, FactStatus>();
      for (const fact of provisional.filter((item) => item.scope === "user" && item.owner === "default"))
        priority.set(factIdentity(fact), "unchecked");
      for (const item of await classifyProjectFacts(currentCwd, provisional.filter((fact) =>
        fact.scope === "project" && fact.owner === project!.owner,
      ))) priority.set(factIdentity(item.fact), item.status);
      // Keep 30 global user facts and 30 facts independently for each project.
      const result = compact(memoryFacts, currentCandidates, 30, priority);
      memoryFacts = result.facts;
      facts = memoryFacts;
      candidates = latestCandidates.filter((item) => !currentCandidates.includes(item));
      await writeJson(paths().memory, {
        schemaVersion: MEMORY_SCHEMA_VERSION,
        facts: memoryFacts,
        updatedAt: new Date().toISOString(),
      });
      await writeJson(paths().candidates, {
        schemaVersion: MEMORY_SCHEMA_VERSION,
        candidates,
      });
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
    if (event?.version !== 1 || event.cwd !== currentCwd) return;
    latestVerification = event;
    if (event.state === "passed") {
      needsVerification = false;
      const remaining = work?.mode === "executing"
        ? work.todos.filter((todo) => todo.status !== "done")
        : [];
      if (work && remaining.length === 1 && isVerificationOnlyTodo(remaining[0].text)) {
        updateTodo(work, remaining[0].id, "done");
        work.updatedAt = new Date().toISOString();
        void saveWork();
      }
    }
    if (work && event.state === "failed") {
      work.latestFailure = `Verification failed (${event.results?.find((item: any) => item.code !== 0)?.command ?? "unknown check"}).`;
      work.nextAction = "Inspect bounded verification failure; use Scout then Advisor if root cause or approach remains unclear.";
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
    else if (event.state === "completed") updateTodo(work, todo.id, "done");
    else if (["failed", "cancelled", "timed_out"].includes(event.state)) {
      updateTodo(work, todo.id, "blocked");
      work.latestFailure = `Background job ${event.id} ${event.state}.`;
      work.nextAction = "Inspect heartbeat status and retry or revise task.";
    }
    work.updatedAt = new Date().toISOString();
    void saveWork();
  });
  pi.on("session_start", async (_e, ctx) => {
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
    memoryEnabled = (await loadConfig()).memoryEnabled !== false;
    memoryInjectionEnabled = memoryEnabled;
    recentCalls.clear();
    pendingMutations.clear();
    deniedToolCalls.clear();
    seenMutationMessages.clear();
    latestVerification = ([...(ctx.sessionManager.getEntries?.() ?? [])]
      .reverse()
      .find((entry: any) => entry.type === "custom" && entry.customType === "pi-verify-result" && entry.data?.version === 1) as any)
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
    memoryFacts = memoryEnabled ? (await readMemory()).facts : [];
    facts = memoryFacts;
    candidates = memoryEnabled ? (await readCandidateQueue()).candidates : [];
    if (memoryEnabled) await reassociateProjectMemory();
    gate(work?.mode === "planning");
    tasksVisible = true;
    refresh(ctx);
    publishState();
  });
  pi.on("session_shutdown", async () => {
    sessionGeneration++;
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
  });
  pi.on("agent_start", (_e, ctx) => {
    awaitingClarificationProse = false;
    tasksVisible ? refresh(ctx) : hideTasks(ctx);
  });
  pi.on("agent_settled", async (_e, ctx) => {
    tasksVisible = false;
    hideTasks(ctx);
    await compactMemory();
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
    if ((event.toolName === "bash" && !sharedWorktreeObserver) || event.toolName === "grunt")
      pendingMutations.set(event.toolCallId, await worktreeFingerprint(ctx.cwd));
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
    if (event.source !== "extension") lastPrompt = event.text;
  });
  const activeWork = () =>
    work && !["handed_off", "completed", "cancelled"].includes(work.mode)
      ? work
      : undefined;
  pi.on("session_before_compact", async (event) => {
    const active = activeWork();
    if (!active) return;
    const missingIdentity = !active.runId || !active.timelineId;
    if (!active.runId) active.runId = randomUUID();
    if (!active.timelineId) active.timelineId = active.runId;
    if (missingIdentity) await saveWork();
    const compaction = buildContinuityCompaction({
      branchEntries: event.branchEntries,
      preparation: event.preparation,
      work: active,
    });
    return compaction ? { compaction } : { cancel: true };
  });
  pi.on("before_agent_start", async () => {
    if (!memoryEnabled || !memoryInjectionEnabled) return;
    const visible = await visibleFacts(lastPrompt, activeWork());
    facts = visible.facts;
    const text = buildContext(undefined, facts, visible.query, 100, [], { resolvedQuery: true });
    if (text)
      return {
        message: {
          customType: "pi-continuity-memory",
          content: text,
          display: false,
        },
      };
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
    const messages = boundary >= 0 ? event.messages.slice(boundary) : event.messages;
    // Execution gets a smaller resume payload; proposed plans retain approval detail.
    const text = buildContext(active, [], lastPrompt, active?.mode === "planning" ? 450 : 300);
    if (!text) return boundary >= 0 ? { messages } : undefined;
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
    description: "Search bounded historical evidence from the current Pi session.",
    promptSnippet: "Explicitly recall sanitized, source-addressed session history.",
    promptGuidelines: [
      "Use only when deterministic compaction omitted a needed historical detail. Results are historical evidence, not current truth.",
      "Default to execution scope. Use lineage or all only when pre-handoff or sibling-branch evidence is explicitly needed.",
      "Recall is read-only and never creates memory. Verify recalled repository claims against current source before relying on them.",
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
    async execute(_i, p, _s, _u, ctx): Promise<any> {
      const active = activeWork();
      if (!active)
        return { content: [{ type: "text", text: "Session recall unavailable: no active Continuity work." }] };
      if (!ctx.sessionManager.getSessionFile?.())
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
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description: "List or query durable memory, or queue an add, replace, or remove candidate.",
    promptSnippet: "Inspect, query, or propose durable memory candidates.",
    executionMode: "sequential",
    promptGuidelines: [
      "Before Verify—or before the final response when Verify is unnecessary—review completed work for up to three stable facts that would change a future decision. Strong candidates are explicit user rules and non-obvious verified workflows, boundaries, or warnings. Use memory list to avoid duplicates, then add or replace valid candidates; continue without a memory call when none qualify. Never save task progress, guesses, temporary state, generic facts, duplicates, or secrets.",
      "Use one fact per stable named key. List memory with a focused query when the current key is uncertain; replace or remove facts only with direct user or repository evidence. Include the source and repository evidencePaths when applicable. Use user scope for cross-project preferences and project scope otherwise.",
    ],
    renderShell: "self",
    renderCall: () => new Container(),
    renderResult: (result, _options, theme) => {
      const item = result.content.find((content) => content.type === "text");
      const text = item?.type === "text" ? item.text : undefined;
      const details = result.details as any;
      if (details?.memoryError)
        return new Text(theme.fg("warning", `⚠ ${text ?? "Invalid memory candidate."}`), 0, 0);
      if (details?.memoryCandidate) {
        const memory = details.memoryCandidate as PendingCandidate;
        return new Text(
          theme.fg("success", `✓ Memory candidate ${memory.action}: ${memory.scope}/${memory.key}`),
          0,
          0,
        );
      }
      if (details?.memoryList)
        return new Text(text ?? "No current-owner memory facts or pending candidates.", 0, 0);
      return new Container();
    },
    parameters: Type.Object({
      action: MemAction,
      query: Type.Optional(Type.String({ maxLength: 500 })),
      key: Type.Optional(Type.String({ maxLength: 200 })),
      kind: Type.Optional(Kind),
      text: Type.Optional(Type.String({ maxLength: 1000 })),
      source: Type.Optional(Type.String({ maxLength: 500 })),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      scope: Type.Optional(ScopeName),
      evidencePaths: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 5 })),
    }, { additionalProperties: false }),
    async execute(_i, p, _s, _u, ctx): Promise<any> {
      if (!memoryEnabled) return {
        content: [{ type: "text", text: "Continuity memory is disabled in package settings." }],
        details: { memoryError: true },
      };
      if (p.action === "list") {
        project = await resolveProject(ctx.cwd);
        // Read without a lock: this action never mutates state and storage writes are atomic.
        memoryFacts = (await readMemory()).facts;
        candidates = (await readCandidateQueue()).candidates;
        const owned = factsForOwners(memoryFacts, project.owner);
        const classified = await classifyProjectFacts(
          ctx.cwd,
          owned.filter((fact) => fact.scope === "project"),
        );
        const applicability = new Map(classified.map((item) => [factIdentity(item.fact), item]));
        const stateFor = (fact: Fact) => fact.scope === "user"
          ? { status: "unchecked" as const, reason: "user memory" }
          : applicability.get(factIdentity(fact))!;
        const shownFacts = p.query?.trim() ? shortlistFacts(owned, p.query, undefined, 30) : owned;
        const pending = candidatesForOwners(candidates, project.owner), shownPending = pending.slice(0, 30);
        const concise = (text: string) => text.length > 200 ? `${text.slice(0, 197)}...` : text;
        const text = !shownFacts.length && !pending.length
          ? p.query?.trim() ? "No matching current-owner memory facts or pending candidates." : "No current-owner memory facts or pending candidates."
          : [
            ...(shownFacts.length ? [
              p.query?.trim() ? "Matching stored facts:" : "Stored facts:",
              ...shownFacts.map((fact) => {
                const state = stateFor(fact);
                return `- ${fact.scope}/${fact.key} [${state.status}: ${concise(state.reason)}]: ${concise(fact.text)}`;
              }),
            ] : []),
            ...(pending.length ? [
              "Pending candidates:",
              ...shownPending.map((item) => `- ${item.scope}/${item.key} [${item.action}]: ${concise(item.text ?? item.source)}`),
              ...(pending.length > shownPending.length ? [`- ${pending.length - shownPending.length} more pending candidates omitted.`] : []),
            ] : []),
          ].join("\n");
        return { content: [{ type: "text", text }], details: { memoryList: true } };
      }
      const requestedScope = (p.scope ?? "project") as Scope;
      if (requestedScope === "project") project = await resolveProject(ctx.cwd);
      const owner = ownerFor(requestedScope)!;
      try {
        if (requestedScope === "user" && p.evidencePaths?.length)
          throw Error("user memory cannot capture project evidence");
        const evidence = requestedScope === "project" && p.evidencePaths?.length
          ? await captureEvidence(ctx.cwd, p.evidencePaths) : undefined;
        const next = candidate({
          key: p.key, kind: p.kind, text: p.text, source: p.source,
          confidence: p.confidence, action: p.action, scope: requestedScope,
        }, {
          scope: requestedScope,
          owner,
          // Callers cannot supply hashes, ownership, or Git provenance.
          ...(requestedScope === "project" ? project : {}),
          ...(evidence?.length ? { evidencePaths: evidence } : {}),
        });
        candidates = await withStateLock(memoryDirectory(), async () => (
          await updateJson(
            paths().candidates,
            { schemaVersion: MEMORY_SCHEMA_VERSION, candidates: [] as PendingCandidate[] },
            (file) => ({
              schemaVersion: MEMORY_SCHEMA_VERSION,
              candidates: [...normalizeCandidatesFile(file)!.candidates, next],
            }),
            validCandidatesFile,
          )
        ).candidates);
        return {
          content: [{ type: "text", text: `Memory candidate ${next.action} queued: ${next.scope}/${next.key}.` }],
          details: { memoryCandidate: next },
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: error?.message ?? "Invalid memory candidate." }],
          details: { memoryError: true },
        };
      }
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
        return {
          content: [
            {
              type: "text",
              text: planning
                ? "Plan stored. Await explicit /plan approve."
                : "Executing task list stored.",
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
        if (p.latestFailure !== undefined) work.latestFailure = p.latestFailure;
        if (p.nextAction !== undefined) work.nextAction = p.nextAction;
      } else if (p.action === "state") {
        work.currentTodoId = p.currentTodoId ?? work.currentTodoId;
        if (p.latestFailure !== undefined) work.latestFailure = p.latestFailure;
        if (p.nextAction !== undefined) work.nextAction = p.nextAction;
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
    description: "Configure planner/executor models or show status",
    handler: async (args, ctx) => {
      const [roleRaw, ...rest] = args.trim().split(/\s+/);
      const role = roleRaw as "planner" | "executor";
      const value = rest.join(" ");
      const config = await loadConfig();
      if (!roleRaw || roleRaw === "status") {
        ctx.ui.notify(
          `Planner: ${config.planner?.model ?? "current session model"} · thinking: ${config.planner?.thinking ?? "current session level"}\nExecutor: ${config.executor?.model ?? "current session model"} · thinking: ${config.executor?.thinking ?? "current session level"}`,
          "info",
        );
        return;
      }
      if (!(["planner", "executor"] as string[]).includes(role)) {
        ctx.ui.notify(
          "Usage: /continuity [status|planner|executor] [provider/model[:thinking]|reset]",
          "info",
        );
        return;
      }
      if (value === "reset") {
        const next = { ...config };
        delete next[role];
        await saveConfig(next);
        ctx.ui.notify(
          `${role} reset; uses current session model and thinking.`,
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
      await saveConfig({
        ...config,
        [role]: {
          model: modelName(model),
          ...(thinking ? { thinking } : {}),
        },
      });
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
    description: "Inspect, compact, or forget project memory",
    handler: async (args, ctx) => {
      if (!memoryEnabled) return void ctx.ui.notify("Continuity memory is disabled in package settings.", "info");
      const sub = args.trim();
      if (sub === "off") {
        memoryInjectionEnabled = false;
        ctx.ui.notify("Memory injection disabled for this session.", "info");
      } else if (sub === "on") {
        memoryInjectionEnabled = true;
        ctx.ui.notify("Memory injection enabled for this session.", "info");
      } else if (sub === "backups") {
        const backups = (await readdir(memoryDirectory()).catch(() => []))
          .filter((name) => name.includes(".reset-unsupported-"))
          .map((name) => join(memoryDirectory(), name));
        ctx.ui.notify(backups.join("\n") || "No memory reset backups.", "info");
      } else if (sub === "compact") {
        project = await resolveProject(ctx.cwd);
        await compactMemory();
        ctx.ui.notify(
          `Applied memory candidates. ${factsForOwners(memoryFacts, project.owner).length} current-owner facts.`,
          "info",
        );
      } else if (sub === "show") {
        project = await resolveProject(ctx.cwd);
        const owned = factsForOwners(memoryFacts, project.owner), statuses = new Map<string, { status: FactStatus; reason: string }>();
        for (const fact of owned.filter((item) => item.scope === "user")) statuses.set(factIdentity(fact), { status: "unchecked", reason: "user memory" });
        for (const item of await classifyProjectFacts(ctx.cwd, owned.filter((item) => item.scope === "project")))
          statuses.set(factIdentity(item.fact), { status: item.status, reason: item.reason });
        ctx.ui.notify(owned.map((fact) => {
          const state = statuses.get(factIdentity(fact))!;
          const provenance = fact.evidencePaths?.length ? `${fact.evidencePaths.length} evidence file(s)` : fact.captureCommit ? "capture commit" : "no provenance";
          return `${fact.scope}/${fact.key} [${state.status}: ${state.reason}; ${provenance}]: ${fact.text}`;
        }).join("\n") || "No facts.", "info");
      } else if (sub === "owners") {
        project = await resolveProject(ctx.cwd);
        const counts = new Map<string, number>();
        for (const item of [...memoryFacts, ...candidates]) counts.set(item.owner!, (counts.get(item.owner!) ?? 0) + 1);
        ctx.ui.notify([...counts].map(([owner, count]) => `${owner}${owner === project!.owner || owner === "default" ? " (current)" : ""}: ${count}`).join("\n") || "No owners.", "info");
      } else if (sub === "forget project") {
        if (!ctx.hasUI || !(await ctx.ui.confirm("Forget project memory?", workspace?.canonicalPath || ctx.cwd))) return;
        project = await resolveProject(ctx.cwd);
        await withStateLock(memoryDirectory(), async () => {
          const latestFacts = (await readMemory()).facts, latestCandidates = (await readCandidateQueue()).candidates;
          memoryFacts = latestFacts.filter((fact) => fact.scope !== "project" || fact.owner !== project!.owner);
          candidates = latestCandidates.filter((item) => item.scope !== "project" || item.owner !== project!.owner);
          await writeJson(paths().memory, { schemaVersion: MEMORY_SCHEMA_VERSION, facts: memoryFacts, updatedAt: new Date().toISOString() });
          await writeJson(paths().candidates, { schemaVersion: MEMORY_SCHEMA_VERSION, candidates });
        });
        facts = memoryFacts;
      } else if (sub === "forget suspect") {
        if (!ctx.hasUI || !(await ctx.ui.confirm("Forget currently suspect project memory?", workspace?.canonicalPath || ctx.cwd))) return;
        project = await resolveProject(ctx.cwd);
        let removed = 0;
        await withStateLock(memoryDirectory(), async () => {
          const latestFacts = (await readMemory()).facts;
          // Reclassify under the lock; unverifiable facts are deliberately retained.
          const suspect = new Set((await classifyProjectFacts(ctx.cwd, latestFacts.filter((fact) =>
            fact.scope === "project" && fact.owner === project!.owner,
          ))).filter((item) => item.status === "suspect").map((item) => factIdentity(item.fact)));
          removed = suspect.size;
          memoryFacts = latestFacts.filter((fact) => !suspect.has(factIdentity(fact)));
          candidates = (await readCandidateQueue()).candidates.filter((item) => !suspect.has(factIdentity(item)));
          await writeJson(paths().memory, { schemaVersion: MEMORY_SCHEMA_VERSION, facts: memoryFacts, updatedAt: new Date().toISOString() });
          await writeJson(paths().candidates, { schemaVersion: MEMORY_SCHEMA_VERSION, candidates });
        });
        facts = memoryFacts;
        ctx.ui.notify(`Forgot ${removed} suspect memory fact(s).`, "info");
      } else if (sub.startsWith("forget owner ")) {
        const owner = sub.slice("forget owner ".length).trim();
        if (!owner) return void ctx.ui.notify("Owner ID required.", "error");
        if (!ctx.hasUI || !(await ctx.ui.confirm("Forget owner memory?", owner))) return;
        await withStateLock(memoryDirectory(), async () => {
          memoryFacts = (await readMemory()).facts.filter((fact) => fact.owner !== owner);
          candidates = (await readCandidateQueue()).candidates.filter((item) => item.owner !== owner);
          await writeJson(paths().memory, { schemaVersion: MEMORY_SCHEMA_VERSION, facts: memoryFacts, updatedAt: new Date().toISOString() });
          await writeJson(paths().candidates, { schemaVersion: MEMORY_SCHEMA_VERSION, candidates });
        });
        facts = memoryFacts;
      } else if (sub.startsWith("forget ")) {
        const target = sub.slice("forget ".length).trim();
        const match = /^(user|project)\s+(.+)$/.exec(target);
        const scope = (match?.[1] ?? "project") as Scope, key = (match?.[2] ?? target).trim();
        if (!key) return void ctx.ui.notify("Memory key required.", "error");
        project = await resolveProject(ctx.cwd);
        const owner = scope === "user" ? "default" : project.owner;
        let removed = false;
        await withStateLock(memoryDirectory(), async () => {
          const latestFacts = (await readMemory()).facts, latestCandidates = (await readCandidateQueue()).candidates;
          removed = latestFacts.some((fact) => fact.scope === scope && fact.owner === owner && fact.key === key);
          memoryFacts = latestFacts.filter((fact) => fact.scope !== scope || fact.owner !== owner || fact.key !== key);
          candidates = latestCandidates.filter((item) => item.scope !== scope || item.owner !== owner || item.key !== key);
          await writeJson(paths().memory, { schemaVersion: MEMORY_SCHEMA_VERSION, facts: memoryFacts, updatedAt: new Date().toISOString() });
          await writeJson(paths().candidates, { schemaVersion: MEMORY_SCHEMA_VERSION, candidates });
        });
        facts = memoryFacts;
        ctx.ui.notify(removed ? `Forgot memory ${scope}/${key}.` : `Memory ${scope}/${key} not found.`, "info");
      } else {
        // `facts` is a transient injection shortlist; status must reload durable state.
        project = await resolveProject(ctx.cwd);
        memoryFacts = (await readMemory()).facts;
        candidates = (await readCandidateQueue()).candidates;
        const owned = factsForOwners(memoryFacts, project.owner);
        const projectFacts = owned.filter((fact) => fact.scope === "project");
        const statuses = await classifyProjectFacts(ctx.cwd, projectFacts);
        const active = statuses.filter((item) => item.status === "active").length;
        const unchecked = owned.filter((fact) => fact.scope === "user").length +
          statuses.filter((item) => item.status === "unchecked").length;
        const visible = active + unchecked;
        const pending = candidatesForOwners(candidates, project.owner).length;
        ctx.ui.notify(
          `Injection ${memoryInjectionEnabled ? "on" : "off"}; ${owned.length} current-owner stored facts, ${visible} visible (active/unchecked: ${active}/${unchecked}), ${pending} current-owner pending candidate${pending === 1 ? "" : "s"} (normally compacted at settlement).`,
          "info",
        );
      }
    },
  });
}
