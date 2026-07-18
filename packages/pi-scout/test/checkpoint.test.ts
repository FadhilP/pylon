import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCheckpoint, repoResult, saveCheckpoint } from "../src/checkpoint.ts";
import { MAX_BYTES } from "../src/result.ts";

test("repo result prefers final output and recovers only timeout checkpoints", () => {
  assert.equal(repoResult("final", undefined, "partial"), "final");
  assert.match(repoResult("", "Scout timed out.", "partial cited report"), /Partial checkpoint[\s\S]*partial cited report/);
  assert.doesNotMatch(repoResult("", "Scout timed out."), /Partial checkpoint/);
});

test("checkpoint storage is bounded and missing-safe", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-checkpoint-"));
  const path = join(dir, "checkpoint.md");
  assert.equal(await loadCheckpoint(path), undefined);
  await saveCheckpoint(path, "finding\n".repeat(2000));
  const checkpoint = await loadCheckpoint(path);
  assert.ok(checkpoint);
  assert.ok(Buffer.byteLength(checkpoint) <= MAX_BYTES + 100);
  await assert.rejects(saveCheckpoint(path, "   "), /must not be empty/);
});
