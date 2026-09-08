import test from "node:test";
import assert from "node:assert/strict";
import {
  applyExplorerChange,
  DEFAULT_EXPLORER_STATE,
  EXPLORER_STATE_KEY,
  readExplorerStates,
  writeExplorerStates,
  type ExplorerState,
} from "../src/client/workspace/explorer-state.ts";

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: (key: string) => (key === EXPLORER_STATE_KEY ? value : null),
    setItem: (key: string, next: string) => {
      if (key === EXPLORER_STATE_KEY) value = next;
    },
  };
}

test("round trips each project's open folders and change filter", () => {
  const storage = memoryStorage();
  const states = new Map<string, ExplorerState>([
    ["pylon", { open: ["platform", "platform/web"], changesOnly: false }],
    ["other", { open: [], changesOnly: true }],
  ]);

  writeExplorerStates(storage, states);
  assert.deepEqual(readExplorerStates(storage), states);
});

test("a project that was never opened falls back to the default", () => {
  const storage = memoryStorage();
  writeExplorerStates(storage, new Map([["pylon", { open: ["src"], changesOnly: false }]]));

  const stored = readExplorerStates(storage);
  assert.equal(stored.get("unseen"), undefined);
  assert.deepEqual(stored.get("unseen") ?? DEFAULT_EXPLORER_STATE, { open: [], changesOnly: false });
});

test("malformed storage reads back empty instead of throwing", () => {
  assert.equal(readExplorerStates(memoryStorage("not json")).size, 0);
  assert.equal(readExplorerStates(memoryStorage('{"pylon":["src"]}')).size, 0);
});

test("drops entries of the wrong shape and keeps the rest", () => {
  const raw = JSON.stringify([
    { projectId: "good", open: ["src"], changesOnly: true },
    { projectId: "", open: [], changesOnly: true },
    { projectId: "no-flag", open: [] },
    { projectId: "bad-paths", open: [7], changesOnly: true },
  ]);

  assert.deepEqual(readExplorerStates(memoryStorage(raw)), new Map([["good", { open: ["src"], changesOnly: true }]]));
});

test("a change always lands, so the tree responds before its project is known", () => {
  // Regression: an early return on a missing project dropped the change outright,
  // leaving every folder click a no-op until the session list arrived.
  const pending = applyExplorerChange(new Map(), "unfiled", { open: ["platform"] });
  assert.deepEqual(pending.get("unfiled"), { open: ["platform"], changesOnly: false });

  const filed = applyExplorerChange(pending, "pylon", { changesOnly: false });
  assert.deepEqual(filed.get("pylon"), { open: [], changesOnly: false });
  assert.deepEqual(filed.get("unfiled"), { open: ["platform"], changesOnly: false });
});

test("a change merges into what the project already had", () => {
  const before = new Map([["pylon", { open: ["src"], changesOnly: false }]]);
  const after = applyExplorerChange(before, "pylon", { open: ["src", "test"] });

  assert.deepEqual(after.get("pylon"), { open: ["src", "test"], changesOnly: false });
  assert.deepEqual(before.get("pylon"), { open: ["src"], changesOnly: false }, "the input map is not mutated");
});
