import test from "node:test";
import assert from "node:assert/strict";
import { candidate } from "../src/memory.ts";
import { fresh, isWork } from "../src/active-work.ts";
import { validateQuestion, validateQuestions } from "../src/questions.ts";

test("questions validate", () => {
  assert.throws(() => validateQuestion("q", [{ label: "x" }, { label: "x" }]));
  validateQuestion("q", [{ label: "x" }, { label: "y" }]);
  validateQuestions([
    { question: "q1", options: [{ label: "x" }, { label: "y" }] },
    { question: "q2", options: [{ label: "a" }, { label: "b" }] },
  ]);
  assert.throws(() => validateQuestions([]), /1-6 questions/);
  assert.throws(() => validateQuestions(Array.from({ length: 7 }, (_, index) => ({
    question: `q${index}`,
    options: [{ label: "x" }, { label: "y" }],
  }))), /1-6 questions/);
});
test("secret rejected", () =>
  assert.throws(
    () =>
      candidate({
        key: "x",
        kind: "warning",
        text: "api_key=sk-proj-abcdefghijklmnopqrstuvwxyz",
        source: "x",
        confidence: 1,
        action: "add",
      }),
    /possible credential/,
  ));

test("work schema rejects malformed persisted state", () => {
  assert.equal(isWork(fresh("goal")), true);
  assert.equal(
    isWork({
      ...fresh("goal"),
      runId: "run",
      timelineId: "timeline",
      baseModel: { provider: "provider", id: "model" },
      baseThinking: "high",
    }),
    true,
  );
  assert.equal(isWork({ ...fresh("goal"), runId: "" }), false);
  assert.equal(isWork({ ...fresh("goal"), timelineId: "" }), false);
  assert.equal(isWork({ ...fresh("goal"), schemaVersion: 2 }), false);
  assert.equal(isWork({ ...fresh("goal"), todos: [{ bad: true }] }), false);
});

