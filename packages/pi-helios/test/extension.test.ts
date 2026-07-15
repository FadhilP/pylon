import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import helios from "../extensions/pi-helios.ts";
import webScoutBrowser from "../extensions/web-scout-browser.ts";
import { captureWindow, findWindow, loopbackUrl } from "../src/capture.ts";
import { consumeWebScoutGrant, issueWebScoutGrant, WEB_SCOUT_GRANT_ENV } from "../src/web-scout-grant.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const WINDOW = { handle: 42, processId: 7, title: "Visual Studio Code" };

function runtime(pi: Record<string, unknown> = {}) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const eventHandlers = new Map<string, Function[]>();
  helios({
    events: {
      on(name: string, handler: Function) {
        eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
        return () => eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((item) => item !== handler));
      },
      emit(name: string, value: unknown) { for (const handler of eventHandlers.get(name) ?? []) handler(value); },
    },
    ...pi,
    registerTool(value: any) { tools.set(value.name, value); },
    registerCommand(name: string, value: any) { commands.set(name, value); },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as any);
  return { tools, commands, handlers, eventHandlers };
}

async function temporaryCaptures() {
  return (await readdir(tmpdir())).filter((name) => /^pi-helios-[A-Za-z0-9]{6}$/.test(name)).sort();
}

function successfulLookup() {
  return { code: 0, stdout: JSON.stringify({ Handle: WINDOW.handle, ProcessId: WINDOW.processId, Title: WINDOW.title }), stderr: "", killed: false };
}

function nativeSource(args: string[]): string {
  const encodedScript = args[args.indexOf("-EncodedCommand") + 1];
  const script = Buffer.from(encodedScript, "base64").toString("utf16le");
  const encodedSource = script.match(/FromBase64String\('([^']+)'\)/)?.[1];
  assert.ok(encodedSource);
  return Buffer.from(encodedSource, "base64").toString("utf8");
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    cwd: process.cwd(), hasUI: true, model: { input: ["text", "image"] },
    sessionManager: { getSessionId: () => "test-session" },
    ui: { async confirm() { return true; }, notify() {} },
    ...overrides,
  };
}

test("registers native capture and constrained browser tools", () => {
  const { tools } = runtime();
  assert.deepEqual([...tools.keys()].sort(), ["helios_browser", "helios_capture"]);
  assert.match(tools.get("helios_capture").description, /Windows window/);
  assert.doesNotMatch(tools.get("helios_capture").description, /browser viewport/);
});

test("visibility command changes future owned launches only", async () => {
  let openArgs: string[] = [];
  let confirmation = "";
  let notification = "";
  const { tools, commands } = runtime({ exec: async (_command: string, args: string[]) => {
    const cliCommand = args.find((arg) => ["open", "tab-list"].includes(arg));
    if (cliCommand === "open") openArgs = args;
    if (cliCommand === "tab-list") return { code: 0, stdout: JSON.stringify({ result: "- 0: (current) [](about:blank)" }), stderr: "", killed: false };
    return { code: 0, stdout: "{}", stderr: "", killed: false };
  } });
  const ctx = context({ ui: {
    async confirm(_title: string, message: string) { confirmation = message; return true; },
    notify(message: string) { notification = message; },
  } });
  await commands.get("helios-visibility").handler("hide", ctx);
  assert.match(notification, /hidden \(headless\)/);
  await tools.get("helios_browser").execute("id", { action: "start" }, undefined, undefined, ctx);
  assert.match(confirmation, /headless isolated browser/);
  assert.match(confirmation, /cannot be visually supervised/);
  assert.ok(!openArgs.includes("--headed"));
  await commands.get("helios-visibility").handler("show", ctx);
  assert.match(notification, /Active owned session unchanged/);
});

test("doctor checks pinned CLI without launching a browser", async () => {
  const calls: string[][] = [];
  const { commands } = runtime({ exec: async (_command: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: "playwright-cli 0.1.17\n", stderr: "", killed: false };
  } });
  let notification = "";
  await commands.get("helios-doctor").handler("", context({ ui: { notify(message: string) { notification = message; } } }));
  assert.match(notification, /CLI ready/);
  assert.ok(calls[0].includes("--version"));
  assert.ok(!calls[0].includes("open"));
});

