import test from "node:test";
import assert from "node:assert/strict";
import { parseMemoryEvaluationCorpus, scoreMemoryEvaluation, type MemoryEvaluationCase } from "../src/memory-evaluation.ts";
import { REQUIRED_ZERO_COUNTS } from "../src/memory-rollout.ts";

const safeCounts = () => Object.fromEntries(REQUIRED_ZERO_COUNTS.map((key) => [key, false])) as MemoryEvaluationCase["zeroCounts"];
const corpus = (count = 500): MemoryEvaluationCase[] => Array.from({ length: count }, (_, index) => ({
  id: `case-${index}`, operationClass: "user_instruction_add", expected: index % 2 ? "approve" : "reject", actual: index % 2 ? "approve" : "reject", useful: true, zeroCounts: safeCounts(),
}));

test("offline evaluator enables only operation classes meeting every rollout and usefulness gate", () => {
  const report = scoreMemoryEvaluation(corpus());
  assert.equal(report.gates.user_instruction_add.enabled, true);
  assert.equal(report.gates.user_instruction_add.corpusSize, 500);
  assert.equal(report.gates.project_contract_write.enabled, false);
  const unsafe = corpus(); unsafe[1]!.zeroCounts.secretWrites = true;
  assert.equal(scoreMemoryEvaluation(unsafe).gates.user_instruction_add.enabled, false);
  const useless = corpus(); useless[1]!.useful = false;
  assert.equal(scoreMemoryEvaluation(useless).gates.user_instruction_add.enabled, false);
});

test("offline evaluator rejects malformed and duplicate labeled cases", () => {
  assert.throws(() => parseMemoryEvaluationCorpus({}), /JSON array/);
  assert.throws(() => parseMemoryEvaluationCorpus([{ ...corpus(1)[0], extra: true }]), /invalid/);
  assert.throws(() => parseMemoryEvaluationCorpus([corpus(1)[0], corpus(1)[0]]), /duplicate/);
});
