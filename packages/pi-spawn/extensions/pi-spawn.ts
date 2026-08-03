import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
  threadInfo,
  withThreadLock,
  SessionAdoptionError,
  type AgentPolicy,
  type SpawnKind,
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

const AgentParameters = Type.Object({
  action: StringEnum(agentActions, { description: "Create a thread, continue one, or list threads available from the current parent branch" }),
  ...threadParameters,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Display name fixed when the private thread is created" })),
  model: Type.Optional(Type.String({ minLength: 3, maxLength: 300, description: "Optional provider/model fixed when the private thread is created" })),
  thinking: Type.Optional(StringEnum(thinkingLevels, { description: "Thinking level fixed when the private thread is created" })),
  systemPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000, description: "Replacement system prompt fixed when the private thread is created" })),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 32, uniqueItems: true, description: "Tool allowlist fixed when the private thread is created; an empty list disables all tools" })),
  disableSpecialists: Type.Optional(Type.Boolean({ description: "Disable Advisor, Grunt, and Scout in this private thread; default true" })),
}, { additionalProperties: false });

const SessionParameters = Type.Object({
  action: StringEnum(sessionActions, { description: "Create a session, adopt an existing project session by ID, continue one, or list sessions available from the current parent branch" }),
  ...threadParameters,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Display name for a newly created standard Pi session" })),
}, { additionalProperties: false });

const preview = (value: string, max = 72) => {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};
const defaultName = (kind: SpawnKind, prompt: string) => `${kind === "agent" ? "Agent" : "Thread"}: ${preview(prompt, 100)}`;
const currentModel = (ctx: any): string | undefined =>
  ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
const creationOnlyAgentFields = (params: any) =>
  params.name !== undefined || params.model !== undefined || params.thinking !== undefined
  || params.systemPrompt !== undefined || params.tools !== undefined || params.disableSpecialists !== undefined;

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
    if (params.name !== undefined) return "Session name cannot be changed on adopt.";
    return;
  }
  if (params.action === "continue") {
    if (!params.id) return `${kind} continue requires id.`;
    if (!params.prompt?.trim()) return `${kind} continue requires prompt.`;
    if (kind === "agent" && creationOnlyAgentFields(params)) return "Agent creation policy cannot change on continue.";
    if (kind === "session" && params.name !== undefined) return "Session name can only be set on create.";
    return;
  }
  if (params.action !== "list") return `Unknown ${kind} action.`;
  if (params.id !== undefined || params.prompt !== undefined || params.name !== undefined
    || (kind === "agent" && creationOnlyAgentFields(params))) return `${kind} list does not accept thread or creation fields.`;
}

function childArgs(kind: SpawnKind, path: string, policy?: AgentPolicy): string[] {
  const args = ["--mode", "rpc", "--session", path];
  if (kind === "session") return args;
  const excluded = [...SPAWN_TOOLS, ...(policy?.disableSpecialists ? SPECIALIST_TOOLS : [])];
  args.push("--exclude-tools", excluded.join(","));
  if (policy?.model) args.push("--model", policy.model);
  if (policy?.thinking) args.push("--thinking", policy.thinking);
  if (policy?.systemPrompt) args.push("--system-prompt", policy.systemPrompt);
  if (policy?.tools !== undefined) {
    if (policy.tools.length) args.push("--tools", policy.tools.join(","));
    else args.push("--no-tools");
  }
  return args;
}

function runText(kind: SpawnKind, id: string, run: SpawnRun): string {
  const label = kind === "agent" ? "Subagent" : "Session";
  const status = run.error ? `${label} ${id} turn failed: ${run.error}` : `${label} ${id}:`;
  return `${status}${run.text ? `\n${run.text}` : ""}${run.truncated ? "\n[Response truncated.]" : ""}`;
}

