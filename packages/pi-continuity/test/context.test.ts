import test from "node:test";
import assert from "node:assert/strict";
import { blocked } from "../src/plan-gate.ts";
import { buildContext, shortlistFacts } from "../src/context.ts";
import { fresh, setPlan, updateTodo, hasRemainingTodos } from "../src/active-work.ts";
import type { Fact } from "../src/memory.ts";

test("gate fail closed", () => {
  for (const x of ["edit", "write", "bash", "other"])
    assert.equal(blocked(true, x), true);
  for (const x of [
    "read",
    "grep",
    "find",
    "ls",
    "continuity_update",
    "repo_scout",
    "advisor",
  ])
    assert.equal(blocked(true, x), false);
});
test("empty continuity state injects no context", () => {
  assert.equal(buildContext(undefined, [], ""), "");
});
test("context bounded active first", () => {
  const w = fresh("goal");
  assert.ok(buildContext(w, [], "", 20).length <= 80);
});
test("context includes preferences but rejects weak one-word memory matches", () => {
  const facts: Fact[] = [
    { key: "preference.style", kind: "preference", text: "Keep output terse", source: "user", confidence: 1, updatedAt: "2026-01-01" },
    { key: "workflow.release", kind: "workflow", text: "Run release check", source: "README", confidence: 1, updatedAt: "2026-01-01" },
  ];
  const text = buildContext(undefined, facts, "discuss release migrations");
  assert.match(text, /Memory preference\.style: Keep output terse/);
  assert.doesNotMatch(text, /workflow\.release/);
});
test("one preference is reserved without crowding out relevant facts", () => {
  const preferences: Fact[] = Array.from({ length: 10 }, (_, index) => ({
    key: `preference.style${index}`, kind: "preference", text: `Style choice ${index}`,
    source: "user", confidence: 1, updatedAt: `2026-01-${String(index + 1).padStart(2, "0")}`,
  }));
  const facts: Fact[] = [
    ...preferences,
    { key: "workflow.release", kind: "workflow", text: "Run release check", source: "README", confidence: 1, updatedAt: "2026-01-01" },
    { key: "warning.deploy", kind: "warning", text: "Check deploy warning", source: "README", confidence: 1, updatedAt: "2026-01-01" },
  ];
  const selected = shortlistFacts(facts, "release check deploy warning");
  assert.deepEqual(selected.map((fact) => fact.key), ["preference.style9", "warning.deploy", "workflow.release"]);
});
test("context accepts two-term and exact-identifier memory matches", () => {
  const facts: Fact[] = [
    { key: "workflow.release", kind: "workflow", text: "Run release check", source: "README", confidence: 1, updatedAt: "2026-01-01" },
    { key: "architecture.web_scout", kind: "architecture", text: "Use web_scout for public research", source: "source", confidence: 1, updatedAt: "2026-01-01" },
  ];
  assert.match(buildContext(undefined, facts, "release check"), /workflow\.release/);
  assert.match(buildContext(undefined, facts, "call web_scout"), /architecture\.web_scout/);
});
test("context normalizes inflections and conservative workflow synonyms", () => {
  const release: Fact = {
    key: "workflow.release", kind: "workflow", text: "Run test before release",
    source: "README", confidence: 1, updatedAt: "2026-01-01",
  };
  const tests: Fact = {
    key: "workflow.tests", kind: "workflow", text: "Run test suite",
    source: "README", confidence: 1, updatedAt: "2026-01-01",
  };
  assert.match(buildContext(undefined, [release], "Verify package before shipping"), /workflow\.release/);
  assert.match(buildContext(undefined, [tests], "run tests"), /workflow\.tests/);
  assert.equal(buildContext(undefined, [tests], "check formatting"), "");
});
test("context deduplicates identical local and parent facts before clipping", () => {
  const fact: Fact = {
    key: "workflow.release", kind: "workflow", text: "Run release check", source: "README",
    confidence: 1, updatedAt: "2026-01-01", captureCommit: "abc123", branchAtCapture: "main",
    evidencePaths: [{ path: "README.md", sha256: "hash" }],
  };
  const text = buildContext(undefined, [fact], "release check", 450, [{ ...fact, updatedAt: "2026-02-01" }]);
  assert.equal(text.match(/workflow\.release/g)?.length, 1);
  assert.doesNotMatch(text, /Parent memory/);
});

