import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, loadConfig } from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

test("numbered line editing is opt-in and persists through the settings adapter", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pylon-core-settings-"));
  try {
    assert.deepEqual(await readSettings({ agentDir }), { kind: "pylon-core", lineEditEnabled: false });
    await updateSettings({ kind: "pylon-core", lineEditEnabled: true }, { agentDir });
    assert.deepEqual(await loadConfig(configPath(agentDir)), { version: 1, lineEditEnabled: true });
    assert.equal(JSON.parse(await readFile(configPath(agentDir), "utf8")).lineEditEnabled, true);
    await assert.rejects(
      updateSettings({ kind: "pylon-core", lineEditEnabled: "yes" }, { agentDir }),
      /invalid Pylon Core settings/,
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
