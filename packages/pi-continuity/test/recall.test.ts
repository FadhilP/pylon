import test from "node:test";
import assert from "node:assert/strict";
import type { Work } from "../src/active-work.ts";
import {
  MAX_RECALL_OUTPUT_CHARS,
  MAX_RECALL_RESULTS,
  MAX_RECALL_SCAN_ENTRIES,
  RECALL_PAGE_SIZE,
  recallSession,
} from "../src/recall.ts";
import { CONTINUITY_COMPACTION_TYPE } from "../src/compaction.ts";

const timestamp = new Date().toISOString();
const entry = (id: string, parentId: string | null, value: Record<string, any>) => ({
  id,
  parentId,
  timestamp,
  ...value,
}) as any;
const user = (id: string, parentId: string | null, content: string) => entry(id, parentId, {
  type: "message",
  message: { role: "user", content, timestamp: Date.now() },
});
const assistant = (id: string, parentId: string | null, content: any) => entry(id, parentId, {
  type: "message",
  message: {
    role: "assistant",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    timestamp: Date.now(),
  },
});
const toolResult = (id: string, parentId: string, toolCallId: string, toolName: string, content: string) => entry(id, parentId, {
  type: "message",
  message: {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text: content }],
    isError: false,
    timestamp: Date.now(),
  },
});
const custom = (id: string, parentId: string | null, customType: string, content: string, details?: any) => entry(id, parentId, {
  type: "custom_message",
  customType,
  content,
  display: false,
  details,
});
const handoff = (id: string, parentId: string | null) => custom(
  id,
  parentId,
  "pi-continuity-handoff",
  "Continuity boundary",
  { version: 1, runId: "run", timelineId: "timeline" },
);
const work = (): Work => ({
  schemaVersion: 1,
  mode: "executing",
  goal: "Recall history",
  approved: true,
  constraints: [],
  planSummary: "Recall",
  todos: [{ id: "todo_1", text: "Recall", status: "in_progress", updatedAt: timestamp }],
  currentTodoId: "todo_1",
  runId: "run",
  timelineId: "timeline",
  createdAt: timestamp,
  updatedAt: timestamp,
});
const baseBranch = () => {
  const planning = user("planning", null, "Planning-only evidence");
  const plan = assistant("plan", "planning", "Plan response");
  const boundary = handoff("handoff", "plan");
  const request = user("request", "handoff", "Executor request evidence");
  const response = assistant("response", "request", "Executor response evidence");
  return [planning, plan, boundary, request, response];
};
const recall = (activeBranch: any[], params: any = {}, options: { visible?: any[]; all?: any[] } = {}) => recallSession({
  sessionId: "session-1",
  activeBranch,
  visibleEntries: options.visible ?? activeBranch.slice(-2),
  allEntries: options.all,
  work: work(),
  params,
});

test("default execution scope cannot return pre-handoff content", () => {
  const result = recall(baseBranch());
  assert.equal(result.effectiveScope, "execution");
  assert.match(result.text, /Executor request evidence/);
  assert.doesNotMatch(result.text, /Planning-only evidence|Plan response/);
  assert.match(result.text, /Session: session-1/);
  assert.match(result.text, /\[text\] entry=request role=user time=/);
  assert.match(result.text, /historical evidence/);
});

test("explicit lineage includes pre-handoff ancestry and all includes sibling branches", () => {
  const active = baseBranch();
  const sibling = user("sibling", "planning", "Sibling-only evidence");
  const lineage = recall(active, { scope: "lineage", query: "Planning-only" }, { all: [...active, sibling] });
  assert.equal(lineage.effectiveScope, "lineage");
  assert.match(lineage.text, /Non-default lineage scope/);
  assert.match(lineage.text, /Planning-only evidence/);
  assert.doesNotMatch(lineage.text, /Sibling-only evidence/);

  const all = recall(active, { scope: "all", query: "Sibling-only" }, { all: [...active, sibling] });
  assert.equal(all.effectiveScope, "all");
  assert.match(all.text, /Non-default all scope/);
  assert.match(all.text, /Sibling-only evidence/);
});

test("raw source entries remain addressable after compaction", () => {
  const active = baseBranch();
  active.push(entry("compaction", "response", {
    type: "compaction",
    summary: "derived summary",
    firstKeptEntryId: "request",
    tokensBefore: 10_000,
    details: {
      type: CONTINUITY_COMPACTION_TYPE,
      version: 1,
      runId: "run",
      timelineId: "timeline",
      handoffEntryId: "handoff",
      currentTaskEntryId: "request",
      sourceEntryCount: 2,
    },
  }));
  const result = recall(active, { query: "Executor request" });
  assert.match(result.text, /entry=request/);
  assert.doesNotMatch(result.text, /entry=compaction/);
});

