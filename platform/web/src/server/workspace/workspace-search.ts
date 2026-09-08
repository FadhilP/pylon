import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { matchesGlob, relative, resolve, sep } from "node:path";
import { PROTOCOL_VERSION } from "../../shared/protocol/envelope.ts";
import type { WorkspaceFileReadModel } from "../../shared/protocol/snapshots.ts";
import type {
  WorkspaceSearchFile,
  WorkspaceSearchQuery,
  WorkspaceSearchResult,
} from "../../shared/workspace/workspace-search.ts";

const MAX_FILES = 100;
const MAX_LINES = 20;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const DEADLINE_MS = 30_000;

export interface WorkspaceSearchOptions {
  cwd: string;
  files: WorkspaceFileReadModel[];
  inventoryTruncated: boolean;
  generation: number;
  input: WorkspaceSearchQuery;
  signal: AbortSignal;
  onUpdate?: (result: WorkspaceSearchResult) => void | Promise<void>;
  /** Executable overrides for missing-tool and process-lifecycle checks. */
  executables?: { rg: string; grep: string };
  timeoutMs?: number;
}

function safePath(path: string): boolean {
  return (
    !!path &&
    path.length <= 500 &&
    !/[\0\\]/.test(path) &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every(part => part && part !== "." && part !== "..")
  );
}

async function containedRegular(root: string, path: string, signal: AbortSignal, deadline: number): Promise<boolean> {
  try {
    let candidate = root;
    for (const part of path.split("/")) {
      if (signal.aborted || Date.now() >= deadline) return false;
      candidate = resolve(candidate, part);
      if ((await lstat(candidate)).isSymbolicLink()) return false;
    }
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return false;
    const actual = await realpath(candidate);
    const inner = relative(root, actual);
    return (
      !!inner &&
      !inner.startsWith(`..${sep}`) &&
      inner !== ".." &&
      actual.startsWith(root.endsWith(sep) ? root : root + sep)
    );
  } catch {
    return false;
  }
}

function run(executable: string, args: string[], cwd: string, signal: AbortSignal, timeout: number) {
  return new Promise<{ stdout: string; limited: boolean; timedOut: boolean }>((accept, reject) => {
    execFile(
      executable,
      args,
      { cwd, encoding: "utf8", windowsHide: true, maxBuffer: MAX_OUTPUT, timeout, signal },
      (error, stdout, stderr) => {
        if (signal.aborted) return reject(signal.reason ?? new Error("Search cancelled"));
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        const limited = failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const timedOut = !!failure?.killed && !limited;
        if (failure && Number(failure.code) !== 1 && !limited && !timedOut) {
          if (failure.code === "ENOENT") return reject(failure);
          return reject(new Error(`Search failed: ${String(stderr || failure.message).slice(0, 1000)}`));
        }
        accept({ stdout: String(stdout), limited, timedOut });
      },
    );
  });
}

