import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import guard from "../extensions/pi-guard.ts";
import { GUARD_RISK_CATEGORIES as category } from "../src/policy.ts";

function harness() {
  const handlers = new Map<string, Function[]>();
  const eventHandlers = new Map<string, Set<(value: any) => void>>();
  const decisions: any[] = [];
  const blocking: any[] = [];
  const events = {
    on(name: string, handler: (value: any) => void) {
      const values = eventHandlers.get(name) ?? new Set();
      values.add(handler);
      eventHandlers.set(name, values);
      return () => values.delete(handler);
    },
    emit(name: string, value: any) {
      if (name === "pi-guard:decision") decisions.push(value);
      if (name === "pylon:ui-blocking") blocking.push(value);
      for (const handler of eventHandlers.get(name) ?? []) handler(value);
    },
  };
  const pi: any = {
    events,
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
  };
  guard(pi);
  return {
    tool: handlers.get("tool_call")![0],
    user: handlers.get("user_bash")![0],
    start: handlers.get("session_start")?.[0] ?? (() => {}),
    shutdown: handlers.get("session_shutdown")?.[0] ?? (() => {}),
    decisions,
    blocking,
    events,
  };
}

async function paths() {
  const parent = await mkdtemp(join(tmpdir(), "pi-guard-extension-"));
  const root = join(parent, "repo");
  const generated = join(parent, "generated");
  const other = join(parent, "other", "outside.txt");
  await Promise.all([mkdir(root), mkdir(generated), mkdir(join(parent, "other"))]);
  return { root, generated, outside: join(generated, "outside.txt"), other, agent: join(parent, "agent") };
}

function event(toolName: "write" | "edit", path: string) {
  return { type: "tool_call", toolName, toolCallId: "call", input: { path } };
}

function context(cwd: string, selections: Array<string | undefined>, prompts: any[] = []) {
  return {
    cwd,
    hasUI: true,
    ui: {
      async select(title: string, options: string[], dialogOptions?: { timeout?: number }) {
        prompts.push({ title, options, dialogOptions });
        return selections.shift();
      },
      setStatus() {},
    },
  };
}

async function approvalFiles(agent: string): Promise<string[]> {
  const root = join(agent, "pi-guard", "approvals");
  const projects = await readdir(root);
  return Promise.all(
    projects.map(async project => {
      const files = await readdir(join(root, project));
      return files.map(file => join(root, project, file));
    }),
  ).then(items => items.flat());
}

test(
  "approval choices have exact labels, allow once is fresh, and session approval is scoped",
  { concurrency: false },
  async () => {
    const { root, generated, outside, other, agent } = await paths();
    process.env.PI_CODING_AGENT_DIR = agent;
    const guard1 = harness();
    const prompts: any[] = [];
    const ctx = context(root, ["Allow once", "Deny"], prompts);
    assert.equal(await guard1.tool(event("write", outside), ctx), undefined);
    assert.equal(guard1.blocking.length, 2);
    assert.equal(guard1.blocking[0].active, true);
    assert.equal(guard1.blocking[1].active, false);
    assert.equal(guard1.blocking[0].id, guard1.blocking[1].id);
    assert.equal((await guard1.tool(event("write", outside), ctx)).block, true);
    assert.deepEqual(prompts[0].options, [
      "Allow once",
      "Always allow this session",
      "Always allow on this project",
      "Deny",
    ]);
    assert.match(prompts[0].title, /Resolved target:/);
    assert.match(prompts[0].title, /Session\/project approval remembers directory:/);
    assert.ok(prompts[0].title.includes(generated));

    const session = harness();
    const sessionCtx = context(root, ["Always allow this session"]);
    assert.equal(await session.tool(event("write", outside), sessionCtx), undefined);
    assert.equal(await session.tool(event("edit", outside), sessionCtx), undefined, "write/edit share a directory key");
    assert.equal(
      await session.tool(event("write", `${outside}.other`), sessionCtx),
      undefined,
      "sibling target shares directory approval",
    );
    assert.equal(
      await session.tool(event("write", join(generated, "nested", "file.txt")), sessionCtx),
      undefined,
      "nested target shares directory approval",
    );
    assert.equal(
      (await session.tool(event("write", other), context(root, ["Deny"]))).block,
      true,
      "adjacent directory does not share",
    );

    const env = harness();
    assert.equal(await env.tool(event("write", ".env.local"), context(root, ["Always allow this session"])), undefined);
    assert.equal(
      (await env.tool(event("write", ".env.other"), context(root, ["Deny"]))).block,
      true,
      ".env approval stays exact",
    );
    assert.equal(session.decisions.length, 5, "one publication per final outcome");
  },
);

