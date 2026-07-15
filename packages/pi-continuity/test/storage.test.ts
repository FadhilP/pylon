import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJson, updateJson } from "../src/storage.ts";

test("concurrent JSON updates do not lose writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-update-"));
  const path = join(root, "state.json");
  await Promise.all(
    Array.from({ length: 20 }, (_, value) =>
      updateJson<number[]>(path, [], (items) => [...items, value], Array.isArray),
    ),
  );
  const items = await readJson<number[]>(path, [], Array.isArray);
  assert.equal(items.length, 20);
  assert.equal(new Set(items).size, 20);
});
