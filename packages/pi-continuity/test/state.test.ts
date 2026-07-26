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
  const snapshot = continuityStateSnapshot("session", 3, undefined, true, facts);
  assert.equal(snapshot.version, CONTINUITY_STATE_VERSION);
  assert.equal(snapshot.memory.length, 30);
  assert.equal(snapshot.memory[0]?.key, "fact.0");
});
