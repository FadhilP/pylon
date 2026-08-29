import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import helios from "../extensions/pi-helios.ts";
import webScoutBrowser from "../extensions/web-scout-browser.ts";
import { captureWindow, findWindow, loopbackUrl } from "../src/capture.ts";
import {
  consumeWebScoutGrant,
  issueWebScoutGrant,
  WEB_SCOUT_GRANT_ENV,
} from "../src/web-scout-grant.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const WINDOW = { handle: 42, processId: 7, title: "Visual Studio Code" };
const SETTINGS_PATH = join(tmpdir(), `pi-helios-test-${process.pid}.json`);
after(() => rm(SETTINGS_PATH, { force: true }));

function runtime(pi: Record<string, unknown> = {}, configPath = SETTINGS_PATH) {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const eventHandlers = new Map<string, Function[]>();
  helios(
    {
      events: {
        on(name: string, handler: Function) {
          eventHandlers.set(name, [
            ...(eventHandlers.get(name) ?? []),
            handler,
          ]);
          return () =>
            eventHandlers.set(
              name,
              (eventHandlers.get(name) ?? []).filter(
                (item) => item !== handler,
              ),
            );
        },
        emit(name: string, value: unknown) {
          for (const handler of eventHandlers.get(name) ?? []) handler(value);
        },
      },
      ...pi,
      registerTool(value: any) {
        tools.set(value.name, value);
      },
      registerCommand(name: string, value: any) {
        commands.set(name, value);
      },
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as any,
    { configPath, persistentClient: false },
  );
  return { tools, commands, handlers, eventHandlers };
}

async function temporaryCaptures() {
  return (await readdir(tmpdir()))
    .filter((name) => /^pi-helios-[A-Za-z0-9]{6}$/.test(name))
    .sort();
}

function successfulLookup() {
  return {
    code: 0,
    stdout: JSON.stringify({
      Handle: WINDOW.handle,
      ProcessId: WINDOW.processId,
      Title: WINDOW.title,
    }),
    stderr: "",
    killed: false,
  };
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
    cwd: process.cwd(),
    hasUI: true,
    model: { input: ["text", "image"] },
    sessionManager: { getSessionId: () => "test-session" },
    ui: {
      async confirm() {
        return true;
      },
      notify() {},
    },
    ...overrides,
  };
}

