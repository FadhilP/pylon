import test from "node:test";
import assert from "node:assert/strict";
import { continuityStateSnapshot, CONTINUITY_STATE_VERSION } from "../src/state.ts";
import type { Fact } from "../src/memory.ts";

test("continuity state publishes bounded memory facts", () => {
  const facts: Fact[] = Array.from({ length: 35 }, (_, index) => ({
    key: `fact.${index}`,
    kind: "architecture",
    text: `Fact ${index}`,
    source: "test",
    confidence: 0.8,
    updatedAt: new Date(index).toISOString(),
    scope: "project",
    owner: "project",
  }));
  const globalFacts: Fact[] = facts.map((fact, index) => ({
    ...fact,
    key: index === 0 ? "user.preference" : `user.${index}`,
    scope: "user",
    owner: "default",
    captureCommit: "a".repeat(40),
    branchAtCapture: "main",
    evidencePaths: [{ path: "package.json", sha256: "b".repeat(64) }],
  }));
  const snapshot = continuityStateSnapshot("session", 3, undefined, true, facts, globalFacts);
  assert.equal(snapshot.version, CONTINUITY_STATE_VERSION);
  assert.equal(snapshot.memory.length, 30);
  assert.equal(snapshot.memory[0]?.key, "fact.0");
  assert.equal(snapshot.globalMemory.length, 30);
  assert.equal(snapshot.globalMemory[0]?.key, "user.preference");
  assert.equal("captureCommit" in snapshot.globalMemory[0]!, false);
  assert.equal("branchAtCapture" in snapshot.globalMemory[0]!, false);
  assert.equal("evidencePaths" in snapshot.globalMemory[0]!, false);
});
