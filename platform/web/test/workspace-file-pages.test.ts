import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { WorkspaceFilePage, WorkspaceFileReadModel } from "../src/shared/protocol/snapshots.ts";
import {
  drainWorkspaceFiles,
  WorkspaceInventoryLoads,
  workspaceInventoryCacheIsFresh,
  workspaceInventoryCacheState,
} from "../src/client/workspace/workspace-file-pages.ts";
import { isWorkspaceFilePage } from "../src/shared/protocol/validation.ts";

test("workspace file pages drain, deduplicate, batch, and report truncation", async () => {
  const pages: WorkspaceFilePage[] = Array.from({ length: 6 }, (_, page) => ({
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration: 1,
    revision: "revision",
    files: Array.from({ length: 200 }, (_, index) => ({ path: `src/${page * 200 + index}.ts` })),
    totalCount: 1_200,
    truncated: page === 5,
    ...(page < 5 ? { nextCursor: String(page + 1) } : {}),
  }));
  pages[5]!.files[0] = pages[0]!.files[0]!;
  const batches: number[] = [];
  const progress: Array<[number, number]> = [];
  let truncated = false;
  const files = await drainWorkspaceFiles(
    cursor => Promise.resolve(pages[Number(cursor ?? 0)]!),
    new AbortController().signal,
    (items, value) => {
      batches.push(items.length);
      truncated = value;
    },
    (loaded, total) => progress.push([loaded, total]),
  );
  assert.deepEqual(batches, [1_000, 1_199]);
  assert.equal(files.length, 1_199);
  assert.equal(truncated, true);
  assert.deepEqual(progress.at(-1), [1_199, 1_200]);
});

test("workspace file page draining stops when its request is stale", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    drainWorkspaceFiles(
      () => Promise.reject(new Error("should not fetch")),
      controller.signal,
      () => {},
    ),
    { name: "AbortError" },
  );
});

test("workspace file pages accept registered submodule folder markers", () => {
  const page: WorkspaceFilePage = {
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration: 1,
    revision: "revision",
    files: [{ path: "vendor/library", kind: "submodule" }],
    totalCount: 1,
    truncated: false,
  };
  assert.equal(isWorkspaceFilePage(page), true);
  assert.equal(isWorkspaceFilePage({ ...page, files: [{ path: "vendor/library", kind: "symlink" }] }), false);
});

test("workspace inventory cache is fresh only for a live matching revision", () => {
  assert.equal(workspaceInventoryCacheIsFresh("same", 2_000, "same", 1_000), true);
  assert.equal(workspaceInventoryCacheIsFresh("old", 2_000, "new", 1_000), false);
  assert.equal(workspaceInventoryCacheIsFresh("same", 1_000, "same", 1_000), false);
});

