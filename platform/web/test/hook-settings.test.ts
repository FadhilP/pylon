import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultHookSettings,
  HookSettingsStore,
} from "../src/server/pi/hook-settings.ts";

const settings = {
  sessionStart: {
    enabled: true,
    sources: [
      { id: "start", name: "Start", kind: "text" as const, content: "hello" },
    ],
  },
  beforeAgentStart: { enabled: false, sources: [] },
};

test("hook settings use safe defaults, validate persisted values, and persist atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-hooks-"));
  const store = new HookSettingsStore(root);
  try {
    const defaults = defaultHookSettings();
    assert.deepEqual(await store.read(), defaults);
    await store.update(settings);
    const normalized = await store.read();
    assert.equal(
      normalized.sessionStart.sources[0]?.reinjectOnCompaction,
      false,
    );
    await writeFile(store.path, JSON.stringify({ version: 1, settings }));
    assert.equal(
      (await store.read()).sessionStart.sources[0]?.reinjectOnCompaction,
      false,
    );
    await writeFile(store.path, '{"version":1,"settings":{}}');
    await assert.rejects(store.read(), /hook settings config is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
