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
  const commands = new Map<string, any>();
  const events: Array<{ name: string; value: any }> = [];
  let sessionId = `heartbeat-test-${process.pid}-${Date.now()}`;
  const messages: Array<{ message: any; options: any }> = [];
  extension({
    on: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    events: { emit: (name: string, value: any) => events.push({ name, value }) },
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
  } as any);
  const ctx = { cwd: process.cwd(), hasUI: false, mode: "print", sessionManager: { getSessionId: () => sessionId } };
  return {
    handlers,
    tools,
    commands,
    ctx,
    events,
    messages,
    setSessionId: (value: string) => {
      sessionId = value;
    },
  };
}

async function completion(messages: ReturnType<typeof harness>["messages"], id: string) {
  for (let i = 0; i < 250; i++) {
    const delivered = messages.find(item => item.message.details.id === id);
    if (delivered) return delivered;
    await delay(20);
  }
  assert.fail(`No completion message for ${id}`);
}

test("session_start shuts down the previous manager before replacing it", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = await mkdtemp(join(tmpdir(), "heartbeat-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { handlers, tools, ctx, events, messages, setSessionId } = harness();
  const first = "first";
  try {
    setSessionId(first);
    await handlers.get("session_start")!({}, ctx);
    assert.deepEqual(events.find(event => event.name === "pylon:tool-policy")?.value, {
      version: 1,
      kind: "register",
      owner: "pi-heartbeat",
      managedTools: ["heartbeat_start", "heartbeat_status", "heartbeat_cancel"],
      enabledTools: ["heartbeat_start"],
      toolUsage: { heartbeat_start: "start a long shell command while independent work remains" },
    });
    const started = await tools
      .get("heartbeat_start")
      .execute(
        "start",
        { command: `node -e "setTimeout(()=>{},10000)"`, otherWork: "replace session" },
        undefined,
        undefined,
        ctx,
      );
    setSessionId("second");
    await handlers.get("session_start")!({}, ctx);
    await assert.rejects(access(join(agentDir, "pi-heartbeat", "tmp", first)));
    const firstJobEvents = events.filter(
      event => event.name === "pi-heartbeat:job" && event.value.id === started.details.id,
    );
    assert.ok(firstJobEvents.length >= 2);
    assert.ok(
      firstJobEvents.every(event => event.value.sessionId === first),
      "terminal events retain the creating session",
    );
    assert.equal(messages.length, 0, "session replacement must not send old-job completions");
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
    const started = await tools
      .get("heartbeat_start")
      .execute(
        "start",
        { command: `node -e "setTimeout(()=>{},2000)"`, otherWork: "run another check" },
        undefined,
        undefined,
        ctx,
      );
    const id = started.details.id;
    assert.deepEqual(events.filter(event => event.name === "pylon:tool-policy").at(-1)?.value.enabledTools, [
      "heartbeat_start",
      "heartbeat_status",
      "heartbeat_cancel",
    ]);
    const injected = handlers.get("context")!({ messages: [] });
    assert.match(injected.messages.at(-1).content, /Do not call heartbeat_status yet/);

    const targeted = await tools.get("heartbeat_status").execute("status", { id });
    assert.match(targeted.content[0].text, /Check too soon/);

    const listed = await tools.get("heartbeat_status").execute("status", {});
    assert.match(listed.content[0].text, /Check too soon/);
    assert.ok(listed.details.retryAfterMs > 0);
  } finally {
    await handlers.get("session_shutdown")!();
  }
});

test("completion delivers output once without status polling and remains manually inspectable", async () => {
  const { handlers, tools, ctx, events, messages } = harness();
  await handlers.get("session_start")!({}, ctx);
  try {
    const started = await tools
      .get("heartbeat_start")
      .execute(
        "start",
        { command: `node -e "console.log('done')"`, otherWork: "inspect results" },
        undefined,
        undefined,
        ctx,
      );
    const delivered = await completion(messages, started.details.id);
    assert.deepEqual(delivered.options, { deliverAs: "steer", triggerTurn: true });
    assert.equal(delivered.message.details.state, "completed");
    assert.equal(delivered.message.details.exitCode, 0);
    assert.match(delivered.message.content, /stdout tail:\ndone/);
    assert.ok(delivered.message.content.includes(delivered.message.details.logPath));
    assert.equal(handlers.get("context")!({ messages: [] }), undefined);
    assert.deepEqual(events.filter(event => event.name === "pylon:tool-policy").at(-1)?.value.enabledTools, [
      "heartbeat_start",
    ]);
    const lifecycle = events.filter(event => event.name === "pi-heartbeat:job");
    assert.ok(lifecycle.length >= 2);
    assert.equal(lifecycle.at(-1)?.value.state, "completed");
    assert.ok(lifecycle.every(event => event.value.sessionId === ctx.sessionManager.getSessionId()));

    const status = await tools.get("heartbeat_status").execute("status", { id: started.details.id });
    assert.match(status.content[0].text, /stdout tail:\ndone/);
    assert.deepEqual(events.filter(event => event.name === "pylon:tool-policy").at(-1)?.value.enabledTools, [
      "heartbeat_start",
    ]);
    assert.equal(handlers.get("context")!({ messages: [] }), undefined);
    assert.equal(messages.length, 1, "status inspection must not repeat completion");
  } finally {
    await handlers.get("session_shutdown")!();
  }
});

for (const exitCode of [0, 7]) {
  test(`completion bounds output and reports exit ${exitCode}`, async () => {
    const { handlers, tools, ctx, messages } = harness();
    await handlers.get("session_start")!({}, ctx);
    try {
      const started = await tools
        .get("heartbeat_start")
        .execute(
          "start",
          {
            command: `node -e "console.log('x'.repeat(20000)); console.error('failure detail'); process.exitCode=${exitCode}"`,
            otherWork: "inspect another file",
          },
          undefined,
          undefined,
          ctx,
        );
      const { message } = await completion(messages, started.details.id);
      assert.equal(message.details.state, exitCode ? "failed" : "completed");
      assert.equal(message.details.exitCode, exitCode);
      assert.match(message.content, /failure detail/);
      assert.match(message.content, /\[tail truncated\]/);
      assert.ok(Buffer.byteLength(message.content) < (exitCode ? 14000 : 4000));
      assert.equal(messages.length, 1);
    } finally {
      await handlers.get("session_shutdown")!();
    }
  });
}

test("spawn failure delivers one result after the process closes", async () => {
  const { handlers, tools, ctx, messages } = harness();
  await handlers.get("session_start")!({}, ctx);
  const missingDir = await mkdtemp(join(tmpdir(), "heartbeat-missing-"));
  await rm(missingDir, { recursive: true });
  try {
    const started = await tools
      .get("heartbeat_start")
      .execute("start", { command: "echo unreachable", otherWork: "inspect another file" }, undefined, undefined, {
        ...ctx,
        cwd: missingDir,
      });
    const { message } = await completion(messages, started.details.id);
    assert.equal(message.details.state, "failed");
    assert.notEqual(message.details.exitCode, undefined);
    assert.notEqual(message.details.exitCode, 0);
    await tools.get("heartbeat_status").execute("status", { id: started.details.id });
    assert.equal(messages.length, 1);
  } finally {
    await handlers.get("session_shutdown")!();
  }
});

test("cancellation and timeout each deliver one terminal result", async () => {
  const { handlers, tools, ctx, messages } = harness();
  await handlers.get("session_start")!({}, ctx);
  try {
    for (const state of ["cancelled", "timed_out"]) {
      const started = await tools
        .get("heartbeat_start")
        .execute(
          "start",
          {
            command: `node -e "setTimeout(()=>{},10000)"`,
            otherWork: "inspect another file",
            timeoutMs: state === "timed_out" ? 1000 : 10000,
          },
          undefined,
          undefined,
          ctx,
        );
      if (state === "cancelled") await tools.get("heartbeat_cancel").execute("cancel", { id: started.details.id });
      const { message } = await completion(messages, started.details.id);
      assert.equal(message.details.state, state);
      assert.notEqual(message.details.exitCode, undefined);
      await tools.get("heartbeat_status").execute("status", { id: started.details.id });
      assert.equal(messages.filter(item => item.message.details.id === started.details.id).length, 1);
    }
  } finally {
    await handlers.get("session_shutdown")!();
  }
});

test("shutdown suppresses completion even while it waits for job termination", async () => {
  const { handlers, tools, ctx, events, messages } = harness();
  await handlers.get("session_start")!({}, ctx);
  try {
    await tools
      .get("heartbeat_start")
      .execute(
        "start",
        { command: `node -e "setTimeout(()=>{},10000)"`, otherWork: "inspect another file" },
        undefined,
        undefined,
        ctx,
      );
  } finally {
    await handlers.get("session_shutdown")!();
  }
  assert.ok(events.some(event => event.name === "pi-heartbeat:job" && event.value.state === "cancelled"));
  assert.equal(messages.length, 0);
  await handlers.get("session_shutdown")!();
  assert.equal(messages.length, 0);
});

test("/heartbeat validates syntax, reports unavailable state, and cancels known jobs", async () => {
  const { handlers, tools, commands, ctx } = harness();
  const notifications: Array<{ text: string; level: string }> = [];
  const commandCtx = { ...ctx, ui: { notify: (text: string, level: string) => notifications.push({ text, level }) } };
  await commands.get("heartbeat").handler("list", commandCtx);
  assert.match(notifications.at(-1)?.text ?? "", /unavailable/i);
  assert.equal(notifications.at(-1)?.level, "warning");

  await handlers.get("session_start")!({}, ctx);
  try {
    await commands.get("heartbeat").handler("cancel", commandCtx);
    assert.equal(notifications.at(-1)?.level, "warning");
    const started = await tools
      .get("heartbeat_start")
      .execute(
        "start",
        { command: `node -e \"setTimeout(()=>{},10000)\"`, otherWork: "cancel it" },
        undefined,
        undefined,
        ctx,
      );
    await commands.get("heartbeat").handler(`cancel ${started.details.id}`, commandCtx);
    assert.match(notifications.at(-1)?.text ?? "", /Cancellation requested/);
  } finally {
    await handlers.get("session_shutdown")!();
  }
});