test("matching compaction identity permits explicit lineage but not an unproven execution cut", () => {
  const old = user("old", null, "Older raw evidence");
  const compacted = entry("compaction", "old", {
    type: "compaction",
    summary: "summary",
    firstKeptEntryId: "old",
    tokensBefore: 1,
    details: {
      type: CONTINUITY_COMPACTION_TYPE,
      version: 2,
      runId: "run",
      timelineId: "timeline",
      handoffEntryId: "missing-handoff",
      sourceEntryCount: 1,
      history: { read: [], modified: [] },
    },
  });
  const visible = [user("visible", null, "Visible fallback evidence")];
  const execution = recall([old, compacted], { query: "evidence" }, { visible });
  assert.equal(execution.effectiveScope, "visible");
  assert.match(execution.text, /Visible fallback evidence/);
  assert.doesNotMatch(execution.text, /Older raw evidence/);

  const lineage = recall([old, compacted], { scope: "lineage", query: "Older raw" }, { visible });
  assert.equal(lineage.effectiveScope, "lineage");
  assert.match(lineage.text, /Older raw evidence/);
});

test("malformed ancestry downgrades every requested scope to visible context", () => {
  const malformed = baseBranch();
  malformed[3] = { ...malformed[3], parentId: "missing" };
  for (const scope of ["execution", "lineage", "all"] as const) {
    const result = recall(malformed, { scope }, {
      visible: [user("visible", null, "Safe visible evidence")],
      all: malformed,
    });
    assert.equal(result.effectiveScope, "visible");
    assert.match(result.text, /downgraded|could not be proven/);
    assert.match(result.text, /Safe visible evidence/);
    assert.doesNotMatch(result.text, /Planning-only evidence/);
  }
});

test("visible fallback still slices at the newest handoff-shaped entry", () => {
  const malformed = baseBranch();
  malformed[3] = { ...malformed[3], parentId: "missing" };
  const result = recall(malformed, {}, { visible: baseBranch() });
  assert.equal(result.effectiveScope, "visible");
  assert.match(result.text, /Executor request evidence/);
  assert.doesNotMatch(result.text, /Planning-only evidence|Plan response/);
});

test("text search excludes thinking, tool arguments, results, and unrelated custom messages", () => {
  const active = baseBranch();
  active.push(assistant("call", "response", [
    { type: "thinking", thinking: "hidden-thinking-marker" },
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: "hidden-argument-marker.txt" } },
  ]));
  active.push(toolResult("result", "call", "read-1", "read", "hidden-result-marker"));
  active.push(custom("foreign", "result", "other-extension", "hidden-custom-marker"));
  active.push(custom("allowed", "foreign", "pi-continuity", "allowed continuity marker"));
  for (const query of ["hidden-thinking-marker", "hidden-argument-marker", "hidden-result-marker", "hidden-custom-marker"])
    assert.equal(recall(active, { query }).total, 0);
  const allowed = recall(active, { query: "allowed continuity" });
  assert.equal(allowed.total, 1);
  assert.match(allowed.text, /entry=allowed role=custom:pi-continuity/);
});

test("file evidence is path-only by default and exact result expansion is bounded and redacted", () => {
  const credential = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const active = baseBranch();
  active.push(assistant("call", "response", [
    { type: "toolCall", id: "read-1", name: "read", arguments: { path: `../private/${credential}.txt`, ignored: "raw-secret" } },
    { type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "cat forbidden.txt" } },
  ]));
  active.push(toolResult("result", "call", "read-1", "read", `file secret=${credential}\n${"large ".repeat(1_000)}`));

  const touched = recall(active, { mode: "touched" });
  assert.match(touched.text, /tool:read/);
  assert.match(touched.text, /\.\.\/private\/\[REDACTED CREDENTIAL\]/);
  assert.doesNotMatch(touched.text, /raw-secret|forbidden\.txt|file secret/);

  const files = recall(active, { mode: "files", expand: ["result"] });
  assert.match(files.text, /file result \(expanded\)/);
  assert.match(files.text, /\[REDACTED CREDENTIAL\]/);
  assert.doesNotMatch(files.text, new RegExp(credential));
  assert.match(files.text, /truncated by Continuity/);
});

test("expansion cannot cross the effective execution scope", () => {
  const active = baseBranch();
  const result = recall(active, { expand: ["planning"] });
  assert.doesNotMatch(result.text, /Planning-only evidence/);
  assert.match(result.text, /Ignored expansion IDs outside the bounded effective scope: planning/);
});

