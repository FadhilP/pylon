import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { git } from "./git.ts";
import {
  canonical,
  confinedFile,
  headRef,
  objectId,
  outside,
  safeRelativePath,
  splitNul,
} from "./worktree-internal.ts";
import {
  type CheckoutState,
  type WorkspaceChangeList,
  type WorkspaceFile,
  type WorkspaceFileContent,
  type WorkspaceFileDelta,
  type WorkspaceFileDiff,
  type WorkspaceFileInventory,
  type WorkspaceFilePage,
} from "./worktree-types.ts";
import { captureCheckoutState, discoverSubmodules, emptyTreeOf, type SubmoduleNode } from "./worktree-checkout.ts";

/** Workspace file listings, reads, and diffs, scoped across submodules. */

const MAX_WORKSPACE_FILES = 10_000;

async function workspaceBaseline(cwd: string, baselineTree?: string): Promise<string> {
  if (baselineTree) return baselineTree;
  try {
    return await git(cwd, ["rev-parse", "--verify", "HEAD^{tree}"]);
  } catch (error) {
    if (!(await headRef(cwd))) throw error;
    return emptyTreeOf(cwd);
  }
}

const underAnyMarker = (markers: string[]) => (path: string) =>
  markers.some(marker => path === marker || path.startsWith(`${marker}/`));

function owningSubmodule(nodes: SubmoduleNode[], path: string): SubmoduleNode | undefined {
  let owner: SubmoduleNode | undefined;
  for (const node of nodes) {
    if (path.startsWith(`${node.path}/`) && (!owner || node.path.length > owner.path.length)) owner = node;
  }
  return owner;
}

interface WorkspaceScope {
  current: CheckoutState;
  baseline: string;
  submodules: SubmoduleNode[];
  markers: string[];
  /** Per repository level (prefix "" = superproject) the relative registered gitlink names. */
  levels: Map<string, Set<string>>;
  underSubmodule(path: string): boolean;
  ownerOf(path: string): SubmoduleNode | undefined;
  revision: string;
  unapplicableSubmoduleChanges: boolean;
}

async function workspaceScope(
  cwd: string,
  baselineTree?: string,
  submoduleBaseline: "recorded" | "head" = "head",
): Promise<WorkspaceScope> {
  const baseline = await workspaceBaseline(cwd, baselineTree);
  const current = await captureCheckoutState(cwd);
  const { nodes, markers, levels } = await discoverSubmodules(current.root, baseline, submoduleBaseline);
  // Nested state aggregates into the revision so nested-only changes refresh the Files views.
  const hash = createHash("sha256").update(`${baseline}\n${current.worktreeTree}\n${current.indexTree}`);
  let unapplicableSubmoduleChanges = false;
  for (const node of nodes) {
    hash.update(
      `\n${node.path}\n${node.baselineTree}\n${node.current.head ?? ""}\n${node.current.worktreeTree}\n${node.current.indexTree}`,
    );
    const headTree = await git(node.root, ["rev-parse", "--verify", "HEAD^{tree}"]).catch(() => emptyTreeOf(node.root));
    if (node.current.worktreeTree !== headTree || node.current.indexTree !== headTree) {
      unapplicableSubmoduleChanges = true;
    }
  }
  return {
    current,
    baseline,
    submodules: nodes,
    markers,
    levels,
    underSubmodule: underAnyMarker(markers),
    ownerOf: path => owningSubmodule(nodes, path),
    revision: hash.digest("base64url").slice(0, 24),
    unapplicableSubmoduleChanges,
  };
}

async function scopeChanges(scope: WorkspaceScope): Promise<WorkspaceFile[]> {
  const files = (await changesBetween(scope.current.root, scope.baseline, scope.current.worktreeTree)).filter(
    file => !scope.underSubmodule(file.path),
  );
  for (const node of scope.submodules) {
    try {
      const nested = await changesBetween(node.root, node.baselineTree, node.current.worktreeTree);
      for (const file of nested) {
        const path = `${node.path}/${file.path}`;
        if (!scope.underSubmodule(path) || scope.ownerOf(path)?.path === node.path) files.push({ ...file, path });
      }
    } catch {
      // A missing nested baseline commit degrades to no nested change entries rather than misreading through the parent.
    }
  }
  return files;
}

const MAX_CACHED_TREE_LISTINGS = 16;
const MAX_CACHED_TREE_LISTING_CODE_UNITS = 2 * 1024 * 1024;
const cachedTreeListings = new Map<string, string>();
let cachedTreeListingCodeUnits = 0;

