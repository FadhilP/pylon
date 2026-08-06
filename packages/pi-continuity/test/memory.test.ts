import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  applyReview, directDelete, directEdit, discardExpiredReviews, emptyMemoryState, enforceMemoryLimits, exactDuplicate,
  isMemoryState, normalizeMemoryState, normalizeProposalBatch, notesForOwners, parseReviewerOutput,
  renderNote, stageReview, type MemoryStateFile, type NotebookNote, type ReviewRecord,
} from "../src/memory.ts";

const note = (overrides: Partial<NotebookNote> = {}): NotebookNote => ({
  id: randomUUID(), scope: "project", owner: "owner", trigger: "changing package settings",
  guidance: "Apply updates to subsequent runtimes; do not expect hot reconfiguration.", authority: "project_contract",
  origin: "agent", sourceRefs: [{ type: "repository", path: "src/config.ts", excerptSha256: "a".repeat(64) }],
  relatedPaths: ["src/config.ts"], revision: 1, createdAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-01-01T00:00:00.000Z", ...overrides,
});
const state = (...notes: NotebookNote[]): MemoryStateFile => ({ ...emptyMemoryState(), notes, updatedAt: "2025-01-01T00:00:00.000Z" });

test("V5 state validates strict records and owner visibility", () => {
  const user = note({ id: randomUUID(), scope: "user", owner: "default", authority: "user_instruction" });
  const file = state(note(), user);
  assert.equal(isMemoryState(file), true);
  assert.deepEqual(notesForOwners(file.notes, "owner"), file.notes);
  assert.equal(notesForOwners(file.notes, "other").length, 1);
  assert.equal(normalizeMemoryState({ ...file, unknown: true }), undefined);
  assert.equal(normalizeMemoryState({ ...file, notes: [{ ...file.notes[0], owner: undefined }] }), undefined);
  assert.equal(normalizeMemoryState({ ...file, notes: [{ ...user, owner: "forged" }] }), undefined);
});

test("proposal schema enforces batch, scope, fields, and exact target shape", () => {
  const proposals = normalizeProposalBatch([{ operation: "add", scope: "project", trigger: " changing settings ", guidance: " restart later ", basis: { type: "project_contract", evidence: [{ path: "src/a.ts", start: 1, end: 2 }] } }]);
  assert.equal((proposals[0] as any).trigger, "changing settings");
  assert.throws(() => normalizeProposalBatch([]), /one or two/);
  assert.throws(() => normalizeProposalBatch([proposals[0], proposals[0], proposals[0]]), /one or two/);
  assert.throws(() => normalizeProposalBatch([{ ...proposals[0], scope: "user" }]), /user memory/);
  assert.throws(() => normalizeProposalBatch([{ ...proposals[0], owner: "forged" }]), /invalid/);
});

test("reviewer output is strict and complete", () => {
  const output = parseReviewerOutput(JSON.stringify({ version: 1, decisions: [{ proposalIndex: 0, verdict: "accept", operation: "add", trigger: "using filters", guidance: "Prefer a dropdown for finite categories.", authority: "user_instruction", reasonCode: "durable_rule" }] }), 1);
  assert.equal(output.decisions[0]?.verdict, "accept");
  assert.throws(() => parseReviewerOutput('{"version":1,"decisions":[]}', 1), /invalid envelope/);
  assert.throws(() => parseReviewerOutput(JSON.stringify({ version: 1, decisions: [{ proposalIndex: 0, verdict: "reject", reasonCode: "task_local", extra: true }] }), 1), /invalid/);
  assert.throws(() => parseReviewerOutput(JSON.stringify({ version: 1, decisions: [{ proposalIndex: 1, verdict: "reject", reasonCode: "task_local" }] }), 1), /unknown/);
});

test("every documented reviewer decision branch parses", () => {
  const targetId = randomUUID();
  const decisions = [
    { proposalIndex: 0, verdict: "reject", reasonCode: "not_durable" },
    { proposalIndex: 0, verdict: "accept", operation: "replace", trigger: "changing settings", guidance: "Keep the existing rule.", authority: "project_contract", reasonCode: "durable_rule" },
    { proposalIndex: 0, verdict: "rewrite", operation: "add", trigger: "when replying", guidance: "Keep replies concise.", authority: "user_instruction", reasonCode: "normalized_rule" },
    { proposalIndex: 0, verdict: "merge", operation: "add", targetId, expectedRevision: 1, trigger: "when replying", guidance: "Keep replies concise.", authority: "user_instruction", reasonCode: "existing_rule" },
    { proposalIndex: 0, verdict: "accept", operation: "remove", targetId, expectedRevision: 1, reasonCode: "revoked_rule" },
  ];
  for (const decision of decisions) assert.equal(parseReviewerOutput(JSON.stringify({ version: 1, decisions: [decision] }), 1).decisions.length, 1);
});

