import { createHash } from "node:crypto";
import {
  MEMORY_COMPILER_VERSION,
  buildRuleIndex,
  candidateRules,
  compileActivationDraft,
  evaluateCompiledRule,
  type AgentEventKind,
  type CompiledRule,
  type EventFrame,
  type TriggerFact,
} from "./memory-activation.ts";
import type { NotebookNote } from "./memory.ts";

export const MEMORY_SIDECAR_VERSION = 1 as const;
export const MEMORY_LEDGER_VERSION = 1 as const;
export const MEMORY_LEDGER_ENTRY_TYPE = "pi-continuity-memory-ledger-v1";

type Primitive = string | number | boolean;
export type CompiledMemorySidecar = {
  version: typeof MEMORY_SIDECAR_VERSION;
  memoryRevision: number;
  compilerVersion: typeof MEMORY_COMPILER_VERSION;
  rules: CompiledRule[];
  failures: Array<{
    memoryId: string;
    noteRevision: number;
    reason: "invalid_activation_draft" | "source_stale" | "policy_ineligible";
  }>;
  updatedAt: string;
};
export type ActiveMemory = {
  memoryId: string;
  noteRevision: number;
  activatedAtSequence: number;
  activeUntil: CompiledRule["lifecycle"]["activateUntil"];
  lastDeliveredContextEpoch?: number;
};
export type DeliveryRecord = {
  memoryId: string;
  noteRevision: number;
  contextEpoch: number;
  cause: string;
};
export type MemoryLedger = {
  version: typeof MEMORY_LEDGER_VERSION;
  sessionId: string;
  taskGeneration: number;
  contextEpoch: number;
  sequence: number;
  active: ActiveMemory[];
  deliveries: DeliveryRecord[];
};
export type MemoryIntervention = {
  memoryId: string;
  noteRevision: number;
  mode: "inject_once" | "warn";
  cause: string;
};

const eventKinds: readonly AgentEventKind[] = [
  "task_started",
  "before_tool_call",
  "after_tool_result",
  "context_compacted",
];
const triggerFacts = new Set<TriggerFact>([
  "event.kind",
  "tool.name",
  "tool.command",
  "tool.exitCode",
  "tool.isError",
  "tool.errorSignature",
  "file.path",
  "task.phase",
  "attempt.count",
]);
const activeUntil = new Set<ActiveMemory["activeUntil"]>([
  "event_complete",
  "task_complete",
  "session_complete",
  "source_changes",
  "explicit_revocation",
]);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer = (value: unknown, minimum = 0) =>
  Number.isSafeInteger(value) && Number(value) >= minimum;
const exactKeys = (value: any, keys: readonly string[]) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

export function compileMemorySidecar(
  notes: readonly NotebookNote[],
  memoryRevision: number,
  now = new Date().toISOString(),
): CompiledMemorySidecar {
  const rules: CompiledRule[] = [],
    failures: CompiledMemorySidecar["failures"] = [];
  for (const note of [...notes].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    if (note.disposition === "eligible_enforced") {
      failures.push({
        memoryId: note.id,
        noteRevision: note.revision,
        reason: "policy_ineligible",
      });
      continue;
    }
    if (note.disposition !== "eligible_advisory" || !note.activationDraft)
      continue;
    try {
      const sourceSnapshotId = createHash("sha256")
        .update(JSON.stringify(note.sourceRefs))
        .digest("hex");
      const rule = compileActivationDraft(
        note.id,
        note.revision,
        note.activationDraft,
        sourceSnapshotId,
      );
      if (rule) rules.push(rule);
    } catch {
      failures.push({
        memoryId: note.id,
        noteRevision: note.revision,
        reason: "invalid_activation_draft",
      });
    }
  }
  return {
    version: MEMORY_SIDECAR_VERSION,
    memoryRevision,
    compilerVersion: MEMORY_COMPILER_VERSION,
    rules,
    failures,
    updatedAt: now,
  };
}

export const indexMemorySidecar = (sidecar: CompiledMemorySidecar) =>
  buildRuleIndex(sidecar.rules);

export function emptyMemoryLedger(
  sessionId: string,
  taskGeneration = 0,
): MemoryLedger {
  return {
    version: MEMORY_LEDGER_VERSION,
    sessionId,
    taskGeneration,
    contextEpoch: 0,
    sequence: 0,
    active: [],
    deliveries: [],
  };
}

