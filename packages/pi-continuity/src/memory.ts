import { createHash, randomUUID } from "node:crypto";
import { assertSafe } from "./secrets.ts";

export const MEMORY_SCHEMA_VERSION = 4 as const;
export type Scope = "user" | "project";
export type Evidence = { path: string; sha256: string };
export type FactStatus = "active" | "suspect" | "unverifiable" | "unchecked";
export type Fact = {
  key: string;
  kind: "workflow" | "structure" | "architecture" | "warning" | "preference";
  text: string;
  source: string;
  confidence: number;
  updatedAt: string;
  scope?: Scope;
  owner?: string;
  captureCommit?: string;
  branchAtCapture?: string;
  evidencePaths?: Evidence[];
};
export type PendingCandidate = {
  id: string;
  action: "add" | "replace" | "remove";
  key: string;
  createdAt: string;
  updatedAt: string;
  scope: Scope;
  owner: string;
  text?: string;
  kind?: Fact["kind"];
  /** Required for every action, including removal, to preserve an audit reason. */
  source: string;
  confidence?: number;
  captureCommit?: string;
  branchAtCapture?: string;
  evidencePaths?: Evidence[];
};
export type MemoryFile = { schemaVersion: 4; facts: Fact[]; updatedAt?: string };
export type CandidatesFile = { schemaVersion: 4; candidates: PendingCandidate[] };
export type CandidateInput = {
  key?: string;
  kind?: Fact["kind"];
  text?: string;
  source?: string;
  confidence?: number;
  action?: PendingCandidate["action"];
  scope?: Scope;
};
export type CandidateContext = {
  owner?: string;
  scope?: Scope;
  captureCommit?: string;
  branchAtCapture?: string;
  evidencePaths?: Evidence[];
};

const kinds = new Set(["workflow", "structure", "architecture", "warning", "preference"]);
const scopes = new Set(["user", "project"]);
const actions = new Set(["add", "replace", "remove"]);
const validText = (value: unknown, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;
const validTimestamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const validCommit = (value: unknown) =>
  value === undefined || (typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value));
const validBranch = (value: unknown) =>
  value === undefined || (typeof value === "string" && value.length <= 240);
const safeStrings = (...values: string[]) => {
  try { assertSafe(...values); return true; } catch { return false; }
};
const validEvidence = (value: any) => value === undefined || (
  Array.isArray(value) && value.length <= 5 && value.every((entry) =>
    entry && typeof entry.path === "string" && entry.path.length > 0 && entry.path.length <= 240 &&
    !entry.path.startsWith("/") && !entry.path.includes("..") &&
    typeof entry.sha256 === "string" && /^[0-9a-f]{64}$/.test(entry.sha256) &&
    safeStrings(entry.path)
  )
);
const derivedKey = (text: string) =>
  `memory.${createHash("sha256").update(text.trim()).digest("hex").slice(0, 16)}`;

export function isFact(value: any): value is Fact {
  return value && validText(value.key, 200) && kinds.has(value.kind) &&
    validText(value.text, 1000) && validText(value.source, 500) &&
    typeof value.confidence === "number" && value.confidence >= 0 && value.confidence <= 1 &&
    validTimestamp(value.updatedAt) && scopes.has(value.scope) && validText(value.owner, 200) &&
    validCommit(value.captureCommit) && validBranch(value.branchAtCapture) &&
    validEvidence(value.evidencePaths) && safeStrings(value.key, value.text, value.source);
}
function isCandidate(value: any): value is PendingCandidate {
  if (!value || !validText(value.id, 200) || !actions.has(value.action) ||
    !scopes.has(value.scope) || !validText(value.owner, 200) || !validText(value.key, 200) ||
    !validText(value.source, 500) || !validTimestamp(value.createdAt) || !validTimestamp(value.updatedAt) ||
    !validCommit(value.captureCommit) || !validBranch(value.branchAtCapture) || !validEvidence(value.evidencePaths)) return false;
  if (value.action === "remove") return safeStrings(value.key, value.source);
  return kinds.has(value.kind) && validText(value.text, 1000) &&
    typeof value.confidence === "number" && value.confidence >= 0 && value.confidence <= 1 &&
    safeStrings(value.key, value.text, value.source);
}

/** Drops malformed V4 records without sacrificing the rest of the file. */
export function normalizeMemoryFile(value: any): MemoryFile | undefined {
  if (value?.schemaVersion !== MEMORY_SCHEMA_VERSION || !Array.isArray(value.facts)) return;
  return { schemaVersion: MEMORY_SCHEMA_VERSION, facts: value.facts.filter(isFact), ...(typeof value.updatedAt === "string" ? { updatedAt: value.updatedAt } : {}) };
}
export function normalizeCandidatesFile(value: any): CandidatesFile | undefined {
  if (value?.schemaVersion !== MEMORY_SCHEMA_VERSION || !Array.isArray(value.candidates)) return;
  return { schemaVersion: MEMORY_SCHEMA_VERSION, candidates: value.candidates.filter(isCandidate) };
}
export const isCandidatesFile = (value: any): value is CandidatesFile => normalizeCandidatesFile(value) !== undefined;
export const isMemoryFile = (value: any): value is MemoryFile => normalizeMemoryFile(value) !== undefined;

