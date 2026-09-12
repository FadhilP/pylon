import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidRunner, type AndroidRunnerSnapshot, type AndroidSdkController } from "pylon-android/android-runner";
import {
  PylonAndroidHost,
  type AndroidHostAppRuntime,
  type AndroidHostLogcat,
} from "../src/server/android/pylon-android-host.ts";
import { AndroidEventJournal } from "../src/server/android/android-event-journal.ts";
import { AndroidSettingsStore } from "../src/server/android/android-settings-store.ts";
import { refreshPackageLogcatPids } from "../src/server/android/android-app-runtime.ts";

const ids = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
];

function projectDiscovery(canonicalRoot: string, fingerprint = "a".repeat(64)) {
  return {
    canonicalRoot,
    candidates: [
      {
        candidateId: "root",
        kind: "gradle" as const,
        label: "Project",
        workspaceRelativePath: ".",
        candidateRoot: canonicalRoot,
        canonicalRoot,
        androidRoot: canonicalRoot,
        settingsFile: "settings.gradle.kts" as const,
        wrapper: {
          executablePath: join(canonicalRoot, "gradlew"),
          executableRelativePath: "gradlew" as const,
          fingerprint,
          files: [],
        },
        modules: [{ modulePath: ":app", variants: ["debug", "release"] }],
      },
    ],
  };
}

function runnerHarness() {
  let starts = 0;
  let stops = 0;
  const sdk: AndroidSdkController = {
    async listAvds() {
      return ["Pixel_External", "Pixel_Owned"];
    },
    async devices() {
      return [{ serial: "emulator-5554", state: "device" }];
    },
    async avdName() {
      return "Pixel_External";
    },
    async start(avd) {
      starts++;
      return {
        serial: "emulator-5556",
        avd,
        async stop() {
          stops++;
        },
        async cleanupUncertainStart() {
          stops++;
        },
      };
    },
  };
  let nextDevice = 0;
  return {
    runner: new AndroidRunner({ createSdk: async () => sdk, idFactory: () => `device-${++nextDevice}` }),
    starts: () => starts,
    stops: () => stops,
  };
}

test("PylonAndroidHost keeps device commands revisioned, idempotent, and ownership-safe", async () => {
  const harness = runnerHarness();
  const host = new PylonAndroidHost(harness.runner);
  const events: number[] = [];
  host.subscribe(event => events.push(event.sequence));

  const discovered = await host.snapshot();
  assert.equal(discovered.runner.discovery, "ready");
  assert.equal(discovered.runner.devices[0].ownership, "external");
  const initialReplay = host.replay(host.cursor(0));
  assert.equal(initialReplay.ok && initialReplay.events.length, 2);

  const start = {
    type: "startEmulator" as const,
    commandId: ids[0],
    expectedServiceRevision: discovered.serviceRevision,
    avd: "Pixel_Owned",
  };
  const accepted = await host.command(start);
  const duplicate = await host.command(start);
  assert.deepEqual(duplicate, accepted);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.starts(), 1);

  assert.throws(() => host.command({ ...start, avd: "Pixel_External" }), /reused with different input/);
  assert.throws(
    () => host.command({ ...start, commandId: ids[1], expectedServiceRevision: discovered.serviceRevision }),
    /service revision is stale/,
  );

  const current = await host.snapshot(false);
  const external = current.runner.devices.find(device => device.ownership === "external")!;
  await assert.rejects(
    host.command({
      type: "stopEmulator",
      commandId: ids[2],
      expectedServiceRevision: current.serviceRevision,
      deviceId: external.deviceId,
      deviceRevision: external.revision,
    }),
    /runner-owned/,
  );

  await host.dispose();
  assert.equal(harness.stops(), 1);
  assert.ok(events.length >= 4);
});

