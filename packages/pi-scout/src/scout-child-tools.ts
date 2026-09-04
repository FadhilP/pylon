import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { executableAvailable, type ExecutableProbe } from "pylon-core/executable";
import { Type } from "typebox";

const TIMEOUT_MS = 30_000;
/** Modest cap for Scout's isolated child tools. */
export const SCOUT_TOOL_MAX_BYTES = 24 * 1024;
const MAX_MATCHES = 200;

export function workspacePath(cwd: string, input = "."): string {
  const clean = input.replace(/^@/, "") || ".";
  const absolute = resolve(cwd, clean);
  const within = relative(resolve(cwd), absolute);
  if (within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)) {
    throw new Error("Search path must stay within workspace");
  }
  return within || ".";
}

function fit(text: string, maxBytes: number): string {
  let value = text;
  while (Buffer.byteLength(value, "utf8") > maxBytes) value = value.slice(0, -1);
  return value;
}

function bounded(output: string, maxBytes = DEFAULT_MAX_BYTES): string {
  const result = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes });
  if (!result.truncated) return result.content;
  const notice = `\n\n[Output truncated; omitted output after ${result.outputLines}/${result.totalLines} lines and ${formatSize(result.outputBytes)}/${formatSize(result.totalBytes)}. Cap: ${formatSize(maxBytes)}.]`;
  return `${fit(result.content, maxBytes - Buffer.byteLength(notice, "utf8"))}${notice}`;
}

function citationBlocks(output: string) {
  const raw = /\r?\n--\r?\n/.test(output) ? output.split(/\r?\n--\r?\n/) : output.split(/\r?\n/).filter(Boolean);
  const files = new Map<string, string[]>();
  for (const [index, block] of raw.entries()) {
    const file = block.match(/^(.+?)(?::|-)\d+(?::|-)/m)?.[1] ?? `~${index}`;
    const blocks = files.get(file) ?? [];
    blocks.push(block);
    files.set(file, blocks);
  }
  const representative: string[] = [];
  for (let depth = 0; representative.length < raw.length; depth++)
    for (const blocks of files.values()) if (blocks[depth] !== undefined) representative.push(blocks[depth]);
  return { blocks: representative, fileCount: files.size };
}

function evenlySample<T>(items: T[], count: number): T[] {
  if (count >= items.length) return items;
  if (count === 1) return [items[Math.floor((items.length - 1) / 2)]];
  return Array.from({ length: count }, (_, index) => items[Math.round((index * (items.length - 1)) / (count - 1))]);
}

export function boundedSearch(output: string, maxBytes = SCOUT_TOOL_MAX_BYTES): string {
  const result = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes });
  if (!result.truncated) return result.content;
  const { blocks, fileCount } = citationBlocks(output);
  if (!blocks.length) return bounded(output, maxBytes);
  const notice = `\n\n[Output sampled across ${fileCount} files; some matching excerpts omitted. Original: ${result.totalLines} lines/${formatSize(result.totalBytes)}. Cap: ${formatSize(maxBytes)}.]`;
  const bodyBudget = maxBytes - Buffer.byteLength(notice, "utf8");
  const prepared = blocks.map(block => fit(block, Math.min(4 * 1024, bodyBudget)));
  let count = prepared.length;
  while (count > 1) {
    const sampled = evenlySample(prepared, count).join("\n--\n");
    if (Buffer.byteLength(sampled, "utf8") <= bodyBudget) return `${sampled}${notice}`;
    count = Math.max(1, Math.min(count - 1, Math.floor((count * bodyBudget) / Buffer.byteLength(sampled, "utf8"))));
  }
  return `${fit(evenlySample(prepared, 1)[0], bodyBudget)}${notice}`;
}

const GIT_ACTIONS = ["status", "diff", "log", "show", "blame"] as const;
const GIT_PROCESS_MAX_BYTES = SCOUT_TOOL_MAX_BYTES * 4;
const GIT_MAX_COMMITS = 50;
const GIT_MAX_BLAME_LINES = 200;
const GIT_REF = /^(?![-^])[A-Za-z0-9._/@{}+~^-]+$/;

