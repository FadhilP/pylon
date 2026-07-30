import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../extensions/pi-verify.ts";

test("verify guidance requires one post-result response", () => {
  let tool: any;
  extension({
    registerTool: (value: any) => { tool = value; },
    on: () => {}, events: { emit: () => {} }, appendEntry: () => {},
  } as any);
  const guidance = tool.promptGuidelines.join("\n");
  assert.match(guidance, /tool-only assistant turn/i);
  assert.match(guidance, /no user-facing prose/i);
  assert.match(guidance, /exactly one evidence-aware final response/i);
  assert.doesNotMatch(guidance, /prose first|verification follows below/i);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  assert.match(tool.renderCall({ scope: "changed" }, theme).render(80).join("\n"), /Verify worktree changes/);
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
  assert.equal(result.terminate, undefined);
  assert.match(result.content[0].text, /^Verification passed\. 1\/1 checks: npm:test · \d+\.\ds\. Hygiene passed\.$/);
  assert.doesNotMatch(result.content[0].text, /Changed paths|PASS|npm run test|\nok\n?/);

  const injected = handlers.get("context")!({ messages: [] });
  assert.match(injected.messages.at(-1).content, /^Verification: passed;/);
  assert.doesNotMatch(injected.messages.at(-1).content, /command|durationMs|cwd/);
  assert.equal(handlers.get("context")!({ messages: [{
    role: "toolResult", toolName: "verify", details: result.details,
  }] }), undefined);
  handlers.get("tool_call")!({ toolName: "edit" });
  assert.equal(handlers.get("context")!({ messages: [] }), undefined);
});

test("Verify never terminates early, even when the assistant emitted prior prose", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-termination-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
  const run = async (
    kind: "passed" | "clean" | "no_checks" | "failed" | "cancelled" | "stale" | "error" | "invalid",
    prose = "Implemented the change; verification follows below.",
  ) => {
    const caseCwd = kind === "no_checks" ? await mkdtemp(join(tmpdir(), "pi-verify-no-checks-")) : cwd;
    let heads = 0;
    let tool: any;
    extension({
      registerTool: (value: any) => { tool = value; },
      on: () => {}, events: { emit: () => {} }, appendEntry: () => {},
      exec: async (command: string, args: string[]) => {
        if (command === "git" && args[0] === "rev-parse") {
          heads++;
          return kind === "error" ? { code: 1, stdout: "", stderr: "no git" }
            : { code: 0, stdout: `${kind === "stale" && heads > 1 ? "def" : "abc"}\n`, stderr: "" };
        }
        if (command === "git" && args[0] === "status")
          return { code: 0, stdout: kind === "clean" ? "" : kind === "failed" ? " M file.ts\n" : "", stderr: "" };
        if (command === "git" && args[0] === "diff")
          return { code: kind === "failed" ? 1 : 0, stdout: kind === "failed" ? "file.ts: bad whitespace\n" : "", stderr: "" };
        return { code: kind === "failed" ? 1 : 0, stdout: "", stderr: "" };
      },
    } as any);
    const id = `verify-${kind}`;
    return tool.execute(id, { scope: kind === "clean" ? "changed" : "project", ...(kind === "invalid" ? { checks: ["missing"] } : {}) }, kind === "cancelled" ? { aborted: true } : undefined, undefined, {
      cwd: caseCwd, hasUI: false,
      sessionManager: { getLeafEntry: () => ({ type: "message", message: { role: "assistant", content: [
        { type: "text", text: prose },
        { type: "toolCall", id, name: "verify" },
      ] } }) },
    });
  };

  for (const kind of ["passed", "clean", "no_checks", "failed", "cancelled", "stale", "error", "invalid"] as const) {
    const result = await run(kind);
    assert.equal(result.terminate, undefined, `${kind} must retain one evidence-aware follow-up`);
    assert.equal(result.details.terminal, undefined);
  }
});

test("tool-only passing Verify remains nonterminal and reports capped check IDs compactly", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-capped-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: {
    verify: "node verify.js", check: "node check.js", typecheck: "node types.js", lint: "node lint.js", test: "node test.js",
  } }));
  await writeFile(join(cwd, "Makefile"), "verify:\n\ncheck:\n\ntest:\n\nlint:\n");
  let tool: any;
  extension({
    registerTool: (value: any) => { tool = value; },
    on: () => {}, events: { emit: () => {} }, appendEntry: () => {},
    exec: async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
      if (command === "git") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "verbose successful command output", stderr: "" };
    },
  } as any);
  const result = await tool.execute("tool-only", { scope: "project" }, undefined, undefined, {
    cwd, hasUI: false,
    sessionManager: { getLeafEntry: () => ({ type: "message", message: { role: "assistant", content: [
      { type: "toolCall", id: "tool-only", name: "verify" },
    ] } }) },
  });
  assert.equal(result.terminate, undefined);
  assert.match(result.content[0].text, /6\/6 checks: npm:verify, npm:check, npm:typecheck, npm:lint, npm:test, make:verify/);
  assert.match(result.content[0].text, /Skipped by six-check cap \(3\): make:check, make:test, make:lint/);
  assert.doesNotMatch(result.content[0].text, /PASS|verbose successful command output|Changed paths/);
});

