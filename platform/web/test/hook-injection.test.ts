import test from "node:test";
import assert from "node:assert/strict";
import { HookInjectionBridge, SESSION_START_HOOK_CUSTOM_TYPE } from "../src/server/pi/hook-injection.ts";

const settings = {
  sessionStart: { enabled: true, sources: [
    { id: "one", name: "One", kind: "text" as const, content: "START", reinjectOnCompaction: true },
    { id: "once", name: "Once", kind: "text" as const, content: "ONCE", reinjectOnCompaction: false },
  ] },
  beforeAgentStart: { enabled: true, sources: [{ id: "two", name: "Two", kind: "text" as const, content: "BEFORE", reinjectOnCompaction: false }] },
};

test("hook bridge persists session-start context once per branch and composes transient prompts", () => {
  const handlers = new Map<string, Function[]>();
  const busHandlers = new Map<string, Function>();
  const messages: unknown[] = [];
  const extension = new HookInjectionBridge(settings).extension;
  if (typeof extension === "function") throw new Error("expected named inline extension");
  extension.factory({
    events: {
      on(name: string, handler: Function) {
        busHandlers.set(name, handler);
        return () => busHandlers.delete(name);
      },
    },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    sendMessage(message: unknown) { messages.push(message); },
  } as any);
  const branch: any[] = [];
  const context = { sessionManager: { getBranch: () => branch } };
  handlers.get("session_start")![0]!({}, context);
  assert.equal(messages.length, 1);
  assert.equal((messages[0] as any).customType, SESSION_START_HOOK_CUSTOM_TYPE);
  branch.push({ type: "custom_message", customType: SESSION_START_HOOK_CUSTOM_TYPE });
  handlers.get("session_start")![0]!({}, context);
  assert.equal(messages.length, 1);
  const result = handlers.get("before_agent_start")![0]!({ systemPrompt: "BASE" }, context);
  assert.match(result.systemPrompt, /^BASE\n\n<pylon-hook/);
  assert.match(result.systemPrompt, /BEFORE/);

  handlers.get("session_compact")![0]!({ compactionEntry: { id: "compact-1" } }, context);
  assert.equal(messages.length, 2);
  assert.match((messages[1] as any).content, /hook="sessionCompact"/);
  assert.match((messages[1] as any).content, /START/);
  assert.doesNotMatch((messages[1] as any).content, /ONCE/);
  assert.deepEqual((messages[1] as any).details, { version: 1, compactionEntryId: "compact-1" });
  branch.push({ type: "custom_message", customType: SESSION_START_HOOK_CUSTOM_TYPE, details: { compactionEntryId: "compact-1" } });
  handlers.get("session_compact")![0]!({ compactionEntry: { id: "compact-1" } }, context);
  assert.equal(messages.length, 2);
  handlers.get("session_compact")![0]!({ compactionEntry: { id: "compact-2" } }, context);
  assert.equal(messages.length, 3);
  branch.push({ type: "custom_message", message: { customType: SESSION_START_HOOK_CUSTOM_TYPE, details: { compactionEntryId: "compact-2" } } });
  handlers.get("session_compact")![0]!({ compactionEntry: { id: "compact-2" } }, context);
  assert.equal(messages.length, 3);

  let spawnHooks: any;
  busHandlers.get("pylon:spawn-hooks-request")!({ version: 1, provide: (value: unknown) => { spawnHooks = value; } });
  assert.equal(spawnHooks.sessionStart.customType, SESSION_START_HOOK_CUSTOM_TYPE);
  assert.match(spawnHooks.sessionStart.content, /START/);
  assert.match(spawnHooks.sessionCompact.content, /START/);
  assert.doesNotMatch(spawnHooks.sessionCompact.content, /ONCE/);
  assert.match(spawnHooks.beforeAgentStart, /BEFORE/);
  handlers.get("session_shutdown")![0]!();
  assert.equal(busHandlers.has("pylon:spawn-hooks-request"), false);
});
