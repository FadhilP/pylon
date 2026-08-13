import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, getAgentDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { configPath, loadConfig, thinkingLevels } from "../src/config.ts";
import { runSpawn, type SpawnActivity, type SpawnRun, type SpawnUiRequest, type SpawnUiResponse } from "../src/runner.ts";
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
  withThreadLock,
  SessionAdoptionError,
  type AgentPolicy,
  type SpawnHooks,
  type SpawnKind,
  type SpawnMarker,
} from "../src/sessions.ts";

const agentActions = ["create", "continue", "status", "cancel", "recent", "list"] as const;
const sessionActions = ["create", "adopt", "continue", "status", "cancel", "list"] as const;
const SPECIALIST_TOOLS = ["advisor", "grunt", "repo_scout", "web_scout"];
const SPAWN_TOOLS = ["spawn_agent", "spawn_session"];
const MAX_DEPTH = 4;
const AGENT_PROMPT_GUIDELINES = [
  "Use spawn_agent for a private, resumable specialist conversation that benefits from an isolated transcript or a fixed model, system prompt, thinking level, or tool allowlist; prefer focused specialist tools for one-shot work they already cover.",
  "When using spawn_agent, create one thread with a self-contained prompt and the narrowest useful policy, then continue that thread by ID for follow-ups because its model, system prompt, thinking level, and tools are immutable.",
  "Set background true only for independent work that should continue across parent turns; use status with the returned thread and run IDs to collect its result, or cancel to stop it.",
  "Use spawn_agent recent to inspect bounded recent transcript messages without prompting the child; use list only to recover private thread IDs available from the current parent branch.",
  "Review child responses and workspace changes before relying on them.",
];
const SESSION_PROMPT_GUIDELINES = [
  "Use spawn_session only when the child conversation must be an ordinary Pi session the user can inspect, open, or continue separately; do not use spawn_session as the default delegation tool when a private spawn_agent thread or focused specialist tool is sufficient.",
  "When starting independent work with spawn_session, use create with a self-contained kickoff prompt and a concise purpose-based name; use continue with the returned ID for follow-ups, and use list only to recover sessions available from the current parent branch.",
  "Set background true only for independent work that should continue across parent turns; use status with the returned session and run IDs to collect its result, or cancel to stop it.",
  "Set spawn_session project only when the user explicitly requests another project; relative project paths resolve from the current project.",
  "Use spawn_session adopt only when the user explicitly asks to resume an existing session in the current or selected project and provides its exact ID; adopt claims and immediately prompts that existing transcript while preserving its model, name, and native parent metadata.",
  "Do not use spawn_session to customize system instructions, thinking, tools, or extensions because it loads the selected project's normal runtime; never prompt or adopt a session concurrently open in another Pi process.",
];

type RunChild = typeof runSpawn;

const threadParameters = {
  id: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Opaque thread ID" })),
  runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128, description: "Background run ID returned when background is true" })),
  prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 16_000, description: "Prompt for create, adopt, or continue" })),
  background: Type.Optional(Type.Boolean({ description: "Return immediately and continue this prompt in the background; default false" })),
};

const createAgentParameters = (allowedThinking: readonly string[] = thinkingLevels) => Type.Object({
  action: StringEnum(agentActions, { description: "Create, continue, inspect recent messages from, or list private threads available from the current parent branch" }),
  ...threadParameters,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Recent transcript messages to return; default 8" })),
  maxChars: Type.Optional(Type.Integer({ minimum: 80, maximum: 2_000, description: "Maximum text characters per recent message; default 800" })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Concise purpose-based display name fixed when the private thread is created" })),
  model: Type.Optional(Type.String({ minLength: 3, maxLength: 300, description: "Optional provider/model fixed when the private thread is created" })),
  thinking: Type.Optional(StringEnum(allowedThinking, { description: "Thinking level fixed when the private thread is created" })),
  systemPrompt: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000, description: "Replacement system prompt fixed when the private thread is created" })),
  tools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { maxItems: 32, uniqueItems: true, description: "Tool allowlist fixed when the private thread is created; an empty list disables all tools" })),
  disableSpecialists: Type.Optional(Type.Boolean({ description: "Disable Advisor, Grunt, and Scout in this private thread; default true" })),
}, { additionalProperties: false });

