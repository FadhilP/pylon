import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig } from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

test("papercut settings use supplied agentDir and expose defaults for missing legacy config", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "papercut-settings-"));
  try {
    const initial = await readSettings({ agentDir });
    assert.equal(initial.fields.find(field => field.key === "listDefaultLimit")?.value, 50);
    const update = {
      ...initial,
      fields: initial.fields.map(field => ({ ...field, value: field.key === "queryDefaultLimit" ? 31 : field.value })),
    };
    await updateSettings(update, { agentDir });
    assert.equal((await loadConfig(configPath(agentDir))).queryDefaultLimit, 31);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
