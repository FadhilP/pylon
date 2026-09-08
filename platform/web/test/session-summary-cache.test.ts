import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SessionSummaryCache } from "../src/server/sessions/session-summary-cache.ts";

const message = JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }) + "\n";
async function fixture(run: (root: string, paths: string[], cache: SessionSummaryCache) => Promise<void>) {
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
    await run(root, paths, new SessionSummaryCache(root));
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
