import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_REPO_TIMEOUT_MS, DEFAULT_SCOUT_MAX_COST_USD, isScoutEnabled, loadConfig, parseModelRef, repoTimeoutMs, saveConfig, scoutMaxCostUsd } from "../src/config.ts";

test("config is atomic, validated, and corrupt input is preserved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-config-")); const path = join(dir, "nested", "config.json");
  await saveConfig({ version: 1, model: "openai/gpt", thinking: "xhigh", disabled: true }, path);
  assert.deepEqual(await loadConfig(path), { version: 1, model: "openai/gpt", thinking: "xhigh", disabled: true });
  await saveConfig({ version: 1, disabled: false }, path);
  assert.deepEqual(await loadConfig(path), { version: 1, disabled: false });
  await writeFile(path, "bad"); assert.deepEqual(await loadConfig(path), { version: 1 });
});
test("Scout stays inactive until configured or explicitly reset", () => {
  assert.equal(isScoutEnabled({ version: 1 }), false);
  assert.equal(isScoutEnabled({ version: 1, disabled: true }), false);
  assert.equal(isScoutEnabled({ version: 1, disabled: false }), true);
  assert.equal(isScoutEnabled({ version: 1, model: "openai/gpt" }), true);
});
test("repo timeout defaults to fifteen minutes and validates overrides", () => {
  assert.equal(repoTimeoutMs(undefined), DEFAULT_REPO_TIMEOUT_MS);
  assert.equal(repoTimeoutMs("120000"), 120000);
  assert.throws(() => repoTimeoutMs("0"), /between/);
  assert.throws(() => repoTimeoutMs("1.5"), /between/);
  assert.throws(() => repoTimeoutMs("7200001"), /between/);
});
test("Scout reported-cost ceiling defaults, disables, and validates overrides", () => {
  assert.equal(scoutMaxCostUsd(undefined), DEFAULT_SCOUT_MAX_COST_USD);
  assert.equal(DEFAULT_SCOUT_MAX_COST_USD, 0.5);
  assert.equal(scoutMaxCostUsd("0"), undefined);
  assert.equal(scoutMaxCostUsd("1.25"), 1.25);
  assert.throws(() => scoutMaxCostUsd("-0.01"), /PI_SCOUT_MAX_COST_USD/);
  assert.throws(() => scoutMaxCostUsd("NaN"), /finite number/);
  assert.throws(() => scoutMaxCostUsd("Infinity"), /finite number/);
  assert.throws(() => scoutMaxCostUsd("nope"), /finite number/);
});

test("model refs support thinking without breaking colon model IDs", () => {
  assert.deepEqual(parseModelRef("p/m:low"), { provider: "p", id: "m", thinking: "low" });
  assert.deepEqual(parseModelRef("ollama/qwen:7b"), { provider: "ollama", id: "qwen:7b" });
  assert.equal(parseModelRef("m"), undefined);
});
