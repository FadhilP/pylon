import assert from "node:assert/strict";
import test from "node:test";
import { fileHistoryContext } from "../src/file-history.ts";
import type { Bound } from "../src/records.ts";
import type { Snapshot } from "../src/snapshot.ts";

const snapshot = (id: number): Snapshot => ({
  snapshotId: String(id),
  gitRoot: "/repo",
  commonDir: "/repo/.git",
  head: "a".repeat(40),
  headRef: "refs/heads/main",
  worktreeRef: `refs/test/${id}`,
  indexRef: `refs/test/index-${id}`,
  worktreeTree: id.toString(16).padStart(40, "0"),
  indexTree: "b".repeat(40),
});
const bound = (entry: string, prompt: string, id: number, owner = "s"): Bound => ({
  checkpointEntryId: entry,
  preview: entry,
  sessionId: owner,
  record: {
    ...snapshot(id),
    version: 6,
    kind: "pi-prompt-checkpoint",
    promptEntryId: prompt,
    ownerSessionId: owner,
    continuationEntryId: prompt,
    createdAt: "2026-01-01",
    baseline: snapshot(0),
  },
});

test("rewind excludes a checkpoint even when its prompt survives, and excludes linked-session checkpoints", () => {
  const records = new Map([
    ["s:old", bound("old", "prompt", 1)],
    ["s:new", bound("new", "prompt", 2)],
    ["other:foreign", bound("foreign", "prompt", 3, "other")],
  ]);
  const current = fileHistoryContext("s", [{ id: "prompt" }, { id: "new" }, { id: "foreign" }], records);
  assert.deepEqual(
    current.checkpoints.map(checkpoint => checkpoint.id),
    ["s:new"],
  );
  assert.equal(current.baseline?.tree, snapshot(0).worktreeTree);
  const rewound = fileHistoryContext("s", [{ id: "prompt" }], records);
  assert.deepEqual(rewound.checkpoints, []);
});

test("branch order wins over insertion order and bounded windows retain an unknown-attribution seed", () => {
  const branch = Array.from({ length: 205 }, (_, index) => [{ id: `p${index}` }, { id: `c${index}` }]).flat();
  const records = new Map(
    Array.from(
      { length: 205 },
      (_, index) => [`s:c${index}`, bound(`c${index}`, `p${index}`, index + 1)] as const,
    ).reverse(),
  );
  const history = fileHistoryContext("s", branch, records);
  assert.equal(history.partial, true);
  assert.equal(history.checkpoints.length, 200);
  assert.equal(history.checkpoints[0].id, "s:c5");
  assert.equal(history.checkpoints.at(-1)?.id, "s:c204");
  assert.equal(history.seed?.tree, snapshot(5).worktreeTree);
  assert.equal(history.baseline?.tree, snapshot(0).worktreeTree);
});
