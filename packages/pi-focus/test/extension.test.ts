import test from "node:test";
import assert from "node:assert/strict";
import focus from "../extensions/pi-focus.ts";

test("/ui rejects RPC mutations without changing focused UI state", async () => {
  let command: any;
  focus({
    on() {},
    registerCommand(_name: string, value: any) {
      command = value;
    },
    getSessionName: () => "test",
    getThinkingLevel: () => "off",
  } as any);
  const notifications: Array<{ text: string; level: string }> = [];
  let uiMutations = 0;
  const ui = {
    notify(text: string, level: string) {
      notifications.push({ text, level });
    },
    setHeader() {
      uiMutations++;
    },
    setFooter() {
      uiMutations++;
    },
    setEditorComponent() {
      uiMutations++;
    },
    setWorkingIndicator() {
      uiMutations++;
    },
    setWidget() {
      uiMutations++;
    },
    setStatus() {
      uiMutations++;
    },
  };
  const rpc = { mode: "rpc", ui };
  await command.handler("disable", rpc);
  assert.equal(notifications.at(-1)?.level, "error");
  assert.equal(uiMutations, 0);

  const tui = { ...rpc, mode: "tui" };
  await command.handler("status", tui);
  assert.match(notifications.at(-1)?.text ?? "", /UI: enabled/);
  assert.match(notifications.at(-1)?.text ?? "", /Density: compact/);
});
