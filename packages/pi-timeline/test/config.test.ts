import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, loadConfig, parseModelRef, saveConfig } from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";

test("Timeline settings default checkpoint titles off and persist model modes atomically", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-timeline-config-"));
  try {
    assert.deepEqual(defaultConfig(), { version: 1, editRollbackDefault: false });
    assert.deepEqual(await readSettings({ agentDir }), {
      kind: "timeline",
      editRollbackDefault: false,
      checkpointTitleMode: "disabled",
    });
    await updateSettings(
      {
        kind: "timeline",
        editRollbackDefault: true,
        checkpointTitleMode: "model",
        checkpointTitleModel: "provider/cheap-model",
      },
      { agentDir },
    );
    assert.deepEqual(await readSettings({ agentDir }), {
      kind: "timeline",
      editRollbackDefault: true,
      checkpointTitleMode: "model",
      checkpointTitleModel: "provider/cheap-model",
    });
    const path = join(agentDir, "pi-timeline", "config.json");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      version: 1,
      editRollbackDefault: true,
      checkpointTitleModel: "provider/cheap-model",
    });
    await updateSettings(
      { kind: "timeline", editRollbackDefault: false, checkpointTitleMode: "session" },
      { agentDir },
    );
    assert.deepEqual(await readSettings({ agentDir }), {
      kind: "timeline",
      editRollbackDefault: false,
      checkpointTitleMode: "session",
    });
    await assert.rejects(
      updateSettings({ kind: "timeline", editRollbackDefault: false, checkpointTitleMode: "model" }, { agentDir }),
      /invalid Timeline settings/,
    );
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        editRollbackDefault: false,
        checkpointTitleModel: "provider/model",
        useSessionModelForCheckpointTitles: true,
      }),
    );
    await assert.rejects(loadConfig(path), /invalid pi-timeline config/);
    await saveConfig({ version: 1, editRollbackDefault: false }, path);
    assert.equal((await loadConfig(path)).editRollbackDefault, false);
    assert.deepEqual(parseModelRef("provider/model/name"), { provider: "provider", id: "model/name" });
    assert.equal(parseModelRef("model-only"), undefined);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
