import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { KeyboardSettings } from "../src/shared/keyboard.ts";

// Exercise the actual client store; Jiti resolves its browser-style extensionless TS imports.
test("keyboard SSE and HTTP replies share a revision gate; authoritative bootstrap invalidates old requests", async () => {
  const jiti = createJiti(import.meta.url);
  const { RuntimeEventStore } = await jiti.import<{
    RuntimeEventStore: new () => {
      getSnapshot(): { connection: string; keyboardSettings?: KeyboardSettings; sequence: number };
      saveKeyboardSettings(revision: number, keymap: KeyboardSettings["keymap"]): Promise<void>;
      dispose(): void;
    };
  }>("../src/client/runtime/event-store.ts");
  const raf = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  const previousWindow = globalThis.window;
  globalThis.window = Object.assign(new EventTarget(), { setTimeout, clearTimeout }) as unknown as Window &
    typeof globalThis;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  class Source extends EventTarget {
    onopen?: () => void;
    close() {}
  }
  let source: Source;
  let resolveSave: (value: KeyboardSettings) => void;
  const value = (revision: number): KeyboardSettings => ({
    revision,
    keymap: { preset: "pylon", overrides: { theme: { kind: "chord", key: `F${revision + 1}`, modifiers: [] } } },
  });
  let boot = {
    protocolVersion: PROTOCOL_VERSION,
    sequence: 0,
    sessionGeneration: 1,
    csrfToken: "test",
    runtime: null,
    unseenCompletionSessionIds: [],
    keyboardSettings: value(2),
  };
  const store = new RuntimeEventStore();
  const internal = store as unknown as { api: unknown; bootstrap(): Promise<void> };
  internal.api = {
    bootstrap: async () => boot,
    events: () => {
      source = new Source();
      return source;
    },
    saveKeyboardSettings: () =>
      new Promise<KeyboardSettings>(resolve => {
        resolveSave = resolve;
      }),
  };
  const event = (revision: number, sequence: number) =>
    source.dispatchEvent(
      new MessageEvent("keyboard.settings", {
        data: JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          payloadVersion: 1,
          eventId: `event-${sequence}`,
          sessionId: "none",
          sessionGeneration: 1,
          sequence,
          type: "keyboard.settings",
          occurredAt: new Date().toISOString(),
          payload: value(revision),
        }),
      }),
    );
  try {
    await internal.bootstrap();
    source!.onopen?.();
    assert.equal(store.getSnapshot().connection, "connected");
    const saving = store.saveKeyboardSettings(2, value(3).keymap);
    event(4, 1);
    resolveSave!(value(3));
    await saving;
    assert.deepEqual(store.getSnapshot().keyboardSettings, value(4));
    event(3, 2);
    assert.equal(store.getSnapshot().sequence, 2);
    assert.deepEqual(store.getSnapshot().keyboardSettings, value(4));
    const oldRequest = store.saveKeyboardSettings(4, value(5).keymap);
    boot = { ...boot, sessionGeneration: 2, keyboardSettings: value(0) };
    await internal.bootstrap();
    source!.onopen?.();
    resolveSave!(value(5));
    await assert.rejects(oldRequest, /Connection changed/);
    assert.deepEqual(store.getSnapshot().keyboardSettings, value(0));
  } finally {
    store.dispose();
    globalThis.requestAnimationFrame = raf;
    globalThis.cancelAnimationFrame = cancel;
    globalThis.window = previousWindow;
  }
});
