import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, loadConfig, parseModelRef, saveConfig, updateConfig } from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

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
      version: 2,
      memoryEnabled: false,
      planner: { model: "provider/planner", thinking: "high" },
      executor: { model: "provider/executor" },
    },
    path,
  );
  assert.deepEqual(await loadConfig(path), {
    version: 2,
    memoryEnabled: false,
    planner: { model: "provider/planner", thinking: "high" },
    executor: { model: "provider/executor" },
  });
  assert.deepEqual(defaultConfig(), { version: 2, memoryEnabled: true });
});

test("concurrent role updates retain independent Continuity settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-config-race-")), path = join(root, "config.json");
  await Promise.all([
    updateConfig((config) => ({ ...config, planner: { model: "provider/planner" } }), path),
    updateConfig((config) => ({ ...config, memoryReviewer: { model: "provider/reviewer", thinking: "high" } }), path),
  ]);
  const config = await loadConfig(path);
  assert.equal(config.planner?.model, "provider/planner"); assert.equal(config.memoryReviewer?.model, "provider/reviewer");
});

test("web settings toggle durable memory without changing model profiles", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "continuity-settings-"));
  assert.deepEqual(await readSettings({ agentDir }), { kind: "continuity", memoryEnabled: true });
  await updateSettings({ kind: "continuity", memoryEnabled: false, planner: { model: "provider/planner" } }, { agentDir });
  assert.deepEqual(await readSettings({ agentDir }), {
    kind: "continuity",
    memoryEnabled: false,
    planner: { model: "provider/planner" },
  });
  await assert.rejects(updateSettings({ kind: "continuity", memoryEnabled: "no" }, { agentDir }), /invalid Continuity settings/);
});
