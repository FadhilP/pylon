import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  AndroidEmulatorStartupCleanupError,
  AndroidSdk,
  OwnedEmulator,
  parseInstalledPackages,
  resolveAndroidSdk,
} from "pylon-android/android-sdk";
import { terminateProcessTree } from "pylon-android/process";

function packageSpawn(
  calls: string[][],
  output: string | Buffer,
  code = 0,
  stderr = "",
  onStart?: () => void,
  complete = true,
) {
  return ((_command: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 12345;
    child.exitCode = null;
    child.signalCode = null;
    let closed = false;
    const finish = (exitCode: number | null, signalCode: string | null = null) => {
      if (closed) return;
      closed = true;
      child.exitCode = exitCode;
      child.signalCode = signalCode;
      child.emit("exit", exitCode, signalCode);
      child.emit("close", exitCode, signalCode);
    };
    child.kill = () => {
      finish(null, "SIGTERM");
      return true;
    };
    queueMicrotask(() => {
      onStart?.();
      if (!complete) return;
      if (closed) return;
      child.stdout.write(output);
      if (closed) return;
      child.stdout.end();
      child.stderr.end(stderr);
      finish(code);
    });
    return child;
  }) as any;
}

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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Android SDK exposes only emulator attachment identities", async () => {
  const calls: string[][] = [];
  const exec = async (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "devices")
      return {
        code: 0,
        stdout: "List of devices attached\nemulator-5554 device product:sdk\nphysical-1 device product:phone\n",
        stderr: "",
        killed: false,
      };
    if (args.includes("avd")) return { code: 0, stdout: "Pixel_Test\nOK\n", stderr: "", killed: false };
    return { code: 0, stdout: "", stderr: "", killed: false };
  };
  const sdk = new AndroidSdk({ root: "root", adb: "adb", emulator: "emulator" }, exec as any);
  assert.deepEqual(await sdk.verifyAttached("emulator-5554"), { serial: "emulator-5554", avd: "Pixel_Test" });
  await assert.rejects(sdk.verifyAttached("physical-1"), /requires an emulator serial/);
  await assert.rejects(sdk.verifyAttached("emulator-5555"), /even console port/);
  assert.ok(calls.some(args => args.join(" ") === "-s emulator-5554 emu avd name"));
});

test("installed package inventory verifies identity and uses one fixed bounded adb query", async () => {
  const execCalls: string[][] = [];
  const packageCalls: string[][] = [];
  const exec = async (_command: string, args: string[]) => {
    execCalls.push(args);
    if (args[0] === "devices")
      return {
        code: 0,
        stdout: "List of devices attached\nemulator-5554 device product:sdk\n",
        stderr: "",
        killed: false,
      };
    return { code: 0, stdout: "Pixel_Test\nOK\n", stderr: "", killed: false };
  };
  const sdk = new AndroidSdk(
    { root: "root", adb: "adb", emulator: "emulator" },
    exec as any,
    packageSpawn(packageCalls, "package:com.example.app\r\npackage:android\r\npackage:com.example.app\r\n"),
  );
  assert.deepEqual(await sdk.listInstalledPackages("emulator-5554"), {
    serial: "emulator-5554",
    avd: "Pixel_Test",
    packages: ["android", "com.example.app"],
  });
  assert.deepEqual(packageCalls, [["-s", "emulator-5554", "shell", "pm", "list", "packages"]]);
  assert.ok(execCalls.some(args => args[0] === "devices"));
  assert.ok(execCalls.some(args => args.join(" ") === "-s emulator-5554 emu avd name"));
});

