import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { availableParallelism, tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import advisor from "../packages/pi-advisor/extensions/pi-advisor.ts";
import pylon from "../packages/pylon-core/extensions/pylon-core.ts";
import continuity from "../packages/pi-continuity/extensions/pi-continuity.ts";
import papercut from "../packages/pi-papercut/extensions/pi-papercut.ts";
import focus from "../packages/pi-focus/extensions/pi-focus.ts";
import guard from "../packages/pi-guard/extensions/pi-guard.ts";
import grunt from "../packages/pi-grunt/extensions/pi-grunt.ts";
import heartbeat from "../packages/pi-heartbeat/extensions/pi-heartbeat.ts";
import helios from "../packages/pi-helios/extensions/pi-helios.ts";
import stateql from "../packages/pi-stateql/extensions/pi-stateql.ts";
import discover from "../packages/pi-discover/extensions/pi-discover.ts";
import scout from "../packages/pi-scout/extensions/pi-scout.ts";
import spawn from "../packages/pi-spawn/extensions/pi-spawn.ts";
import timeline from "../packages/pi-timeline/extensions/pi-timeline.ts";
import verify from "../packages/pi-verify/extensions/pi-verify.ts";
import { mapLimit } from "../scripts/run-packages-lib.mjs";

test("quiet test reporting preserves assertion, startup, and late-activity failures and exit codes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-test-reporter-"));
  const file = join(root, "fixture.test.mjs");
  const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
  try {
    for (const scenario of ["pass", "assertion", "startup", "late", "todo"]) {
      await writeFile(file, `
        import test from "node:test";
        import assert from "node:assert/strict";
        console.log("debug output");
        test("passing test", () => {});
        ${scenario === "assertion" ? 'test("failed assertion", () => assert.equal("actual-value", "expected-value"));' : ""}
        ${scenario === "startup" ? 'throw new Error("startup failure details");' : ""}
        ${scenario === "late" ? 'test("late failure", () => { setTimeout(() => { throw new Error("late failure details"); }, 10); });' : ""}
        ${scenario === "todo" ? 'test("expected failure", { todo: true }, () => { throw new Error("todo failure"); });' : ""}
      `);
      for (const verbose of [false, true]) {
        const run = promisify(execFile)(process.execPath, [runner, file, ...(verbose ? ["--verbose"] : [])]);
        if (scenario === "pass" || scenario === "todo") {
          const { stdout } = await run;
          if (verbose) assert.ok(stdout.includes("debug output"));
          else assert.equal(stdout, "");
        } else {
          await assert.rejects(run, (error: any) => {
            assert.equal(error.code, 1);
            if (scenario === "assertion") {
              assert.ok(error.stdout.includes("actual-value"));
              assert.ok(error.stdout.includes("expected-value"));
            } else {
              assert.ok(error.stdout.includes(`${scenario} failure details`));
            }
            return true;
          });
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared web suites run serially, finish cleanup, and preserve failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-web-test-runner-"));
  const runner = fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url));
  const events = join(root, "events.jsonl");
  try {
    await copyFile(new URL("../platform/web/test/run.mjs", import.meta.url), join(root, "run.mjs"));
    await writeFile(join(root, "shared.mjs"), "export const state = { runs: 0 };\n");
    for (const scenario of ["pass", "assertion", "startup", "hook", "late", "rejection"]) {
      await writeFile(events, "");
      await writeFile(
        join(root, "a.test.ts"),
        `
        import test, { after } from "node:test";
        import assert from "node:assert/strict";
        import { appendFile } from "node:fs/promises";
        import { state } from "./shared.mjs";
        after(async () => {
          await new Promise(resolve => setTimeout(resolve, 10));
          delete process.env.PYLON_SUITE_ACTIVE;
          await appendFile(${JSON.stringify(events)}, JSON.stringify({ event: "cleanup", pid: process.pid }) + "\\n");
          ${scenario === "hook" ? 'throw new Error("hook failure details");' : ""}
        });
        test("first fixture", async () => {
          process.env.PYLON_SUITE_ACTIVE = "1";
          state.runs++;
          await new Promise(resolve => setTimeout(resolve, 10).unref());
          ${scenario === "assertion" ? 'assert.fail("assertion failure details");' : ""}
          ${scenario === "late" ? 'setTimeout(() => { throw new Error("late failure details"); }, 30);' : ""}
          ${scenario === "rejection" ? 'setTimeout(() => { Promise.reject(new Error("rejection failure details")); }, 30);' : ""}
        });
        ${scenario === "startup" ? 'throw new Error("startup failure details");' : ""}
      `,
      );
      await writeFile(
        join(root, "b.test.ts"),
        `
        import test from "node:test";
        import assert from "node:assert/strict";
        import { appendFile, readFile } from "node:fs/promises";
        import { state } from "./shared.mjs";
        assert.equal(process.env.PYLON_SUITE_ACTIVE, undefined);
        assert.equal(JSON.parse((await readFile(${JSON.stringify(events)}, "utf8")).trim()).event, "cleanup");
        test("second fixture", async () => {
          ${scenario === "pass" ? "assert.equal(state.runs, 1);" : ""}
          await appendFile(${JSON.stringify(events)}, JSON.stringify({ event: "second", pid: process.pid }) + "\\n");
          await new Promise(resolve => setTimeout(resolve, 50));
        });
      `,
      );
      const run = promisify(execFile)(process.execPath, [
        runner,
        "--experimental-transform-types",
        join(root, "run.mjs"),
      ]);
      if (scenario === "pass") await run;
      else
        await assert.rejects(run, (error: any) => {
          assert.equal(error.code, 1);
          assert.ok(error.stdout.includes(`${scenario} failure details`), error.stdout);
          return true;
        });
      const recorded = (await readFile(events, "utf8"))
        .trim()
        .split("\n")
        .map(line => JSON.parse(line));
      assert.deepEqual(
        recorded.map(entry => entry.event),
        ["cleanup", "second"],
      );
      assert.equal(new Set(recorded.map(entry => entry.pid)).size, 1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification forwards verbosity to tests, preserves phase ordering, and stops on failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-verify-runner-"));
  const eventsFile = join(root, "events.jsonl");
  const npmCli = join(root, "npm.mjs");
  try {
    for (const path of ["scripts", "packages/a", "platform/web"]) await mkdir(join(root, path), { recursive: true });
    for (const file of ["verify.mjs", "run-packages.mjs", "run-packages-lib.mjs"])
      await copyFile(new URL(`../scripts/${file}`, import.meta.url), join(root, "scripts", file));
    await writeFile(npmCli, `
      import { appendFileSync } from "node:fs";
      const script = process.argv[3], args = process.argv.slice(4);
      appendFileSync(process.env.RUNNER_EVENTS, JSON.stringify({ script, args }) + "\\n");
      if (script === process.env.RUNNER_FAIL) {
        console.error("original failure details");
        process.exit(7);
      }
    `);
    for (const scenario of [
      { mode: "root", verbose: false, fail: "" },
      { mode: "root", verbose: true, fail: "" },
      { mode: "fast", verbose: true, fail: "" },
      { mode: "web", verbose: true, fail: "" },
      { mode: "root", verbose: true, fail: "test:update" },
      { mode: "web", verbose: true, fail: "test" },
    ]) {
      await writeFile(eventsFile, "");
      const run = promisify(execFile)(process.execPath, [join(root, "scripts", "verify.mjs"),
        ...(scenario.mode === "root" ? [] : [`--${scenario.mode}`]), ...(scenario.verbose ? ["--verbose"] : [])],
        { env: { ...process.env, npm_execpath: npmCli, RUNNER_EVENTS: eventsFile, RUNNER_FAIL: scenario.fail } });
      if (scenario.fail) await assert.rejects(run, (error: any) => {
        assert.equal(error.code, 7);
        assert.ok((error.stdout + error.stderr).includes("original failure details"));
        return true;
      });
      else await run;
      const events = (await readFile(eventsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const scripts = events.map(event => event.script);
      if (scenario.mode === "web") assert.deepEqual(scripts, scenario.fail ? ["test"] : ["test", "build"]);
      else if (scenario.fail) assert.deepEqual(scripts, ["test:bundle", "test:update"]);
      else {
        assert.deepEqual(scripts.slice(0, 5), ["test:bundle", "test:update", "test:storage", "test:install", "check"]);
        if (scenario.mode === "fast") assert.deepEqual(scripts.slice(5), ["build"]);
        else assert.deepEqual(new Set(scripts.slice(5)), new Set(["test", "build"]));
      }
      for (const event of events) {
        if (event.script === "build") assert.deepEqual(event.args, scenario.mode === "fast" ? ["--workspace", "@pylon/web"] : []);
        else assert.deepEqual(event.args, scenario.verbose && event.script !== "check" ? ["--", "--verbose"] : []);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package runner bounds concurrency and preserves result order", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapLimit([30, 5, 20, 1], 2, async delay => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, delay));
    active--;
    return delay;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results, [30, 5, 20, 1]);
});

test("package verification shares its bounded pool with web and preserves phase failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-package-runner-"));
  try {
    const names = ["a", "b", "c", "d"];
    await Promise.all(
      ["scripts", "platform/web", ...names.map(name => `packages/${name}`)].map(path =>
        mkdir(join(root, path), { recursive: true }),
      ),
    );
    for (const file of ["run-packages.mjs", "run-packages-lib.mjs"])
      await copyFile(new URL(`../scripts/${file}`, import.meta.url), join(root, "scripts", file));
    const npmCli = join(root, "npm.mjs");
    const eventsFile = join(root, "events.jsonl");
    await writeFile(
      npmCli,
      `
      import { appendFileSync } from "node:fs";
      import { basename } from "node:path";
      const name = basename(process.cwd()), script = process.argv[3];
      const emit = kind => appendFileSync(process.env.RUNNER_EVENTS, JSON.stringify({ kind, name, script, args: process.argv.slice(4) }) + "\\n");
      emit("start");
      setTimeout(() => {
        emit("finish");
        console.log("job output:" + name + ":" + script);
        if (name + ":" + script === process.env.RUNNER_FAIL) console.error("job failure:" + name + ":" + script);
        process.exit(name + ":" + script === process.env.RUNNER_FAIL ? 7 : 0);
      }, 20);
    `,
    );
    for (const scenario of [
      { web: true, fail: "", verbose: false },
      { web: true, fail: "a:check", verbose: false },
      { web: true, fail: "web:test", verbose: false },
      { web: true, fail: "web:build", verbose: false },
      { web: false, fail: "", verbose: false },
      { web: false, fail: "", verbose: true },
    ]) {
      await writeFile(eventsFile, "");
      const run = promisify(execFile)(
        process.execPath,
        [join(root, "scripts", "run-packages.mjs"), "verify", ...(scenario.web ? ["--web"] : []), ...(scenario.verbose ? ["--verbose"] : [])],
        { env: { ...process.env, npm_execpath: npmCli, RUNNER_EVENTS: eventsFile, RUNNER_FAIL: scenario.fail } },
      );
      if (scenario.fail) await assert.rejects(run, (error: any) => {
        assert.equal(error.code, 7);
        assert.ok(error.stdout.includes(`job failure:${scenario.fail}`));
        assert.ok(!error.stdout.includes("job output:b:"), "successful job logs must not bury a failed job");
        return true;
      });
      else {
        const { stdout } = await run;
        if (scenario.verbose) assert.ok(stdout.includes("job output:b:"));
        else assert.equal(stdout, "");
      }
      const events = (await readFile(eventsFile, "utf8"))
        .trim()
        .split("\n")
        .map(line => JSON.parse(line));
      const active = new Set<string>();
      const checked = new Set<string>();
      const started: string[] = [];
      for (const event of events) {
        const key = `${event.name}:${event.script}`;
        if (event.kind === "start") {
          assert.deepEqual(event.args, scenario.verbose && event.script === "test" ? ["--", "--verbose"] : []);
          assert.ok(!active.has(key));
          active.add(key);
          started.push(key);
          assert.ok(active.size <= Math.min(4, availableParallelism()));
          if (event.script !== "check") assert.equal(checked.size, names.length);
        } else {
          assert.ok(active.delete(key));
          if (event.script === "check") checked.add(event.name);
        }
      }
      assert.equal(active.size, 0);
      assert.equal(new Set(started).size, started.length, "each job executes once");
      const tests = started.filter(key => !key.endsWith(":check"));
      if (scenario.fail === "a:check") assert.deepEqual(tests, []);
      else {
        assert.deepEqual(
          new Set(tests),
          new Set([...(scenario.web ? ["web:test", "web:build"] : []), ...names.map(name => `${name}:test`)]),
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

class Bus {
  handlers = new Map<string, Set<(value: unknown) => void>>();
  on(channel: string, handler: (value: unknown) => void) {
    const handlers = this.handlers.get(channel) ?? new Set();
    handlers.add(handler);
    this.handlers.set(channel, handlers);
    return () => handlers.delete(handler);
  }
  emit(channel: string, value: unknown) {
    for (const handler of this.handlers.get(channel) ?? []) handler(value);
  }
  count() {
    return [...this.handlers.values()].reduce((sum, handlers) => sum + handlers.size, 0);
  }
}

test("root bundle discovery integrations run and shut down", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousStateQLHome = process.env.STQL_HOME;
  const root = await mkdtemp(join(tmpdir(), "pylon-bundle-"));
  const cwd = join(root, "repo");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  process.env.STQL_HOME = join(root, "stateql");
  try {
    const events = new Bus();
    const handlers = new Map<string, Function[]>();
    const commands = new Map<string, any>();
    const tools = new Map<string, any>();
    let active: string[] = ["read", "edit", "write", "bash"];
    const pi: any = {
      events,
      on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      registerTool: (tool: any) => {
        tools.set(tool.name, tool);
        active.push(tool.name);
      },
      registerCommand: (name: string, command: any) => commands.set(name, command),
      registerEntryRenderer: () => {},
      getActiveTools: () => [...new Set(active)],
      getAllTools: () => [...tools.values()],
      setActiveTools: (tools: string[]) => {
        active = [...tools];
      },
      getThinkingLevel: () => "low",
      setThinkingLevel: () => {},
      getSessionName: () => undefined,
      setSessionName: () => {},
      setModel: async () => true,
      appendEntry: () => {},
      sendUserMessage: () => {},
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    };
    for (const extension of [
      advisor,
      pylon,
      continuity,
      papercut,
      focus,
      guard,
      grunt,
      heartbeat,
      helios,
      stateql,
      discover,
      scout,
      spawn,
      timeline,
      verify,
    ]) {
      await extension(pi);
    }

    let notification = "";
    const ui = new Proxy(
      {
        confirm: async () => false,
        notify: (text: string) => {
          notification = text;
        },
      },
      { get: (target, property) => (target as any)[property] ?? (() => {}) },
    );
    const ctx: any = {
      cwd,
      hasUI: false,
      mode: "json",
      model: undefined,
      scopedModels: [],
      ui,
      modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false, getAvailable: () => [] },
      sessionManager: {
        getEntries: () => [],
        getBranch: () => [],
        getSessionId: () => "bundle-session",
        getSessionFile: () => join(root, "session.jsonl"),
        getLeafId: () => undefined,
      },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);

    const agentDiscovery = await tools
      .get("search_tools")
      .execute("discover-spawn-agent", { query: "delegate to a private agent", limit: 1 }, undefined, undefined, ctx);
    assert.match(agentDiscovery.content[0].text, /Selected: spawn_agent/);
    assert.ok(active.includes("spawn_agent"));
    assert.ok(!active.includes("spawn_session"));

    const sessionDiscovery = await tools
      .get("search_tools")
      .execute(
        "discover-spawn-session",
        { query: "open an inspectable child session", limit: 1 },
        undefined,
        undefined,
        ctx,
      );
    assert.match(sessionDiscovery.content[0].text, /Selected: spawn_session/);
    assert.ok(!active.includes("spawn_agent"));
    assert.ok(active.includes("spawn_session"));

    const discoveryResult = await tools
      .get("search_tools")
      .execute("discover-browser", { query: "browser navigation" }, undefined, undefined, ctx);
    assert.match(discoveryResult.content[0].text, /Selected: helios_browser/);
    assert.match(discoveryResult.content[0].text, /Callable definitions update next model turn/);
    assert.ok(active.includes("helios_browser"));

    const androidDiscovery = await tools
      .get("search_tools")
      .execute(
        "discover-android",
        { query: "start an Android emulator and navigate an app" },
        undefined,
        undefined,
        ctx,
      );
    assert.match(androidDiscovery.content[0].text, /Selected: helios_android/);
    assert.ok(active.includes("helios_android"));
    await commands.get("pylon").handler("doctor", ctx);
    assert.match(notification, /Package health:/);
    assert.match(notification, /Helios:/);
    assert.match(notification, /Grunt:/);
    assert.match(notification, /Scout:/);
    assert.match(notification, /Web Scout: Helios broker ready/);

    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
    assert.equal(events.count(), 0);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousStateQLHome === undefined) delete process.env.STQL_HOME;
    else process.env.STQL_HOME = previousStateQLHome;
  }
});
