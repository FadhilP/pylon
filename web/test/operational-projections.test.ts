import test from "node:test";
import assert from "node:assert/strict";
import { applyOperationalEvent, initialOperational } from "../src/server/pi/operational-projections.ts";

test("operational projections bound package payloads and isolate malformed versions", () => {
  let state = initialOperational(["verify", "heartbeat_start", "continuity_update"], ["pi-guard.ts", "pi-timeline.ts", "pylon-core.ts"]);
  state = applyOperationalEvent(state, "pi-verify:result", {
    version: 1, state: "failed", runId: "run", scope: "changed", startedAt: new Date().toISOString(),
    results: Array.from({ length: 30 }, (_, index) => ({ id: `check-${index}`, label: `Check ${index}`, command: "npm test", code: 1, output: "x".repeat(10_000), durationMs: 50 })),
  });
  assert.equal(state.verification.availability, "available");
  assert.equal(state.verification.checks.length, 20);
  assert.ok(state.verification.checks.reduce((bytes, item) => bytes + (item.output?.length ?? 0), 0) <= 16 * 1024);

  state = applyOperationalEvent(state, "pi-heartbeat:job", { version: 99 });
  assert.equal(state.jobs.availability, "unavailable");
  assert.equal(state.verification.availability, "available");
  assert.equal(state.health.status, "degraded");
});

test("state snapshots reject stale revisions and policy unregister removes owner", () => {
  let state = initialOperational([], ["pylon-core.ts"]);
  state = applyOperationalEvent(state, "pi-continuity:state-change", {
    version: 1, revision: 2, sessionId: "session", available: true,
    work: { mode: "executing", goal: "Ship", approved: true, planSummary: "Implement", createdAt: "now", updatedAt: "now", todos: [{ id: "todo_1", text: "Build", status: "in_progress", updatedAt: "now" }] },
  }, [], "session");
  state = applyOperationalEvent(state, "pi-continuity:state-change", { version: 1, revision: 2, sessionId: "session", available: false }, [], "session");
  state = applyOperationalEvent(state, "pi-continuity:state-change", { version: 1, revision: 3, sessionId: "old-session", available: false }, [], "session");
  assert.equal(state.continuity.revision, 2);
  assert.equal(state.continuity.work?.goal, "Ship");

  state = applyOperationalEvent(state, "pylon:tool-policy", { version: 1, kind: "register", owner: "pi-test", managedTools: ["test"], enabledTools: ["test"] });
  assert.equal(state.tools.policies.length, 1);
  state = applyOperationalEvent(state, "pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-test" });
  assert.equal(state.tools.policies.length, 0);
});
