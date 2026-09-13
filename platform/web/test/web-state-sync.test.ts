import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { HostPreferences } from "../src/shared/settings/web-state.ts";

const preferences = (revision: number, patch: Partial<HostPreferences> = {}): HostPreferences => ({
  revision,
  initialized: true,
  theme: "system",
  syntax: "auto",
  hiddenModels: [],
  databaseWorkspace: "session",
  ...patch,
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve };
}

test("web-state writes serialize, revision-gate HTTP/SSE races, and validate scoped SSE payloads", async () => {
  const jiti = createJiti(import.meta.url);
  const { RuntimeEventStore } = await jiti.import<{
    RuntimeEventStore: new () => {
      getSnapshot(): { connection: string; hostPreferences?: HostPreferences; sequence: number };
      patchHostPreferences(patch: Partial<Omit<HostPreferences, "revision" | "initialized">>): Promise<HostPreferences>;
      saveHostPreferences(revision: number, input: Omit<HostPreferences, "revision">): Promise<HostPreferences>;
      subscribeWebState(kind: "explorer" | "composer" | "database", listener: (value: unknown) => void): () => void;
      dispose(): void;
    };
  }>("../src/client/runtime/event-store.ts");
  const oldWindow = globalThis.window;
  const raf = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  globalThis.window = Object.assign(new EventTarget(), { setTimeout, clearTimeout }) as Window & typeof globalThis;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  class Source extends EventTarget {
    onopen?: () => void;
    closed = false;
    close() { this.closed = true; }
  }
  const sources: Source[] = [];
  const writes: Array<{ revision: number; input: Omit<HostPreferences, "revision">; pending: ReturnType<typeof deferred<HostPreferences>> }> = [];
  let bootstrapCalls = 0;
  const store = new RuntimeEventStore();
  const internal = store as unknown as { api: unknown; bootstrap(): Promise<void> };
  const boot = () => ({
    protocolVersion: PROTOCOL_VERSION,
    sequence: 0,
    sessionGeneration: 1,
    csrfToken: "test",
    runtime: null,
    unseenCompletionSessionIds: [],
    keyboardSettings: { revision: 0, keymap: { preset: "pylon", overrides: {} } },
    hostPreferences: preferences(0),
  });
  internal.api = {
    bootstrap: async () => { bootstrapCalls++; return boot(); },
    events: () => { const source = new Source(); sources.push(source); return source; },
    keyboardSettings: async () => ({ revision: 0, keymap: { preset: "pylon", overrides: {} } }),
    hostPreferences: async () => preferences(0),
    saveHostPreferences: (revision: number, input: Omit<HostPreferences, "revision">) => {
      const pending = deferred<HostPreferences>();
      writes.push({ revision, input, pending });
      return pending.promise;
    },
  };
  const event = (type: "web.preferences" | "web.explorer", sequence: number, payload: unknown) =>
    sources[sources.length - 1]!.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({
      protocolVersion: PROTOCOL_VERSION, payloadVersion: 1, eventId: `${type}-${sequence}`,
      sessionId: "none", sessionGeneration: 1, sequence, type, occurredAt: new Date().toISOString(), payload,
    }) }));
  try {
    await internal.bootstrap();
    sources[0].onopen?.();

    const theme = store.patchHostPreferences({ theme: "dark" });
    const syntax = store.patchHostPreferences({ syntax: "dracula" });
    await Promise.resolve();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].revision, 0);
    writes[0].pending.resolve(preferences(1, { theme: "dark" }));
    await theme;
    await Promise.resolve();
    assert.equal(writes.length, 2);
    assert.equal(writes[1].revision, 1);
    assert.equal(writes[1].input.theme, "dark");
    assert.equal(writes[1].input.syntax, "dracula");
    writes[1].pending.resolve(preferences(2, { theme: "dark", syntax: "dracula" }));
    await syntax;

    const current = preferences(2);
    const { revision: _revision, ...oldInput } = current;
    const oldHttp = store.saveHostPreferences(2, { ...oldInput, theme: "warm" });
    event("web.preferences", 1, preferences(3, { theme: "light", syntax: "nord" }));
    writes[2].pending.resolve(preferences(2, { theme: "warm" }));
    await oldHttp;
    assert.deepEqual(store.getSnapshot().hostPreferences, preferences(3, { theme: "light", syntax: "nord" }));

    const received: unknown[] = [];
    store.subscribeWebState("explorer", value => received.push(value));
    const scoped = { projectId: "project", state: { projectId: "project", open: ["src"], changesOnly: false, revision: 0, updatedAt: 1 } };
    event("web.explorer", 2, scoped);
    assert.deepEqual(received, [scoped]);
    event("web.explorer", 3, { projectId: "project", state: { invalid: true } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(received.length, 1);
    assert.equal(sources[0].closed, true);
    assert.equal(bootstrapCalls, 2);
  } finally {
    store.dispose();
    globalThis.window = oldWindow;
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = cancel;
  }
});
