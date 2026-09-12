import test from "node:test";
import assert from "node:assert/strict";
import {
  AndroidRunner,
  AndroidRunnerStartError,
  type AndroidOwnedEmulator,
  type AndroidSdkController,
} from "pylon-android/android-runner";
import { AndroidEmulatorStartupCleanupError } from "pylon-android/android-sdk";

function controlledSdk(stops: string[], failOnce = new Set<string>()): AndroidSdkController {
  return {
    async listAvds() {
      return ["Pixel_Test"];
    },
    async start(avd) {
      const cleanup = async () => {
        stops.push(avd);
        if (failOnce.delete(avd)) throw new Error(`cleanup failed for ${avd}`);
      };
      const emulator: AndroidOwnedEmulator = {
        serial: `emulator-${5554 + stops.length * 2}`,
        avd,
        stop: cleanup,
        cleanupUncertainStart: cleanup,
      };
      return emulator;
    },
  };
}

test("AndroidRunner construction and disposal are inert until an operation requests the SDK", async () => {
  let creations = 0;
  const runner = new AndroidRunner({
    createSdk: async () => {
      creations++;
      return controlledSdk([]);
    },
  });

  assert.deepEqual(runner.snapshot(), { lifecycle: "active", revision: 0, discovery: "idle", avds: [], devices: [] });
  assert.equal(creations, 0);
  await runner.dispose();
  assert.equal(creations, 0);
  assert.equal(runner.snapshot().lifecycle, "disposed");
});

test("AndroidRunner tracks only owned handles and serializes start and stop", async () => {
  const stops: string[] = [];
  const events: number[] = [];
  let nextId = 0;
  const runner = new AndroidRunner({
    createSdk: async () => controlledSdk(stops),
    idFactory: () => `device-${++nextId}`,
  });
  const unsubscribe = runner.subscribe(event => events.push(event.snapshot.revision));

  const device = await runner.startEmulator("Pixel_Test");
  assert.deepEqual(device, {
    deviceId: "device-1",
    serial: "emulator-5554",
    avd: "Pixel_Test",
    ownership: "runner",
    state: "ready",
    revision: 2,
  });
  await runner.stopEmulator(device.deviceId);
  assert.deepEqual(stops, ["Pixel_Test"]);
  assert.deepEqual(runner.snapshot().devices, []);
  assert.deepEqual(events, [1, 2, 3, 4]);

  unsubscribe();
  await runner.dispose();
});

test("AndroidRunner retains failed cleanup for an explicit retry", async () => {
  const stops: string[] = [];
  const runner = new AndroidRunner({
    createSdk: async () => controlledSdk(stops, new Set(["Pixel_Test"])),
    idFactory: () => "device-1",
  });
  await runner.startEmulator("Pixel_Test");

  await assert.rejects(runner.dispose(), /could not clean up every owned emulator/);
  assert.deepEqual(runner.snapshot(), {
    lifecycle: "cleanup-required",
    revision: 6,
    discovery: "idle",
    avds: [],
    devices: [
      {
        deviceId: "device-1",
        serial: "emulator-5554",
        avd: "Pixel_Test",
        ownership: "runner",
        state: "cleanup-required",
        revision: 5,
      },
    ],
  });

  await runner.dispose();
  assert.deepEqual(stops, ["Pixel_Test", "Pixel_Test"]);
  assert.equal(runner.snapshot().lifecycle, "disposed");
});

test("AndroidRunner retains an uncertain startup handle until explicit cleanup succeeds", async () => {
  let cleanupAttempts = 0;
  const uncertain = {
    serial: "emulator-5554",
    avd: "Pixel_Test",
    async cleanupUncertainStart() {
      cleanupAttempts++;
    },
  };
  const runner = new AndroidRunner({
    createSdk: async () => ({
      async listAvds() {
        return ["Pixel_Test"];
      },
      async start() {
        throw new AndroidEmulatorStartupCleanupError(uncertain, new Error("boot failed"), new Error("cleanup failed"));
      },
    }),
    idFactory: () => "device-uncertain",
  });

  const error = await runner.startEmulator("Pixel_Test").catch(value => value);
  assert.ok(error instanceof AndroidRunnerStartError);
  assert.equal(error.deviceId, "device-uncertain");
  assert.equal(error.cleanupRequired, true);
  assert.deepEqual(runner.snapshot().devices, [
    {
      deviceId: "device-uncertain",
      serial: "emulator-5554",
      avd: "Pixel_Test",
      ownership: "runner",
      state: "cleanup-required",
      revision: 2,
    },
  ]);

  await runner.stopEmulator("device-uncertain");
  assert.equal(cleanupAttempts, 1);
  assert.deepEqual(runner.snapshot().devices, []);
  await runner.dispose();
});

