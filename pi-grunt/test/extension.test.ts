import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import grunt from "../extensions/pi-grunt.ts";
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
  await execFileAsync("git", ["-C", cwd, "add", "README.md"]);
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
    const runWorker = async (args: string[], options: { cwd: string }): Promise<WorkerRun> => {
      childArgs = args;
      workerCwd = options.cwd;
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
    grunt(pi, runWorker as any);
    const ctx: any = {
      cwd, hasUI: false, model,
      modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }), find: () => model, hasConfiguredAuth: () => true },
      sessionManager: { buildContextEntries: () => [{ type: "message", message: { role: "user", content: "Add worker" } }] },
      ui: { setStatus() {} },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    const result = await tools.get("grunt").execute("id", { task: "Add trivial worker module", thinking: "medium", suggestedPaths: ["src/**"] }, undefined, undefined, ctx);
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
    assert.match(childArgs.at(-1) ?? "", /Add worker/);
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
});