/** Current-file search over one bounded inventory. Neither backend recursively broadens the scope. */
export async function searchWorkspace(options: WorkspaceSearchOptions): Promise<WorkspaceSearchResult> {
  const { cwd, input, signal } = options;
  if (
    !input.query ||
    input.query.length > 2000 ||
    /[\0\r\n]/.test(input.query) ||
    (input.glob && (input.glob.length > 500 || /[\0\r\n]/.test(input.glob)))
  )
    throw new Error("Invalid workspace search query");
  signal.throwIfAborted();
  const started = Date.now();
  const deadline = started + Math.min(DEADLINE_MS, Math.max(1, options.timeoutMs ?? DEADLINE_MS));
  const root = await realpath(cwd);
  const patterns =
    input.glob
      ?.split(",")
      .map(pattern => pattern.trim())
      .filter(Boolean) ?? [];
  const files = options.files.filter(
    file =>
      !file.kind &&
      file.status !== "deleted" &&
      (!input.touched || file.status) &&
      (!patterns.length ||
        patterns.some(pattern =>
          matchesGlob(pattern.includes("/") ? file.path : file.path.split("/").at(-1)!, pattern),
        )),
  );
  const results: WorkspaceSearchFile[] = [];
  let engine: "rg" | "grep" = "rg";
  let skipped = 0,
    truncated = false,
    timedOut = false,
    outputBytes = 0;
  const snapshot = (): WorkspaceSearchResult => ({
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration: options.generation,
    engine,
    files: results.slice(),
    truncated,
    inventoryTruncated: options.inventoryTruncated,
    skipped,
    elapsedMs: Date.now() - started,
    timedOut,
  });
  const executables = options.executables ?? { rg: "rg", grep: "grep" };
  const args = (operands: string[]) => [
    ...(engine === "rg"
      ? ["--json", "--no-config", "--sort", "path", "--max-filesize", String(MAX_FILE_BYTES), "--max-count", "21"]
      : ["-n", "-I", "-m", "21"]),
    ...(input.regex ? (engine === "grep" ? ["-E"] : []) : ["-F"]),
    ...(input.caseSensitive ? [] : ["-i"]),
    ...(input.wholeWord ? ["-w"] : []),
    "--",
    input.query,
    ...operands,
  ];
  const add = (
    path: string,
    line: number,
    raw: string,
    ranges: { start: number; end: number }[],
    group: Map<string, WorkspaceSearchFile>,
  ) => {
    const record = group.get(path);
    if (!record || !Number.isSafeInteger(line) || line < 1) return;
    if (record.matches.length >= MAX_LINES) {
      record.capped = true;
      return;
    }
    const text = raw.replace(/\r?\n$/, "").slice(0, 4000);
    if (outputBytes + Buffer.byteLength(text) > MAX_OUTPUT) {
      truncated = true;
      return;
    }
    if (!record.matches.length) {
      if (results.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      results.push(record);
    }
    outputBytes += Buffer.byteLength(text);
    record.matches.push({
      line,
      text,
      ranges: ranges.filter(range => range.start >= 0 && range.end <= text.length).slice(0, 100),
    });
    if (raw.length > 4000) truncated = true;
  };
  for (let at = 0; at < files.length && !timedOut && !truncated;) {
    signal.throwIfAborted();
    const group = new Map<string, WorkspaceSearchFile>();
    let argumentSize = input.query.length;
    while (at < files.length && group.size < 32 && argumentSize < 12_000) {
      signal.throwIfAborted();
      if (Date.now() >= deadline) {
        timedOut = true;
        break;
      }
      // Validate a small lookahead concurrently, then consume in inventory order.
      const candidates: WorkspaceFileReadModel[] = [];
      let candidateSize = argumentSize;
      while (at < files.length && candidates.length < Math.min(8, 32 - group.size) && candidateSize < 12_000) {
        signal.throwIfAborted();
        const file = files[at++];
        if (!safePath(file.path)) { skipped++; continue; }
        candidates.push(file);
        candidateSize += file.path.length + 5;
      }
      const valid = await Promise.all(candidates.map(file => containedRegular(root, file.path, signal, deadline)));
      signal.throwIfAborted();
      if (Date.now() >= deadline) { timedOut = true; break; }
      for (const [index, file] of candidates.entries()) {
        if (!valid[index]) { skipped++; continue; }
        argumentSize += file.path.length + 5;
        group.set(file.path, { path: file.path, changed: !!file.status, matches: [], capped: false });
      }
    }
    if (!group.size || timedOut) continue;
    const operands = [...group.keys()].map(path => `./${path}`);
    const execute = async () => {
      if (engine === "rg") return run(executables.rg, args(operands), root, signal, Math.max(1, deadline - Date.now()));
      // One explicit operand avoids GNU-only filename delimiters and ambiguous ':' / newline names.
      const collected = { stdout: "", limited: false, timedOut: false };
      for (const operand of operands) {
        signal.throwIfAborted();
        if (Date.now() >= deadline) {
          collected.timedOut = true;
          break;
        }
        const part = await run(executables.grep, args([operand]), root, signal, Math.max(1, deadline - Date.now()));
        const lines = part.stdout.split("\n");
        if (part.limited || part.timedOut) lines.pop();
        for (const line of lines) if (line) collected.stdout += `${operand}\0${line}\n`;
        collected.limited ||= part.limited || Buffer.byteLength(collected.stdout) >= MAX_OUTPUT;
        collected.timedOut ||= part.timedOut;
        if (collected.limited || collected.timedOut) break;
      }
      return collected;
    };
    let output;
    try {
      output = await execute();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (engine !== "rg") throw new Error("Text search is unavailable: neither ripgrep nor grep is installed");
      engine = "grep";
      try {
        output = await execute();
      } catch (fallback) {
        if ((fallback as NodeJS.ErrnoException).code === "ENOENT")
          throw new Error("Text search is unavailable: neither ripgrep nor grep is installed");
        throw fallback;
      }
    }
    if (engine === "rg") {
      for (const json of output.stdout.split("\n")) {
        if (!json) continue;
        let row;
        try {
          row = JSON.parse(json);
        } catch {
          if (output.limited || output.timedOut) continue;
          throw new Error("Invalid ripgrep output");
        }
        if (row.type !== "match") continue;
        const data = row.data;
        // Byte-encoded (non-UTF8) source is not safe to display as a text preview.
        if (typeof data?.path?.text !== "string" || typeof data?.lines?.text !== "string") {
          skipped++;
          continue;
        }
        const bytes = Buffer.from(data.lines.text);
        const ranges = (data.submatches ?? [])
          .slice(0, 100)
          .map((match: { start: number; end: number }) => ({
            start: bytes.subarray(0, match.start).toString("utf8").length,
            end: bytes.subarray(0, match.end).toString("utf8").length,
          }));
        add(data.path.text.replace(/^\.\//, ""), data.line_number, data.lines.text, ranges, group);
      }
    } else {
      // The fallback adapter supplies an unambiguous filename separator.
      let cursor = 0;
      while (cursor < output.stdout.length) {
        const zero = output.stdout.indexOf("\0", cursor);
        if (zero < 0) break;
        const end = output.stdout.indexOf("\n", zero + 1);
        if (end < 0 && (output.limited || output.timedOut)) break;
        const path = output.stdout.slice(cursor, zero).replace(/^\.\//, "");
        const body = output.stdout.slice(zero + 1, end < 0 ? undefined : end);
        const match = /^(\d+):(.*)$/s.exec(body);
        if (match) add(path, Number(match[1]), match[2], [], group);
        cursor = end < 0 ? output.stdout.length : end + 1;
      }
    }
    truncated ||= output.limited;
    timedOut ||= output.timedOut || Date.now() >= deadline;
    await options.onUpdate?.(snapshot());
  }
  signal.throwIfAborted();
  return snapshot();
}
