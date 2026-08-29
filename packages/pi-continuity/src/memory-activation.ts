import { matchesGlob } from "node:path";

export const MEMORY_TRIGGER_DSL_VERSION = 1;
export const MEMORY_COMPILER_VERSION = 1;

export type AgentEventKind = "task_started" | "before_tool_call" | "after_tool_result" | "context_compacted";
export type TriggerFact =
  | "event.kind"
  | "tool.name"
  | "tool.command"
  | "tool.exitCode"
  | "tool.isError"
  | "tool.errorSignature"
  | "file.path"
  | "task.phase"
  | "attempt.count";
type Primitive = string | number | boolean;
type TriggerOperator = "eq" | "neq" | "contains" | "startsWith" | "matchesGlob" | "gte";

export type TriggerExpression =
  | { all: TriggerExpression[] }
  | { any: TriggerExpression[] }
  | { not: TriggerExpression }
  | { fact: TriggerFact; op: TriggerOperator; value: Primitive };
export type EventFixture = { event: AgentEventKind; facts: Partial<Record<TriggerFact, Primitive>> };
export type ActivationDraft = {
  classification: "grounded" | "semantic_guarded" | "archival";
  subscriptions: AgentEventKind[];
  predicate?: TriggerExpression;
  semanticGuard?: { condition: string; abstainOnUnknown: true };
  delivery: "inject_once" | "warn" | "block_candidate" | "validate_candidate";
  lifecycle: {
    activateUntil: "event_complete" | "task_complete" | "session_complete" | "source_changes" | "explicit_revocation";
    rearmOn: AgentEventKind[];
  };
  examples: { positive: EventFixture[]; hardNegative: EventFixture[] };
};
export type EventFrame = {
  kind: AgentEventKind;
  sequence: number;
  sessionId: string;
  taskGeneration: number;
  contextEpoch: number;
  repository: string;
  toolCallId?: string;
  facts: Partial<Record<TriggerFact, Primitive>>;
};
export type CompiledRule = {
  memoryId: string;
  noteRevision: number;
  sourceSnapshotId: string;
  cacheKey: string;
  triggerDslVersion: typeof MEMORY_TRIGGER_DSL_VERSION;
  compilerVersion: typeof MEMORY_COMPILER_VERSION;
  classification: "grounded" | "semantic_guarded";
  subscriptions: AgentEventKind[];
  predicate: TriggerExpression;
  semanticGuard?: { condition: string; abstainOnUnknown: true };
  delivery: ActivationDraft["delivery"];
  lifecycle: ActivationDraft["lifecycle"];
};
export type TriggerResult = true | false | "unknown";

const EVENT_KINDS: readonly AgentEventKind[] = [
  "task_started",
  "before_tool_call",
  "after_tool_result",
  "context_compacted",
];
const FACTS: readonly TriggerFact[] = [
  "event.kind",
  "tool.name",
  "tool.command",
  "tool.exitCode",
  "tool.isError",
  "tool.errorSignature",
  "file.path",
  "task.phase",
  "attempt.count",
];
const OPERATORS: readonly TriggerOperator[] = ["eq", "neq", "contains", "startsWith", "matchesGlob", "gte"];
const DELIVERIES: readonly ActivationDraft["delivery"][] = [
  "inject_once",
  "warn",
  "block_candidate",
  "validate_candidate",
];
const ACTIVATION_UNTIL: readonly ActivationDraft["lifecycle"]["activateUntil"][] = [
  "event_complete",
  "task_complete",
  "session_complete",
  "source_changes",
  "explicit_revocation",
];
const EMPTY_RULES: readonly CompiledRule[] = Object.freeze([]);

