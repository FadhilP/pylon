import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, writeFile, chmod, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, spawn } from "node:child_process";
import { discoverAndroidProject, discoverAndroidWorkspace } from "pylon-android/project-discovery";
import {
  androidGradleInvocation,
  runAndroidGradleBuild,
  sanitizedGradleEnvironment,
} from "pylon-android/gradle-runner";

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pylon-android-project-"));
  await mkdir(join(root, "gradle", "wrapper"), { recursive: true });
  await mkdir(join(root, "app"));
  await writeFile(join(root, "settings.gradle.kts"), 'include(":app")\n');
  await writeFile(join(root, "app", "build.gradle.kts"), 'plugins { id("com.android.application") }\n');
  await writeFile(join(root, "gradlew"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "gradlew"), 0o700);
  await writeFile(join(root, "gradlew.bat"), "@echo off\r\n");
  await writeFile(join(root, "gradle", "wrapper", "gradle-wrapper.jar"), "jar");
  await writeFile(
    join(root, "gradle", "wrapper", "gradle-wrapper.properties"),
    "distributionUrl=https://example.test/gradle.zip\n",
  );
  return root;
}

function childProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 12345,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    stdio: [],
    exitCode: null,
    signalCode: null,
    killed: false,
    connected: false,
    kill: () => true,
  });
  return child;
}

