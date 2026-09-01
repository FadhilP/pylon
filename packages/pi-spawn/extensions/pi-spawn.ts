import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createBackgroundRuns } from "../src/background.ts";
import { configPath, effectiveConfig, loadConfig, thinkingLevels } from "../src/config.ts";
import { MAX_DEPTH, SPAWN_TOOLS } from "../src/constants.ts";
import { defaultName, failure, isFailure, missingThread, threadListResult, type ToolFailure } from "../src/results.ts";
import { runSpawn } from "../src/runner.ts";
import {
  agentPolicy,
  branchSpawnIds,
  branchSpawnReferences,
  claimSpawnedSession,
  createPrivateAgent,
  createSpawnedSession,
  findSessionForAdoption,
  isThreadActive,
  listPrivateAgents,
  listSpawnedSessions,
  RECENT_THREAD_MAX_TOTAL_CHARS,
  recentThreadTranscript,
  requireParent,
  resultDetails,
  sessionPolicy,
  spawnedHooks,
  threadInfo,
  SessionAdoptionError,
  type AgentPolicy,
  type SpawnHooks,
  type SpawnKind,
  type SpawnMarker,
} from "../src/sessions.ts";
import { createTurnRunner, type RunChild, type TurnRequest } from "../src/turns.ts";
import { invalidInput } from "../src/validate.ts";

const agentActions = ["create", "continue", "status", "cancel", "recent", "list"] as const;
const sessionActions = ["create", "adopt", "continue", "status", "cancel", "list"] as const;
const AGENT_PROMPT_GUIDELINES = [
  "Use spawn_agent for a private, resumable specialist conversation that benefits from an isolated transcript or a fixed model, system prompt, thinking level, or tool allowlist; prefer focused specialist tools for one-shot work they already cover.",
  "When using spawn_agent, create one thread with a self-contained prompt and the narrowest useful policy, then continue that thread by ID for follow-ups because its model, system prompt, thinking level, and tools are immutable.",
  "Set background true only for independent work that should continue across parent turns; set queue true on a background continuation to place it behind an active run owned by this parent. Use status with the returned thread and run IDs to inspect or collect it, or cancel to remove or stop it.",
  "Use spawn_agent recent to inspect bounded recent transcript messages without prompting the child; use list only to recover private thread IDs available from the current parent branch.",
  "Review child responses and workspace changes before relying on them.",
];
const SESSION_PROMPT_GUIDELINES = [
  "Use spawn_session only when the child conversation must be an ordinary Pi session the user can inspect, open, or continue separately; do not use spawn_session as the default delegation tool when a private spawn_agent thread or focused specialist tool is sufficient.",
  "When starting independent work with spawn_session, use create with a self-contained kickoff prompt and a concise purpose-based name; use continue with the returned ID for follow-ups, and use list only to recover sessions available from the current parent branch.",
  "Set background true only for independent work that should continue across parent turns; set queue true on a background continuation to place it behind an active run owned by this parent. Use status with the returned session and run IDs to inspect or collect it, or cancel to remove or stop it.",
  "Set spawn_session project only when the user explicitly requests another project; relative project paths resolve from the current project.",
  "Use spawn_session adopt only when the user explicitly asks to resume an existing session in the current or selected project and provides its exact ID; adopt claims and immediately prompts that existing transcript while preserving its model, name, and native parent metadata.",
  "Do not use spawn_session to customize system instructions, thinking, tools, or extensions because it loads the selected project's normal runtime; never prompt or adopt a session concurrently open in another Pi process.",
];

const threadParameters = {
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Opaque thread ID" })),
  runId: Type.Optional(
    Type.String({ minLength: 1, maxLength: 128, description: "Background run ID returned when background is true" }),
  ),
  prompt: Type.Optional(
    Type.String({ minLength: 1, maxLength: 16_000, description: "Prompt for create, adopt, or continue" }),
  ),
  background: Type.Optional(
    Type.Boolean({ description: "Return immediately and continue this prompt in the background; default false" }),
  ),
  queue: Type.Optional(
    Type.Boolean({
      description: "Queue this background continuation behind active work on the same thread; continue only",
    }),
  ),
};