test("installed package parsing and capture fail closed", async () => {
  assert.deepEqual(parseInstalledPackages("package:com.zed\r\npackage:android\r\n"), ["android", "com.zed"]);
  for (const malformed of [
    "package:com.good\n\npackage:com.other",
    "warning\npackage:com.good",
    "package:com.exämple",
    "package:bad-name",
  ]) {
    assert.throws(() => parseInstalledPackages(malformed), /malformed/);
  }
  const maximum = Array.from({ length: 4_096 }, (_, index) => `package:com.package${index}`).join("\n");
  assert.equal(parseInstalledPackages(maximum).length, 4_096);
  assert.throws(() => parseInstalledPackages(`${maximum}\npackage:com.package4096`), /exceeds 4096 packages/);
  assert.deepEqual(parseInstalledPackages(Array.from({ length: 4_097 }, () => "package:com.same").join("\n")), [
    "com.same",
  ]);
  const exec = async (_command: string, args: string[]) =>
    args[0] === "devices"
      ? { code: 0, stdout: "List of devices attached\nemulator-5554 device\n", stderr: "", killed: false }
      : { code: 0, stdout: "Pixel_Test\nOK\n", stderr: "", killed: false };
  let terminations = 0;
  const sdk = new AndroidSdk(
    { root: "root", adb: "adb", emulator: "emulator" },
    exec as any,
    packageSpawn([], Buffer.alloc(128 * 1024 + 1, 0x61)),
    async child => {
      terminations++;
      child.kill();
    },
  );
  await assert.rejects(sdk.listInstalledPackages("emulator-5554"), /exceeds 128KB/);
  assert.equal(terminations, 1, "overflow must terminate immediately");
  const activeController = new AbortController();
  let abortTerminations = 0;
  const abortSdk = new AndroidSdk(
    { root: "root", adb: "adb", emulator: "emulator" },
    exec as any,
    packageSpawn([], "", 0, "", () => activeController.abort(), false),
    async child => {
      abortTerminations++;
      child.kill();
    },
  );
  await assert.rejects(abortSdk.listInstalledPackages("emulator-5554", activeController.signal), /cancelled/);
  assert.equal(abortTerminations, 1, "abort must terminate immediately");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sdk.listInstalledPackages("emulator-5554", controller.signal), /cancelled/);
});

test(
  "owned emulator cleanup kills only the tracked tree when AVD identity is unavailable or mismatched",
  { timeout: 20_000 },
  async () => {
    for (const identity of [undefined, "Other_AVD"]) {
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
      let serialKill = false,
        verified = false;
      const sdk = {
        async avdName() {
          if (identity === undefined) throw new Error("unavailable");
          return identity;
        },
        async runAdb() {
          serialKill = true;
          return "";
        },
        async verifySerialGone() {
          verified = true;
        },
        async terminateOwnedProcess(child: any, label: string, gracefulMs?: number, forceMs?: number) {
          await terminateProcessTree(child, label, gracefulMs, forceMs);
        },
      };
      await new OwnedEmulator(sdk as any, child, "emulator-5554", "Pixel_Test").stop();
      assert.equal(serialKill, false);
      assert.equal(verified, true);
      assert.ok(child.exitCode !== null || child.signalCode !== null);
    }
  },
);

test("uncertain startup cleanup never sends a serial-directed emulator kill", async () => {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  let adbCalls = 0;
  let terminations = 0;
  let verified = 0;
  const sdk = {
    async avdName() {
      return "Pixel_Test";
    },
    async runAdb() {
      adbCalls++;
      return "";
    },
    async terminateOwnedProcess(target: any) {
      terminations++;
      target.signalCode = "SIGTERM";
    },
    async verifySerialGone() {
      verified++;
    },
  };

  await new OwnedEmulator(sdk as any, child, "emulator-5554", "Pixel_Test").cleanupUncertainStart();
  assert.equal(adbCalls, 0);
  assert.equal(terminations, 1);
  assert.equal(verified, 1);
});

test("signal-terminated emulator handles are not treated as running", async () => {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = "SIGTERM";
  let mutations = 0;
  let verified = 0;
  const sdk = {
    async avdName() {
      mutations++;
      return "Pixel_Test";
    },
    async runAdb() {
      mutations++;
      return "";
    },
    async terminateOwnedProcess() {
      mutations++;
    },
    async verifySerialGone() {
      verified++;
    },
  };

  await new OwnedEmulator(sdk as any, child, "emulator-5554", "Pixel_Test").stop();
  assert.equal(mutations, 0);
  assert.equal(verified, 1);
});

