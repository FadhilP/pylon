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

test("tools expose dedicated capture and lifecycle contracts without session review", async () => {
  const app = runtime();
  assert.deepEqual([...app.tools.keys()], ["papercut", "papercuts"]);
  assert.deepEqual([...app.commands.keys()], ["papercuts", "papercut"]);
  const capture = app.tools.get("papercut");
  const manage = app.tools.get("papercuts");
  assert.equal(capture.executionMode, "sequential");
  assert.equal(manage.executionMode, "sequential");
  assert.deepEqual(Object.keys(capture.parameters.properties), ["message"]);
  assert.equal(capture.parameters.properties.message.maxLength, 500);
  assert.match(capture.promptGuidelines.join("\n"), /avoidable retry.*undocumented setup.*flaky command.*stale cache.*misleading error.*gotcha/i);
  assert.match(capture.promptGuidelines.join("\n"), /continue the current task/i);
  assert.match(capture.promptGuidelines.join("\n"), /Do not log actual bugs or tracked work/i);
  assert.match(capture.promptGuidelines.join("\n"), /incidental recurrence is deduplicated automatically/i);
  assert.deepEqual(manage.parameters.properties.action.enum, ["list", "resolve", "dismiss", "reopen"]);
  assert.equal(app.commands.has("papercut-review"), false);

  for (const handler of app.handlers.get("session_start") ?? []) await handler({}, {});
  assert.deepEqual(app.emitted.at(-1), {
    channel: "pylon:tool-policy",
    value: {
      version: 1,
      kind: "register",
      owner: "pi-papercut",
      managedTools: ["papercut", "papercuts"],
      enabledTools: ["papercut", "papercuts"],
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
  const capture = app.tools.get("papercut");
  const manage = app.tools.get("papercuts");

  const first = await capture.execute("one", { message: "Setup required an undocumented retry." }, undefined, undefined, ctx);
  assert.match(first.content[0].text, /captured/i);
  assert.deepEqual(first.details.papercut.source, { sessionId: "session-1", provider: "openai", model: "gpt-test" });
  const repeated = await capture.execute("two", { message: "setup required an undocumented retry." }, undefined, undefined, ctx);
  assert.match(repeated.content[0].text, /already open.*seen 2/i);

  const listed = await manage.execute("list", { action: "list" }, undefined, undefined, ctx);
  assert.match(listed.content[0].text, /Papercuts \(open, 1\)/);
  const id = listed.details.records[0].id;
  const resolved = await manage.execute("resolve", { action: "resolve", ids: [id.slice(0, 8)], note: "Documented setup and added a regression test." }, undefined, undefined, ctx);
  assert.match(resolved.content[0].text, /Resolved papercut/);
  const open = await manage.execute("open", { action: "list" }, undefined, undefined, ctx);
  assert.match(open.content[0].text, /No open papercuts/);
  const closed = await manage.execute("closed", { action: "list", status: "resolved" }, undefined, undefined, ctx);
  assert.match(closed.content[0].text, /Documented setup and added a regression test/);

  await assert.rejects(
    manage.execute("invalid", { action: "list", ids: [id] }, undefined, undefined, ctx),
    /not valid when listing/,
  );
  await assert.rejects(
    manage.execute("missing-ids", { action: "dismiss" }, undefined, undefined, ctx),
    /ids are required/,
  );
  await assert.rejects(
    manage.execute("missing-note", { action: "resolve", ids: [id] }, undefined, undefined, ctx),
    /note is required/,
  );
  await assert.rejects(
    manage.execute("reopen-note", { action: "reopen", ids: [id], note: "extra" }, undefined, undefined, ctx),
    /note is not valid/,
  );
  await assert.rejects(
    capture.execute("secret", { message: "token=super-secret-value" }, undefined, undefined, ctx),
    /possible credential/,
  );

  const notifications: Array<{ text: string; level: string }> = [];
  const commandCtx = context(cwd, notifications);
  await app.commands.get("papercut").handler("A flaky command needed a retry", commandCtx);
  await app.commands.get("papercuts").handler("open", commandCtx);
  await app.commands.get("papercut").handler("resolve", commandCtx);
  await app.commands.get("papercut").handler("review", commandCtx);
  assert.match(notifications[0].text, /captured/i);
  assert.match(notifications[1].text, /flaky command/i);
  assert.match(notifications[2].text, /usage:/i);
  assert.match(notifications[3].text, /session review is not supported/i);
  assert.equal(notifications[2].level, "error");
  assert.equal(notifications[3].level, "error");
});
