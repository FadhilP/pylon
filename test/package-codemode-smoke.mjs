// Copied into the installed package by package.test.mjs, so every import resolves from that distribution.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [packageRoot, root, cwd] = process.argv.slice(2);
const agentDir = join(root, "web-agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const extension = join(packageRoot, "codemode-web-fixture.mjs");
await writeFile(
  extension,
  `
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
export default function(pi) {
  const faux = fauxProvider();
  pi.registerProvider(faux.provider);
  pi.on("input", event => {
    if (!event.text.startsWith("codemode-fixture:")) return;
    const code = JSON.parse(event.text.slice("codemode-fixture:".length));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", {code})], {stopReason:"toolUse"}),
      fauxAssistantMessage([fauxText("done")])
    ]);
  });
}
`,
);
await mkdir(join(agentDir, "pylon-core"), { recursive: true });
await writeFile(
  join(agentDir, "settings.json"),
  JSON.stringify({
    extensions: [extension],
    defaultProvider: "faux",
    defaultModel: "faux-1",
    cacheWarming: "off",
    compaction: { enabled: false },
  }),
);
await writeFile(
  join(agentDir, "pylon-core", "config.json"),
  JSON.stringify({ version: 1, lineEditEnabled: true, codemodeEnabled: true }),
);
const { startPylonServer } = await import(
  pathToFileURL(join(packageRoot, "platform/web/dist-server/server/index.js")).href
);
const running = await startPylonServer({ cwd, repositoryRoot: packageRoot, agentDir, port: 0, development: false });
const origin = `http://127.0.0.1:${running.server.address().port}`;
const streams = [];

async function waitFor(read, predicate) {
  const deadline = Date.now() + 15_000;
  let last;
  while (Date.now() < deadline) {
    const value = await read();
    last = value;
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error(
    "Packaged Web condition did not settle: " +
      JSON.stringify(
        last?.runtime
          ? {
              generation: last.sessionGeneration,
              streaming: last.runtime.conversation.streaming,
              error: last.runtime.conversation.agentError,
              tool: lastTool(last),
              diagnostics: last.runtime.diagnostics,
            }
          : last,
      ),
  );
}
async function tab(id, cookie) {
  const response = await fetch(`${origin}/api/v1/bootstrap`, {
    headers: { "x-pylon-tab-id": id, ...(cookie ? { cookie } : {}) },
  });
  assert.equal(response.status, 200);
  const boot = await response.json();
  return { id, boot, cookie: cookie ?? response.headers.get("set-cookie").split(";")[0], csrf: boot.csrfToken };
}
const headers = tab => ({
  cookie: tab.cookie,
  "x-pylon-tab-id": tab.id,
  "x-pylon-csrf": tab.csrf,
  "content-type": "application/json",
});
const bootstrap = async tab => (await fetch(`${origin}/api/v1/bootstrap`, { headers: headers(tab) })).json();
async function post(tab, path, input, expected = 200) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: headers(tab),
    body: JSON.stringify(input),
  });
  const body = await response.json();
  assert.equal(response.status, expected, JSON.stringify(body));
  return body;
}
let commandId = 0;
async function command(tab, type, input = {}) {
  const boot = await bootstrap(tab);
  return post(tab, "/api/v1/commands", {
    type,
    commandId: `codemode-${++commandId}`,
    expectedGeneration: boot.sessionGeneration,
    ...input,
  });
}
async function connect(tab, cursor = `${tab.boot.sessionGeneration}:${tab.boot.sequence}`) {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/v1/events?tabId=${tab.id}&cursor=${cursor}`, {
    headers: { cookie: tab.cookie },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(),
    events = [];
  const stream = { controller, events, ready: false, cursor };
  stream.done = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (frame.startsWith(": connected")) stream.ready = true;
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (data) {
            const event = JSON.parse(data.slice(6));
            events.push(event);
            if (event.sequence) stream.cursor = `${event.sessionGeneration}:${event.sequence}`;
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  streams.push(stream);
  await waitFor(
    () => stream,
    value => value.ready,
  );
  return stream;
}
const scripts = new Set();
async function runScript(tab, code) {
  const previous = lastTool(await bootstrap(tab))?.id;
  await command(tab, "prompt", { message: `codemode-fixture:${JSON.stringify(code)}` });
  return waitFor(
    () => bootstrap(tab),
    value =>
      !value.runtime.conversation.streaming &&
      lastTool(value)?.id !== previous &&
      lastTool(value)?.tool.status !== "running",
  );
}
function script(tab, code) {
  const task = runScript(tab, code);
  scripts.add(task);
  task.then(
    () => scripts.delete(task),
    () => scripts.delete(task),
  );
  return task;
}
const lastTool = boot => boot.runtime.conversation.messages.filter(message => message.tool?.name === "codemode").at(-1);
const absent = path => assert.rejects(readFile(path), { code: "ENOENT" });

try {
  const owner = await tab("codemode-owner");
  let activity = await connect(owner);
  const other = await tab("codemode-other", owner.cookie);
  await connect(other);
  const initial = await script(
    owner,
    'const r=await tools.read({path:"source.ts"}); store("cursor", "disk-saved"); text(r.includes("packagedSymbol"));',
  );
  assert.equal(lastTool(initial).tool.status, "completed");
  assert.match(lastTool(initial).text, /true/);
  assert.equal(lastTool(initial).tool.nestedCalls.calls[0].name, "read");
  await waitFor(
    () => activity.events,
    events => events.some(event => JSON.stringify(event).includes("parentToolCallId")),
  );
  console.log("Packaged Web: initial execution passed");

  const guarded = join(root, "guarded.txt");
  const pending = script(owner, `await tools.write({path:${JSON.stringify(guarded)},content:"approved"});`);
  const dialog = await waitFor(
    () => bootstrap(owner),
    value => value.pendingUi?.method === "select",
  );
  const request = dialog.pendingUi;
  const answer = { sessionGeneration: dialog.sessionGeneration, method: "select", value: "Allow once" };
  await post(other, `/api/v1/ui-responses/${request.requestId}`, answer, 409);
  await post(owner, `/api/v1/ui-ownership/${request.requestId}`, {
    sessionGeneration: dialog.sessionGeneration,
    action: "release",
  });
  await post(owner, `/api/v1/ui-responses/${request.requestId}`, answer, 409);
  await post(other, `/api/v1/ui-ownership/${request.requestId}`, {
    sessionGeneration: dialog.sessionGeneration,
    action: "claim",
  });
  await post(other, `/api/v1/ui-responses/${request.requestId}`, answer);
  await pending;
  assert.equal(await readFile(guarded, "utf8"), "approved");
  console.log("Packaged Web: approval ownership passed");

  const cancelledPath = join(root, "not-approved.txt");
  const cancelled = script(owner, `await tools.write({path:${JSON.stringify(cancelledPath)},content:"bad"});`);
  const beforeAbort = await waitFor(
    () => bootstrap(other),
    value => value.pendingUi?.method === "select",
  );
  await command(owner, "abort");
  await cancelled;
  assert.equal((await bootstrap(owner)).pendingUi, undefined);
  await absent(cancelledPath);
  console.log("Packaged Web: approval cancellation passed");

  // Reconnect through the real event journal, then reconstruct the same disk-backed runtime.
  activity.controller.abort();
  await activity.done;
  activity = await connect(owner, activity.cursor);
  const originalSessionId = (await bootstrap(owner)).runtime.sessionId;
  await command(owner, "newSession");
  await command(owner, "setSessionActive", { sessionId: originalSessionId, active: false });
  await command(owner, "switchSession", { sessionId: originalSessionId });
  const resumed = await script(owner, 'text(load("cursor"));');
  assert.match(lastTool(resumed).text, /disk-saved/);
  assert.ok(
    resumed.runtime.conversation.messages.some(message => message.tool?.nestedCalls?.calls[0]?.name === "read"),
  );
  await post(
    other,
    `/api/v1/ui-responses/${beforeAbort.pendingUi.requestId}`,
    { sessionGeneration: beforeAbort.sessionGeneration, method: "select", value: "Allow once" },
    409,
  );

  const packages = await (await fetch(`${origin}/api/v1/packages`, { headers: headers(owner) })).json();
  const settings = packages.packages.find(item => item.id === "pylon-core").settings;
  settings.fields.find(field => field.key === "codemodeEnabled").value = false;
  await command(owner, "updatePackageSettings", { packageId: "pylon-core", settings });
  assert.equal(lastTool(await script(owner, 'text("existing runtime unchanged");')).tool.status, "completed");
  await command(owner, "newSession");
  assert.equal(
    lastTool(await script(owner, `await tools.write({path:${JSON.stringify(cancelledPath)},content:"bad"});`)).tool
      .status,
    "failed",
  );
  await absent(cancelledPath);
  settings.fields.find(field => field.key === "codemodeEnabled").value = true;
  await command(owner, "updatePackageSettings", { packageId: "pylon-core", settings });
  await command(owner, "newSession");
  assert.equal(lastTool(await script(owner, 'text("enabled again");')).tool.status, "completed");
  console.log("Installed Web codemode: native worker, HTTP/SSE, approvals, reconnect, replacement and settings passed");
} finally {
  await Promise.allSettled([...scripts]);
  for (const stream of streams) stream.controller.abort();
  await Promise.all(streams.map(stream => stream.done));
  await running.close();
}
