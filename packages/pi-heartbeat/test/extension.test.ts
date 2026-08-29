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
  const events: Array<{ name: string; value: any }> = [];
  let sessionId = `heartbeat-test-${process.pid}-${Date.now()}`;
  extension({
    on: (name: string, handler: (...args: any[]) => any) =>
      handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {},
    events: {
      emit: (name: string, value: any) => events.push({ name, value }),
    },
  } as any);
  const ctx = {
    cwd: process.cwd(),
    hasUI: false,
    mode: "print",
    sessionManager: {
      getSessionId: () => sessionId,
    },
  };
  return {
    handlers,
    tools,
    ctx,
    events,
    setSessionId: (value: string) => {
      sessionId = value;
    },
  };
}

test("session_start shuts down the previous manager before replacing it", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "heartbeat-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { handlers, tools, ctx, events, setSessionId } = harness();
  const first = "first";
  try {
    setSessionId(first);
    await handlers.get("session_start")!({}, ctx);
    assert.deepEqual(
      events.find((event) => event.name === "pylon:tool-policy")?.value,
      {
        version: 1,
        kind: "register",
        owner: "pi-heartbeat",
        managedTools: [
          "heartbeat_start",
          "heartbeat_status",
          "heartbeat_cancel",
        ],
        enabledTools: ["heartbeat_start"],
        toolUsage: {
          heartbeat_start:
            "start a long shell command while independent work remains",
        },
      },
    );
    const started = await tools
      .get("heartbeat_start")
      .execute(
        "start",
        {
          command: `node -e "setTimeout(()=>{},10000)"`,
          otherWork: "replace session",
        },
        undefined,
        undefined,
        ctx,
      );
    setSessionId("second");
    await handlers.get("session_start")!({}, ctx);
    await assert.rejects(access(join(agentDir, "pi-heartbeat", "tmp", first)));
    const firstJobEvents = events.filter(
      (event) =>
        event.name === "pi-heartbeat:job" &&
        event.value.id === started.details.id,
    );
    assert.ok(firstJobEvents.length >= 2);
    assert.ok(
      firstJobEvents.every((event) => event.value.sessionId === first),
      "terminal events retain the creating session",
    );
  } finally {
    await handlers.get("session_shutdown")!();
    assert.deepEqual(events.at(-1), {
      name: "pylon:tool-policy",
      value: { version: 1, kind: "unregister", owner: "pi-heartbeat" },
    });
    await rm(agentDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("early targeted and list checks are rejected without conflicting context", async () => {
  const { handlers, tools, ctx, events } = harness();
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
    assert.deepEqual(
      events.filter((event) => event.name === "pylon:tool-policy").at(-1)?.value
        .enabledTools,
      ["heartbeat_start", "heartbeat_status", "heartbeat_cancel"],
    );
    const injected = handlers.get("context")!({ messages: [] });
    assert.match(
      injected.messages.at(-1).content,
      /Do not call heartbeat_status yet/,
    );

    const targeted = await tools
      .get("heartbeat_status")
      .execute("status", { id });
    assert.match(targeted.content[0].text, /Check too soon/);

    const listed = await tools.get("heartbeat_status").execute("status", {});
    assert.match(listed.content[0].text, /Check too soon/);
    assert.ok(listed.details.retryAfterMs > 0);
  } finally {
    await handlers.get("session_shutdown")!();
  }
});

test("completed job remains in context until its output is fetched", async () => {
  const { handlers, tools, ctx, events } = harness();
  await handlers.get("session_start")!({}, ctx);
  try {
    const started = await tools
      .get("heartbeat_start")
      .execute(
        "start",
        {
          command: `node -e "console.log('done')"`,
          otherWork: "inspect results",
        },
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
    assert.deepEqual(
      events.filter((event) => event.name === "pylon:tool-policy").at(-1)?.value
        .enabledTools,
      ["heartbeat_start", "heartbeat_status"],
    );
    const lifecycle = events.filter(
      (event) => event.name === "pi-heartbeat:job",
    );
    assert.ok(lifecycle.length >= 2);
    assert.ok(
      lifecycle.every(
        (event) => event.value.sessionId === ctx.sessionManager.getSessionId(),
      ),
    );
    assert.match(
      handlers.get("context")!({ messages: [] }).messages.at(-1).content,
      /completed/,
    );

    const status = await tools
      .get("heartbeat_status")
      .execute("status", { id: started.details.id });
    assert.match(status.content[0].text, /stdout tail:\ndone/);
    assert.deepEqual(
      events.filter((event) => event.name === "pylon:tool-policy").at(-1)?.value
        .enabledTools,
      ["heartbeat_start"],
    );
    assert.equal(handlers.get("context")!({ messages: [] }), undefined);
  } finally {
    await handlers.get("session_shutdown")!();
  }
});