test("PylonAndroidHost lets cancellation bypass a queued refresh", async () => {
  let observedAbort = false;
  const runner = new AndroidRunner({
    createSdk: async () => ({
      async listAvds() {
        return ["Pixel_Slow"];
      },
      async devices() {
        return [];
      },
      async avdName() {
        throw new Error("unused");
      },
      async start(_avd, _headless, signal) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new Error("startup cancelled"));
            },
            { once: true },
          );
        });
      },
    }),
    idFactory: () => "device-slow",
  });
  const host = new PylonAndroidHost(runner);
  const initial = await host.snapshot();
  await host.command({
    type: "startEmulator",
    commandId: ids[3],
    expectedServiceRevision: initial.serviceRevision,
    avd: "Pixel_Slow",
  });
  const starting = await host.snapshot(false);
  const device = starting.runner.devices[0];
  assert.ok(device);

  const refreshing = host.command({
    type: "refresh",
    commandId: ids[4],
    expectedServiceRevision: starting.serviceRevision,
  });
  await host.command({
    type: "cancelOperation",
    commandId: ids[5],
    expectedServiceRevision: starting.serviceRevision,
    deviceId: device.deviceId,
    deviceRevision: device.revision,
  });

  await refreshing;
  assert.equal(observedAbort, true);
  assert.equal((await host.snapshot(false)).runner.discovery, "ready");
  await host.dispose();
});