/** Caches only immutable object listings; refs and failed commands always reach Git. */
async function scopeTreeListing(root: string, object: string): Promise<string> {
  if (!objectId.test(object)) return git(root, ["ls-tree", "-rz", "--name-only", object]);
  // Replacement refs can change even a full object's effective contents (including child trees).
  const replacements = () =>
    git(root, [
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      process.env.GIT_REPLACE_REF_BASE ?? "refs/replace/",
    ]);
  if (await replacements()) return git(root, ["ls-tree", "-rz", "--name-only", object]);
  // Scope roots are realpaths from captureCheckoutState, so this is a canonical physical repository root.
  const key = `${canonical(root)}\0${object}`;
  if (cachedTreeListings.has(key)) {
    const listing = cachedTreeListings.get(key)!;
    cachedTreeListings.delete(key);
    cachedTreeListings.set(key, listing);
    return listing;
  }
  const listing = await git(root, ["ls-tree", "-rz", "--name-only", object]);
  if (listing.length > MAX_CACHED_TREE_LISTING_CODE_UNITS || (await replacements())) return listing;
  // Another collector may have filled this key while Git was running.
  const previous = cachedTreeListings.get(key);
  if (previous !== undefined) {
    cachedTreeListingCodeUnits -= previous.length;
    cachedTreeListings.delete(key);
  }
  while (
    cachedTreeListings.size >= MAX_CACHED_TREE_LISTINGS ||
    cachedTreeListingCodeUnits + listing.length > MAX_CACHED_TREE_LISTING_CODE_UNITS
  ) {
    const oldestKey = cachedTreeListings.keys().next().value as string;
    const oldestListing = cachedTreeListings.get(oldestKey)!;
    cachedTreeListings.delete(oldestKey);
    cachedTreeListingCodeUnits -= oldestListing.length;
  }
  cachedTreeListings.set(key, listing);
  cachedTreeListingCodeUnits += listing.length;
  return listing;
}

async function scopeListings(scope: WorkspaceScope): Promise<{ present: string[]; base: string[] }> {
  const gitlinksAt = (prefix: string) => scope.levels.get(prefix) ?? new Set<string>();
  // Each repository level only strips its own direct gitlink entries; nested submodule contents stay inventoried flat.
  const [currentListing, baseListing] = await Promise.allSettled([
    git(scope.current.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
    scopeTreeListing(scope.current.root, scope.baseline),
  ]);
  if (currentListing.status === "rejected") throw currentListing.reason;
  if (baseListing.status === "rejected") throw baseListing.reason;
  const present = splitNul(currentListing.value).filter(path => !gitlinksAt("").has(path));
  const base = splitNul(baseListing.value).filter(path => !gitlinksAt("").has(path));
  for (const node of scope.submodules) {
    const prefix = `${node.path}/`;
    const links = gitlinksAt(node.path);
    const [nestedPresent, nestedBase] = await Promise.allSettled([
      git(node.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
      scopeTreeListing(node.root, node.baselineTree).catch(() => ""),
    ]);
    if (nestedPresent.status === "rejected") throw nestedPresent.reason;
    if (nestedBase.status === "rejected") throw nestedBase.reason;
    present.push(
      ...splitNul(nestedPresent.value)
        .filter(path => !links.has(path))
        .map(path => `${prefix}${path}`),
    );
    base.push(
      ...splitNul(nestedBase.value)
        .filter(path => !links.has(path))
        .map(path => `${prefix}${path}`),
    );
  }
  return { present, base };
}

async function changesBetween(cwd: string, baselineTree: string, tree: string): Promise<WorkspaceFile[]> {
  const [numstat, names] = await Promise.all([
    git(cwd, ["diff", "--numstat", "-z", "--no-renames", baselineTree, tree]),
    git(cwd, ["diff", "--name-status", "-z", "--no-renames", baselineTree, tree]),
  ]);
  const status = new Map<string, "added" | "modified" | "deleted">();
  const nameParts = splitNul(names);
  for (let index = 0; index + 1 < nameParts.length; index += 2) {
    const kind = nameParts[index].slice(0, 1);
    const path = nameParts[index + 1];
    if (!path) continue;
    status.set(path, kind === "A" ? "added" : kind === "D" ? "deleted" : "modified");
  }
  const files: WorkspaceFile[] = [];
  for (const record of splitNul(numstat).slice(0, 5_000)) {
    const [added, deleted, ...pathParts] = record.split("\t");
    const path = pathParts.join("\t");
    if (!path) continue;
    const safe = safeRelativePath(path);
    files.push(
      added === "-" || deleted === "-"
        ? { path: safe, status: status.get(path), binary: true }
        : { path: safe, status: status.get(path), additions: Number(added), deletions: Number(deleted) },
    );
  }
  return files;
}

export async function inspectWorkspaceChanges(cwd: string, baselineTree?: string): Promise<WorkspaceChangeList> {
  // Apply inspection retains session history; live Files views use each submodule's own HEAD.
  const scope = await workspaceScope(cwd, baselineTree, "recorded");
  return {
    revision: scope.revision,
    files: (await scopeChanges(scope)).slice(0, 5_000),
    ...(scope.unapplicableSubmoduleChanges ? { unapplicableSubmoduleChanges: true } : {}),
  };
}

export async function inspectTreeChanges(cwd: string, baselineTree: string, tree: string): Promise<WorkspaceFile[]> {
  if (!objectId.test(baselineTree) || !objectId.test(tree)) throw Error("Invalid workspace tree.");
  return changesBetween(cwd, baselineTree, tree);
}

/** Git does not track empty directories. Inventory them without walking ignored trees. */
async function workspaceDirectories(
  root: string,
  submodules: string[],
): Promise<{ paths: string[]; truncated: boolean }> {
  const pending = [""];
  const paths: string[] = [];
  let scanned = 0;
  while (pending.length && scanned < MAX_WORKSPACE_FILES) {
    const candidates: string[] = [];
    for (const parent of pending.splice(0, 50)) {
      for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === ".git") continue;
        const path = parent ? `${parent}/${entry.name}` : entry.name;
        if (submodules.some(marker => path === marker || path.startsWith(`${marker}/`))) continue;
        candidates.push(safeRelativePath(path));
        if (++scanned >= MAX_WORKSPACE_FILES) break;
      }
      if (scanned >= MAX_WORKSPACE_FILES) break;
    }
    if (!candidates.length) continue;
    const ignored = await new Promise<Set<string>>((resolve, reject) => {
      const child = execFile(
        "git",
        ["check-ignore", "--stdin", "-z"],
        { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: 10_000, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && error.code !== 1) reject(new Error(String(stderr || error.message)));
          else resolve(new Set(splitNul(stdout)));
        },
      );
      child.stdin?.on("error", () => undefined); // The exit callback reports process failures.
      child.stdin?.end(candidates.join("\0") + "\0");
    });
    const visible = candidates.filter(path => !ignored.has(path));
    paths.push(...visible);
    pending.push(...visible);
  }
  return { paths, truncated: scanned >= MAX_WORKSPACE_FILES || pending.length > 0 };
}

