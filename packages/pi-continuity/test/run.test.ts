import test from "node:test";
import assert from "node:assert/strict";
import { isRunEntry, runTimelineId } from "../src/run.ts";
import { sessionWorkFile } from "../src/active-work.ts";

test("run metadata requires explicit timeline lineage", () => {
  const run = {
    version: 1 as const,
    runId: "run-2",
    timelineId: "run",
    role: "planner" as const,
    createdAt: new Date().toISOString(),
  };
  assert.equal(isRunEntry(run), true);
  assert.equal(runTimelineId(run), "run");
  assert.equal(isRunEntry({ ...run, timelineId: undefined }), false);
  assert.equal(isRunEntry({ ...run, timelineId: "" }), false);
  assert.equal(
    isRunEntry({
      version: 1,
      runId: "run",
      timelineId: "run",
      role: "invalid",
      createdAt: "x",
    }),
    false,
  );
});

test("session work files are isolated", () => {
  assert.notEqual(sessionWorkFile("session-a"), sessionWorkFile("session-b"));
  assert.equal(sessionWorkFile("../session"), "..%2Fsession.json");
});
