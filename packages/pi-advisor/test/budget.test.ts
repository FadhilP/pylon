import test from "node:test";
import assert from "node:assert/strict";
import { ADVISOR_MAX_COST_USD, advisorBudget } from "../src/budget.ts";

const model = (cost: any, maxTokens = 100_000) => ({ cost, maxTokens }) as any;

test("advisor budget defaults to $0.50 and limits output tokens", () => {
  assert.equal(ADVISOR_MAX_COST_USD, 0.5);
  assert.deepEqual(
    advisorBudget(
      model({ input: 3, output: 100, cacheRead: 0, cacheWrite: 0 }),
      100_000,
      8_192,
    ),
    { maxTokens: 2_000, estimatedInputCostUsd: 0.3 },
  );
});

test("advisor budget refuses input that already exceeds the limit", () => {
  assert.deepEqual(
    advisorBudget(
      model({ input: 6, output: 10, cacheRead: 0, cacheWrite: 0 }),
      100_000,
      8_192,
    ),
    { error: "input_cost_exceeds_budget" },
  );
});

test("advisor budget uses highest applicable tier rates and model output cap", () => {
  const priced = model(
    {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [
        {
          inputTokensAbove: 10_000,
          input: 4,
          output: 20,
          cacheRead: 0,
          cacheWrite: 0,
        },
        {
          inputTokensAbove: 20_000,
          input: 2,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
    },
    1_000,
  );
  assert.deepEqual(advisorBudget(priced, 30_000, 8_192), {
    maxTokens: 1_000,
    estimatedInputCostUsd: 0.12,
  });
});

test("advisor budget accepts genuinely free models and rejects invalid pricing", () => {
  assert.deepEqual(
    advisorBudget(
      model({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      100_000,
      200,
    ),
    { maxTokens: 200, estimatedInputCostUsd: 0 },
  );
  assert.deepEqual(
    advisorBudget(
      model({ input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0 }),
      1,
      1,
    ),
    { error: "pricing_unavailable" },
  );
});
