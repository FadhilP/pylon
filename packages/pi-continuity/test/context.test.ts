import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildContext, buildMemoryInjection, promptQuery, retrievalQueries, shortlistNotes, shortlistResolvedNotes, shortlistResolvedQueries } from "../src/context.ts";
import type { NotebookNote } from "../src/memory.ts";

const note = (trigger: string, guidance: string, relatedPaths?: string[]): NotebookNote => ({ id: randomUUID(), scope: "project", owner: "o", trigger, guidance, authority: "project_contract", origin: "agent", sourceRefs: [], ...(relatedPaths ? { relatedPaths } : {}), revision: 1, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-01T00:00:00Z" });

test("retrieval matches trigger, guidance, paths, and identifiers", () => {
  const notes = [note("changing package settings", "Restart the runtime after updates.", ["src/config.ts"]), note("designing category filters", "Prefer a dropdown over free text.")];
  assert.equal(shortlistNotes(notes, "package configuration runtime")[0]?.id, notes[0]?.id);
  assert.equal(shortlistNotes(notes, "dropdown category filters")[0]?.id, notes[1]?.id);
  assert.equal(shortlistResolvedNotes(notes, "src/config.ts")[0]?.id, notes[0]?.id);
  assert.equal(shortlistNotes(notes, "unrelated").length, 0);
});

test("retrieval corpus keeps deterministic aliases, matches, and precision threshold", () => {
  const notes = [
    note("changing package settings", "Restart the runtime after updates."),
    note("publishing releases", "Tag only verified commits."),
    note("designing category filters", "Prefer a dropdown over free text."),
  ];
  const cases = [
    ["validate package configuration", notes[0]?.id],
    ["ship verified build", notes[1]?.id],
    ["category dropdown filters", notes[2]?.id],
    ["database migration", undefined],
    ["settings", undefined],
  ] as const;
  for (const [query, expected] of cases)
    assert.equal(shortlistResolvedNotes(notes, query)[0]?.id, expected, query);
});

test("promptQuery uses active work only for content-free continuation", () => {
  const work: any = { goal: "Implement package configuration", currentTodoId: "todo_1", todos: [{ id: "todo_1", text: "Update runtime settings" }] };
  assert.equal(promptQuery("continue", work), "Implement package configuration Update runtime settings");
  assert.equal(promptQuery("configure package", work), "configure package");
});

test("retrieval queries score prompt and planned intent independently", () => {
  const rule = note("running database migrations", "Create a backup before schema changes.");
  const work: any = {
    goal: "Add account history", planSummary: "Apply the database migration after reconnaissance",
    currentTodoId: "todo_1", todos: [{ id: "todo_1", text: "Inspect account schema" }],
  };
  assert.equal(shortlistResolvedQueries([rule], retrievalQueries("Add account history", work))[0]?.id, rule.id);
  assert.equal(shortlistResolvedQueries([note("database packages", "Keep both stable.")], ["database", "packages"]).length, 0,
    "separate intent fields must not combine weak matches");
});

test("generic agent vocabulary does not retrieve unrelated rules", () => {
  const rule = note("work involving StateQL", "Treat StateQL as a project owned by the user.");
  assert.equal(shortlistResolvedNotes([rule], "Could relevant memory affect steps the model will take for the user?").length, 0);

  const applicable = note("delegating agent tasks", "Use the high-effort worker profile.");
  assert.equal(shortlistResolvedNotes([applicable], "delegate this agent task with the high-effort profile")[0]?.id, applicable.id);
});

test("multi-query ties remain deterministic regardless of note order", () => {
  const first = note("package configuration changes", "Restart runtime services.");
  const second = note("package configuration changes", "Reload runtime settings.");
  const expected = [first.id, second.id].sort();
  assert.deepEqual(shortlistResolvedQueries([first, second], ["package configuration"], 2).map((item) => item.id), expected);
  assert.deepEqual(shortlistResolvedQueries([second, first], ["package configuration"], 2).map((item) => item.id), expected);
});

test("memory injection reports only complete newly rendered notes", () => {
  const first = note("database migrations", "Create a backup first.");
  const oversized = note("database migration schema", `Oversized ${"guidance ".repeat(80)}`);
  const injection = buildMemoryInjection([oversized, first], ["database migration schema"], 100, new Set());
  assert.deepEqual(injection.notes.map((item) => item.id), [first.id]);
  assert.match(injection.text, /Create a backup first/);
  assert.doesNotMatch(injection.text, /Oversized/);
  assert.equal(buildMemoryInjection([first], ["database migration"], 100, new Set([first.id])).text, "");

  const surfaced = Array.from({ length: 8 }, (_, index) =>
    note(`database migration schema ${index}`, "Create a backup first."));
  const ninth = note("database migration schema fallback", "Use the final fallback rule.");
  const backfilled = buildMemoryInjection([...surfaced, ninth], ["database migration schema"], 100, new Set(surfaced.map((item) => item.id)));
  assert.deepEqual(backfilled.notes.map((item) => item.id), [ninth.id],
    "surfaced candidates must not consume the discovery limit");
});

test("context injects at most two complete notebook rules within budget", () => {
  const notes = [note("changing package settings", "Restart the runtime after updates."), note("testing package settings", "Run the package tests."), note("publishing releases", "Tag only verified commits.")];
  const context = buildContext(undefined, notes, "package settings runtime tests", 150);
  assert.match(context, /Continuity state/);
  assert.ok((context.match(/^Memory:/gm) ?? []).length <= 2);
  assert.equal(shortlistResolvedNotes(notes, "package settings runtime tests").length, 2);
  assert.doesNotMatch(context, /sourceReviewId|excerptSha256|confidence/);
  for (const line of context.split("\n").filter((value) => value.startsWith("Memory:"))) assert.match(line, /\.$/);
});

test("context backfills shorter ranked candidates when stronger rules exceed the budget", () => {
  const notes = [
    note("package runtime configuration settings", `Oversized ${"guidance ".repeat(50)}`),
    note("package runtime settings", "Restart services."),
    note("package configuration tests", "Run focused checks."),
  ];
  const context = buildContext(undefined, notes, "package runtime configuration settings tests", 100);
  assert.doesNotMatch(context, /Oversized/);
  assert.match(context, /Restart services/);
  assert.match(context, /Run focused checks/);
  assert.equal((context.match(/^Memory:/gm) ?? []).length, 2);
});

test("parent candidates backfill oversized child rules and rendered rules stay single-line", () => {
  const children = Array.from({ length: 8 }, (_, index) =>
    note(`package runtime configuration settings child${index}`, `Oversized ${"guidance ".repeat(50)}`));
  const parent = note("package runtime settings", "Restart\nruntime services.");
  const context = buildContext(undefined, children, "package runtime configuration settings", 100, [parent]);
  assert.doesNotMatch(context, /Oversized/);
  assert.match(context, /Restart runtime services/);
  assert.equal((context.match(/^Memory:/gm) ?? []).length, 1);
});
