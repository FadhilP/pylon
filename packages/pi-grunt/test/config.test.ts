import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_GRUNT_MAX_COST_USD, DEFAULT_GRUNT_MAX_TURNS, DEFAULT_GRUNT_PARENT_CONTEXT_CHARS,
  DEFAULT_GRUNT_TIMEOUT_MS, defaultThinkingLevels, gruntMaxCostUsd, gruntMaxTurns, gruntParentContextChars,
  gruntMode, gruntThinkingLevels, gruntTimeoutMs, isGruntEnabled, loadConfig, parseModelRef, saveConfig, thinkingLevels,
} from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

test("config is atomic, validated, and preserves corrupt input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "grunt-config-"));
  const path = join(dir, "nested", "config.json");
  await saveConfig({ version: 1, model: "openai/worker", mode: "direct", maxTurns: 12 }, path);
  assert.deepEqual(await loadConfig(path), { version: 1, model: "openai/worker", mode: "direct", maxTurns: 12 });
  await saveConfig({ version: 1, disabled: false }, path);
  assert.deepEqual(await loadConfig(path), { version: 1, disabled: false });
  await writeFile(path, "bad");
  assert.deepEqual(await loadConfig(path), { version: 1 });
});

test("execution mode defaults to isolated", () => {
  assert.equal(gruntMode({ version: 1 }), "isolated");
  assert.equal(gruntMode({ version: 1, mode: "direct" }), "direct");
  assert.equal(gruntMode({ version: 1, mode: "dynamic" }), "dynamic");
});

test("Grunt stays inactive until configured or explicitly reset", () => {
  assert.equal(isGruntEnabled({ version: 1 }), false);
  assert.equal(isGruntEnabled({ version: 1, disabled: true }), false);
  assert.equal(isGruntEnabled({ version: 1, disabled: false }), true);
  assert.equal(isGruntEnabled({ version: 1, model: "openai/worker" }), true);
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
  assert.equal(gruntMaxTurns(10_000), 10_000);
  assert.throws(() => gruntMaxTurns("0"), /positive/);
  assert.equal(gruntMaxCostUsd(undefined), DEFAULT_GRUNT_MAX_COST_USD);
  assert.equal(gruntMaxCostUsd("0.5"), 0.5);
  assert.throws(() => gruntMaxCostUsd("0"), /greater/);
  assert.equal(gruntParentContextChars(undefined), DEFAULT_GRUNT_PARENT_CONTEXT_CHARS);
  assert.equal(gruntParentContextChars("1200"), 1200);
  assert.throws(() => gruntParentContextChars("12001"), /between/);
});

test("worker thinking defaults to medium/high and supports a configured allowlist", async () => {
  assert.deepEqual(defaultThinkingLevels, ["medium", "high"]);
  assert.deepEqual(gruntThinkingLevels({ version: 1 }), ["medium", "high"]);
  assert.deepEqual(thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

  const agentDir = await mkdtemp(join(tmpdir(), "grunt-settings-"));
  await updateSettings({
    kind: "grunt", mode: "session", executionMode: "isolated", thinkingLevels: ["low", "xhigh"], maxTurns: 10_000,
  }, { agentDir });
  assert.deepEqual(await readSettings({ agentDir }), {
    kind: "grunt", mode: "session", executionMode: "isolated", thinkingLevels: ["low", "xhigh"], maxTurns: 10_000,
  });
  await assert.rejects(updateSettings({
    kind: "grunt", mode: "session", executionMode: "isolated", thinkingLevels: [], maxTurns: 12,
  }, { agentDir }), /invalid Grunt settings/);
  await assert.rejects(updateSettings({
    kind: "grunt", mode: "session", executionMode: "isolated", thinkingLevels: ["medium"], maxTurns: 0,
  }, { agentDir }), /invalid Grunt settings/);
});

test("model refs preserve colon model IDs", () => {
  assert.deepEqual(parseModelRef("ollama/qwen:7b"), { provider: "ollama", id: "qwen:7b" });
  assert.equal(parseModelRef("worker"), undefined);
});
