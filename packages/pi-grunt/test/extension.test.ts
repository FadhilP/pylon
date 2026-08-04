import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import grunt from "../extensions/pi-grunt.ts";
import { saveConfig } from "../src/config.ts";
import type { WorkerRun } from "../src/runner.ts";

const execFileAsync = promisify(execFile);

class Bus {
  handlers = new Map<string, Set<(value: any) => void>>();
  on(name: string, handler: (value: any) => void) {
    const handlers = this.handlers.get(name) ?? new Set();
    handlers.add(handler); this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }
  emit(name: string, value: any) { for (const handler of this.handlers.get(name) ?? []) handler(value); }
}

test("Grunt runs synchronously with per-call thinking and derives changed paths", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "grunt-extension-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  await execFileAsync("git", ["init", cwd]);
  await writeFile(join(cwd, "README.md"), "base\n");
  await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
  await mkdir(join(cwd, "node_modules"));
  await writeFile(join(cwd, "node_modules", "installed.txt"), "available only in parent\n");
  await execFileAsync("git", ["-C", cwd, "add", "README.md", ".gitignore"]);
  await execFileAsync("git", ["-C", cwd, "-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "base"]);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const events = new Bus();
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const handlers = new Map<string, Function[]>();
    const notifications: Array<{ text: string; level: string }> = [];
    let active: string[] = [];
    let childArgs: string[] = [];
    const model = { provider: "test", id: "worker" };
    let workerCwd = "";
    const workerCwds: string[] = [];
    let workerAttempts = 0;
    let outcome: "completed" | "blocked" = "completed";
    const runningUpdates: any[] = [];
    const runWorker = async (args: string[], options: { cwd: string; onActivity?: Function; onUsage?: Function }): Promise<WorkerRun> => {
      childArgs = args;
      workerCwd = options.cwd;
      workerCwds.push(options.cwd);
      workerAttempts++;
      if (workerAttempts === 1) {
        options.onUsage?.({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
        return {
        text: "", cwd: options.cwd, model: "worker", stopReason: "error", error: "503 model at capacity",
        failure: "child_error", stderr: "", durationMs: 2,
        usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, turns: 1,
        truncated: false, exitCode: 1, activity: [],
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      options.onUsage?.({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 });
      options.onActivity?.(
        { kind: "call", tool: "read", text: "README.md" },
        [{ kind: "call", tool: "read", text: "README.md" }],
      );
      await mkdir(join(options.cwd, "src"), { recursive: true });
      const file = outcome === "completed" ? "worker.ts" : "blocked.ts";
      await writeFile(join(options.cwd, "src", file), `export const ${outcome} = true;\n`);
      return {
        text: `Status: ${outcome}\nChanged files: src/${file}`, cwd: options.cwd, model: "worker", stopReason: "stop", stderr: "", durationMs: 2,
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 }, turns: 1,
        truncated: false, exitCode: 0, activity: [],
      };
    };
    const pi: any = {
      events,
      on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerTool: (tool: any) => { tools.set(tool.name, tool); active.push(tool.name); },
      registerCommand: (name: string, command: any) => commands.set(name, command),
      getActiveTools: () => active,
      setActiveTools: (value: string[]) => { active = value; },
      exec: async (command: string, args: string[]) => {
        try {
          const result = await execFileAsync(command, args, { encoding: "utf8" });
          return { code: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error: any) {
          return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
        }
      },
    };
    await saveConfig({ version: 1, disabled: false, mode: "dynamic" });
    grunt(pi, runWorker as any, async () => true);
    const ctx: any = {
      cwd, hasUI: false, model,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }), find: () => model, hasConfiguredAuth: () => true },
      sessionManager: { buildContextEntries: () => [{ type: "message", message: { role: "user", content: "Add worker" } }] },
      ui: { setStatus() {}, notify: (text: string, level: string) => notifications.push({ text, level }) },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    const result = await tools.get("grunt").execute("id", {
      task: "Add trivial worker module", thinking: "medium", suggestedPaths: ["src/**"],
      targetedContext: "Copy the existing exported-constant convention.",
      checkCommands: ["npm test -- worker"],
    }, undefined, (update: any) => runningUpdates.push(update), ctx);
    const activityUpdate = runningUpdates.find((update) => update.details?.activity?.length);
    assert.equal(activityUpdate.details.state, "running");
    assert.ok(activityUpdate.details.durationMs > 0);
    assert.deepEqual([...new Set(runningUpdates.flatMap((update) => update.details?.usage ? [update.details.usage.input] : []))], [1, 2]);
    assert.equal(result.details.usage.input, 2);
    assert.equal(result.details.status, "completed");
    assert.equal(result.details.applied, true);
    assert.equal(result.details.isolated, true);
    assert.equal(result.details.mode, "isolated");
    assert.equal(result.details.configuredMode, "dynamic");
    assert.equal(result.details.isolationVerified, true);
    assert.equal(result.details.attempts, 2);
    assert.equal(workerAttempts, 2);
    assert.notEqual(workerCwds[0], workerCwds[1]);
    assert.equal(result.details.workerCwd, workerCwd);
    assert.notEqual(workerCwd, cwd);
    assert.equal(result.details.changedPaths, undefined);
    assert.equal(result.details.outsideSuggestedPaths, undefined);
    assert.doesNotMatch(result.content[0].text, /Derived changed paths|Worker report/);
    assert.equal(childArgs[childArgs.indexOf("--thinking") + 1], "medium");
    assert.ok(childArgs.includes("--no-session"));
    assert.ok(childArgs.includes("--no-extensions"));
    assert.ok(childArgs.includes("--system-prompt"));
    assert.ok(!childArgs.includes("--append-system-prompt"));
    assert.match(childArgs.at(-1) ?? "", /Targeted context.*exported-constant convention/s);
    assert.match(childArgs.at(-1) ?? "", /Focused checks:\n- npm test -- worker/);
    assert.match(childArgs.at(-1) ?? "", /Unavailable ignored dependency directories: node_modules/);
    assert.equal(result.details.missingDependencies, undefined);
    assert.deepEqual(result.details.metrics, {
      workerStatus: "completed", integrationStatus: "completed", workerCostUsd: 0,
      turns: 2, inputTokens: 2, outputTokens: 2, cacheReadTokens: 0,
      cacheWriteTokens: 0, changedFileCount: 1,
    });
    assert.equal((await import("node:fs/promises").then((fs) => fs.readFile(join(cwd, "src", "worker.ts"), "utf8"))).replace(/\r\n/g, "\n"), "export const completed = true;\n");

    outcome = "blocked";
    const blocked = await tools.get("grunt").execute("blocked", { task: "Attempt uncertain work", thinking: "high", suggestedPaths: ["src/**"] }, undefined, undefined, ctx);
    assert.equal(blocked.details.status, "partial");
    assert.equal(blocked.details.applied, false);
    assert.deepEqual(blocked.details.changedPaths, ["src/blocked.ts"]);
    assert.match(blocked.content[0].text, /Worker report/);
    assert.equal(blocked.details.metrics.workerStatus, "partial");
    assert.equal(blocked.details.metrics.integrationStatus, "partial");
    assert.ok(blocked.details.artifactPath);
    await access(blocked.details.artifactPath);
    await assert.rejects(access(join(cwd, "src", "blocked.ts")));

    await commands.get("grunt").handler("dynamic", ctx);
    assert.deepEqual(notifications.at(-1), {
      text: "Grunt mode: dynamic. Uses isolation with a Git HEAD; DIRECT otherwise.",
      level: "info",
    });
    await commands.get("grunt").handler("direct", ctx);
    assert.deepEqual(notifications.at(-1), {
      text: "Grunt mode: DIRECT. Worker edits affect the current working directory immediately.",
      level: "warning",
    });
    outcome = "completed";
    const direct = await tools.get("grunt").execute("direct", { task: "Edit current working directory", thinking: "medium" }, undefined, undefined, ctx);
    assert.equal(direct.details.status, "completed");
    assert.equal(direct.details.mode, "direct");
    assert.equal(direct.details.isolated, false);
    assert.equal(direct.details.workerCwd, cwd);
    assert.match(direct.content[0].text, /partial edits|affected the current working directory/i);
    assert.doesNotMatch(direct.content[0].text, /Worker report/);
    await commands.get("grunt").handler("status", ctx);
    assert.match(notifications.at(-1)!.text, /2\/3 integrated · 1 requiring main attention · 4 turns/);
    assert.match(notifications.at(-1)!.text, /exclude main-model handoff, review, repair, and verification cost/);
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "new" }, ctx);
    await commands.get("grunt").handler("status", ctx);
    assert.match(notifications.at(-1)!.text, /Session worker metrics: no runs yet/);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
    await assert.rejects(access(blocked.details.artifactPath));
    await assert.rejects(access(dirname(blocked.details.artifactPath)));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("dynamic mode falls back to direct when isolation setup fails", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "grunt-dynamic-fallback-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const tools = new Map<string, any>();
    const pi: any = {
      events: new Bus(), on() {}, registerCommand() {}, getActiveTools: () => [], setActiveTools() {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
      exec: async (_command: string, args: string[]) => args.includes("--is-inside-work-tree")
        ? { code: 0, stdout: "true\ndeadbeef\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "worktree setup failed" },
    };
    await saveConfig({ version: 1, disabled: false, mode: "dynamic" });
    grunt(pi, async (_args, options) => ({
      text: "Status: completed", cwd: options.cwd, model: "worker", stopReason: "stop", stderr: "", durationMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, turns: 1,
      truncated: false, exitCode: 0, activity: [],
    }));
    const model = { provider: "test", id: "worker" };
    const result = await tools.get("grunt").execute("id", { task: "Edit file", thinking: "medium" }, undefined, undefined, {
      cwd: root, hasUI: false, model,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }), find: () => model },
    });
    assert.equal(result.details.mode, "direct");
    assert.equal(result.details.configuredMode, "dynamic");
    assert.equal(result.details.workerCwd, root);
    assert.equal(result.details.isolationFallback, "worktree setup failed");
    assert.match(result.content[0].text, /Dynamic isolation fallback: worktree setup failed/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("Grunt publishes sanitized bounded worker and outer failure details", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "grunt-failure-details-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const tools = new Map<string, any>();
    const pi: any = {
      events: new Bus(), on() {}, registerCommand() {}, getActiveTools: () => [], setActiveTools() {},
      registerTool: (tool: any) => tools.set(tool.name, tool), exec() {},
    };
    const secret = `sk-${"x".repeat(40)}`;
    let outcome: "failure" | "transient" | "success" | "throw" = "failure";
    let workerCalls = 0;
    await saveConfig({ version: 1, disabled: false, mode: "direct" });
    grunt(pi, async (_args, options): Promise<WorkerRun> => {
      workerCalls++;
      if (outcome === "throw") throw { private: "value" };
      return {
        text: outcome === "success" ? "Status: completed" : "",
        cwd: options.cwd, model: "worker", stopReason: "stop", stderr: "", durationMs: 1,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, turns: 1,
        truncated: false, exitCode: outcome === "success" ? 0 : 1, activity: [],
        ...(outcome === "failure" || outcome === "transient" ? {
          error: outcome === "transient" ? "503 model at capacity" : `bad\napi_key=${secret}\u0085\u2028${"z".repeat(600)}`,
          failure: "child_error" as const,
        } : {}),
      };
    }, async () => true);
    const model = { provider: "test", id: "worker" };
    const ctx: any = {
      cwd: root, hasUI: false, model,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }), find: () => model },
    };

    const failed = await tools.get("grunt").execute(
      "failed", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx,
    );
    assert.equal(failed.details.failureCode, "child_error");
    assert.ok(failed.details.failureMessage.length <= 500);
    assert.doesNotMatch(failed.details.failureMessage, new RegExp(secret));
    assert.doesNotMatch(failed.details.failureMessage, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    assert.match(failed.content[0].text, /\[REDACTED\]/);
    assert.doesNotMatch(failed.content[0].text, new RegExp(secret));

    outcome = "transient";
    const callsBeforeTransient = workerCalls;
    const transient = await tools.get("grunt").execute(
      "transient", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx,
    );
    assert.equal(workerCalls, callsBeforeTransient + 1);
    assert.equal(transient.details.attempts, 1);

    outcome = "success";
    const succeeded = await tools.get("grunt").execute(
      "success", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx,
    );
    assert.equal(Object.hasOwn(succeeded.details, "failureMessage"), false);

    outcome = "throw";
    const thrown = await tools.get("grunt").execute(
      "throw", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx,
    );
    assert.equal(thrown.details.failureCode, "worker_error");
    assert.equal(thrown.details.failureMessage, "Grunt execution failed.");
    assert.doesNotMatch(thrown.content[0].text, /private|value/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("Grunt guidance favors high-displacement work and retains Main ownership", () => {
  const events = new Bus();
  const tools = new Map<string, any>();
  const pi: any = {
    events, on() {}, registerCommand() {}, getActiveTools: () => [], setActiveTools() {},
    registerTool: (tool: any) => tools.set(tool.name, tool), exec() {},
  };
  grunt(pi);
  const tool = tools.get("grunt");
  const guidance = tool.promptGuidelines.join("\n");
  assert.deepEqual(tool.parameters.properties.thinking.enum, ["medium", "high"]);
  assert.equal(tool.parameters.properties.targetedContext.maxLength, 4000);
  assert.equal(tool.parameters.properties.checkCommands.maxItems, 8);
  assert.match(tool.description, /Main model reviews and verifies/i);
  assert.match(guidance, /expected main-model effort avoided, not changed LOC alone/i);
  assert.match(guidance, /ordinary semantic changes around 50–300 LOC in the main model/i);
  assert.match(guidance, /mechanical multi-file work/i);
  assert.match(guidance, /typically 300–500\+ LOC/i);
  assert.match(guidance, /Use the lowest configured thinking level that fits/i);
  assert.match(guidance, /dependent slices sequentially, inspecting and checking each result first/i);
  assert.match(guidance, /main model owns integration and recovery/i);
  assert.match(guidance, /Fix small remaining defects directly/i);
  assert.match(guidance, /Never call grunt only to verify or repair its previous result/i);
  assert.match(guidance, /self-contained medium or large work/i);
  assert.match(guidance, /without rollback, stale-parent checks, changed-path detection/i);
  assert.ok(guidance.length < 1_000);

  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  assert.equal(
    tool.renderCall({ task: "Implement change", thinking: "medium" }, theme, { state: {} }).render(1_000).map((line: string) => line.trimEnd()).join("\n"),
    "Grunt · 1/∞\nImplement change",
  );
  assert.equal(
    tool.renderResult({
      content: [{ type: "text", text: "Worker details" }],
      details: {
        status: "completed",
        model: "test/worker",
        durationMs: 1_250,
        usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
        turns: 1,
      },
    }, { expanded: false }, theme).render(1_000).map((line: string) => line.trimEnd()).join("\n"),
    "Grunt · test/worker · 1 turn · 1 input · 2 output · R3 · W4 · $0.5000 · 1.3s",
  );

  let runtimeColor = "";
  tool.renderResult({
    content: [{ type: "text", text: "1s" }],
    details: { state: "running", model: "test/worker", durationMs: 1_000 },
  }, { expanded: false }, {
    fg: (color: string, text: string) => { runtimeColor = color; return text; },
  });
  assert.equal(runtimeColor, "success");

  let errorColor = "";
  tool.renderResult({
    content: [{ type: "text", text: "Grunt isolation unavailable: not a Git worktree" }],
    details: { status: "unavailable", failureCode: "isolation_error" },
  }, { expanded: false }, {
    fg: (color: string, text: string) => { errorColor = color; return text; },
  }, { isError: true });
  assert.equal(errorColor, "error");
});

test("configured thinking levels update the tool schema and are revalidated at execution", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "grunt-thinking-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    await saveConfig({ version: 1, disabled: false, mode: "direct", thinkingLevels: ["low", "xhigh"] });
    const handlers = new Map<string, Function[]>();
    const tools = new Map<string, any>();
    let active: string[] = [];
    const pi: any = {
      events: new Bus(),
      on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {},
      getActiveTools: () => active, setActiveTools: (next: string[]) => { active = next; }, exec() {},
    };
    grunt(pi);
    for (const handler of handlers.get("session_start") ?? []) await handler({}, {});
    assert.deepEqual(tools.get("grunt").parameters.properties.thinking.enum, ["low", "xhigh"]);
    const rejected = await tools.get("grunt").execute("id", { task: "No run", thinking: "high" }, undefined, undefined, {});
    assert.equal(rejected.details.status, "invalid");
    assert.match(rejected.content[0].text, /not enabled/i);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("isolated mode throws outside Git while direct mode runs there", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "grunt-no-git-"));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  try {
    const tools = new Map<string, any>();
    const pi: any = {
      events: new Bus(), on() {}, registerCommand() {}, getActiveTools: () => [], setActiveTools() {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
      exec: async (command: string, args: string[]) => {
        try {
          const result = await execFileAsync(command, args, { encoding: "utf8" });
          return { code: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error: any) {
          return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
        }
      },
    };
    await saveConfig({ version: 1, disabled: false, mode: "isolated" });
    let workerCwd = "";
    grunt(pi, async (_args, options) => {
      workerCwd = options.cwd;
      return {
        text: "Status: completed", cwd: options.cwd, model: "worker", stopReason: "stop", stderr: "", durationMs: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, turns: 1,
        truncated: false, exitCode: 0, activity: [],
      };
    });
    const model = { provider: "test", id: "worker" };
    const ctx: any = {
      cwd: root, hasUI: false, model,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }), find: () => model },
    };
    await assert.rejects(
      tools.get("grunt").execute("id", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx),
      /Grunt isolation unavailable:.*git repository/i,
    );
    assert.equal(workerCwd, "");

    await saveConfig({ version: 1, disabled: false, mode: "dynamic" });
    const direct = await tools.get("grunt").execute("direct", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx);
    assert.equal(workerCwd, root);
    assert.equal(direct.details.status, "completed");
    assert.equal(direct.details.isolated, false);
    assert.equal(direct.details.mode, "direct");
    assert.equal(direct.details.configuredMode, "dynamic");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
