import { createHash, randomUUID } from "node:crypto";
import { assertSafe } from "./secrets.ts";
import { serializedJson } from "./storage.ts";

export const MEMORY_SCHEMA_VERSION = 5 as const;
export const MEMORY_MAX_NOTES_PER_OWNER = 1_000;
export const MEMORY_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MEMORY_MAX_REVIEWS = 200;
export type MemoryScope = "user" | "project";
export type Scope = MemoryScope;
export type MemoryAuthority = "user_instruction" | "project_contract" | "imported";
export type MemoryOrigin = "user" | "agent" | "migration";

export type MemorySourceRef =
  | { type: "user_message"; sessionId: string; entryId: string; quoteSha256: string }
  | { type: "repository"; path: string; excerptSha256: string; captureCommit?: string }
  | { type: "direct_user_edit" }
  | { type: "migration"; legacyKey: string; captureCommit?: string };

export type NotebookNote = {
  id: string;
  scope: MemoryScope;
  owner: string;
  trigger: string;
  guidance: string;
  authority: MemoryAuthority;
  origin: MemoryOrigin;
  sourceRefs: MemorySourceRef[];
  relatedPaths?: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  sourceReviewId?: string;
};

export type EvidenceRange = { path: string; start: number; end: number };
export type ProposalBasis =
  | { type: "user_instruction"; quote: string }
  | { type: "project_contract"; evidence: EvidenceRange[] };
export type MemoryProposal =
  | { operation: "add"; scope: MemoryScope; trigger: string; guidance: string; basis: ProposalBasis }
  | { operation: "replace"; scope: MemoryScope; targetId: string; expectedRevision: number; trigger: string; guidance: string; basis: ProposalBasis }
  | { operation: "remove"; scope: MemoryScope; targetId: string; expectedRevision: number; reason: string; basis: ProposalBasis };

export type ReviewerDecision =
  | { proposalIndex: number; verdict: "accept"; operation: "add" | "replace"; trigger: string; guidance: string; authority: Exclude<MemoryAuthority, "imported">; reasonCode: "durable_rule" }
  | { proposalIndex: number; verdict: "accept"; operation: "remove"; targetId: string; expectedRevision: number; reasonCode: "revoked_rule" | "contradicted_rule" }
  | { proposalIndex: number; verdict: "rewrite"; operation: "add" | "replace"; trigger: string; guidance: string; authority: Exclude<MemoryAuthority, "imported">; reasonCode: "normalized_rule" }
  | { proposalIndex: number; verdict: "merge"; operation: "add" | "replace"; targetId: string; expectedRevision: number; trigger: string; guidance: string; authority: Exclude<MemoryAuthority, "imported">; reasonCode: "existing_rule" }
  | { proposalIndex: number; verdict: "reject"; reasonCode: "not_durable" | "descriptive_only" | "task_local" | "speculative" | "unsupported" | "duplicate" | "wrong_scope" | "conflict" | "unsafe" };
export type ReviewerOutput = { version: 1; decisions: ReviewerDecision[] };

export type ReviewedOperation =
  | { operation: "add"; noteId: string; scope: MemoryScope; owner: string; trigger: string; guidance: string; authority: Exclude<MemoryAuthority, "imported">; sourceRefs: MemorySourceRef[]; relatedPaths?: string[] }
  | { operation: "replace"; targetId: string; expectedRevision: number; trigger: string; guidance: string; authority: Exclude<MemoryAuthority, "imported">; sourceRefs: MemorySourceRef[]; relatedPaths?: string[] }
  | { operation: "remove"; targetId: string; expectedRevision: number };
export type ReviewRecord = {
  reviewId: string;
  sessionId: string;
  toolCallId: string;
  projectOwner: string;
  reviewedAt: string;
  status: "approved_pending" | "committed" | "discarded";
  requiresVerification: boolean;
  verificationRevision?: string;
  operations: ReviewedOperation[];
  rejectionCounts: Record<string, number>;
  settledAt?: string;
  discardReason?: string;
  generation: number;
  taskGeneration: number;
  worktreeIdentity?: string;
  evidenceBatches?: Array<Array<{ path: string; start: number; end: number; excerptSha256: string }>>;
  quoteRefs?: Array<{ entryId: string; entrySha256: string; quoteSha256: string }>;
};
export type MemoryAuditEvent =
  | { type: "direct_delete"; noteId: string; scope: MemoryScope; owner: string; at: string }
  | { type: "direct_edit"; noteId: string; scope: MemoryScope; owner: string; at: string; previousSourceRefs: MemorySourceRef[]; previousSourceReviewId?: string }
  | { type: "owner_reassociation"; migrationId: string; oldOwner: string; owner: string; at: string; movedNoteIds: string[]; suppressedNoteIds: string[]; fromRevision: number };