export function isMemoryLedger(value: any): value is MemoryLedger {
  return (
    exactKeys(value, [
      "version",
      "sessionId",
      "taskGeneration",
      "contextEpoch",
      "sequence",
      "active",
      "deliveries",
    ]) &&
    value.version === MEMORY_LEDGER_VERSION &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 200 &&
    integer(value.taskGeneration) &&
    integer(value.contextEpoch) &&
    integer(value.sequence) &&
    Array.isArray(value.active) &&
    value.active.length <= 1_000 &&
    value.active.every(
      (item: any) =>
        exactKeys(item, [
          "memoryId",
          "noteRevision",
          "activatedAtSequence",
          "activeUntil",
          "lastDeliveredContextEpoch",
        ]) &&
        uuid.test(item.memoryId) &&
        integer(item.noteRevision, 1) &&
        integer(item.activatedAtSequence) &&
        activeUntil.has(item.activeUntil) &&
        (item.lastDeliveredContextEpoch === undefined ||
          integer(item.lastDeliveredContextEpoch)),
    ) &&
    Array.isArray(value.deliveries) &&
    value.deliveries.length <= 2_000 &&
    value.deliveries.every(
      (item: any) =>
        exactKeys(item, [
          "memoryId",
          "noteRevision",
          "contextEpoch",
          "cause",
        ]) &&
        uuid.test(item.memoryId) &&
        integer(item.noteRevision, 1) &&
        integer(item.contextEpoch) &&
        typeof item.cause === "string" &&
        item.cause.length > 0 &&
        item.cause.length <= 240,
    )
  );
}

export function restoreMemoryLedger(
  entries: readonly any[],
  sessionId: string,
  taskGeneration: number,
): MemoryLedger {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      entry?.type !== "custom" ||
      entry.customType !== MEMORY_LEDGER_ENTRY_TYPE ||
      !isMemoryLedger(entry.data) ||
      entry.data.sessionId !== sessionId
    )
      continue;
    return {
      ...entry.data,
      taskGeneration,
      active: entry.data.active.map((item: ActiveMemory) => ({ ...item })),
      deliveries: entry.data.deliveries.map((item: DeliveryRecord) => ({
        ...item,
      })),
    };
  }
  return emptyMemoryLedger(sessionId, taskGeneration);
}

function boundedFacts(
  input: Record<string, unknown>,
): Partial<Record<TriggerFact, Primitive>> {
  const facts: Partial<Record<TriggerFact, Primitive>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      !triggerFacts.has(key as TriggerFact) ||
      !(
        (typeof value === "string" && value.length <= 500) ||
        (typeof value === "number" && Number.isFinite(value)) ||
        typeof value === "boolean"
      )
    )
      throw Error("invalid memory event fact");
    facts[key as TriggerFact] = value;
  }
  return facts;
}

export function eventFrame(input: {
  kind: AgentEventKind;
  ledger: MemoryLedger;
  repository: string;
  taskPhase: string;
  toolCallId?: string;
  facts?: Record<string, unknown>;
}): EventFrame {
  if (!eventKinds.includes(input.kind))
    throw Error("invalid memory event kind");
  return {
    kind: input.kind,
    sequence: input.ledger.sequence + 1,
    sessionId: input.ledger.sessionId,
    taskGeneration: input.ledger.taskGeneration,
    contextEpoch: input.ledger.contextEpoch,
    repository: input.repository,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    facts: {
      ...boundedFacts(input.facts ?? {}),
      "event.kind": input.kind,
      "task.phase": input.taskPhase,
    },
  };
}

const causeFor = (event: EventFrame) =>
  event.toolCallId
    ? `tool:${event.toolCallId}`
    : `${event.kind}:${event.sequence}`;
const deliveryKey = (
  memoryId: string,
  noteRevision: number,
  contextEpoch: number,
) => `${memoryId}\0${noteRevision}\0${contextEpoch}`;

