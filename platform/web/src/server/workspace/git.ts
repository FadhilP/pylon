import { spawn } from "node:child_process";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { MAX_EDIT_BYTES, validWorkspacePath } from "../../shared/workspace/workspace-mutations.ts";
import {
  validGitActionInput,
  validGitDetailQuery,
  type GitActionInput,
  type GitBranch,
  type GitCommit,
  type GitConflictBlock,
  type GitDetail,
  type GitDetailFile,
  type GitDetailQuery,
  type GitFile,
  type GitOperation,
  type GitRemote,
  type GitStash,
  type GitState,
} from "../../shared/workspace/git.ts";
import { mutateWorkspace, readWorkspaceEntry } from "./workspace-mutations.ts";
import { gitReadBudget } from "./git-reads.ts";

const MAX_FILES = 2000;
const MAX_HISTORY = 100;
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_DETAIL = 2 * 1024 * 1024;
const MAX_METADATA_FILE = 1024 * 1024;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const hash = (value: unknown) =>
  createHash("sha256")
    .update(Buffer.isBuffer(value) || typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

type Repo = { root: string; gitDir: string };
type GitFailure = Error & { code?: number; stdout?: Buffer; stderr?: Buffer; timedOut?: boolean };

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_PAGER: "cat",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GCM_INTERACTIVE: "Never",
    LC_ALL: "C",
  };
}

/** A bounded runner which kills Git's process tree rather than only its immediate process. */
async function git(root: string, args: string[], input?: Buffer, maxBuffer = MAX_OUTPUT): Promise<Buffer> {
  const budget = gitReadBudget();
  const command = new Promise<Buffer>((resolveResult, rejectResult) => {
    const child = spawn("git", ["--no-pager", "-c", "core.quotePath=false", "-c", "diff.external=", ...args], {
      cwd: root,
      env: gitEnv(),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let output = 0;
    let done = false;
    let timedOut = false;
    let forcedError: GitFailure | undefined;
    const finish = (error?: GitFailure) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      budget?.signal.removeEventListener("abort", abort);
      if (error) rejectResult(error);
      else resolveResult(Buffer.concat(stdout));
    };
    const failTooLarge = () => {
      const error = new Error("Git output exceeded the safe inspection limit.") as GitFailure;
      error.stdout = Buffer.concat(stdout);
      error.stderr = Buffer.concat(stderr);
      forcedError = error;
      terminate();
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (done || forcedError) return;
      if (budget) {
        budget.remaining -= chunk.length;
        if (budget.remaining <= 0) return failTooLarge();
      }
      output += chunk.length;
      if (output > maxBuffer) return failTooLarge();
      target.push(chunk);
    };
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.on("error", () => {
          /* The original command will still report its outcome. */
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already exited */
          }
        }
      }
    };
    const abort = () => {
      forcedError = budget?.signal.reason ?? Error("Git inspection cancelled.");
      terminate();
    };
    budget?.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => {
        timedOut = true;
        terminate();
      },
      Math.min(15_000, budget ? Math.max(1, budget.deadline - Date.now()) : 15_000),
    );
    child.stdout!.on("data", collect(stdout));
    child.stderr!.on("data", collect(stderr));
    child.on("error", error => finish(error as GitFailure));
    child.on("close", code => {
      if (done) return;
      if (forcedError) return finish(forcedError);
      if (code === 0 && !timedOut) return finish();
      const error = new Error(
        timedOut
          ? "Git command timed out; its outcome is uncertain."
          : Buffer.concat(stderr).toString("utf8").trim() || `Git exited with status ${code}.`,
      ) as GitFailure;
      error.code = code ?? undefined;
      error.stdout = Buffer.concat(stdout);
      error.stderr = Buffer.concat(stderr);
      error.timedOut = timedOut;
      finish(error);
    });
    if (input) {
      child.stdin!.on("error", () => {
        /* close result carries command failure */
      });
      child.stdin!.end(input);
    }
    if (budget?.signal.aborted) abort();
  });
  budget?.jobs.add(command);
  try {
    return await command;
  } finally {
    budget?.jobs.delete(command);
  }
}
const gitText = async (root: string, args: string[], maxBuffer?: number) =>
  (await git(root, args, undefined, maxBuffer)).toString("utf8");
const nulFields = (raw: Buffer) => raw.toString("utf8").split("\0");

async function repository(cwd: string): Promise<Repo | undefined> {
  let root: string;
  try {
    root = await realpath(cwd);
  } catch {
    return undefined;
  }
  try {
    // Discover the repository in one process instead of four separate probes.
    const lines = (
      await gitText(root, [
        "rev-parse",
        "--is-inside-work-tree",
        "--is-bare-repository",
        "--show-toplevel",
        "--absolute-git-dir",
      ])
    ).split("\n");
    if (lines.length !== 5 || lines[4] !== "" || lines.slice(0, 4).some(line => !line || line.includes("\r")))
      throw Error("Git repository discovery returned unsafe output.");
    const [inside, bare, reportedRoot, reportedGitDir] = lines;
    if (inside !== "true") return undefined;
    if (bare === "true") throw Error("Bare repositories are not supported.");
    const reported = await realpath(reportedRoot);
    if (resolve(reported) !== resolve(root))
      throw Error("Git operations require the repository root, not a subfolder.");
    return { root, gitDir: await realpath(reportedGitDir) };
  } catch (error: any) {
    if (/not a git repository/i.test(String(error?.stderr ?? error?.message))) return undefined;
    throw error;
  }
}

async function lstatOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read a regular file without following a link and reject races, links, and oversize content. */
async function readRegular(path: string, maximum = MAX_METADATA_FILE, missing = false): Promise<Buffer | undefined> {
  gitReadBudget();
  // Windows does not expose O_NOFOLLOW in Node. The handle identity check below detects a
  // substitution; platforms with the flag also receive the kernel no-follow guarantee.
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const stat = await lstatOrMissing(path);
  if (!stat) {
    if (missing) return undefined;
    throw Error("Required repository metadata is missing.");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum)
    throw Error("Repository metadata is unsafe or exceeds the inspection limit.");
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size)
      throw Error("Repository metadata changed while opening.");
    const content = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < content.length) {
      const result = await handle.read(content, used, content.length - used, used);
      if (!result.bytesRead) break;
      used += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      used !== stat.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw Error("Repository metadata changed while reading.");
    return content.subarray(0, used);
  } finally {
    await handle.close();
  }
}

async function safePath(repo: Repo, path: string, allowMissingLeaf = false): Promise<string | undefined> {
  if (!validWorkspacePath(path)) throw Error("Invalid or protected Git path.");
  let current = repo.root;
  const parts = path.split("/");
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const stat = await lstatOrMissing(current);
    if (!stat) {
      if (allowMissingLeaf) return undefined;
      throw Error("Git path is missing.");
    }
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
      throw Error("Symlinks and special files cannot be changed by Git actions.");
    if (stat.isFile() && (stat.nlink !== 1 || index !== parts.length - 1))
      throw Error("Hard-linked files and non-directory parents cannot be changed by Git actions.");
    if (stat.isDirectory()) {
      const nested = await lstatOrMissing(join(current, ".git"));
      if (nested) throw Error("Nested repositories cannot be changed by Git actions.");
    }
  }
  return current;
}

