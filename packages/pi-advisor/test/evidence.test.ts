import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEvidence } from "../src/evidence.ts";

test("loads only bounded line-numbered workspace evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "advisor-evidence-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "example.ts"), "one\ntwo\nthree\nfour\n");
  const evidence = await loadEvidence(root, [
    { path: "src/example.ts", start: 2, end: 3 },
  ]);
  assert.match(evidence, /src\/example\.ts:2-3/);
  assert.match(evidence, /2: two\n3: three/);
  assert.doesNotMatch(evidence, /1: one|4: four/);
});

test("rejects traversal, binary files, and oversized ranges nonfatally", async () => {
  const parent = await mkdtemp(join(tmpdir(), "advisor-boundary-"));
  const root = join(parent, "repo");
  await mkdir(root);
  await writeFile(join(parent, "outside.txt"), "secret");
  await writeFile(join(root, "binary"), Buffer.from([1, 0, 2]));
  const evidence = await loadEvidence(root, [
    { path: "../outside.txt", start: 1, end: 1 },
    { path: "binary", start: 1, end: 1 },
    { path: "binary", start: 1, end: 201 },
  ]);
  assert.match(evidence, /path escapes workspace/);
  assert.match(evidence, /binary file rejected/);
  assert.match(evidence, /range must contain 1\.\.200 lines/);
  assert.doesNotMatch(evidence, /secret/);
});