const invalid = (): never => {
  throw Error("invalid activation draft");
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isRecord(value) && Object.keys(value).every(key => keys.includes(key));
const isPrimitive = (value: unknown): value is Primitive =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean";
const validString = (value: unknown): value is string => typeof value === "string" && value.length <= 500;
const validEvent = (value: unknown): value is AgentEventKind =>
  typeof value === "string" && EVENT_KINDS.includes(value as AgentEventKind);
const validFact = (value: unknown): value is TriggerFact =>
  typeof value === "string" && FACTS.includes(value as TriggerFact);
const validOperator = (value: unknown): value is TriggerOperator =>
  typeof value === "string" && OPERATORS.includes(value as TriggerOperator);

function parseEventList(value: unknown): AgentEventKind[] {
  if (!Array.isArray(value)) invalid();
  const list = value as unknown[];
  if (list.length > 16 || !list.every(validEvent)) invalid();
  return [...list] as AgentEventKind[];
}

function parseFacts(value: unknown): Partial<Record<TriggerFact, Primitive>> {
  if (!exactKeys(value, FACTS)) invalid();
  const input = value as Record<string, unknown>,
    facts: Partial<Record<TriggerFact, Primitive>> = {};
  for (const key of Object.keys(input)) {
    const fact = input[key];
    if (!isPrimitive(fact) || (typeof fact === "string" && !validString(fact))) invalid();
    facts[key as TriggerFact] = fact as Primitive;
  }
  return facts;
}

function parseExpression(value: unknown, state: { nodes: number }, depth: number): TriggerExpression {
  if (++state.nodes > 64 || depth > 8 || !isRecord(value)) invalid();
  const input = value as Record<string, unknown>;
  if ("all" in input) {
    if (!exactKeys(input, ["all"]) || Object.keys(input).length !== 1 || !Array.isArray(input.all)) invalid();
    const list = input.all as unknown[];
    if (list.length < 1 || list.length > 16) invalid();
    return { all: list.map(item => parseExpression(item, state, depth + 1)) };
  }
  if ("any" in input) {
    if (!exactKeys(input, ["any"]) || Object.keys(input).length !== 1 || !Array.isArray(input.any)) invalid();
    const list = input.any as unknown[];
    if (list.length < 1 || list.length > 16) invalid();
    return { any: list.map(item => parseExpression(item, state, depth + 1)) };
  }
  if ("not" in input) {
    if (!exactKeys(input, ["not"]) || Object.keys(input).length !== 1) invalid();
    return { not: parseExpression(input.not, state, depth + 1) };
  }
  if (
    !exactKeys(input, ["fact", "op", "value"]) ||
    !validFact(input.fact) ||
    !validOperator(input.op) ||
    !isPrimitive(input.value) ||
    (typeof input.value === "string" && !validString(input.value))
  )
    invalid();
  const fact = input.fact as TriggerFact,
    op = input.op as TriggerOperator,
    result = input.value as Primitive;
  if (op === "gte" && typeof result !== "number") invalid();
  if (
    (op === "contains" || op === "startsWith" || op === "matchesGlob") &&
    (typeof result !== "string" || !result.length)
  )
    invalid();
  return { fact, op, value: result };
}

function parseFixture(value: unknown): EventFixture {
  if (!exactKeys(value, ["event", "facts"])) invalid();
  const input = value as Record<string, unknown>;
  if (!validEvent(input.event)) invalid();
  const event = input.event as AgentEventKind,
    facts = parseFacts(input.facts);
  return { event, facts: { ...facts, "event.kind": event } };
}

function parseExamples(value: unknown, classification: ActivationDraft["classification"]): ActivationDraft["examples"] {
  if (!exactKeys(value, ["positive", "hardNegative"])) invalid();
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.positive) || !Array.isArray(input.hardNegative)) invalid();
  const positive = input.positive as unknown[],
    hardNegative = input.hardNegative as unknown[],
    minimum = classification === "archival" ? 0 : 1;
  if (positive.length < minimum || positive.length > 8 || hardNegative.length < minimum || hardNegative.length > 8)
    invalid();
  return { positive: positive.map(parseFixture), hardNegative: hardNegative.map(parseFixture) };
}

