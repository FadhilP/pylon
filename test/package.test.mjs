import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const npmCli = process.env.npm_execpath;

function npm(args, options = {}) {
  assert.ok(npmCli, "run this check through npm run test:package");
  return spawnSync(process.execPath, [npmCli, ...args], { cwd: root, encoding: "utf8", timeout: 180_000, ...options });
}

function readyUrl(child) {
  return new Promise((resolveReady, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`pylon did not start\n${stdout}\n${stderr}`)), 30_000);
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const match = stdout.match(/Pylon web: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolveReady(match[1]);
      }
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.once("exit", code => {
      clearTimeout(timer);
      reject(new Error(`pylon exited before startup (${code})\n${stdout}\n${stderr}`));
    });
  });
}

function exited(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise(resolveExit => child.once("exit", resolveExit));
}

test("packed package installs and launches its production web app", { timeout: 240_000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pylon-package-"));
  const packed = join(temp, "packed");
  const prefix = join(temp, "install");
  const project = join(temp, "project");
  await Promise.all([mkdir(packed), mkdir(prefix), mkdir(project)]);
  let launch;

  try {
    const pack = npm(["pack", "--silent", "--pack-destination", packed]);
    assert.equal(pack.status, 0, pack.stderr || pack.stdout);
    const tarball = join(packed, (await readdir(packed)).find(name => name.endsWith(".tgz")) ?? "");
    assert.ok(tarball.endsWith(".tgz") && existsSync(tarball), "npm pack did not create a tarball");

    const install = npm(["install", "--prefix", prefix, "--omit=dev", "--no-audit", "--no-fund", tarball]);
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const packageRoot = join(prefix, "node_modules", "@fadhilp", "pylon");
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.bin.pylon, "./bin/pylon.mjs");
    assert.ok(existsSync(join(packageRoot, "bin", "storage.mjs")));
    assert.ok(existsSync(join(packageRoot, "platform", "web", "dist", "index.html")));
    assert.ok(existsSync(join(packageRoot, "node_modules", "pylon-core", "extensions", "pylon-core.ts")));
    assert.ok(existsSync(join(packageRoot, "node_modules", "pi-sieve", "extensions", "pi-sieve.ts")));
    assert.ok(existsSync(join(packageRoot, "docs", "web", "README.md")));
    assert.ok(existsSync(join(packageRoot, "docs", "pylon-web.png")));

    const adapterCheck = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { createRequire } from "node:module";
       import { join } from "node:path";
       import { pathToFileURL } from "node:url";
       const packageRoot = process.argv[1];
       const installedRequire = createRequire(join(packageRoot, "package.json"));
       const { createJiti } = await import(pathToFileURL(installedRequire.resolve("jiti")).href);
       const jiti = createJiti(join(packageRoot, "package.json"));
       const settings = await jiti.import(join(packageRoot, "packages", "pi-advisor", "src", "web-settings.ts"));
       const docs = await jiti.import(join(packageRoot, "packages", "pylon-core", "src", "docs-tool.ts"));
       const tokenMeter = await jiti.import(installedRequire.resolve("pylon-core/token-meter"));
       const coreExtension = join(packageRoot, "packages", "pylon-core", "extensions", "pylon-core.ts");
       const listedDocs = await docs.listPylonDocs(pathToFileURL(coreExtension).href);
       installedRequire.resolve("pylon-core/extensions/pylon-core.ts");
       installedRequire.resolve("pi-sieve/extensions/pi-sieve.ts");
       if (typeof settings.readSettings !== "function" || typeof settings.updateSettings !== "function" || typeof tokenMeter.meterFromBranch !== "function" || !listedDocs.some(item => item.path === "docs/web/README.md")) process.exit(1);`,
        packageRoot,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(adapterCheck.status, 0, adapterCheck.stderr || adapterCheck.stdout);

    launch = spawn(process.execPath, [join(packageRoot, "bin", "pylon.mjs")], {
      cwd: project,
      env: { ...process.env, PI_CODING_AGENT_DIR: join(temp, "agent"), PYLON_NO_UPDATE_CHECK: "1", PYLON_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const origin = await readyUrl(launch);
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<div id="root"><\/div>/);
  } finally {
    if (launch?.exitCode === null) launch.kill("SIGTERM");
    if (launch) await exited(launch);
    await rm(temp, { recursive: true, force: true });
  }
});
