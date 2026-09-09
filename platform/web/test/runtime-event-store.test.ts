import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { WorkspaceFilePage } from "../src/shared/protocol/snapshots.ts";
import {
  promptCommandType,
  reconcilePendingQueue,
  type PendingMessageReadModel,
} from "../src/client/runtime/pending-messages.ts";
import {
  MAX_UNSEEN_COMPLETIONS,
  completionRecord,
  recordCompletion,
  validCompletionSessionIds,
} from "../src/shared/sessions/session-completions.ts";

test("extension slash commands bypass the prompt queue while prompt and skill commands preserve ordering", () => {
  assert.equal(promptCommandType(true, false, "extension"), "prompt");
  assert.equal(promptCommandType(false, true, "extension"), "prompt");
  assert.equal(promptCommandType(true, false, "prompt"), "queuePrompt");
  assert.equal(promptCommandType(true, false, "skill"), "queuePrompt");
  assert.equal(promptCommandType(true, false), "queuePrompt");
  assert.equal(promptCommandType(false, false), "prompt");
});

test("pending queue reconciliation preserves delivery and removes restored entries", () => {
  const pending = (commandId: string): PendingMessageReadModel => ({
    id: `pending-${commandId}`,
    commandId,
    sessionId: "session",
    sessionGeneration: 1,
    text: "same",
    attachmentCount: 0,
    fileAttachmentCount: 0,
    planMode: false,
    state: "queued",
  });
  const queued = (commandId: string, state: "queued" | "delivering") => ({
    id: `queue-${commandId}`,
    commandId,
    preview: "same",
    attachmentCount: 0,
    fileAttachmentCount: 0,
    planMode: false,
    state,
  });
  const first = reconcilePendingQueue(
    [pending("one"), pending("two")],
    [queued("one", "queued"), queued("two", "queued")],
    [queued("one", "delivering"), queued("two", "queued")],
    "session",
    1,
  );
  assert.deepEqual(
    first.map(item => [item.commandId, item.state]),
    [
      ["one", "sending"],
      ["two", "queued"],
    ],
  );
  const delivered = reconcilePendingQueue(
    first,
    [queued("one", "delivering"), queued("two", "queued")],
    [queued("two", "queued")],
    "session",
    1,
  );
  assert.deepEqual(
    delivered.map(item => item.commandId),
    ["one", "two"],
  );
  const restored = reconcilePendingQueue(delivered, [queued("two", "queued")], [], "session", 1);
  assert.deepEqual(
    restored.map(item => item.commandId),
    ["one"],
  );
  const rehydrated = reconcilePendingQueue([], [], [queued("three", "queued")], "session", 1);
  assert.equal(rehydrated[0]?.id, "pending-three");
});

test("completed background sessions survive sleeping and bootstrap authoritatively", () => {
  const completed = recordCompletion({}, "selected", { sessionId: "background", completed: true });
  const sleeping = recordCompletion(completed, "selected", { sessionId: "background" });

  assert.deepEqual(sleeping, { background: true });
  assert.deepEqual(recordCompletion(sleeping, "background", { sessionId: "background", completed: true }), sleeping);
  assert.deepEqual(completionRecord(["from-server"]), { "from-server": true });
  assert.equal(validCompletionSessionIds(["from-server"]), true);
  assert.equal(validCompletionSessionIds(["duplicate", "duplicate"]), false);
  const special = recordCompletion({}, "selected", { sessionId: "__proto__", completed: true });
  assert.equal(Object.hasOwn(special, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(special), Object.prototype);
  let bounded: Record<string, true> = {};
  for (let index = 0; index <= MAX_UNSEEN_COMPLETIONS; index++) {
    bounded = recordCompletion(bounded, "selected", { sessionId: `session-${index}`, completed: true });
  }
  assert.equal(Object.keys(bounded).length, MAX_UNSEEN_COMPLETIONS);
  assert.equal(bounded["session-0"], undefined);
  assert.equal(bounded["session-200"], true);
});

test("database approval routing survives renewal and stale closes without retaining a closed or unowned request", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true }, appType: "custom" });
  const { RuntimeEventStore } = await vite.ssrLoadModule("/src/client/runtime/event-store.ts");
  const store = new RuntimeEventStore();
  const original = { window: (globalThis as any).window, requestAnimationFrame: (globalThis as any).requestAnimationFrame, cancelAnimationFrame: (globalThis as any).cancelAnimationFrame };
  Object.assign(globalThis, { window: { removeEventListener() {} }, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });
  store.snapshot = { ...store.getSnapshot(), connection: "connected", generation: 1, sequence: 0,
    runtime: { ready: true, sessionId: "database-test", sessionGeneration: 1, conversation: { messages: [], queue: { items: [] } } } };
  let sequence = 0;
  const apply = (type: string, payload: unknown) => store.apply({ type, payload, payloadVersion: 1, sessionGeneration: 1, sequence: ++sequence });
  const request = { requestId: "current", method: "confirm", payload: { title: "Connect?" }, surface: "database", operationId: "setup-id", owned: true, ownershipAvailable: false };
  try {
    apply("ui.request", request);
    store.api.uiKeepAlive = async () => ({ expiresAt: "2099-01-01T00:00:00.000Z" });
    await store.keepUiRequestAlive(request);
    apply("ui.closed", { requestId: "previous" });
    assert.deepEqual(store.getSnapshot().pendingUi, { ...request, expiresAt: "2099-01-01T00:00:00.000Z" });
    apply("ui.ownership", { requestId: "current", owned: false, ownershipAvailable: true });
    assert.equal(store.getSnapshot().pendingUi.owned, false);
    assert.equal(store.getSnapshot().pendingUi.operationId, "setup-id");
    apply("ui.closed", { requestId: "current" });
    assert.equal(store.getSnapshot().pendingUi, undefined);
    await store.keepUiRequestAlive(request);
    assert.equal(store.getSnapshot().pendingUi, undefined, "late renewal must not resurrect a closed request");
    apply("ui.request", { ...request, requestId: "next", operationId: "next-operation" });
    apply("ui.closed", { requestId: "current" });
    assert.equal(store.getSnapshot().pendingUi.requestId, "next");
  } finally {
    store.dispose();
    Object.assign(globalThis, original);
    await vite.close();
  }
});