export type MemoryStateFile = {
  schemaVersion: 5;
  revision: number;
  notes: NotebookNote[];
  reviews: ReviewRecord[];
  updatedAt: string;
  audits?: MemoryAuditEvent[];
};

const scopes = new Set<MemoryScope>(["user", "project"]);
const authorities = new Set<MemoryAuthority>(["user_instruction", "project_contract", "imported"]);
const origins = new Set<MemoryOrigin>(["user", "agent", "migration"]);
const reviewStatuses = new Set(["approved_pending", "committed", "discarded"]);
const rejectReasons = new Set(["not_durable", "descriptive_only", "task_local", "speculative", "unsupported", "duplicate", "wrong_scope", "conflict", "unsafe"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40,64}$/;
const timestamp = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const integer = (value: unknown, minimum = 0) => Number.isSafeInteger(value) && Number(value) >= minimum;
const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
const safeRelativePath = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 240 && !value.startsWith("/") && !value.startsWith("\\") && !/^[a-z]:/i.test(value) && !value.split(/[\\/]+/).some((part) => !part || part === "." || part === "..");
const exactKeys = (value: any, allowed: readonly string[]) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));
const safe = (...values: string[]) => { try { assertSafe(...values); return true; } catch { return false; } };
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const normalizeRuleText = (value: string) => value.trim().replace(/\s+/g, " ");
export const semanticIdentity = (trigger: string, guidance: string) => `${normalizeRuleText(trigger).toLowerCase()}\0${normalizeRuleText(guidance).toLowerCase()}`;
export const noteIdentity = (note: Pick<NotebookNote, "scope" | "owner" | "trigger" | "guidance">) => `${note.scope}\0${note.owner}\0${semanticIdentity(note.trigger, note.guidance)}`;

function sourceRef(value: any): value is MemorySourceRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.type === "user_message") return exactKeys(value, ["type", "sessionId", "entryId", "quoteSha256"]) && text(value.sessionId, 200) && text(value.entryId, 200) && hash.test(value.quoteSha256) && safe(value.sessionId, value.entryId);
  if (value.type === "repository") return exactKeys(value, ["type", "path", "excerptSha256", "captureCommit"]) && safeRelativePath(value.path) && hash.test(value.excerptSha256) && (value.captureCommit === undefined || commit.test(value.captureCommit)) && safe(value.path);
  if (value.type === "direct_user_edit") return exactKeys(value, ["type"]);
  if (value.type === "migration") return exactKeys(value, ["type", "legacyKey", "captureCommit"]) && text(value.legacyKey, 200) && safe(value.legacyKey)
    && (value.captureCommit === undefined || commit.test(value.captureCommit));
  return false;
}

export function isNotebookNote(value: any): value is NotebookNote {
  return exactKeys(value, ["id", "scope", "owner", "trigger", "guidance", "authority", "origin", "sourceRefs", "relatedPaths", "revision", "createdAt", "updatedAt", "sourceReviewId"])
    && uuid.test(value.id) && scopes.has(value.scope) && text(value.owner, 200) && (value.scope !== "user" || value.owner === "default")
    && text(value.trigger, 240) && text(value.guidance, 800) && value.trigger.trim().length + value.guidance.trim().length <= 1_000
    && authorities.has(value.authority) && origins.has(value.origin)
    && Array.isArray(value.sourceRefs) && value.sourceRefs.length <= 5 && value.sourceRefs.every(sourceRef)
    && (value.relatedPaths === undefined || Array.isArray(value.relatedPaths) && value.relatedPaths.length <= 5 && value.relatedPaths.every(safeRelativePath))
    && integer(value.revision, 1) && timestamp(value.createdAt) && timestamp(value.updatedAt)
    && (value.sourceReviewId === undefined || uuid.test(value.sourceReviewId))
    && safe(value.trigger, value.guidance, ...(value.relatedPaths ?? []));
}

