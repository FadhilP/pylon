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
    handlers.add(handler);
    this.handlers.set(name, handlers);
    return () => handlers.delete(handler);
  }
  emit(name: string, value: any) {
    for (const handler of this.handlers.get(name) ?? []) handler(value);
  }
}

test("Grunt runs synchronously with per-call thinking and derives changed paths", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousSettingsEnv = {
    timeout: process.env.PI_GRUNT_TIMEOUT_MS,
    turns: process.env.PI_GRUNT_MAX_TURNS,
    cost: process.env.PI_GRUNT_MAX_COST_USD,
    context: process.env.PI_GRUNT_PARENT_CONTEXT_CHARS,
  };
  const root = await mkdtemp(join(tmpdir(), "grunt-extension-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  await execFileAsync("git", ["init", cwd]);
  await writeFile(join(cwd, "README.md"), "base\n");
  await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
  await mkdir(join(cwd, "node_modules"));
  await writeFile(join(cwd, "node_modules", "installed.txt"), "available only in parent\n");
  await execFileAsync("git", ["-C", cwd, "add", "README.md", ".gitignore"]);
  await execFileAsync("git", [
    "-C",
    cwd,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@local",
    "commit",
    "-m",
    "base",
  ]);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.PI_GRUNT_TIMEOUT_MS = "1000";
  process.env.PI_GRUNT_MAX_TURNS = "2";
  process.env.PI_GRUNT_MAX_COST_USD = "9";
  process.env.PI_GRUNT_PARENT_CONTEXT_CHARS = "0";
  try {
    const events = new Bus();
    let policy: any;
    events.on("pylon:tool-policy", value => {
      policy = value;
    });
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
    const timeoutBudgets: number[] = [];
    const maxCostBudgets: number[] = [];
    const maxTurnBudgets: number[] = [];
    let outcome: "completed" | "blocked" = "completed";
    const runningUpdates: any[] = [];
    const runWorker = async (
      args: string[],
      options: {
        cwd: string;
        timeoutMs: number;
        maxTurns: number;
        maxCostUsd: number;
        onActivity?: Function;
        onUsage?: Function;
      },
    ): Promise<WorkerRun> => {
      childArgs = args;
      workerCwd = options.cwd;
      workerCwds.push(options.cwd);
      workerAttempts++;
      maxTurnBudgets.push(options.maxTurns);
      timeoutBudgets.push(options.timeoutMs);
      maxCostBudgets.push(options.maxCostUsd);
      if (workerAttempts === 1) {
        options.onUsage?.({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
        return {
          text: "",
          cwd: options.cwd,
          model: "worker",
          stopReason: "error",
          error: "503 model at capacity",
          failure: "child_error",
          stderr: "",
          durationMs: 2,
          usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          turns: 1,
          truncated: false,
          exitCode: 1,
          activity: [],
        };
      }
      await new Promise(resolve => setTimeout(resolve, 5));
      options.onUsage?.({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 });
      options.onActivity?.({ kind: "call", tool: "read", text: "README.md" }, [
        { kind: "call", tool: "read", text: "README.md" },
      ]);
      await mkdir(join(options.cwd, "src"), { recursive: true });
      const file = outcome === "completed" ? "worker.ts" : "blocked.ts";
      await writeFile(join(options.cwd, "src", file), `export const ${outcome} = true;\n`);
      return {
        text: `Status: ${outcome}\nChanged files: src/${file}`,
        cwd: options.cwd,
        model: "worker",
        stopReason: "stop",
        stderr: "",
        durationMs: 2,
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 },
        turns: 1,
        truncated: false,
        exitCode: 0,
        activity: [],
      };
    };
    const pi: any = {
      events,
      on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerTool: (tool: any) => {
        tools.set(tool.name, tool);
        active.push(tool.name);
      },
      registerCommand: (name: string, command: any) => commands.set(name, command),
      getActiveTools: () => active,
      setActiveTools: (value: string[]) => {
        active = value;
      },
      exec: async (command: string, args: string[]) => {
        try {
          const result = await execFileAsync(command, args, { encoding: "utf8" });
          return { code: 0, stdout: result.stdout, stderr: result.stderr };
        } catch (error: any) {
          return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
        }
      },
    };
    await saveConfig({
      version: 1,
      disabled: false,
      mode: "dynamic",
      timeoutMs: 120_000,
      maxTurns: 12,
      maxCostUsd: 3,
      parentContextChars: 100,
    });
    grunt(pi, runWorker as any, async () => true);
    const ctx: any = {
      cwd,
      hasUI: false,
      model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
        find: () => model,
        hasConfiguredAuth: () => true,
      },
      sessionManager: {
        buildContextEntries: () => [{ type: "message", message: { role: "user", content: "Add worker" } }],
      },
      ui: { setStatus() {}, notify: (text: string, level: string) => notifications.push({ text, level }) },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    assert.deepEqual(policy.deferredTools, ["grunt"]);
    assert.match(policy.toolUsage.grunt, /delegate/);
    assert.ok(active.includes("grunt"), "standalone fallback keeps Grunt active without coordination");
    const result = await tools
      .get("grunt")
      .execute(
        "id",
        {
          task: "Add trivial worker module",
          thinking: "medium",
          suggestedPaths: ["src/**"],
          targetedContext: "Copy the existing exported-constant convention.",
          checkCommands: ["npm test -- worker"],
        },
        undefined,
        (update: any) => runningUpdates.push(update),
        ctx,
      );
    assert.deepEqual(maxTurnBudgets, [12, 11]);
    assert.deepEqual(maxCostBudgets, [3, 3]);
    const activityUpdate = runningUpdates.find(update => update.details?.activity?.length);
    assert.ok(timeoutBudgets.every(timeoutMs => timeoutMs > 1_000 && timeoutMs <= 120_000));
    assert.ok(activityUpdate.details.durationMs > 0);
    assert.deepEqual(
      [...new Set(runningUpdates.flatMap(update => (update.details?.usage ? [update.details.usage.input] : [])))],
      [1, 2],
    );
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
    const extensionIndexes = childArgs.flatMap((arg, index) => (arg === "--extension" ? [index] : []));
    const lineEditExtension = childArgs[extensionIndexes[0]! + 1] ?? "";
    const sieveExtension = childArgs[extensionIndexes[1]! + 1] ?? "";
    assert.match(lineEditExtension.replace(/\\/g, "/"), /\/pylon-core\/extensions\/line-edit\.ts$/);
    assert.match(sieveExtension.replace(/\\/g, "/"), /\/pi-sieve\/extensions\/pi-sieve\.ts$/);
    await access(lineEditExtension);
    await access(sieveExtension);
    assert.equal(childArgs[childArgs.indexOf("--tools") + 1], "read,grep,find,ls,edit,write,bash,sieve_recall");
    assert.ok(childArgs.includes("--system-prompt"));
    assert.ok(!childArgs.includes("--append-system-prompt"));
    assert.match(childArgs.at(-1) ?? "", /Targeted context.*exported-constant convention/s);
    assert.match(childArgs.at(-1) ?? "", /Focused checks:\n- npm test -- worker/);
    assert.match(childArgs.at(-1) ?? "", /Bounded redacted parent context/);
    assert.match(childArgs.at(-1) ?? "", /Unavailable ignored dependency directories: node_modules/);
    assert.equal(result.details.missingDependencies, undefined);
    assert.deepEqual(result.details.metrics, {
      workerStatus: "completed",
      integrationStatus: "completed",
      workerCostUsd: 0,
      turns: 2,
      inputTokens: 2,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      changedFileCount: 1,
    });
    assert.equal(
      (await import("node:fs/promises").then(fs => fs.readFile(join(cwd, "src", "worker.ts"), "utf8"))).replace(
        /\r\n/g,
        "\n",
      ),
      "export const completed = true;\n",
    );

    outcome = "blocked";
    const blocked = await tools
      .get("grunt")
      .execute(
        "blocked",
        { task: "Attempt uncertain work", thinking: "high", suggestedPaths: ["src/**"] },
        undefined,
        undefined,
        ctx,
      );
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
    const direct = await tools
      .get("grunt")
      .execute("direct", { task: "Edit current working directory", thinking: "medium" }, undefined, undefined, ctx);
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
    if (previousSettingsEnv.timeout === undefined) delete process.env.PI_GRUNT_TIMEOUT_MS;
    else process.env.PI_GRUNT_TIMEOUT_MS = previousSettingsEnv.timeout;
    if (previousSettingsEnv.turns === undefined) delete process.env.PI_GRUNT_MAX_TURNS;
    else process.env.PI_GRUNT_MAX_TURNS = previousSettingsEnv.turns;
    if (previousSettingsEnv.cost === undefined) delete process.env.PI_GRUNT_MAX_COST_USD;
    else process.env.PI_GRUNT_MAX_COST_USD = previousSettingsEnv.cost;
    if (previousSettingsEnv.context === undefined) delete process.env.PI_GRUNT_PARENT_CONTEXT_CHARS;
    else process.env.PI_GRUNT_PARENT_CONTEXT_CHARS = previousSettingsEnv.context;
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
      events: new Bus(),
      on() {},
      registerCommand() {},
      getActiveTools: () => [],
      setActiveTools() {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
      exec: async (_command: string, args: string[]) =>
        args.includes("--is-inside-work-tree")
          ? { code: 0, stdout: "true\ndeadbeef\n", stderr: "" }
          : { code: 1, stdout: "", stderr: "worktree setup failed" },
    };
    await saveConfig({ version: 1, disabled: false, mode: "dynamic" });
    grunt(pi, async (_args, options) => ({
      text: "Status: completed",
      cwd: options.cwd,
      model: "worker",
      stopReason: "stop",
      stderr: "",
      durationMs: 1,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
      turns: 1,
      truncated: false,
      exitCode: 0,
      activity: [],
    }));
    const model = { provider: "test", id: "worker" };
    const result = await tools
      .get("grunt")
      .execute("id", { task: "Edit file", thinking: "medium" }, undefined, undefined, {
        cwd: root,
        hasUI: false,
        model,
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
      events: new Bus(),
      on() {},
      registerCommand() {},
      getActiveTools: () => [],
      setActiveTools() {},
      registerTool: (tool: any) => tools.set(tool.name, tool),
      exec() {},
    };
    const secret = `sk-${"x".repeat(40)}`;
    let outcome: "failure" | "transient" | "success" | "throw" = "failure";
    let workerCalls = 0;
    await saveConfig({ version: 1, disabled: false, mode: "direct" });
    grunt(
      pi,
      async (_args, options): Promise<WorkerRun> => {
        workerCalls++;
        if (outcome === "throw") throw { private: "value" };
        return {
          text: outcome === "success" ? "Status: completed" : "",
          cwd: options.cwd,
          model: "worker",
          stopReason: "stop",
          stderr: "",
          durationMs: 1,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
          turns: 1,
          truncated: false,
          exitCode: outcome === "success" ? 0 : 1,
          activity: [],
          ...(outcome === "failure" || outcome === "transient"
            ? {
                error:
                  outcome === "transient"
                    ? "503 model at capacity"
                    : `bad\napi_key=${secret}\u0085\u2028${"z".repeat(600)}`,
                failure: "child_error" as const,
              }
            : {}),
        };
      },
      async () => true,
    );
    const model = { provider: "test", id: "worker" };
    const ctx: any = {
      cwd: root,
      hasUI: false,
      model,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }), find: () => model },
    };

    const failed = await tools
      .get("grunt")
      .execute("failed", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx);
    assert.equal(failed.details.failureCode, "child_error");
    assert.ok(failed.details.failureMessage.length <= 500);
    assert.doesNotMatch(failed.details.failureMessage, new RegExp(secret));
    assert.doesNotMatch(failed.details.failureMessage, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
    assert.match(failed.content[0].text, /\[possible credential redacted\]/);
    assert.doesNotMatch(failed.content[0].text, new RegExp(secret));

    outcome = "transient";
    const callsBeforeTransient = workerCalls;
    const transient = await tools
      .get("grunt")
      .execute("transient", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx);
    assert.equal(workerCalls, callsBeforeTransient + 1);
    assert.equal(transient.details.attempts, 1);

    outcome = "success";
    const succeeded = await tools
      .get("grunt")
      .execute("success", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx);
    assert.equal(Object.hasOwn(succeeded.details, "failureMessage"), false);

    outcome = "throw";
    const thrown = await tools
      .get("grunt")
      .execute("throw", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx);
    assert.equal(thrown.details.failureCode, "worker_error");
    assert.equal(thrown.details.failureMessage, "Grunt execution failed.");
    assert.doesNotMatch(thrown.content[0].text, /private|value/);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("configured thinking levels are revalidated at execution", async () => {
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
      registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand() {},
      getActiveTools: () => active,
      setActiveTools: (next: string[]) => {
        active = next;
      },
      exec() {},
    };
    grunt(pi);
    for (const handler of handlers.get("session_start") ?? []) await handler({}, {});
    const rejected = await tools
      .get("grunt")
      .execute("id", { task: "No run", thinking: "high" }, undefined, undefined, {});
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
      events: new Bus(),
      on() {},
      registerCommand() {},
      getActiveTools: () => [],
      setActiveTools() {},
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
        text: "Status: completed",
        cwd: options.cwd,
        model: "worker",
        stopReason: "stop",
        stderr: "",
        durationMs: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
        turns: 1,
        truncated: false,
        exitCode: 0,
        activity: [],
      };
    });
    const model = { provider: "test", id: "worker" };
    const ctx: any = {
      cwd: root,
      hasUI: false,
      model,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }), find: () => model },
    };
    await assert.rejects(
      tools.get("grunt").execute("id", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx),
      /Grunt isolation unavailable:.*git repository/i,
    );
    assert.equal(workerCwd, "");

    await saveConfig({ version: 1, disabled: false, mode: "dynamic" });
    const direct = await tools
      .get("grunt")
      .execute("direct", { task: "Edit file", thinking: "medium" }, undefined, undefined, ctx);
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