test(
  "project approval survives extension replacement but is cwd and exact-command scoped",
  { concurrency: false },
  async () => {
    const { root, generated, outside, other, agent } = await paths();
    process.env.PI_CODING_AGENT_DIR = agent;
    const first = harness();
    assert.equal(await first.tool(event("write", outside), context(root, ["Always allow on this project"])), undefined);

    const replacement = harness();
    assert.equal(
      (
        await replacement.tool(event("edit", outside), {
          cwd: root,
          hasUI: false,
          ui: {
            async select() {
              throw new Error("must not run");
            },
            setStatus() {},
          },
        })
      ).block,
      true,
      "remembered project approval still requires UI",
    );
    const noPrompt = context(root, []);
    assert.equal(await replacement.tool(event("edit", outside), noPrompt), undefined);
    assert.equal(await replacement.tool(event("write", `${outside}.different`), noPrompt), undefined);
    assert.equal(await replacement.tool(event("write", join(generated, "nested", "file.txt")), noPrompt), undefined);
    assert.equal((await replacement.tool(event("write", other), context(root, ["Deny"]))).block, true);

    const otherRoot = join(root, "other-project");
    await mkdir(otherRoot);
    assert.equal((await replacement.tool(event("write", outside), context(otherRoot, ["Deny"]))).block, true);

    const command = "rm -rf generated";
    const commandGuard = harness();
    const commandPrompts: any[] = [];
    assert.equal(
      await commandGuard.tool(
        { type: "tool_call", toolName: "bash", input: { command } },
        context(root, ["Always allow this session"], commandPrompts),
      ),
      undefined,
    );
    assert.equal(commandPrompts[0].title, `Pi-guard recursive deletion\n\`${command}\``);
    assert.equal(
      await commandGuard.user({ command }, context(root, [])),
      undefined,
      "agent and user bash share exact commands",
    );
    assert.notEqual(await commandGuard.user({ command: "rm -rf different" }, context(root, ["Deny"])), undefined);
  },
);

test("malformed records, cancellation, UI errors, and no UI fail closed", { concurrency: false }, async () => {
  const { root, outside, agent } = await paths();
  process.env.PI_CODING_AGENT_DIR = agent;
  const initial = harness();
  assert.equal(await initial.tool(event("write", outside), context(root, ["Always allow on this project"])), undefined);
  await writeFile((await approvalFiles(agent))[0], "not json");
  const malformed = harness();
  assert.equal((await malformed.tool(event("write", outside), context(root, [undefined]))).block, true);

  const cancelled = harness();
  assert.equal((await cancelled.tool(event("write", outside), context(root, [undefined]))).block, true);
  assert.equal((await cancelled.tool(event("write", outside), context(root, ["unexpected choice"]))).block, true);
  const failed = await cancelled.tool(event("write", outside), {
    cwd: root,
    hasUI: true,
    ui: {
      async select() {
        throw new Error("UI failed");
      },
      setStatus() {},
    },
  });
  assert.equal(failed.block, true);
  const unavailable = await cancelled.tool(event("write", outside), {
    cwd: root,
    hasUI: false,
    ui: {
      async select() {
        throw new Error("must not run");
      },
      setStatus() {},
    },
  });
  assert.equal(unavailable.block, true);
});

test("bare nul redirection is blocked before Bash can create a file", { concurrency: false }, async () => {
  const { root, agent } = await paths();
  process.env.PI_CODING_AGENT_DIR = agent;
  const app = harness();
  const prompts: any[] = [];
  const ctx = context(root, [], prompts);

  const agentResult = await app.tool(
    { type: "tool_call", toolName: "bash", toolCallId: "nul-agent", input: { command: "tool > nul 2>&1" } },
    ctx,
  );
  assert.equal(agentResult.block, true);
  assert.match(agentResult.reason, /use \/dev\/null/);
  assert.equal(
    await app.tool({ type: "tool_call", toolName: "bash", input: { command: "tool > /dev/null" } }, ctx),
    undefined,
  );

  const heartbeatResult = await app.tool(
    { type: "tool_call", toolName: "heartbeat_start", toolCallId: "nul-heartbeat", input: { command: "tool 2>NUL" } },
    ctx,
  );
  assert.equal(heartbeatResult.block, true);
  assert.equal(app.decisions.at(-1).toolCallId, "nul-heartbeat");

  const userResult = await app.user({ command: "tool > 'nul'" }, ctx);
  assert.equal(userResult.result.cancelled, true);
  assert.equal(userResult.result.exitCode, 126);
  assert.match(userResult.result.output, /use \/dev\/null/);
  assert.deepEqual(prompts, [], "invalid redirections are blocked without an approval prompt");
});