export async function collectWorkspaceFiles(options: {
  cwd: string;
  baselineTree?: string;
  query?: string;
}): Promise<WorkspaceFileInventory> {
  const query = (options.query ?? "").trim().toLocaleLowerCase().slice(0, 200);
  const scope = await workspaceScope(options.cwd, options.baselineTree);
  const [listings, changes, directories] = await Promise.allSettled([
    scopeListings(scope),
    scopeChanges(scope),
    workspaceDirectories(scope.current.root, scope.markers),
  ]);
  if (listings.status === "rejected") throw listings.reason;
  if (changes.status === "rejected") throw changes.reason;
  if (directories.status === "rejected") throw directories.reason;
  const { present, base } = listings.value;
  const changed = new Map(changes.value.map(file => [file.path, file]));
  const files = [...new Set([...present, ...base])].map(safeRelativePath);
  // Registered-but-empty submodules stay visible as non-selectable folders instead of disappearing.
  const folders = new Set(
    scope.markers.filter(marker => !files.some(path => path === marker || path.startsWith(`${marker}/`))),
  );
  const representedDirectories = new Set<string>();
  for (const path of [...files, ...folders]) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++) representedDirectories.add(parts.slice(0, length).join("/"));
  }
  const directoryPaths = new Set(directories.value.paths.filter(path => !representedDirectories.has(path)));
  const allPaths = [...new Set([...files, ...folders, ...directoryPaths])]
    .filter(path => !query || path.toLocaleLowerCase().includes(query))
    .sort((left, right) => Number(changed.has(right)) - Number(changed.has(left)) || left.localeCompare(right));
  const truncated = directories.value.truncated || allPaths.length > MAX_WORKSPACE_FILES;
  const paths = allPaths.slice(0, MAX_WORKSPACE_FILES);
  return {
    revision: scope.revision,
    files: paths.map(path =>
      directoryPaths.has(path)
        ? { path, kind: "directory" as const }
        : (changed.get(path) ?? (folders.has(path) ? { path, kind: "submodule" as const } : { path })),
    ),
    totalCount: paths.length,
    truncated,
  };
}

