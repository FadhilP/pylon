import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../extensions/pi-papercut.ts";

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
  const emitted: Array<{ channel: string; value: any }> = [];
  const pi: any = {
    events: { emit: (channel: string, value: any) => emitted.push({ channel, value }) },
    on: (name: string, handler: Function) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
  };
  extension(pi);
  return { tools, commands, handlers, emitted };
}

function context(cwd: string, notifications: Array<{ text: string; level: string }> = []) {
  return {
    cwd,
    model: { provider: "openai", id: "gpt-test" },
    sessionManager: { getSessionId: () => "session-1" },
    ui: { notify: (text: string, level: string) => notifications.push({ text, level }) },
  } as any;
}

test("one tool exposes capture and lifecycle actions without session review", async () => {
  const app = runtime();
  assert.deepEqual([...app.tools.keys()], ["papercut"]);
  assert.deepEqual([...app.commands.keys()], ["papercut"]);
  const tool = app.tools.get("papercut");
  assert.equal(tool.executionMode, "sequential");
  assert.deepEqual(Object.keys(tool.parameters.properties), ["action", "message", "status", "limit", "ids", "note"]);
  assert.equal(tool.parameters.properties.message.maxLength, 500);
  assert.match(tool.promptGuidelines.join("\n"), /avoidable retry.*undocumented setup.*flaky command.*stale cache.*misleading error.*gotcha/i);
  assert.match(tool.promptGuidelines.join("\n"), /continue the current task/i);
  assert.match(tool.promptGuidelines.join("\n"), /Do not log actual bugs or tracked work/i);
  assert.match(tool.promptGuidelines.join("\n"), /incidental recurrence is deduplicated automatically/i);
  assert.deepEqual(tool.parameters.properties.action.enum, ["capture", "list", "resolve", "dismiss", "reopen"]);
  assert.equal(app.commands.has("papercut-review"), false);

  for (const handler of app.handlers.get("session_start") ?? []) await handler({}, {});
  assert.deepEqual(app.emitted.at(-1), {
    channel: "pylon:tool-policy",
    value: {
      version: 1,
      kind: "register",
      owner: "pi-papercut",
      managedTools: ["papercut"],
      enabledTools: ["papercut"],
    },
  });
  for (const handler of app.handlers.get("session_shutdown") ?? []) await handler({}, {});
  assert.deepEqual(app.emitted.at(-1), {
    channel: "pylon:tool-policy",
    value: { version: 1, kind: "unregister", owner: "pi-papercut" },
  });
});

test("capture, dedupe, list, resolve, and command flows persist project state", async () => {
  const cwd = join(root, "repo");
  await mkdir(join(cwd, ".git"), { recursive: true });
  const app = runtime();
  const ctx = context(cwd);
  const tool = app.tools.get("papercut");

  const first = await tool.execute("one", { message: "Setup required an undocumented retry." }, undefined, undefined, ctx);
  assert.match(first.content[0].text, /captured/i);
  assert.deepEqual(first.details.papercut.source, { sessionId: "session-1", provider: "openai", model: "gpt-test" });
  const repeated = await tool.execute("two", { message: "setup required an undocumented retry." }, undefined, undefined, ctx);
  assert.match(repeated.content[0].text, /already open.*seen 2/i);

  const listed = await tool.execute("list", { action: "list" }, undefined, undefined, ctx);
  assert.match(listed.content[0].text, /Papercuts \(open, 1\)/);
  const id = listed.details.records[0].id;
  const resolved = await tool.execute("resolve", { action: "resolve", ids: [id.slice(0, 8)], note: "Documented setup and added a regression test." }, undefined, undefined, ctx);
  assert.match(resolved.content[0].text, /Resolved papercut/);
  const open = await tool.execute("open", { action: "list" }, undefined, undefined, ctx);
  assert.match(open.content[0].text, /No open papercuts/);
  const closed = await tool.execute("closed", { action: "list", status: "resolved" }, undefined, undefined, ctx);
  assert.match(closed.content[0].text, /Documented setup and added a regression test/);

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
  const command = app.commands.get("papercut");
  await command.handler("", commandCtx);
  await command.handler("ALL", commandCtx);
  await command.handler("A flaky command needed a retry", commandCtx);
  await command.handler("open issue needed a retry", commandCtx);
  await command.handler("resolve", commandCtx);
  await command.handler("review", commandCtx);
  assert.match(notifications[0].text, /No open papercuts/i);
  assert.match(notifications[1].text, /Papercuts \(all, 1\)/i);
  assert.match(notifications[2].text, /captured/i);
  assert.match(notifications[3].text, /captured/i);
  assert.match(notifications[4].text, /usage:/i);
  assert.match(notifications[5].text, /session review is not supported/i);
  assert.equal(notifications[4].level, "error");
  assert.equal(notifications[5].level, "error");
});
