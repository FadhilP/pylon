import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { availableParallelism, tmpdir } from "node:os";
import { promisify } from "node:util";
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
import sieve from "../packages/pi-sieve/extensions/pi-sieve.ts";
import timeline from "../packages/pi-timeline/extensions/pi-timeline.ts";
import verify from "../packages/pi-verify/extensions/pi-verify.ts";
import { mapLimit } from "../scripts/run-packages-lib.mjs";

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
      const emit = kind => appendFileSync(process.env.RUNNER_EVENTS, JSON.stringify({ kind, name, script }) + "\\n");
      emit("start");
      setTimeout(() => {
        emit("finish");
        process.exit(name + ":" + script === process.env.RUNNER_FAIL ? 7 : 0);
      }, 20);
    `,
    );
    for (const scenario of [
      { web: true, fail: "" },
      { web: true, fail: "a:check" },
      { web: true, fail: "web:verify" },
      { web: false, fail: "" },
    ]) {
      await writeFile(eventsFile, "");
      const run = promisify(execFile)(
        process.execPath,
        [join(root, "scripts", "run-packages.mjs"), "verify", ...(scenario.web ? ["--web"] : [])],
        { env: { ...process.env, npm_execpath: npmCli, RUNNER_EVENTS: eventsFile, RUNNER_FAIL: scenario.fail } },
      );
      if (scenario.fail) await assert.rejects(run, { code: 7 });
      else await run;
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
          new Set([...(scenario.web ? ["web:verify"] : []), ...names.map(name => `${name}:test`)]),
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
      sieve,
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
