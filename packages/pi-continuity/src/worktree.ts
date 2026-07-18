import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";
import type { Evidence, Fact, FactStatus } from "./memory.ts";

const exec = promisify(execFile);

async function git(cwd: string, args: string[], env?: Record<string, string>) {
  const result = await exec("git", args, {
    cwd, env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 64 * 1024 * 1024, timeout: 120_000, windowsHide: true,
  });
  return String(result.stdout).replace(/\r?\n$/, "");
}
const exitCode = (error: any) => typeof error?.code === "number" ? error.code : undefined;
const within = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

export type ProjectContext = { owner: string; captureCommit?: string; branchAtCapture?: string };
export type FactClassification = { fact: Fact; status: FactStatus; reason: string };

/** Git common-dir identifies Git projects; canonical workspace identity is the non-Git fallback. */
export async function projectContext(cwd: string, fallbackOwner: string): Promise<ProjectContext> {
  try {
    const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const canonicalCommonDir = await realpath(commonDir).catch(() => resolve(cwd, commonDir));
    const captureCommit = await git(cwd, ["rev-parse", "HEAD"]).catch(() => undefined);
    const branchAtCapture = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => undefined);
    return { owner: createHash("sha256").update(canonicalCommonDir).digest("hex"), ...(captureCommit ? { captureCommit } : {}), ...(branchAtCapture ? { branchAtCapture } : {}) };
  } catch { return { owner: fallbackOwner }; }
}

async function projectRoot(cwd: string) {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => cwd);
  return realpath(root);
}
const sensitivePart = (part: string) => {
  const lower = part.toLowerCase();
  return lower === ".git" || lower === ".env" || lower.startsWith(".env.") ||
    lower === ".npmrc" || lower === ".pypirc" || lower === "credentials" ||
    lower === "id_rsa" || /\.(?:pem|key|p12|pfx)$/.test(lower);
};

/** Resolves and hashes bounded, regular, non-sensitive project files for project facts. */
export async function captureEvidence(cwd: string, paths: string[]): Promise<Evidence[]> {
  if (!Array.isArray(paths) || paths.length > 5) throw Error("at most 5 evidence paths are allowed");
  const root = await projectRoot(cwd), evidence: Evidence[] = [];
  let total = 0;
  for (const raw of paths) {
    if (typeof raw !== "string" || !raw || raw.length > 240 || raw.includes("\0") ||
      isAbsolute(raw) || win32.isAbsolute(raw) || raw.split(/[\\/]+/).some((part) => !part || part === "." || part === ".." || sensitivePart(part)))
      throw Error("invalid or sensitive evidence path");
    const parts = raw.split(/[\\/]+/), normalized = parts.join("/");
    let cursor = root;
    for (const part of parts) {
      cursor = join(cursor, part);
      const info = await lstat(cursor).catch(() => undefined);
      if (!info) throw Error("evidence file is missing");
      if (info.isSymbolicLink()) throw Error("evidence paths may not use symlinks");
    }
    const target = resolve(root, ...parts), canonicalTarget = await realpath(target);
    if (!within(root, target) || !within(root, canonicalTarget)) throw Error("evidence path escapes project root");
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw Error("evidence path must be a regular file");
      if (before.size > 256 * 1024) throw Error("evidence file exceeds 256 KiB");
      total += before.size;
      if (total > 1024 * 1024) throw Error("evidence exceeds 1 MiB total");
      const bytes = await handle.readFile(), after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
        throw Error("evidence file changed while reading");
      let canonical = bytes;
      if (!bytes.includes(0)) {
        try { canonical = Buffer.from(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n/g, "\n")); }
        catch { /* Binary/non-UTF-8 evidence is hashed byte-for-byte. */ }
      }
      evidence.push({ path: normalized, sha256: createHash("sha256").update(canonical).digest("hex") });
    } finally { await handle.close(); }
  }
  return evidence;
}

async function evidenceChanged(cwd: string, evidence: Evidence[]) {
  try {
    const current = await captureEvidence(cwd, evidence.map((item) => item.path));
    return current.some((item, index) => item.sha256 !== evidence[index]?.sha256);
  } catch { return true; }
}

/** Classifies current-owner project facts without mutating their persisted provenance. */
export async function classifyProjectFacts(cwd: string, facts: Fact[]): Promise<FactClassification[]> {
  let head: string | undefined;
  try { head = await git(cwd, ["rev-parse", "HEAD"]); } catch { head = undefined; }
  const output: FactClassification[] = [];
  for (const fact of facts) {
    const hasCommit = Boolean(fact.captureCommit), hasEvidence = Boolean(fact.evidencePaths?.length);
    if (hasCommit && !head) {
      output.push({ fact, status: "unverifiable", reason: "Git HEAD unavailable" });
      continue;
    }
    if (hasCommit) {
      try { await git(cwd, ["merge-base", "--is-ancestor", fact.captureCommit!, head!]); }
      catch (error: any) {
        output.push({ fact, status: exitCode(error) === 1 ? "suspect" : "unverifiable", reason: exitCode(error) === 1 ? "capture is not an ancestor of HEAD" : "Git ancestry unavailable" });
        continue;
      }
    }
    if (hasEvidence && await evidenceChanged(cwd, fact.evidencePaths!)) {
      output.push({ fact, status: "suspect", reason: "captured evidence changed or is unavailable" });
      continue;
    }
    output.push({
      fact,
      status: hasEvidence ? "active" : "unchecked",
      reason: hasEvidence ? "captured evidence matches" : hasCommit ? "ancestry matches; no content evidence" : "no project provenance",
    });
  }
  return output;
}

export async function worktreeFingerprint(cwd: string): Promise<string | undefined> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]), head = await git(root, ["rev-parse", "HEAD"]), status = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    if (!status) return `${root}\n${head}\nclean`;
    const indexTree = await git(root, ["write-tree"]), dir = await mkdtemp(join(tmpdir(), "pi-continuity-")), index = join(dir, "index"), env = { GIT_INDEX_FILE: index };
    try {
      await git(root, ["read-tree", "HEAD"], env); await git(root, ["add", "-A", "--", "."], env);
      return `${root}\n${head}\n${indexTree}\n${await git(root, ["write-tree"], env)}`;
    } finally { await rm(dir, { recursive: true, force: true }); }
  } catch { return undefined; }
}
