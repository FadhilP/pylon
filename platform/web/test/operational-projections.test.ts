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
    version: 2, revision: 2, sessionId: "session", available: true,
    memory: [{ key: "project.arch", kind: "architecture", text: "Use the coordinator", source: "test", confidence: 0.9, updatedAt: new Date(0).toISOString() }],
    work: { mode: "executing", goal: "Ship", approved: true, planSummary: "Implement", createdAt: "now", updatedAt: "now", todos: [{ id: "todo_1", text: "Build", status: "in_progress", updatedAt: "now" }] },
  }, [], "session");
  state = applyOperationalEvent(state, "pi-continuity:state-change", { version: 2, revision: 2, sessionId: "session", available: false, memory: [] }, [], "session");
  state = applyOperationalEvent(state, "pi-continuity:state-change", { version: 2, revision: 3, sessionId: "old-session", available: false, memory: [] }, [], "session");
  assert.equal(state.continuity.revision, 2);
  assert.equal(state.continuity.work?.goal, "Ship");
  assert.equal(state.continuity.memory[0]?.key, "project.arch");

  state = applyOperationalEvent(state, "pi-timeline:state-change", {
    version: 4,
    revision: 1,
    sessionId: "session",
    available: true,
    undoPromptEntryIds: ["user-2"],
    checkpoints: [{
      id: "checkpoint-1",
      title: "First prompt",
      ownerSessionId: "session",
      createdAt: new Date(0).toISOString(),
      verified: true,
    }],
  }, [], "session");
  assert.equal(state.timeline.checkpoints[0]?.id, "checkpoint-1");

  state = applyOperationalEvent(state, "pylon:tool-policy", { version: 1, kind: "register", owner: "pi-test", managedTools: ["test"], enabledTools: ["test"] });
  assert.equal(state.tools.policies.length, 1);
  state = applyOperationalEvent(state, "pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-test" });
  assert.equal(state.tools.policies.length, 0);
});

test("Heartbeat accepts numeric timestamps and cancelling jobs", () => {
  let state = initialOperational([], ["pi-heartbeat.ts"]);
  state = applyOperationalEvent(state, "pi-heartbeat:job", {
    version: 1,
    id: "job-1",
    label: "Run checks",
    state: "cancelling",
    startedAt: 1_000,
    finishedAt: 2_000,
    purpose: "verification",
    exitCode: null,
  });

  assert.equal(state.jobs.availability, "available");
  assert.deepEqual(state.jobs.items[0], {
    id: "job-1",
    label: "Run checks",
    state: "cancelling",
    startedAt: new Date(1_000).toISOString(),
    finishedAt: new Date(2_000).toISOString(),
    exitCode: null,
    purpose: "verification",
  });
});
