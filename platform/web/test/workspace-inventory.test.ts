import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFileDelta } from "pylon-core/src/worktree.ts";
import { WorkspaceInventories } from "../src/server/pi/workspace-inventory.ts";

const snapshot = (revision: string) => ({ revision, files: [{ path: "a.ts" }], truncated: false });
const delta = (revision: string): WorkspaceFileDelta => ({
  revision, upserted: [{ path: "a.ts", status: "modified" }], removed: [], reconcileRequired: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("shared readers serialize collection and retain a same-path edit received in flight", async () => {
  const cache = new WorkspaceInventories();
  const gate = deferred<WorkspaceFileDelta>();
  const batches: string[][] = [];
  const context = {
    isCurrent: () => true,
    collect: async () => snapshot("base"),
    collectDelta: async (paths: string[]) => {
      batches.push(paths);
      return batches.length === 1 ? gate.promise : delta("second edit");
    },
  };
  await cache.read("shared", context);
  cache.hint("shared", "a.ts");
  cache.hint("shared", "a.ts");
  const first = cache.read("shared", context);
  cache.hint("shared", "a.ts");
  const second = cache.read("shared", context);
  assert.deepEqual(batches, [["a.ts"]]);
  gate.resolve(delta("first edit"));
  const results = await Promise.all([first, second]);
  assert.deepEqual(batches, [["a.ts"], ["a.ts"]]);
  assert.deepEqual(results.map(value => value.revision), ["second edit", "second edit"]);
});

test("broad invalidations overtake deltas and full scans without losing later exact hints", async () => {
  const cache = new WorkspaceInventories();
  const deltaGate = deferred<WorkspaceFileDelta>();
  const scanGate = deferred<ReturnType<typeof snapshot>>();
  const scanStarted = deferred<void>();
  let scans = 0;
  let deltas = 0;
  const context = {
    isCurrent: () => true,
    collect: async () => {
      scans++;
      if (scans === 2) {
        scanStarted.resolve();
        return scanGate.promise;
      }
      return snapshot(`scan ${scans}`);
    },
    collectDelta: async () => {
      deltas++;
      return deltas === 1 ? deltaGate.promise : delta("post-scan edit");
    },
  };
  await cache.read("key", context);
  cache.hint("key", "a.ts");
  const reading = cache.read("key", context);
  cache.invalidate("key");
  deltaGate.resolve(delta("obsolete delta"));
  await scanStarted.promise;
  cache.invalidate("key");
  cache.invalidate("key");
  scanGate.resolve(snapshot("obsolete scan"));
  assert.equal((await reading).revision, "scan 3");
  assert.equal(scans, 3);

  const finalGate = deferred<ReturnType<typeof snapshot>>();
  const next = cache.read("key", { ...context, collect: () => finalGate.promise }, true);
  cache.hint("key", "a.ts");
  finalGate.resolve(snapshot("full"));
  assert.equal((await next).revision, "post-scan edit");
  assert.equal(deltas, 2);
});

test("failed collection preserves repair work and does not replace the previous snapshot", async () => {
  const cache = new WorkspaceInventories();
  const gate = deferred<WorkspaceFileDelta>();
  let scans = 0;
  const context = {
    isCurrent: () => true,
    collect: async () => { scans++; return snapshot(`scan ${scans}`); },
    collectDelta: () => gate.promise,
  };
  const original = await cache.read("key", context);
  cache.hint("key", "a.ts");
  const failed = cache.read("key", context);
  cache.hint("key", "b.ts");
  gate.reject(new Error("collector failed"));
  await assert.rejects(failed, /collector failed/);
  assert.equal(original.revision, "scan 1");
  assert.equal((await cache.read("key", context)).revision, "scan 2");
  assert.equal(scans, 2);

  const failedScan = cache.read("key", { ...context, collect: async () => { throw new Error("scan failed"); } }, true);
  await assert.rejects(failedScan, /scan failed/);
  assert.equal((await cache.read("key", context)).revision, "scan 3");
});

test("a stale origin cannot commit or poison a live waiter sharing its inventory key", async () => {
  for (const fails of [false, true]) {
    const cache = new WorkspaceInventories();
    const gate = deferred<ReturnType<typeof snapshot>>();
    let current = true;
    let scans = 0;
    const stale = cache.read("key", { isCurrent: () => current, collect: () => gate.promise });
    const rejected = assert.rejects(stale, /obsolete context/);
    const live = cache.read("key", {
      isCurrent: () => true,
      collect: async () => { scans++; return snapshot("live"); },
    });
    current = false;
    if (fails) gate.reject(new Error("disposed during scan"));
    else gate.resolve(snapshot("stale"));
    await rejected;
    assert.equal((await live).revision, "live");
    assert.equal(scans, 1);
  }
});

test("incremental success never extends the authoritative full-scan expiry", async () => {
  let now = 0;
  const cache = new WorkspaceInventories(() => now);
  let scans = 0;
  let deltas = 0;
  const context = {
    isCurrent: () => true,
    collect: async () => { scans++; return snapshot("base"); },
    collectDelta: async () => { deltas++; return delta("patched"); },
  };
  await cache.read("key", context);
  now = 59_999;
  cache.hint("key", "a.ts");
  await cache.read("key", context);
  now = 60_000;
  cache.hint("key", "a.ts");
  await cache.read("key", context);
  assert.equal(deltas, 1);
  assert.equal(scans, 2);
});

test("path overflow reconciles while duplicate hints at the limit stay incremental", async () => {
  const cache = new WorkspaceInventories();
  let scans = 0;
  const batches: string[][] = [];
  const context = {
    isCurrent: () => true,
    collect: async () => { scans++; return snapshot("full"); },
    collectDelta: async (paths: string[]) => { batches.push(paths); return delta("delta"); },
  };
  await cache.read("key", context);
  for (let index = 0; index < 100; index++) cache.hint("key", `${index}.ts`);
  for (let index = 0; index < 100; index++) cache.hint("key", "0.ts");
  await cache.read("key", context);
  assert.equal(batches[0]!.length, 100);
  assert.equal(scans, 1);
  for (let index = 0; index < 101; index++) cache.hint("key", `${index}.ts`);
  await cache.read("key", context);
  assert.equal(batches.length, 1);
  assert.equal(scans, 2);
});

test("unsafe deltas and removals after incremental truncation fall back to a full scan", async () => {
  const cache = new WorkspaceInventories();
  let scans = 0;
  let patch: WorkspaceFileDelta = { ...delta("overflow"), upserted: [{ path: "new.ts", status: "added" }] };
  const context = {
    isCurrent: () => true,
    collect: async () => {
      scans++;
      return { revision: "full", files: Array.from({ length: 10_000 }, (_, i) => ({ path: `${i}.ts` })), truncated: false };
    },
    collectDelta: async () => patch,
  };
  await cache.read("key", context);
  cache.hint("key", "new.ts");
  const truncated = await cache.read("key", context);
  assert.equal(truncated.files.length, 10_000);
  assert.equal(truncated.truncated, true);
  patch = { ...delta("removed"), upserted: [], removed: ["new.ts"] };
  cache.hint("key", "new.ts");
  await cache.read("key", context);
  assert.equal(scans, 2);
  patch = { ...delta("unsafe"), reconcileRequired: true };
  cache.hint("key", "directory");
  await cache.read("key", context);
  assert.equal(scans, 3);
});

test("cache pressure cannot evict an active writer and allow overlapping scans", async () => {
  const cache = new WorkspaceInventories();
  const gate = deferred<ReturnType<typeof snapshot>>();
  let scans = 0;
  const context = {
    isCurrent: () => true,
    collect: async () => { scans++; return gate.promise; },
  };
  const first = cache.read("active", context);
  for (let index = 0; index < 30; index++) {
    await cache.read(`other ${index}`, { isCurrent: () => true, collect: async () => snapshot("other") });
  }
  const second = cache.read("active", context);
  assert.equal(scans, 1);
  gate.resolve(snapshot("active"));
  await Promise.all([first, second]);
  assert.equal(scans, 1);
});

test("concurrent refresh requests share a coalesced follow-up scan", async () => {
  const cache = new WorkspaceInventories();
  const gate = deferred<ReturnType<typeof snapshot>>();
  let scans = 0;
  const context = {
    isCurrent: () => true,
    collect: async () => ++scans === 1 ? gate.promise : snapshot("fresh"),
  };
  const first = cache.read("key", context, true);
  const readers = Array.from({ length: 10 }, () => cache.read("key", context, true));
  gate.resolve(snapshot("older"));
  const results = await Promise.all([first, ...readers]);
  assert.equal(scans, 2);
  assert.ok(results.every(value => value.revision === "fresh"));
});

test("disposal prevents an in-flight snapshot from repopulating cleared inventory state", async () => {
  const cache = new WorkspaceInventories();
  const gate = deferred<ReturnType<typeof snapshot>>();
  const reading = cache.read("key", { isCurrent: () => true, collect: () => gate.promise });
  cache.clear();
  gate.resolve(snapshot("disposed"));
  await assert.rejects(reading, /obsolete context/);
  assert.equal((await cache.read("key", { isCurrent: () => true, collect: async () => snapshot("new") })).revision, "new");
});