test("PylonAndroidHost binds configuration, trust, build, and cancellation to one workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-android-host-project-"));
  const settings = new AndroidSettingsStore(":memory:");
  let wrapperFingerprint = "a".repeat(64);
  let acceptedRoot: string | undefined;
  let finishBuild: ((cancelled: boolean) => void) | undefined;
  let ignoreBuildAbort = false;
  const runner = new AndroidRunner({
    createSdk: async () => {
      throw new Error("unused");
    },
  });
  const host = new PylonAndroidHost(runner, {
    settingsStore: settings,
    buildStateDirectory: join(root, "state"),
    buildCleanupTimeoutMs: 10,
    workspaceProvider: expectedGeneration => ({
      projectId: "project-1",
      sessionId: "session-1",
      sessionGeneration: expectedGeneration,
      root,
      registeredRoot: root,
      workspaceKind: "project-folder",
      workspaceLabel: "Project",
    }),
    discoverProject: async canonicalRoot => projectDiscovery(canonicalRoot, wrapperFingerprint),
    runBuild: input => {
      acceptedRoot = input.workspace.canonicalRoot;
      return new Promise(resolve => {
        finishBuild = cancelled =>
          resolve({
            task: ":app:assembleDebug",
            code: cancelled ? 143 : 0,
            succeeded: !cancelled,
            cancelled,
            timedOut: false,
            output: "",
            truncated: false,
          });
        input.signal?.addEventListener(
          "abort",
          () => {
            if (!ignoreBuildAbort) finishBuild?.(true);
          },
          { once: true },
        );
      });
    },
  });
  try {
    let current = await host.snapshot(false);
    current = (
      await host.command({
        type: "refreshProject",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        expectedGeneration: 1,
      })
    ).snapshot;
    assert.equal(current.project?.discovery, "ready");

    current = (
      await host.command({
        type: "saveRunConfiguration",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        expectedGeneration: 1,
        expectedConfigRevision: 0,
        candidateId: "root",
        modulePath: ":app",
        variant: "debug",
      })
    ).snapshot;
    assert.equal(current.project?.configuration?.revision, 1);

    current = (
      await host.command({
        type: "setWorkspaceTrust",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        expectedGeneration: 1,
        expectedConfigRevision: 1,
        expectedTrustRevision: 0,
        trusted: true,
      })
    ).snapshot;
    assert.equal(current.project?.trust.status, "trusted");

    current = (
      await host.command({
        type: "build",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        expectedGeneration: 1,
        configRevision: 1,
        trustRevision: 1,
      })
    ).snapshot;
    assert.equal(current.build?.state, "running");
    assert.equal(acceptedRoot, root);

    await host.command({
      type: "cancelBuild",
      commandId: randomUUID(),
      expectedServiceRevision: current.serviceRevision,
      operationId: current.build!.operationId,
      operationRevision: current.build!.revision,
    });
    await new Promise(resolve => setImmediate(resolve));
    current = await host.snapshot(false);
    assert.equal(current.build?.state, "cancelled");

    wrapperFingerprint = "b".repeat(64);
    current = (
      await host.command({
        type: "refreshProject",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        expectedGeneration: 1,
      })
    ).snapshot;
    assert.equal(current.project?.trust.status, "stale");
    await assert.rejects(
      host.command({
        type: "build",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        expectedGeneration: 1,
        configRevision: 1,
        trustRevision: 1,
      }),
      /not trusted/,
    );

    current = await host.snapshot(false);
    current = (
      await host.command({
        type: "setWorkspaceTrust",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        expectedGeneration: 1,
        expectedConfigRevision: 1,
        expectedTrustRevision: 1,
        trusted: true,
      })
    ).snapshot;
    assert.equal(current.project?.trust.status, "trusted");
    ignoreBuildAbort = true;
    current = (
      await host.command({
        type: "build",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        expectedGeneration: 1,
        configRevision: 1,
        trustRevision: 2,
      })
    ).snapshot;
    assert.equal(current.build?.state, "running");
    await assert.rejects(
      host.dispose(),
      error =>
        error instanceof AggregateError &&
        error.errors.some(
          item => item instanceof Error && /build cleanup did not finish within 10ms/.test(item.message),
        ),
    );
  } finally {
    finishBuild?.(true);
    await host.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("package Logcat stops on app exit and restarts only with freshly resolved PIDs", async () => {
  let pids: number[] = [];
  let state: "running" | "stopped" = "running";
  let starts = 0;
  let stops = 0;
  let refreshed: readonly number[] = [];
  const device = { packagePids: async () => pids };
  const logcat = {
    get state() {
      return state;
    },
    start() {
      starts++;
      state = "running";
    },
    async stop() {
      stops++;
      state = "stopped";
    },
    async refreshPids(next: readonly number[]) {
      refreshed = next;
    },
  };
  await refreshPackageLogcatPids(device as any, logcat as any, "emulator-5554", "com.example.app");
  assert.equal(stops, 1);
  assert.equal(starts, 0);
  pids = [42];
  await refreshPackageLogcatPids(device as any, logcat as any, "emulator-5554", "com.example.app");
  assert.deepEqual(refreshed, [42]);
  assert.equal(starts, 1);
});

test("PylonAndroidHost runs, stops, relaunches, and clears package-scoped logs by retained identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-android-host-run-"));
  const settings = new AndroidSettingsStore(":memory:");
  settings.saveConfiguration("project-1", 0, ":app", "debug");
  settings.setTrust("project-1", 0, {
    trusted: true,
    configRevision: 1,
    registeredRoot: root,
    workspaceRoot: root,
    wrapperRelativePath: "gradlew",
    wrapperFingerprint: "a".repeat(64),
  });
  const sdk: AndroidSdkController = {
    listAvds: async () => ["Pixel_Test"],
    devices: async () => [{ serial: "emulator-5554", state: "device" }],
    avdName: async () => "Pixel_Test",
    start: async () => {
      throw new Error("unused");
    },
  };
  let stoppedPackage = "";
  let relaunchedComponent = "";
  let logOutput = "local secret";
  let logStopped = false;
  let publishLogs: (() => void) | undefined;
  const logcat: AndroidHostLogcat = {
    snapshot: () => ({ output: logOutput, truncated: false }),
    subscribe: listener => {
      publishLogs = listener;
      return () => {
        publishLogs = undefined;
      };
    },
    stop: async () => {
      logStopped = true;
    },
    clear: () => {
      logOutput = "";
    },
  };
  const artifact = {
    sha256: "b".repeat(64),
    bytes: 3,
    packageName: "com.example.app",
    versionCode: "1",
    versionName: "1.0",
    minSdk: "23",
    targetSdk: "35",
    signingCertificateSha256: "c".repeat(64),
    launcherComponent: "com.example.app/com.example.app.MainActivity",
    debuggable: true,
  };
  const appRuntime: AndroidHostAppRuntime = {
    buildAndRun: async input => {
      await input.revalidate();
      input.onPhase("finding-artifact");
      input.onPhase("inspecting");
      input.onPhase("installing");
      await input.revalidate();
      input.onPhase("launching");
      await input.revalidate();
      return { artifact, installed: true, replacementInstall: true, installationIdentity: "installed-apk" };
    },
    forceStop: async (_serial, packageName) => {
      stoppedPackage = packageName;
    },
    relaunch: async (_serial, component) => {
      relaunchedComponent = component;
    },
    validateInstallation: async (_serial, _packageName, identity) => {
      assert.equal(identity, "installed-apk");
    },
    startLogs: async () => logcat,
  };
  let workspaceValidations = 0;
  const runner = new AndroidRunner({ createSdk: async () => sdk, idFactory: () => "device-external" });
  const host = new PylonAndroidHost(runner, {
    settingsStore: settings,
    buildStateDirectory: join(root, "build"),
    stagingStateDirectory: join(root, "staging"),
    appRuntime,
    workspaceValidator: () => {
      workspaceValidations++;
    },
    workspaceProvider: expectedGeneration => ({
      projectId: "project-1",
      sessionId: "session-1",
      sessionGeneration: expectedGeneration,
      root,
      registeredRoot: root,
      workspaceKind: "project-folder",
      workspaceLabel: "Project",
    }),
    discoverProject: async canonicalRoot => projectDiscovery(canonicalRoot),
  });
  try {
    let current = await host.snapshot();
    const device = current.runner.devices[0];
    current = (
      await host.command({
        type: "buildAndRun",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        expectedGeneration: 1,
        configRevision: 1,
        trustRevision: 1,
        deviceId: device.deviceId,
        deviceRevision: device.revision,
      })
    ).snapshot;
    while (["building", "inspecting", "installing", "launching"].includes(current.run?.phase ?? "")) {
      await new Promise(resolve => setImmediate(resolve));
      current = await host.snapshot(false);
    }
    assert.equal(current.run?.phase, "running");
    assert.equal(current.run?.artifact?.packageName, "com.example.app");
    assert.equal(current.run?.replacementInstall, true);
    assert.ok(workspaceValidations >= 3);

    current = (
      await host.command({
        type: "stopApp",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        runId: current.run!.runId,
        runRevision: current.run!.revision,
      })
    ).snapshot;
    assert.equal(stoppedPackage, "com.example.app");
    assert.equal(current.run?.phase, "stopped");

    current = (
      await host.command({
        type: "relaunchApp",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        runId: current.run!.runId,
        runRevision: current.run!.revision,
      })
    ).snapshot;
    assert.equal(relaunchedComponent, artifact.launcherComponent);
    assert.equal(current.run?.phase, "running");

    current = (
      await host.command({
        type: "startLogs",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        runId: current.run!.runId,
        runRevision: current.run!.revision,
      })
    ).snapshot;
    assert.equal(current.run?.logs.output, "local secret");
    const cursor = host.cursor(current.sequence);
    logOutput = '\\"'.repeat(600_000);
    assert.doesNotThrow(() => publishLogs?.());
    current = await host.snapshot(false);
    assert.equal(current.run?.logs.outputTruncated, true);
    assert.ok(Buffer.byteLength(current.run?.logs.output ?? "") <= 384 * 1024);
    const replay = host.replay(cursor);
    assert.equal(replay.ok, true);
    if (replay.ok) assert.ok(Buffer.byteLength(JSON.stringify(replay.events.at(-1))) <= 2 * 1024 * 1024);
    current = (
      await host.command({
        type: "clearRetainedOutput",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        runId: current.run!.runId,
        runRevision: current.run!.revision,
      })
    ).snapshot;
    assert.equal(current.run?.logs.output, "");
  } finally {
    await host.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(logStopped, true);
});

