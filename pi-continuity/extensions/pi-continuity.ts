import { randomUUID } from "node:crypto";
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
  isMemoryFile,
  type PendingCandidate,
  type Fact,
} from "../src/memory.ts";
import { assertSafe } from "../src/secrets.ts";
import { blocked, planningTools } from "../src/plan-gate.ts";
import { buildContext } from "../src/context.ts";
import { validateQuestion } from "../src/questions.ts";
import {
  loadConfig,
  parseModelRef,
  saveConfig,
  thinkingLevels,
  type ModelProfile,
  type ThinkingLevel,
} from "../src/config.ts";
import {
  HANDOFF_ENTRY_TYPE,
  RUN_ENTRY_TYPE,
  type RunEntry,
} from "../src/run.ts";
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
    "memory_candidate",
  ] as const),
  MemAction = StringEnum(["add", "replace", "remove"] as const);
export default function (pi: ExtensionAPI) {
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
    parentFacts: Fact[] = [],
    candidates: PendingCandidate[] = [],
    savedTools: string[] | undefined,
    lastPrompt = "",
    tasksVisible = true,
    currentCwd = "",
    latestVerification: any,
    needsVerification = false,
    awaitingClarificationProse = false,
    recentCalls = new Map<string, number[]>(),
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
    memory: join(dir, "memory.json"),
    candidates: join(dir, "candidates.json"),
  });
  const validCandidatesFile = (value: any) =>
    normalizeCandidatesFile(value) !== undefined;
  const readCandidateQueue = async () => {
    const fallback = {
      schemaVersion: 1 as const,
      candidates: [] as PendingCandidate[],
    };
    const loaded = await readJson(
      paths().candidates,
      fallback,
      validCandidatesFile,
    );
    return normalizeCandidatesFile(loaded)!;
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
          ? [
              "Tasks",
              ...work.todos.map(
                (t) =>
                  `${t.status === "done" ? "✓" : t.status === "in_progress" ? "●" : "○"} ${t.text}`,
              ),
            ]
          : undefined,
      );
  };
  const hideTasks = (ctx: any) => {
    if (ctx.mode === "tui") ctx.ui.setWidget("pi-continuity", undefined);
  };
  const compactMemory = async () =>
    withStateLock(dir, async () => {
      const latestFacts = (
          await readJson(
            paths().memory,
            { schemaVersion: 1 as const, facts: [] as Fact[] },
            isMemoryFile,
          )
        ).facts,
        latestCandidates = (await readCandidateQueue()).candidates;
      facts = latestFacts;
      candidates = latestCandidates;
      if (!candidates.length) return;
      const result = compact(facts, candidates, 80);
      facts = result.facts;
      candidates = result.candidates;
      await writeJson(paths().memory, {
        schemaVersion: 1,
        facts,
        updatedAt: new Date().toISOString(),
      });
      await writeJson(paths().candidates, {
        schemaVersion: 1,
        candidates,
      });
    });
  const gate = (on: boolean) => {
    if (on) savedTools ??= pi.getActiveTools();
    let coordinated = false;
    pi.events.emit("pi-conductor:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-continuity",
      managedTools: ["continuity_update"],
      enabledTools: ["continuity_update"],
      ...(on ? { allowOnly: planningTools() } : {}),
      ...(!on && savedTools ? { restoreTools: savedTools } : {}),
      acknowledge: () => { coordinated = true; },
    });
    if (coordinated) {
      if (!on) savedTools = undefined;
      return;
    }
    if (on) {
      const allowed = new Set(planningTools());
      pi.setActiveTools(pi.getActiveTools().filter((tool) => allowed.has(tool)));
    } else if (savedTools) {
      pi.setActiveTools([...new Set([
        ...pi.getActiveTools(),
        ...savedTools,
        "continuity_update",
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
    recentCalls.clear();
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
    facts = (
      await readJson(p.memory, { schemaVersion: 1 as const, facts: [] as Fact[] }, isMemoryFile)
    ).facts;
    candidates = (await readCandidateQueue()).candidates;
    const parent = workspace.parentId
      ? all.find((item) => item.id === workspace!.parentId)
      : undefined;
    parentFacts = parent
      ? (
          await readJson(
            join(root, "workspaces", parent.id, "memory.json"),
            { schemaVersion: 1 as const, facts: [] as Fact[] },
            isMemoryFile,
          )
        ).facts
      : [];
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
    pi.events.emit("pi-conductor:tool-policy", {
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
  pi.on("tool_call", (event, ctx) => {
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
    if (["write", "edit", "bash", "heartbeat_start"].includes(event.toolName)) {
      latestVerification = undefined;
      needsVerification = true;
    }
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") lastPrompt = event.text;
  });
  pi.on("context", (event) => {
    const activeWork =
      work && !["handed_off", "completed", "cancelled"].includes(work.mode)
        ? work
        : undefined;
    const text = buildContext(activeWork, facts, lastPrompt, 900, parentFacts);
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
    name: "continuity_update",
    label: "Continuity Update",
    description:
      "Update plan, todos, state, clarification, or durable-memory candidate.",
    executionMode: "sequential",
    promptGuidelines: [
      "For every non-trivial multi-step task, call continuity_update set_plan with brief todos before execution even when user did not invoke /plan; this creates an executing task list without activating the planning gate. During explicit planning use clarify only for unresolved user decisions, then set_plan. When planning used Scout, put compact actionable anchors in planSummary: relevant paths, symbols, line ranges, assumptions, and unresolved gaps; do not copy the raw Scout report. During execution, use clarify only for a new blocking user decision that cannot be safely inferred, only as the sole tool call at a safe checkpoint; prefer asking before mutation, stabilize any atomic operation first, and never re-ask an answered question without new evidence. During execution, use exact todo IDs from Continuity context: mark one todo in_progress before work, then mark it done immediately after verification when repository mutation occurred. Skip Verify for read-only work. Run Verify and all nonterminal continuity updates in tool-only assistant turns before the final response. Once every todo is done and verification has passed when required, write the final user-facing response with no tool calls; Continuity completes automatically. Do not call tools after final text. Keep completion true for explicit allowUnverified fallback or compatibility only; it still requires preceding response text. Record concise failures/next action. Propose memory only when all three hold: evidence supports it (user instruction, verified repository/tool evidence, or repeated observation); it is likely true and useful in future sessions; it changes a future decision or avoids repeated work. Include evidence in source. Good candidates include user preferences, validated commands, project conventions, canonical paths, architecture boundaries, recurring warnings, and durable tool limitations. Never save task progress, guesses, one-time errors, temporary file state, generic facts, duplicates, or secrets. Reuse stable keys; add and replace both set one fact per key.",
    ],
    renderShell: "self",
    renderCall: () => new Container(),
    renderResult: (result, _options, theme) => {
      const item = result.content.find((content) => content.type === "text");
      const text = item?.type === "text" ? item.text : undefined;
      if (text?.startsWith("Continuity circuit breaker"))
        return new Text(theme.fg("warning", "⚠ Continuity loop stopped"), 0, 0);
      return text?.startsWith("Work completed") || text?.startsWith("Work already completed")
        ? new Text(theme.fg("success", "✓ Task completed"), 0, 0)
        : new Container();
    },
    parameters: Type.Object(
      {
        action: Action,
        question: Type.Optional(Type.String({ maxLength: 500 })),
        options: Type.Optional(
          Type.Array(
            Type.Object({
              label: Type.String({ maxLength: 120 }),
              description: Type.Optional(Type.String({ maxLength: 240 })),
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
        status: Type.Optional(Status),
        currentTodoId: Type.Optional(Type.String()),
        latestFailure: Type.Optional(Type.String({ maxLength: 1000 })),
        nextAction: Type.Optional(Type.String({ maxLength: 1000 })),        completion: Type.Optional(Type.Boolean()),
        allowUnverified: Type.Optional(Type.Boolean({ description: "Explicitly allow completion only when Verify reports clean or no declared checks." })),
        key: Type.Optional(Type.String({ maxLength: 200 })),        kind: Type.Optional(Kind),
        text: Type.Optional(Type.String({ maxLength: 1000 })),
        source: Type.Optional(Type.String({ maxLength: 500 })),        confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        memoryAction: Type.Optional(MemAction),
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
          return {
            content: [
              { type: "text", text: answer || "No answer selected." },
            ],
          };
        }
        return { content: [{ type: "text", text: choice }] };
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
        work.constraints = (p.constraints || []).slice(0, 12);
        work.planSummary = p.planSummary?.trim() || todos.join("; ") || work.goal;
        setPlan(work, todos, now);
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
        };
      }
      if (p.action === "memory_candidate") {
        if (
          !p.key ||
          !p.kind ||
          !p.text ||
          !p.source ||
          p.confidence === undefined ||
          !p.memoryAction
        )
          return {
            content: [
              { type: "text", text: "Missing memory candidate fields." },
            ],
          };
        const next = candidate({
          key: p.key,
          kind: p.kind,
          text: p.text,
          source: p.source,
          confidence: p.confidence,
          action: p.memoryAction,
        });
        candidates = await withStateLock(dir, async () =>
          (
            await updateJson(
              paths().candidates,
              { schemaVersion: 1 as const, candidates: [] as PendingCandidate[] },
              (file) => ({
                schemaVersion: 1 as const,
                candidates: [
                  ...normalizeCandidatesFile(file)!.candidates,
                  next,
                ],
              }),
              validCandidatesFile,
            )
          ).candidates,
        );
        return {
          content: [{ type: "text", text: "Memory candidate stored." }],
        };
      }
      if (!work)
        return { content: [{ type: "text", text: "No active work." }] };
      if (p.action === "todo") {
        if (!p.todoId || !p.status || !updateTodo(work, p.todoId, p.status))
          return {
            content: [
              {
                type: "text",
                text: `Unknown todo or status. Valid IDs: ${work.todos.map((t) => t.id).join(", ") || "none"}.`,
              },
            ],
          };
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
          return void ctx.ui.notify("No active conductor run.", "error");
        pi.appendEntry(RUN_ENTRY_TYPE, {
          version: 1,
          runId: work.runId,
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
        const run: RunEntry = {
          version: 1,
          runId: childWork.runId ?? randomUUID(),
          role: "executor",
          parentSessionId: sourceSessionId,
          createdAt: now,
        };
        childWork.runId = run.runId;
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
      work = fresh(value);
      work.runId = randomUUID();
      work.baseModel = baseModel;
      work.baseThinking = baseThinking;
      const run: RunEntry = {
        version: 1,
        runId: work.runId,
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
        const choice = await settledCtx.ui.select("Plan ready", [
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
    description: "Inspect, compact, or forget workspace memory",
    handler: async (args, ctx) => {
      const sub = args.trim();
      if (sub === "compact") {
        await compactMemory();
        ctx.ui.notify(
          `Applied memory candidates. ${facts.length} facts.`,
          "info",
        );
      } else if (sub === "show")
        ctx.ui.notify(
          facts.map((f) => `${f.key}: ${f.text}`).join("\n") || "No facts.",
          "info",
        );
      else if (sub === "forget workspace") {
        if (
          !ctx.hasUI ||
          !(await ctx.ui.confirm(
            "Forget continuity workspace?",
            workspace?.canonicalPath || ctx.cwd,
          ))
        )
          return;
        await rm(dir, { recursive: true, force: true });
        if (workspace)
          await updateJson<Workspace[]>(
            join(root, "workspaces.json"),
            [],
            (items) =>
              items
                .filter((item) => item.id !== workspace!.id)
                .map((item) =>
                  item.parentId === workspace!.id
                    ? (({ parentId: _parentId, ...rest }) => rest)(item)
                    : item,
                ),
            Array.isArray,
          );
        work = undefined;
        facts = [];
        candidates = [];
        gate(false);
        refresh(ctx);
      } else if (sub.startsWith("forget ")) {
        const key = sub.slice("forget ".length).trim();
        if (!key) return void ctx.ui.notify("Memory key required.", "error");
        let removed = false;
        await withStateLock(dir, async () => {
          const latestFacts = (
              await readJson(
                paths().memory,
                { schemaVersion: 1 as const, facts: [] as Fact[] },
                isMemoryFile,
              )
            ).facts,
            latestCandidates = (await readCandidateQueue()).candidates;
          removed = latestFacts.some((fact) => fact.key === key);
          facts = latestFacts.filter((fact) => fact.key !== key);
          candidates = latestCandidates.filter((item) => item.key !== key);
          await writeJson(paths().memory, {
            schemaVersion: 1,
            facts,
            updatedAt: new Date().toISOString(),
          });
          await writeJson(paths().candidates, {
            schemaVersion: 1,
            candidates,
          });
        });
        ctx.ui.notify(removed ? `Forgot memory ${key}.` : `Memory ${key} not found.`, "info");
      } else
        ctx.ui.notify(
          `${facts.length} facts, ${candidates.length} pending candidates.`,
          "info",
        );
    },
  });
}
