import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSessionManager, cliSessionName, parseTabs, validateCdpEndpoint } from "../src/browser-session.ts";

function fakeCli(log: string[], delay = 0) {
  return {
    directory: "C:\\private-helios",
    async configureOwned() { log.push("configure"); },
    async dispose() { log.push("dispose"); },
    async run(session: string, action: any) {
      log.push(action.kind);
      if (delay && action.kind === "snapshot") await new Promise((resolve) => setTimeout(resolve, delay));
      if (action.kind === "list") return { value: { browsers: [{ name: session, status: "open" }] } };
      if (action.kind === "tab-list") return { value: { result: "- 0: (current) [Example](https://example.com/)" } };
      return { value: {} };
    },
  } as any;
}

const exec = async () => ({ code: 0, stdout: "{}", stderr: "", killed: false });

test("session names are opaque and endpoints are strict loopback origins", () => {
  assert.match(cliSessionName("pi-session"), /^helios-[a-f0-9]{12}-[a-f0-9]{12}$/);
  assert.equal(validateCdpEndpoint("http://127.0.0.1:9222"), "http://127.0.0.1:9222");
  assert.throws(() => validateCdpEndpoint("http://example.com:9222"), /loopback/);
  assert.throws(() => validateCdpEndpoint("http://127.0.0.1:9222/json"), /origin/);
  assert.deepEqual(parseTabs("- 0: [One](https://one.test/)\n- 1: (current) [Two](https://two.test/)"), [
    { index: 0, title: "One", url: "https://one.test/" },
    { index: 1, title: "Two", url: "https://two.test/" },
  ]);
});

test("owned lifecycle closes and attached lifecycle only detaches", async () => {
  const ownedLog: string[] = [];
  const owned = new BrowserSessionManager(exec as any, async () => fakeCli(ownedLog));
  const started = await owned.start("owned", "https://example.com");
  assert.equal(started.ownership, "owned");
  await owned.close("owned", "close");
  assert.deepEqual(ownedLog, ["configure", "open", "tab-list", "close", "dispose"]);

  const attachedLog: string[] = [];
  const attached = new BrowserSessionManager(exec as any, async () => fakeCli(attachedLog));
  await attached.attachCdp("attached", "http://localhost:9222");
  await assert.rejects(attached.close("attached", "close"), /only be detached/);
  await attached.close("attached", "detach");
  assert.ok(attachedLog.includes("detach"));
  assert.ok(!attachedLog.includes("close"));
});

test("operations serialize and shutdown is idempotent", async () => {
  const log: string[] = [];
  const manager = new BrowserSessionManager(exec as any, async () => fakeCli(log, 15));
  await manager.start("serial");
  await Promise.all([
    manager.operate("serial", { kind: "snapshot" }),
    manager.operate("serial", { kind: "snapshot" }),
  ]);
  assert.deepEqual(log.filter((item) => item === "snapshot"), ["snapshot", "snapshot"]);
  await manager.shutdown();
  await manager.shutdown();
  assert.equal(log.filter((item) => item === "close").length, 1);
  assert.equal(log.filter((item) => item === "dispose").length, 1);
});

test("missing CLI session fails conservatively", async () => {
  const cli = fakeCli([]);
  cli.run = async (_session: string, action: any) => action.kind === "list" ? { value: { browsers: [] } } : { value: {} };
  const manager = new BrowserSessionManager(exec as any, async () => cli);
  await manager.start("stale");
  await assert.rejects(manager.operate("stale", { kind: "reload" }), /stale/);
  assert.equal(manager.get("stale")?.state, "cleanup-required");
  await manager.shutdown();
});

test("failed close remains retryable and successful close reports dispose warning", async () => {
  let failClose = true;
  const log: string[] = [];
  const cli = fakeCli(log);
  cli.run = async (session: string, action: any) => {
    log.push(action.kind);
    if (action.kind === "list") return { value: { browsers: [{ name: session, status: "open" }] } };
    if (action.kind === "tab-list") return { value: { result: "- 0: (current) [Example](https://example.com/)" } };
    if (action.kind === "close" && failClose) throw new Error("close failed");
    return { value: {} };
  };
  cli.dispose = async () => { throw new Error("dispose failed"); };
  const manager = new BrowserSessionManager(exec as any, async () => cli);
  await manager.start("retry-close");
  await assert.rejects(manager.close("retry-close", "close"), /close failed/);
  assert.equal(manager.get("retry-close")?.state, "cleanup-required");
  failClose = false;
  const closed = await manager.close("retry-close", "close");
  assert.deepEqual(closed.cleanupWarnings, ["Could not delete private browser directory"]);
  assert.equal(manager.get("retry-close"), undefined);
});

