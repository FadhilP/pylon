import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import guard from "../extensions/pi-guard.ts";

function harness() {
  const handlers = new Map<string, Function[]>();
  const decisions: any[] = [];
  const pi: any = {
    events: { emit(name: string, value: any) { if (name === "pi-guard:decision") decisions.push(value); } },
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
  };
  guard(pi);
  return { tool: handlers.get("tool_call")![0], user: handlers.get("user_bash")![0], decisions };
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
    cwd, hasUI: true,
    ui: {
      async select(title: string, options: string[]) { prompts.push({ title, options }); return selections.shift(); },
      setStatus() {},
    },
  };
}

async function approvalFiles(agent: string): Promise<string[]> {
  const root = join(agent, "pi-guard", "approvals");
  const projects = await readdir(root);
  return Promise.all(projects.map(async project => {
    const files = await readdir(join(root, project));
    return files.map(file => join(root, project, file));
  })).then(items => items.flat());
}

test("approval choices have exact labels, allow once is fresh, and session approval is scoped", { concurrency: false }, async () => {
  const { root, generated, outside, other, agent } = await paths();
  process.env.PI_CODING_AGENT_DIR = agent;
  const guard1 = harness();
  const prompts: any[] = [];
  const ctx = context(root, ["Allow once", "Deny"], prompts);
  assert.equal(await guard1.tool(event("write", outside), ctx), undefined);
  assert.equal((await guard1.tool(event("write", outside), ctx)).block, true);
  assert.deepEqual(prompts[0].options, ["Allow once", "Always allow this session", "Always allow on this project", "Deny"]);
  assert.match(prompts[0].title, /Resolved target:/);
  assert.match(prompts[0].title, /Session\/project approval remembers directory:/);
  assert.ok(prompts[0].title.includes(generated));

  const session = harness();
  const sessionCtx = context(root, ["Always allow this session"]);
  assert.equal(await session.tool(event("write", outside), sessionCtx), undefined);
  assert.equal(await session.tool(event("edit", outside), sessionCtx), undefined, "write/edit share a directory key");
  assert.equal(await session.tool(event("write", `${outside}.other`), sessionCtx), undefined, "sibling target shares directory approval");
  assert.equal(await session.tool(event("write", join(generated, "nested", "file.txt")), sessionCtx), undefined, "nested target shares directory approval");
  assert.equal((await session.tool(event("write", other), context(root, ["Deny"]))).block, true, "adjacent directory does not share");

  const env = harness();
  assert.equal(await env.tool(event("write", ".env.local"), context(root, ["Always allow this session"])), undefined);
  assert.equal((await env.tool(event("write", ".env.other"), context(root, ["Deny"]))).block, true, ".env approval stays exact");
  assert.equal(session.decisions.length, 5, "one publication per final outcome");
});

test("project approval survives extension replacement but is cwd and exact-command scoped", { concurrency: false }, async () => {
  const { root, generated, outside, other, agent } = await paths();
  process.env.PI_CODING_AGENT_DIR = agent;
  const first = harness();
  assert.equal(await first.tool(event("write", outside), context(root, ["Always allow on this project"])), undefined);

  const replacement = harness();
  assert.equal((await replacement.tool(event("edit", outside), {
    cwd: root, hasUI: false, ui: { async select() { throw new Error("must not run"); }, setStatus() {} },
  })).block, true, "remembered project approval still requires UI");
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
  assert.equal(await commandGuard.tool({ type: "tool_call", toolName: "bash", input: { command } }, context(root, ["Always allow this session"])), undefined);
  assert.equal(await commandGuard.user({ command }, context(root, [])), undefined, "agent and user bash share exact commands");
  assert.notEqual(await commandGuard.user({ command: "rm -rf different" }, context(root, ["Deny"])), undefined);
});

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
    cwd: root, hasUI: true, ui: { async select() { throw new Error("UI failed"); }, setStatus() {} },
  });
  assert.equal(failed.block, true);
  const unavailable = await cancelled.tool(event("write", outside), {
    cwd: root, hasUI: false, ui: { async select() { throw new Error("must not run"); }, setStatus() {} },
  });
  assert.equal(unavailable.block, true);
});
