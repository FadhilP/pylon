import test from "node:test";
import assert from "node:assert/strict";
import { startsHeliosBrowser } from "../src/shared/browser-tool-activity.ts";
import type { ToolActivityReadModel } from "../src/shared/protocol/events.ts";

function tool(name: string, input?: unknown): ToolActivityReadModel {
  return { id: "tool-1", name, input: input === undefined ? undefined : JSON.stringify(input), status: "running" };
}

test("recognizes single and batched Helios browser starts", () => {
  assert.equal(startsHeliosBrowser(tool("helios_browser", { action: "start" })), true);
  assert.equal(startsHeliosBrowser(tool("helios_browser", { actions: [{ action: "navigate" }, { action: "start" }] })), true);
  assert.equal(startsHeliosBrowser(tool("helios_browser", { action: "navigate" })), false);
  assert.equal(startsHeliosBrowser(tool("web_scout", { action: "start" })), false);
  assert.equal(startsHeliosBrowser({ ...tool("helios_browser"), input: "invalid" }), false);
});
