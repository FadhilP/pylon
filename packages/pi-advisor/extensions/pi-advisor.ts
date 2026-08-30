import { complete, type Message, type Model } from "@earendil-works/pi-ai/compat";
import { sessionEntryToContextMessages, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ADVISOR_MAX_CALLS, capAdvice } from "../src/advisor.ts";
import { ADVISOR_MAX_COST_USD, advisorBudget } from "../src/budget.ts";
import { ADVISOR_PROMPT } from "../src/prompts.ts";
import {
  configPath,
  loadConfig,
  parseModelRef,
  resetConfig,
  saveConfig,
  thinkingLevels,
  type AdvisorConfig,
  type ThinkingLevel,
} from "../src/config.ts";
import {
  ADVISOR_TIMEOUT_MS,
  emptyUsage,
  runConsultation,
  type AdvisorUsage,
  type FailureCode,
} from "../src/consult.ts";
import {
  advisorMaxTokens,
  buildSnapshot,
  type DuplicateTelemetry,
  type SectionAllocation,
  type Snapshot,
} from "../src/context.ts";
import { loadEvidenceRecords, type EvidenceRef } from "../src/evidence.ts";
import { waitForDelegateRetry } from "../src/retry.ts";

type Details = {
  agentName?: string;
  startedAt?: string;
  advisorModel?: string;
  provider?: string;
  model?: string;
  durationMs: number;
  usage: AdvisorUsage;
  thinking?: string;
  contextTokens?: number | null;
  contextLimit?: number;
  callNumber: 1 | 2 | 3;
  snapshotEstimatedTokens: number;
  redactionCount: number;
  truncated: boolean;
  cacheRetention: "short" | "long";
  omittedEvidence?: EvidenceRef[];
  sectionAllocations?: Record<string, SectionAllocation>;
  duplicateTelemetry?: DuplicateTelemetry;
  failureCode?: FailureCode;
  failureMessage?: string;
  attempts?: number;
};
const modelName = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
const HEARTBEAT_MS = 1_000;

const snapshotDetails = (snapshot: Snapshot) => ({
  snapshotEstimatedTokens: snapshot.estimatedTokens,
  redactionCount: snapshot.redactionCount,
  truncated: snapshot.truncated,
  omittedEvidence: snapshot.omittedEvidence,
  sectionAllocations: snapshot.sectionAllocations,
  duplicateTelemetry: snapshot.duplicateTelemetry,
});
const textResult = (text: string, details: Details) => ({ content: [{ type: "text" as const, text }], details });
const configuredModel = (ctx: any, config: AdvisorConfig): Model<any> | undefined => {
  if (config.useMainModel) return ctx.model;
  if (!config.advisorModel) return undefined;
  const ref = parseModelRef(config.advisorModel);
  return ref ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
};
function delegatedName(pi: ExtensionAPI, callId: string): string {
  let assigned: string | undefined;
  pi.events.emit("pylon:delegate-name", {
    version: 1,
    kind: "advisor",
    callId,
    respond: (name: unknown) => {
      if (typeof name === "string" && /^A\d+$/.test(name)) assigned = name;
    },
  });
  return assigned ?? `A-${callId.replace(/[^a-z0-9]/gi, "").slice(-4) || "run"}`;
}

type CallLifecycle = { signal: AbortSignal; isTimedOut: () => boolean };
/** Owns the abort chain, the hard timeout, and the progress heartbeat for one consultation. */
async function withCallLifecycle<T>(
  outerSignal: AbortSignal | undefined,
  onHeartbeat: () => void,
  run: (lifecycle: CallLifecycle) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  outerSignal?.addEventListener("abort", abort, { once: true });
  if (outerSignal?.aborted) abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ADVISOR_TIMEOUT_MS);
  const heartbeat = setInterval(onHeartbeat, HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await run({ signal: controller.signal, isTimedOut: () => timedOut });
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    outerSignal?.removeEventListener("abort", abort);
  }
}

