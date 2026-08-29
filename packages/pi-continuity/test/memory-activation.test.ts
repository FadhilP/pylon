import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRuleIndex,
  candidateRules,
  compileActivationDraft,
  evaluateCompiledRule,
  evaluateTrigger,
  validateActivationDraft,
  type ActivationDraft,
  type EventFrame,
} from "../src/memory-activation.ts";

const frame = (
  kind: EventFrame["kind"],
  facts: EventFrame["facts"] = {},
): EventFrame => ({
  kind,
  sequence: 1,
  sessionId: "session",
  taskGeneration: 1,
  contextEpoch: 1,
  repository: "repo",
  facts,
});
const grounded = (): ActivationDraft => ({
  classification: "grounded",
  subscriptions: ["after_tool_result"],
  predicate: {
    all: [
      { fact: "tool.name", op: "eq", value: "npm" },
      { fact: "tool.exitCode", op: "gte", value: 1 },
    ],
  },
  delivery: "warn",
  lifecycle: { activateUntil: "event_complete", rearmOn: [] },
  examples: {
    positive: [
      {
        event: "after_tool_result",
        facts: { "tool.name": "npm", "tool.exitCode": 1 },
      },
    ],
    hardNegative: [
      {
        event: "after_tool_result",
        facts: { "tool.name": "npm", "tool.exitCode": 0 },
      },
    ],
  },
});

test("activation compiles grounded rules, indexes deterministically, and evaluates", () => {
  const one = compileActivationDraft("b", 1, grounded())!;
  const two = compileActivationDraft("a", 1, grounded())!;
  const index = buildRuleIndex([one, two, two]);
  assert.deepEqual(
    candidateRules(index, frame("after_tool_result")).map(
      (rule) => rule.memoryId,
    ),
    ["a", "b"],
  );
  assert.equal(
    evaluateCompiledRule(
      one,
      frame("after_tool_result", { "tool.name": "npm", "tool.exitCode": 2 }),
    ),
    true,
  );
  assert.equal(
    evaluateCompiledRule(
      one,
      frame("after_tool_result", { "tool.name": "npm", "tool.exitCode": 0 }),
    ),
    false,
  );
  assert.deepEqual(candidateRules(index, frame("task_started")), []);
});

test("activation supports bounded command predicates with hard negatives", () => {
  const command: ActivationDraft = {
    classification: "grounded",
    subscriptions: ["before_tool_call"],
    predicate: {
      all: [
        { fact: "tool.name", op: "eq", value: "bash" },
        { fact: "tool.command", op: "startsWith", value: "dart format" },
      ],
    },
    delivery: "warn",
    lifecycle: { activateUntil: "event_complete", rearmOn: [] },
    examples: {
      positive: [
        {
          event: "before_tool_call",
          facts: { "tool.name": "bash", "tool.command": "dart format lib" },
        },
      ],
      hardNegative: [
        {
          event: "before_tool_call",
          facts: { "tool.name": "bash", "tool.command": "echo dart format" },
        },
      ],
    },
  };
  const rule = compileActivationDraft("command", 1, command)!;
  assert.equal(
    evaluateCompiledRule(
      rule,
      frame("before_tool_call", {
        "tool.name": "bash",
        "tool.command": "dart format .",
      }),
    ),
    true,
  );
  assert.equal(
    evaluateCompiledRule(
      rule,
      frame("before_tool_call", {
        "tool.name": "bash",
        "tool.command": "echo dart format",
      }),
    ),
    false,
  );
});

test("activation rejects hard-negative matches and preserves missing-fact tri-state", () => {
  const invalid = grounded();
  invalid.examples.hardNegative[0]!.facts["tool.exitCode"] = 2;
  assert.throws(
    () => validateActivationDraft(invalid),
    /invalid activation draft/,
  );
  assert.equal(
    evaluateTrigger(
      { fact: "tool.name", op: "eq", value: "npm" },
      frame("after_tool_result"),
    ),
    "unknown",
  );
  assert.equal(
    evaluateTrigger(
      { not: { fact: "tool.name", op: "eq", value: "npm" } },
      frame("after_tool_result"),
    ),
    "unknown",
  );
  assert.throws(
    () =>
      validateActivationDraft({
        ...grounded(),
        examples: {
          positive: [
            {
              event: "after_tool_result",
              facts: { "tool.name": "npm", "tool.exitCode": Number.NaN },
            },
          ],
          hardNegative: grounded().examples.hardNegative,
        },
      }),
    /invalid activation draft/,
  );
});

test("activation semantic rules abstain after a deterministic match", () => {
  const draft = grounded();
  draft.classification = "semantic_guarded";
  draft.semanticGuard = {
    condition: "Only when the failure is relevant.",
    abstainOnUnknown: true,
  };
  const rule = compileActivationDraft("semantic", 1, draft)!;
  assert.equal(
    evaluateCompiledRule(
      rule,
      frame("after_tool_result", { "tool.name": "npm", "tool.exitCode": 1 }),
    ),
    "unknown",
  );
  assert.equal(
    evaluateCompiledRule(
      rule,
      frame("after_tool_result", { "tool.name": "npm", "tool.exitCode": 0 }),
    ),
    false,
  );
});

test("activation handles archival drafts without compilation", () => {
  const archival: ActivationDraft = {
    classification: "archival",
    subscriptions: [],
    delivery: "inject_once",
    lifecycle: { activateUntil: "explicit_revocation", rearmOn: [] },
    examples: { positive: [], hardNegative: [] },
  };
  assert.equal(compileActivationDraft("old", 1, archival), undefined);
});

test("activation validates exact keys, bounds, depth, and operators", () => {
  assert.throws(
    () => validateActivationDraft({ ...grounded(), extra: true }),
    /invalid activation draft/,
  );
  const oversized = grounded();
  oversized.subscriptions = Array.from(
    { length: 17 },
    () => "after_tool_result",
  );
  assert.throws(
    () => validateActivationDraft(oversized),
    /invalid activation draft/,
  );
  const deep = grounded();
  let expression: any = { fact: "tool.name", op: "eq", value: "npm" };
  for (let index = 0; index < 8; index++) expression = { not: expression };
  deep.predicate = expression;
  assert.throws(
    () => validateActivationDraft(deep),
    /invalid activation draft/,
  );
  const operator = grounded();
  operator.predicate = { fact: "tool.name", op: "gte", value: "npm" } as any;
  assert.throws(
    () => validateActivationDraft(operator),
    /invalid activation draft/,
  );
});

test("activation uses native path glob matching", () => {
  assert.equal(
    evaluateTrigger(
      { fact: "file.path", op: "matchesGlob", value: "src/**/*.ts" },
      frame("before_tool_call", { "file.path": "src/lib/file.ts" }),
    ),
    true,
  );
  assert.equal(
    evaluateTrigger(
      { fact: "file.path", op: "matchesGlob", value: "[" },
      frame("before_tool_call", { "file.path": "src/file.ts" }),
    ),
    false,
  );
});
