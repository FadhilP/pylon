import { createHash } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runSpawn, spawnTimeoutMs, type SpawnActivity, type SpawnRun } from "../src/runner.ts";
import {
  agentPolicy,
  branchSpawnIds,
  claimSpawnedSession,
  createPrivateAgent,
  createSpawnedSession,
  findSessionForAdoption,
  listPrivateAgents,
  listSpawnedSessions,
  requireParent,
  resultDetails,
  sessionPolicy,
  spawnedHooks,
  threadInfo,
  withThreadLock,
  SessionAdoptionError,
  type AgentPolicy,
  type SpawnHooks,
  type SpawnKind,
  type SpawnMarker,
} from "../src/sessions.ts";

const agentActions = ["create", "continue", "list"] as const;
const sessionActions = ["create", "adopt", "continue", "list"] as const;
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const SPECIALIST_TOOLS = ["advisor", "grunt", "repo_scout", "web_scout"];
const SPAWN_TOOLS = ["spawn_agent", "spawn_session"];
const MAX_DEPTH = 4;

type RunChild = typeof runSpawn;

const threadParameters = {
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Opaque thread ID; required for adopt or continue" })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 16_000, description: "Prompt for create, adopt, or continue" })),
};

const createAgentParameters = () => Type.Object({
  action: StringEnum(agentActions, { description: "Create a thread, continue one, or list threads available from the current parent branch" }),
  ...threadParameters,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Concise purpose-based display name fixed when the private thread is created" })),
  model: Type.Optional(Type.String({ minLength: 3, maxLength: 300, description: "Optional provider/model fixed when the private thread is created" })),
  thinking: Type.Optional(StringEnum(thinkingLevels, { description: "Thinking level fixed when the private thread is created" })),
  systemPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000, description: "Replacement system prompt fixed when the private thread is created" })),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 32, uniqueItems: true, description: "Tool allowlist fixed when the private thread is created; an empty list disables all tools" })),
  disableSpecialists: Type.Optional(Type.Boolean({ description: "Disable Advisor, Grunt, and Scout in this private thread; default true" })),
}, { additionalProperties: false });

const createSessionParameters = () => Type.Object({
  action: StringEnum(sessionActions, { description: "Create a session, adopt an existing project session by ID, continue one, or list sessions available from the current parent branch" }),
  ...threadParameters,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Concise purpose-based display name for a newly created standard Pi session" })),
  model: Type.Optional(Type.String({ minLength: 3, maxLength: 300, description: "Optional provider/model fixed when the standard session is created" })),
}, { additionalProperties: false });

const SCIENTIST_NAMES = [
  "Ada", "Marie", "Charles", "Jane", "Alan", "Grace", "Emmy", "Vera", "Carl",
  "Tu", "Rosalind", "Katherine", "Ibn", "Srinivasa", "Chien-Shiung", "Dorothy",
  "Rachel", "Jagadish",
] as const;

const preview = (value: string, max = 72) => {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};
const defaultName = (prompt: string) => preview(prompt, 100);
const scientistName = (id: string) => SCIENTIST_NAMES[createHash("sha256").update(id).digest().readUInt32BE(0) % SCIENTIST_NAMES.length];
const currentModel = (ctx: any): string | undefined =>
  ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
const availableModels = (ctx: any): string[] => {
  const models = ctx.scopedModels.length
    ? ctx.scopedModels.map(({ model }: any) => model)
    : ctx.modelRegistry.getAvailable();
  return [...new Set<string>(models
    .filter((model: any) => ctx.modelRegistry.hasConfiguredAuth(model))
    .map((model: any) => `${model.provider}/${model.id}`))];
};
const modelError = (requested: string, ctx: any): string | undefined => {
  const available = availableModels(ctx);
  if (available.includes(requested)) return;
  const shown = available.slice(0, 20);
  return `Unavailable model: ${requested}.${shown.length
    ? ` Available models: ${shown.join(", ")}${available.length > shown.length ? `, and ${available.length - shown.length} more` : ""}.`
    : " No models are currently available."}`;
};
const setModelChoices = (parameters: any, models: string[], description: string) => {
  if (!models.length) delete parameters.properties.model;
  else parameters.properties.model = Type.Optional(StringEnum(models, { description }));
};
const creationOnlyAgentFields = (params: any) =>
  params.name !== undefined || params.model !== undefined || params.thinking !== undefined
  || params.systemPrompt !== undefined || params.tools !== undefined || params.disableSpecialists !== undefined;
const creationOnlySessionFields = (params: any) => params.name !== undefined || params.model !== undefined;

