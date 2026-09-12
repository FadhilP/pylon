import { constants } from "node:fs";
import { cp, chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function paths(home) {
  return { agentDir: join(home, ".pylon", "agent"), legacyDir: join(home, ".pi", "agent") };
}

async function directoryState(path, inspect = lstat) {
  try {
    return (await inspect(path)).isDirectory() ? "directory" : "invalid";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

async function acquireMigrationLock(path, agentDir, inspect, openFile = open) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await openFile(path, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if ((await directoryState(agentDir, inspect)) === "directory") return;
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

const PROJECT_REGISTRY_RELATIVE = join("pylon-web", "projects.json");
const PROJECT_REGISTRY_MAX_VERSION = 13;
const RECOVERY_MARKER_RELATIVE = join("pylon-web", ".legacy-recovery-v1.json");

async function pathState(path, inspect = lstat) {
  try {
    const value = await inspect(path);
    if (value.isDirectory()) return "directory";
    if (value.isFile()) return "file";
    return "unsupported";
  } catch (error) {
    if (error?.code === "ENOENT") return "missing";
    throw error;
  }
}

async function recoveryComplete(markerPath, options = {}) {
  const inspect = options.lstat ?? lstat;
  const state = await pathState(markerPath, inspect);
  if (state === "missing") return false;
  if (state !== "file") throw new Error("Pylon recovery marker is invalid");
  let marker;
  try {
    marker = JSON.parse(await (options.readFile ?? readFile)(markerPath, "utf8"));
  } catch {
    throw new Error("Pylon recovery marker is invalid");
  }
  if (
    !marker ||
    marker.version !== 1 ||
    !Number.isSafeInteger(marker.importedFiles) ||
    !Number.isSafeInteger(marker.importedProjects) ||
    !Number.isSafeInteger(marker.conflicts)
  ) {
    throw new Error("Pylon recovery marker is invalid");
  }
  return true;
}

async function acquireRecoveryLock(path, openFile = open) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      return await openFile(path, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await wait(100);
    }
  }
  throw new Error("another Pylon storage recovery is still finishing");
}

function projectIdentity(directory) {
  const normalized = resolve(directory).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseProjectRegistry(text, label) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} project registry is not valid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} project registry is invalid`);
  }
  const projects =
    value.version === 1 && Array.isArray(value.directories)
      ? value.directories.map(directory => ({ directory }))
      : Number.isInteger(value.version) && value.version >= 2 && value.version <= PROJECT_REGISTRY_MAX_VERSION && Array.isArray(value.projects)
        ? value.projects
        : undefined;
  if (
    !projects ||
    projects.some(
      project =>
        !project ||
        typeof project !== "object" ||
        Array.isArray(project) ||
        typeof project.directory !== "string" ||
        !project.directory ||
        project.directory.length > 4_096,
    )
  ) {
    throw new Error(`${label} project registry has invalid projects`);
  }
  return { value, projects };
}

async function mergeLegacyProjectRegistry(agentDir, legacyDir, options = {}) {
  const inspect = options.lstat ?? lstat;
  const read = options.readFile ?? readFile;
  const write = options.writeFile ?? writeFile;
  const targetPath = join(agentDir, PROJECT_REGISTRY_RELATIVE);
  const sourcePath = join(legacyDir, PROJECT_REGISTRY_RELATIVE);
  const sourceParentState = await pathState(dirname(sourcePath), inspect);
  if (sourceParentState === "missing") return { importedProjects: 0 };
  if (sourceParentState !== "directory") throw new Error("legacy project registry parent is not a directory");
  const sourceState = await pathState(sourcePath, inspect);
  if (sourceState === "missing") return { importedProjects: 0 };
  if (sourceState !== "file") throw new Error("legacy project registry is not a regular file");
  const sourceText = await read(sourcePath, "utf8");
  const source = parseProjectRegistry(sourceText, "legacy");

  const targetParentState = await pathState(dirname(targetPath), inspect);
  if (targetParentState !== "missing" && targetParentState !== "directory") {
    throw new Error("Pylon project registry parent is not a directory");
  }
  const targetState = await pathState(targetPath, inspect);
  if (targetState === "unsupported" || targetState === "directory") {
    throw new Error("Pylon project registry is not a regular file");
  }
  const targetText = targetState === "file" ? await read(targetPath, "utf8") : undefined;
  const target = targetText !== undefined ? parseProjectRegistry(targetText, "Pylon") : undefined;
  if (target && target.value.version !== PROJECT_REGISTRY_MAX_VERSION) {
    throw new Error("Pylon project registry must be upgraded before legacy recovery");
  }
  const known = new Set((target?.projects ?? []).map(project => projectIdentity(project.directory)));
  const additions = source.projects.filter(project => {
    const identity = projectIdentity(project.directory);
    if (known.has(identity)) return false;
    known.add(identity);
    return true;
  });
  if (!additions.length && target) return { importedProjects: 0 };

  const merged = target
    ? { ...target.value, projects: [...target.projects, ...additions] }
    : source.value.version === 1
      ? { version: 1, directories: source.projects.map(project => project.directory) }
      : source.value;
  const mergedText = `${JSON.stringify(merged, null, 2)}\n`;
  parseProjectRegistry(mergedText, "merged");
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  let backupPath;
  if (targetText !== undefined) {
    backupPath = `${targetPath}.pre-legacy-recovery-${(options.randomId ?? randomUUID)()}.bak`;
    await write(backupPath, targetText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  const temporary = `${targetPath}.recovering-${process.pid}-${(options.randomId ?? randomUUID)()}`;
  try {
    await write(temporary, mergedText, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (targetText === undefined) {
      try {
        await (options.link ?? link)(temporary, targetPath);
      } catch (error) {
        if (error?.code === "EEXIST") throw new Error("Pylon project registry changed during recovery");
        throw error;
      }
    } else {
      if ((await read(targetPath, "utf8")) !== targetText) {
        throw new Error("Pylon project registry changed during recovery");
      }
      await (options.rename ?? rename)(temporary, targetPath);
    }
  } finally {
    await (options.remove ?? rm)(temporary, { force: true }).catch(() => undefined);
  }
  return { importedProjects: additions.length || source.projects.length, ...(backupPath ? { backupPath } : {}) };
}

async function copyMissingLegacyFiles(agentDir, legacyDir, options = {}, relative = "") {
  const list = options.readdir ?? readdir;
  const inspect = options.lstat ?? lstat;
  const copy = options.copyFile ?? copyFile;
  const remove = options.remove ?? rm;
  let importedFiles = 0;
  let conflicts = 0;
  for (const entry of await list(join(legacyDir, relative), { withFileTypes: true })) {
    const childRelative = join(relative, entry.name);
    if (childRelative === PROJECT_REGISTRY_RELATIVE || childRelative === RECOVERY_MARKER_RELATIVE) continue;
    const sourcePath = join(legacyDir, childRelative);
    const targetPath = join(agentDir, childRelative);
    const targetState = await pathState(targetPath, inspect);
    if (entry.isDirectory()) {
      if (targetState === "missing") await mkdir(targetPath, { recursive: true, mode: 0o700 });
      else if (targetState !== "directory") {
        conflicts++;
        continue;
      }
      const nested = await copyMissingLegacyFiles(agentDir, legacyDir, options, childRelative);
      importedFiles += nested.importedFiles;
      conflicts += nested.conflicts;
      continue;
    }
    if (!entry.isFile() || targetState !== "missing") {
      if (!entry.isFile() || targetState !== "file") conflicts++;
      continue;
    }
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    const temporary = `${targetPath}.recovering-${process.pid}-${(options.randomId ?? randomUUID)()}`;
    try {
      await copy(sourcePath, temporary, constants.COPYFILE_EXCL);
      try {
        await (options.link ?? link)(temporary, targetPath);
        importedFiles++;
      } catch (error) {
        if (error?.code === "EEXIST") conflicts++;
        else throw error;
      }
    } finally {
      await remove(temporary, { force: true }).catch(() => undefined);
    }
  }
  return { importedFiles, conflicts };
}

async function recoverExistingPylonStorage(agentDir, legacyDir, options = {}) {
  const inspect = options.lstat ?? lstat;
  const markerPath = join(agentDir, RECOVERY_MARKER_RELATIVE);
  if (await recoveryComplete(markerPath, options)) return { status: "already-present", agentDir, legacyDir };
  const lockPath = `${agentDir}.migration.lock`;
  const lock = await acquireRecoveryLock(lockPath, options.open);
  try {
    if (await recoveryComplete(markerPath, options)) return { status: "already-present", agentDir, legacyDir };
    const merged = await mergeLegacyProjectRegistry(agentDir, legacyDir, options);
    const copied = await copyMissingLegacyFiles(agentDir, legacyDir, options);
    await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
    const markerText = `${JSON.stringify({ version: 1, importedFiles: copied.importedFiles, importedProjects: merged.importedProjects, conflicts: copied.conflicts })}\n`;
    const temporary = `${markerPath}.recovering-${process.pid}-${(options.randomId ?? randomUUID)()}`;
    try {
      await (options.writeFile ?? writeFile)(temporary, markerText, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await (options.link ?? link)(temporary, markerPath);
    } finally {
      await (options.remove ?? rm)(temporary, { force: true }).catch(() => undefined);
    }
    return { status: "recovered", agentDir, legacyDir, ...copied, ...merged };
  } finally {
    await lock.close().catch(() => undefined);
    await (options.remove ?? rm)(lockPath, { force: true }).catch(() => undefined);
  }
}
/** Migrates legacy Pi state into Pylon storage, or recovers missing state when the target already exists. */
export async function migratePylonStorage(options = {}) {
  const home = resolve(options.homeDir ?? homedir());
  const { agentDir, legacyDir } = paths(home);
  const inspect = options.lstat ?? options.stat ?? lstat;
  const pylonDir = join(home, ".pylon");
  await mkdir(pylonDir, { recursive: true, mode: 0o700 });
  await chmod(pylonDir, 0o700);

  const targetState = await directoryState(agentDir, inspect);
  if (targetState === "invalid") throw new Error(`${agentDir} exists but is not a directory`);

  const sourceState = await directoryState(legacyDir, inspect);
  if (targetState === "directory") {
    if (sourceState === "missing") return { status: "already-present", agentDir, legacyDir };
    if (sourceState === "invalid") throw new Error(`${legacyDir} exists but is not a directory`);
    return recoverExistingPylonStorage(agentDir, legacyDir, options);
  }
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
    if ((await directoryState(temporary, inspect)) !== "directory")
      throw new Error("migration copy is not a directory");
    await chmod(temporary, 0o700);
    lock = await acquireMigrationLock(lockPath, agentDir, inspect, options.open);
    if (!lock || (await directoryState(agentDir, inspect)) === "directory")
      return { status: "already-present", agentDir, legacyDir };
    if ((await directoryState(agentDir, inspect)) === "invalid")
      throw new Error(`${agentDir} exists but is not a directory`);
    try {
      await move(temporary, agentDir);
    } catch (error) {
      // A non-cooperating process may still have created the target after our final check.
      if ((await directoryState(agentDir, inspect)) !== "directory") throw error;
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
  const defaults = paths(home);
  const overridden = explicitAgentDir(env[AGENT_DIR_ENV], home);
  if (overridden && projectIdentity(overridden) !== projectIdentity(defaults.agentDir)) {
    return { status: "override", agentDir: overridden, legacyDir: defaults.legacyDir };
  }

  try {
    const result = await migratePylonStorage({ ...options, homeDir: home });
    env[AGENT_DIR_ENV] = result.agentDir;
    if (result.status === "migrated") {
      (options.log ?? console.log)(
        `Migrated Pylon data to ${result.agentDir}. The original remains at ${result.legacyDir}.`,
      );
    } else if (result.status === "recovered") {
      (options.log ?? console.log)(
        `Recovered ${result.importedProjects} legacy project${result.importedProjects === 1 ? "" : "s"} and ${result.importedFiles} missing file${result.importedFiles === 1 ? "" : "s"} into ${result.agentDir}.`,
      );
    }
    return result;
  } catch (error) {
    const { agentDir, legacyDir } = paths(home);
    const message = error instanceof Error ? error.message : String(error);
    const inspect = options.lstat ?? options.stat ?? lstat;
    const targetState = await directoryState(agentDir, inspect);
    if (targetState === "directory") {
      env[AGENT_DIR_ENV] = agentDir;
      (options.warn ?? console.warn)(
        `Pylon legacy recovery failed: ${message}. Continuing with ${agentDir}; stop Pylon and run \`pylon migrate\` to retry.`,
      );
      return { status: "already-present", agentDir, legacyDir, recoveryError: error };
    }
    if (targetState !== "missing") throw error;
    if ((await directoryState(legacyDir, inspect)) !== "directory") throw error;
    env[AGENT_DIR_ENV] = legacyDir;
    (options.warn ?? console.warn)(
      `Pylon storage migration failed: ${message}. Using ${legacyDir}; run \`pylon migrate\` to retry.`,
    );
    return { status: "legacy-fallback", agentDir: legacyDir, legacyDir, migrationError: error };
  }
}
