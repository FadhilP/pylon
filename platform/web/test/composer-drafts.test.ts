import test from "node:test";
import assert from "node:assert/strict";
import { COMPOSER_DRAFTS_KEY, latestProjectDraft, readComposerDrafts, writeComposerDrafts, type ComposerDraft } from "../src/shared/composer-drafts.ts";

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: (key: string) => key === COMPOSER_DRAFTS_KEY ? value : null,
    setItem: (key: string, next: string) => { if (key === COMPOSER_DRAFTS_KEY) value = next; },
  };
}

test("composer drafts persist and select the newest draft for a project", () => {
  const storage = memoryStorage();
  const drafts = new Map<string, ComposerDraft>([
    ["older", { sessionId: "older", projectId: "project", text: "first", updatedAt: 1 }],
    ["newer", { sessionId: "newer", projectId: "project", text: "second", updatedAt: 2 }],
    ["other", { sessionId: "other", projectId: "other-project", text: "other", updatedAt: 3 }],
  ]);

  writeComposerDrafts(storage, drafts);
  const restored = readComposerDrafts(storage);

  assert.deepEqual([...restored.values()], [...drafts.values()]);
  assert.equal(latestProjectDraft(restored, "project")?.sessionId, "newer");
});

test("composer drafts ignore malformed persisted data", () => {
  const storage = memoryStorage(JSON.stringify([
    { sessionId: "valid", projectId: "project", text: "draft", updatedAt: 1 },
    { sessionId: "missing-project", text: "draft", updatedAt: 2 },
  ]));

  assert.deepEqual([...readComposerDrafts(storage).keys()], ["valid"]);
  assert.deepEqual([...readComposerDrafts(memoryStorage("not-json")).keys()], []);
});