/** Authoritatively refreshes exact file paths without rebuilding the full workspace listing. */
export async function collectWorkspaceFileDelta(options: {
  cwd: string;
  baselineTree?: string;
  paths: string[];
}): Promise<WorkspaceFileDelta> {
  const paths = [...new Set(options.paths.slice(0, 100).map(safeRelativePath))];
  const scope = await workspaceScope(options.cwd, options.baselineTree);
  const changed = new Map((await scopeChanges(scope)).map(file => [file.path, file]));
  const upserted: WorkspaceFile[] = [];
  const removed: string[] = [];
  let reconcileRequired = options.paths.length > 100;
  for (const path of paths) {
    const owner = scope.ownerOf(path);
    if (!owner && scope.underSubmodule(path)) {
      reconcileRequired = true;
      continue;
    }
    const inner = owner ? path.slice(owner.path.length + 1) : path;
    const root = owner ? owner.root : scope.current.root;
    const baseline = owner ? owner.baselineTree : scope.baseline;
    const absolute = resolve(root, inner);
    if (outside(root, absolute)) {
      reconcileRequired = true;
      continue;
    }
    const current = await lstat(absolute).catch(() => undefined);
    if (current?.isDirectory()) {
      reconcileRequired = true;
      continue;
    }
    const baseType = await git(root, ["cat-file", "-t", `${baseline}:${inner}`]).catch(() => undefined);
    if (baseType && baseType !== "blob") {
      reconcileRequired = true;
      continue;
    }
    const change = changed.get(path);
    if (change) {
      upserted.push(change);
    } else if (current && baseType === "blob") {
      upserted.push({ path });
    } else if (!current && !baseType) {
      removed.push(path);
    } else {
      // A one-sided path without a bounded change record may have fallen outside Git's change cap.
      reconcileRequired = true;
    }
  }
  return { revision: scope.revision, upserted, removed, reconcileRequired };
}

function pageWorkspaceFiles(
  inventory: WorkspaceFileInventory,
  cursor?: string,
  requestedLimit?: number,
): WorkspaceFilePage {
  const limit = Math.min(200, Math.max(1, requestedLimit ?? 200));
  const paths = inventory.files;
  const offset = cursor ? Number(Buffer.from(cursor, "base64url").toString("utf8")) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > paths.length) throw Error("Invalid file cursor.");
  const files = paths.slice(offset, offset + limit);
  const next = offset + files.length;
  return {
    ...inventory,
    files,
    ...(next < paths.length ? { nextCursor: Buffer.from(String(next)).toString("base64url") } : {}),
  };
}

export async function listWorkspaceFiles(options: {
  cwd: string;
  baselineTree?: string;
  query?: string;
  cursor?: string;
  limit?: number;
}): Promise<WorkspaceFilePage> {
  return pageWorkspaceFiles(await collectWorkspaceFiles(options), options.cursor, options.limit);
}

function binary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8_192).includes(0);
}

export async function readWorkspaceFile(options: {
  cwd: string;
  path: string;
  baselineTree?: string;
  view?: "current" | "base";
  maxBytes?: number;
}): Promise<WorkspaceFileContent> {
  const maxBytes = Math.min(1024 * 1024, Math.max(1, options.maxBytes ?? 1024 * 1024));
  const path = safeRelativePath(options.path);
  const scope = await workspaceScope(options.cwd, options.baselineTree);
  const owner = scope.ownerOf(path);
  // Descendant paths route through the deepest owning initialized submodule; everything else stays in the superproject.
  if (!owner && scope.underSubmodule(path)) {
    return { revision: scope.revision, path, state: "deleted" };
  }
  const inner = owner ? path.slice(owner.path.length + 1) : path;
  const root = owner ? owner.root : scope.current.root;
  let content: Buffer;
  if (options.view === "base") {
    const object = `${owner ? owner.baselineTree : scope.baseline}:${inner}`;
    const rawSize = await git(root, ["cat-file", "-s", object]).catch(() => undefined);
    if (rawSize === undefined) return { revision: scope.revision, path, state: "deleted" };
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size > maxBytes) return { revision: scope.revision, path, state: "oversized" };
    content = Buffer.from(await git(root, ["show", object], {}, maxBytes + 1));
  } else {
    try {
      const file = await confinedFile(root, inner);
      const size = (await stat(file)).size;
      if (size > maxBytes) return { revision: scope.revision, path, state: "oversized" };
      content = await readFile(file);
    } catch (error: any) {
      if (error?.code === "ENOENT") return { revision: scope.revision, path, state: "deleted" };
      throw error;
    }
  }
  if (binary(content)) return { revision: scope.revision, path, state: "binary" };
  if (content.byteLength > maxBytes) return { revision: scope.revision, path, state: "oversized" };
  return { revision: scope.revision, path, state: "available", text: content.toString("utf8") };
}

