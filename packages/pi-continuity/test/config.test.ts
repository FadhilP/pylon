import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, loadConfig, parseModelRef, saveConfig } from "../src/config.ts";

test("model profiles parse, persist, and reset to defaults", async () => {
  assert.deepEqual(parseModelRef("provider/model:high"), {
    provider: "provider",
    id: "model",
    thinking: "high",
  });
  assert.deepEqual(parseModelRef("provider/model:version"), {
    provider: "provider",
    id: "model:version",
  });
  const root = await mkdtemp(join(tmpdir(), "continuity-config-"));
  const path = join(root, "config.json");
  await saveConfig(
    {
      version: 1,
      planner: { model: "provider/planner", thinking: "high" },
      executor: { model: "provider/executor" },
    },
    path,
  );
  assert.deepEqual(await loadConfig(path), {
    version: 1,
    planner: { model: "provider/planner", thinking: "high" },
    executor: { model: "provider/executor" },
  });
  assert.deepEqual(defaultConfig(), { version: 1 });
});
