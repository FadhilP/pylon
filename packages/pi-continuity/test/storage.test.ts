import test from "node:test";
import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJson, readVersionedJson, updateJson, withFileLock } from "../src/storage.ts";

test("concurrent JSON updates do not lose writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-update-"));
  try {
    const path = join(root, "state.json");
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, value) =>
        updateJson<number[]>(path, [], items => [...items, value], Array.isArray),
      ),
    );
    // Do not delete the fixture while other writers are still running after a rejection.
    for (const result of results) if (result.status === "rejected") throw result.reason;
    const items = await readJson<number[]>(path, [], Array.isArray);
    assert.equal(items.length, 20);
    assert.equal(new Set(items).size, 20);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("lock acquisition errors preserve their cause and never run the protected task", async t => {
  const root = await mkdtemp(join(tmpdir(), "continuity-lock-error-"));
  const path = join(root, "state.json");
  const failure = Object.assign(new Error("access denied"), { code: "EACCES" });
  const makeDirectory = fs.mkdir;
  const mocked = t.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
    if (args[0] === `${path}.lock`) throw failure;
    return Reflect.apply(makeDirectory, fs, args);
  });
  syncBuiltinESMExports();
  let ran = false;
  try {
    await assert.rejects(
      withFileLock(path, async () => { ran = true; }),
      { cause: failure },
    );
    assert.equal(ran, false);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("malformed versioned state is quarantined while missing state uses fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-versioned-"));
  try {
    const path = join(root, "state.json");
    assert.deepEqual(await readVersionedJson(path, { version: 1 }, value => value?.version === 1), { version: 1 });
    await writeFile(path, "{bad json");
    assert.deepEqual(await readVersionedJson(path, { version: 1 }, value => value?.version === 1), { version: 1 });
    assert.ok((await readdir(root)).some(name => name.startsWith("state.json.reset-unsupported-")));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
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
      JSON.stringify({ version: 1, token: "dead-owner", pid: 999_999_999, createdAt: "2000-01-01T00:00:00Z" }),
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const result = await updateJson<number[]>(path, [], items => [...items, 1], Array.isArray);
    assert.deepEqual(result, [1]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
