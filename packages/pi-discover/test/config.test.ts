import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, effectiveConfig, loadConfig } from "../src/config.ts";
import { runSearch } from "../src/search-common.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

test("discover settings use supplied agentDir and expose defaults for missing legacy config", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "discover-settings-"));
  try {
    const initial = await readSettings({ agentDir });
    assert.equal(initial.fields.find(field => field.key === "searchTimeoutMs")?.value, 30_000);
    const update = { ...initial, fields: initial.fields.map(field => ({ ...field, value: field.key === "codeResults" ? 17 : field.value })) };
    await updateSettings(update, { agentDir });
    assert.equal((await loadConfig(configPath(agentDir))).codeResults, 17);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("discover search execution uses the configured timeout", async () => {
  let timeout: number | undefined;
  await runSearch(
    { exec: async (_command: string, _args: string[], options: { timeout: number }) => {
      timeout = options.timeout;
      return { code: 0, stdout: "", stderr: "" };
    } } as any,
    "search",
    [],
    { probe: async () => true, timeoutMs: effectiveConfig({ version: 1, searchTimeoutMs: 4_321 }).searchTimeoutMs },
  );
  assert.equal(timeout, 4_321);
});
