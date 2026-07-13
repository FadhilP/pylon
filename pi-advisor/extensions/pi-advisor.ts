import {
  complete,
  type Message,
  type Model,
} from "@earendil-works/pi-ai/compat";
import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ADVISOR_MAX_CALLS, ADVISOR_PROMPT, capAdvice } from "../src/advisor.ts";
import {
  loadConfig,
  parseModelRef,
  resetConfig,
  saveConfig,
  thinkingLevels,
  type ThinkingLevel,
} from "../src/config.ts";
import { advisorMaxTokens, buildSnapshot } from "../src/context.ts";
import { loadEvidence } from "../src/evidence.ts";

type FailureCode =
  | "unavailable"
  | "timeout"
  | "aborted"
  | "rate_limited"
  | "invalid_response";
type Details = {
  advisorModel?: string;
  durationMs: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  };
  callNumber: 1 | 2 | 3;
  snapshotEstimatedTokens: number;
  redactionCount: number;
  truncated: boolean;
  cacheRetention: "short" | "long";
  failureCode?: FailureCode;
};
const emptyUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
});
const modelName = (model: { provider: string; id: string }) =>
  `${model.provider}/${model.id}`;
const ADVISOR_TIMEOUT_MS = 15 * 60 * 1000;
function errorCode(
  error: unknown,
  aborted: boolean,
  timedOut: boolean,
): FailureCode {
  if (timedOut) return "timeout";
  if (aborted) return "aborted";
  return /429|rate.?limit/i.test(String((error as any)?.message ?? error))
    ? "rate_limited"
    : "invalid_response";
}