test("AndroidRunner refresh reconciles external emulators without granting cleanup ownership", async () => {
  let identity = { serial: "emulator-5554", avd: "Pixel_External", instanceId: "00000000-0000-4000-8000-000000000001" };
  let failDiscovery = false;
  let nextId = 0;
  const runner = new AndroidRunner({
    createSdk: async () => ({
      async listAvds() {
        if (failDiscovery) throw new Error(`SDK unavailable ${"x".repeat(600)}`);
        return ["Pixel_External", "Pixel_Owned"];
      },
      async devices() {
        return [{ serial: identity.serial, state: "device" }];
      },
      async avdName() {
        return identity.avd;
      },
      async bootId() {
        return identity.instanceId;
      },
      async start() {
        throw new Error("unused");
      },
    }),
    idFactory: () => `device-${++nextId}`,
  });

  const first = await runner.refresh();
  assert.equal(first.discovery, "ready");
  assert.deepEqual(first.avds, ["Pixel_External", "Pixel_Owned"]);
  assert.equal(first.devices[0].ownership, "external");
  await assert.rejects(runner.stopEmulator(first.devices[0].deviceId, first.devices[0].revision), /externally owned/);

  identity = { ...identity, instanceId: "00000000-0000-4000-8000-000000000002" };
  const restarted = await runner.refresh();
  assert.notEqual(restarted.devices[0].deviceId, first.devices[0].deviceId);
  assert.equal(restarted.devices[0].instanceId, identity.instanceId);

  identity = { ...identity, avd: "Pixel_Replaced" };
  const replaced = await runner.refresh();
  assert.notEqual(replaced.devices[0].deviceId, restarted.devices[0].deviceId);
  assert.equal(replaced.devices[0].avd, "Pixel_Replaced");

  failDiscovery = true;
  const unavailable = await runner.refresh();
  assert.equal(unavailable.discovery, "unavailable");
  assert.equal(unavailable.devices[0].deviceId, replaced.devices[0].deviceId);
  assert.ok((unavailable.issue?.length ?? 0) <= 500);
  await runner.dispose();
});

test("refresh identity drift preserves owned cleanup and rejects stale device revisions", async () => {
  let stopped = 0;
  const runner = new AndroidRunner({
    createSdk: async () => ({
      async listAvds() {
        return ["Pixel_Owned"];
      },
      async devices() {
        return [];
      },
      async avdName() {
        throw new Error("unused");
      },
      async start() {
        return {
          serial: "emulator-5556",
          avd: "Pixel_Owned",
          async stop() {
            stopped++;
          },
          async cleanupUncertainStart() {
            stopped++;
          },
        };
      },
    }),
    idFactory: () => "owned-device",
  });

  const ready = await runner.startEmulator("Pixel_Owned");
  const refreshed = await runner.refresh();
  const cleanup = refreshed.devices[0];
  assert.equal(cleanup.state, "cleanup-required");
  await assert.rejects(runner.stopEmulator(cleanup.deviceId, ready.revision), /revision is stale/);
  await runner.stopEmulator(cleanup.deviceId, cleanup.revision);
  assert.equal(stopped, 1);
  await runner.dispose();
});

test("AndroidRunner exposes booting and cancellation before removing a cancelled start", async () => {
  const states: string[] = [];
  const runner = new AndroidRunner({
    createSdk: async () => ({
      async listAvds() {
        return ["Pixel_Test"];
      },
      async start(_avd, _headless, signal, _timeoutMs, onPhase) {
        onPhase?.("booting");
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        });
      },
    }),
    idFactory: () => "device-cancel",
  });
  runner.subscribe(event => {
    const state = event.snapshot.devices[0]?.state;
    if (state) states.push(state);
  });

  const starting = runner.startEmulator("Pixel_Test");
  const rejected = assert.rejects(starting, error => {
    assert.ok(error instanceof AndroidRunnerStartError);
    assert.equal(error.cleanupRequired, false);
    return true;
  });
  await new Promise(resolve => setImmediate(resolve));
  runner.cancelOperation("device-cancel");
  await rejected;

  assert.ok(states.includes("starting"));
  assert.ok(states.includes("booting"));
  assert.ok(states.includes("cancelled"));
  assert.deepEqual(runner.snapshot().devices, []);
  await runner.dispose();
});