function parseStatus(raw: Buffer): { files: GitFile[]; truncated: boolean } {
  const fields = nulFields(raw);
  const files: GitFile[] = [];
  let unsafe = false;
  for (let index = 0; index < fields.length - 1; index++) {
    const entry = fields[index];
    if (!entry) continue;
    const indexStatus = entry.slice(0, 1);
    const worktreeStatus = entry.slice(1, 2);
    const path = entry.slice(3);
    let oldPath: string | undefined;
    if ((indexStatus === "R" || indexStatus === "C") && index + 1 < fields.length) oldPath = fields[++index];
    if (!validWorkspacePath(path) || (oldPath !== undefined && !validWorkspacePath(oldPath))) {
      unsafe = true;
      continue;
    }
    files.push({ path, ...(oldPath ? { oldPath } : {}), indexStatus, worktreeStatus });
  }
  return { files: files.slice(0, MAX_FILES), truncated: unsafe || files.length > MAX_FILES };
}

/** --numstat -z is header NUL path NUL (and header NUL old NUL new for renames), not a tab row. */
function addNumstat(raw: Buffer, files: GitFile[]): void {
  const byPath = new Map<string, GitFile>();
  for (const file of files) {
    byPath.set(file.path, file);
    if (file.oldPath) byPath.set(file.oldPath, file);
  }
  const fields = nulFields(raw);
  for (let index = 0; index < fields.length - 1; index++) {
    const header = fields[index];
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(header);
    if (!match) continue;
    let names: string[];
    if (match[3] === "") names = [fields[++index] ?? "", fields[++index] ?? ""];
    else names = [match[3]];
    const file = names.map(name => byPath.get(name)).find(Boolean);
    if (!file) continue;
    if (match[1] === "-" || match[2] === "-") file.binary = true;
    else {
      file.additions = (file.additions ?? 0) + Number(match[1]);
      file.deletions = (file.deletions ?? 0) + Number(match[2]);
    }
  }
}

function parseRecords(raw: Buffer, fieldsPerRecord: number): string[][] {
  const result: string[][] = [];
  for (const rawRecord of raw.toString("utf8").split("\x1e")) {
    // Git appends its pretty-format record newline after our delimiter.
    const record = rawRecord.replace(/^\r?\n/, "");
    if (!record) continue;
    const fields = record.split("\0");
    if (fields.length >= fieldsPerRecord) result.push(fields.slice(0, fieldsPerRecord));
  }
  return result;
}
function parseNulRows(raw: Buffer, fieldsPerRow: number): string[][] {
  const fields = nulFields(raw);
  const rows: string[][] = [];
  for (let index = 0; index + fieldsPerRow - 1 < fields.length; index += fieldsPerRow) {
    const row = fields.slice(index, index + fieldsPerRow);
    row[0] = row[0].replace(/^\r?\n/, "");
    if (row[0]) rows.push(row);
  }
  return rows;
}
function parseLog(raw: Buffer): GitCommit[] {
  return parseRecords(raw, 5).flatMap(fields =>
    OID.test(fields[0])
      ? [
          {
            oid: fields[0],
            parents: fields[1].split(" ").filter(Boolean),
            subject: fields[2],
            author: fields[3],
            authoredAt: fields[4],
          },
        ]
      : [],
  );
}
function parseStashes(raw: Buffer): GitStash[] {
  return parseRecords(raw, 3).flatMap(fields =>
    OID.test(fields[0]) && /^stash@\{\d+\}$/.test(fields[1])
      ? [{ oid: fields[0], selector: fields[1], subject: fields[2] }]
      : [],
  );
}

async function metadata(repo: Repo, names: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of names) {
    let parent = repo.gitDir;
    for (const part of name.split("/").slice(0, -1)) {
      parent = join(parent, part);
      const entry = await lstatOrMissing(parent);
      if (entry && (!entry.isDirectory() || entry.isSymbolicLink()))
        throw Error("Git operation metadata contains an unsupported directory or link.");
    }
    const value = await readRegular(join(repo.gitDir, name), MAX_METADATA_FILE, true);
    result[name] = value ? hash(value) : "missing";
  }
  return result;
}

async function operation(
  repo: Repo,
  status?: Buffer,
): Promise<{ value?: GitOperation; identity: Record<string, string> }> {
  // Rebase directories take precedence over stale cherry-pick marker files.
  const names = [
    "MERGE_HEAD",
    "ORIG_HEAD",
    "MERGE_MSG",
    "MERGE_MODE",
    "MERGE_AUTOSTASH",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "sequencer/todo",
    "sequencer/head",
    "sequencer/abort-safety",
    "sequencer/opts",
    "rebase-merge/git-rebase-todo",
    "rebase-merge/done",
    "rebase-merge/head-name",
    "rebase-merge/orig-head",
    "rebase-merge/autostash",
    "rebase-apply/head-name",
    "rebase-apply/orig-head",
    "rebase-apply/autostash",
    "rebase-merge/msgnum",
    "rebase-merge/end",
    "rebase-merge/stopped-sha",
    "rebase-merge/onto",
    "rebase-apply/next",
    "rebase-apply/last",
    "rebase-apply/original-commit",
    "rebase-apply/onto",
  ];
  const identity = await metadata(repo, names);
  const text = async (name: string) =>
    (await readRegular(join(repo.gitDir, name), MAX_METADATA_FILE, true))?.toString("utf8").trim();
  const rebaseMerge = await lstatOrMissing(join(repo.gitDir, "rebase-merge"));
  const rebaseApply = await lstatOrMissing(join(repo.gitDir, "rebase-apply"));
  if (rebaseMerge?.isDirectory() || rebaseApply?.isDirectory()) {
    const folder = rebaseMerge?.isDirectory() ? "rebase-merge" : "rebase-apply";
    const step = Number(await text(`${folder}/${folder === "rebase-merge" ? "msgnum" : "next"}`));
    const total = Number(await text(`${folder}/${folder === "rebase-merge" ? "end" : "last"}`));
    return {
      value: {
        kind: "rebase",
        ...(Number.isFinite(step) ? { step } : {}),
        ...(Number.isFinite(total) ? { total } : {}),
        currentCommit: await text(`${folder}/${folder === "rebase-merge" ? "stopped-sha" : "original-commit"}`),
        onto: await text(`${folder}/onto`),
      },
      identity,
    };
  }
  const merge = await text("MERGE_HEAD");
  if (merge) return { value: { kind: "merge", currentCommit: merge }, identity };
  const cherry = await text("CHERRY_PICK_HEAD");
  if (cherry) return { value: { kind: "cherry-pick", currentCommit: cherry }, identity };
  const revert = await text("REVERT_HEAD");
  if (revert) return { value: { kind: "revert", currentCommit: revert }, identity };
  const sequencer = await lstatOrMissing(join(repo.gitDir, "sequencer"));
  if (sequencer?.isDirectory()) {
    const todo = await text("sequencer/todo");
    return { value: { kind: todo?.startsWith("revert ") ? "revert" : "cherry-pick" }, identity };
  }
  if (
    status &&
    parseStatus(status).files.some(
      file =>
        file.indexStatus === "U" ||
        file.worktreeStatus === "U" ||
        ["AA", "DD"].includes(file.indexStatus + file.worktreeStatus),
    )
  )
    return { value: { kind: "conflict" }, identity };
  return { identity };
}

/** Operation inspection remains available when content snapshots/Timeline are unsupported. */
export async function readGitOperation(cwd: string): Promise<GitOperation | undefined> {
  const repo = await repository(cwd);
  if (!repo) return undefined;
  return (await operation(repo, await git(repo.root, ["status", "--porcelain=v1", "-z", "--untracked-files=no"])))
    .value;
}