function reviewedOperation(value: any): value is ReviewedOperation {
  if (!value || typeof value !== "object") return false;
  if (value.operation === "remove") return exactKeys(value, ["operation", "targetId", "expectedRevision"]) && uuid.test(value.targetId) && integer(value.expectedRevision, 1);
  const common = exactKeys(value, value.operation === "add"
    ? ["operation", "noteId", "scope", "owner", "trigger", "guidance", "authority", "sourceRefs", "relatedPaths"]
    : ["operation", "targetId", "expectedRevision", "trigger", "guidance", "authority", "sourceRefs", "relatedPaths"])
    && text(value.trigger, 240) && text(value.guidance, 800) && value.trigger.trim().length + value.guidance.trim().length <= 1_000
    && (value.authority === "user_instruction" || value.authority === "project_contract")
    && Array.isArray(value.sourceRefs) && value.sourceRefs.length <= 5 && value.sourceRefs.every(sourceRef)
    && (value.relatedPaths === undefined || Array.isArray(value.relatedPaths) && value.relatedPaths.length <= 5 && value.relatedPaths.every(safeRelativePath));
  if (!common || !safe(value.trigger, value.guidance, ...(value.relatedPaths ?? []))) return false;
  if (value.operation === "add") return uuid.test(value.noteId) && scopes.has(value.scope) && text(value.owner, 200) && (value.scope !== "user" || value.owner === "default");
  return value.operation === "replace" && uuid.test(value.targetId) && integer(value.expectedRevision, 1);
}

export function isReviewRecord(value: any): value is ReviewRecord {
  return exactKeys(value, ["reviewId", "sessionId", "toolCallId", "projectOwner", "reviewedAt", "status", "requiresVerification", "verificationRevision", "operations", "rejectionCounts", "settledAt", "discardReason", "generation", "taskGeneration", "worktreeIdentity", "evidenceBatches", "quoteRefs"])
    && uuid.test(value.reviewId) && text(value.sessionId, 200) && text(value.toolCallId, 200) && text(value.projectOwner, 200)
    && timestamp(value.reviewedAt) && reviewStatuses.has(value.status) && typeof value.requiresVerification === "boolean"
    && (value.verificationRevision === undefined || text(value.verificationRevision, 500))
    && Array.isArray(value.operations) && value.operations.length <= 2 && value.operations.every(reviewedOperation)
    && value.rejectionCounts && typeof value.rejectionCounts === "object" && !Array.isArray(value.rejectionCounts)
    && Object.entries(value.rejectionCounts).every(([key, count]) => text(key, 60) && integer(count))
    && (value.settledAt === undefined || timestamp(value.settledAt)) && (value.discardReason === undefined || text(value.discardReason, 240))
    && integer(value.generation) && integer(value.taskGeneration) && (value.worktreeIdentity === undefined || /^[0-9a-f]{16}$/.test(value.worktreeIdentity))
    && (value.evidenceBatches === undefined || Array.isArray(value.evidenceBatches) && value.evidenceBatches.length <= 2 && value.evidenceBatches.every((batch: any) => Array.isArray(batch) && batch.length <= 3 && batch.every((range: any) => exactKeys(range, ["path", "start", "end", "excerptSha256"]) && safeRelativePath(range.path) && integer(range.start, 1) && integer(range.end, range.start) && hash.test(range.excerptSha256))))
    && (value.quoteRefs === undefined || Array.isArray(value.quoteRefs) && value.quoteRefs.length <= 2 && value.quoteRefs.every((ref: any) => exactKeys(ref, ["entryId", "entrySha256", "quoteSha256"]) && text(ref.entryId, 200) && hash.test(ref.entrySha256) && hash.test(ref.quoteSha256)));
}

function auditEvent(value: any): value is MemoryAuditEvent {
  if (value?.type === "owner_reassociation") return exactKeys(value, ["type", "migrationId", "oldOwner", "owner", "at", "movedNoteIds", "suppressedNoteIds", "fromRevision"])
    && uuid.test(value.migrationId) && text(value.oldOwner, 200) && text(value.owner, 200) && timestamp(value.at) && integer(value.fromRevision)
    && Array.isArray(value.movedNoteIds) && value.movedNoteIds.length <= 100 && value.movedNoteIds.every((id: unknown) => typeof id === "string" && uuid.test(id))
    && Array.isArray(value.suppressedNoteIds) && value.suppressedNoteIds.length <= 100 && value.suppressedNoteIds.every((id: unknown) => typeof id === "string" && uuid.test(id));
  const common = value && uuid.test(value.noteId) && scopes.has(value.scope) && text(value.owner, 200) && timestamp(value.at);
  if (value?.type === "direct_delete") return exactKeys(value, ["type", "noteId", "scope", "owner", "at"]) && common;
  return value?.type === "direct_edit" && exactKeys(value, ["type", "noteId", "scope", "owner", "at", "previousSourceRefs", "previousSourceReviewId"]) && common
    && Array.isArray(value.previousSourceRefs) && value.previousSourceRefs.length <= 5 && value.previousSourceRefs.every(sourceRef)
    && (value.previousSourceReviewId === undefined || uuid.test(value.previousSourceReviewId));
}