export function processMemoryEvent(
  index: ReadonlyMap<AgentEventKind, readonly CompiledRule[]>,
  event: EventFrame,
  current: MemoryLedger,
): {
  ledger: MemoryLedger;
  interventions: MemoryIntervention[];
  uncertain: string[];
} {
  if (
    event.sessionId !== current.sessionId ||
    event.sequence <= current.sequence
  )
    return { ledger: current, interventions: [], uncertain: [] };
  let active = current.active.filter(
    (item) =>
      event.kind !== "task_started" ||
      !["event_complete", "task_complete"].includes(item.activeUntil),
  );
  const deliveries = [...current.deliveries],
    delivered = new Set(
      deliveries.map((item) =>
        deliveryKey(item.memoryId, item.noteRevision, item.contextEpoch),
      ),
    );
  const interventions: MemoryIntervention[] = [],
    uncertain: string[] = [],
    cause = causeFor(event);
  for (const rule of candidateRules(index, event)) {
    const result = evaluateCompiledRule(rule, event);
    if (result === "unknown") {
      uncertain.push(rule.memoryId);
      continue;
    }
    if (!result) continue;
    const key = deliveryKey(
      rule.memoryId,
      rule.noteRevision,
      event.contextEpoch,
    );
    const activeIndex = active.findIndex(
      (item) =>
        item.memoryId === rule.memoryId &&
        item.noteRevision === rule.noteRevision,
    );
    if (delivered.has(key)) {
      if (rule.lifecycle.activateUntil !== "event_complete") {
        const next = {
          memoryId: rule.memoryId,
          noteRevision: rule.noteRevision,
          activatedAtSequence: event.sequence,
          activeUntil: rule.lifecycle.activateUntil,
          lastDeliveredContextEpoch: event.contextEpoch,
        };
        if (activeIndex >= 0)
          active[activeIndex] = {
            ...active[activeIndex]!,
            lastDeliveredContextEpoch: event.contextEpoch,
          };
        else active.push(next);
      }
      continue;
    }
    delivered.add(key);
    if (rule.lifecycle.activateUntil !== "event_complete") {
      deliveries.push({
        memoryId: rule.memoryId,
        noteRevision: rule.noteRevision,
        contextEpoch: event.contextEpoch,
        cause: "active",
      });
      if (activeIndex >= 0)
        active[activeIndex] = {
          ...active[activeIndex]!,
          lastDeliveredContextEpoch: event.contextEpoch,
        };
      else
        active.push({
          memoryId: rule.memoryId,
          noteRevision: rule.noteRevision,
          activatedAtSequence: event.sequence,
          activeUntil: rule.lifecycle.activateUntil,
          lastDeliveredContextEpoch: event.contextEpoch,
        });
    } else
      deliveries.push({
        memoryId: rule.memoryId,
        noteRevision: rule.noteRevision,
        contextEpoch: event.contextEpoch,
        cause,
      });
    interventions.push({
      memoryId: rule.memoryId,
      noteRevision: rule.noteRevision,
      mode: rule.delivery === "inject_once" ? "inject_once" : "warn",
      cause,
    });
  }
  return {
    ledger: {
      ...current,
      taskGeneration: event.taskGeneration,
      contextEpoch: event.contextEpoch,
      sequence: event.sequence,
      active: active.slice(-1_000),
      deliveries: deliveries.slice(-2_000),
    },
    interventions,
    uncertain,
  };
}

export function rearmMemoryAfterCompaction(
  current: MemoryLedger,
): MemoryLedger {
  return {
    ...current,
    contextEpoch: current.contextEpoch + 1,
    sequence: current.sequence + 1,
  };
}

export function activeMemoryForDelivery(current: MemoryLedger): ActiveMemory[] {
  return current.active.filter(
    (item) => item.lastDeliveredContextEpoch !== current.contextEpoch,
  );
}

export function markActiveMemoryDelivered(
  current: MemoryLedger,
  delivered: readonly ActiveMemory[],
): MemoryLedger {
  const keys = new Set(
      delivered.map((item) => `${item.memoryId}\0${item.noteRevision}`),
    ),
    records = [...current.deliveries];
  for (const item of delivered)
    if (
      !records.some(
        (record) =>
          record.memoryId === item.memoryId &&
          record.noteRevision === item.noteRevision &&
          record.contextEpoch === current.contextEpoch,
      )
    )
      records.push({
        memoryId: item.memoryId,
        noteRevision: item.noteRevision,
        contextEpoch: current.contextEpoch,
        cause: "active",
      });
  return {
    ...current,
    active: current.active.map((item) =>
      keys.has(`${item.memoryId}\0${item.noteRevision}`)
        ? { ...item, lastDeliveredContextEpoch: current.contextEpoch }
        : item,
    ),
    deliveries: records.slice(-2_000),
  };
}