test("health diagnostics share cached work while doctor stays fresh", async () => {
  let calls = 0;
  const { commands, eventHandlers } = runtime({ exec: async () => {
    calls++;
    return { code: 0, stdout: "playwright-cli 0.1.17\n", stderr: "", killed: false };
  } });
  const health = eventHandlers.get("pi-conductor:health-request")![0];
  const responses: Promise<unknown>[] = [];
  const request = { version: 1, respond(value: Promise<unknown>) { responses.push(value); } };
  health(request);
  health(request);
  await Promise.all(responses);
  assert.equal(calls, 1);
  await commands.get("helios-doctor").handler("", context());
  assert.equal(calls, 2);
});

test("Helios advertises one-use Web Scout child capability", async () => {
  const { eventHandlers } = runtime();
  const capabilities: any[] = [];
  for (const handler of eventHandlers.get("pi-helios:web-scout-capability") ?? []) {
    handler({ version: 1, respond(value: unknown) { capabilities.push(value); } });
  }
  assert.equal(capabilities.length, 1);
  assert.match(capabilities[0].childExtensionPath, /web-scout-browser\.ts$/);
  const issued = await capabilities[0].issueGrant({ maxPages: 2, maxActions: 4, headed: true });
  await issued.revoke();
});

test("Web Scout child extension requires and consumes issued grant", async () => {
  const issued = await issueWebScoutGrant({ maxPages: 2, maxActions: 4, headed: false });
  process.env[WEB_SCOUT_GRANT_ENV] = issued.value;
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  await webScoutBrowser({
    exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
    registerTool(value: any) { tools.set(value.name, value); },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as any);
  assert.deepEqual([...tools.keys()], ["scout_browser"]);
  assert.equal(process.env[WEB_SCOUT_GRANT_ENV], undefined);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  await assert.rejects(webScoutBrowser({} as any), /grant is missing/);
});

test("Web Scout reuses navigation snapshots without extra snapshot subprocesses", async () => {
  const issued = await issueWebScoutGrant({ maxPages: 3, maxActions: 4, headed: false });
  process.env[WEB_SCOUT_GRANT_ENV] = issued.value;
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const commands: string[] = [];
  await webScoutBrowser({
    exec: async (_command: string, args: string[]) => {
      const action = args.find((value) => ["open", "goto", "eval", "snapshot", "tab-list", "close"].includes(value)) ?? "unknown";
      commands.push(action);
      if (action === "tab-list") return { code: 0, stdout: JSON.stringify({ result: "- 0: (current) [Example](https://1.1.1.1/)" }), stderr: "", killed: false };
      if (action === "eval") return { code: 0, stdout: JSON.stringify({ result: "https://1.1.1.1/next" }), stderr: "", killed: false };
      if (action === "goto") return { code: 0, stdout: JSON.stringify({ snapshot: "- link Next [ref=e1]" }), stderr: "", killed: false };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
    registerTool(value: any) { tools.set(value.name, value); },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as any);
  const browser = tools.get("scout_browser");
  const navigated = await browser.execute("navigate", { action: "navigate", url: "https://1.1.1.1" });
  assert.match(navigated.content[0].text, /ref=e1/);
  assert.deepEqual(commands, ["open", "tab-list", "goto", "tab-list"]);
  await browser.execute("follow", { action: "follow", target: "e1" });
  assert.deepEqual(commands.slice(4), ["eval", "goto", "tab-list"]);
  assert.equal(commands.includes("snapshot"), false);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
});

test("Web Scout child cleans proxy after browser start failure", async () => {
  const issued = await issueWebScoutGrant({ maxPages: 2, maxActions: 4, headed: false });
  process.env[WEB_SCOUT_GRANT_ENV] = issued.value;
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  await webScoutBrowser({
    exec: async (_command: string, args: string[]) => {
      const action = args.find((value) => ["open", "close", "list", "tab-list"].includes(value));
      if (action === "open") return { code: 1, stdout: "", stderr: "failed", killed: false };
      return { code: 0, stdout: action === "list" ? JSON.stringify({ browsers: [] }) : "{}", stderr: "", killed: false };
    },
    registerTool(value: any) { tools.set(value.name, value); },
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as any);
  await assert.rejects(tools.get("scout_browser").execute("id", { action: "navigate", url: "https://example.com" }), /command failed/i);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
});

test("crafted Web Scout grant path cannot delete attacker-selected directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-grant-victim-"));
  const path = join(directory, "grant.json");
  await writeFile(path, JSON.stringify({ version: 1, token: "token", expiresAt: Date.now() + 60_000, maxPages: 1, maxActions: 1, headed: false }));
  const encoded = Buffer.from(JSON.stringify({ path, token: "token" })).toString("base64url");
  try {
    await assert.rejects(consumeWebScoutGrant(encoded), /path is invalid/);
    assert.match(await readFile(path, "utf8"), /"token"/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("window capture consent names resolved title", async () => {
  const { tools } = runtime({ exec: async () => successfulLookup() });
  let confirmation = "";
  const result = await tools.get("helios_capture").execute("id", { target: "window", title: "Code" }, undefined, undefined, context({
    ui: { async confirm(_title: string, message: string) { confirmation = message; return false; } },
  }));
  assert.match(confirmation, /Visual Studio Code/);
  assert.equal(result.details.declined, true);
});

test("browser start refuses no UI and decline invokes no CLI", async () => {
  let calls = 0;
  const { tools } = runtime({ exec: async () => { calls++; return successfulLookup(); } });
  const browser = tools.get("helios_browser");
  await assert.rejects(browser.execute("id", { action: "start" }, undefined, undefined, context({ hasUI: false })), /interactive confirmation/);
  const declined = await browser.execute("id", { action: "start", browser: "chrome" }, undefined, undefined, context({ ui: { async confirm() { return false; } } }));
  assert.equal(declined.details.declined, true);
  assert.equal(calls, 0);
});

test("attached endpoint validation happens before consent and remains loopback", async () => {
  const { tools } = runtime({ exec: async () => successfulLookup() });
  await assert.rejects(tools.get("helios_browser").execute("id", {
    action: "attach", attachMode: "cdp", endpoint: "http://example.com:9222",
  }, undefined, undefined, context()), /loopback/);
  assert.equal(loopbackUrl("http://[::1]:9222", ["http:"]).port, "9222");
});

test("owned browser screenshot uses Playwright CLI, attaches image, and cleans artifacts", async () => {
  const commands: string[] = [];
  const before = await temporaryCaptures();
  const { tools, handlers } = runtime({ exec: async (_command: string, args: string[]) => {
    const cliCommand = args.find((arg) => ["open", "list", "tab-list", "screenshot", "close"].includes(arg));
    commands.push(cliCommand ?? "unknown");
    const session = args.find((arg) => arg.startsWith("-s="))?.slice(3);
    if (cliCommand === "list") return { code: 0, stdout: JSON.stringify({ browsers: [{ name: session, status: "open" }] }), stderr: "", killed: false };
    if (cliCommand === "tab-list") return { code: 0, stdout: JSON.stringify({ result: "- 0: (current) [Example](https://example.com/)" }), stderr: "", killed: false };
    if (cliCommand === "screenshot") {
      const path = args.find((arg) => arg.startsWith("--filename="))!.slice("--filename=".length);
      await writeFile(path, PNG);
    }
    return { code: 0, stdout: "{}", stderr: "", killed: false };
  } });
  const statuses: Array<string | undefined> = [];
  const ctx = context({ ui: {
    async confirm() { return true; },
    notify() {},
    setStatus(_key: string, value: string | undefined) { statuses.push(value); },
  } });
  const browser = tools.get("helios_browser");
  await browser.execute("start", { action: "start", url: "https://example.com" }, undefined, undefined, ctx);
  const result = await browser.execute("shot", { action: "screenshot" }, undefined, undefined, ctx);
  assert.ok(result.content.some((item: any) => item.type === "image" && item.data.length > 0));
  assert.ok(commands.includes("screenshot"));
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "quit" }, ctx);
  assert.ok(commands.includes("close"));
  assert.ok(statuses.includes("browser: start"));
  assert.ok(statuses.includes("browser: screenshot"));
  assert.equal(statuses.at(-1), undefined);
  assert.deepEqual(await temporaryCaptures(), before);
});

test("window lookup and PrintWindow regression guarantees remain", async () => {
  await assert.rejects(findWindow(async () => successfulLookup(), "Code", undefined, "linux"), /Windows only/);
  const target = await findWindow(async (command, args) => {
    assert.equal(command, "powershell.exe");
    assert.match(nativeSource(args), /StringComparison\.OrdinalIgnoreCase/);
    return successfulLookup();
  }, "Code", undefined, "win32");
  assert.deepEqual(target, WINDOW);

  const directory = await mkdtemp(join(tmpdir(), "helios-test-"));
  const output = join(directory, "capture.png");
  try {
    await captureWindow(async (_command, args) => {
      const source = nativeSource(args);
      assert.match(source, /PrintWindow/);
      assert.doesNotMatch(source, /CopyFromScreen|VirtualScreen/);
      await writeFile(output, PNG);
      return { code: 0, stdout: "", stderr: "", killed: false };
    }, WINDOW, output, undefined, "win32");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