function parseLifecycle(value: unknown): ActivationDraft["lifecycle"] {
  if (!exactKeys(value, ["activateUntil", "rearmOn"])) invalid();
  const input = value as Record<string, unknown>;
  if (
    typeof input.activateUntil !== "string" ||
    !ACTIVATION_UNTIL.includes(input.activateUntil as ActivationDraft["lifecycle"]["activateUntil"])
  )
    invalid();
  return {
    activateUntil: input.activateUntil as ActivationDraft["lifecycle"]["activateUntil"],
    rearmOn: parseEventList(input.rearmOn),
  };
}

function cloneExpression(expression: TriggerExpression): TriggerExpression {
  if ("all" in expression) return { all: expression.all.map(cloneExpression) };
  if ("any" in expression) return { any: expression.any.map(cloneExpression) };
  if ("not" in expression) return { not: cloneExpression(expression.not) };
  return { fact: expression.fact, op: expression.op, value: expression.value };
}

function cloneDraft(draft: ActivationDraft): ActivationDraft {
  return {
    classification: draft.classification,
    subscriptions: [...draft.subscriptions],
    ...(draft.predicate ? { predicate: cloneExpression(draft.predicate) } : {}),
    ...(draft.semanticGuard
      ? { semanticGuard: { condition: draft.semanticGuard.condition, abstainOnUnknown: true } }
      : {}),
    delivery: draft.delivery,
    lifecycle: { activateUntil: draft.lifecycle.activateUntil, rearmOn: [...draft.lifecycle.rearmOn] },
    examples: {
      positive: draft.examples.positive.map(fixture => ({ event: fixture.event, facts: { ...fixture.facts } })),
      hardNegative: draft.examples.hardNegative.map(fixture => ({ event: fixture.event, facts: { ...fixture.facts } })),
    },
  };
}

export function validateActivationDraft(value: unknown): ActivationDraft {
  if (
    !exactKeys(value, [
      "classification",
      "subscriptions",
      "predicate",
      "semanticGuard",
      "delivery",
      "lifecycle",
      "examples",
    ])
  )
    invalid();
  const input = value as Record<string, unknown>,
    rawClassification = input.classification;
  if (rawClassification !== "grounded" && rawClassification !== "semantic_guarded" && rawClassification !== "archival")
    invalid();
  const classification = rawClassification as ActivationDraft["classification"];
  const subscriptions = parseEventList(input.subscriptions),
    examples = parseExamples(input.examples, classification),
    lifecycle = parseLifecycle(input.lifecycle);
  if (typeof input.delivery !== "string" || !DELIVERIES.includes(input.delivery as ActivationDraft["delivery"]))
    invalid();
  const predicate = input.predicate === undefined ? undefined : parseExpression(input.predicate, { nodes: 0 }, 1);
  let semanticGuard: ActivationDraft["semanticGuard"];
  if (input.semanticGuard !== undefined) {
    if (!exactKeys(input.semanticGuard, ["condition", "abstainOnUnknown"])) invalid();
    const guard = input.semanticGuard as Record<string, unknown>;
    if (!validString(guard.condition) || !guard.condition.length || guard.abstainOnUnknown !== true) invalid();
    semanticGuard = { condition: guard.condition as string, abstainOnUnknown: true };
  }
  if (classification === "archival") {
    if (subscriptions.length || predicate !== undefined || semanticGuard !== undefined) invalid();
  } else if (classification === "grounded") {
    if (!predicate || semanticGuard !== undefined) invalid();
  } else if (!predicate || !semanticGuard) invalid();
  for (const fixture of [...examples.positive, ...examples.hardNegative])
    if (!subscriptions.includes(fixture.event)) invalid();
  if (
    predicate &&
    (!examples.positive.every(fixture => evaluateTrigger(predicate, fixture) === true) ||
      !examples.hardNegative.every(fixture => evaluateTrigger(predicate, fixture) === false))
  )
    invalid();
  return cloneDraft({
    classification,
    subscriptions,
    ...(predicate ? { predicate } : {}),
    ...(semanticGuard ? { semanticGuard } : {}),
    delivery: input.delivery as ActivationDraft["delivery"],
    lifecycle,
    examples,
  });
}

