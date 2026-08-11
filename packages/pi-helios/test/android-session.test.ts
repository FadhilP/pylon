import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { AndroidSessionManager } from "../src/android-session.ts";

const SOURCE = `<hierarchy><android.widget.FrameLayout package="com.example.app" bounds="[0,0][1080,1920]"><android.widget.EditText package="com.example.app" class="android.widget.EditText" text="Continue" clickable="true" focusable="true" enabled="true" bounds="[20,100][400,220]"/></android.widget.FrameLayout></hierarchy>`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const exec = async () => ({ code: 0, stdout: "", stderr: "", killed: false });

function harness() {
  const log: string[] = [];
  const emulator = {
    serial: "emulator-5554", avd: "Pixel_Test",
    async stop() { log.push("emulator-stop"); },
    async cleanupUncertainStart() { log.push("emulator-cleanup"); },
  };
  const sdk = {
    async start() { log.push("emulator-start"); return emulator as any; },
    async verifyAttached(serial: string) { log.push("verify-attach"); return { serial, avd: "Pixel_External" }; },
  };
  const server = { url: "http://127.0.0.1:4723/", version: "3.0.0", async stop() { log.push("server-stop"); } };
  const client = {
    sessionId: undefined as string | undefined,
    async createSession(capabilities: Record<string, unknown>) { log.push(`session:${capabilities["appium:udid"]}`); return this.sessionId = "session-1"; },
    async deleteSession() { log.push("session-delete"); this.sessionId = undefined; },
    async currentPackage() { return "com.example.app"; },
    async source() { return SOURCE; },
    async screenshot() { return PNG; },
    async windowRect() { return { width: 1080, height: 1920 }; },
    async tap(x: number, y: number) { log.push(`tap:${x},${y}`); },
    async swipe() { log.push("swipe"); },
    async findByXpath(xpath: string) { log.push(`find:${xpath}`); return "element-1"; },
    async fillElement(_id: string, text: string) { log.push(`fill:${text}`); },
    async back() { log.push("back"); },
  };
  const manager = new AndroidSessionManager(exec as any, {
    acquireToolingLease: async () => { log.push("tooling-acquire"); return async () => { log.push("tooling-release"); }; },
    createSdk: async () => sdk as any,
    resolveAppium: async () => ({ command: "node", args: ["appium.js"], version: "3.0.0" }),
    startServer: async () => server,
    createClient: () => client,
  });
  return { manager, log, client, server, emulator, sdk };
}

test("owned Android lifecycle starts, uses fresh refs, and stops emulator", async () => {
  const { manager, log } = harness();
  const started = await manager.start("owned", "Pixel_Test", "com.example.app");
  assert.equal(started.ownership, "owned");
  assert.match(started.snapshot!, /\[value redacted\]/);
  await manager.operate("owned", { kind: "tap", target: "a1" });
  await assert.rejects(manager.operate("owned", { kind: "tap", target: "a1" }), /stale/);
  await manager.operate("owned", { kind: "snapshot" });
  await manager.operate("owned", { kind: "fill", target: "a1", text: "hello" });
  await manager.close("owned", "close");
  assert.deepEqual(log.filter((item) => ["session-delete", "server-stop", "emulator-stop"].includes(item)), ["session-delete", "server-stop", "emulator-stop"]);
  assert.equal(log[0], "tooling-acquire");
  assert.equal(log.at(-1), "tooling-release");
});

test("attached Android lifecycle detaches without stopping emulator", async () => {
  const { manager, log } = harness();
  const attached = await manager.attach("attached", "emulator-5556", "com.example.app");
  assert.equal(attached.avd, "Pixel_External");
  await assert.rejects(manager.close("attached", "close"), /only be detached/);
  await manager.close("attached", "detach");
  assert.ok(log.includes("session-delete"));
  assert.ok(log.includes("server-stop"));
  assert.ok(!log.includes("emulator-stop"));
});

test("Android screenshot artifacts are private and removed on close", async () => {
  const { manager } = harness();
  await manager.start("image", "Pixel_Test", "com.example.app");
  const result = await manager.operate("image", { kind: "screenshot" });
  assert.ok(result.artifactPath);
  await access(result.artifactPath!);
  await manager.close("image", "close");
  await assert.rejects(access(result.artifactPath!));
});

test("failed owned startup cleans server and emulator", async () => {
  const { manager, log, client } = harness();
  client.source = async () => SOURCE.replaceAll("com.example.app", "com.other.app");
  await assert.rejects(manager.start("failed", "Pixel_Test", "com.example.app"), /left expected package/);
  assert.ok(log.includes("session-delete"));
  assert.ok(log.includes("server-stop"));
  assert.ok(log.includes("emulator-cleanup"));
  assert.equal(manager.get("failed"), undefined);
});

test("Android operations reject foreground package escape", async () => {
  const { manager, client } = harness();
  await manager.start("escape", "Pixel_Test", "com.example.app");
  client.currentPackage = async () => "com.android.permissioncontroller";
  await assert.rejects(manager.operate("escape", { kind: "snapshot" }), /left expected package/);
  client.currentPackage = async () => "com.example.app";
  await manager.close("escape", "close");
});

