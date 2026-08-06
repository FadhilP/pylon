import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildContext, promptQuery, shortlistNotes, shortlistResolvedNotes } from "../src/context.ts";
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
