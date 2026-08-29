import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { AndroidSessionManager } from "../src/android-session.ts";

const avd = process.env.PI_HELIOS_ANDROID_AVD;
const packageName = process.env.PI_HELIOS_ANDROID_PACKAGE;
const live =
  process.env.PI_HELIOS_ANDROID_LIVE === "1" && Boolean(avd && packageName);
const attachSerial = process.env.PI_HELIOS_ANDROID_ATTACH_SERIAL;
const exec = (
  command: string,
  args: string[],
  options?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) =>
  new Promise<any>((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options?.cwd,
        signal: options?.signal,
        timeout: options?.timeout,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          code:
            typeof (error as any)?.code === "number"
              ? (error as any).code
              : error
                ? 1
                : 0,
          stdout,
          stderr,
          killed: Boolean((error as any)?.killed),
        }),
    );
  });

test(
  "live owned Android emulator and Appium workflow",
  { skip: !live, timeout: 360_000 },
  async () => {
    const manager = new AndroidSessionManager(exec);
    try {
      const started = await manager.start(
        "android-live",
        avd!,
        packageName!,
        process.env.PI_HELIOS_ANDROID_ACTIVITY,
        true,
      );
      assert.equal(started.ownership, "owned");
      assert.equal(
        (await manager.operate("android-live", { kind: "snapshot" }))
          .packageName,
        packageName,
      );
      assert.ok(
        (await manager.operate("android-live", { kind: "screenshot" }))
          .artifactPath,
      );
      await manager.close("android-live", "close");
    } finally {
      await manager.shutdown();
    }
  },
);

test(
  "live attached Android emulator and Appium workflow",
  { skip: !live || !attachSerial, timeout: 180_000 },
  async () => {
    const manager = new AndroidSessionManager(exec);
    try {
      const attached = await manager.attach(
        "android-live-attach",
        attachSerial!,
        packageName!,
        process.env.PI_HELIOS_ANDROID_ACTIVITY,
      );
      assert.equal(attached.ownership, "attached");
      assert.equal(
        (await manager.operate("android-live-attach", { kind: "snapshot" }))
          .packageName,
        packageName,
      );
      assert.ok(
        (await manager.operate("android-live-attach", { kind: "screenshot" }))
          .artifactPath,
      );
      await manager.close("android-live-attach", "detach");
    } finally {
      await manager.shutdown();
    }
  },
);