const createAgentParameters = (allowedThinking: readonly string[] = thinkingLevels) =>
  Type.Object(
    {
      action: StringEnum(agentActions, {
        description:
          "Create, continue, inspect recent messages from, or list private threads available from the current parent branch",
      }),
      ...threadParameters,
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: "Recent transcript messages to return; default 8" }),
      ),
      maxChars: Type.Optional(
        Type.Integer({
          minimum: 80,
          maximum: 2_000,
          description: "Maximum text characters per recent message; default 800",
        }),
      ),
      name: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 200,
          description: "Concise purpose-based display name fixed when the private thread is created",
        }),
      ),
      model: Type.Optional(
        Type.String({
          minLength: 3,
          maxLength: 300,
          description: "Optional provider/model fixed when the private thread is created",
        }),
      ),
      thinking: Type.Optional(
        StringEnum(allowedThinking, { description: "Thinking level fixed when the private thread is created" }),
      ),
      systemPrompt: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 32_000,
          description: "Replacement system prompt fixed when the private thread is created",
        }),
      ),
      tools: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
          maxItems: 32,
          uniqueItems: true,
          description: "Tool allowlist fixed when the private thread is created; an empty list disables all tools",
        }),
      ),
      disableSpecialists: Type.Optional(
        Type.Boolean({ description: "Disable Advisor, Grunt, and Scout in this private thread; default true" }),
      ),
    },
    { additionalProperties: false },
  );

const createSessionParameters = () =>
  Type.Object(
    {
      action: StringEnum(sessionActions, {
        description:
          "Create a session, adopt an existing project session by ID, continue one, or list sessions available from the current parent branch",
      }),
      ...threadParameters,
      name: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 200,
          description: "Concise purpose-based display name for a newly created standard Pi session",
        }),
      ),
      model: Type.Optional(
        Type.String({
          minLength: 3,
          maxLength: 300,
          description: "Optional provider/model fixed when the standard session is created",
        }),
      ),
      project: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 32_768,
          description:
            "Existing project directory for create or adopt; relative paths resolve from the current project, and omission uses the current project",
        }),
      ),
    },
    { additionalProperties: false },
  );

const currentModel = (ctx: any): string | undefined =>
  ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
const availableModels = (ctx: any, allowed?: readonly string[]): string[] => {
  const models = ctx.scopedModels.length
    ? ctx.scopedModels.map(({ model }: any) => model)
    : ctx.modelRegistry.getAvailable();
  const available = [
    ...new Set<string>(
      models
        .filter((model: any) => ctx.modelRegistry.hasConfiguredAuth(model))
        .map((model: any) => `${model.provider}/${model.id}`),
    ),
  ];
  return allowed ? allowed.filter(model => available.includes(model)) : available;
};
const defaultModel = (ctx: any, allowed?: readonly string[]): string | undefined => {
  const available = availableModels(ctx, allowed);
  const current = currentModel(ctx);
  return current && available.includes(current) ? current : available[0];
};
const modelError = (requested: string, ctx: any, allowed?: readonly string[]): string | undefined => {
  const available = availableModels(ctx, allowed);
  if (available.includes(requested)) return;
  const shown = available.slice(0, 20);
  return `Unavailable model: ${requested}.${
    shown.length
      ? ` Available models: ${shown.join(", ")}${available.length > shown.length ? `, and ${available.length - shown.length} more` : ""}.`
      : " No models are currently available."
  }`;
};
const setModelChoices = (parameters: any, models: string[], description: string) => {
  if (!models.length) delete parameters.properties.model;
  else parameters.properties.model = Type.Optional(StringEnum(models, { description }));
};

class ProjectDirectoryError extends Error {}

function projectCwd(currentCwd: string, project?: string): string {
  if (project === undefined) return currentCwd;
  const requested = resolve(currentCwd, project.startsWith("@") ? project.slice(1) : project);
  try {
    const target = realpathSync.native(requested);
    if (statSync(target).isDirectory()) return target;
  } catch {
    /* Report one stable validation error below. */
  }
  throw new ProjectDirectoryError(`Project directory does not exist or is not a directory: ${requested}`);
}

function recentTranscriptResult(
  match: { info: any; manager: any },
  options: { limit?: number; maxChars?: number; totalChars?: number },
) {
  const recent = recentThreadTranscript(match.manager, options);
  const summary = `Private subagent ${match.info.name ?? "Subagent"} (${match.info.id}) recent transcript: ${recent.returned} of ${recent.available} messages.`;
  const output = `${summary}${recent.text ? `\n\n${recent.text}` : "\n\nNo transcript messages."}${recent.truncated ? "\n\n[Transcript truncated.]" : ""}`;
  const outputTruncated = output.length > (options.totalChars ?? RECENT_THREAD_MAX_TOTAL_CHARS);
  return {
    content: [
      {
        type: "text" as const,
        text: outputTruncated
          ? `${output.slice(0, (options.totalChars ?? RECENT_THREAD_MAX_TOTAL_CHARS) - 1)}…`
          : output,
      },
    ],
    details: {
      ...resultDetails("agent", match.info.id),
      action: "recent",
      returned: recent.returned,
      available: recent.available,
      truncated: recent.truncated || outputTruncated,
    },
  };
}

