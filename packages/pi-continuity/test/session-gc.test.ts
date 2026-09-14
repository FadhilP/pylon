import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pruneOrphanWorkFiles, startSessionGc } from "../src/session-gc.ts";

const missing = async (path: string) => assert.rejects(access(path));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

test("continuity GC removes deleted-session work and preserves persisted or leased sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-session-gc-"));
  const sessions = join(root, "workspaces", "workspace", "sessions");
  await mkdir(sessions, { recursive: true });
  const file = (id: string) => join(sessions, `${encodeURIComponent(id)}.json`);
  try {
    const releaseLeased = await startSessionGc(
      root,
      "leased",
      async () => {},
      async () => [],
    );
    const releaseSameSession = await startSessionGc(
      root,
      "leased",
      async () => {},
      async () => [],
    );
    for (const id of ["leased", "persisted", "deleted"]) await writeFile(file(id), "{}\n");

    const releaseCurrent = await startSessionGc(
      root,
      "current",
      live => pruneOrphanWorkFiles(root, live),
      async () => [{ id: "persisted" }],
    );
    await releaseCurrent.collect();
    await access(file("leased"));
    await access(file("persisted"));
    await missing(file("deleted"));

    await releaseLeased(() => rm(file("leased"), { force: true }));
    await access(file("leased"));
    await releaseCurrent();
    const releaseNext = await startSessionGc(
      root,
      "next",
      live => pruneOrphanWorkFiles(root, live),
      async () => [{ id: "persisted" }],
    );
    await releaseNext.collect();
    await access(file("leased"));
    await releaseSameSession();
    await releaseNext();

    const releaseFinal = await startSessionGc(
      root,
      "final",
      live => pruneOrphanWorkFiles(root, live),
      async () => [{ id: "persisted" }],
    );
    await releaseFinal.collect();
    await missing(file("leased"));
    await access(file("persisted"));
    await releaseFinal();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuity GC fails closed when persisted-session discovery fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-session-gc-fail-"));
  const sessions = join(root, "workspaces", "workspace", "sessions"),
    orphan = join(sessions, "orphan.json");
  await mkdir(sessions, { recursive: true });
  await writeFile(orphan, "{}\n");
  try {
    const release = await startSessionGc(
      root,
      "current",
      live => pruneOrphanWorkFiles(root, live),
      async () => {
        throw new Error("unavailable");
      },
    );
    await release.collect();
    await access(orphan);
    await release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuity GC fails closed on malformed leases", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-session-gc-malformed-"));
  const sessions = join(root, "workspaces", "workspace", "sessions"),
    orphan = join(sessions, "orphan.json");
  await mkdir(join(root, "session-artifacts"), { recursive: true });
  await mkdir(sessions, { recursive: true });
  await writeFile(join(root, "session-artifacts", "broken.json"), "not json");
  await writeFile(orphan, "{}\n");
  try {
    const release = await startSessionGc(
      root,
      "current",
      live => pruneOrphanWorkFiles(root, live),
      async () => [],
    );
    await release.collect();
    await access(orphan);
    await release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("continuity GC recovers a lock owned by a dead process", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-session-gc-lock-"));
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
  const pid = child.pid!;
  await once(child, "exit");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "session-artifacts.lock"), JSON.stringify({ version: 1, pid, token: "dead" }));
  try {
    let active = 0,
      maxActive = 0;
    const start = (sessionId: string) =>
      startSessionGc(
        root,
        sessionId,
        async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await delay(50);
          active--;
        },
        async () => [],
      );
    const releases = await Promise.all([start("current-a"), start("current-b")]);
    await Promise.all(releases.map(release => release.collect()));
    assert.equal(maxActive, 1, "stale-lock recovery preserves mutual exclusion");
    await Promise.all(releases.map(release => release()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lease publication skips inventory until collection and release drains a running scan", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-session-gc-deferred-"));
  const started = deferred(),
    finish = deferred();
  let scans = 0,
    cleaned = false;
  const release = await startSessionGc(
    root,
    "current",
    async live => {
      assert.ok(live.has("current"));
    },
    async () => {
      scans++;
      started.resolve();
      await finish.promise;
      return [];
    },
  );
  try {
    assert.equal(scans, 0);
    assert.equal((await readdir(join(root, "session-artifacts"))).length, 1);
    const collection = release.collect();
    await started.promise;
    const closing = release(async () => {
      cleaned = true;
    });
    assert.equal((await readdir(join(root, "session-artifacts"))).length, 1, "lease remains during inventory");
    assert.equal(cleaned, false);
    finish.resolve();
    await Promise.all([collection, closing]);
    assert.equal(cleaned, true);
    assert.equal((await readdir(join(root, "session-artifacts"))).length, 0);
    await release.collect();
    assert.equal(scans, 1);
  } finally {
    finish.resolve();
    await release();
    await rm(root, { recursive: true, force: true });
  }
});

test("unreadable lease storage suppresses orphan deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "continuity-session-gc-unreadable-"));
  let deleted = false;
  const release = await startSessionGc(
    root,
    "current",
    async () => {
      deleted = true;
    },
    async () => [],
  );
  try {
    const leases = join(root, "session-artifacts");
    await rm(leases, { recursive: true });
    await writeFile(leases, "not a directory");
    await release.collect();
    assert.equal(deleted, false);
    await release(async () => {
      deleted = true;
    });
    assert.equal(deleted, false);
  } finally {
    await release();
    await rm(root, { recursive: true, force: true });
  }
});
