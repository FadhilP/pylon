import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { capture } from "../src/snapshot.ts";
import {
  cleanupTimelineSession,
  recordTimelineOwner,
  readLockOwner,
  startSessionGc,
} from "../src/session-gc.ts";

const exec = promisify(execFile);
async function repository() {
  const root = await mkdtemp(join(tmpdir(), "timeline-session-gc-repo-"));
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.email", "timeline@test.local");
  await git("config", "user.name", "timeline-test");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git("add", "tracked.txt");
  await git("commit", "-qm", "base");
  return { root, git };
}

async function refs(git: (...args: string[]) => Promise<string>) {
  return (await git("for-each-ref", "--format=%(refname)", "refs/pi-timeline"))
    .split(/\r?\n/)
    .filter(Boolean);
}

test("timeline lock reads retry transient failures and reject persistent corruption", async () => {
  let attempts = 0;
  const owner = await readLockOwner("unused", async () => {
    attempts++;
    if (attempts < 3) throw Object.assign(new Error("busy"), { code: "EPERM" });
    return JSON.stringify({ version: 1, pid: process.pid, token: "ready" });
  });
  assert.equal(attempts, 3);
  assert.equal(owner?.token, "ready");
  await assert.rejects(
    readLockOwner("unused", async () => "not json"),
    /Unreadable timeline session-artifact lock/,
  );
});

test("timeline GC removes deleted-session refs and preserves persisted or leased sessions", async () => {
  const { root: repo, git } = await repository();
  const artifacts = await mkdtemp(join(tmpdir(), "timeline-session-gc-state-"));
  try {
    const releaseLeased = await startSessionGc(
      artifacts,
      "leased",
      async () => [],
    );
    const releaseSameSession = await startSessionGc(
      artifacts,
      "leased",
      async () => [],
    );
    for (const sessionId of ["leased", "persisted", "deleted"]) {
      await capture(repo, sessionId);
      await recordTimelineOwner(artifacts, sessionId, repo);
    }
    assert.equal((await refs(git)).length, 6);

    const releaseCurrent = await startSessionGc(
      artifacts,
      "current",
      async () => [{ id: "persisted" }],
    );
    assert.equal((await refs(git)).length, 4);

    await cleanupTimelineSession(artifacts, "leased");
    assert.equal(
      (await refs(git)).length,
      4,
      "live leases block explicit cleanup",
    );
    await releaseLeased(true);
    assert.equal(
      (await refs(git)).length,
      4,
      "second lease blocks ephemeral cleanup",
    );
    await releaseCurrent();
    const releaseNext = await startSessionGc(artifacts, "next", async () => [
      { id: "persisted" },
    ]);
    assert.equal(
      (await refs(git)).length,
      4,
      "second lease keeps same session refs live",
    );
    await releaseSameSession();
    await releaseNext();
    const releaseFinal = await startSessionGc(artifacts, "final", async () => [
      { id: "persisted" },
    ]);
    assert.equal((await refs(git)).length, 2);
    await releaseFinal();
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("timeline GC fails closed on a malformed ownership catalog", async () => {
  const { root: repo, git } = await repository();
  const artifacts = await mkdtemp(
    join(tmpdir(), "timeline-session-gc-corrupt-"),
  );
  try {
    await capture(repo, "orphan");
    await recordTimelineOwner(artifacts, "orphan", repo);
    await writeFile(join(artifacts, "session-artifacts.json"), "not json");
    const release = await startSessionGc(artifacts, "current", async () => []);
    assert.equal((await refs(git)).length, 2);
    await assert.rejects(
      recordTimelineOwner(artifacts, "current", repo),
      /Unreadable/,
    );
    await release();
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("timeline stale-lock recovery serializes concurrent catalog writes", async () => {
  const { root: repo } = await repository();
  const artifacts = await mkdtemp(join(tmpdir(), "timeline-session-gc-lock-"));
  const child = spawn(process.execPath, ["-e", ""], { windowsHide: true });
  const pid = child.pid!;
  await once(child, "exit");
  await writeFile(
    join(artifacts, "session-artifacts.lock"),
    JSON.stringify({ version: 1, pid, token: "dead" }),
  );
  try {
    await Promise.all([
      recordTimelineOwner(artifacts, "one", repo),
      recordTimelineOwner(artifacts, "two", repo),
    ]);
    const catalog = JSON.parse(
      await readFile(join(artifacts, "session-artifacts.json"), "utf8"),
    );
    assert.deepEqual(
      new Set(catalog.owners.map((owner: any) => owner.sessionId)),
      new Set(["one", "two"]),
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});

test("timeline explicitly cleans ephemeral-session refs", async () => {
  const { root: repo, git } = await repository();
  const artifacts = await mkdtemp(
    join(tmpdir(), "timeline-session-gc-ephemeral-"),
  );
  try {
    await capture(repo, "ephemeral");
    await recordTimelineOwner(artifacts, "ephemeral", repo);
    assert.equal((await refs(git)).length, 2);
    await cleanupTimelineSession(artifacts, "ephemeral");
    assert.equal((await refs(git)).length, 0);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(artifacts, { recursive: true, force: true });
  }
});
