import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AndroidToolingManager } from "../src/android-tooling.ts";
import { MANAGED_APPIUM_VERSION, MANAGED_UIAUTOMATOR2_VERSION, resolveManagedAppiumAt } from "../src/appium.ts";

async function fixture(root: string) {
  const template = join(root, "template");
  await mkdir(template);
  await writeFile(join(template, "package.json"), JSON.stringify({
    private: true,
    dependencies: { appium: MANAGED_APPIUM_VERSION, "appium-uiautomator2-driver": MANAGED_UIAUTOMATOR2_VERSION },
  }));
  await writeFile(join(template, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
  return template;
}

async function populate(directory: string) {
  const appium = join(directory, "node_modules", "appium");
  const driver = join(directory, "node_modules", "appium-uiautomator2-driver");
  await mkdir(join(appium, "bin"), { recursive: true });
  await mkdir(driver, { recursive: true });
  await writeFile(join(appium, "package.json"), JSON.stringify({ version: MANAGED_APPIUM_VERSION, bin: { appium: "bin/appium.js" } }));
  await writeFile(join(appium, "bin", "appium.js"), "// fixture");
  await writeFile(join(driver, "package.json"), JSON.stringify({ version: MANAGED_UIAUTOMATOR2_VERSION }));
}

test("managed Android tooling stages, verifies, repairs, and removes safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "helios-tooling-test-"));
  try {
    const agentDir = join(root, "agent");
    const templateDirectory = await fixture(root);
    let failInstall = false;
    let installEnv: NodeJS.ProcessEnv | undefined;
    const calls: string[][] = [];
    const manager = new AndroidToolingManager({
      agentDir,
      templateDirectory,
      env: { ...process.env, PYLON_TEST_SECRET: "hidden", ANDROID_SDK_ROOT: join(root, "sdk") },
      run: async (_command, args, options) => {
        calls.push(args);
        if (args.includes("ci")) {
          installEnv = options.env;
          if (failInstall) throw new Error("fixture install failed");
          await populate(options.cwd);
          return { stdout: "installed" };
        }
        if (args.includes("--version")) return { stdout: `${MANAGED_APPIUM_VERSION}\n` };
        return { stdout: JSON.stringify({ uiautomator2: { installed: true, pkgName: "appium-uiautomator2-driver", version: MANAGED_UIAUTOMATOR2_VERSION, installPath: join(options.cwd, "node_modules", "appium-uiautomator2-driver") } }) };
      },
    });

    assert.equal((await manager.status()).state, "missing");
    assert.equal((await manager.install()).state, "ready");
    assert.ok(calls[0].includes("ci"));
    assert.ok(calls[0].includes("--userconfig") && calls[0].includes("--globalconfig"));
    assert.notEqual(calls[0][calls[0].indexOf("--userconfig") + 1], calls[0][calls[0].indexOf("--globalconfig") + 1]);
    assert.equal(installEnv?.PYLON_TEST_SECRET, undefined);
    assert.equal(installEnv?.ANDROID_SDK_ROOT, join(root, "sdk"));
    const current = join(agentDir, "pi-helios", "android-tooling", "current");
    const invocation = await resolveManagedAppiumAt(current, { PYLON_TEST_SECRET: "hidden", ANDROID_SDK_ROOT: join(root, "sdk") });
    assert.equal(invocation?.managed, true);
    assert.equal(invocation?.env?.APPIUM_HOME, current);
    assert.equal(invocation?.env?.PYLON_TEST_SECRET, undefined);
    assert.equal(invocation?.env?.ANDROID_SDK_ROOT, join(root, "sdk"));
    await writeFile(join(current, "node_modules", "appium", "package.json"), JSON.stringify({ version: "0.0.0", bin: { appium: "bin/appium.js" } }));
    assert.equal((await manager.status()).state, "invalid", "tampered Appium package version is rejected");
    await populate(current);
    await writeFile(join(current, "node_modules", "appium-uiautomator2-driver", "package.json"), JSON.stringify({ version: "0.0.0" }));
    assert.equal((await manager.status()).state, "invalid", "tampered driver package version is rejected");
    await populate(current);
    assert.equal((await manager.status()).state, "ready");

    failInstall = true;
    await assert.rejects(manager.install(), /fixture install failed/);
    assert.equal((await manager.status()).state, "ready", "failed repair preserves current tooling");
    await assert.rejects(manager.remove(1), /Close active/);
    assert.equal((await manager.remove(0)).state, "missing");
    assert.equal((await manager.status()).state, "missing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed Android tooling reports an existing operation lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "helios-tooling-lock-"));
  try {
    const agentDir = join(root, "agent");
    const templateDirectory = await fixture(root);
    await mkdir(join(agentDir, "pi-helios", "android-tooling", "operation.lock"), { recursive: true });
    const manager = new AndroidToolingManager({ agentDir, templateDirectory });
    assert.equal((await manager.status()).state, "busy");
    await assert.rejects(manager.install(), /locked by another Pylon process/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("managed Android tooling locks cannot be stolen and usage leases block mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "helios-tooling-concurrency-"));
  try {
    const agentDir = join(root, "agent");
    const templateDirectory = await fixture(root);
    let entered!: () => void;
    let unblock!: () => void;
    const installing = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const run = async (_command: string, args: string[], options: { cwd: string }) => {
      if (args.includes("ci")) { await populate(options.cwd); entered(); await blocked; return { stdout: "installed" }; }
      if (args.includes("--version")) return { stdout: `${MANAGED_APPIUM_VERSION}\n` };
      return { stdout: JSON.stringify({ uiautomator2: { installed: true, pkgName: "appium-uiautomator2-driver", version: MANAGED_UIAUTOMATOR2_VERSION, installPath: join(options.cwd, "node_modules", "appium-uiautomator2-driver") } }) };
    };
    const first = new AndroidToolingManager({ agentDir, templateDirectory, run: run as any });
    const second = new AndroidToolingManager({ agentDir, templateDirectory, run: run as any });
    const pending = first.install();
    await installing;
    await assert.rejects(second.install(), /locked by another Pylon process/);
    unblock();
    await pending;
    const release = await first.acquireUsageLease();
    await assert.rejects(second.remove(0), /Close active Helios Android sessions/);
    await release();
    assert.equal((await second.remove(0)).state, "missing");
    const staleLease = join(agentDir, "pi-helios", "android-tooling", "usage", "lease-stale");
    await mkdir(staleLease, { recursive: true });
    await writeFile(join(staleLease, "owner.json"), `${JSON.stringify({ pid: 99_999_999 })}\n`);
    assert.equal((await second.install()).state, "ready", "dead foreign-process leases are reclaimed");
    await second.remove(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