function invalidInput(kind: SpawnKind, params: any): string | undefined {
  if (params.action === "create") {
    if (params.id !== undefined) return `${kind} create does not accept id.`;
    if (!params.prompt?.trim()) return `${kind} create requires prompt.`;
    if (kind === "agent" && params.tools !== undefined) {
      const excluded = new Set([...SPAWN_TOOLS, ...(params.disableSpecialists === false ? [] : SPECIALIST_TOOLS)]);
      const forbidden = params.tools.find((tool: string) => excluded.has(tool));
      if (forbidden) return `Agent tool allowlist cannot include excluded tool: ${forbidden}.`;
    }
    return;
  }
  if (params.action === "adopt") {
    if (kind !== "session") return "Only standard sessions can be adopted.";
    if (!params.id) return "session adopt requires id.";
    if (!params.prompt?.trim()) return "session adopt requires prompt.";
    if (creationOnlySessionFields(params)) return "Session name and model cannot be changed on adopt.";
    return;
  }
  if (params.action === "continue") {
    if (!params.id) return `${kind} continue requires id.`;
    if (!params.prompt?.trim()) return `${kind} continue requires prompt.`;
    if (kind === "agent" && creationOnlyAgentFields(params)) return "Agent creation policy cannot change on continue.";
    if (kind === "session" && creationOnlySessionFields(params)) return "Session name and model can only be set on create.";
    return;
  }
  if (params.action !== "list") return `Unknown ${kind} action.`;
  if (params.id !== undefined || params.prompt !== undefined
    || (kind === "agent" ? creationOnlyAgentFields(params) : creationOnlySessionFields(params)))
    return `${kind} list does not accept thread or creation fields.`;
}

function childArgs(kind: SpawnKind, path: string, policy?: AgentPolicy | SpawnMarker): string[] {
  const args = ["--mode", "rpc", "--session", path];
  if (kind === "session") {
    if (policy?.model) args.push("--model", policy.model);
    return args;
  }
  const agentPolicy = policy as AgentPolicy | undefined;
  const excluded = [...SPAWN_TOOLS, ...(agentPolicy?.disableSpecialists ? SPECIALIST_TOOLS : [])];
  args.push("--exclude-tools", excluded.join(","));
  if (agentPolicy?.model) args.push("--model", agentPolicy.model);
  if (agentPolicy?.thinking) args.push("--thinking", agentPolicy.thinking);
  if (agentPolicy?.systemPrompt) args.push("--system-prompt", agentPolicy.systemPrompt);
  if (agentPolicy?.tools !== undefined) {
    if (agentPolicy.tools.length) args.push("--tools", agentPolicy.tools.join(","));
    else args.push("--no-tools");
  }
  return args;
}

function runText(kind: SpawnKind, id: string, name: string, run: SpawnRun): string {
  const label = kind === "agent" ? "Subagent" : "Session";
  const status = run.error ? `${label} ${name} (${id}) turn failed: ${run.error}` : `${label} ${name} (${id}):`;
  return `${status}${run.text ? `\n${run.text}` : ""}${run.truncated ? "\n[Response truncated.]" : ""}`;
}

function requestSpawnHooks(pi: ExtensionAPI): SpawnHooks | undefined {
  let hooks: SpawnHooks | undefined;
  pi.events.emit("pylon:spawn-hooks-request", {
    version: 1,
    provide: (value: SpawnHooks) => { if (hooks === undefined) hooks = value; },
  });
  return hooks;
}

