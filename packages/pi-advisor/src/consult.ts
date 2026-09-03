import type { complete } from "@earendil-works/pi-ai/compat";
import {
  addCostParts,
  contextWindowTokensFromUsage,
  emptyCostParts,
  usageSnapshot,
  type CostParts,
} from "pylon-core/child-process";
import { ADVISOR_TIMEOUT_MS } from "./config.ts";
import { redact } from "./redact.ts";
import { isTransientProviderFailure, loadDelegateRetryPolicy, waitForDelegateRetry } from "./retry.ts";

export { ADVISOR_TIMEOUT_MS };
const FAILURE_MESSAGE_MAX_LENGTH = 500;

export type FailureCode =
  | "unavailable"
  | "timeout"
  | "aborted"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_response"
  | "budget_exceeded"
  | "pricing_unavailable"
  | "context_overflow";

export type AdvisorUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costParts: CostParts;
};
export const emptyUsage = (): AdvisorUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  costParts: emptyCostParts(),
});
const validUsageNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
function accumulateUsage(total: AdvisorUsage, usage: any): void {
  if (!usage) return;
  total.input += validUsageNumber(usage.input);
  total.output += validUsageNumber(usage.output);
  total.cacheRead += validUsageNumber(usage.cacheRead);
  total.cacheWrite += validUsageNumber(usage.cacheWrite);
  total.cost += validUsageNumber(usage.cost?.total);
  addCostParts(total.costParts, usage.cost);
}

export function failureMessage(value: unknown, fallback: string): string {
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : fallback;
  const clean =
    redact(message)
      .text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
      .trim() || fallback;
  return clean.length > FAILURE_MESSAGE_MAX_LENGTH ? `${clean.slice(0, FAILURE_MESSAGE_MAX_LENGTH - 3)}...` : clean;
}

/** One classifier for both provider-reported stop reasons and thrown errors. */
function classifyFailure(input: {
  timedOut: boolean;
  aborted: boolean;
  message: string;
  retryable: boolean;
}): FailureCode {
  if (input.timedOut) return "timeout";
  if (input.aborted) return "aborted";
  if (/429|rate.?limit/i.test(input.message)) return "rate_limited";
  return input.retryable ? "provider_unavailable" : "invalid_response";
}

export type ConsultProgress = { note?: string; usage: AdvisorUsage; contextTokens: number | null; attempts: number };
export type ConsultOptions = {
  complete: typeof complete;
  retryWait: typeof waitForDelegateRetry;
  model: any;
  request: { systemPrompt: string; messages: any[] };
  completeOptions: Record<string, unknown>;
  signal: AbortSignal;
  isTimedOut: () => boolean;
  onProgress: (progress: ConsultProgress) => void;
};
export type ConsultResult =
  | { ok: true; raw: string; usage: AdvisorUsage; contextTokens: number | null; attempts: number }
  | {
      ok: false;
      code: FailureCode;
      message: string;
      usage: AdvisorUsage;
      contextTokens: number | null;
      attempts: number;
    };

const responseText = (content: readonly any[]) =>
  content
    .filter(part => part.type === "text")
    .map(part => part.text)
    .join("\n")
    .trim();

/**
 * Runs the advisor completion, retrying transient provider failures while nothing has been billed.
 * Never throws: every outcome comes back as a ConsultResult for the caller to format.
 */
export async function runConsultation(options: ConsultOptions): Promise<ConsultResult> {
  const usage = emptyUsage();
  const retryPolicy = await loadDelegateRetryPolicy();
  let attempts = 0;
  let contextTokens: number | null = null;
  // Progress observers must not control provider execution.
  const report = (progress: ConsultProgress) => {
    try {
      options.onProgress({ ...progress, usage: usageSnapshot(progress.usage) });
    } catch {
      /* ignore */
    }
  };
  const retry = async (retryable: boolean) => {
    if (attempts >= retryPolicy.maxAttempts || usage.cost !== 0 || !retryable) return false;
    if (!(await options.retryWait(attempts, options.signal, retryPolicy.baseMs))) return false;
    contextTokens = null;
    report({
      note: `Advisor provider unavailable; retrying (${attempts + 1}/${retryPolicy.maxAttempts})…`,
      usage,
      attempts,
      contextTokens,
    });
    return true;
  };

  for (;;) {
    attempts++;
    try {
      const response = await options.complete(options.model, options.request as any, options.completeOptions as any);
      accumulateUsage(usage, response.usage);
      const raw = responseText(response.content);
      const failed = response.stopReason === "error" || response.stopReason === "aborted" || !raw;
      const latestContextTokens = contextWindowTokensFromUsage(response.usage);
      contextTokens = !failed && latestContextTokens > 0 ? latestContextTokens : null;
      report({ usage, contextTokens, attempts });
      if (!failed) return { ok: true, raw, usage, contextTokens, attempts };

      const retryable = response.stopReason === "error" && isTransientProviderFailure(response.errorMessage);
      if (await retry(retryable)) continue;
      const aborted = response.stopReason === "aborted";
      return {
        ok: false,
        code: classifyFailure({
          timedOut: aborted && options.isTimedOut(),
          aborted,
          message: response.errorMessage ?? "",
          retryable,
        }),
        message: failureMessage(
          response.errorMessage,
          raw ? "Provider returned an error without a message." : "Provider returned no text content.",
        ),
        usage,
        contextTokens,
        attempts,
      };
    } catch (error) {
      if (await retry(isTransientProviderFailure(error))) continue;
      const message = String((error as any)?.message ?? error);
      const timedOut = options.isTimedOut();
      return {
        ok: false,
        code: classifyFailure({
          timedOut,
          aborted: options.signal.aborted && !timedOut,
          message,
          retryable: isTransientProviderFailure(message),
        }),
        message: failureMessage(error, "Advisor request failed without an Error message."),
        usage,
        contextTokens,
        attempts,
      };
    }
  }
}
