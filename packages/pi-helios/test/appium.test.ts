import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppiumClient, resolveAppium, resolveManagedAppium } from "../src/appium.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("Appium client speaks bounded W3C lifecycle and interaction endpoints", async () => {
  const calls: Array<{ method?: string; url?: string; body: any }> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    calls.push({ method: request.method, url: request.url, body: raw ? JSON.parse(raw) : undefined });
    response.setHeader("content-type", "application/json");
    const send = (value: unknown) => response.end(JSON.stringify({ value }));
    if (request.url === "/status") return send({ ready: true });
    if (request.url === "/session" && request.method === "POST") return response.end(JSON.stringify({ value: { sessionId: "s1", capabilities: {} } }));
    if (request.url === "/session/s1/appium/device/current_package") return send("com.example.app");
    if (request.url === "/session/s1/source") return send("<hierarchy/>");
    if (request.url === "/session/s1/screenshot") return send(PNG.toString("base64"));
    if (request.url === "/session/s1/window/rect") return send({ width: 1080, height: 1920 });
    if (request.url === "/session/s1/element") return send({ "element-6066-11e4-a52e-4f735466cecf": "e1" });
    return send(null);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new AppiumClient(`http://127.0.0.1:${address.port}`);
  try {
    await client.status();
    await client.createSession({ platformName: "Android" });
    assert.equal(await client.currentPackage(), "com.example.app");
    assert.equal(await client.source(), "<hierarchy/>");
    assert.deepEqual(await client.windowRect(), { width: 1080, height: 1920 });
    await client.tap(10, 20);
    await client.swipe({ x: 20, y: 30 }, { x: 20, y: 10 });
    const element = await client.findByXpath("/hierarchy[1]/button[1]");
    await client.fillElement(element, "hello");
    await client.back();
    assert.deepEqual(await client.screenshot(), PNG);
    await client.deleteSession();
    assert.ok(calls.some((call) => call.url === "/session/s1/actions" && call.body.actions[0].parameters.pointerType === "touch"));
    assert.ok(calls.some((call) => call.url === "/session/s1/element/e1/value" && call.body.text === "hello"));
    assert.equal(calls.at(-1)?.method, "DELETE");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Appium client rejects non-loopback and path-bearing endpoints", () => {
  assert.throws(() => new AppiumClient("http://example.com:4723"), /loopback/);
  assert.throws(() => new AppiumClient("http://127.0.0.1:4723/wd/hub"), /origin/);
});

test("Appium status requires an explicit ready true", async () => {
  const server = createServer((_request, response) => response.end(JSON.stringify({ value: { ready: false, message: "starting" } })));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(new AppiumClient(`http://127.0.0.1:${address.port}`).status(), /not ready/);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Appium resolution rejects cancellation before invoking subprocesses", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(resolveAppium(async () => { calls++; return { code: 0, stdout: "", stderr: "", killed: false }; }, controller.signal), /cancelled/);
  assert.equal(calls, 0);
});


test("Windows Appium resolution invokes npm-cli.js through Node without npm.cmd", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "helios-appium-resolution-"));
  const npmCli = join(root, "npm-cli.js");
  const globalRoot = join(root, "global", "node_modules");
  const appiumDirectory = join(globalRoot, "appium");
  const appiumCli = join(appiumDirectory, "build", "main.js");
  try {
    await mkdir(join(appiumDirectory, "build"), { recursive: true });
    await writeFile(npmCli, "// npm fixture");
    await writeFile(join(appiumDirectory, "package.json"), JSON.stringify({ bin: { appium: "build/main.js" } }));
    await writeFile(appiumCli, "// appium fixture");
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec = async (command: string, args: string[]) => {
      calls.push({ command, args });
      if (args[0] === npmCli) return { code: 0, stdout: `${globalRoot}\n`, stderr: "", killed: false };
      if (args.includes("--version")) return { code: 0, stdout: "3.2.0\n", stderr: "", killed: false };
      return { code: 0, stdout: "uiautomator2@5.0.0 [installed]\n", stderr: "", killed: false };
    };
    const invocation = await resolveAppium(exec, undefined, { npm_execpath: npmCli, PATH: "" });
    assert.deepEqual(calls[0], { command: process.execPath, args: [npmCli, "root", "-g"] });
    assert.ok(calls.every(({ command }) => command.toLowerCase() !== "npm.cmd"));
    assert.deepEqual(invocation, { command: process.execPath, args: [appiumCli], version: "3.2.0" });
    await assert.rejects(resolveAppium(exec, undefined, { npm_execpath: join(root, "npm.cmd") }), /absolute npm-cli\.js/);
    await assert.rejects(resolveAppium(async (_command, args) => args[0] === npmCli
      ? { code: 0, stdout: `${join(root, "missing")}\n`, stderr: "", killed: false }
      : { code: 1, stdout: "", stderr: "", killed: false }, undefined, { npm_execpath: npmCli }), /Appium is unavailable/);
    await writeFile(join(appiumDirectory, "package.json"), JSON.stringify({ bin: { appium: "../escape.js" } }));
    await assert.rejects(resolveAppium(exec, undefined, { npm_execpath: npmCli, PATH: "" }), /entrypoint is invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("explicit APPIUM_PATH bypasses npm discovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "helios-appium-path-"));
  const cli = join(root, "appium.js");
  try {
    await writeFile(cli, "// appium fixture");
    const calls: string[][] = [];
    const invocation = await resolveAppium(async (command, args) => {
      assert.equal(command, process.execPath);
      calls.push(args);
      return args.includes("--version")
        ? { code: 0, stdout: "3.2.0\n", stderr: "", killed: false }
        : { code: 0, stdout: "uiautomator2 [installed]\n", stderr: "", killed: false };
    }, undefined, { APPIUM_PATH: cli });
    assert.deepEqual(calls, [[cli, "--version"], [cli, "driver", "list", "--installed"]]);
    assert.deepEqual(invocation, { command: process.execPath, args: [cli], version: "3.2.0" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed Appium refuses to fall back while recovery is incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "helios-appium-recovery-"));
  try {
    await mkdir(join(root, "pi-helios", "android-tooling", "previous"), { recursive: true });
    await assert.rejects(resolveManagedAppium(root), /recovery is incomplete/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
