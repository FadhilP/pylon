# pylon-android

Standalone cross-platform Android SDK and emulator runtime primitives for local developer tools.

## Boundary

`pylon-android` owns validated Android SDK discovery, AVD and emulator identity, bounded ADB operations, owned-emulator lifecycle, and the host-neutral `AndroidRunner` state machine. It does not depend on Pylon Web, Pi, React, HTTP, Appium, or `pylon-core`.

Constructing or importing the package does not discover an SDK or start a process. Native commands use package-owned bounded spawning only after a host explicitly requests discovery or lifecycle operations.

```ts
import { AndroidRunner } from "pylon-android";

const runner = new AndroidRunner();
const snapshot = await runner.refresh();
const device = await runner.startEmulator(snapshot.avds[0]);
await runner.stopEmulator(device.deviceId);
await runner.dispose();
```

Subscribe before starting to observe the generated device ID and `starting`/`booting` phases. `cancelOperation(deviceId)` aborts a pending device startup. A rejected start returns `AndroidRunnerStartError`; when `cleanupRequired` is true, the matching snapshot retains the owned handle until `stopEmulator(deviceId)` or a later `dispose()` succeeds. Disposal aborts and drains active operations, then attempts all owned-device cleanup within bounded timeouts.

`refresh()` publishes bounded AVD inventory and reconciles verified running emulators as `external`. External records never receive cleanup authority. A missing or identity-changed runner-owned device retains its cleanup handle and transitions to `cleanup-required`; host commands can use device revisions to reject stale cancellation or stop requests.

`discoverAndroidProject(root)` performs bounded static inspection of one Gradle root. `discoverAndroidWorkspace(root)` adds a bounded nested candidate search and narrow recognition of prepared Flutter projects without executing Gradle or Flutter. Flutter candidates expose their project root, `android` Gradle root, fixed `:app`/`debug` configuration, and conventional debug output root explicitly. `runAndroidGradleBuild(...)` accepts a host-authorized immutable descriptor, rechecks the canonical root, candidate identity, wrapper fingerprint, module, and variant, then spawns one derived assemble task with no shell on POSIX or a constrained `cmd.exe` adapter on Windows. It uses a sanitized environment, private Gradle user directory, bounded output/timeout, and retained process-tree cleanup. The package validates authorization facts but never grants or persists trust.

`runAndroidBuildAndRun(...)` owns the bounded build → artifact discovery → private staging/hash → Build Tools inspection → replacement-only install → inspected-component launch sequence. A host may supply the fixed Flutter output contract; the coordinator serializes that output, requires the exact top-level metadata/APK pair, and binds the discovered APK identity through staging. Flutter hosts force Gradle task reruns so packaging is regenerated without deleting workspace files. The coordinator rechecks cancellation and host authorization before each side effect, deletes staged APKs after the installer exits, and reports install uncertainty or install-success/launch-failure without destructive recovery. `AndroidAppDevice` exposes only validated package lifecycle operations, while PID-scoped Logcat retains a sanitized memory-only tail and never falls back to unrestricted device logs.

Pylon Web embeds the first host-global service and user-facing side panel. Appium, agent consent, and model-facing Android automation remain in `pi-helios`.

## Verification and opt-in live test

`npm test --workspace pylon-android` and `npm run smoke --workspace pylon-android` are hardware-independent. The smoke command builds, type-checks, and checks the packed-file manifest; `.github/workflows/android-runner-smoke.yml` can run it manually on Windows, macOS, and Linux.

The live lifecycle test is intentionally excluded from normal tests and CI. From a source checkout, run `npm run check --workspace pylon-android` first so the test uses the current compiled package. It builds and installs a maintainer-owned, non-sensitive fixture on an existing **disposable, stopped** AVD, then checks launch, PID-scoped Logcat startup, stop, identity-preserving relaunch, active startup cancellation, and owned-emulator cleanup. Installation or fixture migrations can alter app data. Set every guard explicitly before running:

```sh
PYLON_ANDROID_LIVE=1 \
PYLON_ANDROID_LIVE_DISPOSABLE=YES \
PYLON_ANDROID_LIVE_WORKSPACE=/absolute/path/to/fixture \
PYLON_ANDROID_LIVE_AVD=Disposable_API_35 \
PYLON_ANDROID_LIVE_MODULE=:app \
PYLON_ANDROID_LIVE_VARIANT=debug \
npm run test:live --workspace pylon-android
```

PowerShell users can set the same six values with `$env:NAME = "value"`, then run the final npm command. Do not point the test at an AVD or application whose data matters. The test refuses an already-running target so process cleanup remains Pylon-owned.
