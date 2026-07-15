import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
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
    const handlers = new Map<string, Function[]>();
    let active: string[] = [];
    let childArgs: string[] = [];
    const model = { provider: "test", id: "worker" };
    let workerCwd = "";
    let outcome: "completed" | "blocked" = "completed";
    const runningUpdates: any[] = [];
    const runWorker = async (args: string[], options: { cwd: string; onActivity?: Function }): Promise<WorkerRun> => {
      childArgs = args;
      workerCwd = options.cwd;
      await new Promise((resolve) => setTimeout(resolve, 5));
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
      registerCommand: () => {},
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
    await saveConfig({ version: 1, disabled: false });
    grunt(pi, runWorker as any);
    const ctx: any = {
      cwd, hasUI: false, model,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }), find: () => model, hasConfiguredAuth: () => true },
      sessionManager: { buildContextEntries: () => [{ type: "message", message: { role: "user", content: "Add worker" } }] },
      ui: { setStatus() {} },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    const result = await tools.get("grunt").execute("id", { task: "Add trivial worker module", thinking: "medium", suggestedPaths: ["src/**"] }, undefined, (update: any) => runningUpdates.push(update), ctx);
    const activityUpdate = runningUpdates.find((update) => update.details?.activity?.length);
    assert.equal(activityUpdate.details.state, "running");
    assert.ok(activityUpdate.details.durationMs > 0);
    assert.equal(result.details.status, "completed");
    assert.equal(result.details.applied, true);
    assert.equal(result.details.isolated, true);
    assert.equal(result.details.isolationVerified, true);
    assert.equal(result.details.workerCwd, workerCwd);
    assert.notEqual(workerCwd, cwd);
    assert.deepEqual(result.details.changedPaths, ["src/worker.ts"]);
    assert.deepEqual(result.details.outsideSuggestedPaths, []);
    assert.equal(childArgs[childArgs.indexOf("--thinking") + 1], "medium");
    assert.ok(childArgs.includes("--no-extensions"));
    assert.doesNotMatch(childArgs.at(-1) ?? "", /Add worker/);
    assert.match(childArgs.at(-1) ?? "", /Unavailable ignored dependency directories: node_modules/);
    assert.deepEqual(result.details.missingDependencies, ["node_modules"]);
    assert.equal((await import("node:fs/promises").then((fs) => fs.readFile(join(cwd, "src", "worker.ts"), "utf8"))).replace(/\r\n/g, "\n"), "export const completed = true;\n");

    outcome = "blocked";
    const blocked = await tools.get("grunt").execute("blocked", { task: "Attempt uncertain work", thinking: "high", suggestedPaths: ["src/**"] }, undefined, undefined, ctx);
    assert.equal(blocked.details.status, "partial");
    assert.equal(blocked.details.applied, false);
    assert.ok(blocked.details.artifactPath);
    await assert.rejects(access(join(cwd, "src", "blocked.ts")));
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("Grunt guidance permits whole non-difficult changes and retains Main ownership", () => {
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
  assert.match(tool.description, /unlimited per original user prompt/i);
  assert.match(guidance, /small is under 50 LOC/i);
  assert.match(guidance, /medium is 50–400 LOC inclusive/i);
  assert.match(guidance, /large is over 400 LOC/i);
  assert.match(guidance, /Reasoning complexity.*override LOC/i);
  assert.match(guidance, /inspect its applied changes, run focused verification, then invoke the next Grunt/i);
  assert.match(guidance, /entire change when it is not difficult/i);
  assert.match(guidance, /Main model must own difficult architecture/i);
  assert.match(guidance, /advisor at least once when available/i);
  assert.match(guidance, /Provide grunt suggestedPaths whenever the main model has reliable implementation anchors/i);
  assert.match(guidance, /omit suggestedPaths rather than guessing stale or uncertain paths/i);
  assert.match(guidance, /main model owns recovery/i);
  assert.match(guidance, /fix small\/local defects.*directly/i);
  assert.match(guidance, /Do not call grunt merely to verify or repair the previous worker/i);
  assert.match(guidance, /remaining work is still medium or large/i);

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
});