export default function (pi: ExtensionAPI) {
  let calls = 0;
  let originalPrompt = "";
  let previousAdvice: string | undefined;
  const configuredModel = async (ctx: any): Promise<Model<any> | undefined> => {
    const config = await loadConfig();
    if (!config.advisorModel) return;
    const ref = parseModelRef(config.advisorModel);
    return ref ? ctx.modelRegistry.find(ref.provider, ref.id) : undefined;
  };
  const refreshTool = async (ctx: any) => {
    const model = await configuredModel(ctx);
    const enabled = Boolean(model && ctx.modelRegistry.hasConfiguredAuth(model));
    let coordinated = false;
    pi.events.emit("pi-conductor:tool-policy", {
      version: 1,
      kind: "register",
      owner: "pi-advisor",
      managedTools: ["advisor"],
      enabledTools: enabled ? ["advisor"] : [],
      acknowledge: () => { coordinated = true; },
    });
    if (coordinated) return;
    const active = pi.getActiveTools().filter((name) => name !== "advisor");
    if (enabled) active.push("advisor");
    pi.setActiveTools(active);
  };

  pi.on("input", (event) => {
    if (event.source !== "extension") {
      calls = 0;
      originalPrompt = event.text.trim();
      previousAdvice = undefined;
    }
  });
  pi.on("session_start", async (_event, ctx) => {
    await refreshTool(ctx);
  });
  pi.on("session_shutdown", () => {
    pi.events.emit("pi-conductor:tool-policy", {
      version: 1,
      kind: "unregister",
      owner: "pi-advisor",
    });
  });

  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description:
      "Consult configured tool-free strategic advisor using a redacted bounded snapshot of current executor context plus optional high-priority workspace file ranges. Maximum three calls per original user prompt.",
    promptSnippet:
      "Consult selected strategic model for difficult planning, review, or failure recovery",
    promptGuidelines: [
      "Use advisor for consequential non-local decisions, difficult planning, review, or failure recovery; skip trivial, local, or single-turn work. First call: after focused reads or repo_scout establish evidence, before choosing an approach. Second call: use when implementation, competing evidence, or review changes the decision; do not wait for completion. Third call: reserve for material new evidence, contradictions, or test/failure results that leave the decision unresolved. Pass only highest-priority cited file ranges through evidence so Advisor can inspect primary source. Advisor critiques evidence, reasoning, risks, and proposed direction; Scout gathers evidence, main model owns the final decision. Advisor recommends; verify evidence and perform tools yourself.",
    ],
    parameters: Type.Object(
      {
        evidence: Type.Optional(
          Type.Array(
            Type.Object(
              {
                path: Type.String({ minLength: 1, maxLength: 500 }),
                start: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
                end: Type.Integer({ minimum: 1, maximum: 10_000_000 }),
              },
              { additionalProperties: false },
            ),
            { maxItems: 5 },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, onUpdate, ctx) {
      const callNumber = Math.min(calls + 1, ADVISOR_MAX_CALLS) as Details["callNumber"];
      const cacheRetention: "short" | "long" =
        process.env.PI_CACHE_RETENTION === "long" ? "long" : "short";
      if (calls >= ADVISOR_MAX_CALLS)
        return {
          content: [
            {
              type: "text" as const,
              text: "Advisor call limit reached for this request.",
            },
          ],
          details: {
            durationMs: 0,
            usage: emptyUsage(),
            callNumber: ADVISOR_MAX_CALLS,
            snapshotEstimatedTokens: 0,
            redactionCount: 0,
            truncated: false,
            cacheRetention,
            failureCode: "unavailable" as const,
          },
        };
      const started = Date.now();
      const model = await configuredModel(ctx);
      const config = await loadConfig();
      const base = {
        advisorModel: model ? modelName(model) : undefined,
        durationMs: 0,
        usage: emptyUsage(),
        callNumber,
        snapshotEstimatedTokens: 0,
        redactionCount: 0,
        truncated: false,
        cacheRetention,
      };
      if (!model)
        return {
          content: [
            {
              type: "text" as const,
              text: "Advisor unavailable: no valid model selected.",
            },
          ],
          details: { ...base, failureCode: "unavailable" as const },
        };
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey)
        return {
          content: [
            {
              type: "text" as const,
              text: "Advisor unavailable: selected model has no credentials.",
            },
          ],
          details: { ...base, failureCode: "unavailable" as const },
        };
      calls++;
      const messages: any[] = ctx.sessionManager
        .buildContextEntries()
        .flatMap(sessionEntryToContextMessages);
      const evidence = await loadEvidence(ctx.cwd, params.evidence);
      if (evidence)
        messages.push({
          role: "custom",
          customType: "advisor-evidence",
          content: evidence,
        });
      const continuationPrefix = previousAdvice
        ? `Continue as the same advisor. Prior guidance:\n\n${previousAdvice}\n\nCurrent executor snapshot:\n\n`
        : "";
      const reservedInputTokens = Math.ceil(
        (ADVISOR_PROMPT.length + continuationPrefix.length) / 4,
      ) + 256;
      const snapshot = buildSnapshot(
        ctx.getSystemPrompt(),
        messages,
        model.contextWindow,
        reservedInputTokens,
      );
      if (ctx.hasUI)
        ctx.ui.setStatus(
          "pi-advisor",
          `advisor: consulting ${modelName(model)}…`,
        );
      onUpdate?.({
        content: [{ type: "text", text: `Consulting ${modelName(model)}…` }],
        details: {
          ...base,
          snapshotEstimatedTokens: snapshot.estimatedTokens,
          redactionCount: snapshot.redactionCount,
          truncated: snapshot.truncated,
        },
      });
      const controller = new AbortController();
      let timedOut = false;
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, ADVISOR_TIMEOUT_MS);
      try {
        const userMessage: Message = {
          role: "user",
          content: [
            {
              type: "text",
              text: `${continuationPrefix}${snapshot.text}`,
            },
          ],
          timestamp: Date.now(),
        };
        const response = await complete(
          model,
          { systemPrompt: ADVISOR_PROMPT, messages: [userMessage] },
          {
            apiKey: auth.apiKey,
            headers: auth.headers,
            env: auth.env,
            signal: controller.signal,
            timeoutMs: ADVISOR_TIMEOUT_MS,
            maxTokens: advisorMaxTokens(model.contextWindow),
            cacheRetention,
            sessionId: ctx.sessionManager.getSessionId(),
            ...(config.thinking
              ? {
                  reasoning:
                    config.thinking === "off" ? undefined : config.thinking,
                }
              : process.env.PI_ADVISOR_THINKING
                ? { reasoning: process.env.PI_ADVISOR_THINKING }
                : {}),
          },
        );
        const raw = response.content
          .filter((part) => part.type === "text")
          .map((part) => (part as any).text)
          .join("\n")
          .trim();
        if (
          response.stopReason === "error" ||
          response.stopReason === "aborted" ||
          !raw
        ) {
          const code =
            response.stopReason === "aborted"
              ? timedOut
                ? "timeout"
                : "aborted"
              : /429|rate.?limit/i.test(response.errorMessage ?? "")
                ? "rate_limited"
                : "invalid_response";
          return {
            content: [
              {
                type: "text" as const,
                text: `Advisor failed nonfatally: ${code}.`,
              },
            ],
            details: {
              ...base,
              durationMs: Date.now() - started,
              snapshotEstimatedTokens: snapshot.estimatedTokens,
              redactionCount: snapshot.redactionCount,
              truncated: snapshot.truncated,
              failureCode: code,
            },
          };
        }
        const advice = capAdvice(raw);
        previousAdvice = advice.text;
        const usage = response.usage;
        const details: Details = {
          ...base,
          durationMs: Date.now() - started,
          usage: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            cost: usage.cost.total,
          },
          snapshotEstimatedTokens: snapshot.estimatedTokens,
          redactionCount: snapshot.redactionCount,
          truncated: snapshot.truncated || advice.truncated,
        };
        return {
          content: [
            {
              type: "text" as const,
              text: `Advisor guidance ready.\n\n${advice.text}`,
            },
          ],
          details,
        };
      } catch (error) {
        const code = errorCode(
          error,
          controller.signal.aborted && !timedOut,
          timedOut,
        );
        return {
          content: [
            {
              type: "text" as const,
              text: `Advisor failed nonfatally: ${code}.`,
            },
          ],
          details: {
            ...base,
            durationMs: Date.now() - started,
            snapshotEstimatedTokens: snapshot.estimatedTokens,
            redactionCount: snapshot.redactionCount,
            truncated: snapshot.truncated,
            failureCode: code,
          },
        };
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (ctx.hasUI) ctx.ui.setStatus("pi-advisor", undefined);
      }
    },
    renderCall(_args, theme, context) {
      const callNumber = (context.state.callNumber as number | undefined) ??
        Math.min(calls + 1, ADVISOR_MAX_CALLS);
      context.state.callNumber = callNumber;
      const prompt = originalPrompt.replace(/\s+/g, " ");
      const truncatedPrompt = prompt.length > 256 ? `${prompt.slice(0, 253)}...` : prompt;
      return new Text(
        theme.fg("toolTitle", theme.bold("Advisor")) +
          theme.fg("muted", ` · ${callNumber}/${ADVISOR_MAX_CALLS}`) +
          (truncatedPrompt ? `\n${theme.fg("dim", truncatedPrompt)}` : ""),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as Details | undefined;
      const body = result.content.find(
        (part: any) => part.type === "text",
      ) as any;
      if (!details) return new Text(body?.text ?? "Advisor", 0, 0);
      let text = theme.fg(
        details.failureCode ? "warning" : "success",
        `Advisor · ${details.advisorModel ?? "Unavailable"}`,
      );
      if (!details.failureCode)
        text += theme.fg(
          "dim",
          ` · ${details.usage.input} input · ${details.usage.output} output · R${details.usage.cacheRead} · W${details.usage.cacheWrite} · $${details.usage.cost.toFixed(4)} · ${(details.durationMs / 1000).toFixed(1)}s`,
        );
      const recommendation = body?.text?.match(
        /## Recommended approach\s*\n([^\n]+)/i,
      )?.[1];
      if (!expanded && recommendation) text += `\n${recommendation}`;
      if (expanded && body?.text)
        text += `\n\n${body.text}\n\nredactions: ${details.redactionCount} · truncated: ${details.truncated}`;
      return new Text(text, 0, 0);
    },
  });

  pi.registerCommand("advisor", {
    description: "Select model and thinking, reset, or show status",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (value === "disable" || value === "reset") {
        await resetConfig();
        await refreshTool(ctx);
        ctx.ui.notify("Advisor disabled.", "info");
        return;
      }
      if (value === "status") {
        const config = await loadConfig();
        const model = await configuredModel(ctx);
        ctx.ui.notify(
          `Selected: ${config.advisorModel ?? "none"}\nThinking: ${config.thinking ?? "provider default"}\nState: ${model && ctx.modelRegistry.hasConfiguredAuth(model) ? "active" : "inactive"}\nLimit: ${ADVISOR_MAX_CALLS} calls per original user prompt`,
          "info",
        );
        return;
      }
      let selected = value;
      if (!selected) {
        if (ctx.mode !== "tui") {
          ctx.ui.notify(
            "Usage: /advisor <provider/model-id[:thinking]>|disable|reset|status",
            "info",
          );
          return;
        }
        selected =
          (await ctx.ui.select(
            "Advisor model",
            ctx.modelRegistry.getAvailable().map(modelName),
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
        thinking = (await ctx.ui.select("Advisor thinking level", [...thinkingLevels])) as
          | ThinkingLevel
          | undefined;
        if (!thinking) return;
      }
      if (ctx.mode === "tui") {
        const ok = await ctx.ui.confirm(
          "Share current context with advisor?",
          `Advisor receives a redacted snapshot of current Pi conversation, including user prompts, assistant text, and relevant tool results. Continue with ${modelName(model)}?`,
        );
        if (!ok) return;
      }
      await saveConfig({
        schemaVersion: 1,
        advisorModel: modelName(model),
        ...(thinking ? { thinking } : {}),
      });
      await refreshTool(ctx);
      ctx.ui.notify(
        `Advisor model: ${modelName(model)}\nThinking: ${thinking ?? "provider default"}`,
        "info",
      );
    },
  });
}