test("workspace inventory cache stays visible but refreshes after a session generation change", () => {
  const cached = { generation: 1, mode: "worktree" as const, revision: "same", expiresAt: 2_000 };
  assert.equal(
    workspaceInventoryCacheState(cached, { generation: 1, mode: "worktree", revision: "same" }, 1_000),
    "fresh",
  );
  assert.equal(
    workspaceInventoryCacheState(cached, { generation: 2, mode: "worktree", revision: "same" }, 1_000),
    "stale",
  );
  assert.equal(
    workspaceInventoryCacheState(cached, { generation: 2, mode: "checkout", revision: "same" }, 1_000),
    "hidden",
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
function page(files: WorkspaceFileReadModel[], nextCursor?: string): WorkspaceFilePage {
  return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: 1, revision: "revision", files,
    totalCount: files.length, truncated: false, ...(nextCursor ? { nextCursor } : {}) };
}
const noOp = () => {};
const request = (signal = new AbortController().signal) => ({
  key: "session:1:checkout:revision", signal, refresh: false,
  checkCurrent: noOp, publish: noOp, progress: noOp, complete: noOp,
});

test("revalidation preserves complete snapshots and only replaces changed entries", async () => {
  const previous = Array.from({ length: 1_200 }, (_, index) => ({ path: `${index}.ts` }));
  const snapshots: WorkspaceFileReadModel[][] = [];
  const result = await drainWorkspaceFiles(async cursor => {
    const offset = Number(cursor ?? 0);
    return page(previous.slice(offset, offset + 200).map(file => ({ ...file })), offset < 1_000 ? String(offset + 200) : undefined);
  }, new AbortController().signal, files => snapshots.push(files), undefined, previous);
  assert.equal(result, previous);
  assert.deepEqual(snapshots, [previous], "a refresh must not replace a complete inventory with partial pages");
  const changed = await drainWorkspaceFiles(async () => page([
    { path: previous[0].path, status: "modified", additions: 2 }, ...previous.slice(1).map(file => ({ ...file })),
  ]), new AbortController().signal, noOp, undefined, previous);
  assert.notEqual(changed, previous);
  assert.notEqual(changed[0], previous[0]);
  assert.equal(changed[1], previous[1]);
  const reordered = await drainWorkspaceFiles(async () => page([{ ...previous[1] }, { ...previous[0] }]),
    new AbortController().signal, noOp, undefined, previous.slice(0, 2));
  assert.equal(reordered[0], previous[1]);
  assert.equal(reordered[1], previous[0]);
});

test("inventory consumers share paging, replay progress to late joiners, and abort independently", async () => {
  const loads = new WorkspaceInventoryLoads();
  const entered = deferred<void>();
  const last = deferred<WorkspaceFilePage>();
  const a = new AbortController(), b = new AbortController();
  const seenA: number[] = [], seenB: number[] = [];
  let calls = 0, commits = 0;
  let producer!: AbortSignal;
  const first = loads.load({ ...request(a.signal), publish: files => seenA.push(files.length), complete: () => { commits++; },
    fetchPage: async (cursor, signal) => {
      calls++;
      producer = signal;
      const index = Number(cursor ?? 0);
      if (index === 5) { entered.resolve(); return last.promise; }
      return page(Array.from({ length: 200 }, (_, row) => ({ path: `${index * 200 + row}.ts` })), String(index + 1));
    },
  }).catch(error => error);
  await entered.promise;
  const joined = loads.load({ ...request(b.signal), publish: files => seenB.push(files.length),
    fetchPage: async () => { throw new Error("duplicate drain"); },
  });
  assert.deepEqual(seenB, [1_000]);
  a.abort();
  assert.equal((await first).name, "AbortError");
  assert.equal(producer.aborted, false);
  last.resolve(page(Array.from({ length: 200 }, (_, row) => ({ path: `${1_000 + row}.ts` }))));
  assert.equal((await joined).files.length, 1_200);
  assert.equal(calls, 6);
  assert.equal(commits, 1);
  assert.deepEqual(seenA, [1_000]);
  assert.deepEqual(seenB, [1_000, 1_200]);
  assert.equal(getEventListeners(a.signal, "abort").length, 0);
  assert.equal(getEventListeners(b.signal, "abort").length, 0);
});

test("forced refreshes share one successor and prevent older cache publication", async () => {
  const loads = new WorkspaceInventoryLoads();
  const started = deferred<void>(), forcedStarted = deferred<void>();
  const original = deferred<WorkspaceFilePage>(), fresh = deferred<WorkspaceFilePage>();
  const commits: string[] = [];
  let forcedCalls = 0;
  const first = loads.load({ ...request(), complete: () => commits.push("old"),
    fetchPage: async () => { started.resolve(); return original.promise; },
  });
  await started.promise;
  const forceOptions = { ...request(), refresh: true, complete: () => commits.push("fresh"),
    fetchPage: async () => { forcedCalls++; forcedStarted.resolve(); return fresh.promise; },
  };
  const forced = loads.load(forceOptions);
  const joined = loads.load({ ...forceOptions, signal: new AbortController().signal });
  assert.equal(forcedCalls, 0);
  original.resolve(page([{ path: "old.ts" }]));
  assert.equal((await first).files[0].path, "old.ts");
  await forcedStarted.promise;
  assert.deepEqual(commits, []);
  fresh.resolve(page([{ path: "fresh.ts" }]));
  assert.equal((await forced).files[0].path, "fresh.ts");
  assert.equal((await joined).files[0].path, "fresh.ts");
  assert.equal(forcedCalls, 1);
  assert.deepEqual(commits, ["fresh"]);
  // A caller may request another refresh before the previous flight's cleanup microtask.
  assert.equal((await loads.load({ ...request(), refresh: true, fetchPage: async () => page([{ path: "again.ts" }]) })).files[0].path, "again.ts");
});

test("cancelling a queued forced refresh leaves the original shared load usable", async () => {
  const loads = new WorkspaceInventoryLoads();
  const started = deferred<void>(), original = deferred<WorkspaceFilePage>();
  let calls = 0, commits = 0;
  const options = { ...request(), complete: () => { commits++; }, fetchPage: async () => {
    calls++; started.resolve(); return original.promise;
  } };
  const first = loads.load(options);
  await started.promise;
  const controller = new AbortController();
  const cancelled = loads.load({ ...options, signal: controller.signal, refresh: true }).catch(error => error);
  controller.abort();
  assert.equal((await cancelled).name, "AbortError");
  const joined = loads.load({ ...options, signal: new AbortController().signal });
  original.resolve(page([{ path: "kept.ts" }]));
  await Promise.all([first, joined]);
  assert.equal(calls, 1);
  assert.equal(commits, 1);
});

test("a failed predecessor does not poison its forced successor", async () => {
  const loads = new WorkspaceInventoryLoads();
  const started = deferred<void>(), original = deferred<WorkspaceFilePage>();
  const first = loads.load({ ...request(), fetchPage: async () => { started.resolve(); return original.promise; } }).catch(error => error);
  await started.promise;
  const forced = loads.load({ ...request(), refresh: true, fetchPage: async () => page([{ path: "recovered.ts" }]) });
  original.reject(new Error("old request failed"));
  assert.match(String(await first), /old request failed/);
  assert.equal((await forced).files[0].path, "recovered.ts");
});

test("last-consumer cancellation stops its producer, permits retry, and clear rejects active consumers", async () => {
  const loads = new WorkspaceInventoryLoads();
  const started = deferred<AbortSignal>();
  const controller = new AbortController();
  const first = loads.load({ ...request(controller.signal), fetchPage: async (_cursor, signal) => {
    started.resolve(signal);
    return new Promise<WorkspaceFilePage>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } }).catch(error => error);
  const producer = await started.promise;
  controller.abort();
  assert.equal((await first).name, "AbortError");
  assert.equal(producer.aborted, true);
  const retryStarted = deferred<void>(), retryPage = deferred<WorkspaceFilePage>();
  let calls = 0;
  const retryOptions = { ...request(), fetchPage: async () => { calls++; retryStarted.resolve(); return retryPage.promise; } };
  const retry = loads.load(retryOptions).catch(error => error);
  await retryStarted.promise;
  const joinedSignal = new AbortController().signal;
  const joined = loads.load({ ...retryOptions, signal: joinedSignal }).catch(error => error);
  assert.equal(calls, 1, "old cleanup must not remove a successor flight");
  loads.clear();
  assert.equal((await retry).name, "AbortError");
  assert.equal((await joined).name, "AbortError");
  assert.equal(getEventListeners(joinedSignal, "abort").length, 0);
  retryPage.resolve(page([]));
});

test("stale context blocks publication, and subscriber callback errors do not fail other subscribers", async () => {
  const loads = new WorkspaceInventoryLoads();
  const started = deferred<void>(), result = deferred<WorkspaceFilePage>();
  let current = true, publications = 0;
  const stale = loads.load({ ...request(), checkCurrent: () => { if (!current) throw new Error("stale context"); },
    publish: () => { publications++; }, complete: () => { publications++; },
    fetchPage: async () => { started.resolve(); return result.promise; },
  }).catch(error => error);
  await started.promise;
  current = false;
  result.resolve(page([{ path: "stale.ts" }]));
  assert.match(String(await stale), /stale context/);
  assert.equal(publications, 0);
  const fresh = deferred<WorkspaceFilePage>();
  const badSignal = new AbortController().signal, goodSignal = new AbortController().signal;
  const options = { ...request(), key: "new-context", fetchPage: async () => fresh.promise };
  const bad = loads.load({ ...options, signal: badSignal, publish: () => { throw new Error("consumer failed"); } }).catch(error => error);
  const good = loads.load({ ...options, signal: goodSignal });
  fresh.resolve(page([{ path: "good.ts" }]));
  assert.match(String(await bad), /consumer failed/);
  assert.equal((await good).files[0].path, "good.ts");
  assert.equal(getEventListeners(badSignal, "abort").length, 0);
  assert.equal(getEventListeners(goodSignal, "abort").length, 0);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(loads.load({ ...options, signal: aborted.signal }), { name: "AbortError" });
});

test("notification cancellation skips removed consumers and completion can immediately request another refresh", async () => {
  const loads = new WorkspaceInventoryLoads();
  const cancelled = new AbortController();
  const result = deferred<WorkspaceFilePage>();
  let calls = 0;
  const options = { ...request(), fetchPage: async () => { calls++; return result.promise; } };
  const first = loads.load({ ...options, publish: () => cancelled.abort() });
  const second = loads.load({ ...options, signal: cancelled.signal,
    publish: () => assert.fail("an aborted subscriber must not receive a later notification"),
  }).catch(error => error);
  const followup = first.then(() => loads.load({ ...options, refresh: true }));
  result.resolve(page([{ path: "latest.ts" }]));
  assert.equal((await second).name, "AbortError");
  assert.equal((await followup).files[0].path, "latest.ts");
  assert.equal(calls, 2);
});
