import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, effectiveConfig, loadConfig, saveConfig } from "../src/config.ts";
import { loadDelegateRetryPolicy } from "../src/delegate-retry.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

const fieldValues = (settings: any) =>
  Object.fromEntries(settings.fields.map((field: any) => [field.key, field.value]));

test("pylon-core generic settings persist line-edit ratio and delegate retry policy", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pylon-core-settings-"));
  try {
    const settings = await readSettings({ agentDir });
    assert.equal(settings.kind, "generic");
    assert.equal(settings.packageId, "pylon-core");
    assert.deepEqual(fieldValues(settings), {
      lineEditEnabled: true,
      lineEditPriceRatio: 3,
      delegateMaxAttempts: 3,
      delegateRetryBaseMs: 1_000,
    });
    await updateSettings(
      {
        ...settings,
        fields: settings.fields.map((field: any) =>
          field.key === "lineEditEnabled"
            ? { ...field, value: false }
            : field.key === "lineEditPriceRatio"
              ? { ...field, value: 2 }
              : field.key === "delegateMaxAttempts"
                ? { ...field, value: 5 }
                : field.key === "delegateRetryBaseMs"
                  ? { ...field, value: 200 }
                  : field,
        ),
      },
      { agentDir },
    );
    assert.deepEqual(await loadConfig(configPath(agentDir)), {
      version: 1,
      lineEditEnabled: false,
      lineEditPriceRatio: 2,
      delegateMaxAttempts: 5,
      delegateRetryBaseMs: 200,
    });
    assert.equal(JSON.parse(await readFile(configPath(agentDir), "utf8")).lineEditEnabled, false);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("delegate retry policy snapshots the pylon-core config for an operation", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pylon-core-retry-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await saveConfig({ version: 1, lineEditEnabled: true, delegateMaxAttempts: 4, delegateRetryBaseMs: 300 });
    assert.deepEqual(await loadDelegateRetryPolicy(), { maxAttempts: 4, baseMs: 300 });
    assert.equal(effectiveConfig(await loadConfig()).lineEditPriceRatio, 3);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  }
});