test("runtime inventory sharing preserves cache identity and rejects changes in revision, mode, generation or lifecycle", async () => {
  const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true }, appType: "custom" });
  const { RuntimeEventStore } = await vite.ssrLoadModule("/src/client/runtime/event-store.ts");
  const store = new RuntimeEventStore();
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = { removeEventListener() {} };
  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
  };
  const page = (generation: number, path: string): WorkspaceFilePage => ({
    protocolVersion: PROTOCOL_VERSION, sessionGeneration: generation, revision: "server-revision",
    files: [{ path }], totalCount: 1, truncated: false,
  });
  let pending: { entered: ReturnType<typeof deferred<void>>; page: ReturnType<typeof deferred<WorkspaceFilePage>> } | undefined;
  let path = "first.ts";
  const requests: Array<{ generation: number; refresh: boolean }> = [];
  store.snapshot = { connection: "connected", runtime: { ready: true, sessionId: "inventory-test", sessionGeneration: 1,
    workspace: { mode: "checkout", revision: "revision", fileRevision: 0 } } };
  store.api.workspaceFiles = async (generation: number, _query: string, _cursor: string, _signal: AbortSignal, refresh: boolean) => {
    requests.push({ generation, refresh });
    if (pending) { const next = pending; pending = undefined; next.entered.resolve(); return next.page.promise; }
    return page(generation, path);
  };
  const load = (refresh = false, signal = new AbortController().signal, publish = (_files: unknown) => {}) =>
    store.workspaceInventory(refresh, signal, publish, () => {});
  try {
    const firstPage = { entered: deferred<void>(), page: deferred<WorkspaceFilePage>() };
    pending = firstPage;
    const controller = new AbortController();
    const first = load(false, controller.signal).catch((error: unknown) => error);
    const joined = load();
    await firstPage.entered.promise;
    controller.abort();
    assert.equal((await first as Error).name, "AbortError");
    firstPage.page.resolve(page(1, path));
    const result = await joined;
    assert.equal(requests.length, 1);
    assert.equal((await load()).files, result.files);
    assert.equal((await load(true)).files, result.files);
    assert.deepEqual(requests.map(value => value.refresh), [false, true]);

    const retained = store.cachedWorkspaceInventory();
    assert.equal(retained.files, result.files, "a remount can read its tree before starting an effect");
    retained.expiresAt = 0;
    const expiredPage = { entered: deferred<void>(), page: deferred<WorkspaceFilePage>() };
    pending = expiredPage;
    const seen: unknown[] = [];
    const revalidating = load(false, new AbortController().signal, files => seen.push(files));
    assert.deepEqual(seen, [result.files], "expiry must synchronously publish the last complete inventory");
    await expiredPage.entered.promise;
    assert.equal(store.cachedWorkspaceInventory().files, result.files);
    expiredPage.page.resolve(page(1, "after-expiry.ts"));
    await revalidating;
    assert.equal(store.cachedWorkspaceInventory().files[0].path, "after-expiry.ts");
    assert.equal(store.cachedWorkspaceInventory({ ...store.snapshot.runtime, sessionId: "other" }), undefined);
    assert.equal(store.cachedWorkspaceInventory({ ...store.snapshot.runtime, cwdLabel: "other-root" }), undefined);

    for (const change of ["revision", "mode", "generation"] as const) {
      const gate = { entered: deferred<void>(), page: deferred<WorkspaceFilePage>() };
      pending = gate;
      let stalePublications = 0;
      const generation = store.snapshot.runtime.sessionGeneration;
      const stale = load(true, new AbortController().signal, () => { stalePublications++; }).catch((error: unknown) => error);
      await gate.entered.promise;
      const runtime = store.snapshot.runtime;
      store.snapshot = { ...store.snapshot, runtime: { ...runtime,
        sessionGeneration: generation + (change === "generation" ? 1 : 0),
        workspace: { ...runtime.workspace,
          ...(change === "revision" ? { fileRevision: runtime.workspace.fileRevision + 1 } : {}),
          ...(change === "mode" ? { mode: "worktree" } : {}),
        },
      } };
      path = `${change}.ts`;
      const fresh = await load();
      gate.page.resolve(page(generation, "obsolete.ts"));
      assert.match(String(await stale), /stale workspace|previous session/);
      assert.equal(stalePublications, 0);
      assert.equal((await load()).files, fresh.files);
      assert.equal(fresh.files[0].path, path);
    }
    store.snapshot = { ...store.snapshot, connection: "disconnected" };
    const before = requests.length;
    await assert.rejects(load(), /Runtime is not connected/);
    assert.equal(requests.length, before);
    store.snapshot = { ...store.snapshot, connection: "connected" };
    const gate = { entered: deferred<void>(), page: deferred<WorkspaceFilePage>() };
    pending = gate;
    const closing = load(true).catch((error: unknown) => error);
    await gate.entered.promise;
    store.dispose();
    assert.equal((await closing as Error).name, "AbortError");
    gate.page.resolve(page(store.snapshot.runtime.sessionGeneration, "disposed.ts"));
  } finally {
    store.dispose();
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
    await vite.close();
  }
});
test("switching sessions keeps loaded transcript history available to the replacement bootstrap", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    server: { middlewareMode: true },
    appType: "custom",
  });
  const { RuntimeEventStore } = await vite.ssrLoadModule("/src/client/runtime/event-store.ts");
  const store = new RuntimeEventStore();
  const cached = {
    messages: [{ id: "history-0", role: "assistant", text: "earlier response", streaming: false }],
    historyCursor: undefined,
    historyRemaining: undefined,
  };
  store.snapshot = { connection: "connected", generation: 3 };
  store.historyCache.set("target-session", cached);
  store.sendCommand = async () => ({ sessionGeneration: 4 });
  store.waitForRuntime = async () => {};
  try {
    await store.switchSession("target-session");
    assert.strictEqual(store.historyCache.get("target-session"), cached);
  } finally {
    await vite.close();
  }
});


