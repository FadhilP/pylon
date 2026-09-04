import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/pi-papercut.ts";
import { configPath, saveConfig } from "../src/config.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const root = await mkdtemp(join(tmpdir(), "papercut-extension-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(root, { recursive: true, force: true });
});

function runtime() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const eventHandlers = new Map<string, Function[]>();
  const emitted: Array<{ channel: string; value: any }> = [];
  const pi: any = {
    events: {
      emit: (channel: string, value: any) => {
        emitted.push({ channel, value });
        for (const handler of eventHandlers.get(channel) ?? []) handler(value);
      },
      on: (channel: string, handler: Function) => {
        eventHandlers.set(channel, [...(eventHandlers.get(channel) ?? []), handler]);
        return () =>
          eventHandlers.set(
            channel,
            (eventHandlers.get(channel) ?? []).filter(item => item !== handler),
          );
      },
    },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  };
  extension(pi);
  return { tools, commands, handlers, eventHandlers, emitted, pi };
}

function context(cwd: string, notifications: Array<{ text: string; level: string }> = []) {
  return {
    cwd,
    model: { provider: "openai", id: "gpt-test" },
    sessionManager: { getSessionId: () => "session-1" },
    ui: { notify: (text: string, level: string) => notifications.push({ text, level }) },
  } as any;
}

test("session settings apply configured omitted list limits", async () => {
  const cwd = join(root, "configured-repo");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await saveConfig(
    { version: 1, listDefaultLimit: 1, queryDefaultLimit: 1 },
    configPath(process.env.PI_CODING_AGENT_DIR),
  );
  const app = runtime();
  const ctx = context(cwd);
  const tool = app.tools.get("papercut");
  await app.handlers.get("session_start")?.[0]({}, ctx);
  await tool.execute("one", { message: "First configured papercut." }, undefined, undefined, ctx);
  await tool.execute("two", { message: "Second configured papercut." }, undefined, undefined, ctx);
  const listed = await tool.execute("list", { action: "list" }, undefined, undefined, ctx);
  assert.equal(listed.details.records.length, 1);
  await saveConfig({ version: 1 }, configPath(process.env.PI_CODING_AGENT_DIR));
  await app.handlers.get("session_shutdown")?.[0]();
});

test("capture, dedupe, list, resolve, and command flows persist project state", async () => {
  const cwd = join(root, "repo");
  await mkdir(join(cwd, ".git"), { recursive: true });
  const app = runtime();
  const ctx = context(cwd);
  const tool = app.tools.get("papercut");

  const first = await tool.execute(
    "one",
    { message: "Setup required an undocumented retry." },
    undefined,
    undefined,
    ctx,
  );
  assert.match(first.content[0].text, /captured/i);
  assert.deepEqual(first.details.papercut.source, { sessionId: "session-1", provider: "openai", model: "gpt-test" });
  const repeated = await tool.execute(
    "two",
    { message: "setup required an undocumented retry." },
    undefined,
    undefined,
    ctx,
  );
  assert.match(repeated.content[0].text, /already open.*seen 2/i);

  const listed = await tool.execute("list", { action: "list" }, undefined, undefined, ctx);
  assert.match(listed.content[0].text, /Papercuts \(open, 1\)/);
  const id = listed.details.records[0].id;
  const resolved = await tool.execute(
    "resolve",
    { action: "resolve", ids: [id.slice(0, 8)], note: "Documented setup and added a regression test." },
    undefined,
    undefined,
    ctx,
  );
  assert.match(resolved.content[0].text, /Resolved papercut/);
  const open = await tool.execute("open", { action: "list" }, undefined, undefined, ctx);
  assert.match(open.content[0].text, /No open papercuts/);
  const closed = await tool.execute("closed", { action: "list", status: "resolved" }, undefined, undefined, ctx);
  assert.match(closed.content[0].text, /Documented setup and added a regression test/);

  for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);
  const policy = app.emitted.find(
    item => item.channel === "pylon:tool-policy" && item.value?.kind === "register",
  )?.value;
  assert.deepEqual(policy.deferredTools, []);
  let response: Promise<any> | undefined;
  app.pi.events.emit("pylon:papercut-list-request", {
    version: 1,
    sessionId: "session-1",
    status: "resolved",
    query: "regression",
    offset: 0,
    limit: 25,
    claim: () => true,
    respond: (value: Promise<any>) => {
      response = value;
    },
  });
  const page = await response;
  assert.equal(page.total, 1);
  assert.equal(page.records[0].resolution, "Documented setup and added a regression test.");
  assert.equal(page.records[0].source, undefined);
  assert.equal(page.records[0].lastSource, undefined);
  await assert.rejects(
    tool.execute("invalid", { action: "list", ids: [id] }, undefined, undefined, ctx),
    /not valid when listing/,
  );
  await assert.rejects(
    tool.execute("missing-ids", { action: "dismiss" }, undefined, undefined, ctx),
    /ids are required/,
  );
  await assert.rejects(
    tool.execute("missing-note", { action: "resolve", ids: [id] }, undefined, undefined, ctx),
    /note is required/,
  );
  await assert.rejects(
    tool.execute("reopen-note", { action: "reopen", ids: [id], note: "extra" }, undefined, undefined, ctx),
    /note is not valid/,
  );
  await assert.rejects(
    tool.execute("secret", { message: "token=super-secret-value" }, undefined, undefined, ctx),
    /possible credential/,
  );

  const notifications: Array<{ text: string; level: string }> = [];
  const commandCtx = context(cwd, notifications);
  const command = app.commands.get("papercuts");
  await command.handler("", commandCtx);
  await command.handler("resolved", commandCtx);
  await command.handler("all", commandCtx);
  await command.handler("capture this", commandCtx);
  assert.match(notifications[0].text, /No open papercuts/i);
  assert.match(notifications[1].text, /Documented setup and added a regression test/i);
  assert.match(notifications[2].text, /Papercuts \(all, 1\)/i);
  assert.match(notifications[3].text, /usage: \/papercuts/i);
  assert.equal(notifications[3].level, "warning");

  const request = <T>(channel: string, value: Record<string, unknown>) =>
    new Promise<T>((resolve, reject) => {
      app.pi.events.emit(channel, {
        version: 1,
        sessionId: "session-1",
        ...value,
        claim: () => true,
        respond: (result: Promise<T>) => {
          void result.then(resolve, reject);
        },
      });
    });
  const editResult = await request<any>("pylon:papercut-mutation-request", {
    action: "edit",
    id,
    expectedUpdatedAt: page.records[0].updatedAt,
    message: "Setup retry is now documented.",
  });
  assert.equal(editResult.ok, true);

  const editedPage = await request<any>("pylon:papercut-list-request", {
    status: "all",
    query: "documented",
    offset: 0,
    limit: 25,
  });
  assert.equal(editedPage.records[0].message, "Setup retry is now documented.");

  const deleteResult = await request<any>("pylon:papercut-mutation-request", {
    action: "delete",
    id,
    expectedUpdatedAt: editedPage.records[0].updatedAt,
  });
  assert.equal(deleteResult.ok, true);
  assert.equal(
    app.emitted.some(item => item.channel === "pi-papercut:state-change" && item.value.counts.total === 0),
    true,
  );
});