test("static Android discovery is bounded, comment-safe, and wrapper-revisioned", async () => {
  const root = await project();
  try {
    const first = await discoverAndroidProject(root);
    assert.equal(first.issue, undefined);
    assert.deepEqual(first.modules, [{ modulePath: ":app", variants: ["debug", "release"] }]);
    assert.ok(first.wrapper?.fingerprint);

    await writeFile(
      join(root, "settings.gradle.kts"),
      'val documentation = "include(\\\":ghost\\\")"\ninclude(":app")\n',
    );
    const stringSettings = await discoverAndroidProject(root);
    assert.deepEqual(stringSettings.modules, [{ modulePath: ":app", variants: ["debug", "release"] }]);

    await writeFile(
      join(root, "app", "build.gradle.kts"),
      '// id("com.android.application")\nval documentation = "id(\\\"com.android.application\\\")"\nplugins { id("java-library") }\n',
    );
    const commented = await discoverAndroidProject(root);
    assert.deepEqual(commented.modules, []);
    assert.match(commented.issue ?? "", /No statically explicit/);

    await writeFile(join(root, "app", "build.gradle.kts"), 'plugins { id("com.android.application") }\n');
    await writeFile(
      join(root, "settings.gradle.kts"),
      'include(":app")\nproject(":app").projectDir = file("elsewhere")\n',
    );
    const remapped = await discoverAndroidProject(root);
    assert.deepEqual(remapped.modules, []);
    assert.match(remapped.issue ?? "", /remapped/);

    await writeFile(join(root, "settings.gradle.kts"), 'include(":app")\n');
    await writeFile(join(root, "gradle", "wrapper", "gradle-wrapper.properties"), "distributionUrl=changed\n");
    const changed = await discoverAndroidProject(root);
    assert.notEqual(changed.wrapper?.fingerprint, first.wrapper?.fingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace discovery finds explicit nested Gradle and conventional Flutter candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pylon-android-workspace-"));
  const flutter = join(root, "customer-flutter");
  const android = join(flutter, "android");
  const native = join(root, "native-app");
  try {
    await mkdir(join(android, "gradle", "wrapper"), { recursive: true });
    await mkdir(join(android, "app"));
    await writeFile(join(flutter, "pubspec.yaml"), "name: customer\ndependencies:\n  flutter:\n    sdk: flutter\n");
    await writeFile(join(android, "settings.gradle"), "include ':app'\nincludeBuild('../flutter-tools')\n");
    await writeFile(join(android, "app", "build.gradle"), "apply plugin: 'com.android.application'\n");
    await writeFile(join(android, "gradlew"), "#!/bin/sh\nexit 0\n");
    await chmod(join(android, "gradlew"), 0o700);
    await writeFile(join(android, "gradlew.bat"), "@echo off\r\n");
    await writeFile(join(android, "gradle", "wrapper", "gradle-wrapper.jar"), "jar");
    await writeFile(join(android, "gradle", "wrapper", "gradle-wrapper.properties"), "distributionUrl=x\n");

    await mkdir(join(native, "gradle", "wrapper"), { recursive: true });
    await mkdir(join(native, "app"));
    await writeFile(join(native, "settings.gradle.kts"), 'include(":app")\n');
    await writeFile(join(native, "app", "build.gradle.kts"), 'plugins { id("com.android.application") }\n');
    await writeFile(join(native, "gradlew"), "#!/bin/sh\nexit 0\n");
    await chmod(join(native, "gradlew"), 0o700);
    await writeFile(join(native, "gradlew.bat"), "@echo off\r\n");
    await writeFile(join(native, "gradle", "wrapper", "gradle-wrapper.jar"), "jar");
    await writeFile(join(native, "gradle", "wrapper", "gradle-wrapper.properties"), "distributionUrl=x\n");

    const discovery = await discoverAndroidWorkspace(root, { platform: "linux" });
    assert.equal(discovery.issue, undefined);
    assert.deepEqual(
      discovery.candidates.map(candidate => [candidate.kind, candidate.label]),
      [
        ["flutter", "customer-flutter"],
        ["gradle", "native-app"],
      ],
    );
    const flutterCandidate = discovery.candidates[0];
    assert.deepEqual(flutterCandidate.modules, [{ modulePath: ":app", variants: ["debug"] }]);
    assert.equal(flutterCandidate.androidRoot, await realpath(android));
    assert.equal(
      flutterCandidate.artifactOutputRoot,
      join(await realpath(flutter), "build", "app", "outputs", "apk", "debug"),
    );
    assert.notEqual(flutterCandidate.candidateId, discovery.candidates[1].candidateId);
    let invocation: { executable: string; args: readonly string[] } | undefined;
    const build = await runAndroidGradleBuild(
      {
        workspace: {
          canonicalRoot: flutterCandidate.androidRoot,
          wrapperPath: flutterCandidate.wrapper!.executablePath,
          wrapperFingerprint: flutterCandidate.wrapper!.fingerprint,
          modulePath: ":app",
          variant: "debug",
          kind: "flutter",
          discoveryRoot: discovery.canonicalRoot,
          candidateId: flutterCandidate.candidateId,
        },
        stateDirectory: join(root, ".state"),
        forceRerun: true,
      },
      {
        platform: "linux",
        spawnProcess: ((executable: string, args: readonly string[]) => {
          invocation = { executable, args };
          const child = childProcess();
          queueMicrotask(() => {
            Object.assign(child, { exitCode: 0 });
            child.emit("close", 0);
          });
          return child;
        }) as unknown as typeof spawn,
      },
    );
    assert.equal(build.succeeded, true);
    assert.deepEqual(invocation?.args, [":app:assembleDebug", "--no-daemon", "--console=plain", "--rerun-tasks"]);
    assert.match((await discoverAndroidProject(root)).issue ?? "", /settings file not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gradle builds derive one task, sanitize environment, bound output, and never use a shell", async () => {
  const root = await project();
  try {
    const discovery = await discoverAndroidProject(root, { platform: "linux" });
    assert.ok(discovery.wrapper);
    let invocation: { executable: string; args: readonly string[]; options: Record<string, unknown> } | undefined;
    const spawnProcess = ((executable: string, args: readonly string[], options: Record<string, unknown>) => {
      invocation = { executable, args, options };
      const child = childProcess();
      queueMicrotask(() => {
        child.stdout?.emit("data", Buffer.from("0\u001b[31m123456789"));
        Object.assign(child, { exitCode: 0 });
        child.emit("close", 0);
      });
      return child;
    }) as unknown as typeof spawn;

    const result = await runAndroidGradleBuild(
      {
        workspace: {
          canonicalRoot: discovery.canonicalRoot,
          wrapperPath: discovery.wrapper.executablePath,
          wrapperFingerprint: discovery.wrapper.fingerprint,
          modulePath: ":app",
          variant: "debug",
        },
        stateDirectory: join(root, ".pylon-gradle"),
        maxOutputBytes: 10,
      },
      {
        spawnProcess,
        platform: "linux",
        env: {
          PATH: "/usr/bin",
          HOME: "/home/test",
          JAVA_TOOL_OPTIONS: "-javaagent:unsafe",
          GRADLE_OPTS: "-Dunsafe=true",
          OPENAI_API_KEY: "secret",
        },
      },
    );

    assert.deepEqual(invocation?.args, [":app:assembleDebug", "--no-daemon", "--console=plain"]);
    assert.equal(invocation?.options.shell, false);
    assert.equal((invocation?.options.env as NodeJS.ProcessEnv).JAVA_TOOL_OPTIONS, undefined);
    assert.equal((invocation?.options.env as NodeJS.ProcessEnv).OPENAI_API_KEY, undefined);
    assert.equal(result.output, "01234");
    assert.equal(result.truncated, true);
    assert.equal(result.succeeded, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gradle build refuses a wrapper changed after authorization", async () => {
  const root = await project();
  try {
    const discovery = await discoverAndroidProject(root, { platform: "linux" });
    assert.ok(discovery.wrapper);
    await writeFile(join(root, "gradle", "wrapper", "gradle-wrapper.jar"), "replacement");
    let spawned = false;
    await assert.rejects(
      runAndroidGradleBuild(
        {
          workspace: {
            canonicalRoot: discovery.canonicalRoot,
            wrapperPath: discovery.wrapper.executablePath,
            wrapperFingerprint: discovery.wrapper.fingerprint,
            modulePath: ":app",
            variant: "debug",
          },
          stateDirectory: join(root, ".pylon-gradle"),
        },
        {
          platform: "linux",
          spawnProcess: (() => {
            spawned = true;
            return childProcess();
          }) as unknown as typeof spawn,
        },
      ),
      /changed before build execution/,
    );
    assert.equal(spawned, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gradle cancellation terminates the retained process tree and reports cancellation", async () => {
  const root = await project();
  try {
    const discovery = await discoverAndroidProject(root, { platform: "linux" });
    assert.ok(discovery.wrapper);
    let child: ChildProcess | undefined;
    let terminations = 0;
    const controller = new AbortController();
    const build = runAndroidGradleBuild(
      {
        workspace: {
          canonicalRoot: discovery.canonicalRoot,
          wrapperPath: discovery.wrapper.executablePath,
          wrapperFingerprint: discovery.wrapper.fingerprint,
          modulePath: ":app",
          variant: "release",
        },
        stateDirectory: join(root, ".pylon-gradle"),
        signal: controller.signal,
      },
      {
        platform: "linux",
        spawnProcess: (() => (child = childProcess())) as unknown as typeof spawn,
        terminateProcess: async process => {
          terminations++;
          Object.assign(process, { exitCode: 143 });
          process.emit("close", 143);
        },
      },
    );
    while (!child) await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    const result = await build;
    assert.equal(terminations, 1);
    assert.equal(result.cancelled, true);
    assert.equal(result.succeeded, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows Gradle adapter rejects command metacharacters and uses fixed cmd arguments", () => {
  const workspace = "C:\\work tree\\gradlew.bat";
  assert.deepEqual(androidGradleInvocation("win32", workspace, ":app:assembleDebug", { SystemRoot: "C:\\Windows" }), {
    executable: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/v:off", "/s", "/c", '""C:\\work tree\\gradlew.bat" :app:assembleDebug --no-daemon --console=plain"'],
  });
  assert.throws(
    () =>
      androidGradleInvocation("win32", "C:\\bad&path\\gradlew.bat", ":app:assembleDebug", {
        SystemRoot: "C:\\Windows",
      }),
    /unsupported/,
  );
  const env = sanitizedGradleEnvironment({ Path: "C:\\bin", JDK_JAVA_OPTIONS: "unsafe" }, "C:\\state");
  assert.equal(env.PATH, "C:\\bin");
  assert.equal(env.JDK_JAVA_OPTIONS, undefined);
});
