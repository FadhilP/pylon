import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultConfig, loadConfig, parseModelRef, saveConfig, timelineSettingFields } from "../src/config.ts";
import { readSettings, updateSettings } from "../src/web-settings.ts";
import { packageSettingDefaults } from "pylon-core/package-settings";
import {
  CHECKPOINT_TITLE_PROMPT,
  SESSION_TITLE_IMMUTABLE_FOOTER,
  SESSION_TITLE_PROMPT,
  sessionTitlePrompt,
} from "../src/prompts.ts";

const runtimeSettings = { gitTimeoutMs: 120_000, titleTimeoutMs: 30_000, titleMaxTokens: 32, titleChangedFiles: 20 };
const timelinePromptDefaultText = `Session titles:\n${SESSION_TITLE_PROMPT}\n\nCheckpoint titles:\n${CHECKPOINT_TITLE_PROMPT}`;

test("Timeline naming customization remains append-only before its output footer", () => {
  assert.equal(sessionTitlePrompt(), SESSION_TITLE_PROMPT);
  const prompt = sessionTitlePrompt({ mode: "append", text: "Use repository vocabulary." });
  assert.match(prompt, /## Operator customization\nUse repository vocabulary\./);
  assert.ok(prompt.endsWith(SESSION_TITLE_IMMUTABLE_FOOTER));
});
test("Timeline settings preserve title modes and persist bounded runtime settings", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-timeline-config-"));
  try {
    assert.deepEqual(defaultConfig(), { version: 1, editRollbackDefault: false });
    assert.deepEqual(await readSettings({ agentDir }), {
      kind: "timeline",
      defaults: packageSettingDefaults(timelineSettingFields),
      editRollbackDefault: false,
      checkpointTitleMode: "disabled",
      ...runtimeSettings,
      prompt: { mode: "default", text: "" },
      promptDefaultText: timelinePromptDefaultText,
    });
    await updateSettings(
      {
        kind: "timeline",
        editRollbackDefault: true,
        checkpointTitleMode: "model",
        checkpointTitleModel: "provider/cheap-model",
        gitTimeoutMs: 240_000,
        titleTimeoutMs: 45_000,
        titleMaxTokens: 64,
        titleChangedFiles: 50,
        prompt: { mode: "append", text: "Prefer project terminology." },
      },
      { agentDir },
    );
    assert.deepEqual(await readSettings({ agentDir }), {
      kind: "timeline",
      defaults: packageSettingDefaults(timelineSettingFields),
      editRollbackDefault: true,
      checkpointTitleMode: "model",
      checkpointTitleModel: "provider/cheap-model",
      gitTimeoutMs: 240_000,
      titleTimeoutMs: 45_000,
      titleMaxTokens: 64,
      titleChangedFiles: 50,
      prompt: { mode: "append", text: "Prefer project terminology." },
      promptDefaultText: timelinePromptDefaultText,
    });
    const path = join(agentDir, "pi-timeline", "config.json");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      version: 1,
      editRollbackDefault: true,
      checkpointTitleModel: "provider/cheap-model",
      gitTimeoutMs: 240_000,
      titleTimeoutMs: 45_000,
      titleMaxTokens: 64,
      titleChangedFiles: 50,
      prompt: { mode: "append", text: "Prefer project terminology." },
    });
    await updateSettings(
      {
        kind: "timeline",
        editRollbackDefault: false,
        checkpointTitleMode: "session",
        ...runtimeSettings,
        prompt: { mode: "default", text: "" },
      },
      { agentDir },
    );
    assert.deepEqual(await readSettings({ agentDir }), {
      kind: "timeline",
      defaults: packageSettingDefaults(timelineSettingFields),
      editRollbackDefault: false,
      checkpointTitleMode: "session",
      ...runtimeSettings,
      prompt: { mode: "default", text: "" },
      promptDefaultText: timelinePromptDefaultText,
    });
    await assert.rejects(
      updateSettings(
        { kind: "timeline", editRollbackDefault: false, checkpointTitleMode: "model", ...runtimeSettings },
        { agentDir },
      ),
      /invalid Timeline settings/,
    );
    await assert.rejects(
      updateSettings(
        {
          kind: "timeline",
          editRollbackDefault: false,
          checkpointTitleMode: "disabled",
          ...runtimeSettings,
          titleMaxTokens: 7,
        },
        { agentDir },
      ),
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
