import { createHash } from "node:crypto";
import { REQUIRED_ZERO_COUNTS, validEnabledGate, type MemoryOperationClass, type MemoryRolloutGate } from "./memory-rollout.ts";

export type MemoryEvaluationCase = {
  id: string;
  operationClass: MemoryOperationClass;
  expected: "approve" | "reject";
  actual: "approve" | "reject";
  useful: boolean;
  zeroCounts: Record<(typeof REQUIRED_ZERO_COUNTS)[number], boolean>;
};
export type MemoryEvaluationReport = {
  version: 1;
  caseCount: number;
  gates: Record<MemoryOperationClass, MemoryRolloutGate>;
  usefulnessAgreement: Record<MemoryOperationClass, number>;
};
const operations: MemoryOperationClass[] = ["user_instruction_add", "project_contract_write", "merge_replace", "reviewer_remove", "v4_migration"];
const exactKeys = (value: any, allowed: readonly string[]) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key));

export function parseMemoryEvaluationCorpus(value: unknown): MemoryEvaluationCase[] {
  if (!Array.isArray(value)) throw Error("Memory V5 evaluation corpus must be a JSON array");
  const ids = new Set<string>();
  return value.map((item: any) => {
    if (!exactKeys(item, ["id", "operationClass", "expected", "actual", "useful", "zeroCounts"]) || typeof item.id !== "string" || !item.id.trim() || item.id.length > 200
      || !operations.includes(item.operationClass) || !["approve", "reject"].includes(item.expected) || !["approve", "reject"].includes(item.actual) || typeof item.useful !== "boolean"
      || !exactKeys(item.zeroCounts, REQUIRED_ZERO_COUNTS) || !REQUIRED_ZERO_COUNTS.every((key) => typeof item.zeroCounts[key] === "boolean")) throw Error("invalid Memory V5 evaluation case");
    if (ids.has(item.id)) throw Error(`duplicate Memory V5 evaluation case id: ${item.id}`);
    ids.add(item.id); return item as MemoryEvaluationCase;
  });
}

export function scoreMemoryEvaluation(corpus: MemoryEvaluationCase[]): MemoryEvaluationReport {
  const parsed = parseMemoryEvaluationCorpus(corpus), gates = {} as Record<MemoryOperationClass, MemoryRolloutGate>, usefulnessAgreement = {} as Record<MemoryOperationClass, number>;
  for (const operation of operations) {
    const cases = parsed.filter((item) => item.operationClass === operation).sort((a, b) => a.id.localeCompare(b.id));
    const approvals = cases.filter((item) => item.actual === "approve"), expectedRejects = cases.filter((item) => item.expected === "reject");
    const precision = approvals.length ? approvals.filter((item) => item.expected === "approve").length / approvals.length : 0;
    const noOpAgreement = expectedRejects.length ? expectedRejects.filter((item) => item.actual === "reject").length / expectedRejects.length : 0;
    const useful = approvals.filter((item) => item.expected === "approve");
    usefulnessAgreement[operation] = useful.length ? useful.filter((item) => item.useful).length / useful.length : 0;
    const zeroCounts = Object.fromEntries(REQUIRED_ZERO_COUNTS.map((key) => [key, cases.filter((item) => item.zeroCounts[key]).length])) as Record<(typeof REQUIRED_ZERO_COUNTS)[number], number>;
    const candidate: MemoryRolloutGate = { enabled: true, corpusSize: cases.length, precision, noOpAgreement, corpusSha256: createHash("sha256").update(JSON.stringify(cases)).digest("hex"), zeroCounts };
    gates[operation] = { ...candidate, enabled: validEnabledGate(candidate) && usefulnessAgreement[operation] === 1 };
  }
  return { version: 1, caseCount: parsed.length, gates, usefulnessAgreement };
}
