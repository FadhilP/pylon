import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ActivationDraft } from "../src/memory-activation.ts";
import type { NotebookNote } from "../src/memory.ts";
import {
  MEMORY_LEDGER_ENTRY_TYPE,
  activeMemoryForDelivery,
  compileMemorySidecar,
  emptyMemoryLedger,
  eventFrame,
  indexMemorySidecar,
  isMemoryLedger,
  markActiveMemoryDelivered,
  processMemoryEvent,
  rearmMemoryAfterCompaction,
  restoreMemoryLedger,
} from "../src/memory-runtime.ts";

const draft = (
  activateUntil: ActivationDraft["lifecycle"]["activateUntil"] = "task_complete",
): ActivationDraft => ({
  classification: "grounded",
  subscriptions: ["before_tool_call"],
  predicate: {
    all: [
      { fact: "tool.name", op: "eq", value: "edit" },
      { fact: "file.path", op: "matchesGlob", value: "src/generated/**" },
    ],
  },
  delivery: "warn",
  lifecycle: { activateUntil, rearmOn: ["context_compacted"] },
  examples: {
    positive: [
      {
        event: "before_tool_call",
        facts: { "tool.name": "edit", "file.path": "src/generated/client.ts" },
      },
    ],
    hardNegative: [
      {
        event: "before_tool_call",
        facts: { "tool.name": "edit", "file.path": "src/source/client.ts" },
      },
    ],
  },
});
const note = (activationDraft = draft()): NotebookNote => ({
  id: randomUUID(),
  scope: "project",
  owner: "owner",
  trigger: "editing generated files",
  guidance: "Edit the generator instead.",
  authority: "project_contract",
  origin: "agent",
  sourceRefs: [],
  disposition: "eligible_advisory",
  enforcementAuthority: "warning",
  activationDraft,
  rawProposal: {
    trigger: "editing generated files",
    guidance: "Edit the generator instead.",
  },
  rewriteCharacter: "format_only",
  revision: 1,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z",
});

test("sidecar compilation keeps prose canonical and indexes only compiled drafts", () => {
  const active = note(),
    archival = {
      ...note(),
      id: randomUUID(),
      disposition: "archival" as const,
      activationDraft: undefined,
      enforcementAuthority: "context_only" as const,
    };
  const enforced = {
    ...note(),
    id: randomUUID(),
    disposition: "eligible_enforced" as const,
    enforcementAuthority: "blocking_guard" as const,
  };
  const sidecar = compileMemorySidecar(
    [archival, active, enforced],
    3,
    "2025-01-01T00:00:00.000Z",
  );
  assert.equal(sidecar.memoryRevision, 3);
  assert.deepEqual(
    sidecar.rules.map((rule) => rule.memoryId),
    [active.id],
  );
  assert.deepEqual(sidecar.failures, [
    { memoryId: enforced.id, noteRevision: 1, reason: "policy_ineligible" },
  ]);
  assert.match(sidecar.rules[0]!.sourceSnapshotId, /^[0-9a-f]{64}$/);
  assert.match(
    sidecar.rules[0]!.cacheKey,
    new RegExp(`^${active.id}:1:[0-9a-f]{64}:1:1$`),
  );
});

test("prospective matching allows none and delivers an active rule once per context epoch", () => {
  const memory = note(),
    index = indexMemorySidecar(compileMemorySidecar([memory], 1));
  let ledger = emptyMemoryLedger("session", 1);
  const miss = eventFrame({
    kind: "before_tool_call",
    ledger,
    repository: "owner",
    taskPhase: "executing",
    toolCallId: "miss",
    facts: { "tool.name": "edit", "file.path": "src/source/client.ts" },
  });
  let processed = processMemoryEvent(index, miss, ledger);
  ledger = processed.ledger;
  assert.deepEqual(processed.interventions, []);
  const hit = eventFrame({
    kind: "before_tool_call",
    ledger,
    repository: "owner",
    taskPhase: "executing",
    toolCallId: "hit",
    facts: { "tool.name": "edit", "file.path": "src/generated/client.ts" },
  });
  processed = processMemoryEvent(index, hit, ledger);
  ledger = processed.ledger;
  assert.deepEqual(
    processed.interventions.map((item) => item.memoryId),
    [memory.id],
  );
  const second = eventFrame({
    kind: "before_tool_call",
    ledger,
    repository: "owner",
    taskPhase: "executing",
    toolCallId: "other",
    facts: { "tool.name": "edit", "file.path": "src/generated/other.ts" },
  });
  processed = processMemoryEvent(index, second, ledger);
  ledger = processed.ledger;
  assert.deepEqual(
    processed.interventions,
    [],
    "active task rule remains visible without duplicate delivery",
  );
  ledger = rearmMemoryAfterCompaction(ledger);
  assert.deepEqual(
    activeMemoryForDelivery(ledger).map((item) => item.memoryId),
    [memory.id],
  );
  ledger = markActiveMemoryDelivered(ledger, activeMemoryForDelivery(ledger));
  assert.deepEqual(activeMemoryForDelivery(ledger), []);
});