export const emptyMemoryState = (): MemoryStateFile => ({ schemaVersion: 5, revision: 0, notes: [], reviews: [], updatedAt: new Date(0).toISOString() });
export function normalizeMemoryState(value: any): MemoryStateFile | undefined {
  if (!exactKeys(value, ["schemaVersion", "revision", "notes", "reviews", "updatedAt", "audits"]) || value.schemaVersion !== 5
    || !integer(value.revision) || !Array.isArray(value.notes) || !value.notes.every(isNotebookNote)
    || !Array.isArray(value.reviews) || value.reviews.length > MEMORY_MAX_REVIEWS || !value.reviews.every(isReviewRecord)
    || !timestamp(value.updatedAt) || (value.audits !== undefined && (!Array.isArray(value.audits) || value.audits.length > 100 || !value.audits.every(auditEvent)))) return;
  const ids = new Set<string>(), reviewIds = new Set<string>();
  for (const note of value.notes) if (ids.has(note.id)) return; else ids.add(note.id);
  for (const review of value.reviews) if (reviewIds.has(review.reviewId)) return; else reviewIds.add(review.reviewId);
  try { enforceMemoryLimits(value); } catch { return; }
  return value;
}
export const isMemoryState = (value: any): value is MemoryStateFile => normalizeMemoryState(value) !== undefined;

function evidenceRange(value: any): value is EvidenceRange {
  return exactKeys(value, ["path", "start", "end"]) && safeRelativePath(value.path) && integer(value.start, 1) && integer(value.end, 1) && value.end >= value.start;
}
function proposalBasis(value: any): value is ProposalBasis {
  return value?.type === "user_instruction"
    ? exactKeys(value, ["type", "quote"]) && text(value.quote, 2_000) && safe(value.quote)
    : value?.type === "project_contract" && exactKeys(value, ["type", "evidence"]) && Array.isArray(value.evidence) && value.evidence.length > 0 && value.evidence.length <= 3 && value.evidence.every(evidenceRange);
}
function normalizeProposal(value: any): MemoryProposal {
  if (!value || typeof value !== "object" || !scopes.has(value.scope) || !proposalBasis(value.basis)) throw Error("invalid memory proposal");
  if (value.scope === "user" && value.basis.type !== "user_instruction") throw Error("user memory requires a user instruction");
  if (value.operation === "remove") {
    if (!exactKeys(value, ["operation", "scope", "targetId", "expectedRevision", "reason", "basis"]) || !uuid.test(value.targetId) || !integer(value.expectedRevision, 1) || !text(value.reason, 500)) throw Error("invalid memory remove proposal");
    return { ...value, reason: value.reason.trim(), basis: normalizeBasis(value.basis) };
  }
  if (value.operation !== "add" && value.operation !== "replace") throw Error("invalid memory proposal operation");
  const keys = value.operation === "add" ? ["operation", "scope", "trigger", "guidance", "basis"] : ["operation", "scope", "targetId", "expectedRevision", "trigger", "guidance", "basis"];
  if (!exactKeys(value, keys) || !text(value.trigger, 240) || !text(value.guidance, 800)) throw Error(`invalid memory ${value.operation} proposal`);
  const trigger = normalizeRuleText(value.trigger), guidance = normalizeRuleText(value.guidance);
  if (trigger.length + guidance.length > 1_000 || !safe(trigger, guidance)) throw Error("memory proposal exceeds safety limits");
  if (value.operation === "replace" && (!uuid.test(value.targetId) || !integer(value.expectedRevision, 1))) throw Error("invalid memory replacement target");
  return { ...value, trigger, guidance, basis: normalizeBasis(value.basis) };
}
function normalizeBasis(basis: ProposalBasis): ProposalBasis {
  return basis.type === "user_instruction"
    ? { type: "user_instruction", quote: basis.quote.trim() }
    : { type: "project_contract", evidence: basis.evidence.map((range) => ({ ...range, path: range.path.replace(/\\/g, "/") })) };
}
export function normalizeProposalBatch(value: unknown): MemoryProposal[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) throw Error("memory propose requires one or two proposals");
  return value.map(normalizeProposal);
}

