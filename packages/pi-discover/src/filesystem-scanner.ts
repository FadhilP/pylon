import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { open, lstat, opendir, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { escapesRoot } from "./search-common.ts";
import { languageFor } from "./symbols.ts";

/** Bump when filesystem inventory semantics change. */
export const FILESYSTEM_POLICY = "filesystem-v1";
export const FILESYSTEM_VERIFY_MS = 300_000;
export const MAX_PREPARED_BYTES = 64 * 1024 * 1024;

const MAX_FILE_BYTES = 512 * 1024;
const MAX_IGNORE_BYTES = 512 * 1024;
const MAX_VISITED_ENTRIES = 100_000;
const MAX_DEPTH = 128;

export type FilesystemScan = { files: Map<string, string>; token: string };

type BigintStat = BigIntStats;

type IgnoreScope = { directory: string; matcher: ReturnType<typeof ignore> };

/** A lossless identity for the metadata used to validate an inventory entry. */
export function filesystemFingerprint(stat: BigintStat): string {
  return `size=${stat.size};mtimeNs=${stat.mtimeNs};ctimeNs=${stat.ctimeNs};dev=${stat.dev};ino=${stat.ino}`;
}

function timeoutError(): Error {
  return new Error("filesystem scan timed out");
}

function mutationError(path: string): Error {
  return new Error(`filesystem path changed while being read: ${path}`);
}

function normalPath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function lstatBigint(path: string): Promise<BigintStat> {
  return (await lstat(path, { bigint: true })) as BigintStat;
}

function isSafeDescendant(root: string, path: string): boolean {
  return !escapesRoot(root, path) && path !== root;
}

/**
 * Check every directory component without resolving a link. This is intentionally not an
 * adversarially atomic containment primitive: a hostile process can still race filesystem
 * operations between these checks. It does make ordinary changes fail rather than escape.
 */
async function assertSafeComponents(root: string, absolute: string): Promise<void> {
  if (!isSafeDescendant(root, absolute)) throw new Error("filesystem path must stay within workspace");
  const parts = relative(root, absolute).split(sep);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    if (!part || part === "." || part === "..") throw new Error("filesystem path must stay within workspace");
    current = join(current, part);
    const stat = await lstatBigint(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`filesystem path has unsafe directory: ${current}`);
    const physical = await realpath(current);
    if (escapesRoot(root, physical)) throw new Error(`filesystem directory escapes workspace: ${current}`);
  }
}