type GitTermination = "abort" | "timeout" | "output";
export type ScoutGitResult = {
  stdout: string;
  stderr: string;
  code: number;
  termination?: GitTermination;
  receivedBytes: number;
};
export type ScoutGitRunner = (cwd: string, args: readonly string[], signal?: AbortSignal) => Promise<ScoutGitResult>;

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^GIT_/i.test(key) || /(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_EXTERNAL_DIFF: "",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Spawn Git without a shell and stop it once output, time, or cancellation exceeds the tool budget. */
export const runBoundedGit: ScoutGitRunner = (cwd, args, signal) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn("git", [...args], {
      cwd,
      env: gitEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    let receivedBytes = 0;
    let termination: GitTermination | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let settled = false;

    const stop = (reason: GitTermination) => {
      if (termination) return;
      termination = reason;
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
      forceKill.unref();
    };
    const capture = (chunks: Buffer[], data: Buffer) => {
      receivedBytes += data.length;
      const remaining = Math.max(0, GIT_PROCESS_MAX_BYTES - capturedBytes);
      if (remaining) {
        chunks.push(data.subarray(0, remaining));
        capturedBytes += Math.min(data.length, remaining);
      }
      if (receivedBytes > GIT_PROCESS_MAX_BYTES) stop("output");
    };
    child.stdout.on("data", data => capture(stdout, Buffer.from(data)));
    child.stderr.on("data", data => capture(stderr, Buffer.from(data)));

    const timeout = setTimeout(() => stop("timeout"), TIMEOUT_MS);
    timeout.unref();
    const abort = () => stop("abort");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    const finish = () => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", error => {
      if (settled) return;
      settled = true;
      finish();
      rejectRun(error);
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      finish();
      resolveRun({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 1,
        termination,
        receivedBytes,
      });
    });
  });

function gitPrefix(root: string): string[] {
  return [
    "--no-replace-objects",
    "--no-pager",
    "--no-optional-locks",
    "--literal-pathspecs",
    "-C",
    root,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "color.ui=false",
    "-c",
    "color.blame=false",
  ];
}

