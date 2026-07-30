import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultHookSettings, HookSettingsStore } from "../src/server/pi/hook-settings.ts";
import { validHookSettings } from "../src/shared/protocol/validation.ts";

const settings = {
  sessionStart: { enabled: true, sources: [{ id: "start", name: "Start", kind: "text" as const, content: "hello" }] },
  beforeAgentStart: { enabled: false, sources: [] },
};

test("hook settings enforce exact bounded sources", () => {
  assert.equal(validHookSettings(settings), true);
  assert.equal(validHookSettings({ ...settings, extra: true }), false);
  assert.equal(validHookSettings({
    sessionStart: { enabled: true, sources: [{ id: "a", name: "A", kind: "text", content: "x".repeat(49 * 1024) }] },
    beforeAgentStart: { enabled: true, sources: [{ id: "b", name: "B", kind: "text", content: "x".repeat(49 * 1024) }] },
  }), false);
});

test("hook settings use safe defaults, validate persisted values, and persist atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-hooks-"));
  const store = new HookSettingsStore(root);
  try {
    const defaults = defaultHookSettings();
    assert.deepEqual(await store.read(), defaults);
    assert.equal(defaults.sessionStart.enabled, true);
    assert.match(defaults.sessionStart.sources[0]?.content ?? "", /^---\nname: ponytail\n/);
    assert.equal(defaults.beforeAgentStart.enabled, true);
    assert.match(defaults.beforeAgentStart.sources[0]?.content ?? "", /ponytail: full intensity for coding decisions\.$/);
    await store.update(settings);
    assert.deepEqual(await store.read(), settings);
    await writeFile(store.path, '{"version":1,"settings":{}}');
    await assert.rejects(store.read(), /hook settings config is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
