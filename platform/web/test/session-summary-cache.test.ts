import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { mapLimit, SessionSummaryCache, type SessionSummaryCacheOptions } from "../src/server/sessions/session-summary-cache.ts";
import { SessionIndex } from "../src/server/sessions/session-index.ts";

const message = JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }) + "\n";
async function fixture(run: (root: string, paths: string[], cache: SessionSummaryCache) => Promise<void>, options: SessionSummaryCacheOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "session-cache-performance-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const directory = join(root, "sessions", "project");
    await mkdir(directory, { recursive: true });
    const paths = [join(directory, "a.jsonl"), join(directory, "b.jsonl")];
    for (const [index, path] of paths.entries()) {
      await writeFile(
        path,
        JSON.stringify({ type: "session", id: String(index), timestamp: "2026-01-01T00:00:00Z", cwd: root }) +
          "\n" +
          message,
      );
    }
    const cache = new SessionSummaryCache(root, options);
    try { await run(root, paths, cache); } finally { await cache.close(); }
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test("unchanged targeted refresh does not rewrite the cache; edits and deletions still persist", async () => {
  await fixture(async (root, paths, cache) => {
    await cache.scan();
    const cachePath = join(root, "pylon-web", "session-summaries-v4.json");
    const before = await stat(cachePath);
    await delay(20);
    assert.equal((await cache.refresh("0", paths[0]))?.session.messageCount, 1);
    const after = await stat(cachePath);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ino, before.ino);
    await appendFile(paths[0], message);
    assert.equal((await cache.refresh("0", paths[0]))?.session.messageCount, 2);
    await rm(paths[1]);
    assert.equal(await cache.refresh("1", paths[1]), undefined);
    const persisted = JSON.parse(await readFile(cachePath, "utf8")).records;
    assert.deepEqual(
      persisted.map((record: any) => [record.session.id, record.session.messageCount]),
      [["0", 2]],
    );
  });
});

test("batched refresh and concurrent initial operations preserve all session updates", async () => {
  await fixture(async (root, paths, cache) => {
    await Promise.all([cache.scan(), cache.refresh("0", paths[0])]);
    await Promise.all(paths.map(path => appendFile(path, message)));
    const [batch, scan] = await Promise.all([
      cache.refreshMany(paths.map((path, index) => ({ sessionId: String(index), path }))),
      cache.scan(),
    ]);
    assert.deepEqual(
      batch.map(value => value?.session.messageCount),
      [2, 2],
    );
    assert.deepEqual(
      scan.map(value => value.session.messageCount),
      [2, 2],
    );
    const persisted = JSON.parse(await readFile(join(root, "pylon-web", "session-summaries-v4.json"), "utf8")).records;
    assert.deepEqual(
      persisted.map((record: any) => record.session.messageCount),
      [2, 2],
    );
  });
});

test("failed cache persistence is retried even when transcripts remain unchanged", async () => {
  await fixture(async (root, _paths, cache) => {
    const directory = join(root, "pylon-web");
    await writeFile(directory, "block cache directory creation");
    await assert.rejects(cache.scan());
    await rm(directory);
    assert.equal((await cache.scan()).length, 2);
    const persisted = JSON.parse(await readFile(join(directory, "session-summaries-v4.json"), "utf8")).records;
    assert.deepEqual(
      persisted.map((record: any) => record.session.messageCount),
      [1, 1],
    );
  });
});

test("deferred writes coalesce without pushing back the first dirty deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await fixture(async (root, paths, cache) => {
    const save = t.mock.method(cache as unknown as { save(): Promise<void> }, "save");
    const cachePath = join(root, "pylon-web", "session-summaries-v4.json");
    await cache.scan();
    await assert.rejects(stat(cachePath), { code: "ENOENT" });
    t.mock.timers.tick(600);
    await appendFile(paths[0], message);
    assert.equal((await cache.refresh("0", paths[0]))?.metadata.userMessageCount, 2);
    t.mock.timers.tick(399);
    assert.equal(save.mock.callCount(), 0);
    t.mock.timers.tick(1);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    assert.equal(save.mock.callCount(), 1);
    await cache.flush();
    assert.equal(save.mock.callCount(), 1);
    assert.equal(JSON.parse(await readFile(cachePath, "utf8")).records.find((record: any) => record.session.id === "0").userMessageCount, 2);
  }, { deferredPersistence: true });
});

