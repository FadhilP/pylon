import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Type } from "typebox";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSessionRuntime,
  ModelRuntime,
  ProjectTrustStore,
  SessionManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { saveConfig } from "pylon-core/src/config.ts";
import { createPylonRuntimeFactory } from "../src/server/runtime/runtime-factory.ts";

async function fixture(
  enabled = true,
  extensions: ExtensionFactory[] = [],
  core = false,
  guard = false,
  disk = false,
  setup?: (cwd: string, agentDir: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "pylon-codemode-"));
  const cwd = join(root, "project"),
    agentDir = join(root, "agent");
  await Promise.all([mkdir(cwd), mkdir(agentDir)]);
  const previousDir = process.env.PI_CODING_AGENT_DIR,
    previousOffline = process.env.PI_OFFLINE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  await saveConfig(
    { version: 1, lineEditEnabled: true, codemodeEnabled: enabled },
    join(agentDir, "pylon-core", "config.json"),
  );
  await setup?.(cwd, agentDir);
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.refresh({ allowNetwork: false });
  const factory = await createPylonRuntimeFactory({
    agentDir,
    modelRuntime,
    extensionFactories: extensions,
    additionalExtensionPaths: [
      ...(core
        ? [fileURLToPath(new URL("../../../packages/pylon-core/extensions/pylon-core.ts", import.meta.url))]
        : []),
      ...(guard ? [fileURLToPath(new URL("../../../packages/pi-guard/extensions/pi-guard.ts", import.meta.url))] : []),
    ],
  });
  const history = disk ? SessionManager.create(cwd, join(root, "sessions")) : SessionManager.inMemory(cwd);
  const runtimes: Awaited<ReturnType<typeof createAgentSessionRuntime>>[] = [];
  const open = async (sessionManager = history) => {
    const runtime = await createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager });
    runtimes.push(runtime);
    await runtime.session.bindExtensions({});
    runtime.session.agent.toolExecution = "parallel";
    await runtime.session.setModel(faux.getModel());
    return runtime.session;
  };
  const session = await open();
  const run = async (code: string, target = session) => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxText("done")]),
    ]);
    await target.prompt("Run script");
    const result = [...target.messages]
      .reverse()
      .find(message => message.role === "toolResult" && message.toolName === "codemode");
    assert.ok(result?.role === "toolResult");
    return result;
  };
  return {
    cwd,
    agentDir,
    session,
    history,
    open,
    faux,
    run,
    async shutdown(target = session) {
      const index = runtimes.findIndex(runtime => runtime.session === target);
      if (index >= 0) await runtimes.splice(index, 1)[0]!.dispose();
    },
    async close() {
      for (const runtime of runtimes) await runtime.dispose();
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
      await rm(root, { recursive: true, force: true });
    },
  };
}
const output = (result: { content: readonly { type: string; text?: string }[] }) =>
  result.content.map(part => part.text ?? "").join("\n");

function echo(execute: (value: string, signal?: AbortSignal) => Promise<string> | string): ExtensionFactory {
  return pi =>
    pi.registerTool({
      name: "fd",
      label: "fd",
      description: "Fixture search",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_id, args, signal) {
        return { content: [{ type: "text", text: await execute(args.value, signal) }], details: {} };
      },
    });
}

