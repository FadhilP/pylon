import type { Model } from "@earendil-works/pi-ai/compat";
import { ADVISOR_MAX_COST_USD } from "./config.ts";

export { ADVISOR_MAX_COST_USD };
type Rates = { input: number; output: number };
export type AdvisorBudget =
  | { maxTokens: number; estimatedInputCostUsd: number }
  | { error: "pricing_unavailable" | "input_cost_exceeds_budget" | "output_budget_exhausted" };

function applicableRates(model: Model<any>, inputTokens: number): Rates[] {
  return [model.cost, ...(model.cost.tiers ?? []).filter(tier => inputTokens > tier.inputTokensAbove)];
}

export function advisorBudget(
  model: Model<any>,
  estimatedInputTokens: number,
  desiredMaxTokens: number,
  maxCostUsd = ADVISOR_MAX_COST_USD,
): AdvisorBudget {
  const rates = applicableRates(model, estimatedInputTokens);
  if (
    !rates.length ||
    rates.some(
      rate => !Number.isFinite(rate.input) || rate.input < 0 || !Number.isFinite(rate.output) || rate.output < 0,
    )
  )
    return { error: "pricing_unavailable" };

  // Use highest applicable rates so non-monotonic pricing tiers cannot weaken the estimate.
  const inputRate = Math.max(...rates.map(rate => rate.input));
  const outputRate = Math.max(...rates.map(rate => rate.output));
  const estimatedInputCostUsd = (inputRate * estimatedInputTokens) / 1_000_000;
  const remaining = maxCostUsd - estimatedInputCostUsd;
  if (remaining < 0) return { error: "input_cost_exceeds_budget" };

  const affordableOutput = outputRate === 0 ? desiredMaxTokens : Math.floor((remaining * 1_000_000) / outputRate);
  const maxTokens = Math.min(desiredMaxTokens, model.maxTokens, affordableOutput);
  if (!Number.isFinite(maxTokens) || maxTokens < 1) return { error: "output_budget_exhausted" };
  return { maxTokens: Math.floor(maxTokens), estimatedInputCostUsd };
}
