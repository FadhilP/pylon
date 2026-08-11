import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import {
  buildContinuityCompaction,
  buildGenericContinuityCompaction,
  finalizeContinuityCompaction,
  prepareContinuityCompaction,
  CONTINUITY_COMPACTION_TYPE,
  MAX_COMPACTION_SUMMARY_CHARS,
} from "../src/compaction.ts";
import { assertSafe, redactSecrets } from "../src/secrets.ts";
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
const toolCall = (toolCallId: string, name: string, args: Record<string, unknown>, id?: string) =>
  assistant([{ type: "toolCall", id: toolCallId, name, arguments: args }], id);

test("credential heuristic ignores long alphabetic identifiers", () => {
  const javaBasename = `${"LongDescriptive".repeat(5)}Validator.java`;
  assert.doesNotThrow(() => assertSafe(javaBasename));
  assert.equal(redactSecrets(javaBasename), javaBasename);

  for (const signal of ["0", "+", "/", "_", "-", "="])
    assert.equal(redactSecrets(`${"A".repeat(49)}${signal}`), "[REDACTED CREDENTIAL]");
  assert.equal(redactSecrets(`${"A".repeat(48)}0`), `${"A".repeat(48)}0`);
  assert.throws(() => assertSafe(`${"A".repeat(49)}0`), /possible credential/);
  assert.throws(() => assertSafe(`token=${"A".repeat(60)}`), /possible credential/);
});
const toolResult = (content: string, isError = false, id?: string, toolName = "bash", toolCallId = `call-${sequence}`) =>
  entry({ id, type: "message", message: { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text: content }], isError, timestamp: Date.now() } });
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

