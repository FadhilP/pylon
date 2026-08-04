import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { AndroidSdk, OwnedEmulator, resolveAndroidSdk } from "../src/android-sdk.ts";

test("Android SDK resolution uses canonical configured tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "helios-sdk-test-"));
  const executable = process.platform === "win32" ? ".exe" : "";
  const adb = join(root, "platform-tools", `adb${executable}`);
  const emulator = join(root, "emulator", `emulator${executable}`);
  try {
    await mkdir(join(root, "platform-tools"), { recursive: true });
    await mkdir(join(root, "emulator"), { recursive: true });
    await writeFile(adb, "test");
    await writeFile(emulator, "test");
    await chmod(adb, 0o700).catch(() => {});
    await chmod(emulator, 0o700).catch(() => {});
    const paths = await resolveAndroidSdk({ ANDROID_SDK_ROOT: root });
    assert.equal(paths.root, root);
    assert.equal(paths.adb, adb);
    assert.equal(paths.emulator, emulator);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Android SDK exposes only emulator attachment identities", async () => {
  const calls: string[][] = [];
  const exec = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "devices") return { code: 0, stdout: "List of devices attached\nemulator-5554 device product:sdk\nphysical-1 device product:phone\n", stderr: "", killed: false };
    if (args.includes("avd")) return { code: 0, stdout: "Pixel_Test\nOK\n", stderr: "", killed: false };
    return { code: 0, stdout: "", stderr: "", killed: false };
  };
  const sdk = new AndroidSdk({ root: "root", adb: "adb", emulator: "emulator" }, exec as any);
  assert.deepEqual(await sdk.verifyAttached("emulator-5554"), { serial: "emulator-5554", avd: "Pixel_Test" });
  await assert.rejects(sdk.verifyAttached("physical-1"), /requires an emulator serial/);
  await assert.rejects(sdk.verifyAttached("emulator-5555"), /even console port/);
  assert.ok(calls.some((args) => args.join(" ") === "-s emulator-5554 emu avd name"));
});

test("owned emulator cleanup kills only the tracked tree when AVD identity is unavailable or mismatched", { timeout: 20_000 }, async () => {
  for (const identity of [undefined, "Other_AVD"]) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      shell: false, stdio: "ignore", windowsHide: true, detached: process.platform !== "win32",
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    let serialKill = false, verified = false;
    const sdk = {
      async avdName() { if (identity === undefined) throw new Error("unavailable"); return identity; },
      async runAdb() { serialKill = true; return ""; },
      async verifySerialGone() { verified = true; },
    };
    await new OwnedEmulator(sdk as any, child, "emulator-5554", "Pixel_Test").stop();
    assert.equal(serialKill, false);
    assert.equal(verified, true);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }
});
