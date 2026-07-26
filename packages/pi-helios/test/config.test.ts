import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config.ts";

test("Helios visibility config persists and quarantines invalid input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-helios-config-"));
  const path = join(root, "config.json");
  try {
    assert.deepEqual(await loadConfig(path), { version: 1 });
    await saveConfig({ version: 1, headed: false }, path);
    assert.deepEqual(await loadConfig(path), { version: 1, headed: false });
    await writeFile(path, "{\"version\":1,\"headed\":\"yes\"}");
    assert.deepEqual(await loadConfig(path), { version: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