test("deferred persistence reports failure, avoids idle retry loops, and retries dirty state", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors: unknown[] = [];
  await fixture(async (root, paths, cache) => {
    const directory = join(root, "pylon-web");
    await writeFile(directory, "blocked");
    assert.equal((await cache.scan()).length, 2);
    t.mock.timers.tick(1_000);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    await assert.rejects(cache.flush());
    assert.equal(errors.length, 1);
    t.mock.timers.tick(10_000);
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    assert.equal(errors.length, 1);
    await rm(directory);
    assert.equal((await cache.refresh("0", paths[0]))?.metadata.userMessageCount, 1);
    await cache.flush();
    assert.equal(JSON.parse(await readFile(join(directory, "session-summaries-v4.json"), "utf8")).records.length, 2);
  }, { deferredPersistence: true, onBackgroundError: error => { errors.push(error); throw new Error("reporter failed"); } });
});

test("close drains accepted changes even with a queued timer and rejects later work", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await fixture(async (root, paths, cache) => {
    await cache.scan();
    await appendFile(paths[0], message);
    t.mock.timers.tick(1_000);
    const accepted = cache.refresh("0", paths[0]);
    const closing = cache.close();
    assert.equal(cache.close(), closing);
    await Promise.all([accepted, closing, cache.flush()]);
    await assert.rejects(cache.scan(), /closed/);
    await assert.rejects(cache.refresh("0", paths[0]), /closed/);
    t.mock.timers.tick(10_000);
    const records = JSON.parse(await readFile(join(root, "pylon-web", "session-summaries-v4.json"), "utf8")).records;
    assert.equal(records.find((record: any) => record.session.id === "0").userMessageCount, 2);
  }, { deferredPersistence: true });
});

test("metadata loading stays bounded and preserves input order", async () => {
  let active = 0;
  let peak = 0;
  const inputs = Array.from({ length: 48 }, (_, index) => index);
  const values = await mapLimit(inputs, async value => {
    peak = Math.max(peak, ++active);
    await Promise.resolve();
    active--;
    return value * 2;
  });
  assert.equal(peak, 16);
  assert.deepEqual(values, inputs.map(value => value * 2));
});

test("session index metadata observes edits without waiting for the inventory TTL", async () => {
  await fixture(async (root, paths) => {
    const index = new SessionIndex(undefined, root);
    const options = { activeId: "0", generation: 1, stateFor: () => "idle" as const };
    try {
      await index.list({}, options);
      await appendFile(paths[0], message);
      const result = await index.list({}, options);
      assert.equal(result.projects.flatMap(project => project.sessions).find(session => session.id === "0")?.userMessageCount, 2);
      assert.equal(result.activeSessions.find(session => session.id === "0")?.userMessageCount, 2);
      // A synchronous directory reset must drain its old writer before reading a successor cache.
      index.setAgentDir(root);
      assert.equal((await index.list({}, options)).projects.flatMap(project => project.sessions).find(session => session.id === "0")?.userMessageCount, 2);
    } finally { await index.close(); }
  });
});

test("an obsolete index scan cannot publish after a directory reset", async t => {
  await fixture(async root => {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const original = SessionSummaryCache.prototype.scan;
    let first = true;
    t.mock.method(SessionSummaryCache.prototype, "scan", async function (this: SessionSummaryCache) {
      const result = await original.call(this);
      if (first) { first = false; enter(); await released; }
      return result;
    });
    const index = new SessionIndex(undefined, root);
    const options = { activeId: "0", generation: 1, stateFor: () => "sleeping" as const };
    const stale = index.list({}, options).then(() => undefined, error => error);
    try {
      await entered;
      index.setAgentDir(root);
      const current = await index.list({}, options);
      release();
      assert.match(String(await stale), /Session index changed/);
      assert.equal(current.projects.flatMap(project => project.sessions).length, 2);
    } finally { release(); await stale; await index.close(); }
  });
});
