import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const npmCli = process.env.npm_execpath;

function npm(args: string[], cwd = packageRoot) {
  assert.ok(npmCli, "run this check through npm test");
  return spawnSync(process.execPath, [npmCli, ...args], { cwd, encoding: "utf8", timeout: 120_000 });
}

test("packed standalone package supports runtime and TypeScript consumers", { timeout: 180_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pylon-android-package-"));
  const packed = join(temp, "packed");
  const consumer = join(temp, "consumer");
  await Promise.all([mkdir(packed), mkdir(consumer)]);

  try {
    const pack = npm(["pack", "--silent", "--pack-destination", packed]);
    assert.equal(pack.status, 0, pack.stderr || pack.stdout);
    const tarball = join(packed, (await readdir(packed)).find(name => name.endsWith(".tgz")) ?? "");
    assert.ok(tarball.endsWith(".tgz") && existsSync(tarball));

    const install = npm(["install", "--prefix", consumer, "--omit=dev", "--no-audit", "--no-fund", tarball]);
    assert.equal(install.status, 0, install.stderr || install.stdout);
    await writeFile(join(consumer, "package.json"), '{"type":"module"}\n');

    const runtime = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { AndroidRunner } from "pylon-android";
         let created = false;
         const runner = new AndroidRunner({ createSdk: async () => { created = true; throw new Error("unexpected discovery"); } });
         await runner.dispose();
         if (created || runner.snapshot().lifecycle !== "disposed") process.exit(1);`,
      ],
      { cwd: consumer, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(runtime.status, 0, runtime.stderr || runtime.stdout);

    const source = join(consumer, "consumer.ts");
    await writeFile(
      source,
      `import { AndroidRunner, type AndroidRunnerSnapshot } from "pylon-android";
       import { validateEmulatorSerial } from "pylon-android/android-sdk";
       const runner = new AndroidRunner({ createSdk: async () => ({ listAvds: async () => [], start: async () => { throw new Error("unused"); } }) });
       const snapshot: AndroidRunnerSnapshot = runner.snapshot();
       validateEmulatorSerial("emulator-5554");
       await runner.dispose();
       console.log(snapshot.lifecycle);\n`,
    );
    const typecheck = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--skipLibCheck",
        source,
      ],
      { cwd: consumer, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(typecheck.status, 0, typecheck.stderr || typecheck.stdout);

    const manifest = JSON.parse(
      await readFile(join(consumer, "node_modules", "pylon-android", "package.json"), "utf8"),
    );
    assert.equal(manifest.exports["."].import, "./dist/index.js");
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
});
