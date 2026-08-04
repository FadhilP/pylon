import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { AppiumClient, resolveAppium } from "../src/appium.ts";

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
