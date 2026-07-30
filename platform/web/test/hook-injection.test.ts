import test from "node:test";
import assert from "node:assert/strict";
import { HookInjectionBridge, SESSION_START_HOOK_CUSTOM_TYPE } from "../src/server/pi/hook-injection.ts";

const settings = {
  sessionStart: { enabled: true, sources: [{ id: "one", name: "One", kind: "text" as const, content: "START" }] },
  beforeAgentStart: { enabled: true, sources: [{ id: "two", name: "Two", kind: "text" as const, content: "BEFORE" }] },
};

test("hook bridge persists session-start context once per branch and composes transient prompts", () => {
  const handlers = new Map<string, Function[]>();
  const messages: unknown[] = [];
  const extension = new HookInjectionBridge(settings).extension;
  if (typeof extension === "function") throw new Error("expected named inline extension");
  extension.factory({
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
});
