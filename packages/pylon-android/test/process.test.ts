import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { terminateProcessTree, waitForExit } from "pylon-android/process";

test("tracked process termination waits until the child exits", { timeout: 20_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  await terminateProcessTree(child, "test child", 2_000, 5_000);
  assert.equal(await waitForExit(child, 100), true);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
test("Windows taskkill helpers are terminated and rejected when they exceed their deadline", async () => {
  const child = new EventEmitter() as any;
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  let helperKills = 0;
  const spawnProcess = (() => {
    const helper = new EventEmitter() as any;
    helper.pid = 23456;
    helper.exitCode = null;
    helper.signalCode = null;
    helper.kill = () => {
      helperKills++;
      helper.signalCode = "SIGKILL";
      return true;
    };
    return helper;
  }) as typeof spawn;

  await assert.rejects(
    terminateProcessTree(child, "hung Windows child", 5, 5, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnProcess,
    }),
    /taskkill did not exit within 5ms/,
  );
  assert.equal(helperKills, 2);
});

test("Windows cleanup reports taskkill helpers that cannot be reaped", { timeout: 1_000 }, async () => {
  const child = new EventEmitter() as any;
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  const spawnProcess = (() => {
    const helper = new EventEmitter() as any;
    helper.pid = 23456;
    helper.exitCode = null;
    helper.signalCode = null;
    helper.kill = () => false;
    return helper;
  }) as typeof spawn;

  await assert.rejects(
    terminateProcessTree(child, "hung Windows child", 1, 1, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnProcess,
    }),
    error =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.every(item => item instanceof Error && /could not be reaped within 50ms/.test(item.message)),
  );
});

test("a forced target cleanup does not hide an orphaned graceful taskkill helper", { timeout: 1_000 }, async () => {
  const child = new EventEmitter() as any;
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  let spawnCalls = 0;
  const spawnProcess = (() => {
    spawnCalls++;
    const helper = new EventEmitter() as any;
    helper.pid = 23456 + spawnCalls;
    helper.exitCode = null;
    helper.signalCode = null;
    helper.kill = () => false;
    if (spawnCalls === 2) {
      setImmediate(() => {
        helper.exitCode = 0;
        child.signalCode = "SIGKILL";
        helper.emit("close", 0);
        child.emit("exit", null, "SIGKILL");
      });
    }
    return helper;
  }) as typeof spawn;

  await assert.rejects(
    terminateProcessTree(child, "hung Windows child", 1, 50, {
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      spawnProcess,
    }),
    /could not be reaped within 50ms/,
  );
  assert.equal(spawnCalls, 2);
});

test("process cleanup rejects unbounded deadlines", async () => {
  const child = new EventEmitter() as any;
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  await assert.rejects(terminateProcessTree(child, "test", Infinity, 5), /Graceful cleanup timeout/);
  await assert.rejects(terminateProcessTree(child, "test", 5, Infinity), /Forced cleanup timeout/);
});
