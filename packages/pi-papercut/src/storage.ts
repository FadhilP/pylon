import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  emptyState,
  isPapercutState,
  type PapercutState,
} from "./papercuts.ts";

export const MAX_STATE_BYTES = 2 * 1024 * 1024;
const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 30_000;
type LockOwner = { version: 1; token: string; pid: number; createdAt: string };

export function normalizeProjectIdentity(
  path: string,
  platform = process.platform,
) {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  return platform === "win32"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

async function hasGitMarker(directory: string) {
  try {
    const marker = await stat(join(directory, ".git"));
    return marker.isDirectory() || marker.isFile();
  } catch (error: any) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    return false;
  }
}

export async function projectRoot(cwd: string) {
  const fallback = await realpath(cwd).catch(() => resolve(cwd));
  let current = fallback;
  while (current !== parse(current).root && dirname(current) !== current) {
    if (await hasGitMarker(current)) return current;
    current = dirname(current);
  }
  return (await hasGitMarker(current)) ? current : fallback;
}

export function statePath(agentDir: string, root: string) {
  const id = createHash("sha256")
    .update(normalizeProjectIdentity(root))
    .digest("hex")
    .slice(0, 32);
  return join(agentDir, "pi-papercut", "projects", `${id}.json`);
}

const ownerPath = (lockPath: string) => join(lockPath, "owner.json");
const processAlive = (pid: number) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
};
async function readLockOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const value = JSON.parse(await readFile(ownerPath(lockPath), "utf8"));
    return value?.version === 1 &&
      typeof value.token === "string" &&
      Number.isSafeInteger(value.pid) &&
      typeof value.createdAt === "string"
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
async function removeStaleLock(lockPath: string) {
  const before = await readLockOwner(lockPath);
  const age =
    Date.now() -
    (await stat(lockPath).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
  if (age <= LOCK_STALE_MS || (before && processAlive(before.pid)))
    return false;
  const after = await readLockOwner(lockPath);
  if ((before?.token ?? "") !== (after?.token ?? "")) return false;
  await rm(lockPath, { recursive: true, force: true });
  return true;
}

async function writeLockOwner(lockPath: string, token: string) {
  await writeFile(
    ownerPath(lockPath),
    JSON.stringify({
      version: 1,
      token,
      pid: process.pid,
      createdAt: new Date().toISOString(),
    } satisfies LockOwner),
    { mode: 0o600, flag: "wx" },
  );
}

/** Returns false when another holder owns the lock; throws when we won but could not claim it. */
async function tryAcquireLock(path: string, lockPath: string, token: string) {
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error: any) {
    if (error?.code === "EEXIST") return false;
    throw new Error(`unable to lock papercut state: ${path}`, { cause: error });
  }
  try {
    await writeLockOwner(lockPath, token);
    return true;
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
    throw new Error(`unable to initialize papercut state lock: ${path}`, {
      cause: error,
    });
  }
}

async function acquireLock(path: string, lockPath: string, token: string) {
  for (let attempt = 0; attempt <= LOCK_ATTEMPTS; attempt++) {
    if (await tryAcquireLock(path, lockPath, token)) return;
    if (!(await removeStaleLock(lockPath))) await delay(LOCK_RETRY_MS);
  }
  throw new Error(`unable to lock papercut state: ${path}`);
}

async function withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`,
    token = randomUUID(),
    parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  await acquireLock(path, lockPath, token);
  try {
    return await task();
  } finally {
    if ((await readLockOwner(lockPath))?.token === token)
      await rm(lockPath, { recursive: true, force: true });
  }
}

async function readState(path: string, root: string): Promise<PapercutState> {
  try {
    const info = await stat(path);
    if (info.size > MAX_STATE_BYTES)
      throw new Error("papercut state exceeds 2 MiB limit");
    const value = JSON.parse(await readFile(path, "utf8"));
    if (
      !isPapercutState(value) ||
      normalizeProjectIdentity(value.projectRoot) !==
        normalizeProjectIdentity(root)
    )
      throw Object.assign(new Error("unsupported papercut state"), {
        code: "PAPERCUT_INVALID_STATE",
      });
    return value;
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyState(root);
    if (
      !(error instanceof SyntaxError) &&
      error?.code !== "PAPERCUT_INVALID_STATE"
    )
      throw error;
    await rename(path, `${path}.corrupt-${randomUUID()}`);
    return emptyState(root);
  }
}

async function writeState(path: string, state: PapercutState) {
  const bytes = JSON.stringify(state, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > MAX_STATE_BYTES)
    throw new Error("papercut state exceeds 2 MiB limit");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r").catch(() => undefined);
    if (directory)
      try {
        await directory.sync().catch(() => {});
      } finally {
        await directory.close();
      }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function loadProjectState(agentDir: string, cwd: string) {
  const root = await projectRoot(cwd),
    path = statePath(agentDir, root);
  return withLock(path, async () => ({
    root,
    path,
    state: await readState(path, root),
  }));
}

export async function updateProjectState<T>(
  agentDir: string,
  cwd: string,
  update: (state: PapercutState) => { state: PapercutState; result: T },
): Promise<{ root: string; path: string; state: PapercutState; result: T }> {
  const root = await projectRoot(cwd),
    path = statePath(agentDir, root);
  return withLock(path, async () => {
    const current = await readState(path, root);
    const { state, result } = update(current);
    if (!isPapercutState(state))
      throw new Error("refusing to write invalid papercut state");
    await writeState(path, state);
    return { root, path, state, result };
  });
}