test("malformed newest Continuity compaction cannot fall back to older valid metadata", () => {
  const old = user("old", null, "Older evidence must stay hidden");
  const valid = entry("valid", "old", {
    type: "compaction",
    summary: "valid",
    firstKeptEntryId: "old",
    tokensBefore: 1,
    details: {
      type: CONTINUITY_COMPACTION_TYPE,
      version: 1,
      runId: "run",
      timelineId: "timeline",
      sourceEntryCount: 1,
    },
  });
  const malformed = entry("malformed", "valid", {
    type: "compaction",
    summary: "malformed",
    firstKeptEntryId: "old",
    tokensBefore: 1,
    details: { type: CONTINUITY_COMPACTION_TYPE, version: 1, runId: "run" },
  });
  const result = recall([old, valid, malformed], { scope: "lineage" }, {
    visible: [user("visible", null, "Visible evidence only")],
  });
  assert.equal(result.effectiveScope, "visible");
  assert.match(result.text, /Visible evidence only/);
  assert.doesNotMatch(result.text, /Older evidence must stay hidden/);
});

test("all scope rejects disconnected forests and duplicate tool-call IDs", () => {
  const active = baseBranch();
  const disconnected = user("other-root", null, "Disconnected sibling evidence");
  const forest = recall(active, { scope: "all" }, { all: [...active, disconnected] });
  assert.equal(forest.effectiveScope, "visible");
  assert.doesNotMatch(forest.text, /Disconnected sibling evidence/);

  const duplicate = assistant("duplicate", "response", [
    { type: "toolCall", id: "same-call", name: "read", arguments: { path: "a.txt" } },
    { type: "toolCall", id: "same-call", name: "read", arguments: { path: "b.txt" } },
  ]);
  const duplicated = recall([...active, duplicate], { scope: "all", mode: "files" }, {
    visible: [active.at(-1)!],
    all: [...active, duplicate],
  });
  assert.equal(duplicated.effectiveScope, "visible");
  assert.doesNotMatch(duplicated.text, /a\.txt|b\.txt/);
});

test("large sessions enforce scan, result, page, and output caps before rendering", () => {
  const active: any[] = [handoff("handoff", null)];
  let parent = "handoff";
  for (let index = 0; index < MAX_RECALL_SCAN_ENTRIES + 100; index++) {
    const next = user(`large-${index}`, parent, `bounded needle ${index}`);
    active.push(next);
    parent = next.id;
  }
  const result = recall(active, { query: "bounded needle", page: 50_000, expand: ["large-0"] });
  assert.equal(result.total, MAX_RECALL_RESULTS);
  assert.equal(result.page, 1_000);
  assert.match(result.text, new RegExp(`Bounded scan: newest ${MAX_RECALL_SCAN_ENTRIES}`));
  assert.match(result.text, new RegExp(`Result limit reached: collected the first ${MAX_RECALL_RESULTS}`));
  assert.match(result.text, /Ignored expansion IDs outside the bounded effective scope: large-0/);
  assert.ok(result.text.length <= MAX_RECALL_OUTPUT_CHARS);
});

test("pagination is stable, output is clipped, and unsafe regex is rejected", () => {
  const root = handoff("handoff", null);
  const active: any[] = [root];
  let parent = "handoff";
  for (let index = 0; index < 20; index++) {
    const next = user(`user-${index}`, parent, `needle ${index} ${"detail ".repeat(500)}`);
    active.push(next);
    parent = next.id;
  }
  const firstPage = recall(active, { query: "needle" });
  assert.equal(firstPage.total, RECALL_PAGE_SIZE + 1);
  assert.equal(firstPage.hasMore, true);
  assert.match(firstPage.text, /Page 1; 8 selected; more matches available/);

  const page = recall(active, { query: "needle", page: 2 });
  assert.equal(page.total, RECALL_PAGE_SIZE * 2 + 1);
  assert.equal(page.hasMore, true);
  assert.match(page.text, /Page 2; 8 selected; more matches available/);
  assert.ok(page.text.length <= MAX_RECALL_OUTPUT_CHARS);
  assert.match(page.text, /entry=user-11/);
  assert.doesNotMatch(page.text, /entry=user-19/);

  const finalPage = recall(active, { query: "needle", page: 3 });
  assert.equal(finalPage.total, 20);
  assert.equal(finalPage.hasMore, false);
  assert.match(finalPage.text, /Page 3; 4 selected; 20 matches found/);

  const regex = recall(active, { query: "/(a+)+$/" });
  assert.equal(regex.total, 0);
  assert.match(regex.text, /rejected as unsafe/);
});