async function checkedGit(
  runner: ScoutGitRunner,
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<ScoutGitResult> {
  const result = await runner(root, [...gitPrefix(root), ...args], signal);
  if (result.termination === "abort") throw new Error("Git evidence request cancelled");
  if (result.termination === "timeout") throw new Error(`Git evidence request timed out after ${TIMEOUT_MS}ms`);
  if (result.code !== 0 && result.termination !== "output") {
    const message = bounded(result.stderr || result.stdout, SCOUT_TOOL_MAX_BYTES).trim() || "unknown error";
    throw new Error(`git ${args[0]} failed (${result.code}): ${message}`);
  }
  return result;
}

function samePhysicalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function gitWorkspaceRoot(runner: ScoutGitRunner, cwd: string, signal?: AbortSignal): Promise<string> {
  const workspaceRoot = await realpath(cwd);
  const result = await checkedGit(runner, workspaceRoot, ["rev-parse", "--show-toplevel"], signal);
  if (result.termination === "output") throw new Error("Git repository root output exceeded the safety limit");
  const repositoryRoot = await realpath(result.stdout.trim());
  if (!samePhysicalPath(workspaceRoot, repositoryRoot))
    throw new Error("Git evidence requires the workspace root to equal the repository root");
  return workspaceRoot;
}

async function canonicalCommit(
  runner: ScoutGitRunner,
  root: string,
  input: string,
  signal?: AbortSignal,
): Promise<string> {
  if (
    input.length > 200 ||
    input.trim() !== input ||
    !GIT_REF.test(input) ||
    input.includes("..") ||
    input.includes(":")
  )
    throw new Error("Git ref contains unsupported revision syntax");
  const result = await checkedGit(
    runner,
    root,
    ["rev-parse", "--verify", "--end-of-options", `${input}^{commit}`],
    signal,
  );
  const lines = result.stdout.trim().split(/\r?\n/);
  if (result.termination === "output" || lines.length !== 1 || !/^[0-9a-f]{40,64}$/i.test(lines[0]))
    throw new Error("Git ref did not resolve to exactly one commit");
  return lines[0].toLowerCase();
}

function rejectUnsupported(params: Record<string, unknown>, allowed: readonly string[]) {
  const accepted = new Set(["action", ...allowed]);
  const unsupported = Object.entries(params).find(([key, value]) => value !== undefined && !accepted.has(key));
  if (unsupported) throw new Error(`${params.action} does not accept ${unsupported[0]}`);
}

function pathArgs(root: string, input: string | undefined): string[] {
  return input === undefined ? [] : ["--", workspacePath(root, input)];
}

function gitEvidenceText(label: string, result: ScoutGitResult, empty: string): string {
  const warning =
    result.termination === "output"
      ? `[Git output exceeded ${formatSize(GIT_PROCESS_MAX_BYTES)} and the command was stopped; partial evidence follows.]\n\n`
      : "";
  const stderr = result.stderr.trim() ? `\n\n[git stderr]\n${result.stderr.trim()}` : "";
  return bounded(`${warning}${label}\n${result.stdout.trim() || empty}${stderr}`, SCOUT_TOOL_MAX_BYTES);
}

async function gitEvidence(
  runner: ScoutGitRunner,
  params: Record<string, any>,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const root = await gitWorkspaceRoot(runner, cwd, signal);
  const path = params.path === undefined ? undefined : workspacePath(root, params.path);
  let args: string[];
  let label: string;
  let empty = "No matching Git evidence.";
  const details: Record<string, unknown> = { action: params.action };

  switch (params.action) {
    case "status":
      rejectUnsupported(params, ["path"]);
      args = ["status", "--porcelain=v2", "--branch", "--untracked-files=all", ...pathArgs(root, path)];
      label = "Git status evidence (porcelain v2; includes untracked paths and submodule state):";
      empty = "Clean working tree.";
      break;
    case "diff": {
      rejectUnsupported(params, ["path", "base", "target", "staged"]);
      if (params.staged && (params.base || params.target))
        throw new Error("staged diff does not accept base or target");
      if (params.target && !params.base) throw new Error("diff target requires base");
      const base = params.base ? await canonicalCommit(runner, root, params.base, signal) : undefined;
      const target = params.target ? await canonicalCommit(runner, root, params.target, signal) : undefined;
      args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
      if (params.staged) args.push("--cached");
      if (base) args.push(base);
      if (target) args.push(target);
      args.push(...pathArgs(root, path));
      const mode = params.staged
        ? "staged tracked changes versus HEAD"
        : target
          ? "two-endpoint commit diff"
          : base
            ? "commit versus current index/worktree"
            : "unstaged tracked changes";
      details.mode = mode;
      label = `Git diff evidence (${mode}; untracked files omitted):`;
      empty = "No matching tracked changes.";
      break;
    }
    case "log": {
      rejectUnsupported(params, ["path", "ref", "limit"]);
      const ref = await canonicalCommit(runner, root, params.ref ?? "HEAD", signal);
      const limit = params.limit ?? 20;
      args = [
        "log",
        "--no-color",
        "--no-decorate",
        "--date=iso-strict",
        "--format=%H%x09%ad%x09%an%x09%s",
        "--max-count",
        String(limit),
        ref,
        ...pathArgs(root, path),
      ];
      details.ref = ref;
      label = `Git log evidence from ${ref} (newest first, at most ${limit} commits):`;
      empty = "No commits found for the requested path.";
      break;
    }
    case "show": {
      rejectUnsupported(params, ["path", "ref"]);
      if (!params.ref) throw new Error("show requires ref");
      const ref = await canonicalCommit(runner, root, params.ref, signal);
      args = [
        "show",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--format=fuller",
        "--stat",
        "--patch",
        "--max-count=1",
        ref,
        ...pathArgs(root, path),
      ];
      details.ref = ref;
      label = `Git show evidence for ${ref} (merge commits may have no default patch):`;
      break;
    }
    case "blame": {
      rejectUnsupported(params, ["path", "ref", "startLine", "endLine"]);
      if (!path || path === ".") throw new Error("blame requires a file path");
      if (!params.startLine || !params.endLine || params.endLine < params.startLine)
        throw new Error("blame requires a positive inclusive startLine..endLine range");
      if (params.endLine - params.startLine + 1 > GIT_MAX_BLAME_LINES)
        throw new Error(`blame range cannot exceed ${GIT_MAX_BLAME_LINES} lines`);
      const ref = params.ref ? await canonicalCommit(runner, root, params.ref, signal) : undefined;
      args = ["blame", "--date=short", "-L", `${params.startLine},${params.endLine}`];
      if (ref) args.push(ref);
      args.push("--", path);
      if (ref) details.ref = ref;
      details.range = `${params.startLine}-${params.endLine}`;
      label = `Git blame evidence (${ref ? `commit ${ref}` : "current working tree"}, lines ${params.startLine}-${params.endLine}):`;
      break;
    }
    default:
      throw new Error("Unsupported Git evidence action");
  }

  const result = await checkedGit(runner, root, args, signal);
  details.truncated = result.termination === "output";
  details.receivedBytes = result.receivedBytes;
  return { text: gitEvidenceText(label, result, empty), details };
}

async function excerptSearch(
  pi: ExtensionAPI,
  pattern: string,
  path: string,
  glob: string | undefined,
  context: number,
  signal: AbortSignal | undefined,
  probe: ExecutableProbe,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const rgArgs = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--sort",
    "path",
    "--max-columns=500",
    "--max-columns-preview",
    "--max-count",
    String(MAX_MATCHES),
    "--context",
    String(context),
  ];
  if (glob) rgArgs.push("--glob", glob);
  rgArgs.push("--", pattern, path);
  const run = async (command: string, args: string[]) => {
    try {
      return await pi.exec(command, args, { signal, timeout: TIMEOUT_MS });
    } catch (error) {
      if (await probe(command, signal)) throw error;
      return undefined;
    }
  };
  const rgResult = await run("rg", rgArgs);
  if (rgResult?.code === 0)
    return { text: boundedSearch(rgResult.stdout) || "No matches found", details: { command: "rg", code: 0 } };
  if (rgResult?.code === 1 && (await probe("rg", signal)))
    return { text: "No matches found", details: { command: "rg", code: 1 } };
  if (rgResult && rgResult.code !== 1 && (await probe("rg", signal)))
    throw new Error(`ripgrep failed (${rgResult.code}): ${rgResult.stderr.trim()}`);

  const grepArgs = ["-r", "-n", "-H", "--color=never", "-m", String(MAX_MATCHES), "-C", String(context)];
  if (glob) grepArgs.push(`--include=${glob}`);
  grepArgs.push("--", pattern, path);
  const grepResult = await run("grep", grepArgs);
  if (grepResult?.code === 0)
    return {
      text: boundedSearch(grepResult.stdout) || "No matches found",
      details: { command: "grep", code: 0, fallback: true },
    };
  if (grepResult?.code === 1 && (await probe("grep", signal)))
    return { text: "No matches found", details: { command: "grep", code: 1, fallback: true } };
  if (!grepResult || !(await probe("grep", signal)))
    return { text: "ripgrep and grep unavailable; no excerpt search was run.", details: { unavailable: true } };
  throw new Error(`grep failed (${grepResult.code}): ${grepResult.stderr.trim()}`);
}

