import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, loadConfig, saveConfig } from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

test("Timeline edit rollback setting defaults off and persists atomically", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-timeline-config-"));
  try {
    assert.deepEqual(defaultConfig(), { version: 1, editRollbackDefault: false });
    assert.deepEqual(await readSettings({ agentDir }), { kind: "timeline", editRollbackDefault: false });
    await updateSettings({ kind: "timeline", editRollbackDefault: true }, { agentDir });
    assert.deepEqual(await readSettings({ agentDir }), { kind: "timeline", editRollbackDefault: true });
    const path = join(agentDir, "pi-timeline", "config.json");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, editRollbackDefault: true });
    await assert.rejects(
      updateSettings({ kind: "timeline", editRollbackDefault: "yes" }, { agentDir }),
      /invalid Timeline settings/,
    );
    await writeFile(path, JSON.stringify({ version: 1, editRollbackDefault: "yes" }));
    await assert.rejects(loadConfig(path), /invalid pi-timeline config/);
    await saveConfig({ version: 1, editRollbackDefault: false }, path);
    assert.equal((await loadConfig(path)).editRollbackDefault, false);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
