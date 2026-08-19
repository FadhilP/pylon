import assert from "node:assert/strict";
import test from "node:test";
import { aggregatePairedAgentTiming, pairAgentActivity, pairedAgentToolDuration, pairedAgentToolStatus } from "../src/shared/agent-activity.ts";

test("correlated activity pairs interleaved repeated tool names by call ID", () => {
  const paired = pairAgentActivity([
    { id: "first", kind: "call", tool: "read", text: "a.ts", startedAt: "2026-01-01T00:00:00.000Z" },
    { id: "second", kind: "call", tool: "read", text: "b.ts", startedAt: "2026-01-01T00:00:02.000Z" },
    { id: "first", kind: "result", tool: "read", text: "A", durationMs: 1_000 },
    { id: "second", kind: "result", tool: "read", text: "B", isError: true, durationMs: 2_500 },
  ]);
  assert.deepEqual(paired, [
    { id: "first", tool: "read", input: "a.ts", output: "A", completed: true, failed: undefined, startedAt: "2026-01-01T00:00:00.000Z", durationMs: 1_000 },
    { id: "second", tool: "read", input: "b.ts", output: "B", completed: true, failed: true, startedAt: "2026-01-01T00:00:02.000Z", durationMs: 2_500 },
  ]);
});


test("spawned tool timing selects active and latest terminal states", () => {
  const now = Date.parse("2026-01-01T00:00:05.000Z");
  const tools = pairAgentActivity([
    { id: "done", kind: "call", tool: "read", startedAt: "2026-01-01T00:00:00.000Z" },
    { id: "done", kind: "result", tool: "read", durationMs: 4_000 },
    { id: "live", kind: "call", tool: "bash", startedAt: "2026-01-01T00:00:02.000Z" },
  ]);
  assert.equal(pairedAgentToolStatus(tools[1]!, true), "running");
  assert.equal(pairedAgentToolDuration(tools[1]!, true, now), 3_000);
  assert.deepEqual(aggregatePairedAgentTiming(tools, true, now), { durationMs: 3_000, status: "running" });

  tools[1]!.completed = true;
  tools[1]!.failed = true;
  tools[1]!.durationMs = 3_500;
  assert.deepEqual(aggregatePairedAgentTiming(tools, false, now), { durationMs: 3_500, status: "failed" });
});

test("legacy and unmatched activity remain visible without cross-pairing IDs", () => {
  const paired = pairAgentActivity([
    { kind: "call", tool: "read", text: "legacy-a" },
    { id: "modern", kind: "call", tool: "read", text: "modern" },
    { kind: "call", tool: "read", text: "legacy-b" },
    { kind: "result", tool: "read", text: "legacy-B" },
    { id: "missing", kind: "result", tool: "read", text: "orphan" },
    { kind: "result", tool: "read", text: "legacy-A" },
  ]);
  assert.deepEqual(paired, [
    { tool: "read", input: "legacy-a", output: "legacy-A", completed: true, failed: undefined },
    { id: "modern", tool: "read", input: "modern" },
    { tool: "read", input: "legacy-b", output: "legacy-B", completed: true, failed: undefined },
    { id: "missing", tool: "read", output: "orphan", completed: true, failed: undefined },
  ]);
});
