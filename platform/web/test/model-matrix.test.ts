import test from "node:test";
import assert from "node:assert/strict";
import type { ModelOptionReadModel } from "../src/shared/protocol/events.ts";
import { matrixSelectionAtPoint, matrixThinkingAxis, moveMatrixSelection, nearestModelThinkingLevel } from "../src/shared/model-matrix.ts";

const models: ModelOptionReadModel[] = [
  { provider: "one", id: "full", name: "Full", thinkingLevels: ["off", "low", "medium", "high"] },
  { provider: "two", id: "gapped", name: "Gapped", thinkingLevels: ["off", "medium"] },
  { provider: "three", id: "fast", name: "Fast", thinkingLevels: ["off", "low"] },
];

test("matrix axis stays canonical and pointer selection snaps to supported levels", () => {
  const axis = matrixThinkingAxis(models);
  assert.deepEqual(axis, ["off", "low", "medium", "high"]);
  assert.equal(nearestModelThinkingLevel(models[1], axis, 1), "off", "equal-distance ties prefer the lower effort");
  assert.deepEqual(matrixSelectionAtPoint(models, axis, 1, 1), {
    modelIndex: 2,
    model: models[2],
    level: "low",
  });
});

test("keyboard movement skips unsupported levels and preserves nearest effort between models", () => {
  const axis = matrixThinkingAxis(models);
  assert.deepEqual(moveMatrixSelection(models, axis, 1, "off", 0, 1), {
    modelIndex: 1,
    model: models[1],
    level: "medium",
  });
  assert.deepEqual(moveMatrixSelection(models, axis, 0, "high", 1, 0), {
    modelIndex: 1,
    model: models[1],
    level: "medium",
  });
});
