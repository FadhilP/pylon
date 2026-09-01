import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_GRUNT_MAX_COST_USD,
  DEFAULT_GRUNT_MAX_TURNS,
  DEFAULT_GRUNT_PARENT_CONTEXT_CHARS,
  DEFAULT_GRUNT_TIMEOUT_MS,
  defaultThinkingLevels,
  gruntMaxCostUsd,
  gruntMaxTurns,
  gruntMode,
  gruntParentContextChars,
  gruntThinkingLevels,
  gruntTimeoutMs,
  isGruntEnabled,
  loadConfig,
  parseModelRef,
  saveConfig,
  thinkingLevels,
} from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";
import { DIRECT_WORKER_PROMPT, WORKER_PROMPT } from "../src/prompts.ts";

const scratch = () => mkdtemp(join(tmpdir(), "grunt-config-"));
const withEnv = async (values: Record<string, string | undefined>, run: () => Promise<void>) => {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test("config is atomic, validated, and preserves legacy config fields", async () => {
  const dir = await scratch();
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

test("worker setting defaults and bounds are centralized", () => {
  assert.equal(gruntTimeoutMs(undefined), DEFAULT_GRUNT_TIMEOUT_MS);
  assert.equal(gruntTimeoutMs("120000"), 120000);
  assert.throws(() => gruntTimeoutMs("0"), /invalid/);
  assert.equal(gruntMaxTurns(undefined), DEFAULT_GRUNT_MAX_TURNS);
  assert.equal(gruntMaxTurns("3"), 3);
  assert.throws(() => gruntMaxTurns(1_001), /invalid/);
  assert.equal(gruntMaxCostUsd(undefined), DEFAULT_GRUNT_MAX_COST_USD);
  assert.equal(gruntMaxCostUsd("0.5"), 0.5);
  assert.throws(() => gruntMaxCostUsd("0"), /invalid/);
  assert.equal(gruntParentContextChars(undefined), DEFAULT_GRUNT_PARENT_CONTEXT_CHARS);
  assert.equal(gruntParentContextChars("1200"), 1200);
  assert.throws(() => gruntParentContextChars("12001"), /invalid/);
});

test("web settings persist worker limits and prompt", async () => {
  const agentDir = await scratch();
  const current = await readSettings({ agentDir });
  await updateSettings(
    {
      ...current,
      mode: "session",
      timeoutMs: 120_000,
      maxTurns: 12,
      maxCostUsd: 3,
      parentContextChars: 1_200,
      prompt: { mode: "append", text: "Report focused checks." },
    },
    { agentDir },
  );
  const saved = await readSettings({ agentDir });
  assert.deepEqual(saved.prompt, { mode: "append", text: "Report focused checks." });
  assert.equal(saved.promptDefaultText, `Isolated mode:\n${WORKER_PROMPT}\n\nDirect mode:\n${DIRECT_WORKER_PROMPT}`);
  assert.deepEqual((await loadConfig(join(agentDir, "pi-grunt", "config.json"))).prompt, {
    mode: "append",
    text: "Report focused checks.",
  });
  await assert.rejects(updateSettings({ ...saved, maxCostUsd: 0 }, { agentDir }), /invalid Grunt/);
});

test("environment fallbacks apply only when a worker setting is not persisted", async () => {
  await withEnv(
    {
      PI_GRUNT_TIMEOUT_MS: "240000",
      PI_GRUNT_MAX_TURNS: "7",
      PI_GRUNT_MAX_COST_USD: "4",
      PI_GRUNT_PARENT_CONTEXT_CHARS: "800",
    },
    async () => {
      const agentDir = await scratch();
      await saveConfig({ version: 1, disabled: false, maxTurns: 9 }, join(agentDir, "pi-grunt", "config.json"));
      const settings = await readSettings({ agentDir });
      assert.equal(settings.timeoutMs, 240_000);
      assert.equal(settings.maxTurns, 9);
      assert.equal(settings.maxCostUsd, 4);
      assert.equal(settings.parentContextChars, 800);
    },
  );
});

test("worker thinking defaults to medium/high and supports a configured allowlist", () => {
  assert.deepEqual(defaultThinkingLevels, ["medium", "high"]);
  assert.deepEqual(gruntThinkingLevels({ version: 1 }), ["medium", "high"]);
  assert.deepEqual(thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("model refs preserve colon model IDs", () => {
  assert.deepEqual(parseModelRef("ollama/qwen:7b"), { provider: "ollama", id: "qwen:7b" });
  assert.equal(parseModelRef("worker"), undefined);
});