test("invalid decision diagnostics are bounded and do not echo model fields", () => {
  const decisions = Array.from({ length: 20 }, (_, index) => ({ proposalIndex: index, decision: "accept", guidance: `private-${index}` }));
  assert.throws(() => parseReviewerOutput(JSON.stringify({ version: 1, decisions }), 20), (error: Error) => {
    assert.equal(error.message, "memory reviewer returned invalid decisions (count:20; first-output-indexes:0,1,2,3,4,5,6,7,8,9)");
    assert.doesNotMatch(error.message, /private|guidance/);
    return true;
  });
});

test("review staging and settlement are atomic and idempotent", () => {
  const review: ReviewRecord = { reviewId: randomUUID(), sessionId: "s", toolCallId: "c", projectOwner: "owner", reviewedAt: "2025-01-02T00:00:00.000Z", status: "approved_pending", requiresVerification: false, generation: 1, taskGeneration: 1, operations: [{ operation: "add", noteId: randomUUID(), scope: "project", owner: "owner", trigger: "changing settings", guidance: "Restart the runtime after configuration changes.", authority: "project_contract", sourceRefs: [{ type: "repository", path: "src/config.ts", excerptSha256: "b".repeat(64) }] }], rejectionCounts: {} };
  const staged = stageReview(state(), review), committed = applyReview(staged, review, "2025-01-03T00:00:00.000Z");
  assert.equal(committed.notes.length, 1);
  assert.equal(committed.reviews[0]?.status, "committed");
  assert.equal(applyReview(committed, review), committed);
});

test("direct edit and delete use scoped revision CAS and user authority", () => {
  const original = note(), edited = directEdit(state(original), "project", "owner", original.id, 1, "changing settings", "Restart after changing settings.");
  assert.equal(edited.notes[0]?.revision, 2);
  assert.equal(edited.notes[0]?.origin, "user");
  assert.equal(edited.notes[0]?.authority, "user_instruction");
  assert.deepEqual(edited.notes[0]?.sourceRefs, [{ type: "direct_user_edit" }]);
  assert.equal(edited.audits?.at(-1)?.type, "direct_edit");
  assert.throws(() => directEdit(edited, "project", "owner", original.id, 1, "x", "y"), /changed/);
  const deleted = directDelete(edited, "project", "owner", original.id, 2);
  assert.equal(deleted.notes.length, 0);
  assert.equal(deleted.audits?.at(-1)?.type, "direct_delete");
});

test("abandoned pending reviews are explicitly discarded after retention", () => {
  const review: ReviewRecord = { reviewId: randomUUID(), sessionId: "s", toolCallId: "old", projectOwner: "owner", reviewedAt: "2020-01-01T00:00:00.000Z", status: "approved_pending", requiresVerification: false, generation: 1, taskGeneration: 1, operations: [], rejectionCounts: {} };
  const reconciled = discardExpiredReviews({ ...state(), reviews: [review] }, new Date("2020-02-15T00:00:00.000Z"));
  assert.equal(reconciled.reviews[0]?.status, "discarded"); assert.match(reconciled.reviews[0]?.discardReason ?? "", /abandoned/);
});

test("pending review capacity rejects new staging without evicting approved operations", () => {
  const reviews = Array.from({ length: 200 }, (_, index): ReviewRecord => ({ reviewId: randomUUID(), sessionId: "s", toolCallId: `call-${index}`, projectOwner: "owner", reviewedAt: new Date(1_700_000_000_000 + index).toISOString(), status: "approved_pending", requiresVerification: false, generation: 1, taskGeneration: 1, operations: [], rejectionCounts: {} }));
  const full: MemoryStateFile = { ...state(), reviews };
  const next: ReviewRecord = { ...reviews[0]!, reviewId: randomUUID(), toolCallId: "next" };
  assert.throws(() => stageReview(full, next), /ledger is full/);
  assert.equal(full.reviews.length, 200);
});

test("deduplication, rendering, and safety ceilings never evict", () => {
  const first = note();
  assert.equal(exactDuplicate([first], "project", "owner", ` ${first.trigger.toUpperCase()} `, first.guidance)?.id, first.id);
  assert.match(renderNote(first), /^Memory: When changing package settings,/);
  const oversized = state(...Array.from({ length: 1_001 }, (_, index) => note({ id: randomUUID(), trigger: `trigger ${index}` })));
  assert.throws(() => enforceMemoryLimits(oversized), /1,000-note/);
});
