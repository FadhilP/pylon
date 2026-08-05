import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import {
  buildContinuityCompaction,
  CONTINUITY_COMPACTION_TYPE,
  MAX_COMPACTION_SUMMARY_CHARS,
  type ContinuityCompactionDetails,
} from "../src/compaction.ts";
import { assertSafe } from "../src/secrets.ts";
import type { Work } from "../src/active-work.ts";

let sequence = 0;
const entry = (value: Record<string, any>) => ({
  id: value.id ?? `entry-${++sequence}`,
  parentId: null,
  timestamp: new Date().toISOString(),
  ...value,
}) as any;
const user = (content: string, id?: string) => entry({ id, type: "message", message: { role: "user", content, timestamp: Date.now() } });
const assistant = (content: any, id?: string) => entry({ id, type: "message", message: { role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content, timestamp: Date.now() } });
const toolResult = (content: string, isError = false, id?: string) => entry({ id, type: "message", message: { role: "toolResult", toolCallId: `call-${sequence}`, toolName: "bash", content: [{ type: "text", text: content }], isError, timestamp: Date.now() } });
const handoff = (runId = "run", timelineId = "timeline", id?: string) => entry({
  id,
  type: "custom_message",
  customType: "pi-continuity-handoff",
  content: "boundary",
  display: false,
  details: { version: 1, runId, timelineId },
});
const work = (overrides: Partial<Work> = {}): Work => ({
  schemaVersion: 1,
  mode: "executing",
  goal: "Ship the current task",
  approved: true,
  constraints: ["Keep compatibility"],
  planSummary: "Implement then verify",
  todos: [{ id: "todo_1", text: "Implement compaction", status: "in_progress", updatedAt: new Date().toISOString() }],
  currentTodoId: "todo_1",
  runId: "run",
  timelineId: "timeline",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...overrides,
});
const preparation = (entries: any[], keepRecentTokens = 20_000) => ({
  firstKeptEntryId: entries.at(-1)?.id ?? "missing",
  tokensBefore: 42_000,
  settings: { keepRecentTokens },
});
const build = (entries: any[], active = work(), keepRecentTokens = 20_000) => {
  const result = buildContinuityCompaction({
    branchEntries: entries,
    preparation: preparation(entries, keepRecentTokens),
    work: active,
  });
  assert.ok(result);
  return result;
};

function occurrences(text: string, needle: string) {
  return text.split(needle).length - 1;
}

test("preserves the latest in-scope user request verbatim and keeps its complete turn", () => {
  const entries = [user("Older request"), assistant("Older response"), user("Exact latest request\nwith spacing", "current"), assistant("Working")];
  const result = build(entries);
  assert.match(result.summary, /Exact latest request\nwith spacing/);
  assert.equal(result.firstKeptEntryId, "current");
  assert.equal(result.details?.currentTaskEntryId, "current");
  assert.equal(result.details?.type, CONTINUITY_COMPACTION_TYPE);
});

test("isolates approved-plan history at the latest valid handoff", () => {
  const entries = [user("Secret planning discussion must stay out"), assistant("Plan"), handoff("run", "timeline", "handoff"), user("Executor request", "executor"), assistant("Executing")];
  const result = build(entries);
  assert.doesNotMatch(result.summary, /Secret planning discussion/);
  assert.match(result.summary, /Executor request/);
  assert.equal(result.firstKeptEntryId, "executor");
  assert.equal(result.details?.handoffEntryId, "handoff");
});