async function headIdentity(repo: Repo): Promise<{ symbolic?: string; oid?: string; headFile: string }> {
  const headFile = await readRegular(join(repo.gitDir, "HEAD"), MAX_METADATA_FILE);
  const missingRef = (error: { code?: number }): string => {
    if (error.code === 1) return "";
    throw error;
  };
  const symbolic = (await gitText(repo.root, ["symbolic-ref", "-q", "HEAD"]).catch(missingRef)).trim();
  const oid = (await gitText(repo.root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]).catch(missingRef)).trim();
  return { ...(symbolic ? { symbolic } : {}), ...(OID.test(oid) ? { oid } : {}), headFile: hash(headFile) };
}

async function observedRefs(repo: Repo, head?: { symbolic?: string }): Promise<Buffer> {
  // Checkpoint/private refs are deliberately excluded: they must not revoke panel approvals.
  const scopes = ["refs/heads", "refs/remotes", "refs/tags", "refs/stash", "refs/replace"];
  if (
    head?.symbolic?.startsWith("refs/") &&
    !scopes.some(scope => head.symbolic!.startsWith(`${scope}/`) || head.symbolic === scope)
  )
    scopes.push(head.symbolic);
  return git(repo.root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(symref)%00%(objecttype)%00",
    ...scopes,
  ]);
}

async function observedHead(repo: Repo): Promise<{ head: FreshRevision["head"]; refs: Buffer }> {
  const file = await readRegular(join(repo.gitDir, "HEAD"), MAX_METADATA_FILE);
  const value = file!.toString("utf8").trim();
  const symbolic = /^ref: (refs\/[^\s]+)$/.exec(value)?.[1];
  const refs = await observedRefs(repo, { symbolic });
  const rows = parseNulRows(refs, 4);
  const row = symbolic && rows.find(fields => fields[0] === symbolic);
  // for-each-ref already resolves symbolic references and returns the commit identity.
  // Unborn/unusual HEADs retain native verification instead of guessing.
  const head =
    row && row[3] === "commit" && OID.test(row[1])
      ? { symbolic: row[2] || symbolic!, oid: row[1], headFile: hash(file) }
      : OID.test(value) && rows.some(fields => fields[1] === value && fields[3] === "commit")
        ? { oid: value, headFile: hash(file) }
        : await headIdentity(repo);
  return { head, refs };
}

