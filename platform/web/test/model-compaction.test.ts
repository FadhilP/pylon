import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { SettingsManager, shouldCompact } from "@earendil-works/pi-coding-agent";
import {
  contextUsageMetrics,
  modelCompactionSettings,
  updateModelCompaction,
} from "../src/server/settings/model-compaction.ts";
import { SessionRuntime } from "../src/server/runtime/session-runtime.ts";
import { RuntimeCoordinator } from "../src/server/runtime/runtime-coordinator.ts";

const model = { provider: "test", id: "large/model", contextWindow: 1_000_000 };
const input = { provider: model.provider, modelId: model.id, compactAtTokens: 500_000, expectedReserveTokens: null };

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pylon-model-compaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  const path = join(agentDir, "settings.json");
  return { root, agentDir, cwd, path };
}

test("context budget tracks the model's compaction boundary without changing provider capacity", () => {
  const manager = SettingsManager.inMemory({
    compaction: { modelOverrides: { "test/large/model": { reserveTokens: 500_000 } } },
  });
  const settings = manager.getCompactionSettings(model);
  const usage = { tokens: 250_000, contextWindow: model.contextWindow, percent: 25 };
  const metrics = contextUsageMetrics(usage, settings);
  assert.equal(metrics.contextPercent, 50);
  assert.equal(metrics.contextBudget, 500_000);
  assert.equal(metrics.contextLimit, 1_000_000);
  for (const tokens of [499_999, 500_000, 500_001, 550_000]) {
    const current = contextUsageMetrics({ ...usage, tokens }, settings);
    assert.equal(current.contextPercent > 100, shouldCompact(tokens, model.contextWindow, settings));
  }
  const other = manager.getCompactionSettings({ provider: "test", id: "other" });
  assert.equal(contextUsageMetrics(usage, other).contextBudget, model.contextWindow - other.reserveTokens);
  const disabled = { ...settings, enabled: false };
  assert.equal(shouldCompact(550_000, model.contextWindow, disabled), false);
  assert.equal(contextUsageMetrics(usage, disabled).contextPercent, 25);
  assert.equal(contextUsageMetrics(usage, disabled).contextBudget, model.contextWindow);
});

test("unknown usage and unusable compaction thresholds keep context metrics finite", () => {
  const settings = { enabled: true, reserveTokens: 500_000 };
  assert.deepEqual(contextUsageMetrics(undefined, settings), {
    contextTokens: 0,
    contextLimit: 0,
    contextBudget: 0,
    contextPercent: 0,
  });
  const unknown = { tokens: null, contextWindow: model.contextWindow, percent: null };
  assert.equal(contextUsageMetrics(unknown, settings).contextPercent, 0);
  assert.equal(contextUsageMetrics(unknown, settings).contextBudget, 500_000);
  for (const reserveTokens of [1_000_000, 2_000_000, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const metrics = contextUsageMetrics({ ...unknown, tokens: 250_000 }, { ...settings, reserveTokens });
    assert.equal(metrics.contextBudget, model.contextWindow);
    assert.equal(metrics.contextPercent, 25);
  }
  const invalid = contextUsageMetrics(
    { tokens: Number.NaN, contextWindow: Number.POSITIVE_INFINITY, percent: null },
    settings,
  );
  assert.ok(Object.values(invalid).every(Number.isFinite));
});

test("per-model triggers affect Pi threshold checks and reset without changing other settings", async t => {
  const { agentDir, cwd, path } = await fixture(t);
  const original = {
    theme: "dark",
    compaction: {
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
      modelOverrides: { "test/large/model": { keepRecentTokens: 30_000 }, "other/model": { reserveTokens: 50_000 } },
    },
  };
  await writeFile(path, JSON.stringify(original));
  await updateModelCompaction(agentDir, model.contextWindow, input);
  const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const settings = manager.getCompactionSettings(model);
  assert.equal(shouldCompact(500_000, model.contextWindow, settings), false);
  assert.equal(shouldCompact(500_001, model.contextWindow, settings), true);
  assert.equal(settings.keepRecentTokens, 30_000);
  assert.equal(
    shouldCompact(500_001, model.contextWindow, manager.getCompactionSettings({ provider: "test", id: "another" })),
    false,
  );
  assert.equal(model.contextWindow, 1_000_000);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(saved.compaction.modelOverrides["other/model"], original.compaction.modelOverrides["other/model"]);
  const displayed = modelCompactionSettings(
    model,
    manager.getGlobalSettings().compaction,
    manager.getSettings().compaction,
  )!;
  await updateModelCompaction(agentDir, model.contextWindow, {
    ...input,
    compactAtTokens: null,
    expectedReserveTokens: displayed.reserveTokens,
  });
  await manager.reload();
  assert.equal(shouldCompact(500_001, model.contextWindow, manager.getCompactionSettings(model)), false);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);
});

