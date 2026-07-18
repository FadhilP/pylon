import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import extension from "../extensions/pi-heartbeat.ts";

function harness() {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  let sessionId = `heartbeat-test-${process.pid}-${Date.now()}`;
  extension({
    on: (name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {},
    events: { emit: () => {} },
  } as any);
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    mode: "print",
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
  return { handlers, tools, ctx, setSessionId: (value: string) => { sessionId = value; } };
}

test("session_start shuts down the previous manager before replacing it", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "heartbeat-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { handlers, tools, ctx, setSessionId } = harness();
  const first = "first";
  try {
    setSessionId(first);
    await handlers.get("session_start")!({}, ctx);
    await tools.get("heartbeat_start").execute(
      "start",
      { command: `node -e "setTimeout(()=>{},10000)"`, otherWork: "replace session" },
      undefined,
      undefined,
      ctx,
    );
    setSessionId("second");
    await handlers.get("session_start")!({}, ctx);
    await assert.rejects(access(join(agentDir, "pi-heartbeat", "tmp", first)));
  } finally {
    await handlers.get("session_shutdown")!();
    await rm(agentDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("early targeted and list checks are rejected without conflicting context", async () => {
  const { handlers, tools, ctx } = harness();
  await handlers.get("session_start")!({}, ctx);
  try {
    const started = await tools.get("heartbeat_start").execute(
      "start",
      {
        command: `node -e "setTimeout(()=>{},2000)"`,
        otherWork: "run another check",
      },
      undefined,
      undefined,
      ctx,
    );
    const id = started.details.id;
    const injected = handlers.get("context")!({ messages: [] });
    assert.match(injected.messages.at(-1).content, /Do not call heartbeat_status yet/);

    const targeted = await tools
      .get("heartbeat_status")
      .execute("status", { id });
    assert.match(targeted.content[0].text, /Check too soon/);

    const listed = await tools
      .get("heartbeat_status")
      .execute("status", {});
    assert.match(listed.content[0].text, /Check too soon/);
    assert.ok(listed.details.retryAfterMs > 0);
  } finally {
    await handlers.get("session_shutdown")!();
  }
});

test("completed job remains in context until its output is fetched", async () => {
  const { handlers, tools, ctx } = harness();
  await handlers.get("session_start")!({}, ctx);
  try {
    const started = await tools.get("heartbeat_start").execute(
      "start",
      { command: `node -e "console.log('done')"`, otherWork: "inspect results" },
      undefined,
      undefined,
      ctx,
    );
    let injected: any;
    for (let i = 0; i < 100; i++) {
      injected = handlers.get("context")!({ messages: [] });
      if (injected?.messages.at(-1).content.includes("completed")) break;
      await delay(20);
    }
    assert.match(injected.messages.at(-1).content, /completed/);
    assert.match(injected.messages.at(-1).content, /status available now/);
    assert.match(
      handlers.get("context")!({ messages: [] }).messages.at(-1).content,
      /completed/,
    );

    const status = await tools
      .get("heartbeat_status")
      .execute("status", { id: started.details.id });
    assert.match(status.content[0].text, /stdout tail:\ndone/);
    assert.equal(handlers.get("context")!({ messages: [] }), undefined);
  } finally {
    await handlers.get("session_shutdown")!();
  }
});