function requestSpawnHooks(pi: ExtensionAPI): SpawnHooks | undefined {
  let hooks: SpawnHooks | undefined;
  pi.events.emit("pylon:spawn-hooks-request", {
    version: 1,
    provide: (value: SpawnHooks) => {
      if (hooks === undefined) hooks = value;
    },
  });
  return hooks;
}

export default async function spawnExtension(
  pi: ExtensionAPI,
  runChild: RunChild = runSpawn,
  agentDir = getAgentDir(),
) {
  const config = effectiveConfig(await loadConfig(configPath(agentDir)));
  const { agentAvailability, sessionAvailability } = config;
  const allowedModels = config.models;
  const allowedThinking: readonly string[] = config.agentThinkingLevels;
  const AgentParameters = createAgentParameters(allowedThinking);
  const SessionParameters = createSessionParameters();
  const executeTurn = createTurnRunner(pi, runChild, { spawnTimeoutMs: config.spawnTimeoutMs });
  const background = createBackgroundRuns(pi, executeTurn);

  // Child-side hooks: replay the parent's spawn instructions inside a spawned standard session.
  pi.on("session_start", (_event, ctx) => {
    if (process.env.PI_SPAWN_CHILD !== "session") return;
    const sessionStart = spawnedHooks(ctx.sessionManager)?.sessionStart;
    if (
      !sessionStart ||
      ctx.sessionManager
        .getBranch()
        .some(entry => entry.type === "custom_message" && entry.customType === sessionStart.customType)
    )
      return;
    pi.sendMessage({ customType: sessionStart.customType, content: sessionStart.content, display: false });
  });
  pi.on("session_compact", (event, ctx) => {
    if (process.env.PI_SPAWN_CHILD !== "session") return;
    const hook = spawnedHooks(ctx.sessionManager)?.sessionCompact;
    const compactionEntryId = event.compactionEntry?.id;
    if (
      !hook ||
      !compactionEntryId ||
      ctx.sessionManager.getBranch().some(entry => {
        if (entry.type !== "custom_message") return false;
        const value = entry as any;
        return (
          (value.customType === hook.customType || value.message?.customType === hook.customType) &&
          (value.details?.compactionEntryId === compactionEntryId ||
            value.message?.details?.compactionEntryId === compactionEntryId)
        );
      })
    )
      return;
    pi.sendMessage({
      customType: hook.customType,
      content: hook.content,
      display: false,
      details: { version: 1, compactionEntryId },
    });
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (process.env.PI_SPAWN_CHILD !== "session") return;
    const content = spawnedHooks(ctx.sessionManager)?.beforeAgentStart;
    if (content) return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  });

  /**
   * Shared validation both spawn tools run before dispatching an action. `branchIndex` builds the
   * set of children reachable from the current parent branch, which each kind indexes differently.
   */
  const preflight = <Index>(
    kind: SpawnKind,
    params: any,
    ctx: any,
    branchIndex: (manager: any) => Index,
  ): { parent: any; allowed: Index; selectedModel?: string } | ToolFailure => {
    const invalid = invalidInput(kind, params);
    if (invalid) return failure("invalid", invalid);
    const creating = params.action === "create";
    const selectedModel = creating ? (params.model ?? defaultModel(ctx, allowedModels)) : undefined;
    const unavailable =
      creating &&
      (params.model
        ? modelError(params.model, ctx, allowedModels)
        : selectedModel
          ? undefined
          : "No configured spawn models are currently available.");
    if (unavailable) return failure("model_unavailable", unavailable);
    if (kind === "agent" && creating && params.thinking && !allowedThinking.includes(params.thinking))
      return failure("invalid", `Spawn thinking level is not enabled: ${params.thinking}.`);
    return { parent: requireParent(ctx.sessionManager), allowed: branchIndex(ctx.sessionManager), selectedModel };
  };

  /** Refuses a new child when the runtime is closing or the spawn chain is already too deep. */
  const startGuard = (params: any): ToolFailure | undefined => {
    if (params.background && background.shuttingDown)
      return failure("shutting_down", "Background spawning is unavailable during session shutdown.");
    if (Number(process.env.PI_SPAWN_DEPTH ?? 0) >= MAX_DEPTH)
      return failure("depth_limit", `pi-spawn depth limit (${MAX_DEPTH}) reached.`);
  };

  const dispatch = (request: TurnRequest & { toolCallId: string; parentSessionId: string }) =>
    request.background ? background.start(request) : executeTurn(request);

  pi.on("context", event => {
    const content = background.contextLines();
    if (!content) return;
    return {
      messages: [
        ...event.messages,
        { role: "custom", customType: "pi-spawn-background", content, display: false, timestamp: Date.now() },
      ],
    };
  });

  pi.on("session_start", () => {
    background.reset();
    const deferredTools = [
      ...(agentAvailability === "deferred" ? ["spawn_agent"] : []),
      ...(sessionAvailability === "deferred" ? ["spawn_session"] : []),
    ];
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-spawn",
      managedTools: SPAWN_TOOLS,
      enabledTools: SPAWN_TOOLS,
      toolUsage: {
        spawn_agent: "create, continue, or inspect private customized subagent conversations",
        spawn_session: "create, adopt, or continue inspectable Pi sessions",
      },
      ...(deferredTools.length ? { deferredTools } : {}),
    });
  });
  pi.on("session_shutdown", async () => {
    await background.shutdown();
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-spawn" });
  });

  const agentTool = defineTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description:
      "Create, continue, inspect, or list private persistent subagent threads owned by the current parent-session branch. Set background true on create or continue to return immediately; set queue true on a background continuation to place it behind active work on that thread. Then use status or cancel with the returned thread and run IDs. Use create once with a self-contained prompt and the narrowest useful model, system-prompt, thinking, and tool policy; creation policy is immutable, so continue the returned ID for follow-ups. Use recent for bounded read-only transcript inspection without prompting the child, and list only to recover available branch-owned IDs. Review child responses and workspace changes before relying on them. Threads remain private and never appear in Pi's normal session list.",
    ...(agentAvailability === "active" ? { promptGuidelines: AGENT_PROMPT_GUIDELINES } : {}),
    parameters: AgentParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const checked = preflight("agent", params, ctx, manager => branchSpawnIds(manager, "agent"));
      if (isFailure(checked)) return checked;
      const { parent, allowed, selectedModel } = checked;
      const common = {
        kind: "agent" as const,
        cwd: ctx.cwd,
        ctx,
        signal,
        onUpdate,
        toolCallId,
        parentSessionId: parent.id,
        background: params.background,
      };

      if (params.action === "status" || params.action === "cancel") {
        if (!allowed.has(params.id!)) return missingThread("agent");
        return background.collect("agent", params.id!, params.runId!, params.action === "cancel");
      }
      if (params.action === "list") {
        const entries = await listPrivateAgents(ctx.cwd, parent, allowed, agentDir);
        return threadListResult(
          "agent",
          entries.map(({ info }) => threadInfo("agent", info)),
        );
      }
      if (params.action === "create") {
        const blocked = startGuard(params);
        if (blocked) return blocked;
        const thinking =
          params.thinking ??
          (ctx.thinkingLevel && allowedThinking.includes(ctx.thinkingLevel)
            ? ctx.thinkingLevel
            : config.agentThinkingLevels
              ? allowedThinking[0]
              : undefined);
        const policy = {
          model: selectedModel,
          ...(thinking ? { thinking } : {}),
          ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
          ...(params.tools !== undefined ? { tools: params.tools } : {}),
          disableSpecialists: params.disableSpecialists ?? true,
        };
        const created = createPrivateAgent(
          ctx.cwd,
          parent,
          policy,
          params.name?.trim() || defaultName(params.prompt!),
          agentDir,
        );
        return dispatch({
          ...common,
          id: created.info.id,
          path: created.info.path,
          prompt: params.prompt!,
          policy: created.policy,
        });
      }

      const matches = await listPrivateAgents(ctx.cwd, parent, allowed, agentDir);
      const selected = matches.find(({ info }) => info.id === params.id);
      if (!selected) return missingThread("agent");
      if (params.action === "recent")
        return recentTranscriptResult(selected, {
          limit: params.limit ?? config.recentThreadLimit,
          maxChars: params.maxChars ?? config.recentThreadMaxChars,
          totalChars: config.recentThreadTotalChars,
        });

      const policy = agentPolicy(selected.manager, parent);
      if (!policy)
        return failure(
          "invalid_policy",
          "Private subagent policy is invalid.",
          resultDetails("agent", selected.info.id),
        );
      const request = { ...common, id: selected.info.id, path: selected.info.path, prompt: params.prompt!, policy };
      return params.queue ? background.queue(request) : dispatch(request);
    },
  });
  pi.registerTool(agentTool);

  const sessionTool = defineTool({
    name: "spawn_session",
    label: "Spawn Session",
    description:
      "Create, adopt, continue, or list ordinary Pi sessions when the child must be inspectable or openable separately. Set background true on create, adopt, or continue to return immediately; set queue true on a background continuation to place it behind active work on that session. Then use status or cancel with the returned session and run IDs. Use create with a self-contained kickoff and purpose-based name, continue the returned ID for follow-ups, and list only to recover sessions available from the current parent branch. Set project only when the user explicitly requests another project; relative paths resolve from the current project. Adopt only on the user's explicit request with an exact session ID from the current or selected project; adoption claims and immediately prompts that transcript while preserving its model and metadata. Never prompt or adopt a session open in another Pi process. Sessions use the selected project's normal runtime and cannot customize system instructions, thinking, tools, or extensions; use spawn_agent for a private customized runtime.",
    ...(sessionAvailability === "active" ? { promptGuidelines: SESSION_PROMPT_GUIDELINES } : {}),
    parameters: SessionParameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const checked = preflight("session", params, ctx, manager => branchSpawnReferences(manager, "session"));
      if (isFailure(checked)) return checked;
      const { parent, allowed, selectedModel } = checked;
      const common = {
        kind: "session" as const,
        ctx,
        signal,
        onUpdate,
        toolCallId,
        parentSessionId: parent.id,
        background: params.background,
      };

      if (params.action === "status" || params.action === "cancel") {
        if (!allowed.has(params.id!)) return missingThread("session");
        return background.collect("session", params.id!, params.runId!, params.action === "cancel");
      }
      if (params.action === "list") {
        const entries = await listSpawnedSessions(parent, allowed);
        return threadListResult(
          "session",
          entries.map(({ info }) => threadInfo("session", info)),
        );
      }
      if (params.action === "create") {
        const blocked = startGuard(params);
        if (blocked) return blocked;
        let cwd: string;
        try {
          cwd = projectCwd(ctx.cwd, params.project);
        } catch (error) {
          return failure("invalid_project", error instanceof Error ? error.message : String(error));
        }
        const created = createSpawnedSession(cwd, parent, params.name?.trim() || defaultName(params.prompt!), {
          model: selectedModel,
          hooks: requestSpawnHooks(pi),
        });
        return dispatch({
          ...common,
          cwd,
          id: created.info.id,
          path: created.info.path,
          prompt: params.prompt!,
          policy: created.policy,
        });
      }
      if (params.action === "adopt") {
        try {
          const cwd = projectCwd(ctx.cwd, params.project);
          const existing = await findSessionForAdoption(cwd, params.id!, parent);
          const hooks = requestSpawnHooks(pi);
          const request = { ...common, cwd, id: existing.id, path: existing.path, prompt: params.prompt! };
          if (!params.background)
            return executeTurn({
              ...request,
              beforeRun: () => claimSpawnedSession(existing.path, existing.id, parent, hooks),
            });
          if (background.shuttingDown)
            return failure("shutting_down", "Background spawning is unavailable during session shutdown.");
          if (isThreadActive(existing.path))
            return failure("busy", "Spawned thread is already running in this Pi process.");
          claimSpawnedSession(existing.path, existing.id, parent, hooks);
          return background.start({ ...request, policy: sessionPolicy(SessionManager.open(existing.path), parent) });
        } catch (error) {
          return failure(
            error instanceof SessionAdoptionError
              ? error.code
              : error instanceof ProjectDirectoryError
                ? "invalid_project"
                : "adopt_error",
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      const matches = await listSpawnedSessions(parent, allowed);
      const selected = matches.filter(({ info }) => info.id === params.id);
      if (selected.length !== 1)
        return selected.length ? failure("invalid", "Spawned session ID is ambiguous.") : missingThread("session");
      const [{ info, manager }] = selected;
      const policy = sessionPolicy(manager, parent);
      if (!policy)
        return failure("invalid_policy", "Spawned session policy is invalid.", resultDetails("session", info.id));
      const request = { ...common, cwd: info.cwd, id: info.id, path: info.path, prompt: params.prompt!, policy };
      return params.queue ? background.queue(request) : dispatch(request);
    },
  });
  pi.registerTool(sessionTool);

  pi.on("session_start", (_event, ctx) => {
    const models = availableModels(ctx, allowedModels);
    setModelChoices(AgentParameters, models, "Available provider/model fixed when the private thread is created");
    setModelChoices(SessionParameters, models, "Available provider/model fixed when the standard session is created");
    pi.registerTool(agentTool);
    pi.registerTool(sessionTool);
  });
}
