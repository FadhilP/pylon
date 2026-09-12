import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { lstat, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, spawn } from "node:child_process";
import {
  AndroidAppDevice,
  discoverAndroidApk,
  inspectAndroidApk,
  stageAndroidApk,
  resolveAndroidBuildTools,
  cleanupStaleAndroidStaging,
} from "pylon-android/apk-artifact";
import { AndroidBuildAndRunError, AndroidPidLogcat, runAndroidBuildAndRun } from "pylon-android/app-runner";

async function output(elements: unknown[]): Promise<{ root: string; apk: string }> {
  const root = await mkdtemp(join(tmpdir(), "pylon-apk-"));
  const directory = join(root, "app", "build", "outputs", "apk", "debug");
  await mkdir(directory, { recursive: true });
  const apk = join(directory, "app-debug.apk");
  await writeFile(apk, "apk");
  await writeFile(
    join(directory, "output-metadata.json"),
    JSON.stringify({ applicationId: "com.example.app", variantName: "debug", elements }),
  );
  return { root, apk };
}

test("APK discovery rejects split output and staging detects a replaced source", async () => {
  const fixture = await output([{ type: "SINGLE", filters: [], outputFile: "app-debug.apk" }]);
  try {
    const release = join(fixture.root, "app", "build", "outputs", "apk", "release");
    await mkdir(release, { recursive: true });
    await writeFile(join(release, "app-release.apk"), "apk");
    await writeFile(
      join(release, "output-metadata.json"),
      JSON.stringify({
        applicationId: "com.example.app",
        variantName: "release",
        elements: [{ type: "SINGLE", filters: [], outputFile: "app-release.apk" }],
      }),
    );
    const found = await discoverAndroidApk({ workspaceRoot: fixture.root, modulePath: ":app", variant: "debug" });
    await writeFile(fixture.apk, "replaced before staging");
    await assert.rejects(
      stageAndroidApk(found.sourcePath, join(fixture.root, ".private"), found.sourceIdentity),
      /changed before staging/,
    );
    const rediscovered = await discoverAndroidApk({
      workspaceRoot: fixture.root,
      modulePath: ":app",
      variant: "debug",
    });
    const staged = await stageAndroidApk(
      rediscovered.sourcePath,
      join(fixture.root, ".private"),
      rediscovered.sourceIdentity,
    );
    await writeFile(fixture.apk, "replaced after staging");
    await assert.rejects(staged.revalidate(), /changed before installation/);
    await staged.cleanup();
    await writeFile(
      join(fixture.root, "app", "build", "outputs", "apk", "debug", "output-metadata.json"),
      JSON.stringify({
        applicationId: "com.example.app",
        variantName: "debug",
        elements: [
          { type: "SINGLE", filters: [], outputFile: "app-debug.apk" },
          { type: "SINGLE", filters: [], outputFile: "other.apk" },
        ],
      }),
    );
    await assert.rejects(
      discoverAndroidApk({ workspaceRoot: fixture.root, modulePath: ":app", variant: "debug" }),
      /malformed or ambiguous/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("fixed Flutter output discovery ignores nested stale metadata and binds the exact top-level APK", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-flutter-apk-"));
  const outputRoot = join(root, "build", "app", "outputs", "apk", "debug");
  const apk = join(outputRoot, "app-debug.apk");
  const metadata = join(outputRoot, "output-metadata.json");
  const stale = join(outputRoot, "old");
  const input = {
    workspaceRoot: root,
    modulePath: ":app",
    variant: "debug",
    outputRoot,
    expectedOutputFile: "app-debug.apk",
  };
  try {
    await mkdir(stale, { recursive: true });
    await writeFile(apk, "current");
    await writeFile(join(stale, "app-debug.apk"), "stale");
    const record = (applicationId: string) =>
      JSON.stringify({
        applicationId,
        variantName: "debug",
        elements: [{ type: "SINGLE", filters: [], outputFile: "app-debug.apk" }],
      });
    await writeFile(metadata, record("com.example.current"));
    await writeFile(join(stale, "output-metadata.json"), record("com.example.stale"));
    const found = await discoverAndroidApk(input);
    assert.equal(found.sourcePath, apk);
    assert.equal(found.packageName, "com.example.current");
    await rm(metadata);
    await assert.rejects(discoverAndroidApk(input), /unsafe|unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("fixed Flutter output rejects a linked output ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-flutter-link-root-"));
  const outside = await mkdtemp(join(tmpdir(), "pylon-flutter-link-outside-"));
  try {
    await mkdir(join(outside, "app", "outputs", "apk", "debug"), { recursive: true });
    await symlink(outside, join(root, "build"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      discoverAndroidApk({
        workspaceRoot: root,
        modulePath: ":app",
        variant: "debug",
        outputRoot: join(root, "build", "app", "outputs", "apk", "debug"),
        expectedOutputFile: "app-debug.apk",
      }),
      /escapes workspace|unsafe/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("stale staging cleanup unlinks owned link entries without traversing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-stage-"));
  const staging = join(root, "staging");
  try {
    await mkdir(join(staging, "apk-old"), { recursive: true });
    await writeFile(join(staging, "apk-old", "data"), "x");
    if (process.platform !== "win32") {
      await symlink(root, join(staging, "apk-link"));
    }
    await cleanupStaleAndroidStaging(staging);
    await assert.rejects(lstat(join(staging, "apk-old")));
    if (process.platform !== "win32") await assert.rejects(lstat(join(staging, "apk-link")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inspection uses fixed tools, requires one signer, and device commands remain narrow", async () => {
  const fixture = await output([{ type: "SINGLE", filters: [], outputFile: "app-debug.apk" }]);
  try {
    const staged = await stageAndroidApk(fixture.apk, join(fixture.root, ".private"));
    const calls: string[][] = [];
    const exec = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "dump")
        return {
          code: 0,
          stderr: "",
          stdout:
            "package: name='com.example.app' versionCode='1' versionName='1.0'\nsdkVersion:'23'\ntargetSdkVersion:'35'\napplication-debuggable\nlaunchable-activity: name='.MainActivity'\n",
        };
      if (args[0] === "verify")
        return {
          code: 0,
          stderr: "",
          stdout:
            "Signer #1 certificate SHA-256 digest: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
        };
      if (args.includes("sha256sum")) return { code: 0, stderr: "", stdout: `${"a".repeat(64)}  /data/app/x.apk\n` };
      if (args.includes("ps"))
        return {
          code: 0,
          stderr: "",
          stdout: "PID NAME\n12 com.example.app\n13 com.example.app:remote\n99 other.app\n",
        };
      return { code: 0, stderr: "", stdout: args.includes("pm") ? "package:/data/app/x.apk\n" : "Success\n" };
    };
    const inspected = await inspectAndroidApk(
      staged,
      { root: fixture.root, version: "35.0.0", aapt2: "aapt2", apksigner: "apksigner" },
      exec,
    );
    assert.equal(inspected.launchableComponent, "com.example.app/com.example.app.MainActivity");
    const device = new AndroidAppDevice("adb", exec);
    assert.equal(await device.isPackageInstalled("emulator-5554", "com.example.app"), true);
    assert.equal((await device.installationIdentity("emulator-5554", "com.example.app")).length, 64);
    await device.install("emulator-5554", staged.path);
    await device.launch("emulator-5554", inspected.launchableComponent);
    assert.deepEqual(await device.packagePids("emulator-5554", "com.example.app"), [12, 13]);
    assert.deepEqual(
      calls.find(args => args.includes("install")),
      ["-s", "emulator-5554", "install", "-r", staged.path],
    );
    await assert.rejects(device.launch("emulator-5554", "com.example.app/Bad;component"), /component/);
    await assert.rejects(
      inspectAndroidApk(
        staged,
        { root: fixture.root, version: "35.0.0", aapt2: "aapt2", apksigner: "apksigner" },
        async (_command, args) =>
          args[0] === "dump"
            ? {
                code: 0,
                stderr: "",
                stdout:
                  "package: name='other.app' versionCode='1' versionName='1'\nsdkVersion:'1'\ntargetSdkVersion:'1'\nlaunchable-activity: name='.Main'\n",
              }
            : {
                code: 0,
                stderr: "",
                stdout:
                  "Signer #1 certificate SHA-256 digest: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\nSigner #2 certificate DN: CN=other\n",
              },
        undefined,
        "com.example.app",
      ),
      /does not match AGP|exactly one/,
    );
    await staged.cleanup();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("build coordinator gates each side effect, cleans staging after install, and reports launch as installed", async () => {
  const fixture = await output([{ type: "SINGLE", filters: [], outputFile: "app-debug.apk" }]);
  const phases: string[] = [];
  let stagedPath = "";
  let gates = 0;
  try {
    let packageQueries = 0;
    const exec = async (_command: string, args: string[]) => {
      if (args[0] === "dump")
        return {
          code: 0,
          stderr: "",
          stdout:
            "package: name='com.example.app' versionCode='1' versionName='1'\nsdkVersion:'23'\ntargetSdkVersion:'35'\nlaunchable-activity: name='.Main'\n",
        };
      if (args[0] === "verify")
        return {
          code: 0,
          stderr: "",
          stdout:
            "Signer #1 certificate SHA-256 digest: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
        };
      if (args.includes("pm"))
        return { code: 0, stderr: "", stdout: packageQueries++ ? "package:/data/app/x.apk\n" : "" };
      if (args.includes("sha256sum")) return { code: 0, stderr: "", stdout: `${"b".repeat(64)}  /data/app/x.apk\n` };
      if (args.includes("start")) return { code: 1, stderr: "launch failed", stdout: "" };
      return { code: 0, stderr: "", stdout: "Success" };
    };
    await assert.rejects(
      runAndroidBuildAndRun(
        {
          build: {
            workspace: {
              canonicalRoot: fixture.root,
              wrapperPath: join(fixture.root, "gradlew"),
              wrapperFingerprint: "x",
              modulePath: ":app",
              variant: "debug",
            },
            stateDirectory: join(fixture.root, "state"),
          },
          sdkRoot: fixture.root,
          buildToolsVersion: "35.0.0",
          stagingRoot: join(fixture.root, ".private"),
          serial: "emulator-5554",
          revalidate: () => {
            gates++;
          },
          onPhase: phase => phases.push(phase),
        },
        {
          device: new AndroidAppDevice("adb", exec),
          exec,
          buildRunner: async () => ({
            task: "assembleDebug",
            code: 0,
            succeeded: true,
            cancelled: false,
            timedOut: false,
            output: "",
            truncated: false,
          }),
          resolveTools: async () => ({ root: fixture.root, version: "35.0.0", aapt2: "aapt2", apksigner: "apksigner" }),
          stage: async (source, root) => {
            const staged = await stageAndroidApk(source, root);
            stagedPath = staged.path;
            return staged;
          },
        },
      ),
      (error: unknown) =>
        error instanceof AndroidBuildAndRunError &&
        error.phase === "launching" &&
        error.installed &&
        error.artifact?.packageName === "com.example.app" &&
        error.artifact.sha256.length === 64,
    );
    assert.deepEqual(phases, ["building", "finding-artifact", "staging", "inspecting", "installing", "launching"]);
    assert.equal(gates, 6);
    await assert.rejects(lstat(stagedPath));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Flutter coordinator forces the fixed output to rebuild and deploys only the resulting APK", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-flutter-run-"));
  const outputRoot = join(root, "build", "app", "outputs", "apk", "debug");
  const apk = join(outputRoot, "app-debug.apk");
  const metadata = join(outputRoot, "output-metadata.json");
  let packageQueries = 0;
  try {
    await mkdir(outputRoot, { recursive: true });
    await writeFile(apk, "old");
    await writeFile(metadata, "old metadata");
    const exec = async (_command: string, args: string[]) => {
      if (args[0] === "dump")
        return {
          code: 0,
          stderr: "",
          stdout:
            "package: name='com.example.flutter' versionCode='1' versionName='1'\nsdkVersion:'23'\ntargetSdkVersion:'35'\napplication-debuggable\nlaunchable-activity: name='.Main'\n",
        };
      if (args[0] === "verify")
        return { code: 0, stderr: "", stdout: `Signer #1 certificate SHA-256 digest: ${"a".repeat(64)}\n` };
      if (args.includes("pm"))
        return { code: 0, stderr: "", stdout: packageQueries++ ? "package:/data/app/flutter.apk\n" : "" };
      if (args.includes("sha256sum")) return { code: 0, stderr: "", stdout: `${"b".repeat(64)}  flutter.apk\n` };
      return { code: 0, stderr: "", stdout: "Success" };
    };
    const result = await runAndroidBuildAndRun(
      {
        build: {
          workspace: {
            canonicalRoot: root,
            wrapperPath: join(root, "gradlew"),
            wrapperFingerprint: "x",
            modulePath: ":app",
            variant: "debug",
          },
          stateDirectory: join(root, "state"),
          forceRerun: true,
        },
        artifact: {
          workspaceRoot: root,
          modulePath: ":app",
          variant: "debug",
          outputRoot,
          expectedOutputFile: "app-debug.apk",
        },
        sdkRoot: root,
        buildToolsVersion: "35.0.0",
        stagingRoot: join(root, ".private"),
        serial: "emulator-5554",
        revalidate: () => undefined,
        onPhase: () => undefined,
      },
      {
        device: new AndroidAppDevice("adb", exec),
        exec,
        buildRunner: async input => {
          assert.equal(input.forceRerun, true);
          assert.equal((await lstat(apk)).isFile(), true);
          assert.equal((await lstat(metadata)).isFile(), true);
          await writeFile(apk, "new");
          await writeFile(
            metadata,
            JSON.stringify({
              applicationId: "com.example.flutter",
              variantName: "debug",
              elements: [{ type: "SINGLE", filters: [], outputFile: "app-debug.apk" }],
            }),
          );
          return {
            task: ":app:assembleDebug",
            code: 0,
            succeeded: true,
            cancelled: false,
            timedOut: false,
            output: "",
            truncated: false,
          };
        },
        resolveTools: async () => ({ root, version: "35.0.0", aapt2: "aapt2", apksigner: "apksigner" }),
      },
    );
    assert.equal(result.artifact.packageName, "com.example.flutter");
    assert.equal(result.installed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cancelled middle Flutter output waiter settles promptly without bypassing the active build", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-flutter-lock-"));
  const outputRoot = join(root, "build", "app", "outputs", "apk", "debug");
  const base = (signal?: AbortSignal) => ({
    build: {
      workspace: {
        canonicalRoot: root,
        wrapperPath: join(root, "gradlew"),
        wrapperFingerprint: "x",
        modulePath: ":app",
        variant: "debug",
      },
      stateDirectory: join(root, "state"),
      signal,
    },
    artifact: {
      workspaceRoot: root,
      modulePath: ":app",
      variant: "debug",
      outputRoot,
      expectedOutputFile: "app-debug.apk",
    },
    sdkRoot: root,
    stagingRoot: join(root, ".private"),
    serial: "emulator-5554",
  });
  const failedBuild = {
    task: ":app:assembleDebug",
    code: 1,
    succeeded: false,
    cancelled: false,
    timedOut: false,
    output: "",
    truncated: false,
  };
  let releaseFirst!: () => void;
  let firstStarted = false;
  let thirdStarted = false;
  const device = new AndroidAppDevice("adb", async () => ({ code: 0, stdout: "", stderr: "" }));
  try {
    const first = runAndroidBuildAndRun(base(), {
      device,
      buildRunner: () => {
        firstStarted = true;
        return new Promise(resolve => {
          releaseFirst = () => resolve(failedBuild);
        });
      },
    });
    void first.catch(() => undefined);
    while (!firstStarted) await new Promise(resolve => setImmediate(resolve));
    const middleController = new AbortController();
    const middle = runAndroidBuildAndRun(base(middleController.signal), {
      device,
      buildRunner: async () => failedBuild,
    });
    const third = runAndroidBuildAndRun(base(), {
      device,
      buildRunner: async () => {
        thirdStarted = true;
        return failedBuild;
      },
    });
    void third.catch(() => undefined);
    middleController.abort();
    await assert.rejects(middle, /failed during building/);
    assert.equal(thirdStarted, false);
    releaseFirst();
    await assert.rejects(first, /failed during building/);
    while (!thirdStarted) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(third, /failed during building/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("coordinator forwards one abort signal and cancels at the gate before discovery", async () => {
  const fixture = await output([{ type: "SINGLE", filters: [], outputFile: "app-debug.apk" }]);
  const controller = new AbortController();
  let buildSignal: AbortSignal | undefined;
  let staged = false;
  let gates = 0;
  try {
    await assert.rejects(
      runAndroidBuildAndRun(
        {
          build: {
            workspace: {
              canonicalRoot: fixture.root,
              wrapperPath: join(fixture.root, "gradlew"),
              wrapperFingerprint: "x",
              modulePath: ":app",
              variant: "debug",
            },
            stateDirectory: join(fixture.root, "state"),
          },
          sdkRoot: fixture.root,
          stagingRoot: join(fixture.root, ".private"),
          serial: "emulator-5554",
          signal: controller.signal,
          revalidate: () => {
            if (++gates === 2) controller.abort();
          },
        },
        {
          device: new AndroidAppDevice("adb", async () => ({ code: 0, stdout: "", stderr: "" })),
          exec: async () => ({ code: 0, stdout: "", stderr: "" }),
          buildRunner: async input => {
            buildSignal = input.signal;
            return {
              task: "x",
              code: 0,
              succeeded: true,
              cancelled: false,
              timedOut: false,
              output: "",
              truncated: false,
            };
          },
          stage: async () => {
            staged = true;
            throw new Error("unexpected");
          },
        },
      ),
      (error: unknown) => error instanceof AndroidBuildAndRunError && error.phase === "finding-artifact",
    );
    assert.equal(buildSignal, controller.signal);
    assert.equal(staged, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Build Tools selects newest complete version with platform-specific fixed filenames", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-tools-"));
  try {
    for (const version of ["34.0.0", "35.0.0"]) await mkdir(join(root, "build-tools", version), { recursive: true });
    await writeFile(join(root, "build-tools", "34.0.0", "aapt2"), "tool");
    await writeFile(join(root, "build-tools", "34.0.0", "apksigner"), "tool");
    await writeFile(join(root, "build-tools", "35.0.0", "aapt2"), "tool");
    const tools = await resolveAndroidBuildTools(root, undefined, "linux");
    assert.equal(tools.version, "34.0.0");
    await writeFile(join(root, "build-tools", "35.0.0", "aapt2.exe"), "tool");
    await writeFile(join(root, "build-tools", "35.0.0", "apksigner.bat"), "tool");
    assert.equal((await resolveAndroidBuildTools(root, "35.0.0", "win32")).aapt2.endsWith("aapt2.exe"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PID logcat starts only on demand and bounds/sanitizes its retained output", async () => {
  let invocation: string[] | undefined;
  const states: string[] = [];
  const data: string[] = [];
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 1,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: 0,
    signalCode: null,
    kill: () => true,
  });
  const logcat = new AndroidPidLogcat({
    adb: "adb",
    serial: "emulator-5554",
    pid: 42,
    spawnProcess: ((_exe: string, args: string[]) => {
      invocation = args;
      return child;
    }) as unknown as typeof spawn,
  });
  logcat.on("state", state => states.push(state));
  logcat.on("data", value => data.push(value));
  assert.equal(invocation, undefined);
  logcat.start();
  child.stdout?.emit("data", Buffer.from("hel"));
  assert.equal(logcat.tail(), "hel");
  child.stdout?.emit("data", Buffer.from("lo\n" + "x".repeat(20_000)));
  assert.deepEqual(invocation, ["-s", "emulator-5554", "logcat", "--pid=42", "-v", "brief"]);
  assert.match(logcat.tail(), /hello/);
  assert.doesNotMatch(logcat.tail(), /\u001b|\u0000/);
  assert.match(logcat.tail(), /truncated/);
  assert.ok(data.length >= 2);
  await logcat.refreshPids([42, 43]);
  assert.deepEqual(invocation, ["-s", "emulator-5554", "logcat", "--pid=42", "--pid=43", "-v", "brief"]);
  assert.equal(logcat.state, "running");
  await logcat.dispose();
  assert.deepEqual(states, ["running", "stopped", "running", "stopped", "disposed"]);
});

test("PID logcat retains cleanup authority when termination must be retried", async () => {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 2,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: () => true,
  });
  let attempts = 0;
  const logcat = new AndroidPidLogcat({
    adb: "adb",
    serial: "emulator-5554",
    pid: 42,
    spawnProcess: (() => child) as unknown as typeof spawn,
    terminateProcess: async () => {
      if (++attempts === 1) throw new Error("cleanup failed");
      child.emit("close", 0, null);
    },
  });
  logcat.start();
  await assert.rejects(logcat.stop(), /cleanup failed/);
  assert.equal(logcat.state, "running");
  await logcat.stop();
  assert.equal(attempts, 2);
  assert.equal(logcat.state, "stopped");
});