test("mixed lifecycle batches commit once and roll back together", async () => {
  const cwd = join(root, "batch-repo");
  await mkdir(join(cwd, ".git"), { recursive: true });
  const app = runtime();
  const ctx = context(cwd);
  const tool = app.tools.get("papercut");
  for (const handler of app.handlers.get("session_start") ?? []) await handler({}, ctx);

  await tool.execute("capture-one", { message: "First batch friction." }, undefined, undefined, ctx);
  await tool.execute("capture-two", { message: "Second batch friction." }, undefined, undefined, ctx);
  const listed = await tool.execute("list", { action: "list" }, undefined, undefined, ctx);
  const [first, second] = listed.details.records.map((record: any) => record.id.slice(0, 8));
  const changesBefore = app.emitted.filter(item => item.channel === "pi-papercut:state-change").length;

  const batch = await tool.execute(
    "batch",
    {
      actions: [
        { action: "resolve", ids: [first], note: "Fixed and verified." },
        { action: "dismiss", ids: [second], note: "No project action warranted." },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.match(batch.content[0].text, /Resolved papercut.*Dismissed papercut/s);
  assert.deepEqual(
    batch.details.actions.map((item: any) => item.action),
    ["resolve", "dismiss"],
  );
  assert.equal(app.emitted.filter(item => item.channel === "pi-papercut:state-change").length, changesBefore + 1);

  const afterBatch = await tool.execute("all", { action: "list", status: "all" }, undefined, undefined, ctx);
  assert.deepEqual(
    Object.fromEntries(afterBatch.details.records.map((record: any) => [record.id.slice(0, 8), record.status])),
    { [first]: "resolved", [second]: "dismissed" },
  );

  await assert.rejects(
    tool.execute(
      "rollback",
      {
        actions: [
          { action: "reopen", ids: [first] },
          { action: "dismiss", ids: ["deadbeef"], note: "Missing target." },
        ],
      },
      undefined,
      undefined,
      ctx,
    ),
    /unknown papercut id/,
  );
  const afterFailure = await tool.execute("all-again", { action: "list", status: "all" }, undefined, undefined, ctx);
  assert.deepEqual(
    Object.fromEntries(afterFailure.details.records.map((record: any) => [record.id.slice(0, 8), record.status])),
    { [first]: "resolved", [second]: "dismissed" },
  );
  assert.equal(app.emitted.filter(item => item.channel === "pi-papercut:state-change").length, changesBefore + 1);
});
