import test from "node:test";
import assert from "node:assert/strict";
import advisor from "../extensions/pi-advisor.ts";

test("advisor call renders the executor request instead of the user prompt", () => {
  let tool: any;
  const handlers = new Map<string, Function>();
  advisor({
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerTool: (value: any) => { tool = value; },
    registerCommand: () => {},
    events: { emit: () => {} },
    getActiveTools: () => [],
    setActiveTools: () => {},
  } as any);

  handlers.get("input")?.({ source: "interactive", text: "original user prompt" });
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const rendered = tool.renderCall(
    { request: "  Review   migration\npath risks.  " },
    theme,
    { state: {} },
  ).render(1_000).join("\n");

  assert.match(rendered, /Review migration path risks\./);
  assert.doesNotMatch(rendered, /original user prompt/);
  assert.ok(tool.parameters.required.includes("request"));
});