test("Android start and attachment require visible consent before SDK or Appium access", async () => {
  let executions = 0;
  const { tools } = runtime({
    exec: async () => {
      executions++;
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
  });
  const declined = await tools.get("helios_android").execute(
    "android-start",
    {
      action: "start",
      avd: "Pixel_Test",
      appPackage: "com.example.app",
    },
    undefined,
    undefined,
    context({
      ui: {
        async confirm() {
          return false;
        },
        notify() {},
      },
    }),
  );
  assert.equal(declined.details.declined, true);
  assert.equal(executions, 0);
  const declinedPackages = await tools.get("helios_android").execute(
    "android-packages",
    {
      action: "packages",
      serial: "emulator-5554",
    },
    undefined,
    undefined,
    context({
      ui: {
        async confirm() {
          return false;
        },
        notify() {},
      },
    }),
  );
  assert.equal(declinedPackages.details.declined, true);
  assert.equal(executions, 0);
  await assert.rejects(
    tools.get("helios_android").execute(
      "android-packages-no-ui",
      {
        action: "packages",
        serial: "emulator-5554",
      },
      undefined,
      undefined,
      context({ hasUI: false }),
    ),
    /requires interactive confirmation/,
  );
  assert.equal(executions, 0);
  await assert.rejects(
    tools.get("helios_android").execute(
      "android-attach",
      {
        action: "attach",
        serial: "emulator-5554",
        appPackage: "com.example.app",
      },
      undefined,
      undefined,
      context({ hasUI: false }),
    ),
    /require interactive confirmation/,
  );
  assert.equal(executions, 0);
});

test("Android tool rejects cross-action fields and unsupported screenshots before backend access", async () => {
  let confirmations = 0;
  const { tools } = runtime();
  const ctx = context({
    ui: {
      async confirm() {
        confirmations++;
        return true;
      },
      notify() {},
    },
  });
  await assert.rejects(
    tools.get("helios_android").execute(
      "invalid-start",
      {
        action: "start",
        avd: "Pixel_Test",
        serial: "emulator-5554",
        appPackage: "com.example.app",
      },
      undefined,
      undefined,
      ctx,
    ),
    /does not accept serial/,
  );
  await assert.rejects(
    tools.get("helios_android").execute(
      "invalid-attach",
      {
        action: "attach",
        serial: "emulator-5554",
        appPackage: "com.example.app",
        headless: true,
      },
      undefined,
      undefined,
      ctx,
    ),
    /does not accept headless/,
  );
  await assert.rejects(
    tools.get("helios_android").execute(
      "missing-package",
      {
        action: "start",
        avd: "Pixel_Test",
      },
      undefined,
      undefined,
      ctx,
    ),
    /requires appPackage/,
  );
  await assert.rejects(
    tools.get("helios_android").execute(
      "invalid-packages",
      {
        action: "packages",
        serial: "emulator-5554",
        appPackage: "com.example.app",
      },
      undefined,
      undefined,
      ctx,
    ),
    /does not accept appPackage/,
  );
  await assert.rejects(
    tools.get("helios_android").execute(
      "invalid-package-serial",
      {
        action: "packages",
        serial: "emulator-5555",
      },
      undefined,
      undefined,
      ctx,
    ),
    /even console port/,
  );
  await assert.rejects(
    tools.get("helios_android").execute(
      "invalid-find",
      {
        action: "find",
        text: "Next",
        avd: "Pixel_Test",
      },
      undefined,
      undefined,
      ctx,
    ),
    /does not accept avd/,
  );
  await assert.rejects(
    tools.get("helios_android").execute(
      "text-screenshot",
      {
        action: "screenshot",
      },
      undefined,
      undefined,
      context({ model: { input: ["text"] } }),
    ),
    /does not support image/,
  );
  assert.equal(confirmations, 0);
});

test("owned launches default to headless when visibility is not configured", async () => {
  let openArgs: string[] = [];
  const { tools, handlers } = runtime(
    {
      exec: async (_command: string, args: string[]) => {
        const cliCommand = args.find((arg) =>
          ["open", "tab-list", "close"].includes(arg),
        );
        if (cliCommand === "open") openArgs = args;
        if (cliCommand === "tab-list")
          return {
            code: 0,
            stdout: JSON.stringify({
              result: "- 0: (current) [](about:blank)",
            }),
            stderr: "",
            killed: false,
          };
        return { code: 0, stdout: "{}", stderr: "", killed: false };
      },
    },
    `${SETTINGS_PATH}.missing`,
  );
  const ctx = context();
  await handlers.get("session_start")![0]({}, ctx);
  await tools
    .get("helios_browser")
    .execute("start", { action: "start" }, undefined, undefined, ctx);
  assert.ok(!openArgs.includes("--headed"));
  await tools
    .get("helios_browser")
    .execute("close", { action: "close" }, undefined, undefined, ctx);
});

test("visibility command changes future owned launches only", async () => {
  let openArgs: string[] = [];
  let notification = "";
  const { tools, commands } = runtime({
    exec: async (_command: string, args: string[]) => {
      const cliCommand = args.find((arg) => ["open", "tab-list"].includes(arg));
      if (cliCommand === "open") openArgs = args;
      if (cliCommand === "tab-list")
        return {
          code: 0,
          stdout: JSON.stringify({ result: "- 0: (current) [](about:blank)" }),
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const ctx = context({
    ui: {
      async confirm() {
        throw new Error("owned launch must not request confirmation");
      },
      notify(message: string) {
        notification = message;
      },
    },
  });
  await commands.get("helios-visibility").handler("hide", ctx);
  assert.match(notification, /hidden \(headless\)/);
  await tools
    .get("helios_browser")
    .execute("id", { action: "start" }, undefined, undefined, ctx);
  assert.ok(!openArgs.includes("--headed"));
  await commands.get("helios-visibility").handler("show", ctx);
  assert.match(notification, /Active owned session unchanged/);
});

test("embedded browser bridge launches headless, returns an ephemeral frame, and closes", async () => {
  const commands: string[] = [];
  const { eventHandlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      const action =
        args.find((arg) =>
          ["open", "resize", "tab-list", "screenshot", "close"].includes(arg),
        ) ?? "unknown";
      commands.push(action);
      if (action === "tab-list")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "- 0: (current) [Example](https://example.com/)",
          }),
          stderr: "",
          killed: false,
        };
      if (action === "screenshot") {
        const filename = args
          .find((arg) => arg.startsWith("--filename="))!
          .slice("--filename=".length);
        await writeFile(filename, PNG);
      }
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const call = async (input: Record<string, unknown>) => {
    let claimed = false;
    let response: Promise<any> | undefined;
    const request = {
      version: 1,
      sessionId: "embedded-session",
      owner: "web:tab-one",
      ...input,
      claim() {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      respond(value: Promise<unknown>) {
        response = Promise.resolve(value);
      },
    };
    const handler = eventHandlers.get("pylon:helios-browser-request")![0];
    handler(request);
    handler(request);
    assert.ok(response);
    return response;
  };
  const started = await call({
    action: "start",
    url: "https://example.com",
    width: 900,
    height: 650,
  });
  assert.equal(started.controlled, true);
  assert.equal(commands.filter((command) => command === "open").length, 1);
  const tabListsBeforeFrame = commands.filter(
    (command) => command === "tab-list",
  ).length;
  const frame = await call({ action: "frame" });
  assert.equal(
    commands.filter((command) => command === "tab-list").length,
    tabListsBeforeFrame,
  );
  assert.equal(frame.frame.mimeType, "image/png");
  assert.equal(Buffer.from(frame.frame.data, "base64").equals(PNG), true);
  await call({ action: "close" });
  assert.ok(commands.includes("resize"));
  assert.ok(commands.includes("screenshot"));
  assert.ok(commands.includes("close"));
});

test("embedded panel passively mirrors an agent-owned browser without taking control", async () => {
  const commands: string[] = [];
  const { tools, eventHandlers } = runtime(
    {
      exec: async (_command: string, args: string[]) => {
        const action =
          args.find((arg) =>
            ["open", "goto", "tab-list", "screenshot", "close"].includes(arg),
          ) ?? "unknown";
        commands.push(action);
        if (action === "tab-list")
          return {
            code: 0,
            stdout: JSON.stringify({
              result: "- 0: (current) [Example](https://example.com/)",
            }),
            stderr: "",
            killed: false,
          };
        if (action === "screenshot") {
          const filename = args
            .find((arg) => arg.startsWith("--filename="))!
            .slice("--filename=".length);
          await writeFile(filename, PNG);
        }
        return { code: 0, stdout: "{}", stderr: "", killed: false };
      },
    },
    `${SETTINGS_PATH}.passive`,
  );
  const ctx = context();
  await tools
    .get("helios_browser")
    .execute(
      "start",
      { action: "start", url: "https://example.com" },
      undefined,
      undefined,
      ctx,
    );

  const call = async (action: string) => {
    let response: Promise<any> | undefined;
    eventHandlers.get("pylon:helios-browser-request")![0]({
      version: 1,
      sessionId: "test-session",
      owner: "web:tab-one",
      action,
      claim: () => true,
      respond(value: Promise<unknown>) {
        response = Promise.resolve(value);
      },
    });
    assert.ok(response);
    return response;
  };
  assert.equal((await call("status")).controlled, false);
  const frame = await call("frame");
  assert.equal(frame.controlled, false);
  assert.equal(Buffer.from(frame.frame.data, "base64").equals(PNG), true);
  await tools
    .get("helios_browser")
    .execute(
      "navigate",
      { action: "navigate", url: "https://example.com/next" },
      undefined,
      undefined,
      ctx,
    );
  assert.ok(commands.includes("goto"));
  await tools
    .get("helios_browser")
    .execute("close", { action: "close" }, undefined, undefined, ctx);
});

test("doctor checks pinned CLI without launching a browser", async () => {
  const calls: string[][] = [];
  const { commands } = runtime({
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      return {
        code: 0,
        stdout: "playwright-cli 0.1.17\n",
        stderr: "",
        killed: false,
      };
    },
  });
  let notification = "";
  await commands.get("helios-doctor").handler(
    "",
    context({
      ui: {
        notify(message: string) {
          notification = message;
        },
      },
    }),
  );
  assert.match(notification, /CLI ready/);
  assert.ok(calls[0].includes("--version"));
  assert.ok(!calls[0].includes("open"));
});

test("health diagnostics share cached work while doctor stays fresh", async () => {
  let calls = 0;
  const { commands, eventHandlers } = runtime({
    exec: async () => {
      calls++;
      return {
        code: 0,
        stdout: "playwright-cli 0.1.17\n",
        stderr: "",
        killed: false,
      };
    },
  });
  const health = eventHandlers.get("pylon:health-request")![0];
  const responses: Promise<any>[] = [];
  const request = {
    version: 1,
    respond(value: Promise<unknown>) {
      responses.push(value);
    },
  };
  health(request);
  health(request);
  const values = await Promise.all(responses);
  assert.ok(
    values.every((value) =>
      value.lines.some((line: string) => line.startsWith("Android sessions:")),
    ),
  );
  assert.equal(calls, 1);
  await commands.get("helios-doctor").handler("", context());
  assert.equal(calls, 2);
});

test("Helios exposes fixed Android tooling status through the runtime bridge", async () => {
  const { eventHandlers } = runtime();
  const handler = eventHandlers.get("pylon:helios-android-tooling-request")![0];
  let claimed = false;
  let response: Promise<any> | undefined;
  handler({
    version: 1,
    action: "status",
    claim() {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    respond(value: Promise<unknown>) {
      response = value;
    },
  });
  assert.ok(response);
  const result = await response;
  assert.ok(["missing", "ready", "invalid", "busy"].includes(result.state));
  assert.equal(typeof result.appiumVersion, "string");
  let invalidClaimed = false;
  handler({
    version: 1,
    action: "arbitrary",
    claim() {
      invalidClaimed = true;
      return true;
    },
    respond() {},
  });
  assert.equal(invalidClaimed, false);
});

test("Web Scout child extension requires and consumes issued grant", async () => {
  const issued = await issueWebScoutGrant({
    maxPages: 2,
    maxActions: 4,
    headed: false,
  });
  process.env[WEB_SCOUT_GRANT_ENV] = issued.value;
  const handlers = new Map<string, Function[]>();
  await webScoutBrowser(
    {
      exec: async () => ({ code: 0, stdout: "{}", stderr: "", killed: false }),
      registerTool() {},
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as any,
    { persistentClient: false },
  );
  assert.equal(process.env[WEB_SCOUT_GRANT_ENV], undefined);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  await assert.rejects(
    webScoutBrowser({} as any, { persistentClient: false }),
    /grant is missing/,
  );
});

test("Web Scout reuses navigation snapshots without extra snapshot subprocesses", async () => {
  const issued = await issueWebScoutGrant({
    maxPages: 3,
    maxActions: 4,
    headed: false,
  });
  process.env[WEB_SCOUT_GRANT_ENV] = issued.value;
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const commands: string[] = [];
  await webScoutBrowser(
    {
      exec: async (_command: string, args: string[]) => {
        const action =
          args.find((value) =>
            ["open", "goto", "eval", "snapshot", "tab-list", "close"].includes(
              value,
            ),
          ) ?? "unknown";
        commands.push(action);
        if (action === "tab-list")
          return {
            code: 0,
            stdout: JSON.stringify({
              result: "- 0: (current) [Example](https://1.1.1.1/)",
            }),
            stderr: "",
            killed: false,
          };
        if (action === "eval")
          return {
            code: 0,
            stdout: JSON.stringify({ result: "https://1.1.1.1/next" }),
            stderr: "",
            killed: false,
          };
        if (action === "goto")
          return {
            code: 0,
            stdout: JSON.stringify({
              snapshot: [
                "- text: link [ref=f1e999]",
                ...Array.from(
                  { length: 105 },
                  (_, index) => `- link Item ${index} [ref=f1e${index + 1}]`,
                ),
              ].join("\n"),
            }),
            stderr: "",
            killed: false,
          };
        return { code: 0, stdout: "{}", stderr: "", killed: false };
      },
      registerTool(value: any) {
        tools.set(value.name, value);
      },
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as any,
    { persistentClient: false },
  );
  const browser = tools.get("scout_browser");
  const navigated = await browser.execute("navigate", {
    action: "navigate",
    url: "https://1.1.1.1",
  });
  assert.match(navigated.content[0].text, /ref=f1e1/);
  assert.deepEqual(commands, ["open", "tab-list", "goto", "tab-list"]);
  await assert.rejects(
    browser.execute("follow-spoof", { action: "follow", target: "f1e999" }),
    /link reference/,
  );
  const followed = await browser.execute("follow", {
    action: "follow",
    target: "f1e1",
  });
  assert.deepEqual(commands.slice(4), ["eval", "goto", "tab-list"]);
  const beforeContinue = commands.length;
  const continued = await browser.execute("continue", {
    action: "continue",
    cursor: followed.details.continuation,
  });
  assert.equal(commands.length, beforeContinue);
  assert.match(continued.content[0].text, /ref=f1e105/);
  assert.equal(commands.includes("snapshot"), false);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
});

test("Web Scout falls back to bounded redacted text for raw public documents", async () => {
  const issued = await issueWebScoutGrant({
    maxPages: 1,
    maxActions: 3,
    headed: false,
  });
  process.env[WEB_SCOUT_GRANT_ENV] = issued.value;
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  const commands: string[] = [];
  await webScoutBrowser(
    {
      exec: async (_command: string, args: string[]) => {
        const action =
          args.find((value) =>
            ["open", "goto", "eval", "tab-list", "close"].includes(value),
          ) ?? "unknown";
        commands.push(action);
        if (action === "tab-list")
          return {
            code: 0,
            stdout: JSON.stringify({
              result:
                "- 0: (current) [Changelog](https://example.com/CHANGELOG.md)",
            }),
            stderr: "",
            killed: false,
          };
        if (action === "goto")
          return {
            code: 0,
            stdout: JSON.stringify({
              snapshot: { file: "../invalid-snapshot" },
            }),
            stderr: "",
            killed: false,
          };
        if (action === "eval")
          return {
            code: 0,
            stdout: JSON.stringify({
              result: JSON.stringify({
                contentType: "text/plain",
                text: "# Changelog\napi_key=top-secret\nFixed",
                truncated: false,
              }),
            }),
            stderr: "",
            killed: false,
          };
        return { code: 0, stdout: "{}", stderr: "", killed: false };
      },
      registerTool(value: any) {
        tools.set(value.name, value);
      },
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as any,
    { persistentClient: false },
  );
  const result = await tools
    .get("scout_browser")
    .execute("raw", {
      action: "navigate",
      url: "https://example.com/CHANGELOG.md",
    });
  assert.match(result.content[0].text, /Pages: 1\/1/);
  assert.match(result.content[0].text, /Bounded text fallback: text\/plain/);
  assert.match(result.content[0].text, /# Changelog/);
  assert.match(result.content[0].text, /\[possible credential redacted\]/);
  assert.deepEqual(commands, ["open", "tab-list", "goto", "eval", "tab-list"]);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
});

test("Web Scout does not consume page quota when navigation and text fallback fail", async () => {
  const issued = await issueWebScoutGrant({
    maxPages: 1,
    maxActions: 3,
    headed: false,
  });
  process.env[WEB_SCOUT_GRANT_ENV] = issued.value;
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  let navigations = 0;
  await webScoutBrowser(
    {
      exec: async (_command: string, args: string[]) => {
        const action =
          args.find((value) =>
            ["open", "goto", "eval", "tab-list", "close"].includes(value),
          ) ?? "unknown";
        if (action === "tab-list")
          return {
            code: 0,
            stdout: JSON.stringify({
              result: "- 0: (current) [Example](https://example.com/)",
            }),
            stderr: "",
            killed: false,
          };
        if (action === "goto" && ++navigations === 1)
          return {
            code: 0,
            stdout: JSON.stringify({
              snapshot: { file: "../invalid-snapshot" },
            }),
            stderr: "",
            killed: false,
          };
        if (action === "goto")
          return {
            code: 0,
            stdout: JSON.stringify({ snapshot: "- heading Success" }),
            stderr: "",
            killed: false,
          };
        if (action === "eval")
          return {
            code: 0,
            stdout: JSON.stringify({
              result: JSON.stringify({
                contentType: "text/html",
                text: "not an allowed fallback",
                truncated: false,
              }),
            }),
            stderr: "",
            killed: false,
          };
        return { code: 0, stdout: "{}", stderr: "", killed: false };
      },
      registerTool(value: any) {
        tools.set(value.name, value);
      },
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as any,
    { persistentClient: false },
  );
  const browser = tools.get("scout_browser");
  await assert.rejects(
    browser.execute("failed", {
      action: "navigate",
      url: "https://example.com/first",
    }),
    /invalid snapshot artifact/,
  );
  const recovered = await browser.execute("success", {
    action: "navigate",
    url: "https://example.com/second",
  });
  assert.match(recovered.content[0].text, /Pages: 1\/1/);
  assert.equal(navigations, 2);
  await assert.rejects(
    browser.execute("limited", {
      action: "navigate",
      url: "https://example.com/third",
    }),
    /page limit/,
  );
  assert.equal(navigations, 2);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
});

test("Web Scout child cleans proxy after browser start failure", async () => {
  const issued = await issueWebScoutGrant({
    maxPages: 2,
    maxActions: 4,
    headed: false,
  });
  process.env[WEB_SCOUT_GRANT_ENV] = issued.value;
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function[]>();
  await webScoutBrowser(
    {
      exec: async (_command: string, args: string[]) => {
        const action = args.find((value) =>
          ["open", "close", "list", "tab-list"].includes(value),
        );
        if (action === "open")
          return { code: 1, stdout: "", stderr: "failed", killed: false };
        return {
          code: 0,
          stdout: action === "list" ? JSON.stringify({ browsers: [] }) : "{}",
          stderr: "",
          killed: false,
        };
      },
      registerTool(value: any) {
        tools.set(value.name, value);
      },
      on(name: string, handler: Function) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as any,
    { persistentClient: false },
  );
  await assert.rejects(
    tools
      .get("scout_browser")
      .execute("id", { action: "navigate", url: "https://example.com" }),
    /command failed/i,
  );
  for (const handler of handlers.get("session_shutdown") ?? []) await handler();
});

test("crafted Web Scout grant path cannot delete attacker-selected directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-grant-victim-"));
  const path = join(directory, "grant.json");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      token: "token",
      expiresAt: Date.now() + 60_000,
      maxPages: 1,
      maxActions: 1,
      headed: false,
    }),
  );
  const encoded = Buffer.from(
    JSON.stringify({ path, token: "token" }),
  ).toString("base64url");
  try {
    await assert.rejects(consumeWebScoutGrant(encoded), /path is invalid/);
    assert.match(await readFile(path, "utf8"), /"token"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  "window capture consent names resolved title",
  { skip: process.platform !== "win32" },
  async () => {
    const { tools } = runtime({ exec: async () => successfulLookup() });
    let confirmation = "";
    const result = await tools.get("helios_capture").execute(
      "id",
      { target: "window", title: "Code" },
      undefined,
      undefined,
      context({
        ui: {
          async confirm(_title: string, message: string) {
            confirmation = message;
            return false;
          },
        },
      }),
    );
    assert.match(confirmation, /Visual Studio Code/);
    assert.equal(result.details.declined, true);
  },
);

test("owned browser starts without UI or confirmation", async () => {
  const commands: string[] = [];
  const { tools, handlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command =
        args.find((value) => ["open", "tab-list", "close"].includes(value)) ??
        "unknown";
      commands.push(command);
      if (command === "tab-list")
        return {
          code: 0,
          stdout: JSON.stringify({ result: "- 0: (current) [](about:blank)" }),
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const ctx = context({
    hasUI: false,
    ui: {
      async confirm() {
        throw new Error("owned launch must not request confirmation");
      },
      notify() {},
    },
  });
  const result = await tools
    .get("helios_browser")
    .execute("id", { action: "start" }, undefined, undefined, ctx);
  assert.equal(result.details.ownership, "owned");
  assert.deepEqual(commands, ["open", "tab-list"]);
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
  assert.equal(commands.at(-1), "close");
});

test("browser find returns targeted refs usable by later actions", async () => {
  const commands: string[] = [];
  const { tools, handlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command =
        args.find((value) =>
          ["open", "find", "click", "tab-list", "close"].includes(value),
        ) ?? "unknown";
      commands.push(command);
      if (command === "tab-list")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "- 0: (current) [Shop](https://example.com/)",
          }),
          stderr: "",
          killed: false,
        };
      if (command === "find")
        return {
          code: 0,
          stdout: JSON.stringify({
            result:
              'Found 21 matches for "Add to cart":\n\n- button "Add to cart" [ref=e9]',
          }),
          stderr: "",
          killed: false,
        };
      if (command === "click")
        return {
          code: 0,
          stdout: JSON.stringify({ snapshot: '- button "Added" [ref=e10]' }),
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const browser = tools.get("helios_browser");
  const ctx = context();
  await browser.execute(
    "start",
    { action: "start", url: "https://example.com" },
    undefined,
    undefined,
    ctx,
  );
  const found = await browser.execute(
    "find",
    { action: "find", text: "Add to cart" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(found.content[0].text, /Found 21 matches/);
  assert.match(found.content[0].text, /ref=e9/);
  assert.match(found.content[0].text, /Refine find query/);
  assert.doesNotMatch(found.content[0].text, /Ownership:|Duration:/);
  assert.equal(found.details.findMatches, 21);
  const clicked = await browser.execute(
    "click",
    { action: "click", target: "e9" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(clicked.content[0].text, /Page: Shop/);
  await assert.rejects(
    browser.execute(
      "invalid",
      { action: "find", text: "cart", regex: "cart" },
      undefined,
      undefined,
      ctx,
    ),
    /exactly one/,
  );
  assert.ok(commands.includes("find"));
  assert.ok(commands.includes("click"));
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
});

test("browser semantic plan resolves unique elements and hides intermediate find output", async () => {
  const calls: string[][] = [];
  let finds = 0;
  const { tools, handlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      calls.push(args);
      const command =
        args.find((value) =>
          ["open", "find", "fill", "click", "tab-list", "close"].includes(
            value,
          ),
        ) ?? "unknown";
      if (command === "tab-list")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "- 0: (current) [Form](https://example.com/)",
          }),
          stderr: "",
          killed: false,
        };
      if (command === "find") {
        const result =
          ++finds === 1
            ? 'Found 1 match for "Email":\n\n- generic [ref=e1]:\n  - textbox "Email" [ref=e2]'
            : 'Found 1 match for "Continue":\n\n- button "Continue" [ref=e3]';
        return {
          code: 0,
          stdout: JSON.stringify({ result }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "fill")
        return {
          code: 0,
          stdout: JSON.stringify({ snapshot: '- button "Continue" [ref=e3]' }),
          stderr: "",
          killed: false,
        };
      if (command === "click")
        return {
          code: 0,
          stdout: JSON.stringify({ snapshot: '- heading "Done" [ref=e4]' }),
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const browser = tools.get("helios_browser");
  const ctx = context();
  await browser.execute(
    "start",
    { action: "start", url: "https://example.com" },
    undefined,
    undefined,
    ctx,
  );
  const result = await browser.execute(
    "plan",
    {
      plan: [
        { action: "fill", match: "Email", text: "person@example.com" },
        { action: "click", match: "Continue" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.details.completed, 2);
  assert.match(result.content[0].text, /Step 1 \(fill e2\): completed/);
  assert.match(result.content[0].text, /Step 2 \(click e3\): completed/);
  assert.match(result.content[0].text, /heading "Done" \[ref=e4\]/);
  assert.doesNotMatch(result.content[0].text, /Found 1 match|textbox "Email"/);
  assert.ok(
    calls.some(
      (args) =>
        args.includes("fill") &&
        args.includes("e2") &&
        args.includes("person@example.com"),
    ),
  );
  assert.ok(
    calls.some((args) => args.includes("click") && args.includes("e3")),
  );
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
});

test("browser semantic plan stops on ambiguity and page change", async () => {
  let mode: "ambiguous" | "page-change" = "ambiguous";
  let tabLists = 0;
  let finds = 0;
  const commands: string[] = [];
  const { tools } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command =
        args.find((value) =>
          ["open", "find", "click", "tab-list", "close"].includes(value),
        ) ?? "unknown";
      commands.push(command);
      if (command === "tab-list") {
        const changed = mode === "page-change" && ++tabLists >= 1;
        return {
          code: 0,
          stdout: JSON.stringify({
            result: `- 0: (current) [${changed ? "Next" : "Form"}](https://example.com/${changed ? "next" : ""})`,
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "find") {
        finds++;
        const result =
          mode === "ambiguous"
            ? 'Found 2 matches for "Save":\n\n- button "Save" [ref=e1]\n- button "Save copy" [ref=e2]'
            : 'Found 1 match for "Continue":\n\n- button "Continue" [ref=e3]';
        return {
          code: 0,
          stdout: JSON.stringify({ result }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "click")
        return {
          code: 0,
          stdout: JSON.stringify({ snapshot: '- heading "Next" [ref=e4]' }),
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const browser = tools.get("helios_browser");
  const ctx = context();
  await browser.execute(
    "start",
    { action: "start", url: "https://example.com" },
    undefined,
    undefined,
    ctx,
  );
  const ambiguous = await browser.execute(
    "ambiguous",
    { plan: [{ action: "click", match: "Save" }] },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(ambiguous.details.reason, "ambiguous");
  assert.equal(ambiguous.details.completed, 0);
  assert.match(ambiguous.content[0].text, /Found 2 matches/);
  assert.equal(commands.includes("click"), false);

  mode = "page-change";
  tabLists = 0;
  finds = 0;
  const changed = await browser.execute(
    "changed",
    {
      plan: [
        { action: "click", match: "Continue" },
        { action: "click", match: "Continue" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(changed.details.reason, "page-changed");
  assert.equal(changed.details.completed, 1);
  assert.equal(
    finds,
    1,
    "the next semantic step must not run across a page change",
  );
  await assert.rejects(
    browser.execute(
      "mixed",
      { action: "snapshot", plan: [{ action: "click", match: "Continue" }] },
      undefined,
      undefined,
      ctx,
    ),
    /only plan/,
  );
});

test("browser semantic plan stops when post-action page metadata is unavailable", async () => {
  let tabLists = 0;
  let finds = 0;
  const { tools } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command =
        args.find((value) =>
          ["open", "find", "fill", "tab-list", "close"].includes(value),
        ) ?? "unknown";
      if (command === "tab-list")
        return ++tabLists === 1
          ? {
              code: 0,
              stdout: JSON.stringify({
                result: "- 0: (current) [Form](https://example.com/)",
              }),
              stderr: "",
              killed: false,
            }
          : { code: 0, stdout: "{}", stderr: "", killed: false };
      if (command === "find") {
        finds++;
        return {
          code: 0,
          stdout: JSON.stringify({
            result: 'Found 1 match for "Email":\n\n- textbox "Email" [ref=e2]',
          }),
          stderr: "",
          killed: false,
        };
      }
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const browser = tools.get("helios_browser");
  const ctx = context();
  await browser.execute(
    "start",
    { action: "start", url: "https://example.com" },
    undefined,
    undefined,
    ctx,
  );
  const result = await browser.execute(
    "uncertain",
    {
      plan: [
        { action: "fill", match: "Email", text: "person@example.com" },
        { action: "fill", match: "Email", text: "other@example.com" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.details.reason, "page-uncertain");
  assert.equal(result.details.completed, 1);
  assert.equal(finds, 1);
});

test("browser continue pages cached output without another CLI command and replaces refs", async () => {
  const raw = Array.from(
    { length: 205 },
    (_, index) => `- button Item ${index} [ref=e${index}]`,
  ).join("\n");
  const commands: string[] = [];
  const { tools, handlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command =
        args.find((value) =>
          ["open", "snapshot", "click", "tab-list", "close"].includes(value),
        ) ?? "unknown";
      commands.push(command);
      if (command === "tab-list")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "- 0: (current) [Example](https://example.com/)",
          }),
          stderr: "",
          killed: false,
        };
      if (command === "snapshot")
        return {
          code: 0,
          stdout: JSON.stringify({ snapshot: raw }),
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const browser = tools.get("helios_browser");
  const ctx = context();
  await browser.execute(
    "start",
    { action: "start" },
    undefined,
    undefined,
    ctx,
  );
  const first = await browser.execute(
    "snapshot",
    { action: "snapshot" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(first.content[0].text, /Continuation: hc_/);
  assert.equal(
    first.details.snapshot,
    undefined,
    "snapshot text is not duplicated in persisted details",
  );
  const before = commands.length;
  const continued = await browser.execute(
    "continue",
    { action: "continue", cursor: first.details.snapshotContinuation },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(commands.length, before);
  assert.match(continued.content[0].text, /ref=e204/);
  await assert.rejects(
    browser.execute(
      "stale-ref",
      { action: "click", target: "e1" },
      undefined,
      undefined,
      ctx,
    ),
    /stale/,
  );
  await browser.execute(
    "latest-ref",
    { action: "click", target: "e204" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(commands.filter((command) => command === "snapshot").length, 1);
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
});

test("browser snapshot mode defaults compact and full restores container targets", async () => {
  const raw = '- generic [ref=e1]:\n  - button "Submit" [ref=e2]';
  const commands: string[] = [];
  const { tools, handlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command =
        args.find((value) =>
          ["open", "snapshot", "tab-list", "close"].includes(value),
        ) ?? "unknown";
      commands.push(command);
      if (command === "tab-list")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "- 0: (current) [Example](https://example.com/)",
          }),
          stderr: "",
          killed: false,
        };
      if (command === "snapshot")
        return {
          code: 0,
          stdout: JSON.stringify({ snapshot: raw }),
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const browser = tools.get("helios_browser");
  const ctx = context();
  await browser.execute(
    "start",
    { action: "start" },
    undefined,
    undefined,
    ctx,
  );

  const compact = await browser.execute(
    "compact",
    { action: "snapshot" },
    undefined,
    undefined,
    ctx,
  );
  assert.doesNotMatch(compact.content[0].text, /generic \[ref=e1\]/);
  assert.match(compact.content[0].text, /button "Submit" \[ref=e2\]/);
  await assert.rejects(
    browser.execute(
      "removed",
      { action: "snapshot", target: "e1" },
      undefined,
      undefined,
      ctx,
    ),
    /stale/,
  );

  const full = await browser.execute(
    "full",
    { action: "snapshot", snapshotMode: "full" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(full.content[0].text, /generic \[ref=e1\]/);
  await browser.execute(
    "restored",
    { action: "snapshot", target: "e1" },
    undefined,
    undefined,
    ctx,
  );
  await assert.rejects(
    browser.execute(
      "wrong-mode",
      { action: "navigate", url: "https://example.com", snapshotMode: "full" },
      undefined,
      undefined,
      ctx,
    ),
    /does not accept snapshotMode/,
  );
  assert.equal(commands.filter((command) => command === "snapshot").length, 3);

  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
});

test("browser batch compacts intermediate snapshots and metadata but keeps final output and images", async () => {
  const commands: string[] = [];
  let tabLists = 0;
  const { tools, handlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command =
        args.find((value) =>
          [
            "open",
            "goto",
            "reload",
            "screenshot",
            "snapshot",
            "tab-list",
            "close",
          ].includes(value),
        ) ?? "unknown";
      commands.push(command);
      if (command === "tab-list") {
        const next = ++tabLists > 1;
        return {
          code: 0,
          stdout: JSON.stringify({
            result: `- 0: (current) [${next ? "Next" : "Example"}](https://example.com/${next ? "next" : ""})`,
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "screenshot") {
        const path = args
          .find((arg) => arg.startsWith("--filename="))!
          .slice("--filename=".length);
        await writeFile(path, PNG);
      }
      const snapshot =
        command === "open"
          ? '- button "Start" [ref=e1]'
          : command === "goto"
            ? '- button "Navigate" [ref=f1e2]'
            : command === "reload"
              ? '- button "Reload" [ref=f2e3]'
              : command === "snapshot"
                ? '- button "Final" [ref=f2e4]'
                : undefined;
      return {
        code: 0,
        stdout: JSON.stringify(snapshot ? { snapshot } : {}),
        stderr: "",
        killed: false,
      };
    },
  });
  const ctx = context();
  const result = await tools.get("helios_browser").execute(
    "batch",
    {
      actions: [
        { action: "start", url: "https://example.com" },
        { action: "navigate", url: "https://example.com/next" },
        { action: "reload" },
        { action: "screenshot" },
        { action: "snapshot" },
      ],
    },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(commands, [
    "open",
    "tab-list",
    "goto",
    "tab-list",
    "reload",
    "tab-list",
    "screenshot",
    "snapshot",
  ]);
  assert.deepEqual(
    result.details.steps.map((step: any) => step.action),
    ["start", "navigate", "reload", "screenshot", "snapshot"],
  );
  assert.equal(result.details.completed, 5);
  for (const step of result.details.steps) {
    assert.equal(step.details.snapshot, undefined);
    assert.equal(step.details.artifactPath, undefined);
  }
  const text = result.content
    .filter((item: any) => item.type === "text")
    .map((item: any) => item.text);
  assert.match(text[0], /^Step 1 \(start\): completed \(owned\)\./);
  assert.match(text[0], /Page: Example/);
  assert.doesNotMatch(text[0], /button "Start"/);
  assert.match(text[1], /Page: Next/);
  assert.doesNotMatch(text[1], /button "Navigate"/);
  assert.doesNotMatch(text[2], /Page:/);
  assert.doesNotMatch(text[2], /button "Reload"/);
  const imageIndex = result.content.findIndex(
    (item: any) => item.type === "image" && item.data.length > 0,
  );
  assert.ok(imageIndex > 0);
  assert.match(
    result.content[imageIndex - 1].text,
    /^Step 4 \(screenshot\): completed\./,
  );
  assert.match(result.content[imageIndex + 1].text, /^Step 5 \(snapshot\):/);
  assert.match(
    text.at(-1),
    /^Step 5 \(snapshot\):\nBrowser snapshot completed/,
  );
  assert.match(text.at(-1), /button "Final" \[ref=f2e4\]/);
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
  assert.equal(commands.at(-1), "close");
});

test("browser batch keeps intermediate warnings while omitting truncated snapshot text", async () => {
  const raw = [
    '- textbox "Password" [ref=f1e1]: hunter2',
    ...Array.from(
      { length: 100 },
      (_, index) => `- button Item ${index} [ref=f1e${index + 2}]`,
    ),
  ].join("\n");
  let tabLists = 0;
  const { tools } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command = args.find((value) =>
        ["open", "click", "tab-list", "close"].includes(value),
      );
      if (command === "tab-list") {
        if (++tabLists > 1)
          return {
            code: 1,
            stdout: "",
            stderr: "metadata failed",
            killed: false,
          };
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "- 0: (current) [Example](https://example.com/)",
          }),
          stderr: "",
          killed: false,
        };
      }
      if (command === "open")
        return {
          code: 0,
          stdout: JSON.stringify({ snapshot: "- button Submit [ref=e1]" }),
          stderr: "",
          killed: false,
        };
      if (command === "click")
        return {
          code: 0,
          stdout: JSON.stringify({ snapshot: raw }),
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const result = await tools.get("helios_browser").execute(
    "batch-warnings",
    {
      actions: [
        { action: "start" },
        { action: "click", target: "e1" },
        { action: "close" },
      ],
    },
    undefined,
    undefined,
    context(),
  );
  assert.match(result.content[1].text, /Page metadata may be stale/);
  assert.match(result.content[1].text, /Redactions: 1/);
  assert.match(
    result.content[1].text,
    /Intermediate snapshot omitted and truncated; [1-9][0-9]* lines \/ [1-9][0-9]* bytes remain/,
  );
  assert.match(result.content[1].text, /Request a new snapshot if needed/);
  assert.doesNotMatch(
    result.content[1].text,
    /Continuation:|hunter2|button Item/,
  );
});

test("browser tab-list bounds model output and compact details", async () => {
  let tabLists = 0;
  const { tools, handlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command = args.find((value) =>
        ["open", "tab-list", "close"].includes(value),
      );
      if (command === "tab-list") {
        if (++tabLists === 1)
          return {
            code: 0,
            stdout: JSON.stringify({
              result: "- 0: (current) [Example](https://example.com/)",
            }),
            stderr: "",
            killed: false,
          };
        const tabs = Array.from(
          { length: 25 },
          (_, index) =>
            `- ${index}: ${index === 24 ? "(current) " : ""}[${"T".repeat(200)}](https://example.com/${"u".repeat(900)})`,
        ).join("\n");
        return {
          code: 0,
          stdout: JSON.stringify({ result: tabs }),
          stderr: "",
          killed: false,
        };
      }
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const ctx = context();
  const browser = tools.get("helios_browser");
  await browser.execute(
    "start-tabs",
    { action: "start" },
    undefined,
    undefined,
    ctx,
  );
  const result = await browser.execute(
    "list-tabs",
    { action: "tabs", tabAction: "list" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.details.tabs.length, 20);
  assert.equal(result.details.tabsOmitted, 5);
  assert.equal(result.details.tabs.at(-1).index, 24);
  assert.match(result.content[0].text, /5 more omitted\./);
  assert.ok(result.content[0].text.length < 20_000);
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
});

test("browser single-action result remains unwrapped", async () => {
  const { tools, handlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command = args.find((value) =>
        ["open", "tab-list", "close"].includes(value),
      );
      if (command === "tab-list")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "- 0: (current) [Example](https://example.com/)",
          }),
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const ctx = context();
  const result = await tools
    .get("helios_browser")
    .execute("start", { action: "start" }, undefined, undefined, ctx);
  assert.equal(result.details.action, "start");
  assert.equal(result.details.steps, undefined);
  assert.match(result.content[0].text, /^Browser start completed/);
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
});

test("browser batch rejects mixed input and stops after declined attachment", async () => {
  let calls = 0;
  const { tools } = runtime({
    exec: async () => {
      calls++;
      return successfulLookup();
    },
  });
  const browser = tools.get("helios_browser");
  await assert.rejects(
    browser.execute("missing", {}, undefined, undefined, context()),
    /requires action, actions, or plan/,
  );
  await assert.rejects(
    browser.execute(
      "mixed",
      { action: "start", actions: [{ action: "start" }] },
      undefined,
      undefined,
      context(),
    ),
    /only actions/,
  );
  const declined = await browser.execute(
    "declined",
    {
      actions: [
        {
          action: "attach",
          attachMode: "cdp",
          endpoint: "http://127.0.0.1:9222",
        },
        { action: "navigate", url: "https://example.com" },
      ],
    },
    undefined,
    undefined,
    context({
      ui: {
        async confirm() {
          return false;
        },
      },
    }),
  );
  assert.equal(declined.details.steps.length, 1);
  assert.equal(declined.details.steps[0].details.declined, true);
  assert.equal(declined.details.completed, 1);
  assert.equal(declined.details.stoppedAt, 1);
  assert.equal(declined.details.reason, "declined");
  assert.match(
    declined.content[0].text,
    /^Step 1 \(attach\):\nUser declined browser attachment\./,
  );
  assert.equal(calls, 0);
});

test("browser batch stops after a failed step", async () => {
  const commands: string[] = [];
  const { tools, handlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command =
        args.find((value) =>
          ["open", "goto", "tab-list", "close"].includes(value),
        ) ?? "unknown";
      commands.push(command);
      if (command === "tab-list")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "- 0: (current) [Example](https://example.com/)",
          }),
          stderr: "",
          killed: false,
        };
      if (command === "goto")
        return { code: 1, stdout: "", stderr: "failed", killed: false };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const ctx = context();
  await assert.rejects(
    tools.get("helios_browser").execute(
      "failed",
      {
        actions: [
          { action: "start" },
          { action: "navigate", url: "https://example.com" },
          { action: "close" },
        ],
      },
      undefined,
      undefined,
      ctx,
    ),
    (error: any) => {
      assert.match(
        error.message,
        /batch step 2 \(navigate\) failed:.*command failed/i,
      );
      assert.ok(error.cause);
      return true;
    },
  );
  assert.deepEqual(commands, ["open", "tab-list", "goto"]);
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
});

test("attached endpoint validation happens before consent and remains loopback", async () => {
  const { tools } = runtime({ exec: async () => successfulLookup() });
  const browser = tools.get("helios_browser");
  await assert.rejects(
    browser.execute(
      "id",
      {
        action: "attach",
        attachMode: "cdp",
        endpoint: "http://example.com:9222",
      },
      undefined,
      undefined,
      context(),
    ),
    /loopback/,
  );
  await assert.rejects(
    browser.execute(
      "id",
      {
        action: "attach",
        attachMode: "cdp",
        endpoint: "http://127.0.0.1:9222",
      },
      undefined,
      undefined,
      context({ hasUI: false }),
    ),
    /interactive confirmation/,
  );
  assert.equal(loopbackUrl("http://[::1]:9222", ["http:"]).port, "9222");
});

test("attached browser still requires consent to close a user tab", async () => {
  const commands: string[] = [];
  const confirmations: string[] = [];
  const { tools, handlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      const command =
        args.find((value) =>
          ["attach", "tab-list", "tab-close", "detach"].includes(value),
        ) ?? "unknown";
      commands.push(command);
      if (command === "tab-list")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "- 0: (current) [Example](https://example.com/)",
          }),
          stderr: "",
          killed: false,
        };
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const ctx = context({
    ui: {
      async confirm(title: string) {
        confirmations.push(title);
        return title === "Attach to existing browser?";
      },
      notify() {},
    },
  });
  const browser = tools.get("helios_browser");
  await browser.execute(
    "attach",
    { action: "attach", attachMode: "cdp", endpoint: "http://127.0.0.1:9222" },
    undefined,
    undefined,
    ctx,
  );
  const result = await browser.execute(
    "close-tab",
    { action: "tabs", tabAction: "close", tabIndex: 0 },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.details.declined, true);
  assert.deepEqual(confirmations, [
    "Attach to existing browser?",
    "Close user browser tab?",
  ]);
  assert.ok(!commands.includes("tab-close"));
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
  assert.equal(commands.at(-1), "detach");
});

test("owned browser screenshot uses Playwright CLI, attaches image, and cleans artifacts", async () => {
  const commands: string[] = [];
  const before = await temporaryCaptures();
  const { tools, handlers } = runtime({
    exec: async (_command: string, args: string[]) => {
      const cliCommand = args.find((arg) =>
        ["open", "list", "tab-list", "screenshot", "close"].includes(arg),
      );
      commands.push(cliCommand ?? "unknown");
      const session = args.find((arg) => arg.startsWith("-s="))?.slice(3);
      if (cliCommand === "list")
        return {
          code: 0,
          stdout: JSON.stringify({
            browsers: [{ name: session, status: "open" }],
          }),
          stderr: "",
          killed: false,
        };
      if (cliCommand === "tab-list")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: "- 0: (current) [Example](https://example.com/)",
          }),
          stderr: "",
          killed: false,
        };
      if (cliCommand === "screenshot") {
        const path = args
          .find((arg) => arg.startsWith("--filename="))!
          .slice("--filename=".length);
        await writeFile(path, PNG);
      }
      return { code: 0, stdout: "{}", stderr: "", killed: false };
    },
  });
  const statuses: Array<string | undefined> = [];
  const ctx = context({
    ui: {
      async confirm() {
        return true;
      },
      notify() {},
      setStatus(_key: string, value: string | undefined) {
        statuses.push(value);
      },
    },
  });
  const browser = tools.get("helios_browser");
  await browser.execute(
    "start",
    { action: "start", url: "https://example.com" },
    undefined,
    undefined,
    ctx,
  );
  const result = await browser.execute(
    "shot",
    { action: "screenshot" },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(
    result.content.some(
      (item: any) => item.type === "image" && item.data.length > 0,
    ),
  );
  assert.equal(result.details.snapshot, undefined);
  assert.equal(result.details.artifactPath, undefined);
  assert.ok(commands.includes("screenshot"));
  for (const handler of handlers.get("session_shutdown") ?? [])
    await handler({ reason: "quit" }, ctx);
  assert.ok(commands.includes("close"));
  assert.ok(statuses.includes("browser: start"));
  assert.ok(statuses.includes("browser: screenshot"));
  assert.equal(statuses.at(-1), undefined);
  assert.deepEqual(await temporaryCaptures(), before);
});

test("window lookup and PrintWindow regression guarantees remain", async () => {
  await assert.rejects(
    findWindow(async () => successfulLookup(), "Code", undefined, "linux"),
    /Windows only/,
  );
  const target = await findWindow(
    async (command, args) => {
      assert.equal(command, "powershell.exe");
      assert.match(nativeSource(args), /StringComparison\.OrdinalIgnoreCase/);
      return successfulLookup();
    },
    "Code",
    undefined,
    "win32",
  );
  assert.deepEqual(target, WINDOW);

  const directory = await mkdtemp(join(tmpdir(), "helios-test-"));
  const output = join(directory, "capture.png");
  try {
    await captureWindow(
      async (_command, args) => {
        const source = nativeSource(args);
        assert.match(source, /PrintWindow/);
        assert.doesNotMatch(source, /CopyFromScreen|VirtualScreen/);
        await writeFile(output, PNG);
        return { code: 0, stdout: "", stderr: "", killed: false };
      },
      WINDOW,
      output,
      undefined,
      "win32",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