test("page lookahead distinguishes exact cap matches from overflow", () => {
  const build = (count: number) => {
    const active: any[] = [handoff("handoff", null)];
    let parent = "handoff";
    for (let index = 0; index < count; index++) {
      const next = user(`cap-${index}`, parent, `cap needle ${index}`);
      active.push(next);
      parent = next.id;
    }
    return active;
  };

  for (const [count, selected, hasMore] of [
    [199, 7, false],
    [200, 8, false],
    [201, 8, true],
  ] as const) {
    const result = recall(build(count), { query: "cap needle", page: 25 });
    assert.equal(result.total, Math.min(count, MAX_RECALL_RESULTS));
    assert.equal(result.collected, Math.min(count, MAX_RECALL_RESULTS));
    assert.equal(result.hasMore, hasMore);
    assert.match(result.text, new RegExp(`Page 25; ${selected} selected`));
    if (count === 201)
      assert.match(result.text, /Result limit reached.*more matches available/s);
    else
      assert.doesNotMatch(result.text, /Result limit reached/);
  }
});

test("expanded results keep caller order and output only complete records", () => {
  const active: any[] = [handoff("handoff", null)];
  const expansions: string[] = [];
  let parent = "handoff";
  for (let index = 0; index < RECALL_PAGE_SIZE; index++) {
    const call = assistant(`call-${index}`, parent, [{
      type: "toolCall",
      id: `read-${index}`,
      name: "read",
      arguments: { path: `file-${index}.txt` },
    }]);
    const result = toolResult(
      `result-${index}`,
      call.id,
      `read-${index}`,
      "read",
      `expanded ${index} ${"large ".repeat(1_000)}`,
    );
    active.push(call, result);
    expansions.push(result.id);
    parent = result.id;
  }

  const result = recall(active, {
    mode: "files",
    query: "does-not-match",
    expand: expansions,
  });
  const rendered = result.text.match(/\[file result \(expanded\)\]/g)?.length ?? 0;
  assert.equal(result.hasMore, false);
  assert.match(result.text, /Page 1; 8 selected; 8 matches found/);
  assert.ok(rendered > 0 && rendered < RECALL_PAGE_SIZE);
  assert.match(result.text, /remaining selected records omitted by Continuity/);
  assert.ok(result.text.indexOf("entry=result-0") < result.text.indexOf("entry=result-1"));
  assert.ok(result.text.length <= MAX_RECALL_OUTPUT_CHARS);
});

test("sanitized text is used for both matching and compact source metadata", () => {
  const credential = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const active = baseBranch();
  active.push(user("entry\nspoof", "response", `credential ${credential}`));

  const hidden = recall(active, { query: credential });
  assert.equal(hidden.total, 0);
  assert.doesNotMatch(hidden.text, new RegExp(credential));

  const redacted = recall(active, { query: "REDACTED CREDENTIAL" });
  assert.equal(redacted.total, 1);
  assert.match(redacted.text, /entry=entry spoof role=user/);
  assert.doesNotMatch(redacted.text, /entry=entry\nspoof/);
  assert.doesNotMatch(redacted.text, new RegExp(credential));

  const root = handoff("file-handoff", null);
  const call = assistant("file-call", root.id, [{
    type: "toolCall",
    id: "file-read",
    name: "read",
    arguments: { path: `safe\nInjected ${credential}.txt` },
  }]);
  call.timestamp = `time\nInjected ${credential}`;
  const fileEntries = [root, call];
  const fileRecall = (query: string) => recallSession({
    sessionId: `session\nInjected ${credential}`,
    activeBranch: fileEntries,
    visibleEntries: fileEntries,
    work: work(),
    params: { mode: "touched", query },
  });
  assert.equal(fileRecall(credential).total, 0);
  const safeFile = fileRecall("REDACTED CREDENTIAL");
  assert.equal(safeFile.total, 1);
  assert.doesNotMatch(safeFile.text, new RegExp(credential));
  assert.doesNotMatch(safeFile.text, /Session: session\n|time\nInjected|safe\nInjected/);
});

test("recall is deterministic and does not mutate session entries or Work", () => {
  const active = baseBranch();
  const activeBefore = JSON.stringify(active);
  const state = work();
  const workBefore = JSON.stringify(state);
  const input = {
    sessionId: "session-1",
    activeBranch: active,
    visibleEntries: active.slice(-2),
    work: state,
    params: { query: "Executor" },
  };
  const first = recallSession(input);
  const second = recallSession(input);
  assert.equal(first.text, second.text);
  assert.equal(JSON.stringify(active), activeBefore);
  assert.equal(JSON.stringify(state), workBefore);
});
