import test from "node:test";
import assert from "node:assert/strict";
import registerSearchTools, { workspacePath } from "../extensions/search-tools.ts";

test("search paths cannot escape workspace", () => {
  assert.equal(workspacePath("/workspace", "src"), "src");
  assert.throws(() => workspacePath("/workspace", "../secret"), /within workspace/);
});

test("rg uses argument arrays and reports no matches", async () => {
  const tools = new Map<string, any>();
  const calls: Array<{ command: string; args: string[] }> = [];
  registerSearchTools({
    registerTool(tool: any) { tools.set(tool.name, tool); },
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      return { stdout: "", stderr: "", code: 1, killed: false };
    },
  } as any);
  const result = await tools.get("rg").execute("id", { pattern: "a;b", path: "." }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(calls[0].command, "rg");
  assert.ok(calls[0].args.includes("a;b"));
  assert.match(result.content[0].text, /No matches/);
});

test("fd tries fdfind then directs model to built-in fallback", async () => {
  const tools = new Map<string, any>();
  const calls: string[] = [];
  registerSearchTools({
    registerTool(tool: any) { tools.set(tool.name, tool); },
    async exec(command: string) {
      calls.push(command);
      throw new Error("ENOENT");
    },
  } as any);
  const result = await tools.get("fd").execute("id", {}, undefined, undefined, { cwd: process.cwd() });
  assert.deepEqual(calls, ["fd", "fdfind"]);
  assert.match(result.content[0].text, /use find instead/);
});
