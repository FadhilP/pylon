import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import helios from "../extensions/pi-helios.ts";
import { captureWindow, findWindow, loopbackUrl } from "../src/capture.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const WINDOW = { handle: 42, processId: 7, title: "Visual Studio Code" };

function registeredTool(pi: Record<string, unknown> = {}) {
  let tool: any;
  helios({ ...pi, registerTool(value: any) { tool = value; } } as any);
  return tool;
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

test("registers window capture with consent for resolved title", async () => {
  const tool = registeredTool({ exec: async () => successfulLookup() });
  assert.equal(tool.name, "helios_capture");

  let confirmation = "";
  const result = await tool.execute("id", { target: "window", title: "Code" }, undefined, undefined, {
    hasUI: true,
    model: { input: ["image"] },
    ui: { async confirm(_title: string, message: string) { confirmation = message; return false; } },
  });
  assert.match(confirmation, /Visual Studio Code/);
  assert.equal(result.details.declined, true);
});

test("refuses capture without confirmation, image support, or window title", async () => {
  const tool = registeredTool();
  await assert.rejects(
    tool.execute("id", { target: "window", title: "Code" }, undefined, undefined, { hasUI: false }),
    /interactive confirmation/,
  );
  await assert.rejects(
    tool.execute("id", { target: "window", title: "Code" }, undefined, undefined, { hasUI: true, model: { input: ["text"] } }),
    /does not support image/,
  );
  await assert.rejects(
    tool.execute("id", { target: "window" }, undefined, undefined, { hasUI: true, model: { input: ["image"] } }),
    /non-empty title/,
  );
});

test("browser endpoints must remain loopback", () => {
  assert.equal(loopbackUrl("http://127.0.0.1:9222", ["http:"]).port, "9222");
  assert.throws(() => loopbackUrl("http://example.com:9222", ["http:"]), /loopback/);
  assert.throws(() => loopbackUrl("file:///tmp/socket", ["http:"]), /loopback/);
});

test("window lookup is Windows-only and returns selected identity", async () => {
  await assert.rejects(findWindow(async () => successfulLookup(), "Code", undefined, "linux"), /Windows only/);
  const target = await findWindow(async (command, args) => {
    assert.equal(command, "powershell.exe");
    const source = nativeSource(args);
    assert.match(source, /StringComparison\.OrdinalIgnoreCase/);
    return successfulLookup();
  }, "Code", undefined, "win32");
  assert.deepEqual(target, WINDOW);
});

test("window capture uses PrintWindow only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "helios-test-"));
  const output = join(directory, "capture.png");
  try {
    await captureWindow(async (command, args) => {
      assert.equal(command, "powershell.exe");
      const source = nativeSource(args);
      assert.match(source, /PrintWindow/);
      assert.doesNotMatch(source, /CopyFromScreen|VirtualScreen|expectedTitle/);
      await writeFile(output, PNG);
      return { code: 0, stdout: "", stderr: "", killed: false };
    }, WINDOW, output, undefined, "win32");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("approved browser capture attaches image bytes and removes temporary file", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const before = await temporaryCaptures();
  let confirmation = "";

  class FakeWebSocket {
    listeners = new Map<string, Set<(event: any) => void>>();
    constructor(_url: string | URL) { queueMicrotask(() => this.emit("open", {})); }
    addEventListener(name: string, listener: (event: any) => void) {
      const listeners = this.listeners.get(name) ?? new Set();
      listeners.add(listener);
      this.listeners.set(name, listeners);
    }
    removeEventListener(name: string, listener: (event: any) => void) { this.listeners.get(name)?.delete(listener); }
    send() {
      queueMicrotask(() => this.emit("message", { data: JSON.stringify({ id: 1, result: { data: PNG.toString("base64") } }) }));
    }
    close() {}
    emit(name: string, event: any) { for (const listener of this.listeners.get(name) ?? []) listener(event); }
  }

  globalThis.fetch = async () => new Response(JSON.stringify([{
    type: "page",
    title: "Local App",
    url: "http://localhost:3000/",
    webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/1",
  }])) as any;
  globalThis.WebSocket = FakeWebSocket as any;

  try {
    const tool = registeredTool();
    const result = await tool.execute("id", { target: "browser", title: "Local" }, undefined, undefined, {
      cwd: process.cwd(),
      hasUI: true,
      model: { input: ["text", "image"] },
      ui: {
        async confirm(_title: string, message: string) { confirmation = message; return true; },
        notify() {},
      },
    });
    assert.match(confirmation, /127\.0\.0\.1:9222/);
    assert.ok(result.content.some((item: any) => item.type === "image" && item.data.length > 0));
    assert.deepEqual(await temporaryCaptures(), before);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});
