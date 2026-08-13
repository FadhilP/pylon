import test from "node:test";
import assert from "node:assert/strict";
import { blocked, planningTools } from "../src/plan-gate.ts";

test("planning gate retains Continuity's read-only inspection tools", () => {
  assert.ok(planningTools().includes("memory"));
  assert.ok(planningTools().includes("continuity_recall"));
  assert.ok(planningTools().includes("search_tools"));
  assert.equal(blocked(true, "memory"), false);
  assert.equal(blocked(true, "continuity_recall"), false);
  assert.equal(blocked(true, "search_tools"), false);
  assert.equal(blocked(true, "edit"), true);
});
