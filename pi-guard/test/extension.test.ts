import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import guard from "../extensions/pi-guard.ts";

function harness() {
  const handlers = new Map<string, Function[]>();
  const pi: any = {
    events: { emit() {} },
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand() {},
  };
  guard(pi);
  return handlers.get("tool_call")![0];
}

async function paths() {
  const parent = await mkdtemp(join(tmpdir(), "pi-guard-extension-"));
  const root = join(parent, "repo");
  await mkdir(root);
  return { root, outside: join(parent, "outside.txt") };
}

function event(toolName: "write" | "edit", path: string) {
  return { type: "tool_call", toolName, toolCallId: "call", input: { path } };
}

test("outside writes require fresh consent and show resolved target", async () => {
  const handle = harness();
  const { root, outside } = await paths();
  const prompts: string[] = [];
  const ctx = {
    cwd: root,
    hasUI: true,
    ui: {
      async confirm(_title: string, message: string) { prompts.push(message); return true; },
      setStatus() {},
    },
  };

  assert.equal(await handle(event("write", outside), ctx), undefined);
  assert.equal(await handle(event("edit", outside), ctx), undefined);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /write target is outside workspace/);
  assert.match(prompts[0], /Resolved target:/);
});

test("outside writes fail closed without successful confirmation", async () => {
  const handle = harness();
  const { root, outside } = await paths();
  const declined = await handle(event("write", outside), {
    cwd: root, hasUI: true,
    ui: { async confirm() { return false; }, setStatus() {} },
  });
  assert.equal(declined.block, true);

  const unavailable = await handle(event("edit", outside), {
    cwd: root, hasUI: false,
    ui: { async confirm() { throw new Error("must not run"); }, setStatus() {} },
  });
  assert.equal(unavailable.block, true);

  const failed = await handle(event("write", outside), {
    cwd: root, hasUI: true,
    ui: { async confirm() { throw new Error("UI failed"); }, setStatus() {} },
  });
  assert.equal(failed.block, true);
});