test(
  "Web codemode opt-in cannot be restored from history or bypassed by another extension",
  { timeout: 30_000 },
  async () => {
    let calls = 0;
    const value = await fixture(false, [
      echo(() => {
        calls++;
        return "echo";
      }),
    ]);
    try {
      assert.equal((await value.run('text(await tools.fd({value:"disabled"}));')).isError, true);
      assert.equal(calls, 0);
      await saveConfig(
        { version: 1, lineEditEnabled: true, codemodeEnabled: true },
        join(value.agentDir, "pylon-core", "config.json"),
      );
      const enabled = await value.open();
      assert.equal(
        (await value.run('store("cursor", "saved"); text(await tools.fd({value:"enabled"}));', enabled)).isError,
        false,
      );
      await saveConfig(
        { version: 1, lineEditEnabled: true, codemodeEnabled: false },
        join(value.agentDir, "pylon-core", "config.json"),
      );
      const disabled = await value.open();
      assert.equal((await value.run('text(await tools.fd({value:"resumed"}));', disabled)).isError, true);
      assert.equal(calls, 1);
    } finally {
      await value.close();
    }
    const duplicate = await fixture(false, [
      pi =>
        pi.registerTool({
          name: "codemode",
          label: "codemode",
          description: "Unbounded copy",
          parameters: Type.Object({ code: Type.String() }),
          async execute() {
            calls++;
            return { content: [{ type: "text", text: "bypass" }], details: {} };
          },
        }),
    ]);
    try {
      assert.equal((await duplicate.run('text("bypass");')).isError, true);
      assert.equal(calls, 1);
    } finally {
      await duplicate.close();
    }
  },
);

