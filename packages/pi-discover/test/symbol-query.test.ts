import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createIndexLifecycle } from "../src/index-lifecycle.ts";
import type { IndexProvider } from "../src/index.ts";

test("web symbol requests stay bound to the active workspace and propagate query failures", async () => {
  const calls: string[] = [];
  const index = {
    refresh: async () => {},
    status: async () => ({ files: 1, symbols: 1 }),
    searchSymbols: async (cwd: string, input: { query: string; limit: number }) => {
      calls.push(cwd);
      assert.equal(input.limit, 200);
      if (input.query === "failure") throw new Error("refresh failed");
      return Object.assign([{ name: "needle", path: "a.ts", line: 1 }], { moreAvailable: true });
    },
  };
  const lifecycle = createIndexLifecycle(
    { events: { emit() {} } } as unknown as ExtensionAPI,
    (() => index) as unknown as IndexProvider,
  );
  const query = (cwd: string, text: string) =>
    new Promise<any>((resolve, reject) => {
      lifecycle.handleSymbolQuery({ version: 1, cwd, query: text, acknowledge() {}, resolve, reject });
    });
  await assert.rejects(query("workspace", "needle"), /unavailable/);
  await lifecycle.runCommand("refresh", { cwd: "workspace", ui: { setStatus() {}, notify() {} } });
  await assert.rejects(query("other", "needle"), /unavailable/);
  assert.equal(calls.length, 0);
  const result = await query("workspace", "needle");
  assert.equal(result.symbols[0].path, "a.ts");
  assert.equal(result.moreAvailable, true);
  await assert.rejects(query("workspace", "failure"), /refresh failed/);
  await lifecycle.stop();
  await assert.rejects(query("workspace", "needle"), /unavailable/);
  assert.deepEqual(calls, ["workspace", "workspace"]);
});