function parseDecision(value: any): ReviewerDecision | undefined {
  if (!value || !integer(value.proposalIndex)) return;
  if (value.verdict === "reject") return exactKeys(value, ["proposalIndex", "verdict", "reasonCode"]) && rejectReasons.has(value.reasonCode) ? value : undefined;
  if (value.verdict === "accept" && value.operation === "remove") return exactKeys(value, ["proposalIndex", "verdict", "operation", "targetId", "expectedRevision", "reasonCode"])
    && uuid.test(value.targetId) && integer(value.expectedRevision, 1) && (value.reasonCode === "revoked_rule" || value.reasonCode === "contradicted_rule") ? value : undefined;
  if (value.verdict === "merge") {
    if (!exactKeys(value, ["proposalIndex", "verdict", "operation", "targetId", "expectedRevision", "trigger", "guidance", "authority", "reasonCode"]) || !["add", "replace"].includes(value.operation)
      || !uuid.test(value.targetId) || !integer(value.expectedRevision, 1) || value.reasonCode !== "existing_rule") return;
  } else if (value.verdict === "accept" || value.verdict === "rewrite") {
    if (!exactKeys(value, ["proposalIndex", "verdict", "operation", "trigger", "guidance", "authority", "reasonCode"]) || !["add", "replace"].includes(value.operation)
      || value.reasonCode !== (value.verdict === "accept" ? "durable_rule" : "normalized_rule")) return;
  } else return;
  if (!text(value.trigger, 240) || !text(value.guidance, 800) || value.trigger.trim().length + value.guidance.trim().length > 1_000
    || (value.authority !== "user_instruction" && value.authority !== "project_contract") || !safe(value.trigger, value.guidance)) return;
  return { ...value, trigger: normalizeRuleText(value.trigger), guidance: normalizeRuleText(value.guidance) };
}
export function parseReviewerOutput(raw: string, proposalCount: number): ReviewerOutput {
  let value: any;
  try { value = JSON.parse(raw); } catch { throw Error("memory reviewer returned malformed JSON"); }
  if (!exactKeys(value, ["version", "decisions"]) || value.version !== 1 || !Array.isArray(value.decisions) || value.decisions.length !== proposalCount) {
    const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const version = !object || !("version" in object) ? "missing" : object.version === 1 ? "ok" : "invalid";
    const decisions = !object || !("decisions" in object) ? "missing" : Array.isArray(object.decisions) ? `count:${object.decisions.length}` : "not-array";
    const unexpectedFields = object ? Object.keys(object).filter((key) => key !== "version" && key !== "decisions").length : 0;
    throw Error(`memory reviewer returned an invalid envelope (version:${version}; decisions:${decisions}; unexpected-fields:${unexpectedFields})`);
  }
  const decisions = value.decisions.map(parseDecision);
  const invalidIndexes = decisions.flatMap((item: ReviewerDecision | undefined, index: number) => item ? [] : [index]);
  if (invalidIndexes.length) throw Error(`memory reviewer returned invalid decisions (count:${invalidIndexes.length}; first-output-indexes:${invalidIndexes.slice(0, 10).join(",")})`);
  const indexes = new Set<number>(decisions.map((item: ReviewerDecision) => item.proposalIndex));
  if (indexes.size !== proposalCount || [...indexes].some((index) => index < 0 || index >= proposalCount)) throw Error("memory reviewer returned duplicate or unknown proposal indexes");
  return { version: 1, decisions: decisions as ReviewerDecision[] };
}

