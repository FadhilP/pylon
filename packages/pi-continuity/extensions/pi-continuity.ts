import { randomUUID } from "node:crypto";
import { readFile, readdir, rename } from "node:fs/promises";
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
  updateJson,
  withStateLock,
  rm,
  defaultRoot,
} from "../src/storage.ts";
import { registerWorkspace, type Workspace } from "../src/workspace.ts";
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
import { buildContext, shortlistFacts, type MemoryNotice } from "../src/context.ts";
import { validateQuestion } from "../src/questions.ts";
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
  ScopeName = StringEnum(["user", "project"] as const);
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
    memoryInjectionEnabled = true,
    tasksVisible = true,
    currentCwd = "",
    latestVerification: any,
    needsVerification = false,
    awaitingClarificationProse = false,
    recentCalls = new Map<string, number[]>(),
    pendingBash = new Map<string, string | undefined>(),
    pendingApproval: { runId?: string; revision: number } | undefined,
    approvalContext: any,
    approvalSelectionOpen = false,
    sessionGeneration = 0,
    schedulePlanApproval = (_ctx: any) => {};
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
  const hasUnsafeExecutionClarificationBatch = (ctx: any) => {
    if (work?.mode !== "executing") return false;
    const calls = assistantContent(ctx).filter((part: any) => part?.type === "toolCall");
    return calls.length > 1 && calls.some(
      (part: any) =>
        part.name === "continuity_update" && part.arguments?.action === "clarify",
    );
  };
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
  // Experimental schemas deliberately start clean rather than silently migrating.
  const resetLegacyWorkspaceMemory = async () => {
    for (const legacyShared of [join(root, "memory-v2"), join(root, "memory-v3")]) await rename(legacyShared, `${legacyShared}.reset-unsupported-${randomUUID()}`).catch((error: any) => {
      if (error?.code !== "ENOENT") throw error;
    });
    for (const name of ["memory.json", "candidates.json"]) {
      const path = join(dir, name);
      try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (value?.schemaVersion !== MEMORY_SCHEMA_VERSION)
          await rename(path, `${path}.reset-unsupported-${randomUUID()}`);
      } catch (error: any) {
        if (error?.code !== "ENOENT")
          await rename(path, `${path}.reset-unsupported-${randomUUID()}`).catch(() => {});
      }
    }
  };
  const visibleFacts = async (query: string, active?: Work) => {
    project = await resolveProject(currentCwd);
    // Classify the complete bounded relevant pool before final three-slot selection.
    const owned = factsForOwners(memoryFacts, project.owner), projectFacts = shortlistFacts(
      owned.filter((fact) => fact.scope === "project"), query, active, 30,
    );
    const classified = await classifyProjectFacts(currentCwd, projectFacts);
    const notices: MemoryNotice[] = classified
      .filter((item) => item.status === "suspect" || item.status === "unverifiable")
      .slice(0, 2)
      .map((item) => ({ key: item.fact.key, status: item.status as "suspect" | "unverifiable", reason: item.reason }));
    return {
      facts: [...owned.filter((fact) => fact.scope === "user"), ...classified
        .filter((item) => item.status === "active" || item.status === "unchecked")
        .map((item) => item.fact)],
      notices,
    };
  };
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
  const compactMemory = async () =>
    withStateLock(memoryDirectory(), async () => {
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
  const gate = (on: boolean) => {
    if (on) savedTools ??= pi.getActiveTools();
    let coordinated = false;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-continuity",
      managedTools: ["continuity_update", "memory"],
      enabledTools: ["continuity_update", "memory"],
      ...(on ? { allowOnly: planningTools() } : {}),
      ...(!on && savedTools ? { restoreTools: [...new Set([
        ...savedTools,
        "continuity_update",
        "memory",
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
        ...pi.getActiveTools().filter((tool) => allowed.has(tool)),
        "continuity_update",
        "memory",
      ])]);
    } else if (savedTools) {
      pi.setActiveTools([...new Set([
        ...pi.getActiveTools(),
        ...savedTools,
        "continuity_update",
        "memory",
      ])]);
      savedTools = undefined;
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
  const disposeVerify = pi.events.on("pi-verify:result", (event: any) => {
    if (event?.version !== 1 || event.cwd !== currentCwd) return;
    latestVerification = event;
    if (event.state === "passed") needsVerification = false;
    if (work && event.state === "failed") {
      work.latestFailure = `Verification failed (${event.results?.find((item: any) => item.code !== 0)?.command ?? "unknown check"}).`;
      work.nextAction = "Inspect bounded verification failure; use Scout then Advisor if root cause or approach remains unclear.";
      work.updatedAt = new Date().toISOString();
      void saveWork();
    }
  });
  const disposeHeartbeat = pi.events.on("pi-heartbeat:job", (event: any) => {
    if (event?.version !== 1 || event.cwd !== currentCwd || !event.todoId || !work) return;
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
    currentCwd = ctx.cwd;
    memoryInjectionEnabled = true;
    recentCalls.clear();
    pendingBash.clear();
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
      sessionWorkFile(ctx.sessionManager.getSessionId()),
    );
    const p = paths();
    await resetLegacyWorkspaceMemory();
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
    memoryFacts = (await readMemory()).facts;
    facts = memoryFacts;
    candidates = (await readCandidateQueue()).candidates;
    gate(work?.mode === "planning");
    tasksVisible = true;
    refresh(ctx);
  });
  pi.on("session_shutdown", () => {
    sessionGeneration++;
    pendingApproval = undefined;
    approvalContext = undefined;
    disposeInstanceClaim();
    disposeVerify();
    disposeHeartbeat();
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "unregister",
      owner: "pi-continuity",
    });
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
      work?.mode !== "executing" ||
      awaitingClarificationProse ||
      hasRemainingTodos(work) ||
      needsVerification ||
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
    if (hasUnsafeExecutionClarificationBatch(ctx))
      return {
        block: true,
        reason: "Execution clarification must be the only tool call in its assistant message. Retry it alone at a safe checkpoint.",
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
    if (
      event.toolName === "continuity_update" &&
      input.action === "state" &&
      input.completion === true &&
      !hasReplyBeforeCompletion(event, ctx)
    )
      return {
        block: true,
        reason: "Write the final user-facing response first, then retry completion as the last tool call in the same assistant message.",
      };
    if (event.toolName === "bash") {
      pendingBash.set(
        event.toolCallId,
        await worktreeFingerprint(ctx.cwd),
      );
    } else if (["write", "edit", "heartbeat_start"].includes(event.toolName)) {
      latestVerification = undefined;
      needsVerification = true;
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const before = pendingBash.get(event.toolCallId);
    pendingBash.delete(event.toolCallId);
    const after = await worktreeFingerprint(ctx.cwd);
    if (!before || !after || before !== after) {
      latestVerification = undefined;
      needsVerification = true;
    }
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") lastPrompt = event.text;
  });
  const activeWork = () =>
    work && !["handed_off", "completed", "cancelled"].includes(work.mode)
      ? work
      : undefined;
  pi.on("before_agent_start", async () => {
    if (!memoryInjectionEnabled) return;
    const active = activeWork();
    const query = `${lastPrompt} ${active?.goal || ""} ${active?.todos.find((todo) => todo.id === active.currentTodoId)?.text || ""}`;
    const visible = await visibleFacts(query, active);
    facts = visible.facts;
    const text = buildContext(undefined, facts, query, 250, [], visible.notices);
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
    const text = buildContext(activeWork(), [], lastPrompt, 450);
    if (text)
      return {
        messages: [
          ...event.messages,
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
    name: "memory",
    label: "Memory",
    description: "List durable memory or queue an add, replace, or remove candidate.",
    promptSnippet: "Inspect or propose durable memory candidates.",
    executionMode: "sequential",
    promptGuidelines: [
      "Make one pre-final durable-memory assessment; this does not require creating a candidate, and if no candidate is valid, do nothing. Use memory add, replace, or remove only when all three hold: evidence supports it (user instruction, verified repository/tool evidence, or repeated observation); it is likely true and useful in future sessions; it changes a future decision or avoids repeated work. Use memory list when an existing key is unknown or duplicate risk exists. Prefer named stable keys for commands and conventions; reuse stable keys, and add and replace both set one fact per key. Include evidence in source. Good candidates include user preferences, validated commands, project conventions, canonical paths, architecture boundaries, recurring warnings, and durable tool limitations. Never save task progress, guesses, one-time errors, temporary file state, generic facts, duplicates, or secrets. With direct user or current repository evidence, replace a fact when it remains true or a newer truth is known, and remove it when contradicted; otherwise leave suspect facts alone. Supply evidencePaths when repository files support a project-memory mutation. Remove requires the exact key and a nonempty source/reason. Use user scope only for durable cross-project preferences; use project scope for everything project-specific.",
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
      key: Type.Optional(Type.String({ maxLength: 200 })),
      kind: Type.Optional(Kind),
      text: Type.Optional(Type.String({ maxLength: 1000 })),
      source: Type.Optional(Type.String({ maxLength: 500 })),
      confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      scope: Type.Optional(ScopeName),
      evidencePaths: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 5 })),
    }, { additionalProperties: false }),
    async execute(_i, p, _s, _u, ctx): Promise<any> {
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
        const pending = candidatesForOwners(candidates, project.owner), shownPending = pending.slice(0, 30);
        const concise = (text: string) => text.length > 200 ? `${text.slice(0, 197)}...` : text;
        const text = !owned.length && !pending.length
          ? "No current-owner memory facts or pending candidates."
          : [
            ...(owned.length ? [
              "Stored facts:",
              ...owned.map((fact) => {
                const state = fact.scope === "user"
                  ? { status: "unchecked", reason: "user memory" }
                  : applicability.get(factIdentity(fact))!;
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
      "For every non-trivial multi-step task, call continuity_update set_plan with brief todos before execution even when user did not invoke /plan; this creates an executing task list, starts its first todo, and does not activate the planning gate. During explicit planning use clarify only for unresolved user decisions, then set_plan. Clarification questions must ask one concrete decision in plain language, explain why the answer matters in one short sentence when needed, and avoid vague prompts such as 'What do you prefer?'. Use short distinct option labels; descriptions state the practical outcome or tradeoff. Put the recommended option first and say why in its description. Do not ask questions answerable from repository evidence or safe defaults. During explicit planning, Continuity owns plan presentation: populate goal, planSummary as the approach, constraints, and ordered todos; do not invent a separate plan format. Outside explicit planning, set_plan creates an internal execution task list only; do not present it to the user as a structured plan. When planning used Scout, put compact actionable anchors in planSummary: relevant paths, symbols, line ranges, assumptions, and unresolved gaps; do not copy the raw Scout report. During execution, use clarify only for a new blocking user decision that cannot be safely inferred, only as the sole tool call at a safe checkpoint; prefer asking before mutation, stabilize any atomic operation first, and never re-ask an answered question without new evidence. During execution, use exact todo IDs from Continuity context. Complete current work and start the next todo atomically by passing nextTodoId with status done; omit nextTodoId for the final todo. Mark mutation work done immediately after verification. Skip Verify for read-only work. Run Verify and all nonterminal continuity updates in tool-only assistant turns before the final response. Once every todo is done and verification has passed when required, write the final user-facing response with no tool calls; Continuity completes automatically. Do not call tools after final text. Keep completion true for explicit allowUnverified fallback or compatibility only; it still requires preceding response text. Record concise failures/next action.",
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
        nextTodoId: Type.Optional(
          Type.String({
            description:
              "Pending todo to start atomically when marking current todo done",
          }),
        ),
        status: Type.Optional(Status),
        currentTodoId: Type.Optional(Type.String()),
        latestFailure: Type.Optional(Type.String({ maxLength: 1000 })),
        nextAction: Type.Optional(Type.String({ maxLength: 1000 })),        completion: Type.Optional(Type.Boolean()),
        allowUnverified: Type.Optional(Type.Boolean({ description: "Explicitly allow completion only when Verify reports clean or no declared checks." })),
      },
      { additionalProperties: false },
    ),
    async execute(_i, p, _s, _u, ctx): Promise<any> {
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
        if (work?.mode !== "planning" && !executing)
          return {
            content: [
              {
                type: "text",
                text: "Clarification requires active planning or execution work.",
              },
            ],
          };
        validateQuestion(p.question || "", p.options || []);
        if (!ctx.hasUI) {
          if (executing) awaitingClarificationProse = true;
          const options = (p.options || []).map((o, index) =>
            `${index + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `Ask user in prose and wait: ${p.question}\n${options.join("\n")}`,
              },
            ],
          };
        }
        const labels = [
          ...(p.options || []).map((o) =>
            o.description ? `${o.label} — ${o.description}` : o.label,
          ),
          "Write a different answer…",
        ];
        const choice = await ctx.ui.select(p.question!, labels);
        if (!choice) {
          if (executing) {
            ctx.abort();
            return {
              content: [{ type: "text", text: "No answer selected. Execution stopped." }],
              terminate: true,
            };
          }
          return { content: [{ type: "text", text: "No answer selected." }] };
        }
        if (choice === "Write a different answer…") {
          const answer = (await ctx.ui.editor("Custom answer", ""))?.trim();
          if (!answer && executing) {
            ctx.abort();
            return {
              content: [{ type: "text", text: "No answer selected. Execution stopped." }],
              terminate: true,
            };
          }
          const selected = answer || "No answer selected.";
          return {
            content: [{ type: "text", text: selected }],
            details: { clarification: { question: p.question, answer: selected } },
          };
        }
        return {
          content: [{ type: "text", text: choice }],
          details: { clarification: { question: p.question, answer: choice } },
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
        const todo = p.todoId && work.todos.find((item) => item.id === p.todoId),
          next = p.nextTodoId && work.todos.find((item) => item.id === p.nextTodoId);
        if (!todo || !p.status || (p.nextTodoId && (
          p.status !== "done" ||
          !next ||
          next.id === todo.id ||
          next.status !== "pending"
        )))
          return {
            content: [
              {
                type: "text",
                text: `Unknown or invalid todo transition. Valid IDs: ${work.todos.map((t) => t.id).join(", ") || "none"}.`,
              },
            ],
          };
        const now = new Date().toISOString();
        updateTodo(work, todo.id, p.status, now);
        if (next) updateTodo(work, next.id, "in_progress", now);
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
            };
          if (needsVerification && latestVerification?.state !== "passed") {
            const explicitlyAllowed = p.allowUnverified && ["clean", "no_checks"].includes(latestVerification?.state);
            if (!explicitlyAllowed)
              return {
                content: [
                  {
                    type: "text",
                    text: ["clean", "no_checks"].includes(latestVerification?.state)
                      ? "Verification is unavailable for this worktree. Repeat completion with allowUnverified only after reviewing that limitation."
                      : "Cannot complete until current-session verification passes.",
                  },
                ],
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
      }
      work.updatedAt = new Date().toISOString();
      await saveWork();
      refresh(ctx);
      return { content: [{ type: "text", text: "Continuity state updated." }] };
    },
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
        if (!work?.planSummary)
          return void ctx.ui.notify("No stored plan.", "error");
        const config = await loadConfig();
        const executor = await configuredModel(
          ctx,
          config.executor,
          work.baseModel,
        );
        if (!executor || !(await pi.setModel(executor)))
          return void ctx.ui.notify("Executor model unavailable.", "error");
        const thinking = config.executor?.thinking ?? work.baseThinking;
        if (thinking) pi.setThinkingLevel(thinking as ThinkingLevel);
        work.mode = "executing";
        work.approved = true;
        pendingApproval = undefined;
        work.updatedAt = new Date().toISOString();
        await saveWork();
        if (work.runId)
          pi.appendEntry(RUN_ENTRY_TYPE, {
            version: 1,
            runId: work.runId,
            timelineId: work.timelineId ?? work.runId,
            role: "executor",
            parentSessionId: ctx.sessionManager.getSessionId(),
            createdAt: new Date().toISOString(),
          } satisfies RunEntry);
        gate(false);
        tasksVisible = true;
        refresh(ctx);
        pi.sendUserMessage(
          "Execute approved stored plan in current session. Track and verify todos.",
        );
        return;
      }
      if (value === "approve") {
        if (!work?.planSummary)
          return void ctx.ui.notify("No stored plan.", "error");
        const config = await loadConfig();
        const executor = await configuredModel(
          ctx,
          config.executor,
          work.baseModel,
        );
        if (!executor)
          return void ctx.ui.notify("Executor model unavailable.", "error");
        const sourceSessionId = ctx.sessionManager.getSessionId();
        const sourceSessionFile = ctx.sessionManager.getSessionFile();
        const sourceWorkFile = workFile;
        const now = new Date().toISOString();
        pendingApproval = undefined;
        const childWork: Work = {
          ...work,
          mode: "executing",
          approved: true,
          updatedAt: now,
        };
        const runId = childWork.runId ?? randomUUID();
        const run: RunEntry = {
          version: 1,
          runId,
          timelineId: childWork.timelineId ?? childWork.runId ?? runId,
          role: "executor",
          parentSessionId: sourceSessionId,
          createdAt: now,
        };
        childWork.runId = run.runId;
        childWork.timelineId = run.timelineId ?? run.runId;
        const thinking = config.executor?.thinking ?? work.baseThinking;
        const result = await ctx.newSession({
          parentSession: sourceSessionFile,
          setup: async (sessionManager: any) => {
            sessionManager.appendModelChange(executor.provider, executor.id);
            if (thinking) sessionManager.appendThinkingLevelChange(thinking);
            sessionManager.appendCustomEntry(RUN_ENTRY_TYPE, run);
            sessionManager.appendCustomEntry(HANDOFF_ENTRY_TYPE, {
              version: 1,
              work: childWork,
              model: { provider: executor.provider, id: executor.id },
              ...(thinking ? { thinking } : {}),
            });
          },
          withSession: async (fresh: any) => {
            if (
              fresh.model?.provider !== executor.provider ||
              fresh.model?.id !== executor.id
            )
              throw new Error("Executor model was not selected in child session.");
            await fresh.sendUserMessage(
              "Inspect the current workspace and validate the approved plan's assumptions before editing. Treat paths, symbols, and line ranges in the approved plan as the working set: check them with narrow reads, and call Scout only when repository state changed, anchors are missing, or an unresolved gap requires broader tracing. Execute the plan, track todos, and run fresh verification.",
            );
          },
        });
        if (!result.cancelled) {
          const plannerWork: Work = {
            ...work,
            mode: "handed_off",
            approved: true,
            runId: run.runId,
            updatedAt: new Date().toISOString(),
          };
          await writeJson(sourceWorkFile, plannerWork);
        }
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
          `Plan this task without modifying project files: ${value}`,
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
          "Approve — fresh executor session",
          "Approve — continue current session",
          "Request changes",
        ]);
        if (sessionGeneration !== generation) return;
        if (choice === "Approve — fresh executor session")
          await planCommand.handler("approve", actionCtx);
        else if (choice === "Approve — continue current session")
          await planCommand.handler("approve-current", actionCtx);
        else if (choice === "Request changes") {
          const feedback = await settledCtx.ui.editor("Plan feedback", "");
          if (feedback?.trim() && sessionGeneration === generation)
            pi.sendUserMessage(`Plan changes requested:\n${feedback.trim()}`);
        }
      } catch (error: any) {
        if (
          sessionGeneration === generation &&
          work?.mode === "planning" &&
          work.runId === token.runId &&
          work.planRevision === token.revision
        ) {
          work.offeredPlanRevision = previousOfferedRevision;
          pendingApproval = token;
        }
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
            ctx.modelRegistry.getAvailable().map(modelName),
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
      const sub = args.trim();
      if (sub === "off") {
        memoryInjectionEnabled = false;
        ctx.ui.notify("Memory injection disabled for this session.", "info");
      } else if (sub === "on") {
        memoryInjectionEnabled = true;
        ctx.ui.notify("Memory injection enabled for this session.", "info");
      } else if (sub === "backups") {
        const shared = (await readdir(root).catch(() => []))
            .filter((name) => name.includes(".reset-unsupported-")).map((name) => join(root, name)),
          local = (await readdir(dir).catch(() => []))
            .filter((name) => name.includes(".reset-unsupported-")).map((name) => join(dir, name));
        ctx.ui.notify([...shared, ...local].join("\n") || "No memory reset backups.", "info");
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
