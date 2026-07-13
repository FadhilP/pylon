import test from "node:test";
import assert from "node:assert/strict";
import extension, { ringCompletionBell } from "../extensions/pi-focus.ts";

test("completion bell writes only in TUI mode", () => {
  let output = "";
  const write = (text: string) => { output += text; };
  ringCompletionBell("json", write);
  assert.equal(output, "");
  ringCompletionBell("tui", write);
  assert.equal(output, "\x07");
});

test("ui command toggles and reports completion bell", async () => {
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const pi: any = {
    getSessionName: () => undefined,
    getThinkingLevel: () => "low",
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  };
  extension(pi);
  let notification = "";
  const ctx: any = {
    mode: "json",
    ui: { notify: (text: string) => { notification = text; } },
  };
  await commands.get("ui").handler("status", ctx);
  assert.match(notification, /Completion bell: disabled/);
  await commands.get("ui").handler("bell on", ctx);
  assert.equal(notification, "Completion bell: enabled");
  await commands.get("ui").handler("status", ctx);
  assert.match(notification, /Completion bell: enabled/);
  await commands.get("ui").handler("bell off", ctx);
  assert.equal(notification, "Completion bell: disabled");
  assert.ok(handlers.has("agent_settled"));
});