async function validateRoot(root: string): Promise<string> {
  const lexical = resolve(root);
  const stat = await lstatBigint(lexical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("filesystem root must be a real directory");
  const physical = await realpath(lexical);
  // Callers provide canonical roots. Rejecting a different physical root avoids treating a
  // root symlink/junction as a safe lexical prefix on platforms where lstat is ambiguous.
  if (process.platform !== "win32" && physical !== lexical) throw new Error("filesystem root must be canonical");
  return physical;
}

async function validateDirectory(root: string, path: string): Promise<void> {
  const before = await lstatBigint(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`filesystem directory is unsafe: ${path}`);
  const physical = await realpath(path);
  if (escapesRoot(root, physical)) throw new Error(`filesystem directory escapes workspace: ${path}`);
  const after = await lstatBigint(path);
  if (!after.isDirectory() || after.isSymbolicLink() || filesystemFingerprint(before) !== filesystemFingerprint(after))
    throw mutationError(path);
  const finalPhysical = await realpath(path);
  if (finalPhysical !== physical || escapesRoot(root, finalPhysical)) throw mutationError(path);
}

async function readRegularBounded(path: string, limit: number): Promise<{ data: Buffer; fingerprint: string }> {
  const before = await lstatBigint(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`filesystem file is unsafe: ${path}`);
  if (before.size > BigInt(limit)) throw new Error(`filesystem file exceeds ${limit} byte limit: ${path}`);

  const handle = await open(path, "r");
  try {
    const opened = (await handle.stat({ bigint: true })) as BigintStat;
    const fingerprint = filesystemFingerprint(before);
    if (!opened.isFile() || filesystemFingerprint(opened) !== fingerprint) throw mutationError(path);

    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= limit) {
      const size = Math.min(64 * 1024, limit + 1 - length);
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(chunk, 0, size, length);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (length > limit) throw new Error(`filesystem file exceeds ${limit} byte limit: ${path}`);
    if (BigInt(length) !== opened.size) throw mutationError(path);

    const closed = (await handle.stat({ bigint: true })) as BigintStat;
    if (filesystemFingerprint(closed) !== fingerprint) throw mutationError(path);
    const after = await lstatBigint(path);
    if (!after.isFile() || after.isSymbolicLink() || filesystemFingerprint(after) !== fingerprint)
      throw mutationError(path);
    return { data: Buffer.concat(chunks, length), fingerprint };
  } finally {
    await handle.close();
  }
}

async function readIgnoreFile(
  directory: string,
  path: string,
): Promise<{ data: Buffer; fingerprint: string } | undefined> {
  const ignorePath = join(directory, ".gitignore");
  let stat: BigintStat;
  try {
    stat = await lstatBigint(ignorePath);
  } catch (error: any) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  // A symlinked ignore file must never cause content outside the tree to influence scanning.
  if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
  try {
    return await readRegularBounded(ignorePath, MAX_IGNORE_BYTES);
  } catch (error) {
    throw new Error(`could not read .gitignore at ${path || "."}: ${String(error)}`);
  }
}

function ignoredBy(scopes: readonly IgnoreScope[], path: string): boolean {
  let ignored = false;
  for (const scope of scopes) {
    const scoped = scope.directory ? path.slice(scope.directory.length + 1) : path;
    if (!scoped || scoped.startsWith("../")) continue;
    const result = scope.matcher.test(scoped);
    // `unignored` is significant: it is a later matching negation, not a second independent
    // source of truth to OR with an ancestor/default result.
    if (result.ignored || result.unignored) ignored = result.ignored && !result.unignored;
  }
  return ignored;
}

function hardExcluded(path: string, excludedPath: string | undefined): boolean {
  if (process.platform === "win32") {
    path = path.toLowerCase();
    excludedPath = excludedPath?.toLowerCase();
  }
  if (path.split("/").includes(".git")) return true;
  return (
    !!excludedPath &&
    (path === excludedPath ||
      path === `${excludedPath}-wal` ||
      path === `${excludedPath}-shm` ||
      path === `${excludedPath}-journal`)
  );
}

function normalizedExclusion(root: string, excludedPath: string | undefined): string | undefined {
  if (!excludedPath) return undefined;
  const absolute = resolve(root, excludedPath);
  if (!isSafeDescendant(root, absolute)) return undefined;
  return normalPath(relative(root, absolute));
}

function checkDeadline(deadline: number): void {
  if (Date.now() > deadline) throw timeoutError();
}

/**
 * Walk a canonical workspace without following links. Ignore rules are evaluated in scope,
 * so a nested .gitignore replaces an ancestor decision only after its parent was traversable.
 */
export async function scanFilesystem(
  root: string,
  excludedPath: string | undefined,
  timeoutMs: number,
): Promise<FilesystemScan> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new Error("filesystem scan timeout must be a non-negative number");
  const deadline = Date.now() + timeoutMs;
  checkDeadline(deadline);
  const physicalRoot = await validateRoot(root);
  checkDeadline(deadline);

  const defaultMatcher = ignore({ ignorecase: false }).add([".*", "node_modules/", "dist/", "build/", "coverage/"]);
  const excluded = normalizedExclusion(physicalRoot, excludedPath);
  const files = new Map<string, string>();
  const ignoreContents: Array<[string, Buffer, string]> = [];
  let visited = 0;
  let preparedBytes = 0n;
  let ignoreBytes = 0;

  const visit = async (
    directory: string,
    relativeDirectory: string,
    depth: number,
    inherited: readonly IgnoreScope[],
  ): Promise<void> => {
    checkDeadline(deadline);
    await validateDirectory(physicalRoot, directory);
    checkDeadline(deadline);
    const content = await readIgnoreFile(directory, relativeDirectory);
    checkDeadline(deadline);
    // Traversal already established that this directory is included. A deeper rule may
    // have reopened it against an ancestor matcher; carry that decision into descendants.
    inherited = inherited.map(scope => {
      const path = scope.directory ? relativeDirectory.slice(scope.directory.length + 1) : relativeDirectory;
      if (!path || !scope.matcher.test(`${path}/`).ignored) return scope;
      const literal = path.replace(/([\\*?\[\] !#])/g, "\\$1");
      return { ...scope, matcher: ignore({ ignorecase: false }).add(scope.matcher).add(`!/${literal}/`) };
    });
    const scopes = content
      ? [
          ...inherited,
          { directory: relativeDirectory, matcher: ignore({ ignorecase: false }).add(content.data.toString("utf8")) },
        ]
      : inherited;
    if (content) {
      ignoreBytes += content.data.length;
      if (ignoreBytes > 8 * 1024 * 1024) throw new Error("filesystem ignore source limit exceeded");
      ignoreContents.push([
        relativeDirectory ? `${relativeDirectory}/.gitignore` : ".gitignore",
        content.data,
        content.fingerprint,
      ]);
    }

    // Stream entries so an oversized directory fails without first allocating its inventory.
    for await (const entry of await opendir(directory)) {
      checkDeadline(deadline);
      if (++visited > MAX_VISITED_ENTRIES) throw new Error("filesystem entry limit exceeded");
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const matchPath = entry.isDirectory() ? `${path}/` : path;
      if (hardExcluded(path, excluded) || ignoredBy(scopes, matchPath)) continue;

      const absolute = join(directory, entry.name);
      const stat = await lstatBigint(absolute);
      checkDeadline(deadline);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (depth >= MAX_DEPTH) throw new Error("filesystem directory depth limit exceeded");
        await visit(absolute, path, depth + 1, scopes);
        continue;
      }
      if (!stat.isFile() || !languageFor(path) || stat.size > BigInt(MAX_FILE_BYTES)) continue;
      const fingerprint = filesystemFingerprint(stat);
      preparedBytes += stat.size;
      if (preparedBytes > BigInt(MAX_PREPARED_BYTES)) throw new Error("filesystem prepared source limit exceeded");
      files.set(normalPath(path), fingerprint);
    }
  };

  await visit(physicalRoot, "", 0, [{ directory: "", matcher: defaultMatcher }]);
  checkDeadline(deadline);
  // Recheck the metadata that formed the inventory and rules before returning a token.
  for (const [path, fingerprint] of files) {
    checkDeadline(deadline);
    const absolute = join(physicalRoot, path);
    // Parent directories were checked during traversal; content reads check components again.
    const stat = await lstatBigint(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || filesystemFingerprint(stat) !== fingerprint)
      throw mutationError(path);
  }
  for (const [path, _content, fingerprint] of ignoreContents) {
    checkDeadline(deadline);
    const stat = await lstatBigint(join(physicalRoot, path));
    if (!stat.isFile() || stat.isSymbolicLink() || filesystemFingerprint(stat) !== fingerprint)
      throw mutationError(path);
  }
  checkDeadline(deadline);
  const hash = createHash("sha256");
  const add = (value: string | Buffer) => {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
    hash.update(`${data.length}:`);
    hash.update(data);
  };
  add(FILESYSTEM_POLICY);
  for (const [path, content] of ignoreContents.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    add(path);
    add(content);
  }
  for (const [path, fingerprint] of [...files.entries()].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    add(path);
    add(fingerprint);
  }
  return { files, token: hash.digest("hex") };
}

/** Read one inventoried file once and reject changes before, during, or after the read. */
export async function readFilesystemFile(
  root: string,
  path: string,
  expectedFingerprint: string,
): Promise<{ data: Buffer; fingerprint: string }> {
  const physicalRoot = await validateRoot(root);
  const absolute = resolve(physicalRoot, path);
  await assertSafeComponents(physicalRoot, absolute);
  const initial = await lstatBigint(absolute);
  if (!initial.isFile() || initial.isSymbolicLink() || filesystemFingerprint(initial) !== expectedFingerprint)
    throw mutationError(path);
  if (initial.size > BigInt(MAX_FILE_BYTES))
    throw new Error(`filesystem file exceeds ${MAX_FILE_BYTES} byte limit: ${path}`);

  const result = await readRegularBounded(absolute, MAX_FILE_BYTES);
  if (result.fingerprint !== expectedFingerprint) throw mutationError(path);
  await assertSafeComponents(physicalRoot, absolute);
  const final = await lstatBigint(absolute);
  if (!final.isFile() || final.isSymbolicLink() || filesystemFingerprint(final) !== expectedFingerprint)
    throw mutationError(path);
  return result;
}