test("cleanup attempts all owned resources and retains uncertain server cleanup", async () => {
  const first = harness();
  await first.manager.start("delete-fails", "Pixel_Test", "com.example.app");
  first.client.deleteSession = async () => { first.log.push("session-delete-failed"); throw new Error("delete failed"); };
  const closed = await first.manager.close("delete-fails", "close");
  assert.match(closed.cleanupWarnings?.join(" ") ?? "", /delete Appium session/);
  assert.ok(first.log.includes("server-stop"));
  assert.ok(first.log.includes("emulator-stop"));
  assert.equal(first.manager.get("delete-fails"), undefined);

  const second = harness();
  await second.manager.start("server-fails", "Pixel_Test", "com.example.app");
  second.server.stop = async () => { throw new Error("server failed"); };
  await assert.rejects(second.manager.close("server-fails", "close"), /server failed/);
  assert.equal(second.manager.get("server-fails")?.state, "cleanup-required");
  assert.ok(second.log.includes("emulator-stop"));
  second.server.stop = async () => { second.log.push("server-stop-retry"); };
  await second.manager.close("server-fails", "close");
  assert.equal(second.manager.get("server-fails"), undefined);
});

test("attached cleanup failure never signals the emulator", async () => {
  const { manager, log, server } = harness();
  await manager.attach("attached-failure", "emulator-5556", "com.example.app");
  server.stop = async () => { throw new Error("server failed"); };
  await assert.rejects(manager.close("attached-failure", "detach"), /server failed/);
  assert.equal(manager.get("attached-failure")?.state, "cleanup-required");
  assert.ok(!log.includes("emulator-stop"));
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("Android lifecycle reserves synchronously and close waits for startup cleanup", async () => {
  const { manager, sdk, emulator, log } = harness();
  const entered = gate(), blocked = gate();
  sdk.start = async () => { entered.release(); await blocked.promise; return emulator as any; };
  const starting = manager.start("racing", "Pixel_Test", "com.example.app");
  await entered.promise;
  await assert.rejects(manager.start("racing", "Pixel_Test", "com.example.app"), /already has an active/);
  const closing = manager.close("racing", "close");
  blocked.release();
  await assert.rejects(starting, /interrupted by cleanup/);
  await closing;
  assert.equal(manager.get("racing"), undefined);
  assert.ok(log.includes("emulator-cleanup"));
});

test("Android shutdown interrupts and drains in-flight startup", async () => {
  const { manager, sdk, emulator } = harness();
  const entered = gate(), blocked = gate();
  sdk.start = async () => { entered.release(); await blocked.promise; return emulator as any; };
  const starting = manager.start("shutdown-race", "Pixel_Test", "com.example.app");
  await entered.promise;
  const shutdown = manager.shutdown();
  blocked.release();
  await assert.rejects(starting, /interrupted by cleanup/);
  assert.deepEqual(await shutdown, { failures: [], cleanupWarnings: [] });
  assert.equal(manager.get("shutdown-race"), undefined);
  await assert.rejects(manager.start("later", "Pixel_Test", "com.example.app"), /shutting down/);
});

test("Android actions recheck package, require full bounds, and invalidate refs after partial fill", async () => {
  const first = harness();
  await first.manager.start("toctou", "Pixel_Test", "com.example.app");
  let packageChecks = 0;
  first.client.currentPackage = async () => ++packageChecks === 1 ? "com.example.app" : "com.android.permissioncontroller";
  await assert.rejects(first.manager.operate("toctou", { kind: "tap", target: "a1" }), /left expected package/);
  assert.ok(!first.log.some((item) => item.startsWith("tap:")));
  first.client.currentPackage = async () => "com.example.app";
  await first.manager.close("toctou", "close");

  const second = harness();
  second.client.source = async () => SOURCE.replace("[20,100][400,220]", "[20,100][1400,220]");
  await second.manager.start("bounds", "Pixel_Test", "com.example.app");
  await assert.rejects(second.manager.operate("bounds", { kind: "tap", target: "a1" }), /outside the current viewport/);
  await second.manager.close("bounds", "close");

  const third = harness();
  await third.manager.start("partial-fill", "Pixel_Test", "com.example.app");
  third.client.fillElement = async () => { throw new Error("value failed after clear"); };
  await assert.rejects(third.manager.operate("partial-fill", { kind: "fill", target: "a1", text: "secret" }), /value failed/);
  await assert.rejects(third.manager.operate("partial-fill", { kind: "fill", target: "a1", text: "again" }), /stale/);
  await third.manager.close("partial-fill", "close");
});

test("Android find refs remain actionable beyond rendered snapshot limits", async () => {
  const { manager, client, log } = harness();
  const nodes = Array.from({ length: 260 }, (_, index) => `<android.widget.TextView package="com.example.app" class="android.widget.TextView" text="${index === 259 ? "Target Late" : `Item ${index}`}" clickable="true" enabled="true" bounds="[0,0][100,100]"/>`).join("");
  client.source = async () => `<hierarchy>${nodes}</hierarchy>`;
  await manager.start("large-find", "Pixel_Test", "com.example.app");
  const found = await manager.operate("large-find", { kind: "find", text: "Target Late" });
  assert.match(found.snapshot!, /Target Late/);
  await manager.operate("large-find", { kind: "tap", target: "a1" });
  assert.ok(log.some((item) => item.startsWith("tap:")));
  await manager.close("large-find", "close");
});
