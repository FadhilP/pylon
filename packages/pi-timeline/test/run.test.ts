import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRunEntry, hasTimeline, isRunEntry, runTimelineId } from "../src/run.ts";
import { classifyCompatibility } from "../src/compatibility.ts";

test("checkpoint compatibility keeps refs informational", () => {
  const current = {
    gitRoot: join(tmpdir(), "repo"),
    head: "a".repeat(40),
    headRef: "refs/heads/main",
  };
  assert.deepEqual(
    classifyCompatibility({ ...current, headRef: undefined }, current),
    { allowed: true, refState: "legacy" },
  );
  assert.deepEqual(
    classifyCompatibility({ ...current, headRef: null }, { ...current, headRef: null }),
    { allowed: true, refState: "same" },
  );
  assert.deepEqual(
    classifyCompatibility({ ...current, headRef: null }, current),
    { allowed: true, refState: "target-detached" },
  );
  assert.deepEqual(
    classifyCompatibility(current, { ...current, headRef: null }),
    { allowed: true, refState: "current-detached" },
  );
  assert.deepEqual(
    classifyCompatibility(current, { ...current, headRef: "refs/heads/other" }),
    { allowed: true, refState: "ref-mismatch" },
  );
  assert.deepEqual(
    classifyCompatibility(current, { ...current, head: "b".repeat(40) }),
    { allowed: false, reason: "head-mismatch" },
  );
  assert.deepEqual(
    classifyCompatibility(current, { ...current, gitRoot: join(tmpdir(), "other") }),
    { allowed: false, reason: "repository-mismatch" },
  );
});

test("run metadata is optional and latest valid entry preserves timeline lineage", () => {
  assert.equal(findRunEntry([]), undefined);
  const planner = {
    version: 1 as const,
    runId: "run-1",
    role: "planner" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const executor = {
    ...planner,
    role: "executor" as const,
    parentSessionId: "planner-session",
  };
  const nextPlan = {
    ...planner,
    runId: "run-2",
    timelineId: "run-1",
  };
  assert.equal(isRunEntry(planner), true);
  assert.equal(isRunEntry(nextPlan), true);
  assert.equal(isRunEntry({ ...nextPlan, timelineId: "" }), false);
  assert.equal(runTimelineId(planner), runTimelineId(nextPlan));
  const entries = [
    { type: "custom", customType: "pylon-run", data: planner },
    { type: "custom", customType: "pylon-run", data: executor },
    { type: "custom", customType: "other", data: {} },
    { type: "custom", customType: "pylon-run", data: nextPlan },
  ];
  assert.equal(hasTimeline(entries, "run-1"), true);
  assert.equal(hasTimeline(entries, "unrelated"), false);
  assert.deepEqual(findRunEntry(entries), nextPlan);
  assert.equal(hasTimeline([
    ...entries,
    { type: "custom", customType: "pylon-run", data: {
      ...planner,
      runId: "unrelated",
      timelineId: "unrelated",
    } },
  ], "run-1"), true);
});
