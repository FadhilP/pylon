import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  applyReview,
  archivalActivationDraft,
  directDelete,
  directEdit,
  discardExpiredReviews,
  emptyMemoryState,
  enforceMemoryLimits,
  exactDuplicate,
  isMemoryState,
  migrateV5MemoryState,
  normalizeMemoryState,
  normalizeProposalBatch,
  notesForOwners,
  parseReviewerOutput,
  renderNote,
  stageReview,
  type MemoryStateFile,
  type NotebookNote,
  type ReviewRecord,
} from "../src/memory.ts";

const verified = {
  status: "verified" as const,
  verifiedAt: "2025-01-02T00:00:00.000Z",
  sourceSnapshotId: "f".repeat(64),
};
const note = (overrides: Partial<NotebookNote> = {}): NotebookNote => ({
  id: randomUUID(),
  scope: "project",
  owner: "owner",
  trigger: "changing package settings",
  guidance: "Apply updates to subsequent runtimes; do not expect hot reconfiguration.",
  authority: "project_contract",
  origin: "agent",
  sourceRefs: [{ type: "repository", path: "src/config.ts", excerptSha256: "a".repeat(64) }],
  relatedPaths: ["src/config.ts"],
  disposition: "archival",
  enforcementAuthority: "context_only",
  revision: 1,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
  ...overrides,
});
const state = (...notes: NotebookNote[]): MemoryStateFile => ({
  ...emptyMemoryState(),
  notes,
  updatedAt: "2025-01-01T00:00:00.000Z",
});
const reviewedAdd = (overrides = {}) => ({
  operation: "add" as const,
  noteId: randomUUID(),
  scope: "project" as const,
  owner: "owner",
  trigger: "changing settings",
  guidance: "Restart the runtime after configuration changes.",
  authority: "project_contract" as const,
  sourceRefs: [{ type: "repository" as const, path: "src/config.ts", excerptSha256: "b".repeat(64) }],
  disposition: "archival" as const,
  enforcementAuthority: "context_only" as const,
  activationDraft: archivalActivationDraft(),
  rawProposal: { trigger: "changing settings", guidance: "Restart the runtime after configuration changes." },
  rewriteCharacter: "format_only" as const,
  ...overrides,
});
const review = (overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({
  reviewId: randomUUID(),
  sessionId: "s",
  toolCallId: "c",
  projectOwner: "owner",
  reviewedAt: "2025-01-02T00:00:00.000Z",
  status: "approved_pending",
  verificationStatus: verified,
  generation: 1,
  taskGeneration: 1,
  operations: [],
  rejectionCounts: {},
  ...overrides,
});

test("V6 state validates strict records and owner visibility", () => {
  const user = note({ id: randomUUID(), scope: "user", owner: "default", authority: "user_instruction" });
  const file = state(note(), user);
  assert.equal(isMemoryState(file), true);
  assert.equal(file.schemaVersion, 6);
  assert.deepEqual(notesForOwners(file.notes, "owner"), file.notes);
  assert.equal(notesForOwners(file.notes, "other").length, 1);
  assert.equal(normalizeMemoryState({ ...file, unknown: true }), undefined);
  assert.equal(normalizeMemoryState({ ...file, notes: [{ ...file.notes[0], owner: undefined }] }), undefined);
  assert.equal(normalizeMemoryState({ ...file, notes: [{ ...user, owner: "forged" }] }), undefined);
});

test("reviewer output is V2, strict, and conservatively archives missing or invalid activation", () => {
  const accepted = {
    proposalIndex: 0,
    verdict: "accept",
    operation: "add",
    scope: "user",
    trigger: "using filters",
    guidance: "Prefer a dropdown for finite categories.",
    authority: "user_instruction",
    activationDraft: archivalActivationDraft(),
    reasonCode: "durable_rule",
  };
  const output = parseReviewerOutput(JSON.stringify({ version: 2, decisions: [accepted] }), 1);
  assert.equal(output.decisions[0]?.verdict, "accept");
  assert.throws(() => parseReviewerOutput('{"version":1,"decisions":[]}', 1), /invalid envelope/);
  for (const activationDraft of [undefined, { classification: "grounded" }]) {
    const decision = { ...accepted, activationDraft } as any;
    if (activationDraft === undefined) delete decision.activationDraft;
    const parsed = parseReviewerOutput(JSON.stringify({ version: 2, decisions: [decision] }), 1).decisions[0] as any;
    assert.equal(parsed.activationDraft.classification, "archival");
  }
  assert.throws(
    () =>
      parseReviewerOutput(
        JSON.stringify({
          version: 2,
          decisions: [{ proposalIndex: 0, verdict: "reject", reasonCode: "task_local", extra: true }],
        }),
        1,
      ),
    /invalid/,
  );
  assert.throws(
    () =>
      parseReviewerOutput(
        JSON.stringify({ version: 2, decisions: [{ proposalIndex: 1, verdict: "reject", reasonCode: "task_local" }] }),
        1,
      ),
    /unknown/,
  );
  const sorted = parseReviewerOutput(
    JSON.stringify({
      version: 2,
      decisions: [
        { proposalIndex: 1, verdict: "reject", reasonCode: "task_local" },
        { proposalIndex: 0, verdict: "defer", reasonCode: "insufficient_context" },
      ],
    }),
    2,
  );
  assert.deepEqual(
    sorted.decisions.map(decision => decision.proposalIndex),
    [0, 1],
  );
});

test("every documented reviewer decision branch parses", () => {
  const targetId = randomUUID(),
    draft = archivalActivationDraft();
  const decisions = [
    { proposalIndex: 0, verdict: "reject", reasonCode: "not_durable" },
    { proposalIndex: 0, verdict: "defer", reasonCode: "insufficient_context" },
    {
      proposalIndex: 0,
      verdict: "accept",
      operation: "replace",
      scope: "project",
      targetId,
      expectedRevision: 1,
      trigger: "changing settings",
      guidance: "Keep the existing rule.",
      authority: "project_contract",
      activationDraft: draft,
      reasonCode: "durable_rule",
    },
    {
      proposalIndex: 0,
      verdict: "rewrite",
      operation: "add",
      scope: "user",
      trigger: "when replying",
      guidance: "Keep replies concise.",
      authority: "user_instruction",
      activationDraft: draft,
      rewriteCharacter: "format_only",
      reasonCode: "normalized_rule",
    },
    {
      proposalIndex: 0,
      verdict: "merge",
      operation: "replace",
      scope: "user",
      targetId,
      expectedRevision: 1,
      trigger: "when replying",
      guidance: "Keep replies concise.",
      authority: "user_instruction",
      activationDraft: draft,
      rewriteCharacter: "format_only",
      reasonCode: "existing_rule",
    },
    {
      proposalIndex: 0,
      verdict: "accept",
      operation: "remove",
      scope: "project",
      targetId,
      expectedRevision: 1,
      reasonCode: "revoked_rule",
    },
  ];
  for (const decision of decisions)
    assert.equal(parseReviewerOutput(JSON.stringify({ version: 2, decisions: [decision] }), 1).decisions.length, 1);
});

test("invalid decision diagnostics are bounded and do not echo model fields", () => {
  const decisions = Array.from({ length: 20 }, (_, index) => ({
    proposalIndex: index,
    decision: "accept",
    guidance: `private-${index}`,
  }));
  assert.throws(
    () => parseReviewerOutput(JSON.stringify({ version: 2, decisions }), 20),
    (error: Error) => {
      assert.equal(
        error.message,
        "memory reviewer returned invalid decisions (count:20; first-output-indexes:0,1,2,3,4,5,6,7,8,9)",
      );
      assert.doesNotMatch(error.message, /private|guidance/);
      return true;
    },
  );
});

test("review staging and settlement are atomic and idempotent", () => {
  const pending = review({ operations: [reviewedAdd()] });
  const staged = stageReview(state(), pending),
    committed = applyReview(staged, pending, "2025-01-03T00:00:00.000Z");
  assert.equal(committed.notes.length, 1);
  assert.equal(committed.reviews[0]?.status, "committed");
  assert.equal(applyReview(committed, pending), committed);
});

test("direct edit and delete use scoped revision CAS and user authority", () => {
  const original = note(),
    edited = directEdit(
      state(original),
      "project",
      "owner",
      original.id,
      1,
      "changing settings",
      "Restart after changing settings.",
    );
  assert.equal(edited.notes[0]?.revision, 2);
  assert.equal(edited.notes[0]?.origin, "user");
  assert.equal(edited.notes[0]?.authority, "user_instruction");
  assert.deepEqual(edited.notes[0]?.sourceRefs, [{ type: "direct_user_edit" }]);
  assert.equal(edited.notes[0]?.disposition, "archival");
  assert.equal(edited.audits?.at(-1)?.type, "direct_edit");
  assert.throws(() => directEdit(edited, "project", "owner", original.id, 1, "x", "y"), /changed/);
  const deleted = directDelete(edited, "project", "owner", original.id, 2);
  assert.equal(deleted.notes.length, 0);
  assert.equal(deleted.audits?.at(-1)?.type, "direct_delete");
});

test("abandoned pending reviews are explicitly discarded after retention", () => {
  const pending = review({ toolCallId: "old", reviewedAt: "2020-01-01T00:00:00.000Z" });
  const reconciled = discardExpiredReviews({ ...state(), reviews: [pending] }, new Date("2020-02-15T00:00:00.000Z"));
  assert.equal(reconciled.reviews[0]?.status, "discarded");
  assert.match(reconciled.reviews[0]?.discardReason ?? "", /abandoned/);
});

test("pending review capacity rejects new staging without evicting approved operations", () => {
  const reviews = Array.from({ length: 200 }, (_, index): ReviewRecord =>
    review({ toolCallId: `call-${index}`, reviewedAt: new Date(1_700_000_000_000 + index).toISOString() }),
  );
  const full: MemoryStateFile = { ...state(), reviews };
  const next: ReviewRecord = { ...reviews[0]!, reviewId: randomUUID(), toolCallId: "next" };
  assert.throws(() => stageReview(full, next), /ledger is full/);
  assert.equal(full.reviews.length, 200);
});

test("V5 migration preserves prose and provenance while archiving pending reviews", () => {
  const { disposition: _disposition, enforcementAuthority: _enforcementAuthority, ...legacyNote } = note();
  const legacyReview = {
    ...review({ operations: [reviewedAdd()], status: "approved_pending" }),
    operations: [
      {
        operation: "add",
        noteId: randomUUID(),
        scope: "project",
        owner: "owner",
        trigger: "legacy trigger",
        guidance: "legacy guidance",
        authority: "project_contract",
        sourceRefs: legacyNote.sourceRefs,
      },
    ],
  };
  const legacy = {
    schemaVersion: 5,
    revision: 4,
    notes: [legacyNote],
    reviews: [legacyReview],
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
  const now = "2025-02-01T00:00:00.000Z",
    migrated = migrateV5MemoryState(legacy, now);
  if (!migrated) assert.fail("valid V5 state should migrate");
  assert.equal(migrated.schemaVersion, 6);
  assert.equal(migrated.revision, 5);
  assert.equal(migrated.notes[0]?.trigger, legacyNote.trigger);
  assert.equal(migrated.notes[0]?.guidance, legacyNote.guidance);
  assert.deepEqual(migrated.notes[0]?.sourceRefs, legacyNote.sourceRefs);
  assert.equal(migrated.notes[0]?.disposition, "archival");
  assert.equal(migrated.notes[0]?.enforcementAuthority, "context_only");
  assert.equal(migrated.reviews[0]?.status, "discarded");
  assert.equal(migrated.reviews[0]?.operations[0]?.operation, "add");
  assert.deepEqual((migrated.reviews[0]?.operations[0] as any)?.sourceRefs, legacyReview.operations[0]?.sourceRefs);
  assert.deepEqual(migrateV5MemoryState(legacy, now), migrated, "fixed migration time gives deterministic output");
  assert.equal(migrateV5MemoryState(migrated, now), undefined, "migration is not reapplied to V6 state");
  assert.equal(migrateV5MemoryState({ ...legacy, notes: [{}] }, now), undefined);
});

test("deduplication, rendering, and safety ceilings never evict", () => {
  const first = note();
  assert.equal(
    exactDuplicate([first], "project", "owner", ` ${first.trigger.toUpperCase()} `, first.guidance)?.id,
    first.id,
  );
  assert.match(renderNote(first), /^Memory: When changing package settings,/);
  const oversized = state(
    ...Array.from({ length: 1_001 }, (_, index) => note({ id: randomUUID(), trigger: `trigger ${index}` })),
  );
  assert.throws(() => enforceMemoryLimits(oversized), /1,000-note/);
});
