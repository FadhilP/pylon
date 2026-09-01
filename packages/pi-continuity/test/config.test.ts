import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_KEEP_RECENT_TOKENS,
  defaultConfig,
  loadConfig,
  parseModelRef,
  saveConfig,
  updateConfig,
} from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

test("model profiles parse, persist, and reset to defaults", async () => {
  assert.deepEqual(parseModelRef("provider/model:high"), { provider: "provider", id: "model", thinking: "high" });
  assert.deepEqual(parseModelRef("provider/model:version"), { provider: "provider", id: "model:version" });
  const root = await mkdtemp(join(tmpdir(), "continuity-config-"));
  const path = join(root, "config.json");
  await saveConfig(
    {
      version: 2,
      memoryEnabled: false,
      keepRecentTokens: 31_000,
      planner: { model: "provider/planner", thinking: "high" },
      executor: { model: "provider/executor" },
      compactionReviewer: { model: "provider/compaction", thinking: "low" },
    },
    path,
  );
  assert.deepEqual(await loadConfig(path), {
    version: 2,
    memoryEnabled: false,
    keepRecentTokens: 31_000,
    planner: { model: "provider/planner", thinking: "high" },
    executor: { model: "provider/executor" },
    compactionReviewer: { model: "provider/compaction", thinking: "low" },
  });
  assert.deepEqual(defaultConfig(), { version: 2, memoryEnabled: true, keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS });
});

test("legacy configs gain the retained-token default without losing profiles", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-config-migration-"));
  for (const version of [1, 2]) {
    const path = join(root, `v${version}.json`);
    await writeFile(
      path,
      JSON.stringify({ version, memoryEnabled: false, planner: { model: "provider/planner", thinking: "high" } }),
    );
    assert.deepEqual(await loadConfig(path), {
      version: 2,
      memoryEnabled: false,
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
      planner: { model: "provider/planner", thinking: "high" },
    });
  }
});

test("retained-token bounds are strict and inclusive", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-config-budget-"));
  for (const keepRecentTokens of [1_000, 50_000]) {
    const path = join(root, `${keepRecentTokens}.json`);
    await saveConfig({ version: 2, keepRecentTokens }, path);
    assert.equal((await loadConfig(path)).keepRecentTokens, keepRecentTokens);
  }
  for (const keepRecentTokens of [999, 50_001, 25_000.5]) {
    await assert.rejects(
      saveConfig({ version: 2, keepRecentTokens }, join(root, `invalid-${keepRecentTokens}.json`)),
      /invalid Continuity config/,
    );
  }
});

test("concurrent role updates retain independent Continuity settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-config-race-")),
    path = join(root, "config.json");
  await Promise.all([
    updateConfig(config => ({ ...config, planner: { model: "provider/planner" } }), path),
    updateConfig(config => ({ ...config, memoryReviewer: { model: "provider/reviewer", thinking: "high" } }), path),
  ]);
  const config = await loadConfig(path);
  assert.equal(config.planner?.model, "provider/planner");
  assert.equal(config.memoryReviewer?.model, "provider/reviewer");
});

test("web settings persist the global compaction reserve without changing unrelated Pi settings", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "continuity-settings-"));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({ theme: "dark", compaction: { enabled: true, keepRecentTokens: 20_000 } }),
  );
  assert.deepEqual(await readSettings({ agentDir }), {
    kind: "continuity",
    memoryEnabled: true,
    reserveTokens: 16_384,
    keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    compactionReviewTimeoutMs: 60_000,
    compactionReviewerMaxOutputTokens: 1_200,
  });
  await updateSettings(
    {
      kind: "continuity",
      memoryEnabled: false,
      reserveTokens: 24_000,
      keepRecentTokens: 32_000,
      compactionReviewTimeoutMs: 75_000,
      compactionReviewerMaxOutputTokens: 1_500,
      planner: { model: "provider/planner" },
      compactionReviewer: { model: "provider/compaction", thinking: "low" },
    },
    { agentDir },
  );
  assert.deepEqual(await readSettings({ agentDir }), {
    kind: "continuity",
    memoryEnabled: false,
    reserveTokens: 24_000,
    keepRecentTokens: 32_000,
    compactionReviewTimeoutMs: 75_000,
    compactionReviewerMaxOutputTokens: 1_500,
    planner: { model: "provider/planner" },
    compactionReviewer: { model: "provider/compaction", thinking: "low" },
  });
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), {
    theme: "dark",
    compaction: { enabled: true, keepRecentTokens: 20_000, reserveTokens: 24_000 },
  });
  await assert.rejects(
    updateSettings(
      {
        kind: "continuity",
        memoryEnabled: "no",
        reserveTokens: 24_000,
        keepRecentTokens: 25_000,
        compactionReviewTimeoutMs: 60_000,
        compactionReviewerMaxOutputTokens: 1_200,
      },
      { agentDir },
    ),
    /invalid Continuity settings/,
  );
  await assert.rejects(
    updateSettings(
      {
        kind: "continuity",
        memoryEnabled: true,
        reserveTokens: 999,
        keepRecentTokens: 25_000,
        compactionReviewTimeoutMs: 60_000,
        compactionReviewerMaxOutputTokens: 1_200,
      },
      { agentDir },
    ),
    /invalid Continuity settings/,
  );
  await assert.rejects(
    updateSettings(
      {
        kind: "continuity",
        memoryEnabled: true,
        reserveTokens: 24_000,
        keepRecentTokens: 999,
        compactionReviewTimeoutMs: 60_000,
        compactionReviewerMaxOutputTokens: 1_200,
      },
      { agentDir },
    ),
    /invalid Continuity settings/,
  );
});

test("failed Continuity persistence restores an absent global reserve exactly", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "continuity-settings-rollback-"));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
  await writeFile(join(agentDir, "pi-continuity"), "blocks the config directory");
  await assert.rejects(
    updateSettings(
      {
        kind: "continuity",
        memoryEnabled: true,
        reserveTokens: 24_000,
        keepRecentTokens: 25_000,
        compactionReviewTimeoutMs: 60_000,
        compactionReviewerMaxOutputTokens: 1_200,
      },
      { agentDir },
    ),
  );
  assert.deepEqual(JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")), { theme: "dark" });
});
