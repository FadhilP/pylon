import test from "node:test";
import assert from "node:assert/strict";
import { isRunEntry, runTimelineId } from "../src/run.ts";
import { sessionWorkFile } from "../src/active-work.ts";

test("run metadata validates backward-compatible timeline lineage", () => {
  const legacy = {
    version: 1 as const,
    runId: "run",
    role: "planner" as const,
    createdAt: new Date().toISOString(),
  };
  assert.equal(isRunEntry(legacy), true);
  assert.equal(runTimelineId(legacy), "run");
  assert.equal(isRunEntry({ ...legacy, runId: "run-2", timelineId: "run" }), true);
  assert.equal(runTimelineId({ ...legacy, runId: "run-2", timelineId: "run" }), "run");
  assert.equal(isRunEntry({ ...legacy, timelineId: "" }), false);
  assert.equal(
    isRunEntry({ version: 1, runId: "run", role: "invalid", createdAt: "x" }),
    false,
  );
});

test("session work files are isolated", () => {
  assert.notEqual(sessionWorkFile("session-a"), sessionWorkFile("session-b"));
  assert.equal(sessionWorkFile("../session"), "..%2Fsession.json");
});