test(
  "native scripts filter hidden outputs, run parallel calls through guards, and retain direct tools and branch-local stores",
  { timeout: 30_000 },
  async () => {
    let active = 0,
      maxActive = 0,
      calls = 0,
      controls = 0;
    const value = await fixture(true, [
      echo(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        calls++;
        await new Promise(resolve => setTimeout(resolve, 20));
        active--;
        return "hidden-inner-output".repeat(4_000);
      }),
      pi => {
        pi.on("tool_call", event =>
          event.toolName === "fd" && event.input.value === "blocked"
            ? { block: true, reason: "permission denied" }
            : undefined,
        );
        for (const [name, exposure, defaultActive] of [
          ["verify", "direct", true],
          ["code_search", "deferred", true],
          ["symbol_search", "model-only", true],
          ["rg", "direct", false],
        ] as const) {
          pi.registerTool({
            name,
            label: name,
            description: name,
            exposure,
            defaultActive,
            parameters: Type.Object({}),
            async execute() {
              controls++;
              return { content: [{ type: "text", text: "control" }], details: {} };
            },
          });
        }
      },
    ]);
    try {
      const result =
        await value.run(`text(ALL_TOOLS.map(t=>t.name)); text(typeof models); const r = await Promise.allSettled([
      tools.fd({value:"one"}), tools.fd({value:"two"}), tools.fd({value:"blocked"})]); text(r.map(v=>v.status)); store("cursor", "page-one");`);
      assert.equal(result.isError, false);
      assert.equal(maxActive, 2);
      assert.equal(calls, 2);
      assert.equal(controls, 0);
      assert.match(output(result), /fulfilled.*fulfilled.*rejected/);
      assert.match(output(result), /undefined/);
      assert.doesNotMatch(output(result), /verify|code_search|symbol_search|"rg"|hidden-inner-output/);
      assert.deepEqual(
        result.nestedCalls?.calls.map(call => call.status),
        ["ok", "ok", "error"],
      );
      assert.equal((await value.run('text(load("cursor"));')).isError, false);
      assert.match(
        output([...value.session.messages].reverse().find(message => message.role === "toolResult")!),
        /page-one/,
      );
      value.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("fd", { value: "direct" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      await value.session.prompt("Use direct tool");
      assert.equal(calls, 3);
      const leaf = value.history.getLeafId();
      assert.ok(leaf);
      value.history.resetLeaf();
      assert.doesNotMatch(output(await value.run('text(load("cursor"));')), /page-one/);
      value.history.branch(leaf);
      const resumed = await value.open();
      assert.match(output(await value.run('text(load("cursor"));', resumed)), /page-one/);
      value.session.setActiveToolsByName(["read"]);
      assert.equal((await value.run('await tools.fd({value:"gated"});')).isError, true);
      assert.equal(calls, 3);
    } finally {
      await value.close();
    }
  },
);

test("source options are validated and cannot increase native output limits", { timeout: 30_000 }, async () => {
  const value = await fixture();
  try {
    for (const header of [
      '{"timeout_ms":0}',
      '{"timeout_ms":2147483648}',
      '{"timeout_ms":"5"}',
      '{"max_output_tokens":-1}',
      '{"max_output_tokens":1.5}',
      '{"unknown":1}',
      "[]",
      "broken",
    ]) {
      assert.equal((await value.run(`// @options: ${header}\ntext("must-not-run");`)).isError, true);
    }
    for (const [header, expectedMax] of [
      ['{"timeout_ms":200000,"max_output_tokens":9000}', 10_000],
      ['{"max_output_tokens":5}', 1_000],
    ] as const) {
      const result = await value.run(` \t// @options: ${header}\r\ntext("large".repeat(4000));`);
      assert.equal(result.isError, false);
      assert.ok(output(result).length < expectedMax);
      assert.match(output(result), /truncated output/);
      const path = (result.details as { fullOutputPath: string }).fullOutputPath;
      assert.equal((await readFile(path, "utf8")).length, 20_000);
      await rm(path);
    }
  } finally {
    await value.close();
  }
});

test(
  "caught errors cannot bypass the nested-call budget and live tool changes are rechecked",
  { timeout: 30_000 },
  async () => {
    let calls = 0;
    const value = await fixture(true, [
      echo(() => {
        calls++;
        return "ok";
      }),
    ]);
    try {
      const result = await value.run(
        'for(let i=0;i<10000;i++){try{await tools.fd({value:"count"});}catch{}} text("must-not-finish");',
      );
      assert.equal(result.isError, true);
      assert.equal(calls, 32);
      assert.doesNotMatch(output(result), /must-not-finish/);
      assert.equal(result.nestedCalls?.calls.length, 32);
    } finally {
      await value.close();
    }
    let changes = 0;
    const changing = await fixture(true, [
      pi =>
        pi.registerTool({
          name: "fd",
          label: "fd",
          description: "Change tools",
          parameters: Type.Object({ value: Type.String() }),
          async execute() {
            changes++;
            pi.setActiveTools(pi.getActiveTools().filter(name => name !== "fd"));
            return { content: [{ type: "text", text: "changed" }], details: {} };
          },
        }),
    ]);
    try {
      const result = await changing.run('await tools.fd({value:"first"}); await tools.fd({value:"second"});');
      assert.equal(result.isError, true);
      assert.equal(changes, 1);
    } finally {
      await changing.close();
    }
  },
);

test(
  "deadlines and caller abort cancel nested work and do not commit failed store writes",
  { timeout: 30_000 },
  async () => {
    let aborted = 0;
    let entered!: () => void;
    const value = await fixture(true, [
      echo(
        (_value, signal) =>
          new Promise((_resolve, reject) => {
            entered?.();
            const abort = () => {
              aborted++;
              reject(new Error("nested aborted"));
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          }),
      ),
    ]);
    try {
      await value.run('text("warm sandbox");');
      const timeout = await value.run(
        '// @options: {"timeout_ms":1000}\nstore("failed", "must-not-persist"); text("partial"); await tools.fd({value:"wait"});',
      );
      assert.equal(timeout.isError, true);
      assert.match(output(timeout), /partial/);
      assert.equal(aborted, 1);
      assert.doesNotMatch(output(await value.run('text(load("failed"));')), /must-not-persist/);
      const started = new Promise<void>(resolve => {
        entered = resolve;
      });
      const pending = value.run('await tools.fd({value:"wait"});');
      await started;
      await value.session.abort();
      await pending;
      assert.equal(aborted, 2);
      const cpu = await value.run('// @options: {"timeout_ms":500}\nwhile(true){}');
      assert.equal(cpu.isError, true);
      assert.equal((await value.run('text("recovered");')).isError, false);
    } finally {
      await value.close();
    }
  },
);

test("parallel codemode edits retain Pylon revision guards and file-mutation queues", { timeout: 30_000 }, async () => {
  const value = await fixture(true, [], true);
  try {
    await writeFile(join(value.cwd, "note.txt"), "before\n");
    const result =
      await value.run(`const read = await tools.read({path:"note.txt"}); const revision = read.match(/#([a-f0-9]+)/)[1];
      const r = await Promise.allSettled(["first", "second"].map(newText=>tools.edit({path:"note.txt", revision,
        edits:[{operation:"replace",startLine:1,endLine:1,newText}]}))); text(r.map(v=>v.status));`);
    assert.equal(result.isError, false);
    assert.match(output(result), /fulfilled.*rejected|rejected.*fulfilled/);
    assert.match(await readFile(join(value.cwd, "note.txt"), "utf8"), /^(first|second)\n$/);
  } finally {
    await value.close();
  }
});

test("numbered image reads reach Web codemode and retain their saved bytes", { timeout: 30_000 }, async () => {
  const value = await fixture(true, [], true);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  let savedPath: string | undefined;
  try {
    await writeFile(join(value.cwd, "pixel.png"), png);
    const result = await value.run('image(await tools.read({path:"pixel.png"}));');
    savedPath = output(result).match(/Image saved to (.+) \(image\/png,/)?.[1];
    assert.equal(result.isError, false, output(result));
    const image = result.content.find(block => block.type === "image");
    assert.ok(image?.type === "image");
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(Buffer.from(image.data, "base64"), png);
    assert.ok(savedPath);
    assert.deepEqual(await readFile(savedPath), png);
  } finally {
    if (savedPath) await rm(savedPath, { force: true });
    await value.close();
  }
});

test("Pylon Guard blocks dangerous nested commands before shell execution", { timeout: 30_000 }, async () => {
  const value = await fixture(true, [], false, true);
  try {
    const result = await value.run('await tools.bash({command:"echo forbidden > nul"});');
    assert.equal(result.isError, true);
    assert.match(output(result), /nul/i);
    assert.equal(result.nestedCalls?.calls[0]?.status, "error");
    await assert.rejects(readFile(join(value.cwd, "nul")), { code: "ENOENT" });
  } finally {
    await value.close();
  }
});

test(
  "disk stores survive reopen, fork and compaction without inheriting abandoned or failed writes",
  { timeout: 30_000 },
  async () => {
    const value = await fixture(true, [], false, false, true);
    try {
      await value.run('store("cursor", {page:1}); store("deleted", "old");');
      const originalPath = value.history.getSessionFile();
      const base = value.history.getLeafId();
      assert.ok(originalPath && base);
      value.session.dispose();
      const reopenedHistory = SessionManager.open(originalPath);
      const reopened = await value.open(reopenedHistory);
      assert.match(output(await value.run('text(load("cursor"));', reopened)), /"page":1/);
      await value.run('store("cursor", {page:2}); store("deleted", undefined);', reopened);
      const active = reopenedHistory.getLeafId();
      assert.ok(active);
      await value.run('store("cursor", {page:99}); store("abandoned", true);', reopened);
      reopenedHistory.branch(active);
      // Native compaction must not discard custom state earlier than the kept model context.
      reopenedHistory.appendCompaction("Compacted", null, 1000);
      for (const data of [null, {}, { set: null, delete: [] }, { set: { cursor: "poison" }, delete: [7] }]) {
        reopenedHistory.appendCustomEntry("codemode-store", data);
      }
      const compacted = await value.open(SessionManager.open(originalPath));
      assert.match(
        output(await value.run('text([load("cursor"), load("deleted"), load("abandoned")]);', compacted)),
        /\[{"page":2},null,null\]/,
      );
      await value.run('store("cursor", "failed"); throw new Error("failed write");', compacted);
      assert.equal((await value.run('store("cursor", "x".repeat(262145));', compacted)).isError, true);
      compacted.dispose();
      const afterFailure = await value.open(SessionManager.open(originalPath));
      assert.match(output(await value.run('text(load("cursor"));', afterFailure)), /"page":2/);
      const forkHistory = SessionManager.open(originalPath);
      const forkPath = forkHistory.createBranchedSession(base);
      assert.ok(forkPath);
      const fork = await value.open(SessionManager.open(forkPath));
      assert.match(
        output(await value.run('text([load("cursor"), load("deleted")]); store("cursor", {page:3});', fork)),
        /\[{"page":1},"old"\]/,
      );
      fork.dispose();
      const forkReopened = await value.open(SessionManager.open(forkPath));
      assert.match(output(await value.run('text(load("cursor"));', forkReopened)), /"page":3/);
      const parent = await value.open(SessionManager.open(originalPath));
      assert.match(output(await value.run('text(load("cursor"));', parent)), /"page":2/);
    } finally {
      await value.close();
    }
  },
);

test(
  "maximum fan-out filters large intermediate outputs and cancels cooperative work before mutation",
  { timeout: 30_000 },
  async t => {
    let active = 0,
      peak = 0,
      mutations = 0,
      aborted = 0;
    let entered!: () => void;
    const value = await fixture(true, [
      echo(async (mode, signal) => {
        active++;
        peak = Math.max(peak, active);
        try {
          if (mode === "large") return "hidden-payload".padEnd(1024 * 1024, "x");
          await new Promise<void>((resolve, reject) => {
            const finish = () => {
              signal?.removeEventListener("abort", abort);
              resolve();
            };
            const timer = setTimeout(finish, 5000);
            const abort = () => {
              clearTimeout(timer);
              aborted++;
              reject(new Error("cancelled"));
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
            if (active === 32) entered();
          });
          mutations++;
          return "mutation";
        } finally {
          active--;
        }
      }),
    ]);
    try {
      const rss = process.memoryUsage().rss;
      const start = performance.now();
      const result = await value.run(
        'text((await Promise.all(Array.from({length:32},()=>tools.fd({value:"large"})))).map(v=>v.length));',
      );
      assert.equal(result.isError, false);
      assert.equal(result.nestedCalls?.calls.length, 32);
      assert.ok(result.nestedCalls?.calls.every(call => call.status === "ok"));
      assert.doesNotMatch(output(result), /hidden-payload/);
      assert.ok(output(result).length < 2000);
      t.diagnostic(
        `32 x 1 MiB intermediate results: ${Math.round(performance.now() - start)}ms, RSS delta ${Math.round((process.memoryUsage().rss - rss) / 1024 / 1024)} MiB`,
      );
      const started = new Promise<void>(resolve => {
        entered = resolve;
      });
      const pending = value.run('await Promise.all(Array.from({length:32},()=>tools.fd({value:"wait"})));');
      await started;
      assert.equal(peak, 32);
      await value.session.abort();
      await pending;
      assert.equal(active, 0);
      assert.equal(aborted, 32);
      assert.equal(mutations, 0);
      assert.equal((await value.run('text("worker recovered");')).isError, false);
    } finally {
      await value.close();
    }
  },
);

async function mcpServer(waitForTools?: Promise<void>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = createServer(async (request, response) => {
    if (request.method === "DELETE") {
      calls.push({ method: "close", params: {} });
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    const params = message.params ?? {};
    calls.push({ method: message.method, params });
    if (message.id === undefined) {
      response.writeHead(204).end();
      return;
    }
    let result: unknown;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "fixture", version: "1" },
          instructions: "Echo fixture values",
        };
        break;
      case "tools/list":
        await waitForTools;
        result = {
          tools: ["echo", "secret"].map(name => ({
            name,
            description: `Echo fixture ${name}`,
            inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
          })),
        };
        break;
      case "tools/call":
        if (params.arguments.value === "wait") return; // Remain pending until the client's signal aborts.
        result = {
          content: [{ type: "text", text: "x".repeat(30_000) }],
          structuredContent: { value: params.arguments.value },
          isError: params.arguments.value === "error",
        };
        break;
      case "resources/list":
        result = { resources: [{ uri: "fixture://note", name: "note" }] };
        break;
      case "resources/templates/list":
        result = { resourceTemplates: [] };
        break;
      case "resources/read":
        result = { contents: [{ uri: params.uri, text: "resource body" }] };
        break;
      default:
        response.writeHead(400).end();
        return;
    }
    if (!response.destroyed)
      response
        .writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "fixture-session" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    },
  };
}

const mcpConfig = (url: string) => ({ mcpServers: { fixture: { url, toolExposure: { secret: "hidden" } } } });

test(
  "native MCP startup, structured results, resources and permission hooks work in bounded Web scripts",
  { timeout: 30_000 },
  async () => {
    const server = await mcpServer();
    const nested: string[] = [];
    const value = await fixture(
      true,
      [
        pi => {
          pi.on("tool_call", event => {
            if (!event.toolName.startsWith("mcp__")) return;
            assert.ok(event.parentToolCallId);
            nested.push(event.toolName);
            if ((event.input as { value?: string }).value === "blocked")
              return { block: true, reason: "permission denied" };
          });
        },
      ],
      true,
      false,
      false,
      async (_cwd, agentDir) => {
        await writeFile(join(agentDir, "mcp.json"), JSON.stringify(mcpConfig(server.url)));
        // The SDK's supplied agent directory must win over the process-wide Pi directory.
        const ambient = join(agentDir, "ambient");
        await mkdir(ambient);
        await writeFile(join(ambient, "mcp.json"), JSON.stringify({ mcpServers: {} }));
        process.env.PI_CODING_AGENT_DIR = ambient;
      },
    );
    try {
      const result = await value.run(`text(await searchTools("echo", {namespace:"fixture"}));
      text((await describeNamespace("fixture")).instructions);
      const result = await tools.mcp__fixture__echo({value:"large"});
      text([result.content[0].text.length, result.structuredContent.value]);
      text((await tools.mcp__fixture__echo({value:"error"})).isError);
      text(await tools.read_mcp_resource({server:"fixture", uri:"fixture://note"}));
      const denied = await Promise.allSettled([tools.mcp__fixture__echo({value:"blocked"})]); text(denied[0].status);`);
      assert.equal(result.isError, false, output(result));
      assert.match(output(result), /30000,"large"/);
      assert.match(output(result), /true/);
      assert.match(output(result), /resource body/);
      assert.match(output(result), /rejected/);
      assert.match(output(result), /Echo fixture values/);
      assert.equal(nested.length, 3);
      assert.equal(server.calls.filter(call => call.method === "tools/call").length, 2);
      assert.equal((await value.run('await tools.mcp__fixture__secret({value:"hidden"});')).isError, true);
      assert.equal(server.calls.filter(call => call.method === "tools/call").length, 2);
      await value.shutdown();
      assert.equal(
        server.calls.filter(call => call.method === "close").length,
        1,
        "runtime shutdown closes native HTTP sessions",
      );
    } finally {
      await value.close();
      await server.close();
    }
  },
);

test(
  "MCP indirect and direct calls cannot bypass gates, disabled overrides or policy changes during approval",
  { timeout: 30_000 },
  async () => {
    const server = await mcpServer();
    let api!: ExtensionAPI;
    const value = await fixture(
      true,
      [
        pi => {
          api = pi;
          pi.on("tool_call", event => {
            if (event.toolName === "mcp__fixture__echo" && (event.input as { value?: string }).value === "late")
              pi.events.emit("pylon:tool-overrides", { version: 1, overrides: { mcp__fixture__echo: "disabled" } });
          });
        },
      ],
      true,
      false,
      false,
      async (_cwd, agentDir) => {
        await writeFile(join(agentDir, "mcp.json"), JSON.stringify(mcpConfig(server.url)));
      },
    );
    try {
      assert.equal((await value.run('await tools.mcp__fixture__echo({value:"initial"});')).isError, false);
      api.events.emit("pylon:tool-policy", {
        version: 1,
        kind: "register",
        owner: "pi-test",
        managedTools: [],
        enabledTools: [],
        allowOnly: ["codemode", "read"],
      });
      assert.equal((await value.run('await tools.mcp__fixture__echo({value:"gated"});')).isError, true);
      // Simulate a native extension activating a tool after the gate was reconciled.
      api.setActiveTools([...api.getActiveTools(), "mcp__fixture__echo"]);
      value.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("mcp__fixture__echo", { value: "direct bypass" })], {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      await value.session.prompt("Try direct call");
      const denied = [...value.session.messages]
        .reverse()
        .find(message => message.role === "toolResult" && message.toolName === "mcp__fixture__echo");
      assert.ok(denied?.role === "toolResult");
      assert.match(output(denied), /disabled by Pylon policy/);
      assert.equal(server.calls.filter(call => call.method === "tools/call").length, 1);
      api.events.emit("pylon:tool-policy", { version: 1, kind: "unregister", owner: "pi-test" });
      assert.equal((await value.run('await tools.mcp__fixture__echo({value:"late"});')).isError, true);
      assert.equal((await value.run('await tools.mcp__fixture__echo({value:"disabled"});')).isError, true);
      api.events.emit("pylon:tool-overrides", { version: 1, overrides: { mcp__fixture__echo: "deferred" } });
      assert.equal((await value.run('await tools.mcp__fixture__echo({value:"restored"});')).isError, false);
      assert.equal(server.calls.filter(call => call.method === "tools/call").length, 2);
    } finally {
      await value.close();
      await server.close();
    }
  },
);

test(
  "project MCP requires trust, and native deferred discovery works without enabling Web codemode",
  { timeout: 30_000 },
  async () => {
    const server = await mcpServer();
    const value = await fixture(false, [], true, false, false, async cwd => {
      await mkdir(join(cwd, ".pi"));
      await writeFile(
        join(cwd, ".pi", "mcp.json"),
        JSON.stringify({ mcpServers: { fixture: { url: server.url, exposure: "deferred" } } }),
      );
    });
    const call = async (session = value.session) => {
      value.faux.setResponses([
        fauxAssistantMessage([fauxToolCall("tool_search", { query: "fixture echo" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("mcp__fixture__echo", { value: "trusted" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      await session.prompt("Search then use MCP");
    };
    try {
      await call();
      assert.equal(server.calls.length, 0);
      await value.shutdown();
      new ProjectTrustStore(value.agentDir).set(value.cwd, true);
      const trusted = await value.open();
      await call(trusted);
      assert.equal(server.calls.filter(call => call.method === "tools/call").length, 1);
      assert.equal(
        (await value.run('await tools.mcp__fixture__echo({value:"codemode disabled"});', trusted)).isError,
        true,
      );
      assert.equal(server.calls.filter(call => call.method === "tools/call").length, 1);
    } finally {
      await value.close();
      await server.close();
    }
  },
);

test(
  "MCP readiness respects a lower script deadline and does not dispatch calls after timeout",
  { timeout: 30_000 },
  async () => {
    let release!: () => void;
    const server = await mcpServer(
      new Promise<void>(resolve => {
        release = resolve;
      }),
    );
    const value = await fixture(true, [], false, false, false, async (_cwd, agentDir) => {
      await writeFile(join(agentDir, "mcp.json"), JSON.stringify(mcpConfig(server.url)));
    });
    try {
      const result = await value.run(
        '// @options: {"timeout_ms":100}\nawait tools.mcp__fixture__echo({value:"must-not-run"});',
      );
      assert.equal(result.isError, true);
      assert.match(output(result), /MCP connection wait timed out/);
      release();
      assert.equal(server.calls.filter(call => call.method === "tools/call").length, 0);
      assert.equal((await value.run('await tools.mcp__fixture__echo({value:"recovered"});')).isError, false);
      assert.equal(server.calls.filter(call => call.method === "tools/call").length, 1);
      const stalled = await value.run(
        '// @options: {"timeout_ms":500}\nawait tools.mcp__fixture__echo({value:"wait"});',
      );
      assert.equal(stalled.isError, true);
      assert.equal(stalled.nestedCalls?.calls[0]?.status, "error");
      assert.equal((await value.run('await tools.mcp__fixture__echo({value:"after abort"});')).isError, false);
    } finally {
      release();
      await value.close();
      await server.close();
    }
  },
);

test(
  "native stdio MCP uses the session cwd and environment and stops its child on shutdown",
  { timeout: 30_000 },
  async () => {
    const script = `require('node:readline').createInterface({input:process.stdin}).on('line', line => {
    const m = JSON.parse(line); if (m.id === undefined) return;
    const result = m.method === 'initialize'
      ? {protocolVersion:m.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'stdio',version:'1'}}
      : m.method === 'tools/list'
      ? {tools:[{name:'inspect',description:'Inspect fixture process',inputSchema:{type:'object',properties:{}}}]}
      : {content:[{type:'text',text:JSON.stringify({pid:process.pid,cwd:process.cwd(),value:process.env.FIXTURE_VALUE})}]};
    console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
  }).on('close',()=>process.exit(0));`;
    const value = await fixture(true, [], false, false, false, async (_cwd, agentDir) => {
      await writeFile(
        join(agentDir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            stdio: {
              command: process.execPath,
              args: ["-e", script],
              cwd: ".",
              env: { FIXTURE_VALUE: "pylon-mcp-test" },
            },
          },
        }),
      );
    });
    try {
      const result = await value.run("text((await tools.mcp__stdio__inspect({})).content[0].text);");
      assert.equal(result.isError, false, output(result));
      const info = JSON.parse(
        output(result)
          .split("\n")
          .find(line => line.startsWith('{"pid"'))!,
      );
      assert.equal(info.cwd, value.cwd);
      assert.equal(info.value, "pylon-mcp-test");
      process.kill(info.pid, 0);
      await value.shutdown();
      assert.throws(() => process.kill(info.pid, 0), { code: "ESRCH" });
    } finally {
      await value.close();
    }
  },
);

test(
  "native MCP yields to an alternate adapter, and Guard prevents UI-less server dispatch",
  { timeout: 30_000 },
  async () => {
    const server = await mcpServer();
    const setup = async (_cwd: string, agentDir: string) => {
      await writeFile(join(agentDir, "mcp.json"), JSON.stringify(mcpConfig(server.url)));
    };
    let statuses = 0;
    const adapter = await fixture(
      true,
      [
        pi => {
          pi.registerCommand("mcp", {
            description: "Fixture adapter",
            handler: async () => {
              statuses++;
            },
          });
        },
      ],
      false,
      false,
      false,
      setup,
    );
    try {
      await adapter.session.prompt("/mcp");
      assert.equal(statuses, 1);
      assert.equal((await adapter.run('await tools.mcp__fixture__echo({value:"adapter"});')).isError, true);
      assert.equal(server.calls.length, 0, "replaced native MCP never connects");
    } finally {
      await adapter.close();
    }
    const guarded = await fixture(true, [], true, true, false, setup);
    try {
      const result = await guarded.run('await tools.mcp__fixture__echo({value:"headless"});');
      assert.equal(result.isError, true);
      assert.match(output(result), /interactive approval required/);
      assert.equal(server.calls.filter(call => call.method === "tools/call").length, 0);
    } finally {
      await guarded.close();
      await server.close();
    }
  },
);
