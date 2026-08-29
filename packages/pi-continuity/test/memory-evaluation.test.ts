import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMemoryEvaluationCorpus,
  REQUIRED_ZERO_COUNTS,
  scoreMemoryEvaluation,
  type MemoryEvaluationCase,
} from "../src/memory-evaluation.ts";

const safeCounts = () =>
  Object.fromEntries(
    REQUIRED_ZERO_COUNTS.map((key) => [key, false]),
  ) as MemoryEvaluationCase["zeroCounts"];
const corpus = (count = 500): MemoryEvaluationCase[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `case-${index}`,
    operationClass: "user_instruction_add",
    expected: index % 2 ? "approve" : "reject",
    actual: index % 2 ? "approve" : "reject",
    useful: true,
    zeroCounts: safeCounts(),
  }));

test("offline evaluator reports only operation classes meeting every safety and usefulness threshold", () => {
  const report = scoreMemoryEvaluation(corpus());
  assert.equal(report.results.user_instruction_add.passed, true);
  assert.equal(report.results.user_instruction_add.corpusSize, 500);
  assert.equal(report.results.project_contract_write.passed, false);
  const unsafe = corpus();
  unsafe[1]!.zeroCounts.secretWrites = true;
  assert.equal(
    scoreMemoryEvaluation(unsafe).results.user_instruction_add.passed,
    false,
  );
  const useless = corpus();
  useless[1]!.useful = false;
  assert.equal(
    scoreMemoryEvaluation(useless).results.user_instruction_add.passed,
    false,
  );
});

test("offline evaluator rejects malformed and duplicate labeled cases", () => {
  assert.throws(() => parseMemoryEvaluationCorpus({}), /JSON array/);
  assert.throws(
    () => parseMemoryEvaluationCorpus([{ ...corpus(1)[0], extra: true }]),
    /invalid/,
  );
  assert.throws(
    () => parseMemoryEvaluationCorpus([corpus(1)[0], corpus(1)[0]]),
    /duplicate/,
  );
});
