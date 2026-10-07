import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const executable = fileURLToPath(new URL("../bin/pylon.mjs", import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pylon-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  await mkdir(cwd);
  const source = join(cwd, "local extension.ts");
  await writeFile(source, "export default function () {}\n");
  const env = { ...process.env, HOME: root, USERPROFILE: root, PI_OFFLINE: "1" };
  delete env.PI_CODING_AGENT_DIR;
  const run = (...args) =>
    spawnSync(process.execPath, [executable, "install", ...args], { cwd, env, encoding: "utf8", timeout: 30000 });
  return { root, cwd, source, env, run };
}

const settings = async path => JSON.parse(await readFile(path, "utf8"));

test("install persists a local extension in Pylon storage, preserving migrated Pi settings", async t => {
  const { root, source, run } = await fixture(t);
  const legacyDir = join(root, ".pi", "agent");
  await mkdir(legacyDir, { recursive: true });
  const legacy = { quietStartup: true };
  await writeFile(join(legacyDir, "settings.json"), JSON.stringify(legacy));
  const result = run(source);
  assert.equal(result.status, 0, result.stderr);
  const installed = await settings(join(root, ".pylon", "agent", "settings.json"));
  assert.deepEqual(
    installed.packages.map(path => resolve(root, ".pylon", "agent", path)),
    [source],
  );
  assert.equal(installed.quietStartup, true);
  assert.deepEqual(await settings(join(legacyDir, "settings.json")), legacy);
});

test("install honors the agent-directory override and propagates missing-source failure", async t => {
  const { root, source, env, run } = await fixture(t);
  env.PI_CODING_AGENT_DIR = join(root, "custom-agent");
  const result = run("./local extension.ts");
  assert.equal(result.status, 0, result.stderr);
  const path = join(env.PI_CODING_AGENT_DIR, "settings.json");
  const installed = await settings(path);
  assert.deepEqual(
    installed.packages.map(path => resolve(env.PI_CODING_AGENT_DIR, path)),
    [source],
  );
  const failure = run();
  assert.equal(failure.status, 1, failure.stderr);
  assert.match(failure.stderr, /Missing install source/);
  assert.deepEqual(await settings(path), installed);
});

test("project install retains Pi's trust gate and forwards --local and --approve", async t => {
  const { root, cwd, source, env, run } = await fixture(t);
  env.PI_CODING_AGENT_DIR = join(root, "agent");
  const blocked = run(source, "--local", "--no-approve");
  assert.equal(blocked.status, 1, blocked.stderr);
  await assert.rejects(readFile(join(cwd, ".pi", "settings.json")), { code: "ENOENT" });
  const approved = run(source, "--local", "--approve");
  assert.equal(approved.status, 0, approved.stderr);
  const installed = await settings(join(cwd, ".pi", "settings.json"));
  assert.deepEqual(
    installed.packages.map(path => resolve(cwd, ".pi", path)),
    [source],
  );
  await assert.rejects(readFile(join(env.PI_CODING_AGENT_DIR, "settings.json")), { code: "ENOENT" });
});
