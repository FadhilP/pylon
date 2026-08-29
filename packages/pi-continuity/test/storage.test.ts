import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJson, readVersionedJson, updateJson } from "../src/storage.ts";

test("concurrent JSON updates do not lose writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-update-"));
  try {
    const path = join(root, "state.json");
    await Promise.all(
      Array.from({ length: 20 }, (_, value) =>
        updateJson<number[]>(
          path,
          [],
          (items) => [...items, value],
          Array.isArray,
        ),
      ),
    );
    const items = await readJson<number[]>(path, [], Array.isArray);
    assert.equal(items.length, 20);
    assert.equal(new Set(items).size, 20);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed versioned state is quarantined while missing state uses fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-versioned-"));
  try {
    const path = join(root, "state.json");
    assert.deepEqual(
      await readVersionedJson(
        path,
        { version: 1 },
        (value) => value?.version === 1,
      ),
      { version: 1 },
    );
    await writeFile(path, "{bad json");
    assert.deepEqual(
      await readVersionedJson(
        path,
        { version: 1 },
        (value) => value?.version === 1,
      ),
      { version: 1 },
    );
    assert.ok(
      (await readdir(root)).some((name) =>
        name.startsWith("state.json.reset-unsupported-"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dead stale lock is removed only after owner fencing is checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-lock-"));
  try {
    const path = join(root, "state.json"),
      lock = `${path}.lock`;
    await mkdir(lock);
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({
        version: 1,
        token: "dead-owner",
        pid: 999_999_999,
        createdAt: "2000-01-01T00:00:00Z",
      }),
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const result = await updateJson<number[]>(
      path,
      [],
      (items) => [...items, 1],
      Array.isArray,
    );
    assert.deepEqual(result, [1]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
