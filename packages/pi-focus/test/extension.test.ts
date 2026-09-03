import test from "node:test";
import assert from "node:assert/strict";
import focus from "../extensions/pi-focus.ts";

test("/ui rejects RPC mutations without changing focused UI state", async () => {
  let command: any;
  focus({
    events: { on: () => () => {} },
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


test("focused editor renders an empty prompt with Pi's editor theme", async () => {
  const handlers = new Map<string, any>();
  let editorFactory: any;
  const theme = {
    name: "focus-dark",
    fg: (_color: string, text: string) => text,
  };
  focus({
    events: { on: () => () => {} },
    on(name: string, handler: any) {
      handlers.set(name, handler);
    },
    registerCommand() {},
    getSessionName: () => "test",
    getThinkingLevel: () => "off",
  } as any);

  const ui = {
    theme,
    setTitle() {},
    setHeader() {},
    setFooter() {},
    setEditorComponent(factory: any) {
      editorFactory = factory;
    },
    setWorkingIndicator() {},
  };
  await handlers.get("session_start")({}, { mode: "tui", cwd: process.cwd(), ui, model: { id: "test-model" } });

  const editorTheme = {
    borderColor: (text: string) => text,
    selectList: {},
  };
  const editor = editorFactory(
    { requestRender() {}, terminal: { rows: 24, columns: 80 } },
    editorTheme,
    { matches: () => false },
  );

  assert.doesNotThrow(() => editor.render(40));
});
