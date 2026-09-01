import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, defaultConfig, effectiveConfig, loadConfig } from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

const deferred = {
  version: 1 as const,
  agentAvailability: "deferred" as const,
  sessionAvailability: "deferred" as const,
};
const allThinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const primitiveDefaults = {
  spawnTimeoutMs: 0,
  recentThreadLimit: 8,
  recentThreadMaxChars: 800,
  recentThreadTotalChars: 12_000,
};

test("Spawn custom settings preserve model validation and persist transcript defaults", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-spawn-config-"));
  try {
    assert.deepEqual(defaultConfig(), deferred);
    assert.deepEqual(await readSettings({ agentDir }), {
      kind: "spawn",
      agentAvailability: "deferred",
      sessionAvailability: "deferred",
      agentThinkingLevels: allThinking,
      ...primitiveDefaults,
    });

    await updateSettings(
      {
        kind: "spawn",
        agentAvailability: "active",
        sessionAvailability: "deferred",
        models: ["custom/model"],
        agentThinkingLevels: ["low", "high"],
        spawnTimeoutMs: 4_000,
        recentThreadLimit: 4,
        recentThreadMaxChars: 400,
        recentThreadTotalChars: 4_000,
      },
      { agentDir },
    );
    assert.deepEqual(await readSettings({ agentDir }), {
      kind: "spawn",
      agentAvailability: "active",
      sessionAvailability: "deferred",
      models: ["custom/model"],
      agentThinkingLevels: ["low", "high"],
      spawnTimeoutMs: 4_000,
      recentThreadLimit: 4,
      recentThreadMaxChars: 400,
      recentThreadTotalChars: 4_000,
    });
    assert.deepEqual(JSON.parse(await readFile(configPath(agentDir), "utf8")), {
      version: 1,
      agentAvailability: "active",
      sessionAvailability: "deferred",
      models: ["custom/model"],
      agentThinkingLevels: ["low", "high"],
      spawnTimeoutMs: 4_000,
      recentThreadLimit: 4,
      recentThreadMaxChars: 400,
      recentThreadTotalChars: 4_000,
    });
    await assert.rejects(
      updateSettings(
        {
          kind: "spawn",
          agentAvailability: "sometimes",
          sessionAvailability: "active",
          agentThinkingLevels: ["high"],
          ...primitiveDefaults,
        },
        { agentDir },
      ),
      /invalid Spawn settings/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("PI_SPAWN_TIMEOUT_MS is used only when spawn timeout is not persisted", async () => {
  const previous = process.env.PI_SPAWN_TIMEOUT_MS;
  process.env.PI_SPAWN_TIMEOUT_MS = "5000";
  try {
    assert.equal(effectiveConfig(deferred).spawnTimeoutMs, 5_000);
    assert.equal(effectiveConfig({ ...deferred, spawnTimeoutMs: 0 }).spawnTimeoutMs, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_SPAWN_TIMEOUT_MS;
    else process.env.PI_SPAWN_TIMEOUT_MS = previous;
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
