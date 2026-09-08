import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readdir, realpath, open, mkdir, rename, unlink, rmdir, link } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { MAX_EDIT_BYTES, pathWithin, validWorkspaceMutation, validWorkspacePath,
  type WorkspaceEntry, type WorkspaceMutation } from "../../shared/workspace-mutations.ts";

const run = promisify(execFile);
const MAX_ENTRIES = 2000;
const MAX_BYTES = 64 * 1024 * 1024;
type Item = { path: string; kind: "file" | "directory"; version: string; mode: number; links: number; dev: number; ino: number; uid: number; ctimeMs: number; bytes?: Buffer };
type Context = { root: string; submodules: string[] };

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}

async function windowsFileOperation(script: string, source: string, destination: string): Promise<void> {
  await run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${script}`], {
    env: { ...process.env, PYLON_FILE_SOURCE: source, PYLON_FILE_DESTINATION: destination },
    windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024,
  });
}

async function context(cwd: string): Promise<Context> {
  const root = await realpath(cwd);
  let submodules: string[] = [];
  if (await exists(join(root, ".gitmodules"))) {
    // Git parses quoted paths correctly. A malformed config fails closed.
    const result = await run("git", ["config", "--file", join(root, ".gitmodules"), "--get-regexp", "^submodule\\..*\\.path$"],
      { timeout: 5000, maxBuffer: 1024 * 1024 }).catch(error => {
        if (error.code === 1 && !error.stdout) return { stdout: "" };
        throw error;
      });
    submodules = result.stdout.trim().split("\n").filter(Boolean).map(line => line.slice(line.indexOf(" ") + 1).trim());
  }
  return { root, submodules };
}

async function confined(ctx: Context, path: string, missingLeaf = false): Promise<string> {
  if (!validWorkspacePath(path)) throw new Error("Invalid or protected workspace path.");
  if (ctx.submodules.some(submodule => pathWithin(path.toLowerCase(), submodule.toLowerCase())))
    throw new Error("Managed submodules cannot be modified here.");
  const parts = path.split("/");
  let current = ctx.root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let stat;
    try { stat = await lstat(current); }
    catch (error: any) {
      if (missingLeaf && index === parts.length - 1 && error.code === "ENOENT") return current;
      throw error;
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw new Error("Symlinks and special files cannot be modified here.");
    if (stat.isDirectory() && await exists(join(current, ".git")))
      throw new Error("Nested repositories cannot be modified here.");
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Parent is not a folder.");
    if (resolve(await realpath(current)) !== resolve(current)) throw new Error("Workspace path changed or escapes its folder.");
  }
  return current;
}

async function inspect(ctx: Context, path: string): Promise<{ version: string; items: Item[] }> {
  const items: Item[] = [];
  let bytes = 0;
  const deadline = Date.now() + 10_000;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (items.length >= MAX_ENTRIES || depth > 64 || Date.now() > deadline)
      throw new Error("Operation exceeds the safe folder inspection limit (2,000 entries / 64 MiB). Use local filesystem tools.");
    const absolute = await confined(ctx, path);
    const stat = await lstat(absolute);
    const hash = createHash("sha256").update(JSON.stringify([ctx.root, path, stat.dev, stat.ino, stat.mode, stat.uid, stat.gid]));
    const item: Item = { path, kind: stat.isDirectory() ? "directory" : "file", version: "", mode: stat.mode, links: stat.nlink, dev: stat.dev, ino: stat.ino, uid: stat.uid, ctimeMs: stat.ctimeMs };
    items.push(item);
    if (item.kind === "directory") {
      if (ctx.submodules.some(submodule => pathWithin(submodule.toLowerCase(), path.toLowerCase())))
        throw new Error("Folder contains a managed submodule.");
      const names = (await readdir(absolute)).sort();
      hash.update(JSON.stringify(names));
      for (const name of names) await visit(`${path}/${name}`, depth + 1);
      if (JSON.stringify((await readdir(absolute)).sort()) !== JSON.stringify(names))
        throw new Error("Folder changed while inspecting it. Try again.");
    } else {
      bytes += stat.size;
      if (bytes > MAX_BYTES) throw new Error("Operation exceeds the safe inspection limit (64 MiB). Use local filesystem tools.");
      const handle = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev) throw new Error("File changed while opening it.");
        // Never let a growing file defeat the bounded read.
        const buffer = Buffer.alloc(Math.min(MAX_BYTES - bytes + stat.size, stat.size) + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        const after = await handle.stat();
        if (length !== stat.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
          throw new Error("File changed while reading it. Try again.");
        const content = buffer.subarray(0, length);
        hash.update(content);
        // Retain only editor-sized buffers; manifests retain hashes, not file contents.
        if (items.length === 1 && length <= MAX_EDIT_BYTES) item.bytes = content;
      } finally { await handle.close(); }
    }
    item.version = hash.digest("hex");
  };
  await visit(path, 0);
  return { items, version: createHash("sha256").update(items.map(item => `${item.version}:${item.ctimeMs}:${item.links}`).join("\0")).digest("hex") };
}

function editable(item: Item): { text: string; bom: boolean; eol: string } {
  if (item.kind !== "file" || !item.bytes) throw new Error("Only text files up to 1 MiB can be edited.");
  if (item.links !== 1) throw new Error("Hard-linked files are read-only here.");
  if (!(item.mode & 0o222)) throw new Error("Read-only files cannot be saved here.");
  if (process.platform !== "win32" && process.platform !== "linux") throw new Error("Metadata-preserving saves are supported on Windows and Linux only.");
  if (process.getuid && item.uid !== process.getuid()) throw new Error("Files owned by another user are read-only here.");
  const raw = item.bytes.toString("utf8");
  if (!Buffer.from(raw, "utf8").equals(item.bytes) || raw.includes("\0")) throw new Error("Only valid UTF-8 text can be edited.");
  const bom = raw.startsWith("\ufeff");
  const text = bom ? raw.slice(1) : raw;
  const crlf = text.includes("\r\n");
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.includes("\r") || (crlf && /(?<!\r)\n/.test(text)))
    throw new Error("Mixed or legacy line endings are read-only here.");
  return { text: normalized, bom, eol: crlf ? "\r\n" : "\n" };
}

export async function readWorkspaceEntry(cwd: string, path: string): Promise<Omit<WorkspaceEntry, "sessionId" | "sessionGeneration">> {
  const result = await inspect(await context(cwd), path);
  const entry = { path, version: result.version, kind: result.items[0].kind, entries: result.items.length };
  if (entry.kind === "directory") return entry;
  try { return { ...entry, text: editable(result.items[0]).text }; }
  catch (error) { return { ...entry, readOnlyReason: (error as Error).message }; }
}

/** Optimistic local-writer protection, not an OS sandbox or a cross-process CAS. */
export async function mutateWorkspace(cwd: string, mutation: WorkspaceMutation): Promise<void> {
  if (!validWorkspaceMutation(mutation)) throw new Error("Invalid workspace operation.");
  const ctx = await context(cwd);
  const source = await confined(ctx, mutation.path, mutation.action.startsWith("create"));
  if (mutation.action === "createDirectory") { await mkdir(source); return; }
  if (mutation.action === "createFile") {
    const file = await open(source, "wx");
    await file.close();
    return;
  }
  if (!("expectedVersion" in mutation)) throw new Error("Missing entry version.");
  const original = await inspect(ctx, mutation.path);
  if (original.version !== mutation.expectedVersion) throw new Error("File or folder changed on disk. Reopen it before trying again; your draft has not been saved.");
  const revalidate = async () => {
    if ((await inspect(ctx, mutation.path)).version !== original.version) throw new Error("File or folder changed during the operation.");
  };
  if (mutation.action === "save") {
    const format = editable(original.items[0]);
    if (mutation.text.includes("\r") || mutation.text.includes("\0") || Buffer.from(mutation.text).toString("utf8") !== mutation.text)
      throw new Error("Invalid text. Submit well-formed UTF-8 text with LF line endings.");
    const content = Buffer.from((format.bom ? "\ufeff" : "") + mutation.text.replaceAll("\n", format.eol));
    if (content.length > MAX_EDIT_BYTES) throw new Error("Edited file exceeds 1 MiB.");
    await access(source, constants.W_OK);
    const temporary = join(dirname(source), `.pylon-save-${randomUUID()}.tmp`);
    let failure: unknown;
    try {
      const reserved = await open(temporary, "wx", 0o600);
      await reserved.close();
      if (process.platform === "win32") {
        // Apply the source ACL before writing any text into the temporary file.
        await windowsFileOperation("Get-Acl -LiteralPath $env:PYLON_FILE_SOURCE | Set-Acl -LiteralPath $env:PYLON_FILE_DESTINATION", source, temporary);
      } else {
        // Explicit preservation attributes make GNU cp fail rather than silently dropping security metadata.
        await run("cp", ["--preserve=mode,ownership,xattr", "--", source, temporary], { timeout: 10_000, maxBuffer: 64 * 1024 });
      }
      const file = await open(temporary, "r+");
      try { await file.writeFile(content); await file.truncate(content.length); await file.sync(); }
      finally { await file.close(); }
      await revalidate();
      await confined(ctx, mutation.path);
      if (process.platform === "win32") {
        // ReplaceFileW retains target ACLs and streams; never fall back to a metadata-losing rename.
        await windowsFileOperation("[IO.File]::Replace($env:PYLON_FILE_SOURCE, $env:PYLON_FILE_DESTINATION, [NullString]::Value)", temporary, source);
      } else { await rename(temporary, source); }
    } catch (error) { failure = error; throw error; }
    finally {
      await unlink(temporary).catch((error: any) => {
        if (error.code !== "ENOENT") throw new Error(`${failure ? (failure as Error).message : "Save completed."} Temporary-file cleanup failed: ${error.message}`);
      });
    }
    return;
  }
  if (mutation.action === "move") {
    if (pathWithin(mutation.destination.toLowerCase(), mutation.path.toLowerCase()))
      throw new Error("Cannot move a folder into itself or perform a case-only rename.");
    const destination = await confined(ctx, mutation.destination, true);
    if (await exists(destination)) throw new Error("Destination already exists. Nothing was overwritten.");
    await revalidate();
    await confined(ctx, mutation.destination, true);
    if (await exists(destination)) throw new Error("Destination already exists. Nothing was overwritten.");
    if (original.items[0].kind === "file") {
      // link is exclusive on both Windows and POSIX; no copy/delete fallback.
      await link(source, destination);
      try {
        const linked = (await inspect(ctx, mutation.path)).items[0];
        // Linking intentionally changes ctime/nlink; still verify bytes, identity, mode and owner.
        if (linked.version !== original.items[0].version || linked.links !== original.items[0].links + 1) throw new Error("Source changed during move.");
        await unlink(source);
      }
      catch (error) { throw new Error(`Move stopped; both paths may exist. Inspect them before retrying. ${(error as Error).message}`); }
    } else {
      if ((await lstat(dirname(destination))).dev !== original.items[0].dev) throw new Error("Cross-device folder moves are not supported.");
      if (process.platform === "win32") {
        // Directory.Move refuses an existing destination, unlike POSIX rename.
        await windowsFileOperation("[IO.Directory]::Move($env:PYLON_FILE_SOURCE, $env:PYLON_FILE_DESTINATION)", source, destination);
      } else if (process.platform === "linux") {
        await run("mv", ["--no-clobber", "--no-target-directory", "--", source, destination], { timeout: 10_000, maxBuffer: 64 * 1024 });
        if (await exists(source)) throw new Error("Destination exists or folder move was not completed. Inspect both paths before retrying.");
      } else { throw new Error("No-overwrite folder moves are supported on Windows and Linux only."); }
    }
    return;
  }
  if (mutation.action === "delete") {
    await revalidate();
    try {
      // Never recursive rm: newly introduced entries must survive and make rmdir fail.
      for (const item of [...original.items].reverse()) {
        const absolute = await confined(ctx, item.path);
        if (item.kind === "file") {
          const current = await inspect(ctx, item.path);
          if (current.items[0].version !== item.version) throw new Error("An entry changed during deletion.");
          await unlink(absolute);
        } else {
          const current = await lstat(absolute);
          if (current.dev !== item.dev || current.ino !== item.ino || current.mode !== item.mode) throw new Error("Folder changed during deletion.");
          await rmdir(absolute);
        }
      }
    } catch (error) { throw new Error(`Deletion stopped; some entries may already be deleted. Refresh before retrying. ${(error as Error).message}`); }
  }
}