test("uncertain start failure cleans independently or preserves retry state", async () => {
  const cleanedLog: string[] = [];
  const cleanedCli = fakeCli(cleanedLog);
  cleanedCli.run = async (_session: string, action: any) => {
    cleanedLog.push(action.kind);
    if (action.kind === "open") throw new Error("open timed out");
    return { value: {} };
  };
  const cleaned = new BrowserSessionManager(exec as any, async () => cleanedCli);
  await assert.rejects(cleaned.start("cleaned"), /open timed out/);
  assert.deepEqual(cleanedLog, ["configure", "open", "close", "dispose"]);
  assert.equal(cleaned.get("cleaned"), undefined);

  let cleanupWorks = false;
  const retainedCli = fakeCli([]);
  retainedCli.run = async (session: string, action: any) => {
    if (action.kind === "open") throw new Error("open timed out");
    if (action.kind === "close" && !cleanupWorks) throw new Error("close failed");
    if (action.kind === "list") return { value: { browsers: [{ name: session, status: "open" }] } };
    return { value: {} };
  };
  const retained = new BrowserSessionManager(exec as any, async () => retainedCli);
  await assert.rejects(retained.start("retained"), /cleanup is uncertain/);
  assert.equal(retained.get("retained")?.state, "cleanup-required");
  cleanupWorks = true;
  await retained.close("retained", "close");
  assert.equal(retained.get("retained"), undefined);
});

test("metadata failure does not hide primary success and hover invalidates refs", async () => {
  let tabLists = 0;
  const actions: string[] = [];
  const cli = fakeCli(actions);
  cli.run = async (session: string, action: any) => {
    actions.push(action.kind);
    if (action.kind === "list") return { value: { browsers: [{ name: session, status: "open" }] } };
    if (action.kind === "tab-list") {
      tabLists++;
      if (tabLists > 1) throw new Error("metadata failed");
      return { value: { result: "- 0: (current) [Example](https://example.com/)" } };
    }
    if (action.kind === "snapshot") return { value: {}, snapshot: "- button [ref=e1]" };
    return { value: {} };
  };
  const manager = new BrowserSessionManager(exec as any, async () => cli);
  await manager.start("metadata");
  const snapshot = await manager.operate("metadata", { kind: "snapshot" });
  assert.equal(snapshot.outcome, "completed");
  assert.equal(snapshot.metadataAvailable, false);
  await manager.operate("metadata", { kind: "hover", target: "e1" });
  await assert.rejects(manager.operate("metadata", { kind: "click", target: "e1" }), /stale/);
  await manager.close("metadata", "close");
});

test("shutdown reports partial cleanup failure and keeps uncertain session", async () => {
  const failingCli = fakeCli([]);
  failingCli.run = async (session: string, action: any) => {
    if (action.kind === "close") throw new Error("close failed");
    if (action.kind === "list") return { value: { browsers: [{ name: session, status: "open" }] } };
    if (action.kind === "tab-list") return { value: { result: "- 0: (current) [](about:blank)" } };
    return { value: {} };
  };
  const manager = new BrowserSessionManager(exec as any, async () => failingCli);
  await manager.start("shutdown-failure");
  const summary = await manager.shutdown();
  assert.deepEqual(summary.failures, [{ ownership: "owned", action: "close" }]);
  assert.equal(manager.get("shutdown-failure")?.state, "cleanup-required");
});

test("malformed cleanup list never discards uncertain state", async () => {
  const cli = fakeCli([]);
  cli.run = async (_session: string, action: any) => {
    if (action.kind === "open" || action.kind === "close") throw new Error(`${action.kind} failed`);
    if (action.kind === "list") return { value: {} };
    return { value: {} };
  };
  const manager = new BrowserSessionManager(exec as any, async () => cli);
  await assert.rejects(manager.start("malformed-list"), /cleanup is uncertain/);
  assert.equal(manager.get("malformed-list")?.state, "cleanup-required");
});

test("close rejects later operations and duplicate cleanup while preserving earlier queued work", async () => {
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  const cli = fakeCli([]);
  cli.run = async (session: string, action: any) => {
    if (action.kind === "list") return { value: { browsers: [{ name: session, status: "open" }] } };
    if (action.kind === "tab-list") return { value: { result: "- 0: (current) [Example](https://example.com/)" } };
    if (action.kind === "snapshot") await snapshotGate;
    return { value: {}, snapshot: action.kind === "snapshot" ? "- button [ref=e1]" : undefined };
  };
  const manager = new BrowserSessionManager(exec as any, async () => cli);
  await manager.start("queue-close");
  const earlier = manager.operate("queue-close", { kind: "snapshot" });
  const closing = manager.close("queue-close", "close");
  await assert.rejects(manager.operate("queue-close", { kind: "reload" }), /closing/);
  await assert.rejects(manager.close("queue-close", "close"), /closing/);
  releaseSnapshot();
  await earlier;
  await closing;
  assert.equal(manager.get("queue-close"), undefined);
});
