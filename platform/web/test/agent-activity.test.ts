import assert from "node:assert/strict";
import test from "node:test";
import { pairAgentActivity } from "../src/shared/agent-activity.ts";

test("correlated activity pairs interleaved repeated tool names by call ID", () => {
  const paired = pairAgentActivity([
    { id: "first", kind: "call", tool: "read", text: "a.ts" },
    { id: "second", kind: "call", tool: "read", text: "b.ts" },
    { id: "first", kind: "result", tool: "read", text: "A" },
    { id: "second", kind: "result", tool: "read", text: "B", isError: true },
  ]);
  assert.deepEqual(paired, [
    { id: "first", tool: "read", input: "a.ts", output: "A", completed: true, failed: undefined },
    { id: "second", tool: "read", input: "b.ts", output: "B", completed: true, failed: true },
  ]);
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