export function notesForOwners(notes: NotebookNote[], projectOwner: string) {
  return notes.filter((note) => note.scope === "user" ? note.owner === "default" : note.owner === projectOwner);
}
export function exactDuplicate(notes: NotebookNote[], scope: MemoryScope, owner: string, trigger: string, guidance: string, excludeId?: string) {
  const identity = semanticIdentity(trigger, guidance);
  return notes.find((note) => note.id !== excludeId && note.scope === scope && note.owner === owner && semanticIdentity(note.trigger, note.guidance) === identity);
}
const duplicateWords = (value: string) => new Set((normalizeRuleText(value).toLowerCase().match(/[a-z0-9_-]{3,}/g) ?? []).filter((word) => !new Set(["when", "then", "that", "this", "with", "from", "into", "after", "before", "because", "should"]).has(word)));
export function strongDuplicate(notes: NotebookNote[], scope: MemoryScope, owner: string, trigger: string, guidance: string, excludeId?: string) {
  const proposed = duplicateWords(`${trigger} ${guidance}`);
  if (proposed.size < 4) return exactDuplicate(notes, scope, owner, trigger, guidance, excludeId);
  return notes.find((note) => {
    if (note.id === excludeId || note.scope !== scope || note.owner !== owner) return false;
    const existing = duplicateWords(`${note.trigger} ${note.guidance}`), intersection = [...proposed].filter((word) => existing.has(word)).length;
    return intersection / Math.max(proposed.size, existing.size) >= 0.8;
  });
}
export function enforceMemoryLimits(state: MemoryStateFile): void {
  const counts = new Map<string, number>();
  for (const note of state.notes) {
    const owner = `${note.scope}\0${note.owner}`, count = (counts.get(owner) ?? 0) + 1;
    if (count > MEMORY_MAX_NOTES_PER_OWNER) throw Error("memory owner exceeds 1,000-note safety ceiling");
    counts.set(owner, count);
  }
  if (Buffer.byteLength(serializedJson(state), "utf8") > MEMORY_MAX_FILE_BYTES) throw Error("memory notebook exceeds 2 MiB safety ceiling");
}
export const renderNote = (note: Pick<NotebookNote, "trigger" | "guidance">) => `Memory: When ${normalizeRuleText(note.trigger).replace(/[.!?]+$/, "")}, ${normalizeRuleText(note.guidance)}`;

function boundedReviews(reviews: ReviewRecord[]) {
  const pending = reviews.filter((item) => item.status === "approved_pending");
  if (pending.length > MEMORY_MAX_REVIEWS) throw Error("memory review ledger is full of pending operations");
  const terminal = reviews.filter((item) => item.status !== "approved_pending").slice(-(MEMORY_MAX_REVIEWS - pending.length));
  return [...pending, ...terminal].sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
}
export function applyReview(state: MemoryStateFile, review: ReviewRecord, now = new Date().toISOString()): MemoryStateFile {
  if (state.reviews.some((item) => item.reviewId === review.reviewId && item.status === "committed")) return state;
  const stored = state.reviews.find((item) => item.reviewId === review.reviewId);
  if (!stored || stored.status !== "approved_pending" || stored.sessionId !== review.sessionId || stored.toolCallId !== review.toolCallId) throw Error("memory review is not pending in this state");
  const notes = [...state.notes];
  for (const operation of review.operations) {
    if (operation.operation === "add") {
      if (!((operation.scope === "user" && operation.owner === "default") || (operation.scope === "project" && operation.owner === review.projectOwner))) throw Error("memory review add crosses owner boundary");
      if (strongDuplicate(notes, operation.scope, operation.owner, operation.trigger, operation.guidance)) throw Error("memory review conflicts with an existing rule");
      notes.push({ id: operation.noteId, scope: operation.scope, owner: operation.owner, trigger: operation.trigger, guidance: operation.guidance, authority: operation.authority, origin: "agent", sourceRefs: operation.sourceRefs, ...(operation.relatedPaths?.length ? { relatedPaths: operation.relatedPaths } : {}), revision: 1, createdAt: now, updatedAt: now, sourceReviewId: review.reviewId });
      continue;
    }
    const index = notes.findIndex((note) => note.id === operation.targetId);
    if (index < 0 || notes[index]!.revision !== operation.expectedRevision) throw Error("memory review target changed");
    const target = notes[index]!;
    if (!((target.scope === "user" && target.owner === "default") || (target.scope === "project" && target.owner === review.projectOwner))) throw Error("memory review target crosses owner boundary");
    if (operation.operation === "remove") notes.splice(index, 1);
    else {
      const existing = notes[index]!;
      if (strongDuplicate(notes, existing.scope, existing.owner, operation.trigger, operation.guidance, existing.id)) throw Error("memory review creates a duplicate rule");
      notes[index] = { ...existing, trigger: operation.trigger, guidance: operation.guidance, authority: operation.authority, origin: "agent", sourceRefs: operation.sourceRefs, ...(operation.relatedPaths?.length ? { relatedPaths: operation.relatedPaths } : { relatedPaths: undefined }), revision: existing.revision + 1, updatedAt: now, sourceReviewId: review.reviewId };
    }
  }
  const reviews = state.reviews.map((item) => item.reviewId === review.reviewId ? { ...item, status: "committed" as const, settledAt: now } : item);
  const next = { ...state, revision: state.revision + 1, notes, reviews: boundedReviews(reviews), updatedAt: now };
  enforceMemoryLimits(next);
  return next;
}