test("PylonAndroidHost binds a selected Flutter candidate to its Android build and fixed artifact layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-flutter-host-"));
  const settings = new AndroidSettingsStore(":memory:");
  const fingerprint = "b".repeat(64);
  settings.saveConfiguration("project-1", 0, ":app", "debug", "flutter-candidate");
  settings.setTrust("project-1", 0, {
    trusted: true,
    configRevision: 1,
    registeredRoot: root,
    workspaceRoot: root,
    wrapperRelativePath: "gradlew",
    wrapperFingerprint: fingerprint,
  });
  const harness = runnerHarness();
  let accepted = false;
  const appRuntime: AndroidHostAppRuntime = {
    async buildAndRun(input) {
      accepted = true;
      assert.equal(input.build.workspace.canonicalRoot, join(root, "customer-flutter", "android"));
      assert.equal(input.build.workspace.kind, "flutter");
      assert.equal(input.build.workspace.discoveryRoot, root);
      assert.equal(input.build.workspace.candidateId, "flutter-candidate");
      assert.deepEqual(input.artifact, {
        workspaceRoot: join(root, "customer-flutter"),
        modulePath: ":app",
        variant: "debug",
        outputRoot: join(root, "customer-flutter", "build", "app", "outputs", "apk", "debug"),
        expectedOutputFile: "app-debug.apk",
      });
      assert.equal(input.build.forceRerun, true);
      await input.revalidate();
      return {
        artifact: {
          sha256: "c".repeat(64),
          bytes: 3,
          packageName: "com.example.flutter",
          versionCode: "1",
          signingCertificateSha256: "d".repeat(64),
          launcherComponent: "com.example.flutter/.MainActivity",
          debuggable: true,
        },
        installed: true,
        replacementInstall: true,
        installationIdentity: "installed-flutter",
      };
    },
    forceStop: async () => undefined,
    relaunch: async () => undefined,
    validateInstallation: async () => undefined,
    startLogs: async () => {
      throw new Error("unused");
    },
  };
  const discovery = (canonicalRoot: string) => ({
    canonicalRoot,
    candidates: [
      projectDiscovery(canonicalRoot).candidates[0],
      {
        candidateId: "flutter-candidate",
        kind: "flutter" as const,
        label: "customer-flutter",
        workspaceRelativePath: "customer-flutter",
        candidateRoot: join(canonicalRoot, "customer-flutter"),
        canonicalRoot: join(canonicalRoot, "customer-flutter", "android"),
        androidRoot: join(canonicalRoot, "customer-flutter", "android"),
        artifactOutputRoot: join(canonicalRoot, "customer-flutter", "build", "app", "outputs", "apk", "debug"),
        settingsFile: "settings.gradle" as const,
        wrapper: {
          executablePath: join(canonicalRoot, "customer-flutter", "android", "gradlew"),
          executableRelativePath: "gradlew" as const,
          fingerprint,
          files: [],
        },
        modules: [{ modulePath: ":app", variants: ["debug"] }],
      },
    ],
  });
  const host = new PylonAndroidHost(harness.runner, {
    settingsStore: settings,
    buildStateDirectory: join(root, "state"),
    stagingStateDirectory: join(root, "staging"),
    appRuntime,
    workspaceProvider: expectedGeneration => ({
      projectId: "project-1",
      sessionId: "session-1",
      sessionGeneration: expectedGeneration,
      root,
      registeredRoot: root,
      workspaceKind: "project-folder",
      workspaceLabel: "Project",
    }),
    discoverProject: async canonicalRoot => discovery(canonicalRoot),
  });
  try {
    let current = await host.snapshot();
    current = (
      await host.command({
        type: "refreshProject",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        expectedGeneration: 1,
      })
    ).snapshot;
    assert.equal(current.project?.candidates.length, 2);
    assert.equal(current.project?.configuration?.candidateId, "flutter-candidate");
    const device = current.runner.devices[0];
    current = (
      await host.command({
        type: "buildAndRun",
        commandId: randomUUID(),
        expectedServiceRevision: current.serviceRevision,
        expectedGeneration: 1,
        configRevision: 1,
        trustRevision: 1,
        deviceId: device.deviceId,
        deviceRevision: device.revision,
      })
    ).snapshot;
    while (current.run?.phase !== "running") {
      await new Promise(resolve => setImmediate(resolve));
      current = await host.snapshot(false);
    }
    assert.equal(accepted, true);
    assert.equal(current.run.artifact?.packageName, "com.example.flutter");
  } finally {
    await host.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("PylonAndroidHost shutdown prevents a build still resolving its workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-android-host-shutdown-"));
  const settings = new AndroidSettingsStore(":memory:");
  settings.saveConfiguration("project-1", 0, ":app", "debug");
  settings.setTrust("project-1", 0, {
    trusted: true,
    configRevision: 1,
    registeredRoot: root,
    workspaceRoot: root,
    wrapperRelativePath: "gradlew",
    wrapperFingerprint: "a".repeat(64),
  });
  const runnerSnapshot: AndroidRunnerSnapshot = {
    lifecycle: "active",
    revision: 0,
    discovery: "idle",
    avds: [],
    devices: [],
  };
  let releaseRunner!: () => void;
  let releaseDiscovery!: () => void;
  let discoveryStarted = false;
  let buildStarted = false;
  const runner = {
    snapshot: () => runnerSnapshot,
    subscribe: () => () => undefined,
    refresh: async () => runnerSnapshot,
    startEmulator: async () => {
      throw new Error("unused");
    },
    cancelOperation: () => undefined,
    stopEmulator: async () => undefined,
    dispose: () => new Promise<void>(resolve => (releaseRunner = resolve)),
  };
  const host = new PylonAndroidHost(runner, {
    settingsStore: settings,
    buildStateDirectory: join(root, "state"),
    buildCleanupTimeoutMs: 10,
    workspaceProvider: expectedGeneration => ({
      projectId: "project-1",
      sessionId: "session-1",
      sessionGeneration: expectedGeneration,
      root,
      registeredRoot: root,
      workspaceKind: "project-folder",
      workspaceLabel: "Project",
    }),
    discoverProject: canonicalRoot => {
      discoveryStarted = true;
      return new Promise(resolve => {
        releaseDiscovery = () => resolve(projectDiscovery(canonicalRoot));
      });
    },
    runBuild: async () => {
      buildStarted = true;
      throw new Error("must not run");
    },
  });
  try {
    const command = host.command({
      type: "build",
      commandId: randomUUID(),
      expectedServiceRevision: 0,
      expectedGeneration: 1,
      configRevision: 1,
      trustRevision: 1,
    });
    while (!discoveryStarted) await new Promise(resolve => setImmediate(resolve));
    const disposing = host.dispose();
    releaseDiscovery();
    await assert.rejects(command, /shutting down/);
    assert.equal(buildStarted, false);
    releaseRunner();
    await disposing;
  } finally {
    releaseDiscovery?.();
    releaseRunner?.();
    await host.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Android event replay fails closed after retention gaps and epoch changes", () => {
  const journal = new AndroidEventJournal("epoch-a");
  const runner: AndroidRunnerSnapshot = { lifecycle: "active", revision: 0, discovery: "ready", avds: [], devices: [] };
  for (let index = 0; index < 520; index++) journal.append(index, { runner: { ...runner, revision: index } });

  assert.deepEqual(journal.replay("epoch-b:520"), { ok: false });
  assert.deepEqual(journal.replay("epoch-a:not-a-number"), { ok: false });
  assert.deepEqual(journal.replay("epoch-a:0"), { ok: false });
  const replay = journal.replay("epoch-a:519");
  assert.equal(replay.ok && replay.events.length, 1);
});

test("Android event rejection does not create an unreplayable sequence gap", () => {
  const journal = new AndroidEventJournal("epoch-a");
  const runner: AndroidRunnerSnapshot = { lifecycle: "active", revision: 0, discovery: "ready", avds: [], devices: [] };
  journal.append(1, { runner });
  assert.throws(() => journal.append(2, { runner, lastError: "x".repeat(2 * 1024 * 1024) }), /byte limit/);
  assert.equal(journal.sequence, 1);
  assert.deepEqual(journal.replay("epoch-a:1"), { ok: true, events: [] });
});