test("verify runs checks from independent child-package directories concurrently", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-parallel-"));
  for (const name of ["a", "b"]) {
    await mkdir(join(cwd, name));
    await writeFile(join(cwd, name, "package.json"), JSON.stringify({ scripts: { test: "node test.js" } }));
  }
  let tool: any;
  let active = 0;
  let peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  extension({
    registerTool: (value: any) => { tool = value; },
    on: () => {}, events: { emit: () => {} }, appendEntry: () => {},
    exec: async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
      if (command === "git") return { code: 0, stdout: "", stderr: "" };
      active++;
      peak = Math.max(peak, active);
      await gate;
      active--;
      return { code: 0, stdout: "ok\n", stderr: "" };
    },
  } as any);
  const running = tool.execute("parallel", { scope: "project" }, undefined, undefined, { cwd, hasUI: false });
  for (let attempt = 0; attempt < 100 && peak < 2; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(peak, 2);
  release();
  const result = await running;
  assert.equal(result.details.state, "passed");
  assert.deepEqual(result.details.results.map((item: any) => item.id), ["a/npm:test", "b/npm:test"]);
});

test("verify reports live elapsed runtime while a check runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-runtime-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node slow.js" } }));
  const tools = new Map<string, any>();
  const statuses: string[] = [];
  const updates: any[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: () => {}, events: { emit: () => {} }, appendEntry: () => {},
    exec: async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
      if (command === "git") return { code: 0, stdout: "", stderr: "" };
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      return { code: 0, stdout: "ok\n", stderr: "" };
    },
  };
  extension(pi);
  const result = await tools.get("verify").execute(
    "call", { scope: "project" }, undefined, (update: any) => updates.push(update),
    { cwd, hasUI: true, ui: { setStatus: (_id: string, status: string) => statuses.push(status) } },
  );
  assert.equal(result.details.state, "passed");
  assert.ok(result.details.durationMs >= 1_000);
  assert.ok(updates.some((update) => /^1s$/.test(update.content[0].text)));
  const runtimeUpdate = updates.find((update) => update.details.durationMs >= 1_000);
  assert.ok(runtimeUpdate);
  assert.ok(statuses.some((status) => /Running 1\/1 · 1s/.test(status)));
  const theme = { fg: (_color: string, text: string) => text };
  assert.match(
    tools.get("verify").renderResult(runtimeUpdate, { expanded: false }, theme).render(80).join("\n"),
    /Verification running · \d+ check\(s\) · 1s/,
  );
  assert.match(
    tools.get("verify").renderResult(result, { expanded: false }, theme).render(80).join("\n"),
    /Verification passed · 1 check\(s\) · 1\.\d+s/,
  );
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

test("runtime policy overrides model-supplied Verify checks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-verify-policy-"));
  await writeFile(join(cwd, "package.json"), JSON.stringify({
    scripts: { test: "node test.js", lint: "node lint.js" },
  }));
  let tool: any;
  const sessionHandlers = new Map<string, (value: any, ctx?: any) => any>();
  const eventHandlers = new Map<string, (value: any) => any>();
  const commands: string[] = [];
  extension({
    registerTool: (value: any) => { tool = value; },
    on: (name: string, handler: (value: any, ctx?: any) => any) => sessionHandlers.set(name, handler),
    events: {
      emit: () => {},
      on: (name: string, handler: (value: any) => any) => {
        eventHandlers.set(name, handler);
        return () => {};
      },
    },
    appendEntry: () => {},
    exec: async (command: string, args: string[]) => {
      if (command === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc\n", stderr: "" };
      if (command === "git") return { code: 0, stdout: "", stderr: "" };
      commands.push(args.join(" "));
      return { code: 0, stdout: "", stderr: "" };
    },
  } as any);
  sessionHandlers.get("session_start")!({}, {
    cwd,
    sessionManager: { getSessionId: () => "session", getEntries: () => [] },
  });
  eventHandlers.get("pylon:runtime-policy")!({
    version: 1,
    sessionId: "session",
    verify: { mode: "selected", checks: ["npm:lint"] },
  });
  await tool.execute("policy", { scope: "project", checks: ["npm:test"] }, undefined, undefined, {
    cwd,
    hasUI: false,
  });
  assert.deepEqual(commands, ["/d /s /c npm run lint"]);
});