test("injected SDK commands reject killed and oversized executor results", async () => {
  const limits: Array<number | undefined> = [];
  const killedSdk = new AndroidSdk({ root: "root", adb: "adb", emulator: "emulator" }, (async (
    _command: string,
    _args: string[],
    options?: { maxOutputBytes?: number },
  ) => {
    limits.push(options?.maxOutputBytes);
    return { code: 0, stdout: "partial", stderr: "", killed: true };
  }) as any);
  await assert.rejects(killedSdk.runAdb(["version"]), /cancelled/);
  await assert.rejects(killedSdk.listAvds(), /cancelled/);
  assert.deepEqual(limits, [256 * 1024, 64 * 1024]);

  const oversizedSdk = new AndroidSdk({ root: "root", adb: "adb", emulator: "emulator" }, (async (
    _command: string,
    args: string[],
  ) => ({
    code: 0,
    stdout: "x".repeat(args[0] === "-list-avds" ? 64 * 1024 + 1 : 256 * 1024 + 1),
    stderr: "",
  })) as any);
  await assert.rejects(oversizedSdk.runAdb(["version"]), /output exceeds 256KB/);
  await assert.rejects(oversizedSdk.listAvds(), /output exceeds 64KB/);
});

test("package-owned command capture terminates immediately on streamed overflow", async () => {
  let terminations = 0;
  const sdk = new AndroidSdk(
    { root: "root", adb: "adb", emulator: "emulator" },
    undefined,
    packageSpawn([], Buffer.alloc(256 * 1024 + 1, 0x61)),
    async child => {
      terminations++;
      child.kill();
    },
  );

  await assert.rejects(sdk.runAdb(["version"]), /output exceeds 256KB/);
  assert.equal(terminations, 1);
});

test("AVD and device inventories enforce structure and count bounds", async () => {
  const sdkForAvds = (stdout: string) =>
    new AndroidSdk({ root: "root", adb: "adb", emulator: "emulator" }, (async () => ({
      code: 0,
      stdout,
      stderr: "",
    })) as any);
  await assert.rejects(sdkForAvds("Pixel_Test\n\nOther").listAvds(), /malformed AVD inventory/);
  await assert.rejects(
    sdkForAvds(Array.from({ length: 1_025 }, (_, index) => `Pixel_${index}`).join("\n")).listAvds(),
    /exceeds 1024 entries/,
  );

  const devices = Array.from({ length: 513 }, (_, index) => `emulator-${6000 + index * 2} device`).join("\n");
  const deviceSdk = new AndroidSdk({ root: "root", adb: "adb", emulator: "emulator" }, (async () => ({
    code: 0,
    stdout: `List of devices attached\n${devices}\n`,
    stderr: "",
  })) as any);
  await assert.rejects(deviceSdk.devices(), /exceeds 512 entries/);
});

test("real SDK startup failures retain uncertain ownership for cleanup retry", async () => {
  const controller = new AbortController();
  const calls: string[][] = [];
  const phases: string[] = [];
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  let terminations = 0;
  const exec = async (command: string, args: string[]) => {
    calls.push(args);
    if (command === "emulator") return { code: 0, stdout: "Pixel_Test\n", stderr: "" };
    if (args[0] === "devices") return { code: 0, stdout: "List of devices attached\n", stderr: "" };
    return { code: 1, stdout: "", stderr: "unavailable" };
  };
  const sdk = new AndroidSdk(
    { root: "root", adb: "adb", emulator: "emulator" },
    exec as any,
    (() => {
      queueMicrotask(() => controller.abort());
      return child;
    }) as any,
    async target => {
      terminations++;
      if (terminations === 1) throw new Error("cleanup failed");
      (target as any).signalCode = "SIGTERM";
    },
  );

  const error = await sdk
    .start("Pixel_Test", false, controller.signal, 100, phase => phases.push(phase))
    .catch(value => value);
  assert.ok(error instanceof AndroidEmulatorStartupCleanupError);
  assert.equal(error.emulator.serial.startsWith("emulator-"), true);
  assert.deepEqual(phases, ["starting"]);
  assert.equal(
    calls.some(args => args.join(" ").endsWith("emu kill")),
    false,
  );

  await error.emulator.cleanupUncertainStart();
  assert.equal(terminations, 2);
});
