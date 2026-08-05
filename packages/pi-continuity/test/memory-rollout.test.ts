import test from "node:test";
import assert from "node:assert/strict";
import { MEMORY_V5_ROLLOUT, assertRolloutEnabled, reviewerBackedV4MigrationPolicy } from "../src/memory-rollout.ts";

test("immutable operation gates default off", () => {
  assert.deepEqual(MEMORY_V5_ROLLOUT, {
    user_instruction_add: { enabled: false, corpusSize: 0 },
    project_contract_write: { enabled: false, corpusSize: 0 },
    merge_replace: { enabled: false, corpusSize: 0 },
    reviewer_remove: { enabled: false, corpusSize: 0 },
    v4_migration: { enabled: false, corpusSize: 0 },
  });
  for (const operation of Object.keys(MEMORY_V5_ROLLOUT) as Array<keyof typeof MEMORY_V5_ROLLOUT>) assert.throws(() => assertRolloutEnabled(operation), /rollout gate/);
});

test("explicit migration policy bypasses only the V4 migration gate", () => {
  for (const operation of Object.keys(MEMORY_V5_ROLLOUT) as Array<keyof typeof MEMORY_V5_ROLLOUT>) assert.equal(reviewerBackedV4MigrationPolicy(operation), operation === "v4_migration");
});
