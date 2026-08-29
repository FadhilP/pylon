import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";
import type { EvidenceRange } from "./memory.ts";

const exec = promisify(execFile);
async function git(cwd: string, args: string[], env?: Record<string, string>) {
  const result = await exec("git", args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  return String(result.stdout).replace(/\r?\n$/, "");
}
const within = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};
export type ProjectContext = { owner: string; captureCommit?: string; branchAtCapture?: string };
export type CapturedEvidenceRange = EvidenceRange & { excerpt: string; excerptSha256: string; captureCommit?: string };
export type CapturedEvidenceFile = { path: string; sha256: string };

export async function projectContext(cwd: string, fallbackOwner: string): Promise<ProjectContext> {
  try {
    const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const canonicalCommonDir = await realpath(commonDir).catch(() => resolve(cwd, commonDir));
    const captureCommit = await git(cwd, ["rev-parse", "HEAD"]).catch(() => undefined);
    const branchAtCapture = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => undefined);
    return {
      owner: createHash("sha256").update(canonicalCommonDir).digest("hex"),
      ...(captureCommit ? { captureCommit } : {}),
      ...(branchAtCapture ? { branchAtCapture } : {}),
    };
  } catch {
    return { owner: fallbackOwner };
  }
}
async function projectRoot(cwd: string) {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => cwd);
  return realpath(root);
}
const sensitivePart = (part: string) => {
  const lower = part.toLowerCase();
  return (
    lower === ".git" ||
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower === ".npmrc" ||
    lower === ".pypirc" ||
    /^(?:credentials|secrets?|auth|tokens?)(?:\..+)?$/.test(lower) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)$/.test(lower) ||
    /\.(?:pem|key|p12|pfx|keystore|jks)$/.test(lower)
  );
};
async function readSafeFile(cwd: string, raw: string) {
  if (
    typeof raw !== "string" ||
    !raw ||
    raw.length > 240 ||
    raw.includes("\0") ||
    isAbsolute(raw) ||
    win32.isAbsolute(raw)
  )
    throw Error("invalid or sensitive evidence path");
  const parts = raw.split(/[\\/]+/);
  if (parts.some(part => !part || part === "." || part === ".." || sensitivePart(part)))
    throw Error("invalid or sensitive evidence path");
  const root = await projectRoot(cwd),
    normalized = parts.join("/");
  let cursor = root;
  const components: Array<{ path: string; dev: number; ino: number }> = [];
  for (const part of parts) {
    cursor = join(cursor, part);
    const info = await lstat(cursor).catch(() => undefined);
    if (!info) throw Error("evidence file is missing");
    if (info.isSymbolicLink()) throw Error("evidence paths may not use symlinks");
    components.push({ path: cursor, dev: info.dev, ino: info.ino });
  }
  const target = resolve(root, ...parts),
    canonicalTarget = await realpath(target);
  if (!within(root, target) || !within(root, canonicalTarget)) throw Error("evidence path escapes project root");
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw Error("evidence path must be a regular file");
    if (before.size > 256 * 1024) throw Error("evidence file exceeds 256 KiB");
    const bytes = await handle.readFile(),
      after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
      throw Error("evidence file changed while reading");
    for (const component of components) {
      const current = await lstat(component.path).catch(() => undefined);
      if (!current || current.isSymbolicLink() || current.dev !== component.dev || current.ino !== component.ino)
        throw Error("evidence path changed while reading");
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n");
    } catch {
      throw Error("evidence file must be UTF-8 text");
    }
    if (content.includes("\0")) throw Error("evidence file must be text");
    return { normalized, content };
  } finally {
    await handle.close();
  }
}

export async function captureEvidenceRanges(cwd: string, ranges: EvidenceRange[]): Promise<CapturedEvidenceRange[]> {
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 3)
    throw Error("one to three evidence ranges are required");
  let totalLines = 0,
    totalCharacters = 0;
  const context = await projectContext(cwd, "unknown"),
    output: CapturedEvidenceRange[] = [];
  for (const range of ranges) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 1 ||
      range.end < range.start
    )
      throw Error("invalid evidence line range");
    totalLines += range.end - range.start + 1;
    if (totalLines > 120) throw Error("evidence exceeds 120 lines per proposal");
    const file = await readSafeFile(cwd, range.path),
      lines = file.content.split("\n");
    if (range.end > lines.length) throw Error("evidence line range exceeds file length");
    const excerpt = lines.slice(range.start - 1, range.end).join("\n");
    totalCharacters += excerpt.length;
    if (totalCharacters > 12_000) throw Error("evidence excerpts exceed the reviewer input budget");
    output.push({
      path: file.normalized,
      start: range.start,
      end: range.end,
      excerpt,
      excerptSha256: createHash("sha256").update(excerpt).digest("hex"),
      ...(context.captureCommit ? { captureCommit: context.captureCommit } : {}),
    });
  }
  return output;
}
export async function captureEvidence(cwd: string, paths: string[]): Promise<CapturedEvidenceFile[]> {
  if (!Array.isArray(paths) || paths.length > 5) throw Error("at most 5 evidence paths are allowed");
  const output: CapturedEvidenceFile[] = [];
  for (const path of paths) {
    const file = await readSafeFile(cwd, path);
    output.push({ path: file.normalized, sha256: createHash("sha256").update(file.content).digest("hex") });
  }
  return output;
}
export async function currentChangedPaths(cwd: string): Promise<Set<string> | undefined> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const result = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    });
    const records = String(result.stdout).split("\0").filter(Boolean),
      paths = new Set<string>();
    for (let index = 0; index < records.length; index++) {
      const record = records[index]!,
        status = record.slice(0, 2),
        path = record.slice(3);
      if (status.includes("R") || status.includes("C")) {
        paths.add(path.replace(/\\/g, "/"));
        index++;
      } else paths.add(path.replace(/\\/g, "/"));
    }
    return paths;
  } catch {
    return undefined;
  }
}
/** Canonical Verify-compatible identity: SHA-256(HEAD + newline + raw porcelain status), truncated to 16 hex chars. */
export async function worktreeFingerprint(cwd: string): Promise<string | undefined> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const [head, status] = await Promise.all([
      exec("git", ["rev-parse", "HEAD"], { cwd: root, maxBuffer: 1024 * 1024, timeout: 15_000, windowsHide: true }),
      exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
        cwd: root,
        maxBuffer: 64 * 1024 * 1024,
        timeout: 15_000,
        windowsHide: true,
      }),
    ]);
    return createHash("sha256")
      .update(`${String(head.stdout).trim()}\n${String(status.stdout)}`)
      .digest("hex")
      .slice(0, 16);
  } catch {
    return undefined;
  }
}
