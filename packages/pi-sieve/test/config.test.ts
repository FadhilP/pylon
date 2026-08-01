import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configuredActivePruning,
  configuredProjectionMode,
  configuredThreshold,
  loadConfig,
  saveConfig,
} from "../src/config.ts";
import { SIEVE_THRESHOLD } from "../src/sieve.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

test("sieve config persists active pruning and threshold atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-sieve-config-"));
  const path = join(directory, "nested", "config.json");

  assert.deepEqual(await loadConfig(path), { version: 1 });
  await saveConfig({ version: 1, activePruning: true, threshold: 12_000, projectionMode: "legacy" }, path);
  assert.deepEqual(await loadConfig(path), { version: 1, activePruning: true, threshold: 12_000, projectionMode: "legacy" });
  assert.match(await readFile(path, "utf8"), /"threshold": 12000/);

  await saveConfig({ version: 1, activePruning: false, threshold: SIEVE_THRESHOLD }, path);
  assert.deepEqual(await loadConfig(path), {
    version: 1,
    activePruning: false,
    threshold: SIEVE_THRESHOLD,
  });
});

test("web settings round-trip projection mode", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-sieve-web-settings-"));
  assert.deepEqual(await readSettings({ agentDir }), {
    kind: "sieve",
    activePruning: true,
    threshold: SIEVE_THRESHOLD,
    projectionMode: "stable",
  });
  await updateSettings({ kind: "sieve", activePruning: false, threshold: 12_000, projectionMode: "legacy" }, { agentDir });
  assert.deepEqual(await readSettings({ agentDir }), {
    kind: "sieve",
    activePruning: false,
    threshold: 12_000,
    projectionMode: "legacy",
  });
  await assert.rejects(updateSettings({ kind: "sieve", activePruning: true, threshold: 12_000, projectionMode: "invalid" }, { agentDir }));
});

test("sieve config defaults safely and quarantines invalid settings", async () => {
  assert.equal(configuredActivePruning({ version: 1 }), true);
  assert.equal(configuredThreshold({ version: 1 }), SIEVE_THRESHOLD);
  assert.equal(configuredProjectionMode({ version: 1 }), "stable");
  assert.equal(configuredProjectionMode({ version: 1, projectionMode: "legacy" }), "legacy");

  for (const value of [
    [],
    { version: 1, activePruning: "yes" },
    { version: 1, projectionMode: "mutable" },
    { version: 1, threshold: 999 },
    { version: 1, threshold: 50_001 },
    { version: 1, threshold: 1_000.5 },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "pi-sieve-invalid-"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify(value));
    assert.deepEqual(await loadConfig(path), { version: 1 });
    assert.ok((await readdir(directory)).some((name) => name.startsWith("config.json.corrupt-")));
  }

  const unreadable = await mkdtemp(join(tmpdir(), "pi-sieve-unreadable-"));
  await assert.rejects(loadConfig(unreadable));

  const blockedDirectory = await mkdtemp(join(tmpdir(), "pi-sieve-blocked-"));
  const blocker = join(blockedDirectory, "not-a-directory");
  await writeFile(blocker, "block");
  await assert.rejects(
    saveConfig({ version: 1, activePruning: true, threshold: SIEVE_THRESHOLD }, join(blocker, "config.json")),
  );
});
