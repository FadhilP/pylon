import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  configPath,
  DEFAULT_REPO_TIMEOUT_MS,
  DEFAULT_SCOUT_MAX_COST_USD,
  isScoutEnabled,
  loadConfig,
  parseModelRef,
  repoTimeoutMs,
  saveConfig,
  scoutMaxCostUsd,
} from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";
import { REPO_SCOUT_PROMPT, WEB_SCOUT_PROMPT } from "../src/prompts.ts";

test("config is atomic, validated, and corrupt input is preserved", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scout-config-"));
  const path = join(dir, "nested", "config.json");
  await saveConfig(
    {
      version: 1,
      model: "openai/gpt",
      thinking: "xhigh",
      disabled: true,
      webSearch: true,
      repoTimeoutMs: 120_000,
      maxCostUsd: 1.25,
      webSearchResults: 6,
    },
    path,
  );
  assert.deepEqual(await loadConfig(path), {
    version: 1,
    model: "openai/gpt",
    thinking: "xhigh",
    disabled: true,
    webSearch: true,
    repoTimeoutMs: 120_000,
    maxCostUsd: 1.25,
    webSearchResults: 6,
  });
  await saveConfig({ version: 1, disabled: false, webSearch: false }, path);
  assert.deepEqual(await loadConfig(path), { version: 1, disabled: false, webSearch: false });
  await writeFile(path, "bad");
  assert.deepEqual(await loadConfig(path), { version: 1 });
});

test("Scout settings round-trip prompt", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "scout-web-settings-"));
  const current = await readSettings({ agentDir });
  await updateSettings(
    {
      ...current,
      mode: "session",
      repoTimeoutMs: 120_000,
      maxCostUsd: 0,
      webSearchResults: 6,
      prompt: { mode: "replace", text: "Gather only release evidence." },
    },
    { agentDir },
  );
  const saved = await readSettings({ agentDir });
  assert.deepEqual(saved.prompt, { mode: "replace", text: "Gather only release evidence." });
  assert.equal(saved.promptDefaultText, `Repository Scout:\n${REPO_SCOUT_PROMPT}\n\nWeb Scout:\n${WEB_SCOUT_PROMPT}`);
  assert.deepEqual((await loadConfig(configPath(agentDir))).prompt, {
    mode: "replace",
    text: "Gather only release evidence.",
  });
  await assert.rejects(
    updateSettings({ ...saved, prompt: { mode: "default", text: "not allowed" } }, { agentDir }),
    /invalid Scout/,
  );
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
  assert.throws(() => repoTimeoutMs("0"), /invalid/);
  assert.throws(() => repoTimeoutMs("1.5"), /invalid/);
  assert.throws(() => repoTimeoutMs("7200001"), /invalid/);
});
test("Scout reported-cost ceiling defaults, disables, and validates overrides", () => {
  assert.equal(scoutMaxCostUsd(undefined), DEFAULT_SCOUT_MAX_COST_USD);
  assert.equal(scoutMaxCostUsd("0"), undefined);
  assert.equal(scoutMaxCostUsd("1.25"), 1.25);
  assert.throws(() => scoutMaxCostUsd("-0.01"), /PI_SCOUT_MAX_COST_USD/);
  assert.throws(() => scoutMaxCostUsd("NaN"), /PI_SCOUT_MAX_COST_USD/);
  assert.throws(() => scoutMaxCostUsd("Infinity"), /PI_SCOUT_MAX_COST_USD/);
  assert.throws(() => scoutMaxCostUsd("nope"), /PI_SCOUT_MAX_COST_USD/);
});

test("model refs support thinking without breaking colon model IDs", () => {
  assert.deepEqual(parseModelRef("p/m:low"), { provider: "p", id: "m", thinking: "low" });
  assert.deepEqual(parseModelRef("ollama/qwen:7b"), { provider: "ollama", id: "qwen:7b" });
  assert.equal(parseModelRef("m"), undefined);
});
