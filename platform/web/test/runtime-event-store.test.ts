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
