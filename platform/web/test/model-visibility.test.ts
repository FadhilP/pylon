import assert from "node:assert/strict";
import test from "node:test";
import type { ModelOptionReadModel } from "../src/shared/protocol/events.ts";
import { selectableModels, visibleModels } from "../src/shared/model-options.ts";

const models: ModelOptionReadModel[] = [
  { provider: "openai", id: "visible", name: "Visible" },
  { provider: "openai", id: "hidden", name: "Hidden" },
];

test("model choices follow visibility while retaining an existing selection", () => {
  const hidden = new Set(["openai/hidden"]);

  assert.deepEqual(visibleModels(models, hidden), [models[0]]);
  assert.deepEqual(selectableModels(models, hidden), [models[0]]);
  assert.deepEqual(selectableModels(models, hidden, ["openai/hidden"]), models);
});