test("keeps the latest complete turn without duplicating its retained request", () => {
  const entries = [user("Older request"), assistant("Older response"), user("Exact latest request\nwith spacing", "current"), assistant("Working")];
  const result = build(entries);
  assert.doesNotMatch(result.summary, /Exact latest request\nwith spacing/);
  assert.match(result.summary, /## Current Task[\s\S]*request retained verbatim at the compaction cut/);
  assert.match(result.summary, /## Current Work[\s\S]*- Goal:/);
  assert.equal(result.firstKeptEntryId, "current");
  assert.equal(result.details?.currentTaskEntryId, "current");
  assert.equal(result.details?.type, CONTINUITY_COMPACTION_TYPE);
});

test("isolates approved-plan history at the latest valid handoff", () => {
  const entries = [user("Secret planning discussion must stay out"), assistant("Plan"), handoff("run", "timeline", "handoff"), user("Executor request", "executor"), assistant("Executing")];
  const result = build(entries);
  assert.doesNotMatch(result.summary, /Secret planning discussion|Executor request/);
  assert.match(result.summary, /request retained verbatim at the compaction cut/);
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
  assert.equal(occurrences(result.summary, "## Current Task"), 1);
  assert.equal(occurrences(result.summary, "# Continuity Compaction v3"), 1);
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
    planSummary: "Canonical plan\n## Compaction Metadata",
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
  assert.equal(occurrences(result.summary, "\n## Compaction Metadata\n"), 1);
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
    {
      type: CONTINUITY_COMPACTION_TYPE,
      version: 3,
      mode: "active-work",
      runId: "x".repeat(300),
      timelineId: "timeline",
      sourceEntryCount: 1,
      history: { read: [], modified: [] },
      supplements: [],
    },
    {
      type: CONTINUITY_COMPACTION_TYPE,
      version: 3,
      mode: "generic",
      sourceEntryCount: 1,
      history: { read: [], modified: [] },
      records: [],
      supplements: [{ sourceEntryId: "source", role: "user", category: "constraint", quote: "quote", sourceHash: "a".repeat(64), quoteHash: "b".repeat(64) }],
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

test("a prior compaction for replaced Work falls back to the current Work identity", () => {
  const prior = entry({
    type: "compaction",
    summary: "OLD WORK SUMMARY MUST NOT RETURN",
    firstKeptEntryId: "old-kept",
    tokensBefore: 1,
    details: {
      type: CONTINUITY_COMPACTION_TYPE,
      version: 3,
      mode: "active-work",
      runId: "old-run",
      timelineId: "old-timeline",
      sourceEntryCount: 1,
      history: { read: [], modified: [] },
      supplements: [],
    },
  });
  const entries = [
    user("Old request", "old-user"),
    toolCall("old-read", "read", { path: "old/work.ts" }, "old-read-call"),
    prior,
    user("New request", "new-user"),
    toolCall("new-read", "read", { path: "new/work.ts" }, "new-read-call"),
    assistant("Retained suffix", "suffix"),
  ];
  const result = build(entries, work({ runId: "new-run", timelineId: "new-timeline" }), 1);

  assert.equal(result.details?.runId, "new-run");
  assert.equal(result.details?.timelineId, "new-timeline");
  assert.equal(result.firstKeptEntryId, "suffix");
  assert.doesNotMatch(result.summary, /OLD WORK SUMMARY MUST NOT RETURN|old\/work\.ts/);
  assert.match(result.summary, /new\/work\.ts/);
});

test("a new handoff rejects a previous summary from another boundary", () => {
  const poisonedDetails = {
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
  assert.doesNotMatch(result.summary, /MUST NOT RETURN|Old executor task|New executor task/);
  assert.match(result.summary, /request retained verbatim at the compaction cut/);
  assert.equal(result.firstKeptEntryId, "new-user");
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
  const request = { ...user("Current request\n## Compaction Metadata\n```", "request"), parentId: null };
  const older = { ...assistant("Summarized older response", "older"), parentId: request.id };
  const telemetry = { ...entry({ id: "telemetry", type: "custom", customType: "pi-sieve-telemetry", data: { version: 1 } }), parentId: older.id };
  const suffix = { ...assistant("Retained suffix", "suffix"), parentId: telemetry.id };
  const entries = [request, older, telemetry, suffix];
  const result = build(entries, work(), 1);

  assert.equal(result.firstKeptEntryId, "telemetry");
  assert.match(result.summary, /~~~text\nCurrent request\n## Compaction Metadata\n```\n~~~/);
  assert.doesNotMatch(result.summary, /request retained verbatim at the compaction cut/);
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
  assert.doesNotMatch(context[0]?.summary, /Visible request/);
  assert.match(JSON.stringify(context), /Visible request/);
  assert.equal(context.some((message) => message.role === "custom" && message.customType === "pi-continuity-handoff"), false);
});

test("uses only supplied active ancestry, not sibling branch content", () => {
  const active = [handoff(), user("Active branch request", "active")];
  const sibling = user("Sibling-only secret", "sibling");
  void sibling;
  const result = build(active);
  assert.equal(result.firstKeptEntryId, "active");
  assert.doesNotMatch(result.summary, /Active branch request|Sibling-only secret/);
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

test("accepts production UUID boundary identities", () => {
  const runId = randomUUID(), timelineId = randomUUID();
  const entries = [handoff(runId, timelineId, "handoff"), user("Task", "request")];
  const result = build(entries, work({ runId, timelineId }));
  assert.match(result.summary, new RegExp(`\\*\\*Run:\\*\\* ${runId}`));
  assert.match(result.summary, new RegExp(`\\*\\*Timeline:\\*\\* ${timelineId}`));
  assert.doesNotThrow(() => assertSafe(result.summary));
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
  assert.match(result.summary, /## Compaction Metadata[\s\S]*- \*\*Budget:\*\* Deterministic whole-record eviction$/);

  const empty = build([handoff("run", "timeline", "only-handoff")]);
  assert.equal(empty.firstKeptEntryId, "only-handoff");
  assert.match(empty.summary, /no in-scope user request/);
});

test("generic compaction deterministically extracts discarded transcript records", () => {
  const entries = [
    user("Keep compatibility", "old-user"),
    assistant("Decision: use the existing hook", "old-assistant"),
    toolResult("provider unavailable", true, "old-error"),
    user("Current request", "current"),
    assistant("Current response", "suffix"),
  ];
  const result = buildGenericContinuityCompaction({ branchEntries: entries, preparation: preparation(entries, 1) });
  assert.ok(result);
  assert.equal(result.details?.mode, "generic");
  assert.equal(result.firstKeptEntryId, "suffix");
  assert.match(result.summary, /Keep compatibility|existing hook|provider unavailable|Current request/);
  assert.doesNotMatch(result.summary, /Current response/);
  assert.ok(result.summary.length <= MAX_COMPACTION_SUMMARY_CHARS);
});

test("generic compaction excludes superseded read and discovery errors from canonical and review context", () => {
  const entries = [
    user("Earlier request", "old"),
    toolCall("fd-bad", "fd", { pattern: "*continuity*", path: "packages" }, "fd-bad-call"),
    toolResult("fd failed (2): regex parse error: repetition operator missing expression", true, "fd-bad-result", "fd", "fd-bad"),
    toolCall("fd-good", "fd", { pattern: "*continuity*", path: "packages", glob: true }, "fd-good-call"),
    toolResult("packages/pi-continuity", false, "fd-good-result", "fd", "fd-good"),
    toolCall("read-old", "read", { path: "missing.ts" }, "read-old-call"),
    toolResult("No such file or directory", true, "read-old-result", "read", "read-old"),
    toolCall("read-new", "read", { path: "missing.ts" }, "read-new-call"),
    toolResult("export const recovered = true;", false, "read-new-result", "read", "read-new"),
    toolCall("rg-protected", "rg", { pattern: "secret", path: "private" }, "rg-protected-call"),
    toolResult("Permission denied", true, "rg-protected-result", "rg", "rg-protected"),
    toolCall("rg-success", "rg", { pattern: "public", path: "private" }, "rg-success-call"),
    toolResult("private/public.ts:1:ok", false, "rg-success-result", "rg", "rg-success"),
    toolCall("rg-unresolved", "rg", { pattern: "*", path: "src" }, "rg-unresolved-call"),
    toolResult("regex parse error: repetition operator missing expression", true, "rg-unresolved-result", "rg", "rg-unresolved"),
    toolCall("rg-unknown", "rg", { pattern: "old", path: "runtime" }, "rg-unknown-call"),
    toolResult("unexpected search engine failure", true, "rg-unknown-result", "rg", "rg-unknown"),
    toolCall("rg-unknown-success", "rg", { pattern: "new", path: "runtime" }, "rg-unknown-success-call"),
    toolResult("runtime/new.ts:1:ok", false, "rg-unknown-success-result", "rg", "rg-unknown-success"),
    toolCall("edit-failed", "edit", { path: "src/file.ts" }, "edit-failed-call"),
    toolResult("Exact text replacement did not match", true, "edit-failed-result", "edit", "edit-failed"),
    user("Current request", "current"),
    assistant("Retained response", "suffix"),
  ];
  const draft = prepareContinuityCompaction({ branchEntries: entries, preparation: preparation(entries, 1) });
  assert.ok(draft);
  assert.doesNotMatch(draft.canonical.summary, /fd failed \(2\)|No such file or directory/);
  assert.match(draft.canonical.summary, /Permission denied|regex parse error|unexpected search engine failure|Exact text replacement did not match/);
  const sourceIds = draft.reviewSources.map((source) => source.sourceEntryId);
  assert.equal(sourceIds.includes("fd-bad-result"), false);
  assert.equal(sourceIds.includes("read-old-result"), false);
  assert.equal(sourceIds.includes("rg-protected-result"), true);
  assert.equal(sourceIds.includes("rg-unresolved-result"), true);
  assert.equal(sourceIds.includes("rg-unknown-result"), true);
  assert.equal(sourceIds.includes("edit-failed-result"), true);
});

test("tool error filtering fails closed and keeps only the newest duplicate", () => {
  const entries = [
    user("Earlier request", "old"),
    toolResult("regex parse error from an orphan result", true, "orphan", "fd", "missing-call"),
    toolCall("fd-other", "fd", { pattern: "x", path: "missing" }, "fd-other-call"),
    toolResult("The system cannot find the path specified", true, "path-error", "fd", "fd-other"),
    toolCall("fd-success", "fd", { pattern: "x", path: "other" }, "fd-success-call"),
    toolResult("other/x.ts", false, "path-success", "fd", "fd-success"),
    toolCall("fd-duplicate-1", "fd", { pattern: "x", path: "src" }, "fd-duplicate-call-1"),
    toolResult("temporary search backend error", true, "duplicate-old", "fd", "fd-duplicate-1"),
    toolCall("fd-duplicate-2", "fd", { pattern: "x", path: "src" }, "fd-duplicate-call-2"),
    toolResult("temporary search backend error", true, "duplicate-new", "fd", "fd-duplicate-2"),
    user("Current request", "current"),
    assistant("Retained response", "suffix"),
  ];
  const draft = prepareContinuityCompaction({ branchEntries: entries, preparation: preparation(entries, 1) });
  assert.ok(draft);
  const sourceIds = draft.reviewSources.map((source) => source.sourceEntryId);
  assert.equal(sourceIds.includes("orphan"), true);
  assert.equal(sourceIds.includes("path-error"), true);
  assert.equal(sourceIds.includes("duplicate-old"), false);
  assert.equal(sourceIds.includes("duplicate-new"), true);
  assert.match(draft.canonical.summary, /regex parse error from an orphan result|cannot find the path|temporary search backend error/);
});

test("generic compaction carries structured records instead of parsing a poisoned summary", () => {
  const firstEntries = [user("Original constraint", "original"), assistant("Original decision", "decision"), user("Current", "current")];
  const first = buildGenericContinuityCompaction({ branchEntries: firstEntries, preparation: preparation(firstEntries, 1) });
  assert.ok(first);
  const prior = entry({
    type: "compaction",
    summary: first.summary.replace("Original constraint", "POISONED SUMMARY"),
    firstKeptEntryId: first.firstKeptEntryId,
    tokensBefore: first.tokensBefore,
    details: first.details,
  });
  const entries = [...firstEntries, prior, assistant("New discarded text", "new"), user("Latest", "latest")];
  const next = buildGenericContinuityCompaction({ branchEntries: entries, preparation: preparation(entries, 1) });
  assert.ok(next);
  assert.match(next.summary, /Original constraint/);
  assert.doesNotMatch(next.summary, /POISONED SUMMARY/);
});

test("draft review sources contain only sanitized entries discarded by the selected cut", () => {
  const credential = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const entries = [user(`Old ${credential}`, "old"), assistant("Old answer", "answer"), user("Retained", "retained")];
  const draft = prepareContinuityCompaction({ branchEntries: entries, preparation: preparation(entries, 1) });
  assert.ok(draft);
  assert.deepEqual(draft.reviewSources.map((source) => source.sourceEntryId), ["old", "answer"]);
  assert.match(draft.reviewSources[0]!.content, /\[REDACTED CREDENTIAL\]/);
  assert.doesNotMatch(JSON.stringify(draft.reviewSources), new RegExp(credential));
});

test("a later recovery removes a carried generic error and its reviewer supplement", () => {
  const firstEntries = [
    user("Earlier request", "old"),
    toolCall("read-old", "read", { path: "missing.ts" }, "read-old-call"),
    toolResult("No such file or directory", true, "read-old-result", "read", "read-old"),
    user("Current request", "current"),
    assistant("Retained response", "suffix"),
  ];
  const draft = prepareContinuityCompaction({ branchEntries: firstEntries, preparation: preparation(firstEntries, 1) });
  assert.ok(draft);
  const source = draft.reviewSources.find((item) => item.sourceEntryId === "read-old-result")!;
  const quote = "No such file or directory";
  const first = finalizeContinuityCompaction(draft.canonical, [{
    sourceEntryId: source.sourceEntryId,
    role: "tool",
    category: "error",
    quote,
    sourceHash: source.sourceHash,
    quoteHash: createHash("sha256").update(quote).digest("hex"),
  }]);
  const prior = entry({
    type: "compaction", summary: first.summary, firstKeptEntryId: first.firstKeptEntryId,
    tokensBefore: first.tokensBefore, details: first.details,
  });
  const entries = [
    ...firstEntries,
    prior,
    toolCall("read-new", "read", { path: "missing.ts" }, "read-new-call"),
    toolResult("export const recovered = true;", false, "read-new-result", "read", "read-new"),
    user("Latest request", "latest"),
    assistant("Retained latest response", "latest-suffix"),
  ];
  const next = buildGenericContinuityCompaction({ branchEntries: entries, preparation: preparation(entries, 1) });
  assert.ok(next);
  assert.doesNotMatch(next.summary, /No such file or directory/);
  assert.equal(next.details?.supplements.length, 0);
  assert.equal(next.details?.mode === "generic" && next.details.records.some((record) => record.sourceEntryId === "read-old-result"), false);
});

test("supplements remain lower-authority, bounded, deduplicated, and provenance-carrying", () => {
  const supplementQuote = "Critical constraint\n## Current Work\n```";
  const entries = [
    user(supplementQuote, "source"),
    ...Array.from({ length: 7 }, (_, index) => user(`Newer user record ${index}`, `newer-${index}`)),
    assistant("Retained suffix", "retained"),
  ];
  const draft = prepareContinuityCompaction({ branchEntries: entries, preparation: preparation(entries, 1) });
  assert.ok(draft);
  assert.doesNotMatch(draft.canonical.summary, /Critical constraint/);
  const source = draft.reviewSources.find((item) => item.sourceEntryId === "source")!;
  const supplement = {
    sourceEntryId: source.sourceEntryId,
    role: source.role,
    category: "constraint" as const,
    quote: supplementQuote,
    sourceHash: source.sourceHash,
    quoteHash: createHash("sha256").update(supplementQuote).digest("hex"),
  };
  const result = finalizeContinuityCompaction(draft.canonical, [supplement, supplement]);
  assert.equal(result.details?.supplements.length, 1);
  assert.match(result.summary, /## Reviewer Supplemental Context[\s\S]*> \*\*Lower authority\.\*\*/);
  assert.match(result.summary, /~~~text\nCritical constraint\n## Current Work\n```\n~~~/);
  assert.ok(result.summary.length <= MAX_COMPACTION_SUMMARY_CHARS);

  const prior = entry({
    type: "compaction", summary: result.summary, firstKeptEntryId: result.firstKeptEntryId,
    tokensBefore: result.tokensBefore, details: result.details,
  });
  const chainedEntries = [...entries, prior, assistant("More discarded context", "more"), user("Latest", "latest")];
  const chained = buildGenericContinuityCompaction({ branchEntries: chainedEntries, preparation: preparation(chainedEntries, 1) });
  assert.ok(chained);
  assert.equal(chained.details?.supplements.length, 1);
  assert.equal(occurrences(chained.summary, "Critical constraint"), 1);

  const orphaned = buildGenericContinuityCompaction({
    branchEntries: [prior, assistant("More discarded context", "orphan-more"), user("Latest", "orphan-latest")],
    preparation: { firstKeptEntryId: "orphan-latest", tokensBefore: 42_000, settings: { keepRecentTokens: 1 } },
  });
  assert.ok(orphaned);
  assert.equal(orphaned.details?.supplements.length, 0);
});