export function directEdit(state: MemoryStateFile, scope: MemoryScope, owner: string, id: string, expectedRevision: number, trigger: string, guidance: string, now = new Date().toISOString()): MemoryStateFile {
  trigger = normalizeRuleText(trigger); guidance = normalizeRuleText(guidance);
  if (!text(trigger, 240) || !text(guidance, 800) || trigger.length + guidance.length > 1_000 || !safe(trigger, guidance)) throw Error("invalid memory note");
  const index = state.notes.findIndex((note) => note.id === id && note.scope === scope && note.owner === owner);
  if (index < 0) throw Error("memory note is unavailable");
  const existing = state.notes[index]!;
  if (existing.revision !== expectedRevision) throw Error("memory note changed; review the latest value");
  if (strongDuplicate(state.notes, scope, owner, trigger, guidance, id)) throw Error("memory note duplicates an existing rule");
  const notes = [...state.notes];
  notes[index] = { ...existing, trigger, guidance, authority: "user_instruction", origin: "user", sourceRefs: [{ type: "direct_user_edit" }], revision: existing.revision + 1, updatedAt: now, sourceReviewId: undefined };
  const audits = [...(state.audits ?? []), { type: "direct_edit" as const, noteId: id, scope, owner, at: now, previousSourceRefs: existing.sourceRefs, ...(existing.sourceReviewId ? { previousSourceReviewId: existing.sourceReviewId } : {}) }].slice(-100);
  const next = { ...state, revision: state.revision + 1, notes, audits, updatedAt: now };
  enforceMemoryLimits(next);
  return next;
}
export function directDelete(state: MemoryStateFile, scope: MemoryScope, owner: string, id: string, expectedRevision: number, now = new Date().toISOString()): MemoryStateFile {
  const index = state.notes.findIndex((note) => note.id === id && note.scope === scope && note.owner === owner);
  if (index < 0) throw Error("memory note is unavailable");
  if (state.notes[index]!.revision !== expectedRevision) throw Error("memory note changed; review the latest value");
  const notes = [...state.notes]; notes.splice(index, 1);
  const audits = [...(state.audits ?? []), { type: "direct_delete" as const, noteId: id, scope, owner, at: now }].slice(-100);
  const next = { ...state, revision: state.revision + 1, notes, audits, updatedAt: now };
  enforceMemoryLimits(next);
  return next;
}

export function discardExpiredReviews(state: MemoryStateFile, now = new Date(), retentionMs = 30 * 24 * 60 * 60 * 1_000): MemoryStateFile {
  let changed = false;
  const reviews = state.reviews.map((review) => {
    if (review.status !== "approved_pending" || now.getTime() - Date.parse(review.reviewedAt) <= retentionMs) return review;
    changed = true; return { ...review, status: "discarded" as const, discardReason: "abandoned after pending-review retention period", settledAt: now.toISOString() };
  });
  return changed ? { ...state, revision: state.revision + 1, reviews: boundedReviews(reviews), updatedAt: now.toISOString() } : state;
}

export function stageReview(state: MemoryStateFile, review: ReviewRecord): MemoryStateFile {
  const sameCall = state.reviews.find((item) => item.sessionId === review.sessionId && item.toolCallId === review.toolCallId);
  if (sameCall) {
    if (sameCall.reviewId !== review.reviewId) throw Error("memory proposal tool call was already staged");
    return state;
  }
  const next = { ...state, revision: state.revision + 1, reviews: boundedReviews([...state.reviews, review]), updatedAt: review.reviewedAt };
  enforceMemoryLimits(next);
  return next;
}

export const serverNoteId = () => randomUUID();
export const serverReviewId = () => randomUUID();
