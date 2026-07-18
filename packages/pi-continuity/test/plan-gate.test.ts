import test from "node:test";
import assert from "node:assert/strict";
import { blocked, planningTools } from "../src/plan-gate.ts";

test("planning gate retains the memory tool for inspection", () => {
  assert.ok(planningTools().includes("memory"));
  assert.equal(blocked(true, "memory"), false);
  assert.equal(blocked(true, "edit"), true);
});
