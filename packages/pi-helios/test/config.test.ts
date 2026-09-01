import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveConfig, loadConfig, saveConfig } from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

const fieldValues = (settings: any) =>
  Object.fromEntries(settings.fields.map((field: any) => [field.key, field.value]));

test("Helios generic settings expose defaults and persist all operation values", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-helios-web-settings-"));
  try {
    const settings = await readSettings({ agentDir });
    assert.equal(settings.kind, "generic");
    assert.equal(settings.packageId, "pi-helios");
    assert.deepEqual(fieldValues(settings), {
      headed: false,
      androidStartTimeoutMs: 180_000,
      androidInstallTimeoutMs: 600_000,
      browserLeaseIdleMs: 5_000,
      browserResultTabs: 20,
    });
    const update = {
      ...settings,
      fields: settings.fields.map((field: any) =>
        (
          ({
            headed: true,
            androidStartTimeoutMs: 2_000,
            androidInstallTimeoutMs: 3_000,
            browserLeaseIdleMs: 0,
            browserResultTabs: 7,
          }) as Record<string, unknown>
        )[field.key] === undefined
          ? field
          : {
              ...field,
              value: (
                {
                  headed: true,
                  androidStartTimeoutMs: 2_000,
                  androidInstallTimeoutMs: 3_000,
                  browserLeaseIdleMs: 0,
                  browserResultTabs: 7,
                } as Record<string, unknown>
              )[field.key],
            },
      ),
    };
    await updateSettings(update, { agentDir });
    assert.deepEqual(fieldValues(await readSettings({ agentDir })), {
      headed: true,
      androidStartTimeoutMs: 2_000,
      androidInstallTimeoutMs: 3_000,
      browserLeaseIdleMs: 0,
      browserResultTabs: 7,
    });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("Helios config persists effective settings and quarantines invalid input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-helios-config-"));
  const path = join(root, "config.json");
  try {
    assert.deepEqual(effectiveConfig(await loadConfig(path)), {
      version: 1,
      headed: false,
      androidStartTimeoutMs: 180_000,
      androidInstallTimeoutMs: 600_000,
      browserLeaseIdleMs: 5_000,
      browserResultTabs: 20,
    });
    await saveConfig({ version: 1, headed: false, browserResultTabs: 7 }, path);
    assert.deepEqual(await loadConfig(path), { version: 1, headed: false, browserResultTabs: 7 });
    await writeFile(path, '{"version":1,"headed":"yes"}');
    assert.deepEqual(await loadConfig(path), { version: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