test("display previews survive expiry and failed refresh without accepting obsolete reads or leaking workspace content", async t => {
  const vite = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true }, appType: "custom" });
  const { RuntimeEventStore } = await vite.ssrLoadModule("/src/client/runtime/event-store.ts");
  const { ApiHttpError } = await vite.ssrLoadModule("/src/client/runtime/api-client.ts");
  const store = new RuntimeEventStore();
  const originalWindow = (globalThis as any).window;
  (globalThis as any).window = { removeEventListener() {} };
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const original = { ready: true, sessionId: "preview-session", sessionGeneration: 1, cwdLabel: "project",
    workspace: { mode: "worktree", revision: "revision", fileRevision: 0 } };
  store.snapshot = { connection: "connected", runtime: original };
  let text = "first";
  let fail: Error | undefined;
  let gate: { promise: Promise<void>; resolve: () => void } | undefined;
  let requests = 0;
  const defer = () => {
    let resolve!: () => void;
    gate = { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
    return gate;
  };
  const read = async (generation: number, path: string, signal?: AbortSignal) => {
    requests++;
    assert.ok(signal === undefined || signal instanceof AbortSignal);
    const pending = gate; gate = undefined;
    if (pending) await pending.promise;
    if (fail) throw fail;
    return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: generation, path, revision: `content:${text}`, state: "available", text };
  };
  store.api.workspaceFile = (generation: number, path: string, _view: string, signal?: AbortSignal) => read(generation, path, signal);
  store.api.workspaceDiff = read;
  const load = (path = "a.ts", view = "diff", signal = new AbortController().signal) => store.workspacePreview(path, view, signal);
  const cached = (path = "a.ts", view = "diff") => store.cachedWorkspacePreview(path, view);
  try {
    await load();
    const first = cached();
    assert.equal(first.value.text, "first");
    await load();
    assert.equal(requests, 1, "a fresh remount must not reread the file");
    assert.equal(cached(), first);
    assert.equal(cached("b.ts"), undefined);
    assert.equal(cached("a.ts", "current"), undefined);
    await store.workspaceDiff("a.ts");
    assert.equal(requests, 2, "raw reads must never use the display cache");
    text = "baseline";
    await load("a.ts", "base");
    assert.equal(cached("a.ts", "base").value.text, "baseline");
    assert.equal(cached(), first, "baseline and diff previews of one path must remain distinct");

    now += 60_001;
    const expired = defer();
    const refreshing = load();
    assert.equal(cached(), first, "expired content remains readable while revalidation is pending");
    text = "refreshed"; expired.resolve(); await refreshing;
    assert.equal(cached().value.text, "refreshed");
    const refreshed = cached();
    store.snapshot.runtime = { ...original, workspace: { ...original.workspace, fileRevision: 1 } };
    fail = new Error("temporary read failure");
    await assert.rejects(load(), /temporary read failure/);
    assert.equal(cached(), refreshed);
    fail = undefined; text = "";
    await load();
    assert.equal(cached().value.text, "", "a successful empty result replaces old text");

    for (const change of ["session", "generation", "mode", "cwd", "revision", "fileRevision", "unavailable"] as const) {
      const origin = { ...original, workspace: { ...original.workspace, fileRevision: 2 } };
      store.snapshot.runtime = origin;
      const previous = cached();
      const delayed = defer();
      const stale = load().catch((error: unknown) => error);
      store.snapshot.runtime = { ...origin,
        ...(change === "session" ? { sessionId: "another-session" } : {}),
        ...(change === "generation" ? { sessionGeneration: 2 } : {}),
        ...(change === "cwd" ? { cwdLabel: "another-root" } : {}),
        ...(change === "unavailable" ? { projectAvailable: false } : {}),
        workspace: { ...origin.workspace,
          ...(change === "mode" ? { mode: "local" } : {}),
          ...(change === "revision" ? { revision: "new-revision" } : {}),
          ...(change === "fileRevision" ? { fileRevision: 3 } : {}),
        },
      };
      if (["session", "mode", "cwd", "unavailable"].includes(change)) assert.equal(cached(), undefined);
      else assert.equal(cached(), previous, "a new revision or generation may display stale content, not reuse it as fresh");
      const beforeStaleEffect: number = requests;
      await assert.rejects(store.workspacePreview("a.ts", "diff", new AbortController().signal, origin), /stale workspace/);
      assert.equal(requests, beforeStaleEffect, "an effect from a previous render must not request a file in the new workspace");
      delayed.resolve();
      assert.match(String(await stale), /stale workspace|previous session/);
      store.snapshot.runtime = origin;
      assert.equal(cached(), previous, "obsolete responses must not replace the retained preview");
    }
    const cancelled = defer();
    const controller = new AbortController();
    const aborted = load("a.ts", "diff", controller.signal).catch((error: unknown) => error);
    controller.abort(); cancelled.resolve();
    assert.equal((await aborted as Error).name, "AbortError");

    store.snapshot.runtime = { ...original, sessionGeneration: 2 };
    const beforeGeneration = requests;
    await load();
    assert.equal(requests, beforeGeneration + 1);
    assert.equal(cached().generation, 2);
    store.snapshot.runtime = { ...original, workspace: { ...original.workspace, fileRevision: 4 } };
    fail = new ApiHttpError(403, "Access denied");
    await assert.rejects(load(), /Access denied/);
    assert.equal(cached(), undefined, "revoked access must remove retained content");
    fail = undefined;

    for (let index = 0; index < 40; index++) await load(`${index}.ts`);
    await load("0.ts");
    await load("40.ts");
    assert.equal(cached("1.ts"), undefined, "preview retention must stay bounded");
    assert.ok(cached("0.ts"), "revisited entries are retained ahead of inactive ones");
    for (let index = 0; index < 12; index++) {
      store.snapshot.runtime = { ...original, sessionId: `session-${index}` };
      await load();
    }
    assert.equal(store.cachedWorkspacePreview("0.ts", "diff", original), undefined);
    const closing = defer();
    const disposed = load("closing.ts").catch((error: unknown) => error);
    store.dispose(); closing.resolve();
    assert.match(String(await disposed), /stale workspace/);
    assert.equal(cached(), undefined);
    assert.equal(store.workspacePreviews.size, 0);
  } finally {
    store.dispose();
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
    t.mock.restoreAll();
    await vite.close();
  }
});
