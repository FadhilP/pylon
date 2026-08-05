import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MEMORY_V5_ROLLOUT, assertRolloutEnabled, reviewerBackedV4MigrationPolicy } from "../src/memory-rollout.ts";

test("checked-in rollout manifest matches immutable default-off operation gates", async () => {
  const manifest = JSON.parse(await readFile(new URL("../docs/memory-v5-rollout-gates.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.gates, MEMORY_V5_ROLLOUT);
  assert.equal(manifest.requirements.minimumCorpusSize, 500);
  assert.equal(manifest.requirements.minimumPrecision, 0.99);
  for (const operation of Object.keys(MEMORY_V5_ROLLOUT) as Array<keyof typeof MEMORY_V5_ROLLOUT>) assert.throws(() => assertRolloutEnabled(operation), /rollout gate/);
});

test("explicit migration policy bypasses only the V4 migration gate", () => {
  for (const operation of Object.keys(MEMORY_V5_ROLLOUT) as Array<keyof typeof MEMORY_V5_ROLLOUT>) assert.equal(reviewerBackedV4MigrationPolicy(operation), operation === "v4_migration");
});