test("AndroidRunner disposal aborts and drains active discovery", async () => {
  let observedAbort = false;
  const runner = new AndroidRunner({
    createSdk: async () => ({
      async listAvds(signal) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new Error("discovery cancelled"));
            },
            { once: true },
          );
        });
      },
      async start() {
        throw new Error("unused");
      },
    }),
  });

  const listing = assert.rejects(runner.listAvds(), /discovery cancelled/);
  await new Promise(resolve => setImmediate(resolve));
  await runner.dispose();
  await listing;
  assert.equal(observedAbort, true);
  assert.equal(runner.snapshot().lifecycle, "disposed");
});

test("AndroidRunner bounds disposal when a controller ignores cancellation and retries after it settles", async () => {
  let resolveStart!: (emulator: AndroidOwnedEmulator) => void;
  let cleanups = 0;
  const runner = new AndroidRunner({
    createSdk: async () => ({
      async listAvds() {
        return ["Pixel_Test"];
      },
      async start() {
        return new Promise(resolve => {
          resolveStart = resolve;
        });
      },
    }),
    idFactory: () => "device-slow",
    drainTimeoutMs: 10,
  });

  const starting = assert.rejects(runner.startEmulator("Pixel_Test"), AndroidRunnerStartError);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(runner.dispose(), /operations did not stop within 10ms/);
  assert.equal(runner.snapshot().lifecycle, "cleanup-required");

  resolveStart({
    serial: "emulator-5554",
    avd: "Pixel_Test",
    async stop() {
      cleanups++;
    },
    async cleanupUncertainStart() {
      cleanups++;
    },
  });
  await starting;
  await runner.dispose();
  assert.equal(cleanups, 1);
  assert.equal(runner.snapshot().lifecycle, "disposed");
});

test("AndroidRunner bounds owned cleanup and attempts every device in parallel", async () => {
  let releaseFirst!: () => void;
  let secondStops = 0;
  const runner = new AndroidRunner({
    createSdk: async () => ({
      async listAvds() {
        return ["Pixel_A", "Pixel_B"];
      },
      async start(avd) {
        const stop =
          avd === "Pixel_A"
            ? () =>
                new Promise<void>(resolve => {
                  releaseFirst = resolve;
                })
            : async () => {
                secondStops++;
              };
        return {
          serial: avd === "Pixel_A" ? "emulator-5554" : "emulator-5556",
          avd,
          stop,
          cleanupUncertainStart: stop,
        };
      },
    }),
    idFactory: (() => {
      let id = 0;
      return () => `device-${++id}`;
    })(),
    cleanupTimeoutMs: 10,
  });
  await runner.startEmulator("Pixel_A");
  await runner.startEmulator("Pixel_B");

  await assert.rejects(runner.dispose(), /cleanup did not finish within 10ms/);
  assert.equal(secondStops, 1);
  assert.equal(runner.snapshot().devices[0]?.state, "cleanup-required");

  releaseFirst();
  await new Promise(resolve => setImmediate(resolve));
  await runner.dispose();
  assert.equal(runner.snapshot().lifecycle, "disposed");
});

test("AndroidRunner disposal is reentrant from a synchronous state listener", async () => {
  let creations = 0;
  const runner = new AndroidRunner({
    createSdk: async () => {
      creations++;
      return controlledSdk([]);
    },
    idFactory: () => "device-reentrant",
  });
  let disposal: Promise<void> | undefined;
  runner.subscribe(event => {
    if (event.snapshot.devices[0]?.state === "starting") disposal ??= runner.dispose();
  });

  const starting = assert.rejects(runner.startEmulator("Pixel_Test"), AndroidRunnerStartError);
  await starting;
  await disposal;
  assert.equal(creations, 0);
  assert.equal(runner.snapshot().lifecycle, "disposed");
});

test("AndroidRunner rejects unbounded lifecycle timeouts", async () => {
  const runner = new AndroidRunner({ createSdk: async () => controlledSdk([]) });
  assert.throws(() => runner.startEmulator("Pixel_Test", { timeoutMs: Infinity }), /startup timeout/);
  assert.throws(
    () => new AndroidRunner({ createSdk: async () => controlledSdk([]), drainTimeoutMs: Infinity }),
    /drain timeout/,
  );
  assert.throws(
    () => new AndroidRunner({ createSdk: async () => controlledSdk([]), cleanupTimeoutMs: Infinity }),
    /cleanupTimeoutMs/,
  );
  await runner.dispose();
});
