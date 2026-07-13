import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../extensions/pi-verify.ts";

test("verify publishes bounded result metadata and session entry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-extension-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node ok.js" } }));
  const tools = new Map<string, any>();
  const events: Array<{ channel: string; value: any }> = [];
  const entries: Array<{ type: string; data: any }> = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: () => {},
    events: { emit: (channel: string, value: any) => events.push({ channel, value }) },
    appendEntry: (type: string, data: any) => entries.push({ type, data }),
    exec: async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
      if (command === "git") return { code: 0, stdout: " M file.ts\n", stderr: "" };
      return { code: 0, stdout: "ok\n", stderr: "" };
    },
  };
  extension(pi);
  const result = await tools.get("verify").execute(
    "call", { scope: "changed" }, undefined, undefined,
    { cwd, hasUI: false },
  );
  assert.equal(result.details.state, "passed");
  assert.match(result.details.worktreeId, /^[a-f0-9]{16}$/);
  const published = events.find((event) => event.channel === "pi-verify:result")?.value;
  assert.equal(published.state, "passed");
  assert.equal(entries[0]?.type, "pi-verify-result");
  assert.equal("output" in entries[0]!.data.results[0], false);
});