type FreshRevision = {
  revision: string;
  truncated: boolean;
  status: Buffer;
  op?: GitOperation;
  head: { symbolic?: string; oid?: string; headFile: string };
  refs: Buffer;
  config: Buffer;
  stash: Buffer;
};
/** Full-content, double-observed mutation precondition. It intentionally does no display work. */
async function safeRevision(repo: Repo, observedStatus?: Buffer): Promise<FreshRevision> {
  const status = observedStatus ?? (await git(repo.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const parsed = parseStatus(status);
  if (parsed.truncated)
    return {
      revision: hash([repo.root, "unsafe-status"]),
      truncated: true,
      status,
      head: { headFile: "" },
      refs: Buffer.alloc(0),
      config: Buffer.alloc(0),
      stash: Buffer.alloc(0),
    };
  const index = (await readRegular(join(repo.gitDir, "index"), MAX_OUTPUT, true)) ?? Buffer.alloc(0);
  if ((await gitText(repo.root, ["rev-parse", "--shared-index-path"])).trim())
    return {
      revision: hash([repo.root, "split-index"]),
      truncated: true,
      status,
      head: { headFile: "" },
      refs: Buffer.alloc(0),
      config: Buffer.alloc(0),
      stash: Buffer.alloc(0),
    };
  const { head: beforeHead, refs } = await observedHead(repo);
  const beforeOperation = await operation(repo, status);
  let total = 0;
  const files: string[] = [];
  for (const file of parsed.files)
    for (const path of [file.path, file.oldPath].filter((value): value is string => Boolean(value))) {
      const absolute = await safePath(repo, path, true);
      if (!absolute) {
        files.push(`${path}:missing`);
        continue;
      }
      const body = await readRegular(absolute, MAX_DETAIL);
      total += body!.length;
      if (total > MAX_OUTPUT)
        return {
          revision: hash([repo.root, "oversized-worktree"]),
          truncated: true,
          status,
          head: beforeHead,
          refs: Buffer.alloc(0),
          config: Buffer.alloc(0),
          stash: Buffer.alloc(0),
        };
      files.push(`${path}:${hash(body!)}`);
    }
  const config = await git(repo.root, ["config", "--null", "--list"], undefined, MAX_METADATA_FILE);
  const stash = await git(repo.root, ["stash", "list", "--format=%H%x00%gd%x00%s%x00%x1e"]);
  const afterStatus = await git(repo.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const afterIndex = (await readRegular(join(repo.gitDir, "index"), MAX_OUTPUT, true)) ?? Buffer.alloc(0);
  const { head: afterHead, refs: afterRefs } = await observedHead(repo);
  const afterOperation = await operation(repo, afterStatus);
  const afterConfig = await git(repo.root, ["config", "--null", "--list"], undefined, MAX_METADATA_FILE);
  const afterStash = await git(repo.root, ["stash", "list", "--format=%H%x00%gd%x00%s%x00%x1e"]);
  if (
    !status.equals(afterStatus) ||
    !index.equals(afterIndex) ||
    JSON.stringify(beforeHead) !== JSON.stringify(afterHead) ||
    JSON.stringify(beforeOperation.identity) !== JSON.stringify(afterOperation.identity) ||
    !config.equals(afterConfig) ||
    !refs.equals(afterRefs) ||
    !stash.equals(afterStash)
  )
    throw Error("Repository changed while being inspected. Refresh and try again.");
  let observed = 0;
  for (const file of parsed.files)
    for (const path of [file.path, file.oldPath].filter((value): value is string => Boolean(value))) {
      const absolute = await safePath(repo, path, true);
      const fingerprint = absolute ? `${path}:${hash(await readRegular(absolute, MAX_DETAIL))}` : `${path}:missing`;
      if (files[observed++] !== fingerprint) throw Error("Working files changed while being inspected.");
    }
  const rootStat = await lstat(repo.root);
  return {
    revision: hash([
      repo.root,
      rootStat.dev,
      rootStat.ino,
      repo.gitDir,
      status,
      index,
      beforeHead,
      beforeOperation.identity,
      refs,
      config,
      stash,
      files,
    ]),
    truncated: false,
    status,
    op: beforeOperation.value,
    head: beforeHead,
    refs,
    config,
    stash,
  };
}

export async function readGitState(cwd: string): Promise<GitState> {
  const nonGit = async (reason: string): Promise<GitState> => {
    const root = await realpath(cwd).catch(() => cwd);
    const stat = await lstatOrMissing(root).catch(() => undefined);
    return {
      available: false,
      reason,
      revision: hash(["non-git", resolve(root), stat?.dev, stat?.ino, stat?.mtimeMs, stat?.ctimeMs]),
      remotes: [],
      branches: [],
      files: [],
      history: [],
      stashes: [],
    };
  };
  let repo: Repo | undefined;
  try {
    repo = await repository(cwd);
  } catch (error) {
    return nonGit((error as Error).message);
  }
  if (!repo) return nonGit("This folder is not a Git working repository.");
  let unavailableReason: string | undefined;
  try {
    const [revision, branchRaw, historyRaw] = await Promise.all([
      safeRevision(repo).catch(async (error): Promise<FreshRevision> => {
        unavailableReason = (error as Error).message;
        const status = await git(repo!.root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        return {
          revision: hash([repo!.root, "read-only"]),
          truncated: true,
          status,
          op: (await operation(repo!, status)).value,
          head: { headFile: "" },
          refs: Buffer.alloc(0),
          config: Buffer.alloc(0),
          stash: Buffer.alloc(0),
        };
      }),
      git(repo.root, ["status", "--porcelain=v2", "--branch"]),
      git(repo.root, ["log", "-n", String(MAX_HISTORY), "--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%x1e"]).catch(() =>
        Buffer.alloc(0),
      ),
    ]);
    const refsRaw = revision.refs,
      stashRaw = revision.stash;
    const status = parseStatus(revision.status);
    addNumstat(
      await git(repo.root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z"]).catch(() => Buffer.alloc(0)),
      status.files,
    );
    addNumstat(
      await git(repo.root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--numstat", "-z"]).catch(() =>
        Buffer.alloc(0),
      ),
      status.files,
    );
    const headers = new Map(
      branchRaw
        .toString("utf8")
        .split("\n")
        .filter(line => line.startsWith("# "))
        .map(line => {
          const at = line.indexOf(" ", 2);
          return [line.slice(2, at), line.slice(at + 1)];
        }),
    );
    const branches: GitBranch[] = [];
    for (const fields of parseNulRows(refsRaw, 4))
      if (OID.test(fields[1]) && (fields[0].startsWith("refs/heads/") || fields[0].startsWith("refs/remotes/")))
        branches.push({
          name: fields[0],
          oid: fields[1],
          ...(fields[0] === revision.head.symbolic ? { current: true } : {}),
          ...(fields[0].startsWith("refs/remotes/") ? { remote: true } : {}),
        });
    const remotes = configuredRemotes(revision.config);
    const ab = /# branch\.ab \+(-?\d+) -(-?\d+)/.exec(branchRaw.toString("utf8"));
    return {
      available: true,
      reason: unavailableReason,
      truncated: revision.truncated || undefined,
      revision: revision.revision,
      branch: headers.get("branch.head") === "(detached)" ? undefined : headers.get("branch.head"),
      head: headers.get("branch.oid") && OID.test(headers.get("branch.oid")!) ? headers.get("branch.oid") : undefined,
      upstream: headers.get("branch.upstream"),
      ...(ab ? { ahead: Number(ab[1]), behind: Number(ab[2]) } : {}),
      remotes,
      branches,
      files: status.files,
      operation: revision.op,
      history: parseLog(historyRaw),
      stashes: parseStashes(stashRaw),
    };
  } catch (error) {
    return {
      available: false,
      reason: `Git inspection failed: ${(error as Error).message}`,
      remotes: [],
      branches: [],
      files: [],
      history: [],
      stashes: [],
    };
  }
}

function configKey(key: string): string {
  const first = key.indexOf("."),
    last = key.lastIndexOf(".");
  return first < 0
    ? key.toLowerCase()
    : `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}
function configuredRemotes(config: Buffer): GitRemote[] {
  return [
    ...new Set(
      nulFields(config).flatMap(entry => {
        const match = /^remote\.(.+)\.url\n/i.exec(entry);
        return match?.[1] && /^[^-\s][^\s]*$/.test(match[1]) ? [match[1]] : [];
      }),
    ),
  ].map(name => ({ name }));
}
function configValues(raw: Buffer, key: string): string[] {
  const wanted = configKey(key);
  return nulFields(raw).flatMap(entry => {
    const newline = entry.indexOf("\n");
    return newline >= 0 && configKey(entry.slice(0, newline)) === wanted ? [entry.slice(newline + 1)] : [];
  });
}
function freshState(fresh: FreshRevision): GitState {
  const branch = fresh.head.symbolic?.startsWith("refs/heads/")
    ? fresh.head.symbolic.slice("refs/heads/".length)
    : undefined;
  const remotes = configuredRemotes(fresh.config);
  return {
    available: true,
    revision: fresh.revision,
    truncated: fresh.truncated || undefined,
    branch,
    head: fresh.head.oid,
    remotes,
    branches: [],
    files: parseStatus(fresh.status).files,
    operation: fresh.op,
    history: [],
    stashes: parseStashes(fresh.stash),
  };
}
async function checkedRepo(cwd: string, expected: string): Promise<{ repo: Repo; state: GitState; config: Buffer }> {
  const repo = await repository(cwd);
  if (!repo) throw Error("This folder is not a Git working repository.");
  const fresh = await safeRevision(repo);
  if (fresh.truncated) throw Error("Git state exceeded the safe inspection limit; actions are disabled.");
  if (fresh.revision !== expected) throw Error("Git state changed. Refresh before performing this action.");
  return { repo, state: freshState(fresh), config: fresh.config };
}

async function assertActionPath(repo: Repo, path: string, missing = true, hasHead = true): Promise<void> {
  await safePath(repo, path, missing);
  const modes = (await pathModesBatch(repo, [path], hasHead)).get(path)!;
  if (modes.some(mode => mode === 0o120000 || mode === 0o160000 || (mode & 0o170000) !== 0o100000))
    throw Error("Symlink, submodule, and special Git entries cannot be changed here.");
  const attribute = nulFields(await git(repo.root, ["--literal-pathspecs", "check-attr", "-z", "filter", "--", path]));
  if (attribute[2] && attribute[2] !== "unspecified" && attribute[2] !== "unset")
    throw Error("Files using Git filters cannot be changed here.");
}
function pathChunks(paths: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const path of paths) {
    if (current.length >= 200 || chars + path.length + 1 > 24_000) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(path);
    chars += path.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
async function pathModesBatch(repo: Repo, paths: string[], hasHead: boolean): Promise<Map<string, number[]>> {
  const modes = new Map(paths.map(path => [path, [] as number[]]));
  for (const chunk of pathChunks(paths)) {
    const commands: [string[], RegExp][] = [
      [["--literal-pathspecs", "ls-files", "-s", "-z", "--", ...chunk], /^(\d+) [a-f0-9]{40,64} \d\t([\s\S]+)$/],
      ...(hasHead
        ? [
            [
              ["--literal-pathspecs", "ls-tree", "-z", "HEAD", "--", ...chunk],
              /^(\d+) \w+ [a-f0-9]{40,64}\t([\s\S]+)$/,
            ] as [string[], RegExp],
          ]
        : []),
    ];
    for (const [command, matcher] of commands) {
      for (const row of nulFields(await git(repo.root, command)).filter(Boolean)) {
        const match = matcher.exec(row);
        const values = match && modes.get(match[2]);
        if (!values) throw Error("Git returned an unexpected path or mode during validation.");
        values.push(Number.parseInt(match![1], 8));
      }
    }
  }
  return modes;
}
function requireExactChanged(state: GitState, paths: string[]): void {
  const requested = new Set(paths);
  for (const path of paths) {
    const file = state.files.find(item => item.path === path || item.oldPath === path);
    if (!file) throw Error(`Path is not a current changed file: ${path}`);
    if (file.oldPath && (!requested.has(file.path) || !requested.has(file.oldPath)))
      throw Error("Both old and new paths of a staged rename must be selected.");
  }
}
async function validateActionPaths(repo: Repo, state: GitState, paths: string[]): Promise<Map<string, number[]>> {
  requireExactChanged(state, paths);
  for (const path of paths) await safePath(repo, path, true);
  const modes = await pathModesBatch(repo, paths, !!state.head);
  for (const chunk of pathChunks(paths)) {
    const fields = nulFields(
      await git(repo.root, ["--literal-pathspecs", "check-attr", "-z", "filter", "--", ...chunk]),
    );
    if (fields.length !== chunk.length * 3 + 1 || fields.at(-1) !== "")
      throw Error("Incomplete Git attribute validation.");
    for (let index = 0; index + 2 < fields.length; index += 3) {
      const [path, name, attribute] = fields.slice(index, index + 3);
      if (
        path !== chunk[index / 3] ||
        name !== "filter" ||
        !modes.has(path) ||
        (attribute && attribute !== "unspecified" && attribute !== "unset")
      )
        throw Error("Files using Git filters cannot be changed here.");
    }
  }
  if (
    [...modes.values()].some(values =>
      values.some(mode => mode === 0o120000 || mode === 0o160000 || (mode & 0o170000) !== 0o100000),
    )
  )
    throw Error("Symlink, submodule, and special Git entries cannot be changed here.");
  return modes;
}
async function noOperation(state: GitState): Promise<void> {
  if (state.operation) throw Error(`A ${state.operation.kind} is already in progress.`);
}
async function clean(state: GitState): Promise<void> {
  if (state.files.length) throw Error("Working tree must be clean for this action.");
}

async function namedRef(repo: Repo, ref: string): Promise<string> {
  await git(repo.root, ["check-ref-format", ref]);
  const refs = (await gitText(repo.root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])).split(
    "\n",
  );
  if (!refs.includes(ref)) throw Error("Select a current local or remote branch ref.");
  return (await gitText(repo.root, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
}
async function allowedCommit(repo: Repo, oid: string): Promise<void> {
  if (!OID.test(oid)) throw Error("Invalid commit ID.");
  await git(repo.root, ["cat-file", "-e", `${oid}^{commit}`]);
  const reachable = await gitText(repo.root, [
    "for-each-ref",
    "--contains",
    oid,
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
  ]);
  if (!reachable.trim()) throw Error("Commit is not reachable from an available branch.");
}
async function configuredUpstream(
  repo: Repo,
  state: GitState,
  config: Buffer,
): Promise<{ remote: string; remoteRef: string; local: string }> {
  if (!state.branch) throw Error("Detached HEAD cannot be pushed or pulled by the managed workspace.");
  const remote = configValues(config, `branch.${state.branch}.remote`)[0];
  const remoteRef = configValues(config, `branch.${state.branch}.merge`)[0];
  if (!remote || !remoteRef || remote.startsWith("-") || !/^[^\s\0]+$/.test(remote))
    throw Error("Current branch has no safe configured upstream.");
  await git(repo.root, ["check-ref-format", remoteRef]);
  if (!remoteRef.startsWith("refs/heads/")) throw Error("Configured upstream is unsafe.");
  const mirrors = configValues(config, `remote.${remote}.mirror`),
    pushUrls = configValues(config, `remote.${remote}.pushurl`);
  const pushSpecs = configValues(config, `remote.${remote}.push`),
    pushOptions = configValues(config, `remote.${remote}.pushoption`);
  const globalPushOptions = configValues(config, "push.pushOption"),
    urls = configValues(config, `remote.${remote}.url`);
  const mirror = (
    await gitText(repo.root, ["config", "--bool", `remote.${remote}.mirror`]).catch((error: GitFailure) => {
      if (error.code === 1) return "false";
      throw error;
    })
  )
    .trim()
    .split(/\s+/);
  if (mirror.includes("true") || globalPushOptions.length || (!pushUrls.length && urls.length > 1))
    throw Error("Configured push destination is ambiguous or has unsafe options.");
  if (
    mirrors.some(value => value === "true") ||
    pushUrls.length > 1 ||
    pushOptions.length ||
    pushSpecs.some(value => value.startsWith("+") || value.startsWith(":"))
  )
    throw Error("Configured remote has unsafe mirror, force, or push-option behavior.");
  if (!state.remotes.some(value => value.name === remote)) throw Error("Configured upstream remote is unavailable.");
  return { remote, remoteRef, local: `refs/heads/${state.branch}` };
}
function operationCommand(input: Extract<GitActionInput, { action: "continue" | "skip" | "abort" }>): string[] {
  if (input.action === "continue")
    return input.operation === "merge"
      ? ["merge", "--continue"]
      : input.operation === "rebase"
        ? ["rebase", "--continue"]
        : input.operation === "cherry-pick"
          ? ["cherry-pick", "--continue"]
          : ["revert", "--continue"];
  if (input.action === "skip") {
    if (input.operation === "merge") throw Error("Merge cannot be skipped.");
    return input.operation === "rebase"
      ? ["rebase", "--skip"]
      : input.operation === "cherry-pick"
        ? ["cherry-pick", "--skip"]
        : ["revert", "--skip"];
  }
  return input.operation === "merge"
    ? ["merge", "--abort"]
    : input.operation === "rebase"
      ? ["rebase", "--abort"]
      : input.operation === "cherry-pick"
        ? ["cherry-pick", "--abort"]
        : ["revert", "--abort"];
}

async function selectedStash(repo: Repo, oid: string, selector: string): Promise<void> {
  const stashes = parseStashes(await git(repo.root, ["stash", "list", "--format=%H%x00%gd%x00%s%x00%x1e"]));
  if (!stashes.some(stash => stash.oid === oid && stash.selector === selector))
    throw Error("Selected stash changed; refresh first.");
}

export async function runGitAction(cwd: string, input: GitActionInput): Promise<void> {
  if (!validGitActionInput(input)) throw Error("Invalid Git action.");
  if (input.action === "init") {
    const root = await realpath(cwd),
      before = await readGitState(root);
    if (before.available || before.revision !== input.expectedRevision)
      throw Error("Folder state changed or is already a repository.");
    if (await repository(root)) throw Error("Git can only be initialized in a non-repository folder.");
    await git(root, ["init"]);
    return;
  }
  const { repo, state, config } = await checkedRepo(cwd, input.expectedRevision);
  if (input.action === "stage" || input.action === "unstage") {
    await noOperation(state);
    await validateActionPaths(repo, state, input.paths);
    for (const paths of pathChunks(input.paths)) {
      if (input.action === "stage") await git(repo.root, ["--literal-pathspecs", "add", "--", ...paths]);
      else if (state.head) await git(repo.root, ["--literal-pathspecs", "restore", "--staged", "--", ...paths]);
      else await git(repo.root, ["--literal-pathspecs", "rm", "--cached", "--ignore-unmatch", "--", ...paths]);
    }
    return;
  }
  if (input.action === "commit") {
    await noOperation(state);
    if (!state.branch) throw Error("Detached HEAD cannot be committed by the managed workspace.");
    const staged = state.files.some(file => file.indexStatus !== " " && file.indexStatus !== "?");
    if (!staged && !(input.amend && state.head)) throw Error("There are no staged changes to commit.");
    await git(repo.root, ["commit", ...(input.amend ? ["--amend"] : []), "-m", input.message]);
    return;
  }
  if (input.action === "createBranch") {
    await noOperation(state);
    await git(repo.root, ["check-ref-format", "--branch", input.name]);
    await git(repo.root, ["branch", input.name]);
    return;
  }
  if (input.action === "fetch") {
    await noOperation(state);
    const remote = input.remote ?? state.remotes[0]?.name;
    if (!remote || remote.startsWith("-") || !state.remotes.some(value => value.name === remote))
      throw Error("Select a configured remote.");
    const mirror = (
      await gitText(repo.root, ["config", "--bool", `remote.${remote}.mirror`]).catch((error: GitFailure) => {
        if (error.code === 1) return "false";
        throw error;
      })
    ).trim();
    if (mirror === "true") throw Error("Mirror remotes cannot be used here.");
    await git(repo.root, ["fetch", "--", remote]);
    return;
  }
  if (input.action === "pull" || input.action === "push") {
    await noOperation(state);
    if (input.action === "pull") await clean(state);
    const upstream = await configuredUpstream(repo, state, config);
    await git(
      repo.root,
      input.action === "pull"
        ? ["pull", "--ff-only", "--no-rebase", "--", upstream.remote, upstream.remoteRef]
        : [
            "push",
            "--no-mirror",
            "--no-follow-tags",
            "--recurse-submodules=no",
            "--",
            upstream.remote,
            `${upstream.local}:${upstream.remoteRef}`,
          ],
    );
    return;
  }
  if (input.action === "stash") {
    await noOperation(state);
    if (!state.files.length) throw Error("There are no changes to stash.");
    await git(repo.root, [
      "stash",
      "push",
      ...(input.includeUntracked ? ["--include-untracked"] : []),
      ...(input.message ? ["-m", input.message] : []),
    ]);
    return;
  }
  if (input.action === "stashApply" || input.action === "stashPop" || input.action === "stashDrop") {
    if (input.action !== "stashDrop") {
      await noOperation(state);
      await clean(state);
    }
    if (!state.stashes.some(stash => stash.oid === input.oid && stash.selector === input.selector))
      throw Error("Selected stash changed or no longer exists.");
    await selectedStash(repo, input.oid, input.selector);
    if (input.action === "stashDrop") await git(repo.root, ["stash", "drop", input.selector]);
    else if (input.action === "stashApply") await git(repo.root, ["stash", "apply", input.selector]);
    else
      try {
        await git(repo.root, ["stash", "pop", input.selector]);
      } catch (error) {
        const status = await git(repo.root, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
        if (parseStatus(status).files.some(file => file.indexStatus === "U" || file.worktreeStatus === "U" ||
          ["AA", "DD"].includes(file.indexStatus + file.worktreeStatus)))
          throw Error("Stash pop conflicted; the stash was not dropped.");
        throw error;
      }
    return;
  }
  if (input.action === "discard") {
    await noOperation(state);
    const modes = await validateActionPaths(repo, state, input.paths);
    const tracked = input.paths.filter(path => modes.get(path)!.length > 0),
      untracked = input.paths.filter(path => !modes.get(path)!.length);
    // Restore tracked paths only after the whole selection has passed validation.
    if (tracked.length && input.scope === "working")
      for (const paths of pathChunks(tracked))
        await git(repo.root, ["--literal-pathspecs", "restore", "--worktree", "--", ...paths]);
    if (tracked.length && input.scope === "all" && state.head)
      for (const paths of pathChunks(tracked))
        await git(repo.root, [
          "--literal-pathspecs",
          "restore",
          "--source=HEAD",
          "--staged",
          "--worktree",
          "--",
          ...paths,
        ]);
    const remove = [...untracked, ...(tracked.length && input.scope === "all" && !state.head ? tracked : [])];
    for (const paths of pathChunks(remove.filter(path => modes.get(path)!.length)))
      if (!state.head && input.scope === "all")
        await git(repo.root, ["--literal-pathspecs", "rm", "--cached", "--ignore-unmatch", "--", ...paths]);
    for (const path of remove) {
      const absolute = await safePath(repo, path, true);
      if (!absolute) continue;
      const stat = await lstat(absolute);
      if (!stat.isFile() || stat.nlink !== 1) throw Error("Only an explicit regular untracked file can be discarded.");
      await unlink(absolute);
    }
    return;
  }
  if (input.action === "merge" || input.action === "rebase") {
    await noOperation(state);
    await clean(state);
    await git(repo.root, [input.action, await namedRef(repo, input.target)]);
    return;
  }
  if (input.action === "cherryPick" || input.action === "revert") {
    await noOperation(state);
    await clean(state);
    if (!state.branch) throw Error("Select a branch before replaying commits.");
    for (const oid of input.oids) await allowedCommit(repo, oid);
    const parentRows = parseRecords(
      await git(repo.root, ["show", "-s", "--format=%H%x00%P%x00%x1e", ...input.oids]),
      2,
    );
    if (parentRows.some(row => row[1].split(" ").filter(Boolean).length > 1))
      throw Error("Merge commits require an explicit mainline choice. Use local Git tools for this selection.");
    await git(repo.root, [input.action === "cherryPick" ? "cherry-pick" : "revert", ...input.oids]);
    return;
  }
  if (input.action === "continue" || input.action === "skip" || input.action === "abort") {
    if (!state.operation || state.operation.kind !== input.operation) throw Error("That Git operation is not active.");
    await git(repo.root, operationCommand(input));
    return;
  }
  if (input.action === "resolve") await resolveConflict(repo, state, input);
}

async function markerSize(repo: Repo, path: string): Promise<number> {
  const parts = nulFields(await git(repo.root, ["check-attr", "-z", "conflict-marker-size", "--", path]));
  const value = parts[2];
  if (!value || value === "unspecified" || value === "unset") return 7;
  if (!/^\d+$/.test(value) || Number(value) !== 7)
    throw Error("Custom conflict marker sizes require manual resolution.");
  return Number(value);
}
function parseConflictBlocks(text: string, size = 7): GitConflictBlock[] {
  const startMarker = "<".repeat(size);
  const baseMarker = "|".repeat(size);
  const middleMarker = "=".repeat(size);
  const endMarker = ">".repeat(size);
  const lines = text.split(/(?<=\n)/);
  const blocks: GitConflictBlock[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const first = lines[index];
    if (!first.startsWith(`${startMarker} `)) {
      offset += first.length;
      continue;
    }
    const start = offset;
    const oursLabel = first.slice(size + 1).replace(/\n$/, "");
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    let baseLabel: string | undefined;
    let theirsLabel: string | undefined;
    let part = ours;
    let middle = false;
    let end: number | undefined;
    offset += first.length;
    for (index++; index < lines.length; index++) {
      const line = lines[index];
      if (line.startsWith(`${baseMarker} `) && !middle) {
        baseLabel = line.slice(size + 1).replace(/\n$/, "");
        part = base;
        offset += line.length;
        continue;
      }
      if (line === middleMarker || line === `${middleMarker}\n`) {
        middle = true;
        part = theirs;
        offset += line.length;
        continue;
      }
      if (line.startsWith(`${endMarker} `) && middle) {
        theirsLabel = line.slice(size + 1).replace(/\n$/, "");
        offset += line.length;
        end = offset;
        break;
      }
      part.push(line);
      offset += line.length;
    }
    if (end === undefined) return [];
    blocks.push({
      start,
      end,
      ours: ours.join(""),
      theirs: theirs.join(""),
      ...(base.length ? { base: base.join("") } : {}),
      oursLabel,
      ...(baseLabel ? { baseLabel } : {}),
      theirsLabel,
    });
  }
  return blocks;
}
function hasConflictMarkers(text: string): boolean {
  return /^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/m.test(text);
}

async function unmergedEntries(repo: Repo, path: string): Promise<Array<{ mode: string; oid: string; stage: number }>> {
  const rows = nulFields(await git(repo.root, ["--literal-pathspecs", "ls-files", "--unmerged", "-z", "--", path]));
  const entries: Array<{ mode: string; oid: string; stage: number }> = [];
  for (const row of rows) {
    const match = /^(\d+) ([a-f0-9]{40,64}) ([123])\t(.+)$/.exec(row);
    if (match && match[4] === path) entries.push({ mode: match[1], oid: match[2], stage: Number(match[3]) });
  }
  return entries;
}
async function blobText(repo: Repo, oid: string): Promise<string> {
  const bytes = await git(repo.root, ["cat-file", "blob", oid], undefined, MAX_EDIT_BYTES + 1);
  if (bytes.length > MAX_EDIT_BYTES || bytes.includes(0))
    throw Error("Manual resolution is required for binary or oversized conflict content.");
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw Error("Manual resolution is required for non-UTF-8 conflict content.");
  return text.replace(/^\ufeff/, "").replaceAll("\r\n", "\n");
}
async function validateConflict(
  repo: Repo,
  path: string,
): Promise<Array<{ mode: string; oid: string; stage: number }>> {
  await assertActionPath(repo, path, false);
  const entries = await unmergedEntries(repo, path);
  const stages = new Set(entries.map(entry => entry.stage));
  if (
    !(
      (stages.size === 3 && stages.has(1) && stages.has(2) && stages.has(3)) ||
      (stages.size === 2 && stages.has(2) && stages.has(3))
    ) ||
    entries.some(entry => entry.mode !== "100644" && entry.mode !== "100755")
  )
    throw Error(
      "Manual resolution is required for rename, delete, binary, symlink, submodule, or unsupported conflicts.",
    );
  for (const entry of entries) await blobText(repo, entry.oid);
  return entries;
}
async function stagingIdentity(repo: Repo): Promise<string> {
  const index = (await readRegular(join(repo.gitDir, "index"), MAX_OUTPUT, true)) ?? Buffer.alloc(0);
  const head = await headIdentity(repo);
  const op = await operation(repo);
  return hash([index, head, op.identity]);
}
async function resolveConflict(
  repo: Repo,
  state: GitState,
  input: Extract<GitActionInput, { action: "resolve" }>,
): Promise<void> {
  if (!state.operation) throw Error("Conflict resolution requires an active Git operation.");
  await markerSize(repo, input.path);
  await validateConflict(repo, input.path);
  if (hasConflictMarkers(input.text)) throw Error("Resolved text still contains conflict markers.");
  const entry = await readWorkspaceEntry(repo.root, input.path, undefined, false);
  if (entry.text === undefined || entry.version !== input.expectedVersion)
    throw Error(entry.readOnlyReason ?? "Conflict file changed; reopen it before resolving.");
  const before = await stagingIdentity(repo);
  const receipt = await mutateWorkspace(repo.root, {
    action: "save",
    path: input.path,
    expectedVersion: input.expectedVersion,
    text: input.text,
  });
  if (!receipt?.savedVersion) throw Error("Resolved file save did not return a receipt.");
  const saved = await readWorkspaceEntry(repo.root, input.path, undefined, false);
  if (saved.version !== receipt.savedVersion || saved.text !== input.text)
    throw Error("Resolved file was saved, not staged: save receipt could not be verified.");
  try {
    if ((await stagingIdentity(repo)) !== before) throw Error("Git index, HEAD, or operation changed after saving.");
  } catch (error) {
    throw Error(`Resolved file was saved, not staged: ${(error as Error).message}`);
  }
  let stageAttempted = false;
  try {
    stageAttempted = true;
    await git(repo.root, ["--literal-pathspecs", "add", "--", input.path]);
    if ((await unmergedEntries(repo, input.path)).length)
      throw Error("Git still reports unmerged entries for the exact resolved path.");
  } catch (error) {
    throw Error(
      stageAttempted
        ? `Resolved file was saved; staging outcome uncertain: ${(error as Error).message}`
        : `Resolved file was saved, not staged: ${(error as Error).message}`,
    );
  }
}

async function textAt(repo: Repo, spec: string): Promise<{ text?: string; truncated?: boolean }> {
  try {
    return { text: await blobText(repo, spec) };
  } catch (error: any) {
    if (error?.code) return {};
    return { truncated: true };
  }
}
function changed(raw: Buffer): GitDetailFile[] {
  const values = nulFields(raw);
  const files: GitDetailFile[] = [];
  for (let index = 0; index < values.length - 1; index++) {
    const status = values[index];
    if (!status) continue;
    const kind = status.slice(0, 1);
    const score = /^[A-Z][0-9]*$/.test(status);
    const path = values[++index];
    if ((kind === "R" || kind === "C") && score) {
      const destination = values[++index];
      if (validWorkspacePath(destination) && validWorkspacePath(path))
        files.push({ path: destination, oldPath: path, indexStatus: kind, worktreeStatus: " " });
    } else if (validWorkspacePath(path)) files.push({ path, indexStatus: kind, worktreeStatus: " " });
  }
  return files;
}
const blobCache = new Map<string, { text: string; bytes: number }>();
let blobCacheBytes = 0;
async function historicalText(
  repo: Repo,
  oid: string,
  cache: boolean,
): Promise<{ text?: string; truncated?: boolean }> {
  const key = `${repo.gitDir}:${oid}`;
  const hit = cache && blobCache.get(key);
  if (hit) return { text: hit.text };
  const result = await textAt(repo, oid);
  if (cache && result.text !== undefined && !blobCache.has(key)) {
    const bytes = Buffer.byteLength(result.text);
    while (blobCache.size >= 512 || blobCacheBytes + bytes > 16 * 1024 * 1024) {
      const oldest = blobCache.entries().next().value;
      if (!oldest) break;
      blobCache.delete(oldest[0]);
      blobCacheBytes -= oldest[1].bytes;
    }
    if (bytes <= 16 * 1024 * 1024) {
      blobCache.set(key, { text: result.text, bytes });
      blobCacheBytes += bytes;
    }
  }
  return result;
}
async function detailFile(
  repo: Repo,
  file: GitDetailFile,
  beforePrefix: string,
  afterPrefix: string,
  cache: boolean,
): Promise<void> {
  const specs = [
    file.indexStatus === "A" ? undefined : `${beforePrefix}${file.oldPath ?? file.path}`,
    file.indexStatus === "D" ? undefined : `${afterPrefix}${file.path}`,
  ];
  const ids = (await gitText(repo.root, ["rev-parse", ...specs.filter((spec): spec is string => spec !== undefined)]))
    .trim()
    .split(/\r?\n/);
  if (ids.length !== specs.filter(Boolean).length || ids.some(oid => !OID.test(oid)))
    throw Error("Git returned incomplete historical object identities.");
  let next = 0;
  const [before, after] = await Promise.all(
    specs.map(async (spec): Promise<{ text?: string; truncated?: boolean }> =>
      spec === undefined ? { text: "" } : historicalText(repo, ids[next++], cache),
    ),
  );
  if (before.text !== undefined) file.beforeText = before.text;
  if (after.text !== undefined) file.afterText = after.text;
  if (before.truncated || after.truncated) file.textTruncated = true;
}
function historicalDetail(
  revision: string,
  files: GitDetailFile[],
  selected: GitDetailFile,
  unified: Buffer,
): GitDetail {
  return {
    revision: hash([revision, unified, selected]),
    selectedPath: selected.path,
    files,
    unifiedDiff: unified.toString("utf8"),
    truncated: unified.length >= MAX_DETAIL,
  };
}
async function diffOutput(repo: Repo, args: string[]): Promise<Buffer> {
  try {
    return await git(repo.root, args, undefined, MAX_DETAIL);
  } catch (error: any) {
    if (error.code === 1 && error.stdout) return error.stdout;
    throw error;
  }
}

export async function readGitDetail(cwd: string, query: GitDetailQuery): Promise<GitDetail> {
  if (!validGitDetailQuery(query)) throw Error("Invalid Git detail query.");
  const repo = await repository(cwd);
  if (!repo) throw Error("This folder is not a Git working repository.");
  // Mutable views need the same fresh content observation used by actions, but never display loading.
  if (query.kind === "file" || query.kind === "conflict") {
    const fresh = await safeRevision(repo);
    if (fresh.truncated) throw Error("Git state exceeded the safe inspection limit.");
    const state = freshState(fresh),
      revision = fresh.revision;
    if (query.kind === "file") {
      await assertActionPath(repo, query.path, true, !!state.head);
      const status = state.files.find(file => file.path === query.path || file.oldPath === query.path);
      if (!status) throw Error("Path is not a current changed file.");
      let unified = await diffOutput(
        repo,
        query.stage === "staged"
          ? [
              "--literal-pathspecs",
              "diff",
              "--cached",
              "--no-ext-diff",
              "--no-textconv",
              "--",
              ...(status.oldPath ? [status.oldPath, status.path] : [query.path]),
            ]
          : [
              "--literal-pathspecs",
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--",
              ...(status.oldPath ? [status.oldPath, status.path] : [query.path]),
            ],
      );
      const before =
        (query.stage === "staged" && (!state.head || status.indexStatus === "A")) ||
        (query.stage === "unstaged" && status.indexStatus === "?")
          ? { text: "" }
          : await textAt(repo, query.stage === "staged" ? `HEAD:${status.oldPath ?? query.path}` : `:${query.path}`);
      let after: { text?: string; truncated?: boolean };
      if (query.stage === "staged")
        after = status.indexStatus === "D" ? { text: "" } : await textAt(repo, `:${query.path}`);
      else if (status.indexStatus === "?" && !status.oldPath) {
        await safePath(repo, query.path);
        unified = await diffOutput(repo, [
          "--no-pager",
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-textconv",
          "--",
          "/dev/null",
          query.path,
        ]);
        const entry = await readWorkspaceEntry(repo.root, query.path, undefined, false);
        after = entry.text === undefined ? { truncated: true } : { text: entry.text };
      } else if (status.worktreeStatus === "D") after = { text: "" };
      else {
        const entry = await readWorkspaceEntry(repo.root, query.path, undefined, false);
        after = entry.text === undefined ? { truncated: true } : { text: entry.text };
      }
      return {
        revision,
        selectedPath: query.path,
        files: [
          {
            path: query.path,
            ...(status.oldPath ? { oldPath: status.oldPath } : {}),
            indexStatus: status.indexStatus,
            worktreeStatus: status.worktreeStatus,
            ...(before.text !== undefined ? { beforeText: before.text } : {}),
            ...(after.text !== undefined ? { afterText: after.text } : {}),
            ...(before.truncated || after.truncated ? { textTruncated: true } : {}),
          },
        ],
        unifiedDiff: unified.toString("utf8"),
        truncated: unified.length >= MAX_DETAIL,
      };
    }
    await markerSize(repo, query.path);
    const entries = await validateConflict(repo, query.path);
    const entry = await readWorkspaceEntry(repo.root, query.path, undefined, false);
    if (entry.text === undefined) throw Error(entry.readOnlyReason ?? "Manual resolution is required.");
    const blocks = parseConflictBlocks(entry.text),
      last = blocks.at(-1);
    if (last?.end === entry.text.length) {
      const ours = await blobText(repo, entries.find(item => item.stage === 2)!.oid),
        theirs = await blobText(repo, entries.find(item => item.stage === 3)!.oid);
      if (!ours.endsWith("\n")) last.ours = last.ours.replace(/\n$/, "");
      if (!theirs.endsWith("\n")) last.theirs = last.theirs.replace(/\n$/, "");
    }
    return {
      revision,
      selectedPath: query.path,
      files: [{ path: query.path, indexStatus: "U", worktreeStatus: "U", afterText: entry.text }],
      unifiedDiff: "",
      conflict: { path: query.path, version: entry.version, text: entry.text, blocks, operation: state.operation },
    };
  }
  // Immutable views authorize current reachability/membership before consulting object caches.
  const { refs } = await observedHead(repo);
  const revision = hash([repo.gitDir, refs]);
  // Replacement refs can change bytes returned for the same requested OID.
  const cacheBlobs = !parseNulRows(refs, 4).some(row => row[0].startsWith("refs/replace/"));
  if (query.kind === "history") {
    await namedRef(repo, query.ref);
    return {
      revision,
      files: [],
      unifiedDiff: "",
      commits: parseLog(
        await git(repo.root, [
          "log",
          "-n",
          String(MAX_HISTORY),
          "--format=%H%x00%P%x00%s%x00%an%x00%aI%x00%x1e",
          query.ref,
        ]),
      ),
    };
  }
  if (query.kind === "stash") {
    if (
      !parseStashes(await git(repo.root, ["stash", "list", "--format=%H%x00%gd%x00%s%x00%x1e"])).some(
        stash => stash.oid === query.oid,
      )
    )
      throw Error("Selected stash no longer exists.");
    const names = changed(
      await git(repo.root, ["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", `${query.oid}^`, query.oid]),
    );
    const parents = (await gitText(repo.root, ["show", "-s", "--format=%P", query.oid]))
      .trim()
      .split(" ")
      .filter(value => OID.test(value));
    const untracked = parents[2]
      ? changed(
          await git(repo.root, ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-z", parents[2]]),
        )
      : [];
    for (const file of untracked) if (!names.some(existing => existing.path === file.path)) names.push(file);
    if (names.length > MAX_FILES) throw Error("This comparison exceeds the 2,000-file review limit.");
    if (!names.length && !query.path) return { revision, files: [], unifiedDiff: "" };
    const selected = query.path
      ? names.find(file => file.path === query.path || file.oldPath === query.path)
      : names[0];
    if (!selected) throw Error("Selected path is not changed by this comparison.");
    await detailFile(
      repo,
      selected,
      `${query.oid}^:`,
      untracked.includes(selected) && parents[2] ? `${parents[2]}:` : `${query.oid}:`,
      cacheBlobs,
    );
    const files = names;
    const paths = selected.oldPath ? [selected.oldPath, selected.path] : [selected.path];
    const unified = await diffOutput(repo, [
      "--literal-pathspecs",
      "stash",
      "show",
      "--include-untracked",
      "-p",
      "--no-ext-diff",
      "--no-textconv",
      query.oid,
      ...(files.some(file => file.oldPath) ? [] : ["--", ...paths]),
    ]);
    return historicalDetail(revision, files, selected, unified);
  }
  const oldest = query.kind === "commit" ? undefined : query.oldest,
    newest = query.kind === "commit" ? query.oid : query.newest;
  await allowedCommit(repo, newest);
  if (oldest) {
    await allowedCommit(repo, oldest);
    try {
      await git(repo.root, ["merge-base", "--is-ancestor", oldest, newest]);
    } catch (error: any) {
      if (error.code === 1) throw Error("Range oldest commit is not an ancestor of newest commit.");
      throw error;
    }
  }
  const parent = oldest
    ? (await gitText(repo.root, ["rev-parse", "--verify", `${oldest}^`]).catch(() => "")).trim() ||
      (await git(repo.root, ["hash-object", "-t", "tree", "--stdin"], Buffer.alloc(0))).toString("utf8").trim()
    : ((await gitText(repo.root, ["show", "-s", "--format=%P", newest])).trim().split(" ").filter(Boolean)[0] ??
      (await git(repo.root, ["hash-object", "-t", "tree", "--stdin"], Buffer.alloc(0))).toString("utf8").trim());
  const files = changed(await git(repo.root, ["diff", "--name-status", "-z", parent, newest]));
  if (files.length > MAX_FILES) throw Error("This comparison exceeds the 2,000-file review limit.");
  if (!files.length && !query.path) return { revision, files: [], unifiedDiff: "" };
  const selected = query.path ? files.find(file => file.path === query.path || file.oldPath === query.path) : files[0];
  if (!selected) throw Error("Selected path is not changed by this comparison.");
  await detailFile(repo, selected, `${parent}:`, `${newest}:`, cacheBlobs);
  const paths = selected.oldPath ? [selected.oldPath, selected.path] : [selected.path];
  const unified = await diffOutput(repo, [
    "--literal-pathspecs",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    parent,
    newest,
    ...(files.some(file => file.oldPath) ? [] : ["--", ...paths]),
  ]);
  return historicalDetail(revision, files, selected, unified);
}