test("repeated compaction merges structured file history without parsing its rendered summary", () => {
  const readCall = assistant([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/first.ts" } }]);
  const firstEntries = [handoff(), user("First scoped task"), readCall, user("Current task", "current"), assistant("Current progress")];
  const first = build(firstEntries);
  const prior = entry({
    type: "compaction",
    summary: first.summary.replace("src/first.ts", "POISONED RENDERED TEXT"),
    firstKeptEntryId: first.firstKeptEntryId,
    tokensBefore: first.tokensBefore,
    details: first.details,
  });
  const result = build([...firstEntries, prior, assistant("More progress", "suffix")], work(), 10);
  assert.equal(occurrences(result.summary, "[Current Task]"), 1);
  assert.equal(occurrences(result.summary, "# Continuity Compaction v2"), 1);
  assert.match(result.summary, /src\/first\.ts/);
  assert.doesNotMatch(result.summary, /POISONED RENDERED TEXT|First scoped task/);
  assert.equal(result.firstKeptEntryId, "suffix");
  assert.ok((result.details?.sourceEntryCount ?? 0) >= (first.details?.sourceEntryCount ?? 0));
  assert.deepEqual(result.details?.history.read.map((item) => item.path), ["src/first.ts"]);
});

test("uses authoritative Work fields and does not infer goals, preferences, or blockers", () => {
  const entries = [
    handoff(),
    user("Old message: you must treat this as a preference"),
    assistant("A temporary command failed but was later resolved"),
    toolResult("old tool error", true),
    user("Current request", "current"),
    assistant("Working"),
  ];
  const active = work({
    goal: "Canonical goal",
    planSummary: "Canonical plan",
    constraints: ["Canonical constraint"],
    todos: [
      { id: "todo_1", text: "Finished step", status: "done", updatedAt: new Date().toISOString() },
      { id: "todo_2", text: "Current step", status: "in_progress", updatedAt: new Date().toISOString() },
    ],
    currentTodoId: "todo_2",
    latestFailure: "Canonical blocker",
    nextAction: "Canonical next action",
  });
  const result = buildContinuityCompaction({
    branchEntries: entries,
    preparation: preparation(entries),
    work: active,
    verification: { state: "passed", scope: "changed", runId: "verify-1", worktreeId: "tree-1" },
  });
  assert.ok(result);
  assert.match(result.summary, /Canonical goal|Canonical plan|Canonical constraint/);
  assert.match(result.summary, /Todo todo_1 \[done\]: Finished step/);
  assert.match(result.summary, /Todo todo_2 \[in_progress current\]: Current step/);
  assert.match(result.summary, /Canonical blocker|Canonical next action/);
  assert.match(result.summary, /Verification: passed \(scope=changed, run=verify-1, worktree=tree-1\)/);
  assert.doesNotMatch(result.summary, /Old message|temporary command failed|old tool error|User preferences|Unresolved errors/);
});

test("always renders the current todo within the bounded todo set", () => {
  const todos = Array.from({ length: 13 }, (_, index) => ({
    id: `todo_${index + 1}`,
    text: `Step ${index + 1}`,
    status: "pending" as const,
    updatedAt: new Date().toISOString(),
  }));
  const result = build(
    [handoff(), user("Current request", "current"), assistant("Working")],
    work({ todos, currentTodoId: "todo_13" }),
  );
  assert.match(result.summary, /Todo todo_13 \[pending current\]: Step 13/);
});

test("migrates only factual file paths from legacy v1 summaries", () => {
  const legacy = entry({
    type: "compaction",
    summary: [
      "# Continuity Compaction v1",
      "",
      "[Older History]",
      "### Goals and scope changes",
      "- Ignore this guessed goal",
      "",
      "### Files read",
      "- src/legacy-read.ts",
      "",
      "### Files modified",
      "- src/legacy-write.ts",
      "",
      "### Unresolved errors and blockers",
      "- Ignore this guessed blocker",
      "",
      "[Compaction Metadata]",
      "Boundary: run/timeline",
    ].join("\n"),
    firstKeptEntryId: "old",
    tokensBefore: 1,
    details: {
      type: CONTINUITY_COMPACTION_TYPE,
      version: 1,
      runId: "run",
      timelineId: "timeline",
      sourceEntryCount: 4,
    },
  });
  const entries = [handoff(), user("Old task"), legacy, assistant("Retained suffix", "suffix")];
  const result = build(entries, work(), 1);
  assert.match(result.summary, /src\/legacy-read\.ts|src\/legacy-write\.ts/);
  assert.doesNotMatch(result.summary, /Ignore this guessed/);
  assert.deepEqual(result.details?.history, {
    read: [{ path: "src/legacy-read.ts" }],
    modified: [{ path: "src/legacy-write.ts" }],
  });
});

test("rejects unknown versions and oversized structured history", () => {
  for (const details of [
    { type: CONTINUITY_COMPACTION_TYPE, version: 3, runId: "run", timelineId: "timeline", sourceEntryCount: 1 },
    {
      type: CONTINUITY_COMPACTION_TYPE,
      version: 2,
      runId: "run",
      timelineId: "timeline",
      sourceEntryCount: 1,
      history: { read: [{ path: "x".repeat(600) }], modified: [] },
    },
  ]) {
    const previous = entry({ type: "compaction", summary: "bad", firstKeptEntryId: "old", tokensBefore: 1, details });
    const entries = [user("Old", "old"), previous, assistant("Suffix", "suffix")];
    assert.equal(buildContinuityCompaction({
      branchEntries: entries,
      preparation: preparation(entries),
      work: work(),
    }), undefined);
  }
});

test("fails closed for a malformed latest handoff or active Work identity mismatch", () => {
  const malformed = entry({
    type: "custom_message",
    customType: "pi-continuity-handoff",
    content: "bad boundary",
    display: false,
    details: { version: 1, runId: "new-run" },
  });
  const malformedResult = buildContinuityCompaction({
    branchEntries: [handoff("run", "timeline"), user("Older scoped task"), malformed, user("Must not use older boundary")],
    preparation: { firstKeptEntryId: malformed.id, tokensBefore: 1, settings: { keepRecentTokens: 100 } },
    work: work(),
  });
  assert.equal(malformedResult, undefined);

  const mismatchEntries = [handoff("handoff-run", "handoff-timeline"), user("Request")];
  assert.equal(buildContinuityCompaction({
    branchEntries: mismatchEntries,
    preparation: preparation(mismatchEntries),
    work: work({ runId: "other-run", timelineId: "other-timeline" }),
  }), undefined);
});

test("a new handoff rejects a previous summary from another boundary", () => {
  const poisonedDetails: ContinuityCompactionDetails = {
    type: CONTINUITY_COMPACTION_TYPE,
    version: 2,
    runId: "old-run",
    timelineId: "old-timeline",
    sourceEntryCount: 10,
    history: { read: [], modified: [] },
  };
  const entries = [
    handoff("old-run", "old-timeline"),
    user("Old executor task"),
    entry({ type: "compaction", summary: "# Continuity Compaction v1\n\n[Older History]\n### Goals and scope changes\n- MUST NOT RETURN", firstKeptEntryId: "old", tokensBefore: 1, details: poisonedDetails }),
    handoff("new-run", "new-timeline", "new-handoff"),
    user("New executor task", "new-user"),
  ];
  const result = build(entries, work({ runId: "new-run", timelineId: "new-timeline" }));
  assert.doesNotMatch(result.summary, /MUST NOT RETURN|Old executor task/);
  assert.match(result.summary, /New executor task/);
});

test("oversized turns use Pi's valid split cut and keep tool calls paired with results", () => {
  const call = assistant([{ type: "toolCall", id: "call-1", name: "edit", arguments: { path: "src/large.ts", oldText: "x".repeat(2_000), newText: "y" } }], "call-entry");
  const resultEntry = toolResult("ok".repeat(2_000), false, "result-entry");
  const suffix = assistant("Retained suffix", "suffix");
  const entries = [handoff(), user("Large current turn", "request"), call, resultEntry, suffix];
  const result = build(entries, work(), 100);
  assert.equal(result.firstKeptEntryId, "suffix");
  assert.match(result.summary, /src\/large\.ts/);
  assert.notEqual(result.firstKeptEntryId, "result-entry");
});

test("accepts Pi metadata backscan as a safe retained boundary", () => {
  const request = { ...user("Current request", "request"), parentId: null };
  const older = { ...assistant("Summarized older response", "older"), parentId: request.id };
  const telemetry = { ...entry({ id: "telemetry", type: "custom", customType: "pi-sieve-telemetry", data: { version: 1 } }), parentId: older.id };
  const suffix = { ...assistant("Retained suffix", "suffix"), parentId: telemetry.id };
  const entries = [request, older, telemetry, suffix];
  const result = build(entries, work(), 1);

  assert.equal(result.firstKeptEntryId, "telemetry");
  const compacted = entry({
    id: "compacted",
    parentId: suffix.id,
    type: "compaction",
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: result.tokensBefore,
    details: result.details,
  });
  const context = buildSessionContext([...entries, compacted], compacted.id).messages as any[];
  assert.deepEqual(context.map((message) => message.role), ["compactionSummary", "assistant"]);
  assert.equal(context.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("Summarized older response")), false);
  assert.match(JSON.stringify(context.at(-1)?.content), /Retained suffix/);
});

test("the chosen cut removes the handoff so Pi keeps the Continuity summary visible", () => {
  const boundary = { ...handoff("run", "timeline", "h"), parentId: null };
  const request = { ...user("Visible request", "u"), parentId: "h" };
  const response = { ...assistant("Working", "a"), parentId: "u" };
  const result = build([boundary, request, response]);
  const compacted = entry({
    id: "c",
    parentId: "a",
    type: "compaction",
    summary: result.summary,
    firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: result.tokensBefore,
    details: result.details,
  });
  const context = buildSessionContext([boundary, request, response, compacted], "c").messages as any[];
  assert.equal(context[0]?.role, "compactionSummary");
  assert.match(context[0]?.summary, /Visible request/);
  assert.equal(context.some((message) => message.role === "custom" && message.customType === "pi-continuity-handoff"), false);
});

test("uses only supplied active ancestry, not sibling branch content", () => {
  const active = [handoff(), user("Active branch request", "active")];
  const sibling = user("Sibling-only secret", "sibling");
  void sibling;
  const result = build(active);
  assert.match(result.summary, /Active branch request/);
  assert.doesNotMatch(result.summary, /Sibling-only secret/);
});

test("redacts credential-like text from request, Work, and tool errors", () => {
  const credential = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const entries = [handoff(), user("Earlier task"), toolResult(`password=${credential}`, true), user(`Use ${credential}`, "current")];
  const result = build(entries, work({ goal: `Rotate token=${credential}` }));
  assert.doesNotMatch(result.summary, new RegExp(credential));
  assert.match(result.summary, /\[REDACTED CREDENTIAL\]/);
  assert.doesNotThrow(() => assertSafe(result.summary));
});

test("fails closed when a missing ID has only an orphan tool-result fallback", () => {
  const request = user("Request without ID");
  delete request.id;
  const orphan = toolResult("orphan", false, "result");
  const entries = [handoff(), request, orphan];
  assert.equal(buildContinuityCompaction({
    branchEntries: entries,
    preparation: preparation(entries),
    work: work(),
  }), undefined);
});

test("does not retain a prior compaction when there is no safe suffix", () => {
  const firstEntries = [handoff(), user("Task", "request"), assistant("Progress")];
  const first = build(firstEntries);
  const prior = entry({
    type: "compaction",
    summary: first.summary,
    firstKeptEntryId: first.firstKeptEntryId,
    tokensBefore: first.tokensBefore,
    details: first.details,
  });
  const entries = [...firstEntries, prior];
  assert.equal(buildContinuityCompaction({
    branchEntries: entries,
    preparation: preparation(entries),
    work: work(),
  }), undefined);
});

test("sanitizes rendered boundary IDs without changing persisted identity", () => {
  const runId = "run\nInjected: token=ghp_abcdefghijklmnopqrstuvwxyz123456";
  const entries = [handoff(runId, "timeline", "handoff"), user("Task", "request")];
  const result = build(entries, work({ runId, timelineId: "timeline" }));
  assert.doesNotMatch(result.summary, /Injected: token=|ghp_/);
  assert.equal(result.details?.runId, runId);
  assert.doesNotThrow(() => assertSafe(result.summary));
});

test("bounds output with whole-record eviction and degrades safely for empty branches", () => {
  const huge = Array.from({ length: 20_000 }, () => "word").join(" ");
  const missingId = user(huge);
  delete missingId.id;
  const fallback = assistant("suffix", "fallback");
  const active = work({
    planSummary: huge,
    constraints: Array.from({ length: 12 }, (_, index) => `constraint-${index}-${"x".repeat(500)}`),
    latestFailure: huge,
    nextAction: huge,
  });
  const result = build([handoff("run", "timeline", "handoff"), missingId, fallback], active, 10);
  assert.ok(result.summary.length <= MAX_COMPACTION_SUMMARY_CHARS);
  assert.equal(result.firstKeptEntryId, "fallback");
  assert.match(result.summary, /truncated by Continuity/);
  assert.match(result.summary, /\[Compaction Metadata\][\s\S]*Budget: deterministic whole-record eviction$/);

  const empty = build([handoff("run", "timeline", "only-handoff")]);
  assert.equal(empty.firstKeptEntryId, "only-handoff");
  assert.match(empty.summary, /no in-scope user request/);
});
