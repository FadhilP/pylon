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
  assert.doesNotMatch(context, /sourceReviewId|excerptSha256|confidence/);
  for (const line of context.split("\n").filter((value) => value.startsWith("Memory:"))) assert.match(line, /\.$/);
});