test("active delivery deduplication survives more than 200 simultaneous rules", () => {
  const notes = Array.from({ length: 250 }, () => note()),
    index = indexMemorySidecar(compileMemorySidecar(notes, 1));
  let ledger = emptyMemoryLedger("session", 1);
  const next = (toolCallId: string) =>
    eventFrame({
      kind: "before_tool_call",
      ledger,
      repository: "owner",
      taskPhase: "executing",
      toolCallId,
      facts: { "tool.name": "edit", "file.path": "src/generated/client.ts" },
    });
  let result = processMemoryEvent(index, next("first"), ledger);
  ledger = result.ledger;
  assert.equal(result.interventions.length, 250);
  result = processMemoryEvent(index, next("second"), ledger);
  assert.equal(result.interventions.length, 0);
});

test("event frames reject facts outside the closed vocabulary", () => {
  const ledger = emptyMemoryLedger("session", 1);
  assert.throws(
    () =>
      eventFrame({
        kind: "before_tool_call",
        ledger,
        repository: "owner",
        taskPhase: "executing",
        facts: { "unknown.fact": true },
      }),
    /invalid memory event fact/,
  );
  assert.throws(
    () =>
      eventFrame({
        kind: "after_tool_result",
        ledger,
        repository: "owner",
        taskPhase: "executing",
        facts: { "tool.exitCode": Number.POSITIVE_INFINITY },
      }),
    /invalid memory event fact/,
  );
});

test("candidate delivery modes are downgraded to advisory interventions", () => {
  const candidate = draft();
  candidate.delivery = "block_candidate";
  const memory = note(candidate),
    index = indexMemorySidecar(compileMemorySidecar([memory], 1)),
    ledger = emptyMemoryLedger("session", 1);
  const event = eventFrame({
    kind: "before_tool_call",
    ledger,
    repository: "owner",
    taskPhase: "executing",
    toolCallId: "candidate",
    facts: { "tool.name": "edit", "file.path": "src/generated/client.ts" },
  });
  assert.deepEqual(
    processMemoryEvent(index, event, ledger).interventions.map(
      (item) => item.mode,
    ),
    ["warn"],
  );
});

test("event-complete delivery remains visible once per context epoch", () => {
  const memory = note(draft("event_complete")),
    index = indexMemorySidecar(compileMemorySidecar([memory], 1));
  let ledger = emptyMemoryLedger("session", 1);
  const call = (toolCallId: string) =>
    eventFrame({
      kind: "before_tool_call",
      ledger,
      repository: "owner",
      taskPhase: "executing",
      toolCallId,
      facts: { "tool.name": "edit", "file.path": "src/generated/client.ts" },
    });
  let result = processMemoryEvent(index, call("one"), ledger);
  ledger = result.ledger;
  assert.equal(result.interventions.length, 1);
  result = processMemoryEvent(index, call("one"), ledger);
  ledger = result.ledger;
  assert.equal(result.interventions.length, 0);
  result = processMemoryEvent(index, call("two"), ledger);
  ledger = result.ledger;
  assert.equal(
    result.interventions.length,
    0,
    "visible memory is not repeated for a sibling tool call",
  );
  ledger = rearmMemoryAfterCompaction(ledger);
  result = processMemoryEvent(index, call("three"), ledger);
  assert.equal(
    result.interventions.length,
    1,
    "compaction rearms event-complete delivery",
  );
});

test("ledger restoration is strict, bounded, and branch-local", () => {
  const stored = {
    ...emptyMemoryLedger("session", 2),
    contextEpoch: 3,
    sequence: 4,
  };
  assert.equal(isMemoryLedger(stored), true);
  const restored = restoreMemoryLedger(
    [{ type: "custom", customType: MEMORY_LEDGER_ENTRY_TYPE, data: stored }],
    "session",
    5,
  );
  assert.equal(restored.contextEpoch, 3);
  assert.equal(restored.taskGeneration, 5);
  assert.equal(
    restoreMemoryLedger(
      [
        {
          type: "custom",
          customType: MEMORY_LEDGER_ENTRY_TYPE,
          data: { ...stored, extra: true },
        },
      ],
      "session",
      1,
    ).contextEpoch,
    0,
  );
});