function factValue(event: EventFrame | EventFixture, fact: TriggerFact): Primitive | undefined {
  if (fact === "event.kind") return "kind" in event ? event.kind : event.event;
  return event.facts[fact];
}

export function evaluateTrigger(expression: TriggerExpression, event: EventFrame | EventFixture): TriggerResult {
  if ("all" in expression) {
    let unknown = false;
    for (const item of expression.all) {
      const result = evaluateTrigger(item, event);
      if (result === false) return false;
      if (result === "unknown") unknown = true;
    }
    return unknown ? "unknown" : true;
  }
  if ("any" in expression) {
    let unknown = false;
    for (const item of expression.any) {
      const result = evaluateTrigger(item, event);
      if (result === true) return true;
      if (result === "unknown") unknown = true;
    }
    return unknown ? "unknown" : false;
  }
  if ("not" in expression) {
    const result = evaluateTrigger(expression.not, event);
    return result === "unknown" ? result : !result;
  }
  const actual = factValue(event, expression.fact);
  if (actual === undefined) return "unknown";
  if (expression.op === "eq") return actual === expression.value;
  if (expression.op === "neq") return actual !== expression.value;
  if (expression.op === "gte")
    return typeof actual === "number" && typeof expression.value === "number" && actual >= expression.value;
  if (typeof actual !== "string" || typeof expression.value !== "string") return false;
  if (expression.op === "contains") return actual.includes(expression.value);
  if (expression.op === "startsWith") return actual.startsWith(expression.value);
  try {
    return matchesGlob(actual, expression.value);
  } catch {
    return false;
  }
}

export function compileActivationDraft(
  memoryId: string,
  noteRevision: number,
  draft: ActivationDraft,
  sourceSnapshotId = "unspecified",
): CompiledRule | undefined {
  const validated = validateActivationDraft(draft);
  if (validated.classification === "archival") return undefined;
  return {
    memoryId,
    noteRevision,
    sourceSnapshotId,
    cacheKey: `${memoryId}:${noteRevision}:${sourceSnapshotId}:${MEMORY_TRIGGER_DSL_VERSION}:${MEMORY_COMPILER_VERSION}`,
    triggerDslVersion: MEMORY_TRIGGER_DSL_VERSION,
    compilerVersion: MEMORY_COMPILER_VERSION,
    classification: validated.classification,
    subscriptions: [...validated.subscriptions],
    predicate: cloneExpression(validated.predicate!),
    ...(validated.semanticGuard
      ? { semanticGuard: { condition: validated.semanticGuard.condition, abstainOnUnknown: true } }
      : {}),
    delivery: validated.delivery,
    lifecycle: { activateUntil: validated.lifecycle.activateUntil, rearmOn: [...validated.lifecycle.rearmOn] },
  };
}

export function buildRuleIndex(rules: readonly CompiledRule[]): ReadonlyMap<AgentEventKind, readonly CompiledRule[]> {
  const indexed = new Map<AgentEventKind, CompiledRule[]>();
  const ordered = [...rules].sort(
    (left, right) => left.memoryId.localeCompare(right.memoryId) || left.noteRevision - right.noteRevision,
  );
  for (const rule of ordered)
    for (const subscription of rule.subscriptions) {
      const entries = indexed.get(subscription) ?? [];
      if (!entries.some(entry => entry.memoryId === rule.memoryId && entry.noteRevision === rule.noteRevision))
        entries.push(rule);
      indexed.set(subscription, entries);
    }
  return new Map([...indexed].map(([kind, entries]) => [kind, Object.freeze(entries)]));
}

export function candidateRules(
  index: ReadonlyMap<AgentEventKind, readonly CompiledRule[]>,
  event: EventFrame,
): readonly CompiledRule[] {
  return index.get(event.kind) ?? EMPTY_RULES;
}

export function evaluateCompiledRule(rule: CompiledRule, event: EventFrame): TriggerResult {
  const deterministic = evaluateTrigger(rule.predicate, event);
  return rule.classification === "semantic_guarded" && deterministic === true ? "unknown" : deterministic;
}
