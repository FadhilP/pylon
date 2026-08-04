import { cp, chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function paths(home) {
  return {
    agentDir: join(home, ".pylon", "agent"),
    legacyDir: join(home, ".pi", "agent"),
  };
}

async function directoryState(path, inspect = stat) {
  try {
    return (await inspect(path)).isDirectory() ? "directory" : "invalid";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));

async function acquireMigrationLock(path, agentDir, inspect, openFile = open) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await openFile(path, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (await directoryState(agentDir, inspect) === "directory") return;
      await wait(100);
    }
  }
  throw new Error("another Pylon storage migration is still finishing");
}

function explicitAgentDir(value, home) {
  if (!value) return;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return resolve(home, value.slice(2));
  return resolve(value);
}

/** Copies legacy Pi state into Pylon storage without changing or deleting the source. */
export async function migratePylonStorage(options = {}) {
  const home = resolve(options.homeDir ?? homedir());
  const { agentDir, legacyDir } = paths(home);
  const inspect = options.stat ?? stat;
  const pylonDir = join(home, ".pylon");
  await mkdir(pylonDir, { recursive: true, mode: 0o700 });
  await chmod(pylonDir, 0o700);

  const targetState = await directoryState(agentDir, inspect);
  if (targetState === "directory") return { status: "already-present", agentDir, legacyDir };
  if (targetState === "invalid") throw new Error(`${agentDir} exists but is not a directory`);

  const sourceState = await directoryState(legacyDir, inspect);
  if (sourceState === "missing") return { status: "no-legacy-data", agentDir, legacyDir };
  if (sourceState === "invalid") throw new Error(`${legacyDir} exists but is not a directory`);

  const temporary = `${agentDir}.migrating-${process.pid}-${(options.randomId ?? randomUUID)()}`;
  const lockPath = `${agentDir}.migration.lock`;
  const copy = options.copy ?? cp;
  const move = options.rename ?? rename;
  const remove = options.remove ?? rm;
  let lock;
  try {
    await copy(legacyDir, temporary, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
      dereference: false,
    });
    if (await directoryState(temporary, inspect) !== "directory") throw new Error("migration copy is not a directory");
    await chmod(temporary, 0o700);
    lock = await acquireMigrationLock(lockPath, agentDir, inspect, options.open);
    if (!lock || await directoryState(agentDir, inspect) === "directory") return { status: "already-present", agentDir, legacyDir };
    if (await directoryState(agentDir, inspect) === "invalid") throw new Error(`${agentDir} exists but is not a directory`);
    try {
      await move(temporary, agentDir);
    } catch (error) {
      // A non-cooperating process may still have created the target after our final check.
      if (await directoryState(agentDir, inspect) !== "directory") throw error;
      return { status: "already-present", agentDir, legacyDir };
    }
    return { status: "migrated", agentDir, legacyDir };
  } finally {
    await lock?.close().catch(() => undefined);
    if (lock) await remove(lockPath, { force: true }).catch(() => undefined);
    await remove(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Selects coherent Pylon storage, falling back to legacy Pi state if automatic migration fails. */
export async function preparePylonStorage(options = {}) {
  const env = options.env ?? process.env;
  const home = resolve(options.homeDir ?? homedir());
  const overridden = explicitAgentDir(env[AGENT_DIR_ENV], home);
  if (overridden) return { status: "override", agentDir: overridden, legacyDir: paths(home).legacyDir };

  try {
    const result = await migratePylonStorage({ ...options, homeDir: home });
    env[AGENT_DIR_ENV] = result.agentDir;
    if (result.status === "migrated") {
      (options.log ?? console.log)(`Migrated Pylon data to ${result.agentDir}. The original remains at ${result.legacyDir}.`);
    }
    return result;
  } catch (error) {
    const { agentDir, legacyDir } = paths(home);
    if (await directoryState(legacyDir, options.stat ?? stat) !== "directory") throw error;
    env[AGENT_DIR_ENV] = legacyDir;
    const message = error instanceof Error ? error.message : String(error);
    (options.warn ?? console.warn)(`Pylon storage migration failed: ${message}. Using ${legacyDir}; run \`pylon migrate\` to retry.`);
    return { status: "legacy-fallback", agentDir: legacyDir, legacyDir, migrationError: error };
  }
}