export async function diffWorkspaceFile(options: {
  cwd: string;
  baselineTree?: string;
  path: string;
  maxBytes?: number;
  maxLines?: number;
}): Promise<WorkspaceFileDiff> {
  const maxBytes = Math.min(2 * 1024 * 1024, Math.max(1, options.maxBytes ?? 2 * 1024 * 1024));
  const maxLines = Math.min(20_000, Math.max(1, options.maxLines ?? 20_000));
  const path = safeRelativePath(options.path);
  const scope = await workspaceScope(options.cwd, options.baselineTree);
  const owner = scope.ownerOf(path);
  // Uninitialized registered submodules degrade to an empty diff instead of misreading gitlink output through the parent.
  if (!owner && scope.underSubmodule(path)) {
    return { revision: scope.revision, path, state: "available" };
  }
  const inner = owner ? path.slice(owner.path.length + 1) : path;
  const output = await git(
    owner ? owner.root : scope.current.root,
    [
      "diff",
      "--no-ext-diff",
      "--no-renames",
      "--unified=3",
      owner ? owner.baselineTree : scope.baseline,
      owner ? owner.current.worktreeTree : scope.current.worktreeTree,
      "--",
      inner,
    ],
    {},
    maxBytes + 1,
  );
  if (output.includes("Binary files ") || output.includes("GIT binary patch")) {
    return { revision: scope.revision, path, state: "binary" };
  }
  const lines = output.split(/\r?\n/);
  if (Buffer.byteLength(output, "utf8") > maxBytes || lines.length > maxLines) {
    const bounded = lines.slice(0, maxLines).join("\n");
    return {
      revision: scope.revision,
      path,
      state: "oversized",
      text: Buffer.from(bounded).subarray(0, maxBytes).toString("utf8"),
      truncated: true,
    };
  }
  return { revision: scope.revision, path, state: "available", text: output };
}

export async function collectPlainWorkspaceFiles(options: {
  cwd: string;
  query?: string;
}): Promise<WorkspaceFileInventory> {
  const root = await realpath(options.cwd);
  const query = (options.query ?? "").trim().toLocaleLowerCase().slice(0, 200);
  const paths: string[] = [];
  const directories = new Set<string>();
  const pending = [root];
  let scanned = 0;
  while (pending.length && scanned <= MAX_WORKSPACE_FILES) {
    const directory = pending.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (!entry.isDirectory() && !entry.isFile()) continue;
      scanned++;
      const path = safeRelativePath(relative(root, absolute).replaceAll("\\", "/"));
      if (entry.isDirectory()) {
        pending.push(absolute);
        directories.add(path);
      }
      if (!query || path.toLocaleLowerCase().includes(query)) paths.push(path);
      if (scanned > MAX_WORKSPACE_FILES) break;
    }
  }
  paths.sort((left, right) => left.localeCompare(right));
  const truncated = scanned > MAX_WORKSPACE_FILES || pending.length > 0;
  paths.length = Math.min(paths.length, MAX_WORKSPACE_FILES);
  const revision = createHash("sha256").update(paths.join("\0")).digest("base64url").slice(0, 24);
  return {
    revision,
    files: paths.map(path => (directories.has(path) ? { path, kind: "directory" as const } : { path })),
    totalCount: paths.length,
    truncated,
  };
}

export async function listPlainWorkspaceFiles(options: {
  cwd: string;
  query?: string;
  cursor?: string;
  limit?: number;
}): Promise<WorkspaceFilePage> {
  return pageWorkspaceFiles(await collectPlainWorkspaceFiles(options), options.cursor, options.limit);
}

export async function readPlainWorkspaceFile(cwd: string, path: string): Promise<WorkspaceFileContent> {
  const root = await realpath(cwd);
  const safe = safeRelativePath(path);
  try {
    const file = await confinedFile(root, safe);
    const info = await stat(file);
    if (info.size > 1024 * 1024) return { revision: "non-git", path: safe, state: "oversized" };
    const content = await readFile(file);
    if (binary(content)) return { revision: "non-git", path: safe, state: "binary" };
    return { revision: "non-git", path: safe, state: "available", text: content.toString("utf8") };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { revision: "non-git", path: safe, state: "deleted" };
    throw error;
  }
}