test("reset preserves trusted project overrides without exposing them to untrusted projects", async t => {
  const { agentDir, cwd } = await fixture(t);
  await updateModelCompaction(agentDir, model.contextWindow, input);
  await mkdir(join(cwd, ".pi"));
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ compaction: { modelOverrides: { "test/large/model": { reserveTokens: 600_000 } } } }),
  );
  const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const displayed = modelCompactionSettings(
    model,
    manager.getGlobalSettings().compaction,
    manager.getSettings().compaction,
  )!;
  assert.equal(shouldCompact(400_001, model.contextWindow, manager.getCompactionSettings(model)), true);
  const usage = { tokens: 400_001, contextWindow: model.contextWindow, percent: 40.0001 };
  assert.equal(contextUsageMetrics(usage, manager.getCompactionSettings(model)).contextBudget, 400_000);
  await updateModelCompaction(agentDir, model.contextWindow, {
    ...input,
    compactAtTokens: null,
    expectedReserveTokens: displayed.reserveTokens,
  });
  await manager.reload();
  assert.equal(shouldCompact(400_001, model.contextWindow, manager.getCompactionSettings(model)), true);
  manager.setProjectTrusted(false);
  assert.equal(shouldCompact(400_001, model.contextWindow, manager.getCompactionSettings(model)), false);
  assert.equal(
    contextUsageMetrics(usage, manager.getCompactionSettings(model)).contextBudget,
    model.contextWindow - manager.getCompactionReserveTokens(model),
  );
});

test("concurrent writes preserve other models and reject a stale same-model write", async t => {
  const { agentDir, path } = await fixture(t);
  const outcomes = await Promise.allSettled([
    updateModelCompaction(agentDir, model.contextWindow, input),
    updateModelCompaction(agentDir, model.contextWindow, { ...input, compactAtTokens: 400_000 }),
    updateModelCompaction(agentDir, model.contextWindow, { ...input, modelId: "other/model" }),
  ]);
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 2);
  const rejected = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult;
  assert.match(rejected.reason.message, /changed; reload/);
  const saved = JSON.parse(await readFile(path, "utf8"));
  assert.ok([500_000, 600_000].includes(saved.compaction.modelOverrides["test/large/model"].reserveTokens));
  assert.equal(saved.compaction.modelOverrides["test/other/model"].reserveTokens, 500_000);
});

test("invalid or unsafe triggers and malformed existing settings never overwrite the file", async t => {
  const { agentDir, path } = await fixture(t);
  const original = JSON.stringify({ compaction: { reserveTokens: 100_000, enabled: false } });
  await writeFile(path, original);
  for (const compactAtTokens of [0, -1, 0.5, 900_001, 1_000_001, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      updateModelCompaction(agentDir, model.contextWindow, { ...input, compactAtTokens }),
      /positive whole token count/,
    );
    assert.equal(await readFile(path, "utf8"), original);
  }
  await updateModelCompaction(agentDir, model.contextWindow, { ...input, compactAtTokens: 900_000 });
  const manager = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  assert.equal(
    shouldCompact(950_000, model.contextWindow, manager.getCompactionSettings(model)),
    false,
    "saving a trigger must not enable compaction",
  );
  for (const malformed of [
    "{",
    "[]",
    '{"compaction":[]}',
    '{"compaction":{"modelOverrides":[]}}',
    '{"compaction":{"modelOverrides":{"test/large/model":null}}}',
    '{"compaction":{"reserveTokens":null}}',
  ]) {
    await writeFile(path, malformed);
    await assert.rejects(updateModelCompaction(agentDir, model.contextWindow, input));
    assert.equal(await readFile(path, "utf8"), malformed);
  }
});

