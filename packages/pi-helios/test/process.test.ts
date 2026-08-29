import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { terminateProcessTree, waitForExit } from "../src/process.ts";

test(
  "tracked process termination waits until the child exits",
  { timeout: 20_000 },
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await terminateProcessTree(child, "test child", 2_000, 5_000);
    assert.equal(await waitForExit(child, 100), true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  },
);