test("Guard uses the effective runtime-policy timeout", { concurrency: false }, async () => {
  const { root, outside, agent } = await paths();
  process.env.PI_CODING_AGENT_DIR = agent;
  const timed = harness();
  timed.events.emit("pylon:runtime-policy", { version: 2, dialogTimeouts: { guard: 90, clarify: 60 } });
  const timedPrompts: any[] = [];
  assert.equal((await timed.tool(event("write", outside), context(root, ["Deny"], timedPrompts))).block, true);
  assert.deepEqual(timedPrompts[0].dialogOptions, { timeout: 90_000 });

  const never = harness();
  never.events.emit("pylon:runtime-policy", { version: 2, dialogTimeouts: { guard: null, clarify: 60 } });
  const neverPrompts: any[] = [];
  assert.equal((await never.tool(event("write", outside), context(root, ["Deny"], neverPrompts))).block, true);
  assert.deepEqual(neverPrompts[0].dialogOptions, { timeout: 0 });
});

test(
  "runtime guardRules applies allow, confirm, block, and fails closed when malformed",
  { concurrency: false },
  async () => {
    const { root, outside, agent } = await paths();
    process.env.PI_CODING_AGENT_DIR = agent;
    const app = harness();
    const prompts: any[] = [];
    app.events.emit("pylon:runtime-policy", {
      version: 2,
      guardRules: {
        [category.COMMAND_RECURSIVE_DELETION]: "allow",
        [category.COMMAND_DESTRUCTIVE_GIT_RESET]: "block",
        [category.COMMAND_FORCED_GIT_PUSH]: "confirm",
        [category.PATH_GIT_INTERNALS]: "allow",
        [category.PATH_ENVIRONMENT_FILE]: "block",
        [category.PATH_WORKSPACE_ESCAPE]: "confirm",
      },
    });
    assert.equal(
      await app.tool(
        { type: "tool_call", toolName: "bash", input: { command: "rm -rf generated" } },
        context(root, [], prompts),
      ),
      undefined,
    );
    assert.equal(
      (
        await app.tool(
          { type: "tool_call", toolName: "bash", input: { command: "git reset --hard HEAD" } },
          context(root, [], prompts),
        )
      ).block,
      true,
    );
    assert.equal(
      await app.tool(
        { type: "tool_call", toolName: "bash", input: { command: "git push -f origin main" } },
        context(root, ["Allow once"], prompts),
      ),
      undefined,
    );
    assert.equal(await app.tool(event("write", ".git/config"), context(root, [], prompts)), undefined);
    assert.equal((await app.tool(event("write", ".env.local"), context(root, [], prompts))).block, true);
    assert.equal(await app.tool(event("write", "../escaped.txt"), context(root, ["Allow once"], prompts)), undefined);
    assert.equal(prompts.length, 2, "only confirm rules prompt");

    app.events.emit("pylon:runtime-policy", {
      version: 2,
      guardRules: { [category.COMMAND_RECURSIVE_DELETION]: "allow", unknown: "block" },
    });
    const malformedPrompts: any[] = [];
    assert.equal(
      (await app.tool(event("write", outside), context(root, ["Allow once"], malformedPrompts))).block,
      true,
    );
    assert.deepEqual(malformedPrompts, [], "invalid rules block rather than using a permissive override");
  },
);

test(
  "Guard applies command policy to Heartbeat and can be disabled by runtime policy",
  { concurrency: false },
  async () => {
    const { root, agent } = await paths();
    process.env.PI_CODING_AGENT_DIR = agent;
    const app = harness();
    const heartbeat = {
      type: "tool_call",
      toolName: "heartbeat_start",
      toolCallId: "heartbeat-risk",
      input: { command: "rm -rf generated", otherWork: "Inspect files" },
    };
    assert.equal((await app.tool(heartbeat, context(root, ["Deny"]))).block, true);
    assert.equal(app.decisions.at(-1).toolCallId, "heartbeat-risk");

    const malformedPrompts: any[] = [];
    assert.equal(
      (
        await app.tool(
          { type: "tool_call", toolName: "heartbeat_start", toolCallId: "heartbeat-malformed", input: { command: 42 } },
          context(root, ["Allow once"], malformedPrompts),
        )
      ).block,
      true,
    );
    assert.deepEqual(malformedPrompts, [], "malformed commands cannot enter the approval path");
    assert.equal(app.decisions.at(-1).reason, "invalid background command");

    app.events.emit("pylon:runtime-policy", {
      version: 2,
      guardEnabled: false,
      dialogTimeouts: { guard: 60, clarify: 60 },
    });
    assert.equal(await app.tool(heartbeat, context(root, [])), undefined);
    assert.equal(await app.user({ command: "rm -rf generated" }, context(root, [])), undefined);
  },
);