/** Creates a V4 candidate. Ownership, provenance, and evidence only come from context. */
export function candidate(input: CandidateInput, context: CandidateContext = {}): PendingCandidate {
  const action = input.action ?? "add", text = input.text?.trim(), source = input.source?.trim() || (input.action === "remove" ? "" : "continuity candidate");
  if (!actions.has(action)) throw Error("invalid memory action");
  if ((action === "replace" || action === "remove") && !input.key?.trim())
    throw Error("memory replace/remove requires a key");
  if (action !== "remove" && !text) throw Error(`memory ${action} requires text`);
  if (!source) throw Error("memory remove requires nonempty source/reason evidence");
  const key = input.key?.trim() || derivedKey(text!);
  const scope = input.scope ?? context.scope ?? "project";
  if (!scopes.has(scope)) throw Error("invalid memory scope");
  if (!validText(key, 200) || (action !== "remove" && !validText(text, 1000)) || !validText(source, 500))
    throw Error("memory candidate exceeds field limits");
  if (scope === "user" && context.evidencePaths?.length) throw Error("user memory cannot capture project evidence");
  const now = new Date().toISOString();
  if (action === "remove") {
    assertSafe(key, source);
    return {
      id: randomUUID(), action, key, source, scope, owner: context.owner ?? "default", createdAt: now, updatedAt: now,
      ...(context.captureCommit ? { captureCommit: context.captureCommit } : {}),
      ...(context.branchAtCapture ? { branchAtCapture: context.branchAtCapture } : {}),
      ...(context.evidencePaths?.length ? { evidencePaths: context.evidencePaths.slice(0, 5) } : {}),
    };
  }
  const kind = input.kind ?? "workflow", confidence = input.confidence ?? 0.5;
  if (!kinds.has(kind) || confidence < 0 || confidence > 1 ||
    !validText(context.owner ?? "default", 200) || !validCommit(context.captureCommit) ||
    !validBranch(context.branchAtCapture) || !validEvidence(context.evidencePaths)) throw Error("invalid memory candidate");
  assertSafe(key, text!, source);
  return {
    id: randomUUID(), action, key, kind, text, source, confidence, scope,
    owner: context.owner ?? "default", createdAt: now, updatedAt: now,
    ...(context.captureCommit ? { captureCommit: context.captureCommit } : {}),
    ...(context.branchAtCapture ? { branchAtCapture: context.branchAtCapture } : {}),
    ...(context.evidencePaths?.length ? { evidencePaths: context.evidencePaths.slice(0, 5) } : {}),
  };
}

export function factsForOwners(facts: Fact[], projectOwner: string) {
  return facts.filter((fact) =>
    (fact.scope === "user" && fact.owner === "default") ||
    (fact.scope === "project" && fact.owner === projectOwner)
  );
}

const retentionPriority = (fact: Fact) => fact.kind === "preference" ? 2 : fact.kind === "warning" ? 1 : 0;
export const factIdentity = (item: Pick<Fact, "scope" | "owner" | "key">) =>
  `${item.scope ?? "project"}\0${item.owner ?? "default"}\0${item.key}`;
const ownerIdentity = (item: Pick<Fact, "scope" | "owner">) => `${item.scope ?? "project"}\0${item.owner ?? "default"}`;
const applicabilityRank: Record<FactStatus, number> = { active: 3, unchecked: 2, unverifiable: 1, suspect: 0 };

/** Keeps at most max facts for global user memory and independently for each project. */
export function compact(
  facts: Fact[], candidates: PendingCandidate[], max = 30,
  applicability: ReadonlyMap<string, FactStatus> | Record<string, FactStatus> = new Map(),
) {
  const statusFor = (fact: Fact): FactStatus | undefined => {
    const key = factIdentity(fact), map = applicability as ReadonlyMap<string, FactStatus>;
    return typeof map.get === "function" ? map.get(key) : (applicability as Record<string, FactStatus>)[key];
  };
  const keyed = new Map(facts.map((fact) => [factIdentity(fact), fact]));
  for (const item of candidates) {
    const id = factIdentity(item);
    if (item.action === "remove") keyed.delete(id);
    else keyed.set(id, {
      key: item.key, kind: item.kind!, text: item.text!, source: item.source!, confidence: item.confidence!,
      updatedAt: new Date().toISOString(), scope: item.scope, owner: item.owner,
      ...(item.captureCommit ? { captureCommit: item.captureCommit } : {}),
      ...(item.branchAtCapture ? { branchAtCapture: item.branchAtCapture } : {}),
      ...(item.evidencePaths?.length ? { evidencePaths: item.evidencePaths } : {}),
    });
  }
  const counts = new Map<string, number>(), kept = [...keyed.values()]
    .sort((a, b) => (applicabilityRank[statusFor(b) ?? "unchecked"] - applicabilityRank[statusFor(a) ?? "unchecked"]) ||
      retentionPriority(b) - retentionPriority(a) || b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt))
    .filter((fact) => {
      const owner = ownerIdentity(fact), count = counts.get(owner) ?? 0;
      if (count >= max) return false;
      counts.set(owner, count + 1);
      return true;
    });
  return { facts: kept, candidates: [] as PendingCandidate[] };
}