export default function advisorExtension(
  pi: ExtensionAPI,
  completeAdvisor = complete,
  retryWait = waitForDelegateRetry,
) {
  let calls = 0;
  let previousAdvice: string | undefined;
  let advisorQueue = Promise.resolve();
  const serializeAdvisor = async <T>(run: () => Promise<T>): Promise<T> => {
    const previousRun = advisorQueue;
    let releaseRun = () => {};
    advisorQueue = new Promise<void>(resolve => {
      releaseRun = resolve;
    });
    await previousRun;
    try {
      return await run();
    } finally {
      releaseRun();
    }
  };
  const refreshTool = async (ctx: any, agentDir?: string) => {
    const config = await loadConfig(agentDir ? configPath(agentDir) : undefined);
    const model = configuredModel(ctx, config);
    const enabled = Boolean(model && ctx.modelRegistry.hasConfiguredAuth(model));
    let coordinated = false;
    pi.events.emit("pylon:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-advisor",
      managedTools: ["advisor"],
      enabledTools: enabled ? ["advisor"] : [],
      ...(enabled
        ? {
            toolUsage: {
              advisor: "review consequential decisions, architecture, migrations, security, or broad regression risk",
            },
          }
        : {}),
      acknowledge: () => {
        coordinated = true;
      },
    });
    if (coordinated) return;
    const active = pi.getActiveTools().filter(name => name !== "advisor");
    if (enabled) active.push("advisor");
    pi.setActiveTools(active);
  };

  pi.on("input", event => {
    if (event.source !== "extension") {
      calls = 0;
      previousAdvice = undefined;
    }
  });
  let sessionContext: any;
  const disposeSettingsRefresh =
    pi.events.on?.("pylon:package-settings-changed", (request: any) => {
      if (
        request?.version !== 1 ||
        request.packageId !== "pi-advisor" ||
        typeof request.agentDir !== "string" ||
        typeof request.acknowledge !== "function"
      )
        return;
      request.acknowledge(() =>
        sessionContext
          ? refreshTool(sessionContext, request.agentDir)
          : Promise.reject(new Error("Advisor session is unavailable")),
      );
    }) ?? (() => {});
  pi.on("session_start", async (_event, ctx) => {
    sessionContext = ctx;
    await refreshTool(ctx);
  });
  pi.on("session_shutdown", () => {
    sessionContext = undefined;
    disposeSettingsRefresh();
    pi.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-advisor" });
  });

  type PreparedCall = {
    started: number;
    named: (value: string) => string;
    base: Details;
    model: Model<any>;
    auth: any;
    snapshot: Snapshot;
    budget: { maxTokens: number; estimatedInputCostUsd: number };
    thinking?: string;
    userMessage: Message;
    cacheRetention: "short" | "long";
  };
  type PrepareResult = { ok: true; call: PreparedCall } | { ok: false; result: ReturnType<typeof textResult> };

  /** Everything that must hold before a provider call: quota, model, credentials, snapshot, budget. */
  const prepareCall = async (id: string, params: any, ctx: any): Promise<PrepareResult> => {
    const cacheRetention: "short" | "long" = process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
    if (calls >= ADVISOR_MAX_CALLS)
      return {
        ok: false,
        result: textResult("Advisor call limit reached for this request.", {
          durationMs: 0,
          usage: emptyUsage(),
          callNumber: ADVISOR_MAX_CALLS,
          snapshotEstimatedTokens: 0,
          redactionCount: 0,
          truncated: false,
          cacheRetention,
          failureCode: "unavailable",
        }),
      };

    const started = Date.now();
    const agentName = delegatedName(pi, id);
    const named = (value: string) => `[${agentName} · Advisor] ${value}`;
    const config = await loadConfig();
    const model = configuredModel(ctx, config);
    const thinking = config.thinking ?? (config.useMainModel ? pi.getThinkingLevel() : undefined);
    const base: Details = {
      agentName,
      startedAt: new Date(started).toISOString(),
      advisorModel: model ? modelName(model) : undefined,
      provider: model?.provider,
      model: model?.id,
      thinking,
      durationMs: 0,
      usage: emptyUsage(),
      callNumber: Math.min(calls + 1, ADVISOR_MAX_CALLS) as Details["callNumber"],
      snapshotEstimatedTokens: 0,
      redactionCount: 0,
      truncated: false,
      cacheRetention,
    };
    const fail = (text: string, code: FailureCode, extra: Partial<Details> = {}): PrepareResult => ({
      ok: false,
      result: textResult(text, { ...base, ...extra, failureCode: code }),
    });

    if (!model) return fail("Advisor unavailable: no valid model selected.", "unavailable");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return fail("Advisor unavailable: selected model has no credentials.", "unavailable");

    const messages: any[] = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
    messages.push({ role: "custom", customType: "advisor-request", content: params.request.trim() });
    for (const record of await loadEvidenceRecords(ctx.cwd, params.evidence))
      messages.push({
        role: "custom",
        customType: "advisor-evidence",
        content: record.text,
        evidenceRef: record.ref,
        evidenceUnavailable: record.unavailable,
      });

    const continuationPrefix = previousAdvice
      ? `Continue as the same advisor. Prior guidance:\n\n${previousAdvice}\n\nCurrent executor snapshot:\n\n`
      : "";
    const reservedInputTokens = Math.ceil((ADVISOR_PROMPT.length + continuationPrefix.length) / 4) + 256;
    const snapshot = buildSnapshot(messages, model.contextWindow, reservedInputTokens);
    if (snapshot.requiredContextOmitted)
      return fail(
        named("Advisor failed nonfatally: required context exceeds the input budget."),
        "context_overflow",
        snapshotDetails(snapshot),
      );

    const budget = advisorBudget(
      model,
      snapshot.estimatedTokens + reservedInputTokens,
      advisorMaxTokens(model.contextWindow),
    );
    if ("error" in budget) {
      const reason =
        budget.error === "pricing_unavailable"
          ? "selected model pricing is unavailable"
          : budget.error === "input_cost_exceeds_budget"
            ? "estimated input cost exceeds the limit"
            : "estimated output budget is exhausted";
      return fail(
        named(`Advisor failed nonfatally: ${reason} ($${ADVISOR_MAX_COST_USD.toFixed(2)} limit).`),
        budget.error === "pricing_unavailable" ? "pricing_unavailable" : "budget_exceeded",
        snapshotDetails(snapshot),
      );
    }

    const userMessage: Message = {
      role: "user",
      content: [{ type: "text", text: `${continuationPrefix}${snapshot.text}` }],
      timestamp: Date.now(),
    };
    return {
      ok: true,
      call: { started, named, base, model, auth, snapshot, budget, thinking, userMessage, cacheRetention },
    };
  };

  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description:
      "Send configured tool-free strategic advisor a concrete request using a redacted bounded snapshot of current executor context plus optional high-priority workspace file ranges. Maximum three successful consultations per original user prompt; failures do not consume quota.",
    promptSnippet: "Consult selected strategic model for difficult planning, review, or failure recovery",
    promptGuidelines: [
      "Use one advisor consultation before implementation only when both conditions hold: multiple credible approaches have meaningful tradeoffs and repository precedent does not clearly determine the solution; and a wrong choice risks security or privacy, data loss, compatibility or migration failure, or broad cross-module regression. Skip advisor for local fixes, established repository patterns, routine refactors, test additions, dependency-free changes, and decisions reversible in one small diff.",
      "Call advisor after focused reads or repo_scout establish evidence, before choosing an approach. Consult again after implementation only when implementation exposes new risks, contradicts assumptions, or verification fails ambiguously—not by default. Reserve a third advisor call for material contradictions, failures, or unresolved risks.",
      "Give advisor a concrete decision, risk, or approach to review plus only the highest-priority cited file ranges. Usually provide 3–5 concise, non-overlapping ranges; use up to 8 only when each range is independently necessary, and avoid redundant evidence. Prefer complete decisive definitions, callers, and checks over broad file slices; 150–300 total evidence lines is a selection signal, not a hard cap, and may be exceeded when decisive context requires it. Advisor critiques evidence, reasoning, risks, and direction; Scout gathers evidence; main model decides, verifies evidence, and performs tools.",
    ],
    parameters: Type.Object(
      {
        request: Type.String({
          minLength: 1,
          maxLength: 8_192,
          description: "Concrete decision, risk, or approach for the advisor to review",
        }),
        evidence: Type.Optional(
          Type.Array(
            Type.Object(
              {
                path: Type.String({ minLength: 1, maxLength: 500 }),
                start: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
                end: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
                claim: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
                revision: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
                verification: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
              },
              { additionalProperties: false },
            ),
            {
              maxItems: 8,
              description:
                "Usually 3–5 concise, non-overlapping decisive ranges; use up to 8 only when independently necessary; usually 150–300 total lines, exceeding that when required for correctness",
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(id, params, signal, onUpdate, ctx) {
      return serializeAdvisor(async () => {
        if (signal?.aborted) throw new DOMException("Advisor call was aborted.", "AbortError");
        const prepared = await prepareCall(id, params, ctx);
        if (!prepared.ok) return prepared.result;
        const { started, named, base, model, auth, snapshot, budget, thinking, userMessage, cacheRetention } =
          prepared.call;
        let contextTokens: number | null = null;
        const contextLimit = model.contextWindow;

        if (ctx.hasUI) ctx.ui.setStatus("pi-advisor", `advisor: consulting ${modelName(model)}…`);
        const { usage: _usage, ...runningDetails } = base;
        const running = (text: string, extra: Record<string, unknown> = {}) =>
          onUpdate?.({
            content: [{ type: "text", text }],
            details: { ...runningDetails, state: "running", contextTokens, contextLimit, ...extra },
          });
        running(`Consulting ${modelName(model)}…`, snapshotDetails(snapshot));

        try {
          const result = await withCallLifecycle(
            signal,
            () => running(`${((Date.now() - started) / 1000).toFixed(0)}s`, { durationMs: Date.now() - started }),
            lifecycle =>
              runConsultation({
                complete: completeAdvisor,
                retryWait,
                model,
                request: { systemPrompt: ADVISOR_PROMPT, messages: [userMessage] },
                completeOptions: {
                  apiKey: auth.apiKey,
                  headers: auth.headers,
                  env: auth.env,
                  signal: lifecycle.signal,
                  timeoutMs: ADVISOR_TIMEOUT_MS,
                  maxTokens: budget.maxTokens,
                  cacheRetention,
                  sessionId: `${ctx.sessionManager.getSessionId()}:advisor`,
                  ...(thinking
                    ? { reasoning: thinking === "off" ? undefined : thinking }
                    : process.env.PI_ADVISOR_THINKING
                      ? { reasoning: process.env.PI_ADVISOR_THINKING }
                      : {}),
                },
                signal: lifecycle.signal,
                isTimedOut: lifecycle.isTimedOut,
                onProgress: ({ note, usage, contextTokens: latestContextTokens, attempts }) => {
                  contextTokens = latestContextTokens;
                  running(note ?? "Advisor usage updated", {
                    durationMs: Date.now() - started,
                    usage: { ...usage },
                    attempts,
                  });
                },
              }),
          );

          const details: Details = {
            ...base,
            durationMs: Date.now() - started,
            usage: result.usage,
            contextTokens,
            contextLimit,
            ...snapshotDetails(snapshot),
            attempts: result.attempts,
          };
          if (!result.ok)
            return textResult(named(`Advisor failed nonfatally: ${result.code}.`), {
              ...details,
              failureCode: result.code,
              failureMessage: result.message,
            });

          const advice = capAdvice(result.raw);
          calls++;
          previousAdvice = advice.text;
          return textResult(`${named("Advice:")}\n\n${advice.text}`, {
            ...details,
            truncated: snapshot.truncated || advice.truncated,
          });
        } finally {
          if (ctx.hasUI) ctx.ui.setStatus("pi-advisor", undefined);
        }
      });
    },
    renderCall(args, theme, context) {
      const callNumber = (context.state.callNumber as number | undefined) ?? Math.min(calls + 1, ADVISOR_MAX_CALLS);
      context.state.callNumber = callNumber;
      const request = args.request?.trim().replace(/\s+/g, " ") ?? "";
      const truncatedRequest = request.length > 512 ? `${request.slice(0, 509)}...` : request;
      return new Text(
        theme.fg("toolTitle", theme.bold("Advisor")) +
          theme.fg("muted", ` · ${callNumber}/${ADVISOR_MAX_CALLS}`) +
          (truncatedRequest ? `\n${theme.fg("dim", truncatedRequest)}` : ""),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as Details | undefined;
      const body = result.content.find((part: any) => part.type === "text") as any;
      if (!details) return new Text(body?.text ?? "Advisor", 0, 0);
      let text = theme.fg(
        details.failureCode ? "error" : "success",
        `Advisor${details.failureCode ? " failed" : ""} · ${details.advisorModel ?? "Unavailable"}`,
      );
      if (!details.failureCode && details.usage)
        text += ` · ${details.usage.input} input · ${details.usage.output} output · R${details.usage.cacheRead} · W${details.usage.cacheWrite} · $${details.usage.cost.toFixed(4)} · ${(details.durationMs / 1000).toFixed(1)}s`;
      else if (details.durationMs) text += ` · ${(details.durationMs / 1000).toFixed(0)}s`;
      if (details.failureCode && body?.text) text += `\n${body.text}`;
      else if (expanded && body?.text) text += `\n\nAdvisor report:\n${body.text}`;
      return new Text(text, 0, 0);
    },
  });

  const confirmContextSharing = async (ctx: any, model: Model<any>): Promise<boolean> =>
    ctx.mode !== "tui" ||
    (await ctx.ui.confirm(
      "Share current context with advisor?",
      `Advisor receives a redacted snapshot of current Pi conversation, including user prompts, assistant text, and relevant tool results. Continue with ${modelName(model)}?`,
    ));

  const disableAdvisor = async (ctx: any) => {
    await resetConfig();
    await refreshTool(ctx);
    ctx.ui.notify("Advisor disabled.", "info");
  };
  const resetAdvisor = async (ctx: any) => {
    const model = ctx.model;
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
      ctx.ui.notify("Current main model is unavailable.", "error");
      return;
    }
    if (!(await confirmContextSharing(ctx, model))) return;
    await saveConfig({ version: 1, useMainModel: true });
    await refreshTool(ctx);
    ctx.ui.notify("Advisor enabled; uses current main model and thinking level.", "info");
  };
  const showAdvisorStatus = async (ctx: any) => {
    const config = await loadConfig();
    const model = configuredModel(ctx, config);
    ctx.ui.notify(
      `Selected: ${config.useMainModel ? "current main model" : (config.advisorModel ?? "none")}\nThinking: ${config.useMainModel ? "current main level" : (config.thinking ?? "provider default")}\nState: ${model && ctx.modelRegistry.hasConfiguredAuth(model) ? "active" : "inactive"}\nLimit: ${ADVISOR_MAX_CALLS} calls per original user prompt`,
      "info",
    );
  };
  const selectAdvisorModel = async (value: string, ctx: any) => {
    let selected = value;
    if (!selected) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Usage: /advisor <provider/model-id[:thinking]>|disable|reset|status", "info");
        return;
      }
      selected =
        (await ctx.ui.select(
          "Advisor model",
          (ctx.scopedModels.length
            ? ctx.scopedModels.map(({ model }: any) => model)
            : ctx.modelRegistry.getAvailable()
          ).map(modelName),
        )) ?? "";
      if (!selected) return;
    }
    const ref = parseModelRef(selected);
    const model = ref && ctx.modelRegistry.find(ref.provider, ref.id);
    if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
      ctx.ui.notify(`Unavailable model: ${selected}`, "error");
      return;
    }
    let thinking: ThinkingLevel | undefined = ref.thinking;
    if (!value && ctx.mode === "tui") {
      thinking = (await ctx.ui.select("Advisor thinking level", [...thinkingLevels])) as ThinkingLevel | undefined;
      if (!thinking) return;
    }
    if (!(await confirmContextSharing(ctx, model))) return;
    await saveConfig({ version: 1, advisorModel: modelName(model), ...(thinking ? { thinking } : {}) });
    await refreshTool(ctx);
    ctx.ui.notify(`Advisor model: ${modelName(model)}\nThinking: ${thinking ?? "provider default"}`, "info");
  };

  pi.registerCommand("advisor", {
    description: "Select model and thinking, reset, or show status",
    handler: async (args, ctx) => {
      const subcommands: Record<string, (ctx: any) => Promise<void>> = {
        disable: disableAdvisor,
        reset: resetAdvisor,
        status: showAdvisorStatus,
      };
      const value = args.trim();
      const subcommand = subcommands[value];
      if (subcommand) return subcommand(ctx);
      return selectAdvisorModel(value, ctx);
    },
  });
}
