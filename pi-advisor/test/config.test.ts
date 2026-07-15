import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, parseModelRef, saveConfig } from "../src/config.ts";

test("config persists and malformed config deactivates advisor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "advisor-config-")); const path = join(dir, "nested", "config.json");
  await saveConfig({ schemaVersion: 1, advisorModel: "p/m", thinking: "high" }, path); assert.deepEqual(await loadConfig(path), { schemaVersion: 1, advisorModel: "p/m", thinking: "high" });
  await saveConfig({ schemaVersion: 1, useMainModel: true }, path); assert.deepEqual(await loadConfig(path), { schemaVersion: 1, useMainModel: true });
  await writeFile(path, "{}"); assert.deepEqual(await loadConfig(path), { schemaVersion: 1 });
});

test("model refs accept thinking suffix without breaking colon model IDs", () => {
  assert.deepEqual(parseModelRef("p/m:high"), { provider: "p", id: "m", thinking: "high" });
  assert.deepEqual(parseModelRef("ollama/qwen:7b"), { provider: "ollama", id: "qwen:7b" });
});