export default function scoutChildToolsExtension(
  pi: ExtensionAPI,
  probe: ExecutableProbe = executableAvailable,
  gitRunner: ScoutGitRunner = runBoundedGit,
) {
  const read = createReadToolDefinition(process.cwd());
  pi.registerTool({
    ...read,
    description: `Read workspace files with child-local output capped at ${formatSize(SCOUT_TOOL_MAX_BYTES)}. Use offset/limit for focused ranges.`,
    promptSnippet: "Read a focused workspace file range",
    promptGuidelines: [
      "Read the smallest range supported by existing evidence; use offset and limit instead of paging through files.",
    ],
    async execute(id, params, signal, update, ctx) {
      const result = await createReadToolDefinition(ctx.cwd).execute(id, params, signal, update, ctx);
      return {
        ...result,
        content: result.content.map(part =>
          part.type === "text" ? { ...part, text: bounded(part.text, SCOUT_TOOL_MAX_BYTES) } : part,
        ),
      };
    },
  });

  pi.registerTool({
    name: "search_excerpt",
    label: "Search excerpts",
    description: `Read-only text search returning deterministic line-numbered matching excerpts and context in one call. Output capped at ${formatSize(SCOUT_TOOL_MAX_BYTES)}; matching results beyond the cap are reported as omitted.`,
    promptSnippet: "Search text once and return bounded line-numbered matching excerpts with context",
    promptGuidelines: [
      "Use search_excerpt for citation-ready evidence. Give a workspace-relative path or glob when known; refine a truncated search rather than repeating it. It tries rg and then grep without running shell commands.",
    ],
    parameters: Type.Object(
      {
        pattern: Type.String({ minLength: 1, maxLength: 300, description: "Regular expression to search" }),
        path: Type.Optional(
          Type.String({ maxLength: 500, description: "Workspace-relative file or directory; default ." }),
        ),
        glob: Type.Optional(Type.String({ maxLength: 200, description: "Optional file glob, such as *.ts" })),
        context: Type.Optional(
          Type.Integer({ minimum: 0, maximum: 3, description: "Lines of context on each side; default 2" }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await excerptSearch(
        pi,
        params.pattern,
        workspacePath(ctx.cwd, params.path),
        params.glob,
        params.context ?? 2,
        signal,
        probe,
      );
      return { content: [{ type: "text" as const, text: result.text }], details: result.details };
    },
  });

  pi.registerTool({
    name: "git_evidence",
    label: "Git evidence",
    description: `Read-only, repository-contained Git evidence through fixed status, diff, log, show, and blame operations. Output is capped at ${formatSize(SCOUT_TOOL_MAX_BYTES)}; processes stop after ${formatSize(GIT_PROCESS_MAX_BYTES)} or ${TIMEOUT_MS / 1000}s. Diffs omit untracked files; blame requires at most ${GIT_MAX_BLAME_LINES} lines.`,
    promptSnippet: "Inspect bounded Git status, diffs, history, commits, or blame without arbitrary commands",
    promptGuidelines: [
      "Use git_evidence only when repository state or history is needed. Historical output is provenance, not a current path:line citation; reread current files for current-line claims.",
    ],
    parameters: Type.Object(
      {
        action: StringEnum(GIT_ACTIONS, { description: "Fixed read-only Git operation" }),
        path: Type.Optional(Type.String({ maxLength: 500, description: "Optional workspace-relative literal path" })),
        ref: Type.Optional(
          Type.String({ minLength: 1, maxLength: 200, description: "Commit-ish for log, show, or blame" }),
        ),
        base: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "Base commit-ish for diff" })),
        target: Type.Optional(
          Type.String({ minLength: 1, maxLength: 200, description: "Target commit-ish; requires base" }),
        ),
        staged: Type.Optional(Type.Boolean({ description: "For diff, inspect the index versus HEAD" })),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: GIT_MAX_COMMITS, description: "Maximum log commits; default 20" }),
        ),
        startLine: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 10_000_000, description: "First blame line, inclusive" }),
        ),
        endLine: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 10_000_000, description: "Last blame line, inclusive" }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _update, ctx) {
      const result = await gitEvidence(gitRunner, params, ctx.cwd, signal);
      return { content: [{ type: "text" as const, text: result.text }], details: result.details };
    },
  });
}