test("runtime updates reload compaction settings without losing Pylon overrides and reject busy or unavailable models", async t => {
  const { agentDir, cwd, path } = await fixture(t);
  await writeFile(path, JSON.stringify({ defaultTools: ["+read"] }));
  const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  manager.applyOverrides({ defaultModel: "configured-model", defaultTools: ["+codemode"] });
  const toolsBefore = manager.getDefaultTools();
  let idle = true;
  let snapshots = 0;
  const runtime = { services: { settingsManager: manager, modelRuntime: { getAvailableSnapshot: () => [model] } } };
  const driver: any = {
    target: { agentDir },
    canSleep: () => idle,
    requireRuntime: () => runtime,
    withSettingsUpdate: (action: () => Promise<void>) => action(),
    refreshSnapshot: () => snapshots++,
    refreshCompactionSettings: () => SessionRuntime.prototype.refreshCompactionSettings.call(driver),
  };
  await SessionRuntime.prototype.setModelCompaction.call(driver, input);
  assert.equal(shouldCompact(500_001, model.contextWindow, manager.getCompactionSettings(model)), true);
  assert.equal(manager.getDefaultModel(), "configured-model");
  assert.deepEqual(manager.getDefaultTools(), toolsBefore);
  assert.equal(snapshots, 1);
  const restoredTools = manager.getSettings().defaultTools;
  await driver.refreshCompactionSettings();
  assert.deepEqual(manager.getSettings().defaultTools, restoredTools, "reloading must not accumulate tool modifiers");
  const saved = await readFile(path, "utf8");
  idle = false;
  await assert.rejects(
    SessionRuntime.prototype.setModelCompaction.call(driver, {
      ...input,
      compactAtTokens: null,
      expectedReserveTokens: 500_000,
    }),
    /idle/,
  );
  idle = true;
  await assert.rejects(
    SessionRuntime.prototype.setModelCompaction.call(driver, { ...input, modelId: "missing" }),
    /unavailable/,
  );
  assert.equal(await readFile(path, "utf8"), saved);
});

test("coordinator blocks writes while any session has work and refreshes idle sibling runtimes", async () => {
  const coordinator = new RuntimeCoordinator();
  const internal = coordinator as any;
  const effects: string[] = [];
  let siblingIdle = false;
  const selected = {
    id: "selected",
    driver: {
      canSleep: () => true,
      setModelCompaction: async () => {
        effects.push("save and refresh selected");
      },
    },
  };
  const sibling = {
    id: "sibling",
    queuedPrompts: [] as unknown[],
    driver: {
      canSleep: () => siblingIdle,
      refreshCompactionSettings: async () => {
        effects.push("refresh sibling");
      },
    },
  };
  internal.selectedId = selected.id;
  internal.slots.set(selected.id, selected);
  internal.slots.set(sibling.id, sibling);
  try {
    await assert.rejects(coordinator.setModelCompaction(input), /every session is idle/);
    assert.deepEqual(effects, []);
    siblingIdle = true;
    sibling.queuedPrompts.push({});
    await assert.rejects(coordinator.setModelCompaction(input), /every session is idle/);
    sibling.queuedPrompts.length = 0;
    await coordinator.setModelCompaction(input);
    assert.deepEqual(effects, ["save and refresh selected", "refresh sibling"]);
  } finally {
    internal.slots.clear();
    await coordinator.dispose();
  }
});
