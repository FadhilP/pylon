import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { saveConfig } from "pylon-core/src/config.ts";
import { SessionRuntime } from "../src/server/runtime/session-runtime.ts";
import type { UiRequest } from "../src/server/runtime/remote-ui-bridge.ts";

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "lifecycle event did not arrive");
    await delay(10);
  }
}

async function fixture(extensionFactories: ExtensionFactory[] = [], setup?: (cwd: string, agentDir: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pylon-codemode-lifecycle-"));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const previous = process.env.PI_CODING_AGENT_DIR,
    offline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  const extensions = ["pylon-core", "pi-continuity", "pi-guard"].map(name =>
    fileURLToPath(new URL(`../../../packages/${name}/extensions/${name}.ts`, import.meta.url)),
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ pi: { extensions } }));
  await saveConfig(
    { version: 1, lineEditEnabled: true, codemodeEnabled: true },
    join(agentDir, "pylon-core", "config.json"),
  );
  await setup?.(cwd, agentDir);
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const driver = new SessionRuntime({ modelRuntime, extensionFactories });
  const requests: UiRequest[] = [],
    closed: string[] = [];
  const stop = driver.subscribe(event => {
    if (event.type === "ui.event") requests.push(event.payload as UiRequest);
    if (event.type === "ui.closed") closed.push(event.requestId);
  });
  await driver.start({ cwd, agentDir, repositoryRoot: root, inMemory: true });
  // The same real session/UI binding used by HTTP commands, without a transport mock.
  const session = () => (driver as any).runtime.session;
  await session().setModel(faux.getModel());
  session().agent.toolExecution = "parallel";
  let nestedEnds = 0;
  const stopTools = session().subscribe((event: any) => {
    if (event.type === "tool_execution_end" && event.parentToolCallId) nestedEnds++;
  });
  const calls = async (tools: ReturnType<typeof fauxToolCall>[]) => {
    faux.setResponses([
      fauxAssistantMessage(tools, { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    const target = session();
    await target.prompt("Exercise codemode lifecycle");
    return [...target.messages]
      .reverse()
      .filter((message: any) => message.role === "toolResult")
      .slice(0, tools.length);
  };
  const run = async (code: string) => (await calls([fauxToolCall("codemode", { code })]))[0];
  return {
    root,
    cwd,
    agentDir,
    driver,
    requests,
    closed,
    session,
    calls,
    run,
    nestedEnds: () => nestedEnds,
    async close() {
      await driver.abort();
      stop();
      stopTools();
      await driver.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      if (offline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = offline;
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}


test("MCP settings drive native process startup, reload and shutdown without exposing configuration values", { timeout: 30_000 }, async () => {
  let pidPath = "";
  const value = await fixture([], async (_cwd, agentDir) => {
    pidPath = join(agentDir, "fixture.pid");
    const script = `
      require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
          if (request.id === undefined) continue;
          const result = request.method === 'initialize'
            ? {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}
            : {tools:[{name:'hello',inputSchema:{type:'object',properties:{}}}]};
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result}) + '\\n');
        }
      });
    `;
    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:["-e",script],env:{PRIVATE_SETTING:"fixture-private-value"},enabled:false}}}));
  });
  try {
    const runtime = await value.driver.snapshot();
    const query = {sessionId:runtime.sessionId!,expectedGeneration:runtime.sessionGeneration};
    let snapshot = await value.driver.mcpSettings(query);
    assert.equal(snapshot.servers[0]?.enabled,false);
    assert.doesNotMatch(JSON.stringify(snapshot),/fixture-private-value|PRIVATE_SETTING|writeFileSync/);
    await assert.rejects(value.driver.mcpSettings({...query,sessionId:"wrong-session"}),/Session changed/);
    // Follow the setup guide's returned path, then prove native MCP loads that file.
    assert.equal(snapshot.userConfigPath,join(value.agentDir,"mcp.json"));
    const config = JSON.parse(await readFile(snapshot.userConfigPath!,"utf8"));
    config.mcpServers.fixture.enabled = true;
    await writeFile(snapshot.userConfigPath!,JSON.stringify(config));
    assert.equal((await value.driver.mcpSettings(query)).needsReload,true);
    await value.driver.reloadExtensions();
    const deadline = Date.now()+10_000;
    do {
      snapshot = await value.driver.mcpSettings(query);
      if (snapshot.servers[0]?.state === "connected") break;
      assert.ok(Date.now()<deadline,"native MCP did not connect");
      await delay(20);
    } while (true);
    assert.equal(snapshot.servers[0]?.toolCount,1);
    assert.equal(snapshot.needsReload,false);
    const pid = Number(await readFile(pidPath,"utf8"));
    assert.ok(pid>0);
    await value.driver.mcpAction({...query,action:"enabled",name:"fixture",enabled:false,confirmed:true,expectedRevision:snapshot.revision});
    await value.driver.reloadExtensions();
    await waitFor(()=>{try {process.kill(pid,0);return false;} catch {return true;}});
    assert.equal((await value.driver.mcpSettings(query)).servers[0]?.enabled,false);
  } finally {await value.close();}
});

const text = (result: any) => result.content.map((part: any) => part.text ?? "").join("\n");
const absent = (path: string) => assert.rejects(readFile(path), { code: "ENOENT" });

test(
  "real Continuity planning and clarification cannot be bypassed by scripts or mixed batches",
  { timeout: 30_000 },
  async () => {
    const value = await fixture();
    try {
      await value.session().prompt("/plan start");
      assert.equal((await value.run('await tools.write({path:"gated.txt",content:"bad"});')).isError, true);
      await absent(join(value.cwd, "gated.txt"));
      await value.session().prompt("/plan cancel");
      assert.equal((await value.run('text("restored");')).isError, false);
      await value.calls([
        fauxToolCall("continuity_update", {
          action: "set_plan",
          goal: "Lifecycle coverage",
          todos: ["Protect writes"],
        }),
      ]);
      const results = await value.calls([
        fauxToolCall("codemode", { code: 'await tools.write({path:"mixed.txt",content:"bad"});' }),
        fauxToolCall("continuity_update", {
          action: "clarify",
          question: "Proceed?",
          options: [{ label: "Proceed" }, { label: "Stop" }],
        }),
      ]);
      assert.ok(results.every(result => result.isError));
      await absent(join(value.cwd, "mixed.txt"));
      const start = value.requests.length;
      const pending = value.calls([
        fauxToolCall("continuity_update", {
          action: "clarify",
          question: "Proceed?",
          options: [{ label: "Proceed" }, { label: "Stop" }],
        }),
      ]);
      await waitFor(() => value.requests.slice(start).some(request => request.method === "questionnaire"));
      await value.driver.abort();
      await pending;
      assert.equal((await value.run('await tools.write({path:"after.txt",content:"ok"});')).isError, false);
      assert.equal(await readFile(join(value.cwd, "after.txt"), "utf8"), "ok");
    } finally {
      await value.close();
    }
  },
);

test(
  "real Guard parallel approvals fail closed, deadlines close requests, and replacement rejects stale answers",
  { timeout: 30_000 },
  async () => {
    const value = await fixture();
    try {
      await value.run('text("warm worker");');
      const first = join(value.root, "first.txt"),
        second = join(value.root, "second.txt");
      const start = value.requests.length;
      const ended = value.nestedEnds();
      const parallel = value.run(
        `text((await Promise.allSettled(${JSON.stringify([first, second])}.map(path=>tools.write({path,content:"approved"})))).map(r=>r.status));`,
      );
      await waitFor(() => value.requests.slice(start).some(request => request.method === "select"));
      // Wait until the sibling is denied by the bridge's single-flight rule, rather than racing the response.
      await waitFor(() => value.nestedEnds() > ended);
      // A real planning command during a script must refuse the transition, not strand an approval.
      await value.session().prompt("/plan start");
      const request = value.requests.slice(start).find(request => request.method === "select")!;
      await value.driver.answerUiRequest({
        requestId: request.requestId,
        sessionGeneration: request.sessionGeneration,
        method: "select",
        value: "Allow once",
      });
      const result = await parallel;
      assert.equal(result.isError, false);
      assert.match(text(result), /fulfilled.*rejected|rejected.*fulfilled/);
      const files = await Promise.all([first, second].map(path => readFile(path, "utf8").catch(() => undefined)));
      assert.equal(files.filter(value => value === "approved").length, 1);
      const cancelledPath = join(value.root, "cancelled.txt");
      const deadlineStart = value.requests.length;
      const timed = value.run(
        `// @options: {"timeout_ms":500}\nawait tools.write({path:${JSON.stringify(cancelledPath)},content:"bad"});`,
      );
      await waitFor(() => value.requests.slice(deadlineStart).some(request => request.method === "select"));
      const expired = value.requests.slice(deadlineStart).find(request => request.method === "select")!;
      assert.equal((await timed).isError, true);
      assert.ok(value.closed.includes(expired.requestId), "deadline left a stale Guard request open");
      await assert.rejects(
        value.driver.answerUiRequest({
          requestId: expired.requestId,
          sessionGeneration: expired.sessionGeneration,
          method: "select",
          value: "Allow once",
        }),
        /expired|unknown/,
      );
      await absent(cancelledPath);
      const replaceStart = value.requests.length;
      const pending = value.run(`await tools.write({path:${JSON.stringify(cancelledPath)},content:"bad"});`);
      await waitFor(() => value.requests.slice(replaceStart).some(request => request.method === "select"));
      const stale = value.requests.slice(replaceStart).find(request => request.method === "select")!;
      await value.driver.abort();
      await pending;
      const replaced = await value.driver.newSession({ expectedGeneration: 1 });
      assert.equal(replaced.cancelled, false);
      await assert.rejects(
        value.driver.answerUiRequest({
          requestId: stale.requestId,
          sessionGeneration: stale.sessionGeneration,
          method: "select",
          value: "Allow once",
        }),
        /expired|unknown|stale/,
      );
      await absent(cancelledPath);
      assert.equal((await value.run('text("replacement recovered");')).isError, false);
    } finally {
      await value.close();
    }
  },
);

test(
  "successful script exit closes unawaited Guard approvals and delayed preparation stays cancelled",
  { timeout: 30_000 },
  async () => {
    const value = await fixture([
      pi =>
        pi.registerTool({
          name: "fd",
          label: "fd",
          description: "Wait for an approval request",
          parameters: Type.Object({}),
          async execute() {
            await waitFor(() => value.requests.some(request => request.method === "select"));
            return { content: [{ type: "text", text: "approval pending" }], details: {} };
          },
        }),
    ]);
    try {
      const path = join(value.root, "unawaited.txt");
      const result = await value.run(
        `void tools.write({path:${JSON.stringify(path)},content:"bad"}); await tools.fd({}); text("finished");`,
      );
      assert.equal(result.isError, false);
      const request = value.requests.find(request => request.method === "select")!;
      assert.ok(value.closed.includes(request.requestId));
      await absent(path);
      assert.equal((await value.run('text("recovered");')).isError, false);
    } finally {
      await value.close();
    }

    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const delayed = await fixture([
      pi => {
        const stop = pi.events.on("pi-timeline:checkpoint-request", (event: any) => {
          event.respond(gate);
          entered();
        });
        pi.on("session_shutdown", () => stop());
      },
    ]);
    try {
      await writeFile(join(delayed.cwd, "ready.txt"), "ready");
      const path = join(delayed.root, "delayed.txt");
      const pending = delayed.run(
        `void tools.write({path:${JSON.stringify(path)},content:"bad"}); await tools.read({path:"ready.txt"}); text("finished");`,
      );
      await started;
      assert.equal((await pending).isError, false);
      const ended = delayed.nestedEnds();
      release();
      await waitFor(() => delayed.nestedEnds() > ended);
      assert.equal(delayed.requests.filter(request => request.method === "select").length, 0);
      await absent(path);
      assert.equal((await delayed.run('text("recovered");')).isError, false);
    } finally {
      release();
      await delayed.close();
    }
  },
);
