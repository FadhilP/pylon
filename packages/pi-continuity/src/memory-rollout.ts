import type { MemoryProposal, ReviewerDecision } from "./memory.ts";

export type MemoryOperationClass = "user_instruction_add" | "project_contract_write" | "merge_replace" | "reviewer_remove" | "v4_migration";
export const REQUIRED_ZERO_COUNTS = ["unsupportedCitations", "secretWrites", "staleApplies", "crossOwnerMutations", "duplicateApplies", "prohibitedUserNoteChanges"] as const;
export type MemoryRolloutGate = { enabled: boolean; corpusSize: number; precision?: number; noOpAgreement?: number; corpusSha256?: string; zeroCounts?: Record<string, number> };
const gate = (value: MemoryRolloutGate): Readonly<MemoryRolloutGate> => Object.freeze({ ...value, ...(value.zeroCounts ? { zeroCounts: Object.freeze({ ...value.zeroCounts }) } : {}) });

/** Release-owned constants validated in tests/CI. */
export const MEMORY_V5_ROLLOUT: Readonly<Record<MemoryOperationClass, Readonly<MemoryRolloutGate>>> = Object.freeze({
  user_instruction_add: gate({ enabled: false, corpusSize: 0 }),
  project_contract_write: gate({ enabled: false, corpusSize: 0 }),
  merge_replace: gate({ enabled: false, corpusSize: 0 }),
  reviewer_remove: gate({ enabled: false, corpusSize: 0 }),
  v4_migration: gate({ enabled: false, corpusSize: 0 }),
});
export type MemoryRolloutPolicy = (operation: MemoryOperationClass) => boolean;
/** Reviewer-backed V4 migration bypasses only its release rollout decision. */
export const reviewerBackedV4MigrationPolicy: MemoryRolloutPolicy = (operation) => operation === "v4_migration";
export function validEnabledGate(value: MemoryRolloutGate) {
  const counts = value.zeroCounts, keys = counts ? Object.keys(counts).sort() : [];
  return value.enabled && value.corpusSize >= 500 && (value.precision ?? 0) >= 0.99 && (value.noOpAgreement ?? 0) >= 0.95
    && /^[0-9a-f]{64}$/.test(value.corpusSha256 ?? "") && JSON.stringify(keys) === JSON.stringify([...REQUIRED_ZERO_COUNTS].sort())
    && REQUIRED_ZERO_COUNTS.every((key) => Number.isSafeInteger(counts![key]) && counts![key] === 0);
}
const rolloutOrder: MemoryOperationClass[] = ["user_instruction_add", "project_contract_write", "merge_replace", "reviewer_remove", "v4_migration"];
export const rolloutEnabled: MemoryRolloutPolicy = (operation) => rolloutOrder.slice(0, rolloutOrder.indexOf(operation) + 1).every((item) => validEnabledGate(MEMORY_V5_ROLLOUT[item]));
export function proposalOperationClass(proposal: MemoryProposal): MemoryOperationClass {
  if (proposal.operation === "remove") return "reviewer_remove";
  if (proposal.operation === "replace") return "merge_replace";
  return proposal.basis.type === "user_instruction" ? "user_instruction_add" : "project_contract_write";
}
export function decisionOperationClass(proposal: MemoryProposal, decision: ReviewerDecision): MemoryOperationClass | undefined {
  if (decision.verdict === "reject") return;
  if (decision.verdict === "merge" || proposal.operation === "replace") return "merge_replace";
  if (decision.operation === "remove") return "reviewer_remove";
  return proposal.basis.type === "user_instruction" ? "user_instruction_add" : "project_contract_write";
}
export function assertRolloutEnabled(operation: MemoryOperationClass, policy: MemoryRolloutPolicy = rolloutEnabled) {
  if (!policy(operation)) throw Error(`Memory V5 ${operation} is disabled until its offline rollout gate passes.`);
}
