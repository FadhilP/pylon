import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, stat } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { withDirectoryLock, writeBytesAtomic } from "pylon-core/file-lock";
import { emptyState, isPapercutState, type PapercutState } from "./papercuts.ts";

export const MAX_STATE_BYTES = 2 * 1024 * 1024;

export function normalizeProjectIdentity(path: string, platform = process.platform) {
  const normalized = path.replace(/\\/g, "/").replace(/\/$/, "");
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
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
  const id = createHash("sha256").update(normalizeProjectIdentity(root)).digest("hex").slice(0, 32);
  return join(agentDir, "pi-papercut", "projects", `${id}.json`);
}

async function withLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  return withDirectoryLock(path, task, { name: "papercut state", retryMs: 25 });
}

async function readState(path: string, root: string): Promise<PapercutState> {
  try {
    const info = await stat(path);
    if (info.size > MAX_STATE_BYTES) throw new Error("papercut state exceeds 2 MiB limit");
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!isPapercutState(value) || normalizeProjectIdentity(value.projectRoot) !== normalizeProjectIdentity(root))
      throw Object.assign(new Error("unsupported papercut state"), { code: "PAPERCUT_INVALID_STATE" });
    return value;
  } catch (error: any) {
    if (error?.code === "ENOENT") return emptyState(root);
    if (!(error instanceof SyntaxError) && error?.code !== "PAPERCUT_INVALID_STATE") throw error;
    await rename(path, `${path}.corrupt-${randomUUID()}`);
    return emptyState(root);
  }
}

async function writeState(path: string, state: PapercutState) {
  const bytes = JSON.stringify(state, null, 2) + "\n";
  if (Buffer.byteLength(bytes) > MAX_STATE_BYTES) throw new Error("papercut state exceeds 2 MiB limit");
  await writeBytesAtomic(path, bytes);
}

export async function loadProjectState(agentDir: string, cwd: string) {
  const root = await projectRoot(cwd),
    path = statePath(agentDir, root);
  return withLock(path, async () => ({ root, path, state: await readState(path, root) }));
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
    if (!isPapercutState(state)) throw new Error("refusing to write invalid papercut state");
    await writeState(path, state);
    return { root, path, state, result };
  });
}
