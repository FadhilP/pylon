import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { AndroidRunner } from "pylon-android/android-runner";
import { resolveAndroidSdk } from "pylon-android/android-sdk";
import { AndroidAppDevice } from "pylon-android/apk-artifact";
import { AndroidPidLogcat, runAndroidBuildAndRun } from "pylon-android/app-runner";
import { createAndroidExec } from "pylon-android/android-exec";
import { discoverAndroidProject } from "pylon-android/project-discovery";

const enabled = process.env.PYLON_ANDROID_LIVE === "1";
const required = (name: string): string => {
  const value = process.env[name];
  assert.ok(value, `${name} is required for the opt-in Android live test`);
  return value;
};

test(
  "opt-in disposable AVD completes the Android Runner lifecycle",
  { skip: enabled ? false : "set PYLON_ANDROID_LIVE=1 to run", timeout: 20 * 60_000 },
  async () => {
    assert.equal(
      required("PYLON_ANDROID_LIVE_DISPOSABLE"),
      "YES",
      "live deployment requires an explicit disposable-AVD acknowledgement",
    );
    const workspaceInput = required("PYLON_ANDROID_LIVE_WORKSPACE");
    assert.ok(isAbsolute(workspaceInput), "PYLON_ANDROID_LIVE_WORKSPACE must be absolute");
    const workspace = await realpath(workspaceInput);
    const avd = required("PYLON_ANDROID_LIVE_AVD");
    const modulePath = required("PYLON_ANDROID_LIVE_MODULE");
    const variant = required("PYLON_ANDROID_LIVE_VARIANT");
    const discovery = await discoverAndroidProject(workspace);
    assert.ok(discovery.wrapper, discovery.issue ?? "a complete Gradle wrapper is required");
    assert.ok(
      discovery.modules.some(module => module.modulePath === modulePath && module.variants.includes(variant)),
      "the requested module and variant must be statically discovered",
    );

    const state = await mkdtemp(join(tmpdir(), "pylon-android-live-"));
    const runner = new AndroidRunner();
    let logcat: AndroidPidLogcat | undefined;
    try {
      const initial = await runner.refresh();
      assert.ok(initial.avds.includes(avd), `AVD is not configured: ${avd}`);
      assert.ok(
        !initial.devices.some(device => device.avd === avd),
        "the live-test AVD must be stopped so Pylon owns its process",
      );
      const cancelled = new AbortController();
      let sawBooting = false;
      const unsubscribe = runner.subscribe(event => {
        if (
          event.snapshot.devices.some(candidate => candidate.ownership === "runner" && candidate.state === "booting")
        ) {
          sawBooting = true;
          cancelled.abort();
        }
      });
      await assert.rejects(runner.startEmulator(avd, { signal: cancelled.signal }));
      unsubscribe();
      assert.equal(sawBooting, true);
      assert.ok(!runner.snapshot().devices.some(candidate => candidate.ownership === "runner"));
      const device = await runner.startEmulator(avd);
      assert.equal(device.ownership, "runner");
      assert.equal(device.state, "ready");
      assert.ok(device.serial);

      const sdk = await resolveAndroidSdk();
      const exec = createAndroidExec();
      const app = new AndroidAppDevice(sdk.adb, exec);
      const result = await runAndroidBuildAndRun(
        {
          build: {
            workspace: {
              canonicalRoot: workspace,
              wrapperPath: discovery.wrapper.executablePath,
              wrapperFingerprint: discovery.wrapper.fingerprint,
              modulePath,
              variant,
            },
            stateDirectory: join(state, "gradle"),
          },
          sdkRoot: sdk.root,
          stagingRoot: join(state, "staging"),
          serial: device.serial!,
        },
        { device: app, exec },
      );
      assert.equal(result.installed, true);
      assert.equal(result.installationIdentity.length, 64);

      const pids = await app.packagePids(device.serial!, result.artifact.packageName);
      assert.ok(pids.length > 0, "launched fixture app must expose a package process");
      logcat = new AndroidPidLogcat({ adb: sdk.adb, serial: device.serial!, pids });
      logcat.start();
      await new Promise(resolve => setTimeout(resolve, 1_000));
      assert.equal(logcat.state, "running");
      await logcat.stop();
      logcat = undefined;

      await app.forceStop(device.serial!, result.artifact.packageName);
      assert.equal(
        await app.installationIdentity(device.serial!, result.artifact.packageName),
        result.installationIdentity,
      );
      await app.launch(device.serial!, result.artifact.launchableComponent);
    } finally {
      await logcat?.stop().catch(() => undefined);
      await runner.dispose();
      await rm(state, { recursive: true, force: true });
    }
  },
);