const createSessionParameters = () => Type.Object({
  action: StringEnum(sessionActions, { description: "Create a session, adopt an existing project session by ID, continue one, or list sessions available from the current parent branch" }),
  ...threadParameters,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Concise purpose-based display name for a newly created standard Pi session" })),
  model: Type.Optional(Type.String({ minLength: 3, maxLength: 300, description: "Optional provider/model fixed when the standard session is created" })),
  project: Type.Optional(Type.String({ minLength: 1, maxLength: 32_768, description: "Existing project directory for create or adopt; relative paths resolve from the current project, and omission uses the current project" })),
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
const availableModels = (ctx: any, allowed?: readonly string[]): string[] => {
  const models = ctx.scopedModels.length
    ? ctx.scopedModels.map(({ model }: any) => model)
    : ctx.modelRegistry.getAvailable();
  const available = [...new Set<string>(models
    .filter((model: any) => ctx.modelRegistry.hasConfiguredAuth(model))
    .map((model: any) => `${model.provider}/${model.id}`))];
  return allowed ? allowed.filter((model) => available.includes(model)) : available;
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
const runControlFields = (params: any) => params.runId !== undefined || params.background !== undefined;

class ProjectDirectoryError extends Error {}

function projectCwd(currentCwd: string, project?: string): string {
  if (project === undefined) return currentCwd;
  const requested = resolve(currentCwd, project.startsWith("@") ? project.slice(1) : project);
  try {
    const target = realpathSync.native(requested);
    if (statSync(target).isDirectory()) return target;
  } catch { /* Report one stable validation error below. */ }
  throw new ProjectDirectoryError(`Project directory does not exist or is not a directory: ${requested}`);
}

function invalidInput(kind: SpawnKind, params: any): string | undefined {
  if (params.action === "create") {
    if (params.id !== undefined || params.runId !== undefined) return `${kind} create does not accept id or runId.`;
    if (!params.prompt?.trim()) return `${kind} create requires prompt.`;
    if (params.limit !== undefined || params.maxChars !== undefined) return `${kind} create does not accept recent limits.`;
    if (kind === "session" && params.project !== undefined && !params.project.trim()) return "session project must not be empty.";
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
    if (params.runId !== undefined) return "session adopt does not accept runId.";
    if (!params.prompt?.trim()) return "session adopt requires prompt.";
    if (params.project !== undefined && !params.project.trim()) return "session project must not be empty.";
    if (creationOnlySessionFields(params)) return "Session name and model cannot be changed on adopt.";
    return;
  }
  if (params.action === "continue") {
    if (!params.id) return `${kind} continue requires id.`;
    if (params.runId !== undefined) return `${kind} continue does not accept runId.`;
    if (!params.prompt?.trim()) return `${kind} continue requires prompt.`;
    if (params.limit !== undefined || params.maxChars !== undefined) return `${kind} continue does not accept recent limits.`;
    if (kind === "agent" && creationOnlyAgentFields(params)) return "Agent creation policy cannot change on continue.";
    if (kind === "session" && (creationOnlySessionFields(params) || params.project !== undefined)) return "Session name, model, and project can only be set on create or adopt.";
    return;
  }
  if (params.action === "status" || params.action === "cancel") {
    if (!params.id || !params.runId) return `${kind} ${params.action} requires id and runId.`;
    if (params.prompt !== undefined || params.background !== undefined || params.limit !== undefined || params.maxChars !== undefined
      || (kind === "agent" ? creationOnlyAgentFields(params) : creationOnlySessionFields(params) || params.project !== undefined))
      return `${kind} ${params.action} accepts only id and runId.`;
    return;
  }
  if (params.action === "recent") {
    if (kind !== "agent") return "Only private agents support recent transcript inspection.";
    if (!params.id) return "agent recent requires id.";
    if (params.prompt !== undefined || runControlFields(params) || creationOnlyAgentFields(params)) return "agent recent does not accept prompts, runs, or creation fields.";
    if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 50)) return "agent recent limit must be an integer between 1 and 50.";
    if (params.maxChars !== undefined && (!Number.isInteger(params.maxChars) || params.maxChars < 80 || params.maxChars > 2_000)) return "agent recent maxChars must be an integer between 80 and 2000.";
    return;
  }
  if (params.action !== "list") return `Unknown ${kind} action.`;
  if (params.id !== undefined || params.prompt !== undefined || params.limit !== undefined || params.maxChars !== undefined || runControlFields(params)
    || (kind === "agent" ? creationOnlyAgentFields(params) : creationOnlySessionFields(params) || params.project !== undefined))
    return `${kind} list does not accept thread, run, recent, or creation fields.`;
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

function requestSpawnRuntimePolicy(pi: ExtensionAPI, cwd: string, sessionId: string): string | undefined {
  let policy: unknown;
  pi.events.emit("pylon:spawn-runtime-policy-request", {
    version: 1,
    cwd,
    sessionId,
    provide: (value: unknown) => { if (policy === undefined) policy = value; },
  });
  if (policy === undefined) return JSON.stringify({ version: 1, invalid: true });
  const serialized = JSON.stringify(policy);
  return Buffer.byteLength(serialized) <= 16 * 1024 ? serialized : JSON.stringify({ version: 1, invalid: true });
}

export default async function spawnExtension(pi: ExtensionAPI, runChild: RunChild = runSpawn, agentDir = getAgentDir()) {
  const config = await loadConfig(configPath(agentDir));
  const { agentAvailability, sessionAvailability } = config;
  const allowedModels = config.models;
  const allowedThinking: readonly string[] = config.agentThinkingLevels ?? thinkingLevels;
  const AgentParameters = createAgentParameters(allowedThinking);
  const SessionParameters = createSessionParameters();
  type BackgroundRun = {
    kind: SpawnKind;
    id: string;
    path: string;
    cwd: string;
    runId: string;
    agentName: string;
    started: number;
    controller: AbortController;
    state: "running" | "completed" | "failed" | "cancelled";
    promise: Promise<any>;
    result?: any;
  };
  const backgroundRuns = new Map<string, BackgroundRun>();
  let shuttingDown = false;
  const pruneBackgroundRuns = () => {
    const terminal = [...backgroundRuns.values()].filter((run) => run.state !== "running").sort((a, b) => b.started - a.started);
    for (const run of terminal.slice(20)) backgroundRuns.delete(run.runId);
  };

  pi.on("session_start", (_event, ctx) => {
    if (process.env.PI_SPAWN_CHILD !== "session") return;
    const sessionStart = spawnedHooks(ctx.sessionManager)?.sessionStart;
    if (!sessionStart || ctx.sessionManager.getBranch()
      .some((entry) => entry.type === "custom_message" && entry.customType === sessionStart.customType)) return;
    pi.sendMessage({ customType: sessionStart.customType, content: sessionStart.content, display: false });
  });
  pi.on("session_compact", (event, ctx) => {
    if (process.env.PI_SPAWN_CHILD !== "session") return;
    const hook = spawnedHooks(ctx.sessionManager)?.sessionCompact;
    const compactionEntryId = event.compactionEntry?.id;
    if (!hook || !compactionEntryId || ctx.sessionManager.getBranch().some((entry) => {
      if (entry.type !== "custom_message") return false;
      const value = entry as any;
      return (value.customType === hook.customType || value.message?.customType === hook.customType)
        && (value.details?.compactionEntryId === compactionEntryId || value.message?.details?.compactionEntryId === compactionEntryId);
    })) return;
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

  const executeTurn = async (
    kind: SpawnKind,
    id: string,
    path: string,
    cwd: string,
    prompt: string,
    policy: AgentPolicy | SpawnMarker | undefined,
    signal: AbortSignal | undefined,
    onUpdate: any,
    ctx: any,
    beforeRun?: () => void | Promise<void>,
    runId = randomUUID(),
    background = false,
  ) => {
    const started = Date.now();
    const agentName = scientistName(id);
    let model = policy?.model;
    let thinking = kind === "agent" ? (policy as AgentPolicy | undefined)?.thinking : undefined;
    let activity: readonly SpawnActivity[] = [];
    let authorized = beforeRun === undefined;
    const update = (value: unknown) => { try { onUpdate?.(value); } catch { /* UI updates must not control child lifecycle. */ } };
    const runningDetails = () => ({
      ...resultDetails(kind, id, path, cwd), runId, agentName, startedAt: new Date(started).toISOString(), state: "running",
      ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(background ? { background: true } : {}),
    });
    const onUiRequest = async (request: SpawnUiRequest, uiSignal: AbortSignal): Promise<SpawnUiResponse> => {
      if (background || !ctx.hasUI || request.method === "editor")
        return request.method === "confirm" ? { confirmed: false } : { cancelled: true };
      update({
        content: [{ type: "text", text: `${kind === "agent" ? "Subagent" : "Session"} ${agentName} is waiting for input…` }],
        details: { ...runningDetails(), state: "attention", durationMs: Date.now() - started },
      });
      const title = `${kind === "agent" ? "Subagent" : "Session"} ${agentName}: ${request.title}`;
      const dialogOptions = { signal: uiSignal, ...(request.timeout !== undefined ? { timeout: request.timeout } : {}) };
      if (request.method === "confirm") return { confirmed: await ctx.ui.confirm(title, request.message, dialogOptions) };
      if (request.method === "select") {
        const value = await ctx.ui.select(title, request.options, dialogOptions);
        return value === undefined ? { cancelled: true } : { value };
      }
      const value = await ctx.ui.input(title, request.placeholder, dialogOptions);
      return value === undefined ? { cancelled: true } : { value };
    };
    update({
      content: [{ type: "text", text: `${kind === "agent" ? "Subagent" : "Session"} ${agentName} is working…` }],
      details: { ...runningDetails(), activity },
    });
    try {
      const run = await withThreadLock(path, async () => {
        if (beforeRun) await beforeRun();
        authorized = true;
        const runtimePolicy = requestSpawnRuntimePolicy(pi, cwd, id);
        return runChild(childArgs(kind, path, policy), {
          cwd,
          prompt,
          signal,
          env: {
            PI_SPAWN_CHILD: kind,
            PI_SPAWN_AUTONOMOUS: "1",
            PI_SPAWN_DEPTH: String(Number(process.env.PI_SPAWN_DEPTH ?? 0) + 1),
            ...(runtimePolicy ? { PI_SPAWN_GUARD_POLICY: runtimePolicy } : {}),
          },
          onUiRequest,
          onUsage: (usage) => update({
            content: [{ type: "text", text: `${kind === "agent" ? "Subagent" : "Session"} usage updated` }],
            details: { ...runningDetails(), durationMs: Date.now() - started, usage },
          }),
          onState: (state) => {
            model = state.model ?? model;
            thinking = state.thinking ?? thinking;
            update({
              content: [{ type: "text", text: `${kind === "agent" ? "Subagent" : "Session"} runtime ready` }],
              details: { ...runningDetails(), durationMs: Date.now() - started },
            });
          },
          onActivity: (item, all) => {
            activity = all;
            update({
              content: [{ type: "text", text: `${kind === "agent" ? "Subagent" : "Session"} activity: ${item.tool}` }],
              details: { ...runningDetails(), durationMs: Date.now() - started, activityDelta: [item] },
            });
          },
        });
      }, signal);
      const status = signal?.aborted ? "cancelled" : run.error ? "failed" : "completed";
      return {
        content: [{ type: "text" as const, text: runText(kind, id, agentName, run) }],
        details: {
          ...resultDetails(kind, id, path, cwd), runId, agentName, startedAt: new Date(started).toISOString(),
          status, model: run.model ?? model, ...(background ? { background: true } : {}),
          ...(run.thinking ?? thinking ? { thinking: run.thinking ?? thinking } : {}), durationMs: run.durationMs,
          usage: run.usage, ...(run.sessionUsage ? { sessionUsage: run.sessionUsage } : {}),
          turns: run.turns, activity: run.activity, stopReason: run.stopReason,
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
        details: {
          ...(authorized ? resultDetails(kind, id, path, cwd) : {}), runId, agentName,
          startedAt: new Date(started).toISOString(), status: signal?.aborted ? "cancelled" : "failed",
          ...(background ? { background: true } : {}),
          failureCode: error instanceof SessionAdoptionError ? error.code : "runner_error", failureMessage: message,
        },
      };
    }
  };

  const startBackground = (
    kind: SpawnKind,
    id: string,
    path: string,
    cwd: string,
    prompt: string,
    policy: AgentPolicy | SpawnMarker | undefined,
    ctx: any,
  ) => {
    if (shuttingDown)
      return { content: [{ type: "text" as const, text: "Background spawning is unavailable during session shutdown." }], details: { failureCode: "shutting_down" } };
    if (isThreadActive(path))
      return { content: [{ type: "text" as const, text: "Spawned thread is already running in this Pi process." }], details: { failureCode: "busy" } };
    const runId = randomUUID();
    const started = Date.now();
    const controller = new AbortController();
    const entry = {
      kind, id, path, cwd, runId, agentName: scientistName(id), started, controller,
      state: "running" as const, promise: Promise.resolve(undefined),
    } as BackgroundRun;
    backgroundRuns.set(runId, entry);
    entry.promise = executeTurn(kind, id, path, cwd, prompt, policy, controller.signal, undefined, ctx, undefined, runId, true)
      .then((result) => {
        entry.result = result;
        entry.state = result.details?.status === "completed" ? "completed"
          : result.details?.status === "cancelled" ? "cancelled" : "failed";
        pruneBackgroundRuns();
        return result;
      });
    const label = kind === "agent" ? "Subagent" : "Session";
    return {
      content: [{ type: "text" as const, text: `${label} ${entry.agentName} (${id}) started in background as run ${runId}. Continue independent work, then use ${kind === "agent" ? "spawn_agent" : "spawn_session"} status with id and runId.` }],
      details: {
        ...resultDetails(kind, id, path, cwd), runId, agentName: entry.agentName,
        startedAt: new Date(started).toISOString(), status: "running", state: "running", background: true,
        ...(policy?.model ? { model: policy.model } : {}),
        ...(kind === "agent" && (policy as AgentPolicy | undefined)?.thinking ? { thinking: (policy as AgentPolicy).thinking } : {}),
      },
    };
  };

  const backgroundResult = async (kind: SpawnKind, id: string, runId: string, cancel: boolean) => {
    const entry = backgroundRuns.get(runId);
    if (!entry || entry.kind !== kind || entry.id !== id)
      return { content: [{ type: "text" as const, text: "Background run is unavailable in this session runtime." }], details: { failureCode: "not_found" } };
    if (cancel && entry.state === "running") entry.controller.abort();
    if (cancel) await entry.promise;
    if (entry.state === "running") {
      const label = kind === "agent" ? "Subagent" : "Session";
      return {
        content: [{ type: "text" as const, text: `${label} ${entry.agentName} (${id}) background run ${runId} is still running.` }],
        details: { ...resultDetails(kind, id, entry.path, entry.cwd), runId, agentName: entry.agentName, startedAt: new Date(entry.started).toISOString(), status: "running", state: "running", background: true, durationMs: Date.now() - entry.started },
      };
    }
    if (backgroundRuns.get(runId) !== entry)
      return { content: [{ type: "text" as const, text: "Background run result was already collected." }], details: { failureCode: "not_found" } };
    backgroundRuns.delete(runId);
    return entry.result;
  };

  pi.on("context", (event) => {
    const runs = [...backgroundRuns.values()];
    const visible = [...runs.filter((run) => run.state === "running"), ...runs.filter((run) => run.state !== "running")].slice(0, 8);
    if (!visible.length) return;
    const content = visible.map((run) => `${run.kind} ${run.id}, run ${run.runId}: ${run.state}${run.state === "running" ? "" : "; call status to collect the result"}`).join("\n");
    return { messages: [...event.messages, { role: "custom", customType: "pi-spawn-background", content, display: false, timestamp: Date.now() }] };
  });

  pi.on("session_start", () => {
    shuttingDown = false;
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
    shuttingDown = true;
    const running = [...backgroundRuns.values()].filter((run) => run.state === "running");
    for (const run of running) run.controller.abort();
    await Promise.allSettled(running.map((run) => run.promise));
    backgroundRuns.clear();
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-spawn" });
  });

  const agentTool = defineTool({
    name: "spawn_agent",
    label: "Spawn Agent",
    description: "Create, continue, inspect, or list private persistent subagent threads owned by the current parent-session branch. Set background true on create or continue to return immediately, then use status or cancel with the returned thread and run IDs. Use create once with a self-contained prompt and the narrowest useful model, system-prompt, thinking, and tool policy; creation policy is immutable, so continue the returned ID for follow-ups. Use recent for bounded read-only transcript inspection without prompting the child, and list only to recover available branch-owned IDs. Review child responses and workspace changes before relying on them. Threads remain private and never appear in Pi's normal session list.",
    ...(agentAvailability === "active" ? { promptGuidelines: AGENT_PROMPT_GUIDELINES } : {}),
    parameters: AgentParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const invalid = invalidInput("agent", params);
      if (invalid) return { content: [{ type: "text" as const, text: invalid }], details: { failureCode: "invalid" } };
      const selectedModel = params.action === "create" ? params.model ?? defaultModel(ctx, allowedModels) : undefined;
      const unavailable = params.action === "create" && (params.model
        ? modelError(params.model, ctx, allowedModels)
        : selectedModel ? undefined : "No configured spawn models are currently available.");
      if (unavailable) return { content: [{ type: "text" as const, text: unavailable }], details: { failureCode: "model_unavailable" } };
      if (params.action === "create" && params.thinking && !allowedThinking.includes(params.thinking))
        return { content: [{ type: "text" as const, text: `Spawn thinking level is not enabled: ${params.thinking}.` }], details: { failureCode: "invalid" } };
      const parent = requireParent(ctx.sessionManager);
      const allowed = branchSpawnIds(ctx.sessionManager, "agent");
      if (params.action === "status" || params.action === "cancel") {
        if (!allowed.has(params.id!))
          return { content: [{ type: "text" as const, text: "Private subagent thread is unavailable from this parent branch." }], details: { failureCode: "not_found" } };
        return backgroundResult("agent", params.id!, params.runId!, params.action === "cancel");
      }
      if (params.action === "list") {
        const entries = await listPrivateAgents(ctx.cwd, parent, allowed, agentDir);
        const threads = entries.map(({ info }) => threadInfo("agent", info));
        return { content: [{ type: "text" as const, text: threads.length ? threads.map((item) => `${item.id} ${item.name ?? "Subagent"} (${item.messageCount} messages)`).join("\n") : "No private subagent threads on this parent branch." }], details: { threads } };
      }
      if (params.action === "create") {
        if (params.background && shuttingDown)
          return { content: [{ type: "text" as const, text: "Background spawning is unavailable during session shutdown." }], details: { failureCode: "shutting_down" } };
        if (Number(process.env.PI_SPAWN_DEPTH ?? 0) >= MAX_DEPTH)
          return { content: [{ type: "text" as const, text: `pi-spawn depth limit (${MAX_DEPTH}) reached.` }], details: { failureCode: "depth_limit" } };
        const thinking = params.thinking ?? (ctx.thinkingLevel && allowedThinking.includes(ctx.thinkingLevel)
          ? ctx.thinkingLevel
          : config.agentThinkingLevels ? allowedThinking[0] : undefined);
        const policy = {
          model: selectedModel,
          ...(thinking ? { thinking } : {}),
          ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
          ...(params.tools !== undefined ? { tools: params.tools } : {}),
          disableSpecialists: params.disableSpecialists ?? true,
        };
        const created = createPrivateAgent(ctx.cwd, parent, policy, params.name?.trim() || defaultName(params.prompt!), agentDir);
        return params.background
          ? startBackground("agent", created.info.id, created.info.path, ctx.cwd, params.prompt!, created.policy, ctx)
          : executeTurn("agent", created.info.id, created.info.path, ctx.cwd, params.prompt!, created.policy, signal, onUpdate, ctx);
      }
      const matches = await listPrivateAgents(ctx.cwd, parent, allowed, agentDir);
      const selected = matches.find(({ info }) => info.id === params.id);
      if (!selected) return { content: [{ type: "text" as const, text: "Private subagent thread is unavailable from this parent branch." }], details: { failureCode: "not_found" } };
      if (params.action === "recent") {
        const recent = recentThreadTranscript(selected.manager, { limit: params.limit, maxChars: params.maxChars });
        const name = selected.info.name ?? "Subagent";
        const summary = `Private subagent ${name} (${selected.info.id}) recent transcript: ${recent.returned} of ${recent.available} messages.`;
        const output = `${summary}${recent.text ? `\n\n${recent.text}` : "\n\nNo transcript messages."}${recent.truncated ? "\n\n[Transcript truncated.]" : ""}`;
        const outputTruncated = output.length > RECENT_THREAD_MAX_TOTAL_CHARS;
        const text = outputTruncated ? `${output.slice(0, RECENT_THREAD_MAX_TOTAL_CHARS - 1)}…` : output;
        return {
          content: [{ type: "text" as const, text }],
          details: { ...resultDetails("agent", selected.info.id), action: "recent", returned: recent.returned, available: recent.available, truncated: recent.truncated || outputTruncated },
        };
      }
      const policy = agentPolicy(selected.manager, parent);
      if (!policy) return { content: [{ type: "text" as const, text: "Private subagent policy is invalid." }], details: { ...resultDetails("agent", selected.info.id), failureCode: "invalid_policy" } };
      return params.background
        ? startBackground("agent", selected.info.id, selected.info.path, ctx.cwd, params.prompt!, policy, ctx)
        : executeTurn("agent", selected.info.id, selected.info.path, ctx.cwd, params.prompt!, policy, signal, onUpdate, ctx);
    },
  });
  pi.registerTool(agentTool);

  const sessionTool = defineTool({
    name: "spawn_session",
    label: "Spawn Session",
    description: "Create, adopt, continue, or list ordinary Pi sessions when the child must be inspectable or openable separately. Set background true on create, adopt, or continue to return immediately, then use status or cancel with the returned session and run IDs. Use create with a self-contained kickoff and purpose-based name, continue the returned ID for follow-ups, and list only to recover sessions available from the current parent branch. Set project only when the user explicitly requests another project; relative paths resolve from the current project. Adopt only on the user's explicit request with an exact session ID from the current or selected project; adoption claims and immediately prompts that transcript while preserving its model and metadata. Never prompt or adopt a session open in another Pi process. Sessions use the selected project's normal runtime and cannot customize system instructions, thinking, tools, or extensions; use spawn_agent for a private customized runtime.",
    ...(sessionAvailability === "active" ? { promptGuidelines: SESSION_PROMPT_GUIDELINES } : {}),
    parameters: SessionParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const invalid = invalidInput("session", params);
      if (invalid) return { content: [{ type: "text" as const, text: invalid }], details: { failureCode: "invalid" } };
      const selectedModel = params.action === "create" ? params.model ?? defaultModel(ctx, allowedModels) : undefined;
      const unavailable = params.action === "create" && (params.model
        ? modelError(params.model, ctx, allowedModels)
        : selectedModel ? undefined : "No configured spawn models are currently available.");
      if (unavailable) return { content: [{ type: "text" as const, text: unavailable }], details: { failureCode: "model_unavailable" } };
      const parent = requireParent(ctx.sessionManager);
      const allowed = branchSpawnReferences(ctx.sessionManager, "session");
      if (params.action === "status" || params.action === "cancel") {
        if (!allowed.has(params.id!))
          return { content: [{ type: "text" as const, text: "Spawned session is unavailable from this parent branch." }], details: { failureCode: "not_found" } };
        return backgroundResult("session", params.id!, params.runId!, params.action === "cancel");
      }
      if (params.action === "list") {
        const entries = await listSpawnedSessions(parent, allowed);
        const threads = entries.map(({ info }) => threadInfo("session", info));
        return { content: [{ type: "text" as const, text: threads.length ? threads.map((item) => `${item.id} ${item.name ?? "Session"} (${item.messageCount} messages)`).join("\n") : "No spawned sessions on this parent branch." }], details: { threads } };
      }
      if (params.action === "create") {
        if (params.background && shuttingDown)
          return { content: [{ type: "text" as const, text: "Background spawning is unavailable during session shutdown." }], details: { failureCode: "shutting_down" } };
        if (Number(process.env.PI_SPAWN_DEPTH ?? 0) >= MAX_DEPTH)
          return { content: [{ type: "text" as const, text: `pi-spawn depth limit (${MAX_DEPTH}) reached.` }], details: { failureCode: "depth_limit" } };
        let cwd: string;
        try { cwd = projectCwd(ctx.cwd, params.project); }
        catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text" as const, text: message }], details: { failureCode: "invalid_project" } };
        }
        const created = createSpawnedSession(cwd, parent, params.name?.trim() || defaultName(params.prompt!), {
          model: selectedModel,
          hooks: requestSpawnHooks(pi),
        });
        return params.background
          ? startBackground("session", created.info.id, created.info.path, cwd, params.prompt!, created.policy, ctx)
          : executeTurn("session", created.info.id, created.info.path, cwd, params.prompt!, created.policy, signal, onUpdate, ctx);
      }
      if (params.action === "adopt") {
        try {
          const cwd = projectCwd(ctx.cwd, params.project);
          const existing = await findSessionForAdoption(cwd, params.id!, parent);
          const hooks = requestSpawnHooks(pi);
          if (params.background && shuttingDown)
            return { content: [{ type: "text" as const, text: "Background spawning is unavailable during session shutdown." }], details: { failureCode: "shutting_down" } };
          if (params.background && isThreadActive(existing.path))
            return { content: [{ type: "text" as const, text: "Spawned thread is already running in this Pi process." }], details: { failureCode: "busy" } };
          if (params.background) {
            claimSpawnedSession(existing.path, existing.id, parent, hooks);
            return startBackground("session", existing.id, existing.path, cwd, params.prompt!, sessionPolicy(SessionManager.open(existing.path), parent), ctx);
          }
          return executeTurn("session", existing.id, existing.path, cwd, params.prompt!, undefined, signal, onUpdate, ctx, () => claimSpawnedSession(existing.path, existing.id, parent, hooks));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text" as const, text: message }], details: { failureCode: error instanceof SessionAdoptionError ? error.code : error instanceof ProjectDirectoryError ? "invalid_project" : "adopt_error" } };
        }
      }
      const matches = await listSpawnedSessions(parent, allowed);
      const selected = matches.filter(({ info }) => info.id === params.id);
      if (selected.length !== 1) return { content: [{ type: "text" as const, text: selected.length ? "Spawned session ID is ambiguous." : "Spawned session is unavailable from this parent branch." }], details: { failureCode: selected.length ? "invalid" : "not_found" } };
      const [{ info, manager }] = selected;
      const policy = sessionPolicy(manager, parent);
      if (!policy) return { content: [{ type: "text" as const, text: "Spawned session policy is invalid." }], details: { ...resultDetails("session", info.id), failureCode: "invalid_policy" } };
      return params.background
        ? startBackground("session", info.id, info.path, info.cwd, params.prompt!, policy, ctx)
        : executeTurn("session", info.id, info.path, info.cwd, params.prompt!, policy, signal, onUpdate, ctx);
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
