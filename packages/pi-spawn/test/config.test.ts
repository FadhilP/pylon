import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { configPath, defaultConfig, loadConfig } from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

const deferred = {
  version: 1 as const,
  agentAvailability: "deferred" as const,
  sessionAvailability: "deferred" as const,
};

test("spawn tool availability defaults to deferred and persists independently", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-spawn-config-"));
  try {
    assert.deepEqual(defaultConfig(), deferred);
    assert.deepEqual(await readSettings({ agentDir }), {
      kind: "spawn",
      agentAvailability: "deferred",
      sessionAvailability: "deferred",
    });

    await updateSettings({
      kind: "spawn",
      agentAvailability: "active",
      sessionAvailability: "deferred",
    }, { agentDir });
    assert.deepEqual(await readSettings({ agentDir }), {
      kind: "spawn",
      agentAvailability: "active",
      sessionAvailability: "deferred",
    });
    assert.deepEqual(JSON.parse(await readFile(configPath(agentDir), "utf8")), {
      version: 1,
      agentAvailability: "active",
      sessionAvailability: "deferred",
    });
    await assert.rejects(
      updateSettings({ kind: "spawn", agentAvailability: "sometimes", sessionAvailability: "active" }, { agentDir }),
      /invalid Spawn settings/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("combined availability configs migrate both tools without rewriting", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-spawn-legacy-config-"));
  try {
    const path = configPath(agentDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, toolAvailability: "active" }));
    assert.deepEqual(await loadConfig(path), {
      version: 1,
      agentAvailability: "active",
      sessionAvailability: "active",
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, toolAvailability: "active" });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("invalid spawn config is quarantined and safely defaults to deferred", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-spawn-invalid-config-"));
  try {
    const path = configPath(agentDir);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, agentAvailability: "active" }));
    assert.deepEqual(await loadConfig(path), deferred);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
