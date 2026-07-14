import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../extensions/pi-verify.ts";

test("verify guidance keeps verification before final text", () => {
  let tool: any;
  extension({
    registerTool: (value: any) => { tool = value; },
    on: () => {}, events: { emit: () => {} }, appendEntry: () => {},
  } as any);
  const guidance = tool.promptGuidelines.join("\n");
  assert.match(guidance, /tool-only assistant turn/i);
  assert.match(guidance, /before writing final user-facing text/i);
  assert.match(guidance, /wait for its result and respond once/i);
});

test("verify publishes bounded result metadata and session entry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-extension-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node ok.js" } }));
  const tools = new Map<string, any>();
  const events: Array<{ channel: string; value: any }> = [];
  const entries: Array<{ type: string; data: any }> = [];
  const handlers = new Map<string, (event: any) => any>();
  const gitCalls: string[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (name: string, handler: (event: any) => any) => handlers.set(name, handler),
    events: { emit: (channel: string, value: any) => events.push({ channel, value }) },
    appendEntry: (type: string, data: any) => entries.push({ type, data }),
    exec: async (command: string, args: string[]) => {
      if (command === "git") gitCalls.push(args.join(" "));
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
      if (command === "git" && args[0] === "diff") return { code: 0, stdout: "", stderr: "" };
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
  assert.deepEqual(gitCalls, [
    "rev-parse HEAD",
    "status --porcelain=v1 --untracked-files=all",
    "diff --check HEAD --",
    "rev-parse HEAD",
    "status --porcelain=v1 --untracked-files=all",
  ]);
  const published = events.find((event) => event.channel === "pi-verify:result")?.value;
  assert.equal(published.state, "passed");
  assert.equal(entries[0]?.type, "pi-verify-result");
  assert.equal("output" in entries[0]!.data.results[0], false);
  assert.equal("output" in entries[0]!.data.hygiene, false);
  assert.equal("status" in entries[0]!.data.hygiene, false);
  assert.match(result.content[0].text, /Changed paths:\n M file\.ts/);
  assert.doesNotMatch(result.content[0].text, /\nok\n?/);

  const injected = handlers.get("context")!({ messages: [] });
  assert.match(injected.messages.at(-1).content, /^Verification: passed;/);
  assert.doesNotMatch(injected.messages.at(-1).content, /command|durationMs|cwd/);
  assert.equal(handlers.get("context")!({ messages: [{
    role: "toolResult", toolName: "verify", details: result.details,
  }] }), undefined);
  handlers.get("tool_call")!({ toolName: "edit" });
  assert.equal(handlers.get("context")!({ messages: [] }), undefined);
});

test("verify stops before declared checks when changed-set hygiene fails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-hygiene-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node ok.js" } }));
  const tools = new Map<string, any>();
  let checks = 0;
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: () => {}, events: { emit: () => {} }, appendEntry: () => {},
    exec: async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
      if (command === "git" && args[0] === "status") return { code: 0, stdout: " M file.ts\n?? debug.log\n", stderr: "" };
      if (command === "git" && args[0] === "diff") return { code: 1, stdout: "file.ts:1: trailing whitespace.\n", stderr: "" };
      checks++;
      return { code: 0, stdout: "ok\n", stderr: "" };
    },
  };
  extension(pi);
  const result = await tools.get("verify").execute(
    "call", { scope: "changed" }, undefined, undefined,
    { cwd, hasUI: false },
  );
  assert.equal(result.details.state, "failed");
  assert.equal(checks, 0);
  assert.match(result.content[0].text, /trailing whitespace/);
  assert.match(result.content[0].text, /\?\? debug\.log/);
});

test("verify keeps failed check diagnostics", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-failed-check-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node fail.js" } }));
  const tools = new Map<string, any>();
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: () => {}, events: { emit: () => {} }, appendEntry: () => {},
    exec: async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
      if (command === "git") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "decisive failure detail\n", stderr: "" };
    },
  };
  extension(pi);
  const result = await tools.get("verify").execute(
    "call", { scope: "project" }, undefined, undefined,
    { cwd, hasUI: false },
  );
  assert.equal(result.details.state, "failed");
  assert.match(result.content[0].text, /decisive failure detail/);
});

test("verify selects a stable child-package check ID", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-selection-"));
  const child = join(cwd, "package-a");
  await mkdir(child);
  await writeFile(join(child, "package.json"), JSON.stringify({ scripts: { check: "node check.js", test: "node test.js" } }));
  const tools = new Map<string, any>();
  const executions: Array<{ command: string; cwd?: string }> = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: () => {}, events: { emit: () => {} }, appendEntry: () => {},
    exec: async (command: string, args: string[], options: any) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
      if (command === "git") return { code: 0, stdout: " M file.ts\n", stderr: "" };
      executions.push({ command: [command, ...args].join(" "), cwd: options.cwd });
      return { code: 0, stdout: "ok\n", stderr: "" };
    },
  };
  extension(pi);
  const result = await tools.get("verify").execute(
    "call", { scope: "project", checks: ["package-a/npm:test"] }, undefined, undefined,
    { cwd, hasUI: false },
  );
  assert.equal(result.details.state, "passed");
  assert.equal(executions.length, 1);
  assert.equal(executions[0]?.cwd, child);
  assert.match(executions[0]!.command, /npm.*run.*test/);
  assert.equal(result.details.results[0].id, "package-a/npm:test");
});