test("context keeps facts from different revisions distinct", () => {
  const fact: Fact = {
    key: "workflow.release", kind: "workflow", text: "Run release check", source: "README",
    confidence: 1, updatedAt: "2026-01-01", captureCommit: "abc123",
  };
  const text = buildContext(undefined, [fact], "release check", 450, [{ ...fact, captureCommit: "def456" }]);
  assert.match(text, /Memory workflow\.release/);
  assert.match(text, /Parent memory workflow\.release/);
});

test("context reserves room for active memory and suspect metadata without stale text", () => {
  const active: Fact = {
    key: "workflow.release", kind: "workflow", text: "Run release check", source: "README",
    confidence: 1, updatedAt: "2026-01-01",
  };
  const text = buildContext(undefined, [active], "release check", 100, [], [{
    key: "workflow.old", status: "suspect", reason: "capture is not an ancestor of HEAD",
  }]);
  assert.match(text, /Memory workflow\.release: Run release check/);
  assert.match(text, /Memory workflow\.old \[suspect\]/);
  assert.match(text, /ancestry or age alone never justifies deletion/);
  assert.doesNotMatch(text, /obsolete command text/);
});
test("context deduplicates constraints before planning limits", () => {
  const work = fresh("goal");
  work.mode = "planning";
  work.constraints = ["Repeated constraint", "Repeated constraint", "Unique constraint"];
  const text = buildContext(work, [], "", 900);
  assert.equal(text.match(/Repeated constraint/g)?.length, 1);
  assert.match(text, /Unique constraint/);
});

test("context exposes exact todo IDs and status", () => {
  const w = fresh("goal");
  setPlan(w, ["inspect"]);
  const text = buildContext(w, [], "", 900);
  assert.match(text, /Todo todo_1 \[pending\]: inspect/);
});
test("executing context is compact while planning retains approval detail", () => {
  const executing = fresh("A deliberately concise but active execution goal");
  setPlan(executing, ["done work", "current work", "next one", "next two", "next three", "omitted later"]);
  executing.mode = "executing";
  executing.planSummary = "Anchor packages/pi-continuity/src/context.ts and verify focused tests.";
  executing.constraints = ["Keep compatibility", "Do not redesign", "This third constraint is omitted"];
  updateTodo(executing, "todo_1", "done");
  updateTodo(executing, "todo_2", "in_progress");
  const compact = buildContext(executing, [], "", 300);
  assert.match(compact, /Current todo_2 \[in_progress\]: current work/);
  assert.match(compact, /Todo todo_3 \[pending\]: next one/);
  assert.match(compact, /Done: 1/);
  assert.doesNotMatch(compact, /done work/);
  assert.doesNotMatch(compact, /todo_6/);
  assert.match(compact, /Plan anchor:/);
  assert.ok(compact.length <= 1_200);

  const planning = fresh("Review proposal");
  setPlan(planning, ["Inspect", "Implement", "Test", "Document", "Review"]);
  planning.planSummary = "Detailed approval approach";
  const detailed = buildContext(planning, [], "", 300);
  assert.match(detailed, /Plan: Detailed approval approach/);
  assert.match(detailed, /Todo todo_5 \[pending\]: Review/);
});

test("plan refresh preserves todo progress", () => {
  const w = fresh("goal");
  setPlan(w, ["inspect", "fix"], "1");
  assert.equal(updateTodo(w, "todo_1", "done", "2"), true);
  setPlan(w, ["inspect", "test"], "3");
  assert.equal(w.todos[0].status, "done");
  assert.equal(w.todos[1].status, "pending");
  assert.equal(new Set(w.todos.map((t) => t.id)).size, 2);
  assert.equal(hasRemainingTodos(w), true);
  updateTodo(w, w.todos[1].id, "done", "4");
  assert.equal(hasRemainingTodos(w), false);
});
test("todo current state follows status", () => {
  const w = fresh();
  setPlan(w, ["work"]);
  assert.equal(updateTodo(w, "todo_1", "in_progress"), true);
  assert.equal(w.currentTodoId, "todo_1");
  updateTodo(w, "todo_1", "done");
  assert.equal(w.currentTodoId, undefined);
  assert.equal(updateTodo(w, "missing", "done"), false);
});
