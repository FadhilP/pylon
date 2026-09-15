import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import type { ModelOptionReadModel } from "../src/shared/protocol/events.ts";
import { selectableModels, visibleModels } from "../src/client/settings/model-options.ts";

const models: ModelOptionReadModel[] = [
  { provider: "openai", id: "visible", name: "Visible" },
  { provider: "openai", id: "hidden", name: "Hidden" },
];

class RecordingStorage {
  private readonly values = new Map<string, string>();
  writes = 0;
  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }
}

test("model choices follow visibility while retaining an existing selection", () => {
  const hidden = new Set(["openai/hidden"]);

  assert.deepEqual(visibleModels(models, hidden), [models[0]]);
  assert.deepEqual(selectableModels(models, hidden), [models[0]]);
  assert.deepEqual(selectableModels(models, hidden, ["openai/hidden"]), models);
});

test("provider visibility persists a large model batch once", async () => {
  const previous = globalThis.localStorage;
  const storage = new RecordingStorage();
  globalThis.localStorage = storage as unknown as Storage;
  const keys = Array.from({ length: 500 }, (_, index) => `provider/model-${index}`);
  try {
    const jiti = createJiti(import.meta.url);
    const { setHiddenModelsVisible } = await jiti.import<{
      setHiddenModelsVisible: (keys: Iterable<string>, visible: boolean) => void;
    }>("../src/client/settings/model-visibility.ts");
    setHiddenModelsVisible(keys, false);

    assert.equal(storage.writes, 1);
    assert.deepEqual(JSON.parse(storage.getItem("pylon-hidden-models") ?? "[]"), keys);
    setHiddenModelsVisible(keys, true);
  } finally {
    globalThis.localStorage = previous;
  }
});
