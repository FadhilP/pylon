import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  advisorMaxCalls,
  advisorMaxCostUsd,
  advisorMaxOutputTokens,
  advisorTimeoutMs,
  configPath,
  loadConfig,
  parseModelRef,
  saveConfig,
} from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

test("config persists and malformed config deactivates advisor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "advisor-config-"));
  const path = join(dir, "nested", "config.json");
  await saveConfig({ version: 1, advisorModel: "p/m", thinking: "high" }, path);
  assert.deepEqual(await loadConfig(path), { version: 1, advisorModel: "p/m", thinking: "high" });
  await saveConfig({ version: 1, useMainModel: true }, path);
  assert.deepEqual(await loadConfig(path), { version: 1, useMainModel: true });
  await writeFile(path, "{}");
  assert.deepEqual(await loadConfig(path), { version: 1 });
});

test("unsupported config is quarantined", async () => {
  const dir = await mkdtemp(join(tmpdir(), "advisor-config-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, advisorModel: "p/m" }));
  assert.deepEqual(await loadConfig(path), { version: 1 });
  assert.ok((await readdir(dir)).some(name => name.startsWith("config.json.corrupt-")));
});

test("Advisor settings use persisted values and validate package bounds", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "advisor-web-settings-"));
  await updateSettings(
    {
      kind: "advisor",
      mode: "session",
      maxCalls: 4,
      timeoutMs: 120_000,
      maxCostUsd: 1.25,
      maxOutputTokens: 4_096,
      inputTokenBudget: 40_000,
    },
    { agentDir },
  );
  assert.deepEqual(await readSettings({ agentDir }), {
    kind: "advisor",
    mode: "session",
    maxCalls: 4,
    timeoutMs: 120_000,
    maxCostUsd: 1.25,
    maxOutputTokens: 4_096,
    inputTokenBudget: 40_000,
  });
  const config = await loadConfig(configPath(agentDir));
  assert.equal(advisorMaxCalls(config.maxCalls), 4);
  assert.equal(advisorTimeoutMs(config.timeoutMs), 120_000);
  assert.equal(advisorMaxCostUsd(config.maxCostUsd), 1.25);
  assert.equal(advisorMaxOutputTokens(config.maxOutputTokens), 4_096);
  await assert.rejects(
    updateSettings(
      {
        kind: "advisor",
        mode: "session",
        maxCalls: 0,
        timeoutMs: 120_000,
        maxCostUsd: 1.25,
        maxOutputTokens: 4_096,
        inputTokenBudget: 40_000,
      },
      { agentDir },
    ),
    /invalid Advisor settings/,
  );
});

test("model refs accept thinking suffix without breaking colon model IDs", () => {
  assert.deepEqual(parseModelRef("p/m:high"), { provider: "p", id: "m", thinking: "high" });
  assert.deepEqual(parseModelRef("ollama/qwen:7b"), { provider: "ollama", id: "qwen:7b" });
});
