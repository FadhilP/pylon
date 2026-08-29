import { createHash } from "node:crypto";

export type MemoryOperationClass =
  | "user_instruction_add"
  | "project_contract_write"
  | "merge_replace"
  | "reviewer_remove"
  | "v4_migration";
export const REQUIRED_ZERO_COUNTS = [
  "unsupportedCitations",
  "secretWrites",
  "staleApplies",
  "crossOwnerMutations",
  "duplicateApplies",
  "prohibitedUserNoteChanges",
] as const;
export type MemoryEvaluationResult = {
  passed: boolean;
  corpusSize: number;
  precision?: number;
  noOpAgreement?: number;
  corpusSha256?: string;
  zeroCounts?: Record<string, number>;
};

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
  results: Record<MemoryOperationClass, MemoryEvaluationResult>;
  usefulnessAgreement: Record<MemoryOperationClass, number>;
};
const operations: MemoryOperationClass[] = [
  "user_instruction_add",
  "project_contract_write",
  "merge_replace",
  "reviewer_remove",
  "v4_migration",
];
const exactKeys = (value: any, allowed: readonly string[]) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => allowed.includes(key));
const meetsEvaluationThreshold = (value: MemoryEvaluationResult) => {
  const counts = value.zeroCounts,
    keys = counts ? Object.keys(counts).sort() : [];
  return (
    value.passed &&
    value.corpusSize >= 500 &&
    (value.precision ?? 0) >= 0.99 &&
    (value.noOpAgreement ?? 0) >= 0.95 &&
    /^[0-9a-f]{64}$/.test(value.corpusSha256 ?? "") &&
    JSON.stringify(keys) === JSON.stringify([...REQUIRED_ZERO_COUNTS].sort()) &&
    REQUIRED_ZERO_COUNTS.every(
      (key) => Number.isSafeInteger(counts![key]) && counts![key] === 0,
    )
  );
};

export function parseMemoryEvaluationCorpus(
  value: unknown,
): MemoryEvaluationCase[] {
  if (!Array.isArray(value))
    throw Error("Memory V5 evaluation corpus must be a JSON array");
  const ids = new Set<string>();
  return value.map((item: any) => {
    if (
      !exactKeys(item, [
        "id",
        "operationClass",
        "expected",
        "actual",
        "useful",
        "zeroCounts",
      ]) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      item.id.length > 200 ||
      !operations.includes(item.operationClass) ||
      !["approve", "reject"].includes(item.expected) ||
      !["approve", "reject"].includes(item.actual) ||
      typeof item.useful !== "boolean" ||
      !exactKeys(item.zeroCounts, REQUIRED_ZERO_COUNTS) ||
      !REQUIRED_ZERO_COUNTS.every(
        (key) => typeof item.zeroCounts[key] === "boolean",
      )
    )
      throw Error("invalid Memory V5 evaluation case");
    if (ids.has(item.id))
      throw Error(`duplicate Memory V5 evaluation case id: ${item.id}`);
    ids.add(item.id);
    return item as MemoryEvaluationCase;
  });
}

export function scoreMemoryEvaluation(
  corpus: MemoryEvaluationCase[],
): MemoryEvaluationReport {
  const parsed = parseMemoryEvaluationCorpus(corpus),
    results = {} as Record<MemoryOperationClass, MemoryEvaluationResult>,
    usefulnessAgreement = {} as Record<MemoryOperationClass, number>;
  for (const operation of operations) {
    const cases = parsed
      .filter((item) => item.operationClass === operation)
      .sort((a, b) => a.id.localeCompare(b.id));
    const approvals = cases.filter((item) => item.actual === "approve"),
      expectedRejects = cases.filter((item) => item.expected === "reject");
    const precision = approvals.length
      ? approvals.filter((item) => item.expected === "approve").length /
        approvals.length
      : 0;
    const noOpAgreement = expectedRejects.length
      ? expectedRejects.filter((item) => item.actual === "reject").length /
        expectedRejects.length
      : 0;
    const useful = approvals.filter((item) => item.expected === "approve");
    usefulnessAgreement[operation] = useful.length
      ? useful.filter((item) => item.useful).length / useful.length
      : 0;
    const zeroCounts = Object.fromEntries(
      REQUIRED_ZERO_COUNTS.map((key) => [
        key,
        cases.filter((item) => item.zeroCounts[key]).length,
      ]),
    ) as Record<(typeof REQUIRED_ZERO_COUNTS)[number], number>;
    const candidate: MemoryEvaluationResult = {
      passed: true,
      corpusSize: cases.length,
      precision,
      noOpAgreement,
      corpusSha256: createHash("sha256")
        .update(JSON.stringify(cases))
        .digest("hex"),
      zeroCounts,
    };
    results[operation] = {
      ...candidate,
      passed:
        meetsEvaluationThreshold(candidate) &&
        usefulnessAgreement[operation] === 1,
    };
  }
  return { version: 1, caseCount: parsed.length, results, usefulnessAgreement };
}