export default function spawnExtension(pi: ExtensionAPI, runChild: RunChild = runSpawn, agentDir = getAgentDir()) {
  const executeTurn = async (
    kind: SpawnKind,
    id: string,
    path: string,
    cwd: string,
    prompt: string,
    policy: AgentPolicy | undefined,
    signal: AbortSignal | undefined,
    onUpdate: any,
    beforeRun?: () => void | Promise<void>,
  ) => {
    const started = Date.now();
    const agentName = `${kind === "agent" ? "Agent" : "Thread"}-${id.slice(0, 8)}`;
    let activity: readonly SpawnActivity[] = [];
    let authorized = beforeRun === undefined;
    const update = (value: unknown) => { try { onUpdate?.(value); } catch { /* UI updates must not control child lifecycle. */ } };
    update({
      content: [{ type: "text", text: `${kind === "agent" ? "Subagent" : "Session"} ${id} is working…` }],
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
        content: [{ type: "text" as const, text: runText(kind, id, run) }],
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

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Create, continue, or list private persistent subagent threads owned by the current parent-session branch. Creation may fix a custom model, system prompt, tool allowlist, and specialist-tool policy. Threads never appear in Pi's normal session list.",
    promptSnippet: "Launch or continue a private persistent subagent thread accessible only through this parent session",
    promptGuidelines: [
      "Use spawn_agent for specialized, resumable delegated conversations whose transcript should remain private to the parent session.",
      "Treat spawn_agent creation policy as immutable; continue an existing agent by ID rather than creating another when follow-up context matters.",
    ],
    parameters: AgentParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const invalid = invalidInput("agent", params);
      if (invalid) return { content: [{ type: "text" as const, text: invalid }], details: { failureCode: "invalid" } };
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
        const created = createPrivateAgent(ctx.cwd, parent, policy, params.name?.trim() || defaultName("agent", params.prompt!), agentDir);
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

  pi.registerTool({
    name: "spawn_session",
    label: "Spawn Session",
    description: "Create, adopt, continue, or list ordinary Pi sessions. Adopt resolves an existing session by exact ID in the current project and claims it for this parent branch. Sessions use the normal project runtime and appear in Pi/Pylon's standard session list. This tool cannot replace their system prompt or disable tools and extensions.",
    promptSnippet: "Launch or continue a first-class inspectable Pi session with the normal project runtime",
    promptGuidelines: [
      "Use spawn_session when the user should be able to inspect or open the child conversation as an ordinary session.",
      "Use spawn_session adopt only when the user explicitly asks to resume an existing project session; never adopt the active parent or a session open in another Pi process.",
      "Do not use spawn_session to customize system instructions or tool policy; use spawn_agent for private specialized runtimes.",
    ],
    parameters: SessionParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const invalid = invalidInput("session", params);
      if (invalid) return { content: [{ type: "text" as const, text: invalid }], details: { failureCode: "invalid" } };
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
        const created = createSpawnedSession(ctx.cwd, parent, params.name?.trim() || defaultName("session", params.prompt!));
        return executeTurn("session", created.info.id, created.info.path, ctx.cwd, params.prompt!, undefined, signal, onUpdate);
      }
      if (params.action === "adopt") {
        try {
          const existing = await findSessionForAdoption(ctx.cwd, params.id!, parent);
          return executeTurn("session", existing.id, existing.path, ctx.cwd, params.prompt!, undefined, signal, onUpdate, () => claimSpawnedSession(existing.path, existing.id, parent));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text" as const, text: message }], details: { failureCode: error instanceof SessionAdoptionError ? error.code : "adopt_error" } };
        }
      }
      const matches = await listSpawnedSessions(ctx.cwd, parent, allowed);
      const selected = matches.find(({ info }) => info.id === params.id);
      if (!selected) return { content: [{ type: "text" as const, text: "Spawned session is unavailable from this parent branch." }], details: { failureCode: "not_found" } };
      return executeTurn("session", selected.info.id, selected.info.path, ctx.cwd, params.prompt!, undefined, signal, onUpdate);
    },
  });
}
