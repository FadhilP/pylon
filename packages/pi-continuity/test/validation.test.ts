import test from "node:test";
import assert from "node:assert/strict";
import { candidate } from "../src/memory.ts";
import { fresh, isWork } from "../src/active-work.ts";
import { validateQuestion } from "../src/questions.ts";

test("questions validate", () => {
  assert.throws(() => validateQuestion("q", [{ label: "x" }, { label: "x" }]));
  validateQuestion("q", [{ label: "x" }, { label: "y" }]);
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

