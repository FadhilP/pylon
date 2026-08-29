import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { migratePylonStorage, preparePylonStorage } from "../bin/storage.mjs";

const roots = new Set();

async function home() {
  const path = await mkdtemp(join(tmpdir(), "pylon-storage-"));
  roots.add(path);
  return path;
}

async function legacy(path, files = { "auth.json": "secret", "sessions/repo/session.jsonl": "history" }) {
  for (const [name, content] of Object.entries(files)) {
    const target = join(path, ".pi", "agent", name);
    await mkdir(resolve(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
}

test.after(async () => {
  await Promise.all([...roots].map(path => rm(path, { recursive: true, force: true })));
});

test("fresh installs select Pylon storage without creating legacy state", async () => {
  const root = await home();
  const env = {};
  const result = await preparePylonStorage({ homeDir: root, env, log: () => {} });
  assert.equal(result.status, "no-legacy-data");
  assert.equal(result.agentDir, join(root, ".pylon", "agent"));
  assert.equal(env.PI_CODING_AGENT_DIR, result.agentDir);
  await assert.rejects(stat(join(root, ".pi")), { code: "ENOENT" });
});

test("automatic migration copies legacy state and leaves its source intact", async () => {
  const root = await home();
  await legacy(root);
  await mkdir(join(root, ".pylon"));
  await writeFile(join(root, ".pylon", "update-check.json"), "cache");
  const env = {};
  const messages = [];
  const result = await preparePylonStorage({ homeDir: root, env, log: message => messages.push(message) });
  assert.equal(result.status, "migrated");
  assert.equal(env.PI_CODING_AGENT_DIR, join(root, ".pylon", "agent"));
  assert.equal(await readFile(join(root, ".pylon", "agent", "auth.json"), "utf8"), "secret");
  assert.equal(await readFile(join(root, ".pylon", "agent", "sessions", "repo", "session.jsonl"), "utf8"), "history");
  assert.equal(await readFile(join(root, ".pi", "agent", "auth.json"), "utf8"), "secret");
  assert.equal(await readFile(join(root, ".pylon", "update-check.json"), "utf8"), "cache");
  assert.match(messages[0], /original remains/i);
});

test("an explicit Pi agent directory bypasses migration", async () => {
  const root = await home();
  await legacy(root);
  const env = { PI_CODING_AGENT_DIR: join(root, "custom") };
  const result = await preparePylonStorage({ homeDir: root, env });
  assert.equal(result.status, "override");
  assert.equal(result.agentDir, join(root, "custom"));
  await assert.rejects(stat(join(root, ".pylon", "agent")), { code: "ENOENT" });
});

test("failed automatic migration cleans up and falls back to legacy state", async () => {
  const root = await home();
  await legacy(root);
  const env = {};
  const warnings = [];
  const result = await preparePylonStorage({
    homeDir: root,
    env,
    copy: async () => {
      throw new Error("copy blocked");
    },
    warn: message => warnings.push(message),
  });
  assert.equal(result.status, "legacy-fallback");
  assert.equal(env.PI_CODING_AGENT_DIR, join(root, ".pi", "agent"));
  assert.match(warnings[0], /pylon migrate/);
  assert.deepEqual(await readdir(join(root, ".pylon")), []);
});

test("migration never overwrites an existing Pylon agent directory", async () => {
  const root = await home();
  await legacy(root, { "auth.json": "legacy" });
  await mkdir(join(root, ".pylon", "agent"), { recursive: true });
  await writeFile(join(root, ".pylon", "agent", "auth.json"), "current");
  const result = await migratePylonStorage({ homeDir: root });
  assert.equal(result.status, "already-present");
  assert.equal(await readFile(join(root, ".pylon", "agent", "auth.json"), "utf8"), "current");
});

test("a concurrent migration winner is accepted and only the losing temporary copy is removed", async () => {
  const root = await home();
  await legacy(root);
  const agentDir = join(root, ".pylon", "agent");
  const result = await migratePylonStorage({
    homeDir: root,
    rename: async () => {
      await mkdir(agentDir);
      await writeFile(join(agentDir, "winner"), "yes");
      const error = new Error("already exists");
      error.code = "EEXIST";
      throw error;
    },
  });
  assert.equal(result.status, "already-present");
  assert.equal(await readFile(join(agentDir, "winner"), "utf8"), "yes");
  assert.deepEqual((await readdir(join(root, ".pylon"))).sort(), ["agent"]);
});

test("manual CLI migration succeeds without loading the web server", async () => {
  const root = await home();
  await legacy(root, { "settings.json": "{}" });
  const executable = fileURLToPath(new URL("../bin/pylon.mjs", import.meta.url));
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  delete env.PI_CODING_AGENT_DIR;
  const result = spawnSync(process.execPath, [executable, "migrate"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Migrated Pylon data/);
  assert.equal(await readFile(join(root, ".pylon", "agent", "settings.json"), "utf8"), "{}");
});

test("manual CLI migration fails without overwriting an invalid target", async () => {
  const root = await home();
  await legacy(root, { "auth.json": "legacy" });
  await mkdir(join(root, ".pylon"));
  await writeFile(join(root, ".pylon", "agent"), "not a directory");
  const executable = fileURLToPath(new URL("../bin/pylon.mjs", import.meta.url));
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  delete env.PI_CODING_AGENT_DIR;
  const result = spawnSync(process.execPath, [executable, "migrate"], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not a directory/);
  assert.equal(await readFile(join(root, ".pylon", "agent"), "utf8"), "not a directory");
  assert.equal(await readFile(join(root, ".pi", "agent", "auth.json"), "utf8"), "legacy");
});

test("standalone packages retain Pi's default storage", async () => {
  const root = await home();
  const config = new URL("../packages/pi-advisor/src/config.ts", import.meta.url).href;
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  delete env.PI_CODING_AGENT_DIR;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--input-type=module",
      "--eval",
      "const { configPath } = await import(process.argv[1]); console.log(configPath());",
      config,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(root, ".pi", "agent", "pi-advisor", "config.json"));
});
