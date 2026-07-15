import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_GRUNT_MAX_COST_USD, DEFAULT_GRUNT_MAX_TURNS, DEFAULT_GRUNT_PARENT_CONTEXT_CHARS,
  DEFAULT_GRUNT_TIMEOUT_MS, gruntMaxCostUsd, gruntMaxTurns, gruntParentContextChars,
  gruntTimeoutMs, loadConfig, parseModelRef, saveConfig, thinkingLevels,
} from "../src/config.ts";

test("config is atomic, validated, and preserves corrupt input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grunt-config-"));
  const path = join(dir, "nested", "config.json");
  await saveConfig({ version: 1, model: "openai/worker" }, path);
  assert.deepEqual(await loadConfig(path), { version: 1, model: "openai/worker" });
  await writeFile(path, "bad");
  assert.deepEqual(await loadConfig(path), { version: 1 });
});

test("timeout defaults to fifteen minutes and validates overrides", () => {
  assert.equal(gruntTimeoutMs(undefined), DEFAULT_GRUNT_TIMEOUT_MS);
  assert.equal(gruntTimeoutMs("120000"), 120000);
  assert.throws(() => gruntTimeoutMs("0"), /between/);
  assert.throws(() => gruntTimeoutMs("1.5"), /between/);
});

test("worker budgets and parent context limits are bounded", () => {
  assert.equal(gruntMaxTurns(undefined), DEFAULT_GRUNT_MAX_TURNS);
  assert.equal(gruntMaxTurns("3"), 3);
  assert.throws(() => gruntMaxTurns("0"), /between/);
  assert.equal(gruntMaxCostUsd(undefined), DEFAULT_GRUNT_MAX_COST_USD);
  assert.equal(gruntMaxCostUsd("0.5"), 0.5);
  assert.throws(() => gruntMaxCostUsd("0"), /greater/);
  assert.equal(gruntParentContextChars(undefined), DEFAULT_GRUNT_PARENT_CONTEXT_CHARS);
  assert.equal(gruntParentContextChars("1200"), 1200);
  assert.throws(() => gruntParentContextChars("12001"), /between/);
});

test("worker thinking is limited to medium and high", () => {
  assert.deepEqual(thinkingLevels, ["medium", "high"]);
});

test("model refs preserve colon model IDs", () => {
  assert.deepEqual(parseModelRef("ollama/qwen:7b"), { provider: "ollama", id: "qwen:7b" });
  assert.equal(parseModelRef("worker"), undefined);
});
