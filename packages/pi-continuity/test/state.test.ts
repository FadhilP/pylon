import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { continuityStateSnapshot, CONTINUITY_STATE_VERSION } from "../src/state.ts";
import { fresh, setPlan } from "../src/active-work.ts";
import type { NotebookNote } from "../src/memory.ts";

test("continuity state publishes V5 scoped note models", () => {
  const make = (scope: "user" | "project", owner: string): NotebookNote => ({ id: randomUUID(), scope, owner, trigger: "changing settings", guidance: "Restart after updates.", authority: scope === "user" ? "user_instruction" : "project_contract", origin: "agent", sourceRefs: [{ type: "direct_user_edit" }], relatedPaths: ["src/config.ts"], revision: 2, createdAt: "2025-01-01T00:00:00Z", updatedAt: "2025-01-02T00:00:00Z" });
  const snapshot = continuityStateSnapshot("session", 3, undefined, true, [make("project", "o")], [make("user", "default")], true);
  assert.equal(snapshot.version, CONTINUITY_STATE_VERSION);
  assert.equal(snapshot.memory[0]?.scope, "project");
  assert.equal(snapshot.globalMemory[0]?.scope, "user");
  assert.equal(snapshot.memory[0]?.revision, 2);
  assert.equal(snapshot.v4MigrationAvailable, true);
  assert.equal("confidence" in snapshot.memory[0]!, false);
  assert.equal("kind" in snapshot.memory[0]!, false);
});

test("continuity state projects structured plan and approval recovery fields", () => {
  const work = fresh("Ship");
  setPlan(work, ["Implement"]);
  work.planRevision = 1;
  work.planSummary = "Implement safely";
  work.handoff = { workingSet: ["src/index.ts"], assumptions: ["API stable"], acceptanceCriteria: ["Tests pass"] };
  work.approval = { token: "token", revision: 1, resetContext: true, executorModel: { provider: "provider", id: "executor" }, createdAt: new Date(0).toISOString() };
  work.revisionFeedback = { revision: 1, text: "Clarify it", createdAt: new Date(0).toISOString() };

  const projected = continuityStateSnapshot("session", 1, work).work!;
  assert.equal(projected.approvalPending, true);
  assert.equal(projected.planRevision, 1);
  assert.deepEqual(projected.handoff?.workingSet, ["src/index.ts"]);
  assert.equal(projected.revisionFeedback?.text, "Clarify it");
});