export default function spawnExtension(pi: ExtensionAPI, runChild: RunChild = runSpawn, agentDir = getAgentDir()) {
  const AgentParameters = createAgentParameters();
  const SessionParameters = createSessionParameters();

  pi.on("session_start", (_event, ctx) => {
    if (process.env.PI_SPAWN_CHILD !== "session") return;
    const sessionStart = spawnedHooks(ctx.sessionManager)?.sessionStart;
    if (!sessionStart || ctx.sessionManager.getBranch()
      .some((entry) => entry.type === "custom_message" && entry.customType === sessionStart.customType)) return;
    pi.sendMessage({ customType: sessionStart.customType, content: sessionStart.content, display: false });
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (process.env.PI_SPAWN_CHILD !== "session") return;
    const content = spawnedHooks(ctx.sessionManager)?.beforeAgentStart;
    if (content) return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  });

  const executeTurn = async (
    kind: SpawnKind,
    id: string,
    path: string,
    cwd: string,
    prompt: string,
    policy: AgentPolicy | SpawnMarker | undefined,
    signal: AbortSignal | undefined,
    onUpdate: any,
    beforeRun?: () => void | Promise<void>,
  ) => {
    const started = Date.now();
    const agentName = scientistName(id);
    let activity: readonly SpawnActivity[] = [];
    let authorized = beforeRun === undefined;
    const update = (value: unknown) => { try { onUpdate?.(value); } catch { /* UI updates must not control child lifecycle. */ } };
    update({
      content: [{ type: "text", text: `${kind === "agent" ? "Subagent" : "Session"} ${agentName} is working…` }],
      details: { ...resultDetails(kind, id), agentName, startedAt: new Date(started).toISOString(), state: "running", activity },
    });
    try {
      const run = await withThreadLock(path, async () => {
        await beforeRun?.();
        authorized = true;
        return runChild(childArgs(kind, path, policy), {
          cwd,
          prompt,
          signal,
          timeoutMs: spawnTimeoutMs(),
          env: { PI_SPAWN_CHILD: kind, PI_SPAWN_DEPTH: String(Number(process.env.PI_SPAWN_DEPTH ?? 0) + 1) },
          onActivity: (_item, all) => {
            activity = all;
            update({
              content: [{ type: "text", text: `${kind === "agent" ? "Subagent" : "Session"} activity: ${all.at(-1)?.tool ?? "working"}` }],
              details: { ...resultDetails(kind, id), agentName, startedAt: new Date(started).toISOString(), state: "running", durationMs: Date.now() - started, activity: all },
            });
          },
        });
      }, signal);
      return {
        content: [{ type: "text" as const, text: runText(kind, id, agentName, run) }],
        details: {
          ...resultDetails(kind, id), agentName, startedAt: new Date(started).toISOString(),
          status: run.error ? "failed" : "completed", model: run.model, durationMs: run.durationMs,
          usage: run.usage, turns: run.turns, activity: run.activity, stopReason: run.stopReason,
          truncated: run.truncated, ...(run.error ? { failureCode: "child_error", failureMessage: run.error } : {}),
        },
        usage: {
          input: run.usage.input, output: run.usage.output, cacheRead: run.usage.cacheRead,
          cacheWrite: run.usage.cacheWrite, totalTokens: run.usage.input + run.usage.output + run.usage.cacheRead + run.usage.cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: run.usage.cost },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `${kind === "agent" ? "Subagent" : "Session"} ${id} turn failed: ${message}` }],
        details: { ...(authorized ? resultDetails(kind, id) : {}), agentName, startedAt: new Date(started).toISOString(), status: "failed", failureCode: error instanceof SessionAdoptionError ? error.code : "runner_error", failureMessage: message },
      };
    }
  };

  pi.on("session_start", () => {
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-spawn",
      managedTools: SPAWN_TOOLS,
      enabledTools: SPAWN_TOOLS,
      deferredTools: SPAWN_TOOLS,
      deferredToolUsage: {
        spawn_agent: "create or continue private customized subagent conversations",
        spawn_session: "create, adopt, or continue inspectable Pi sessions",
      },
    });
  });
  pi.on("session_shutdown", () => {
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-spawn" });
  });

  const agentTool = defineTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Create, continue, or list private persistent subagent threads owned by the current parent-session branch. Use for specialized, resumable delegated conversations whose transcript should remain private. Creation may fix a custom model, system prompt, tool allowlist, and specialist-tool policy. Creation policy is immutable; continue an existing agent by ID when follow-up context matters. Threads never appear in Pi's normal session list.",
    parameters: AgentParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const invalid = invalidInput("agent", params);
      if (invalid) return { content: [{ type: "text" as const, text: invalid }], details: { failureCode: "invalid" } };
      const unavailable = params.action === "create" && params.model ? modelError(params.model, ctx) : undefined;
      if (unavailable) return { content: [{ type: "text" as const, text: unavailable }], details: { failureCode: "model_unavailable" } };
      const parent = requireParent(ctx.sessionManager);
      const allowed = branchSpawnIds(ctx.sessionManager, "agent");
      if (params.action === "list") {
        const entries = await listPrivateAgents(ctx.cwd, parent, allowed, agentDir);
        const threads = entries.map(({ info }) => threadInfo("agent", info));
        return { content: [{ type: "text" as const, text: threads.length ? threads.map((item) => `${item.id} ${item.name ?? "Subagent"} (${item.messageCount} messages)`).join("\n") : "No private subagent threads on this parent branch." }], details: { threads } };
      }
      if (params.action === "create") {
        if (Number(process.env.PI_SPAWN_DEPTH ?? 0) >= MAX_DEPTH)
          return { content: [{ type: "text" as const, text: `pi-spawn depth limit (${MAX_DEPTH}) reached.` }], details: { failureCode: "depth_limit" } };
        const policy = {
          ...(params.model ?? currentModel(ctx) ? { model: params.model ?? currentModel(ctx) } : {}),
          ...(params.thinking ?? ctx.thinkingLevel ? { thinking: params.thinking ?? ctx.thinkingLevel } : {}),
          ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
          ...(params.tools !== undefined ? { tools: params.tools } : {}),
          disableSpecialists: params.disableSpecialists ?? true,
        };
        const created = createPrivateAgent(ctx.cwd, parent, policy, params.name?.trim() || defaultName(params.prompt!), agentDir);
        return executeTurn("agent", created.info.id, created.info.path, ctx.cwd, params.prompt!, created.policy, signal, onUpdate);
      }
      const matches = await listPrivateAgents(ctx.cwd, parent, allowed, agentDir);
      const selected = matches.find(({ info }) => info.id === params.id);
      if (!selected) return { content: [{ type: "text" as const, text: "Private subagent thread is unavailable from this parent branch." }], details: { failureCode: "not_found" } };
      const policy = agentPolicy(selected.manager, parent);
      if (!policy) return { content: [{ type: "text" as const, text: "Private subagent policy is invalid." }], details: { ...resultDetails("agent", selected.info.id), failureCode: "invalid_policy" } };
      return executeTurn("agent", selected.info.id, selected.info.path, ctx.cwd, params.prompt!, policy, signal, onUpdate);
    },
  });
  pi.registerTool(agentTool);

  const sessionTool = defineTool({
    name: "spawn_session",
    label: "Spawn Session",
    description: "Create, adopt, continue, or list ordinary Pi sessions when the child conversation should be inspectable or openable. Creation may fix a custom model; otherwise it inherits the current model. Adopt only when the user explicitly asks to resume an existing project session; it resolves an exact current-project session ID and must never target the active parent or a session open in another Pi process. Sessions use the normal project runtime and appear in Pi/Pylon's standard session list. For customized private runtimes, use spawn_agent instead; this tool cannot replace system prompts or disable tools and extensions.",
    parameters: SessionParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const invalid = invalidInput("session", params);
      if (invalid) return { content: [{ type: "text" as const, text: invalid }], details: { failureCode: "invalid" } };
      const unavailable = params.action === "create" && params.model ? modelError(params.model, ctx) : undefined;
      if (unavailable) return { content: [{ type: "text" as const, text: unavailable }], details: { failureCode: "model_unavailable" } };
      const parent = requireParent(ctx.sessionManager);
      const allowed = branchSpawnIds(ctx.sessionManager, "session");
      if (params.action === "list") {
        const entries = await listSpawnedSessions(ctx.cwd, parent, allowed);
        const threads = entries.map(({ info }) => threadInfo("session", info));
        return { content: [{ type: "text" as const, text: threads.length ? threads.map((item) => `${item.id} ${item.name ?? "Session"} (${item.messageCount} messages)`).join("\n") : "No spawned sessions on this parent branch." }], details: { threads } };
      }
      if (params.action === "create") {
        if (Number(process.env.PI_SPAWN_DEPTH ?? 0) >= MAX_DEPTH)
          return { content: [{ type: "text" as const, text: `pi-spawn depth limit (${MAX_DEPTH}) reached.` }], details: { failureCode: "depth_limit" } };
        const created = createSpawnedSession(ctx.cwd, parent, params.name?.trim() || defaultName(params.prompt!), {
          model: params.model ?? currentModel(ctx),
          hooks: requestSpawnHooks(pi),
        });
        return executeTurn("session", created.info.id, created.info.path, ctx.cwd, params.prompt!, created.policy, signal, onUpdate);
      }
      if (params.action === "adopt") {
        try {
          const existing = await findSessionForAdoption(ctx.cwd, params.id!, parent);
          const hooks = requestSpawnHooks(pi);
          return executeTurn("session", existing.id, existing.path, ctx.cwd, params.prompt!, undefined, signal, onUpdate, () => claimSpawnedSession(existing.path, existing.id, parent, hooks));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text" as const, text: message }], details: { failureCode: error instanceof SessionAdoptionError ? error.code : "adopt_error" } };
        }
      }
      const matches = await listSpawnedSessions(ctx.cwd, parent, allowed);
      const selected = matches.find(({ info }) => info.id === params.id);
      if (!selected) return { content: [{ type: "text" as const, text: "Spawned session is unavailable from this parent branch." }], details: { failureCode: "not_found" } };
      const policy = sessionPolicy(selected.manager, parent);
      if (!policy) return { content: [{ type: "text" as const, text: "Spawned session policy is invalid." }], details: { ...resultDetails("session", selected.info.id), failureCode: "invalid_policy" } };
      return executeTurn("session", selected.info.id, selected.info.path, ctx.cwd, params.prompt!, policy, signal, onUpdate);
    },
  });
  pi.registerTool(sessionTool);

  pi.on("session_start", (_event, ctx) => {
    const models = availableModels(ctx);
    setModelChoices(AgentParameters, models, "Available provider/model fixed when the private thread is created");
    setModelChoices(SessionParameters, models, "Available provider/model fixed when the standard session is created");
    pi.registerTool(agentTool);
    pi.registerTool(sessionTool);
  });
}
