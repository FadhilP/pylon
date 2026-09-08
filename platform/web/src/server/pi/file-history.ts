import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { applyPatch, parsePatch } from "diff";
import type {
  FileHistoryContent,
  FileHistoryContext,
  FileHistoryOwner,
  FileHistoryQuery,
  FileHistoryResult,
  FileHistoryStop,
  HistoryRepository,
  HistoryTree,
} from "pylon-core/src/file-history.ts";

const MAX_FILE = 1024 * 1024;
const MAX_LINES = 20_000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
const lines = (text: string) => (text ? text.replace(/\n$/, "").split("\n") : []);

export function validateHistoryPath(path: string): void {
  if (
    !path ||
    path.length > 500 ||
    /[\\\0\r\n]/.test(path) ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some(part => !part || part === "." || part === "..")
  )
    throw Error("Invalid history path");
}

/** One byte-budgeted cache for metadata, patches and attribution, not an unbounded cache per file. */
class HistoryCache {
  private values = new Map<string, { value: unknown; bytes: number }>();
  private bytes = 0;
  get<T>(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) return undefined;
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value as T;
  }
  set<T>(key: string, value: T): T {
    const bytes = Buffer.byteLength(JSON.stringify(value)) * 2;
    if (bytes > 24 * 1024 * 1024) return value;
    const previous = this.values.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.values.delete(key);
    }
    this.values.set(key, { value, bytes });
    this.bytes += bytes;
    while (this.bytes > 24 * 1024 * 1024 || this.values.size > 512) {
      const first = this.values.keys().next().value!;
      this.bytes -= this.values.get(first)!.bytes;
      this.values.delete(first);
    }
    return value;
  }
}

/** No shell, external diff, textconv, lazy fetch or inherited Git repository redirection. */
class HistoryGit {
  private deadline = Date.now() + 12_000;
  private remaining = 24 * 1024 * 1024;
  constructor(private signal: AbortSignal) {}
  async run(root: string, args: string[], input?: string, maxBytes = MAX_OUTPUT): Promise<Buffer> {
    this.signal.throwIfAborted();
    const timeout = this.deadline - Date.now();
    if (timeout <= 0 || this.remaining <= 0) throw Error("History work limit reached; select a shorter history");
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
    Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" });
    const output = await new Promise<Buffer>((accept, reject) => {
      const child = execFile(
        "git",
        ["--no-pager", "-c", "core.quotePath=false", ...args],
        {
          cwd: root,
          env,
          encoding: "buffer",
          timeout,
          maxBuffer: Math.min(maxBytes, this.remaining),
          windowsHide: true,
          signal: this.signal,
        },
        (error, stdout, stderr) => {
          // Failed/truncated commands consume the budget too; never retry 200 oversized patches for free.
          this.remaining -= stdout.length + stderr.length;
          if (error) reject(Error("Git history is unavailable or exceeded its read limit"));
          else accept(stdout);
        },
      );
      child.stdin?.on("error", () => {
        /* execFile reports child failure; EPIPE must not escape. */
      });
      child.stdin?.end(input);
    });
    return output;
  }
  async text(root: string, args: string[], input?: string, maxBytes?: number): Promise<string> {
    return (await this.run(root, args, input, maxBytes)).toString("utf8");
  }
}

interface Source {
  root: string;
  tree: string;
  path: string;
  blob?: string;
  size: number;
  state: FileHistoryContent["state"];
}
interface GitStop extends FileHistoryStop {
  sha: string;
  parent?: string;
  previousPath: string;
}
interface Owned {
  text: string;
  ids: (string | null)[];
  owners: FileHistoryOwner[];
  complete: boolean;
}
interface ReadInput {
  cwd: string;
  sessionId: string;
  baselineTree?: string;
  baselineCommit?: string;
  context?: FileHistoryContext;
  query: FileHistoryQuery;
}

/** Parse our NUL-framed log, not human-oriented Git output. Paths may contain tabs and spaces. */
export function parseHistoryLog(output: string, initialPath: string): GitStop[] {
  const fields = output.split("\0");
  const result: GitStop[] = [];
  let index = 0;
  let path = initialPath;
  while (index < fields.length) {
    while (fields[index] === "" || fields[index] === "\n") index++;
    if (index >= fields.length) break;
    const sha = fields[index++];
    if (!OID.test(sha)) throw Error("Invalid history log framing");
    const parents = fields[index++].split(" ").filter(Boolean);
    const createdAt = fields[index++];
    const author = fields[index++];
    const title = fields[index++];
    let previousPath = path;
    while (index < fields.length && fields[index] !== "") {
      const status = fields[index++].replace(/^\n/, "");
      if (!status) continue;
      if (!/^[ACDMRTUXB][0-9]*$/.test(status)) throw Error("Invalid history status");
      const oldPath = fields[index++];
      if (status[0] === "R" || status[0] === "C") {
        const newPath = fields[index++];
        if (status[0] === "R" && newPath === path) previousPath = oldPath;
      }
    }
    validateHistoryPath(path);
    validateHistoryPath(previousPath);
    if (parents.some(parent => !OID.test(parent))) throw Error("Invalid history parent");
    result.push({
      id: `git:${sha}`,
      kind: "commit",
      sha,
      parent: parents[0],
      title: title.slice(0, 300),
      author: author.slice(0, 200),
      createdAt,
      path,
      previousPath,
    });
    path = previousPath;
  }
  return result;
}

/** Only unchanged lines inherit ownership. Git decides ambiguous repeated-line matches. */
export function carryHistoryOwners(
  before: Owned,
  after: string,
  patch: string,
  owner: string | null,
): (string | null)[] {
  const oldLines = lines(before.text);
  const newLines = lines(after);
  if (before.ids.length !== oldLines.length) throw Error("Invalid attribution source");
  if (before.text === after) return before.ids;
  const parsed = parsePatch(patch);
  if (parsed.length !== 1 || applyPatch(before.text, parsed[0], { autoConvertLineEndings: false }) !== after)
    throw Error("History patch does not match its snapshots");
  const output: (string | null)[] = [];
  let oldIndex = 0;
  for (const hunk of parsed[0].hunks) {
    // parsePatch normalizes Git's zero-length ranges to the next one-based source line.
    const start = hunk.oldStart - 1;
    if (start < oldIndex || start > oldLines.length) throw Error("Invalid history hunk");
    output.push(...before.ids.slice(oldIndex, start));
    oldIndex = start;
    for (const line of hunk.lines) {
      if (line[0] === " ") output.push(before.ids[oldIndex++]);
      else if (line[0] === "-") oldIndex++;
      else if (line[0] === "+") output.push(owner);
    }
  }
  output.push(...before.ids.slice(oldIndex));
  if (output.length !== newLines.length || oldIndex > oldLines.length) throw Error("Invalid history line counts");
  return output;
}

export class FileHistoryReader {
  private cache = new HistoryCache();
  private inFlight = new Map<
    string,
    { promise: Promise<FileHistoryResult>; users: number; controller: AbortController }
  >();

  async read(input: ReadInput, signal?: AbortSignal): Promise<FileHistoryResult> {
    signal?.throwIfAborted();
    validateHistoryPath(input.query.path);
    if (
      !["session", "all"].includes(input.query.scope) ||
      !["file", "diff", "change"].includes(input.query.view ?? "file") ||
      !Number.isInteger(input.query.limit ?? 40) ||
      (input.query.limit ?? 40) < 1 ||
      (input.query.limit ?? 40) > 200
    )
      throw Error("Invalid history query");
    this.validateContext(input);
    const key = digest(input);
    let entry = this.inFlight.get(key);
    if (!entry) {
      if (this.inFlight.size >= 2) throw Error("History is busy; try again");
      const controller = new AbortController();
      const promise = this.load(input, controller.signal);
      entry = { promise, users: 0, controller };
      this.inFlight.set(key, entry);
      void promise.then(
        () => this.inFlight.delete(key),
        () => this.inFlight.delete(key),
      );
    }
    if (entry.users >= 32 || entry.controller.signal.aborted) throw Error("History is busy; try again");
    entry.users++;
    let abort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal?.reason ?? Error("History request cancelled"));
      signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      return await (signal ? Promise.race([entry.promise, cancelled]) : entry.promise);
    } finally {
      signal?.removeEventListener("abort", abort);
      if (--entry.users === 0) {
        entry.controller.abort();
        await entry.promise.catch(() => {}); // Reap the last consumer's Git process before releasing the request.
      }
    }
  }

  private validateContext(input: ReadInput): void {
    for (const id of [input.baselineTree, input.baselineCommit])
      if (id && !OID.test(id)) throw Error("Invalid baseline");
    const context = input.context;
    if (!context) return;
    if (
      context.sessionId !== input.sessionId ||
      !Array.isArray(context.checkpoints) ||
      context.checkpoints.length > 200
    )
      throw Error("Invalid history owner or window");
    const validateTree = (snapshot: HistoryTree) => {
      if (snapshot.path !== "" || (snapshot.repositories?.length ?? 0) > 100) throw Error("Invalid history repository");
      for (const repository of [snapshot, ...(snapshot.repositories ?? [])]) {
        if (!OID.test(repository.tree) || !OID.test(repository.head)) throw Error("Invalid history object");
        if (repository.path) validateHistoryPath(repository.path);
        if (
          repository.commonDir !== undefined &&
          (typeof repository.commonDir !== "string" || !isAbsolute(repository.commonDir))
        )
          throw Error("Invalid history repository identity");
      }
    };
    const ids = new Set<string>();
    for (const checkpoint of context.checkpoints) {
      if (
        !/^[A-Za-z0-9._:-]{1,128}$/.test(checkpoint.id) ||
        checkpoint.id === "baseline" ||
        checkpoint.id.startsWith("git:") ||
        ids.has(checkpoint.id) ||
        typeof checkpoint.title !== "string" ||
        checkpoint.title.length > 300 ||
        typeof checkpoint.createdAt !== "string" ||
        checkpoint.createdAt.length > 64 ||
        !["passed", "failed", "unverified"].includes(checkpoint.verification)
      )
        throw Error("Invalid history checkpoint");
      ids.add(checkpoint.id);
      validateTree(checkpoint.snapshot);
    }
    if (context.baseline) validateTree(context.baseline);
    if (context.seed) validateTree(context.seed);
  }

  private async load(input: ReadInput, signal: AbortSignal): Promise<FileHistoryResult> {
    const git = new HistoryGit(signal);
    const root = (await git.text(input.cwd, ["rev-parse", "--show-toplevel"], undefined, 4096)).trim();
    const physicalRoot = await realpath(root);
    const requestedPath = input.query.path;
    const context = input.context;
    // Route ordinary Git files through their deepest current repository, including initialized submodules.
    let directory = dirname(resolve(root, requestedPath));
    while (directory !== dirname(directory) && !(await stat(directory).catch(() => undefined))?.isDirectory())
      directory = dirname(directory);
    const physicalDirectory = await realpath(directory);
    if (this.outside(physicalRoot, physicalDirectory)) throw Error("History path escapes the workspace");
    const fileRoot = (await git.text(physicalDirectory, ["rev-parse", "--show-toplevel"], undefined, 4096)).trim();
    if (this.outside(physicalRoot, await realpath(fileRoot))) throw Error("History repository escapes the workspace");
    const prefix = relative(root, fileRoot).replaceAll("\\", "/");
    const innerPath = prefix ? requestedPath.slice(prefix.length + 1) : requestedPath;
    validateHistoryPath(innerPath);
    const head = (await git.text(fileRoot, ["rev-parse", "HEAD"], undefined, 256)).trim();
    if (!OID.test(head)) throw Error("Git history has no committed anchor");
    const commonDir = (
      await git.text(fileRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], undefined, 4096)
    ).trim();
    const repository = (snapshot?: HistoryTree): HistoryRepository | undefined => {
      if (!snapshot) return undefined;
      const owner = [...(snapshot.repositories ?? []), snapshot]
        .filter(item => !item.path || requestedPath.startsWith(`${item.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0];
      if (!owner || owner.path !== prefix || (owner.commonDir && canonical(owner.commonDir) !== canonical(commonDir)))
        return undefined;
      return owner;
    };
    const baseline = repository(context?.baseline);
    const baselineTree = baseline?.tree ?? (!prefix ? input.baselineTree : undefined);
    const unknownBaseline = !baselineTree && Boolean(context?.checkpoints.length);
    let anchor = baseline?.head ?? repository(context?.checkpoints[0]?.snapshot)?.head ?? head;
    if (!prefix && input.baselineCommit) {
      const raw = await git.text(fileRoot, ["cat-file", "-p", input.baselineCommit], undefined, 8192);
      const tree = /^tree ([a-f0-9]+)$/m.exec(raw)?.[1];
      const parents = [...raw.matchAll(/^parent ([a-f0-9]+)$/gm)].map(match => match[1]);
      if (tree !== input.baselineTree || parents.length > 1) throw Error("Invalid registered history baseline");
      anchor = parents[0] ?? "";
    }
    const key = digest([
      canonical(fileRoot),
      commonDir,
      head,
      input.sessionId,
      context,
      baselineTree,
      anchor,
      input.query,
    ]);
    const cached = this.cache.get<FileHistoryResult>(`result:${key}`);
    if (cached) return cached;
    const descriptor = (tree: string, path = innerPath): Source => ({
      root: fileRoot,
      tree,
      path,
      size: 0,
      state: "unavailable",
    });
    const baseSource = baselineTree ? descriptor(baselineTree) : anchor ? descriptor(anchor) : undefined;
    // Legacy checkpoints lack a session-start tree. Their first saved state is an unknown-owner seed,
    // not evidence that the first turn introduced every difference from HEAD.
    const seedRepository = repository(
      context?.seed ?? (unknownBaseline ? context?.checkpoints[0]?.snapshot : undefined),
    );
    const seed = seedRepository ? descriptor(seedRepository.tree) : baseSource;
    const checkpoints = (context?.checkpoints ?? []).map(checkpoint => ({
      checkpoint,
      source: repository(checkpoint.snapshot) ? descriptor(repository(checkpoint.snapshot)!.tree) : undefined,
    }));
    const sources = [baseSource, seed, ...checkpoints.map(item => item.source)].filter(
      (item): item is Source => !!item,
    );
    await this.resolveSources(git, sources);
    let previous = unknownBaseline && !context?.seed ? undefined : seed;
    const stops: FileHistoryStop[] = [];
    for (const { checkpoint, source } of checkpoints) {
      if (!source || !previous || source.state !== previous.state || source.blob !== previous.blob)
        stops.push({
          id: checkpoint.id,
          kind: "checkpoint",
          title: checkpoint.title,
          createdAt: checkpoint.createdAt,
          verification: checkpoint.verification,
          path: requestedPath,
        });
      previous = source;
    }
    let commits: GitStop[] = [];
    let hasMore = false;
    if (input.query.scope === "all" && anchor) {
      const limit = input.query.limit ?? 40;
      const logKey = `log:${digest([fileRoot, anchor, innerPath, limit])}`;
      const cachedLog = this.cache.get<GitStop[]>(logKey);
      commits =
        cachedLog ??
        this.cache.set(
          logKey,
          parseHistoryLog(
            await git.text(fileRoot, [
              "--literal-pathspecs",
              "log",
              "--no-ext-diff",
              "--no-textconv",
              "--first-parent",
              "--follow",
              "--diff-merges=first-parent",
              "--find-renames",
              `--max-count=${limit + 1}`,
              "--format=%x00%H%x00%P%x00%aI%x00%an%x00%s",
              "--name-status",
              "-z",
              anchor,
              "--",
              innerPath,
            ]),
            innerPath,
          ),
        );
      hasMore = commits.length > limit;
      commits = commits.slice(0, limit);
    }
    const result: FileHistoryResult = {
      path: requestedPath,
      revision: key,
      stops: [...commits]
        .reverse()
        .map(({ sha, parent, previousPath, ...stop }) => ({
          ...stop,
          path: prefix ? `${prefix}/${stop.path}` : stop.path,
        }))
        .concat(stops),
      sessionAvailable: !!context?.baseline || !!context?.checkpoints.length,
      baselineAvailable: !!baseSource,
      baselineLabel: baselineTree ? "Session baseline" : "HEAD",
      partial:
        unknownBaseline ||
        context?.partial === true ||
        hasMore ||
        sources.some(source => source.state === "unavailable"),
      hasMore: hasMore && (input.query.limit ?? 40) < 200,
      notice:
        "Git history follows first parents and committed renames, anchored before the session baseline (or at HEAD without a baseline). Session history follows this conversation branch and path; live edits are not attributed. Session renames start a new path history.",
    };
    if (input.query.selected) {
      if (input.query.selected !== "baseline" && !result.stops.some(stop => stop.id === input.query.selected))
        throw Error("Selected history version is unavailable on this branch");
      result.selected = input.query.selected;
      result.view = input.query.view ?? "file";
      const historyInput = unknownBaseline && context ? { ...input, context: { ...context, partial: true } } : input;
      result.content = await this.content(git, historyInput, baseSource, seed, checkpoints, commits, anchor);
    }
    return sources.some(source => source.state === "unavailable") ||
      (result.content && !result.content.attributionComplete)
      ? result
      : this.cache.set(`result:${key}`, result);
  }

  private outside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel);
  }

  private async resolveSources(git: HistoryGit, sources: Source[]): Promise<void> {
    if (!sources.length) return;
    // All descriptors are confined to one validated owning repository. Batch metadata, including tree existence.
    const missing = sources.filter(source => {
      const cached = this.cache.get<Pick<Source, "blob" | "state" | "size">>(
        `object:${digest([source.root, source.tree, source.path])}`,
      );
      if (cached) Object.assign(source, cached);
      return !cached;
    });
    if (!missing.length) return;
    const specs = missing.flatMap(source => [source.tree, `${source.tree}:${source.path}`]);
    const output = await git.text(
      missing[0].root,
      ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
      `${specs.join("\n")}\n`,
      512 * 1024,
    );
    const rows = output.trimEnd().split("\n");
    if (rows.length !== specs.length) throw Error("Incomplete history objects");
    for (const [index, source] of missing.entries()) {
      const tree = rows[index * 2].split(" ");
      const parts = rows[index * 2 + 1].split(" ");
      let value: Pick<Source, "blob" | "state" | "size"> = { state: "unavailable", size: 0 };
      if (OID.test(tree[0]) && ["tree", "commit"].includes(tree[1])) {
        if (rows[index * 2 + 1] === `${source.tree}:${source.path} missing`) value = { state: "deleted", size: 0 };
        else if (OID.test(parts[0]) && parts[1] === "blob" && /^\d+$/.test(parts[2])) {
          const size = Number(parts[2]);
          value = { blob: parts[0], size, state: size > MAX_FILE ? "oversized" : "available" };
        }
      }
      Object.assign(source, value);
      // Missing objects may be recovered later; don't cache failures as deletions.
      if (value.state !== "unavailable")
        this.cache.set(`object:${digest([source.root, source.tree, source.path])}`, value);
    }
  }

  private async text(git: HistoryGit, source?: Source): Promise<string | undefined> {
    if (!source || source.state === "unavailable" || source.state === "oversized" || source.state === "binary")
      return undefined;
    if (source.state === "deleted") return "";
    const cached = this.cache.get<string>(`blob:${source.root}:${source.blob}`);
    if (cached !== undefined) return cached;
    const buffer = await git.run(source.root, ["cat-file", "blob", source.blob!], undefined, MAX_FILE + 1);
    return this.rememberText(source, buffer);
  }

  private rememberText(source: Source, buffer: Buffer): string | undefined {
    if (buffer.includes(0)) {
      source.state = "binary";
      return undefined;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      source.state = "binary";
      return undefined;
    }
    if (lines(text).length > MAX_LINES) {
      source.state = "oversized";
      return undefined;
    }
    return this.cache.set(`blob:${source.root}:${source.blob}`, text);
  }

  private async primeTexts(git: HistoryGit, sources: (Source | undefined)[]): Promise<void> {
    const unique = new Map<string, Source>();
    for (const source of sources)
      if (
        source?.state === "available" &&
        source.blob &&
        this.cache.get<string>(`blob:${source.root}:${source.blob}`) === undefined
      )
        unique.set(source.blob, source);
    const wanted = [...unique.values()];
    // Avoid multiplying process startup costs by the number of checkpoints. Large histories fall back
    // to incremental reads under the same aggregate deadline/output budget.
    if (!wanted.length || wanted.reduce((sum, source) => sum + source.size, 0) > 4 * MAX_FILE) return;
    const output = await git.run(
      wanted[0].root,
      ["cat-file", "--batch"],
      `${wanted.map(source => source.blob).join("\n")}\n`,
      4 * MAX_FILE + 64 * 1024,
    );
    let offset = 0;
    for (const source of wanted) {
      const end = output.indexOf(10, offset);
      if (end < 0 || output.subarray(offset, end).toString() !== `${source.blob} blob ${source.size}`)
        throw Error("Incomplete history blob batch");
      offset = end + 1;
      if (output[offset + source.size] !== 10) throw Error("Truncated history blob");
      this.rememberText(source, output.subarray(offset, offset + source.size));
      offset += source.size + 1;
    }
    if (offset !== output.length) throw Error("Unexpected history blob output");
  }

  private async patch(git: HistoryGit, before: Source, after: Source): Promise<string> {
    if ([before, after].some(source => source.state !== "available" && source.state !== "deleted"))
      throw Error("Cannot compare an unavailable history version");
    if (
      before.path === after.path &&
      before.state === after.state &&
      before.blob === after.blob &&
      before.state !== "unavailable"
    )
      return "";
    const key = `patch:${digest([before.root, before.blob ?? before.state, before.path, after.blob ?? after.state, after.path])}`;
    const cached = this.cache.get<string>(key);
    if (cached !== undefined) return cached;
    const quote = (path: string) => (/[\s"\\]/.test(path) ? JSON.stringify(path) : path);
    const header = `diff --git ${quote(`a/${before.path}`)} ${quote(`b/${after.path}`)}`;
    if (before.blob && before.blob === after.blob)
      return `${header}\nsimilarity index 100%\nrename from ${quote(before.path)}\nrename to ${quote(after.path)}\n`;
    let args: string[];
    if (before.blob && after.blob) args = [before.blob, after.blob];
    else {
      const emptyKey = `empty-tree:${after.root}`;
      const empty =
        this.cache.get<string>(emptyKey) ??
        this.cache.set(
          emptyKey,
          (await git.text(after.root, ["hash-object", "-t", "tree", "--stdin"], "", 256)).trim(),
        );
      args = [
        before.blob ? before.tree : empty,
        after.blob ? after.tree : empty,
        "--",
        before.blob ? before.path : after.path,
      ];
    }
    // Compare blobs, not a pair of pathspecs: an old name may have been reused for another file.
    const output = await git.text(
      after.root,
      [
        "--literal-pathspecs",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--diff-algorithm=myers",
        "--no-indent-heuristic",
        "--unified=3",
        "--no-renames",
        ...args,
      ],
      undefined,
      2 * MAX_FILE + 64 * 1024,
    );
    return this.cache.set(
      key,
      output
        .replace(/^diff --git .*$/m, header)
        .replace(/^--- (?!\/dev\/null).*$/m, `--- ${quote(`a/${before.path}`)}`)
        .replace(/^\+\+\+ (?!\/dev\/null).*$/m, `+++ ${quote(`b/${after.path}`)}`),
    );
  }

  private async blame(git: HistoryGit, source: Source, sha: string): Promise<Owned> {
    const text = await this.text(git, source);
    if (text === undefined) return { text: "", ids: [], owners: [], complete: false };
    const key = `blame:${digest([source.root, sha, source.path, source.blob])}`;
    const cached = this.cache.get<Owned>(key);
    if (cached) return cached;
    if (!text) return { text, ids: [], owners: [], complete: true };
    const output = await git.text(source.root, [
      "--literal-pathspecs",
      "blame",
      "--no-textconv",
      "--first-parent",
      "--line-porcelain",
      sha,
      "--",
      source.path,
    ]);
    const ids: (string | null)[] = [];
    const sourceLines = lines(text);
    const owners = new Map<string, FileHistoryOwner>();
    let id = "",
      author = "",
      title = "";
    for (const line of output.split("\n")) {
      const header = /^([a-f0-9]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(line);
      if (header) {
        if (!OID.test(header[1]) || Number(header[2]) !== ids.length + 1) throw Error("Invalid blame coordinates");
        id = `git:${header[1]}`;
        author = "";
        title = "";
      } else if (line.startsWith("author ")) author = line.slice(7, 207);
      else if (line.startsWith("summary ")) title = line.slice(8, 308);
      else if (line.startsWith("\t")) {
        if (!id || line.slice(1) !== sourceLines[ids.length]) throw Error("Invalid blame response");
        ids.push(id);
        owners.set(id, { id, kind: "commit", author, title });
      }
    }
    if (ids.length !== sourceLines.length) throw Error("Incomplete blame response");
    return this.cache.set(key, { text, ids, owners: [...owners.values()], complete: true });
  }

  private async content(
    git: HistoryGit,
    input: ReadInput,
    baseline: Source | undefined,
    seed: Source | undefined,
    checkpoints: { checkpoint: NonNullable<ReadInput["context"]>["checkpoints"][number]; source?: Source }[],
    commits: GitStop[],
    anchor: string,
  ): Promise<FileHistoryContent> {
    const unknown = async (source?: Source): Promise<Owned> => {
      const text = (await this.text(git, source)) ?? "";
      return { text, ids: lines(text).map(() => null), owners: [], complete: false };
    };
    const selected = input.query.selected!;
    const view = input.query.view ?? "file";
    const commit = commits.find(item => item.id === selected);
    let before: Source | undefined;
    let after: Source | undefined;
    let oldOwned: Owned | undefined;
    let newOwned: Owned | undefined;
    if (commit) {
      const root = baseline?.root ?? seed?.root;
      if (!root) throw Error("History baseline is unavailable");
      after = { root, tree: commit.sha, path: commit.path, state: "unavailable", size: 0 };
      // Git Diff describes this commit's change, never changes made after it up to the session baseline.
      const parent = commit.parent ?? (await git.text(root, ["hash-object", "-t", "tree", "--stdin"], "", 256)).trim();
      before = { root, tree: parent, path: commit.previousPath, state: "unavailable", size: 0 };
      await this.resolveSources(
        git,
        [before, after].filter((item): item is Source => !!item),
      );
      if (view !== "file") {
        try {
          oldOwned = await this.blame(git, before, commit.parent ?? "");
        } catch {
          oldOwned = await unknown(before);
        }
      }
      try {
        newOwned = await this.blame(git, after, commit.sha);
      } catch {
        newOwned = await unknown(after);
      }
    } else {
      after = selected === "baseline" ? baseline : checkpoints.find(item => item.checkpoint.id === selected)?.source;
      before = baseline;
    }
    if (!after) return { state: "unavailable", owners: [], attributionComplete: false };
    if (!commit) {
      const index = checkpoints.findIndex(item => item.checkpoint.id === selected);
      await this.primeTexts(git, [baseline, seed, ...checkpoints.slice(0, index + 1).map(item => item.source)]);
    }
    const afterText = await this.text(git, after);
    if (afterText === undefined) return { state: after.state, owners: [], attributionComplete: false };

    const baselineOwners = async (): Promise<Owned> => {
      if (!baseline) return unknown();
      const key = `base-owners:${digest([baseline.root, baseline.tree, baseline.path, anchor, input.query.scope])}`;
      const cached = this.cache.get<Owned>(key);
      if (cached) return cached;
      const value = await unknown(baseline);
      if (input.query.scope === "all" && anchor) {
        try {
          const parent: Source = { ...baseline, tree: anchor, blob: undefined, state: "unavailable" };
          await this.resolveSources(git, [parent]);
          const owned = await this.blame(git, parent, anchor);
          value.ids = carryHistoryOwners(owned, value.text, await this.patch(git, parent, baseline), null);
          value.owners = owned.owners;
          value.complete = owned.complete;
        } catch {
          value.complete = false;
        }
      } else value.complete = true; // Baseline lines intentionally have no session owner.
      return value.complete ? this.cache.set(key, value) : value;
    };
    if (!newOwned) {
      if (selected === "baseline") newOwned = await baselineOwners();
      else if (commit) newOwned = await unknown(after);
      else {
        let previousSource = seed;
        let owned = input.context?.partial ? await unknown(seed) : await baselineOwners();
        let chain = digest([input.sessionId, seed, input.query.scope, anchor, input.context?.partial]);
        for (const item of checkpoints) {
          chain = digest([chain, item.checkpoint.id, item.source]);
          const cached = this.cache.get<Owned>(`owners:${chain}`);
          if (item.checkpoint.id === selected && view === "change") {
            before = previousSource;
            oldOwned = owned;
          }
          if (cached) owned = cached;
          else if (!(
            previousSource &&
            item.source &&
            previousSource.blob === item.source.blob &&
            previousSource.state === item.source.state &&
            ["available", "deleted"].includes(item.source.state)
          )) {
            const text = await this.text(git, item.source);
            const owner: FileHistoryOwner = {
              id: item.checkpoint.id,
              title: item.checkpoint.title,
              kind: "checkpoint",
            };
            try {
              if (!previousSource || !item.source || text === undefined) throw Error("History gap");
              const ids = carryHistoryOwners(owned, text, await this.patch(git, previousSource, item.source), owner.id);
              const present = new Set(ids.filter((id): id is string => id !== null));
              owned = {
                text,
                ids,
                owners: [...owned.owners, owner].filter(value => present.has(value.id)),
                complete: owned.complete,
              };
              this.cache.set(`owners:${chain}`, owned);
            } catch {
              owned = await unknown(item.source);
            }
          }
          previousSource = item.source;
          if (item.checkpoint.id === selected) break;
        }
        newOwned = owned;
      }
    }
    if (view === "file")
      return {
        state: after.state,
        text: afterText,
        newOwners: newOwned.ids,
        owners: newOwned.owners,
        attributionComplete: newOwned.complete,
      };
    if (!before) return { state: "unavailable", owners: [], attributionComplete: false };
    const beforeText = await this.text(git, before);
    if (beforeText === undefined) return { state: before.state, owners: [], attributionComplete: false };
    oldOwned ??= await baselineOwners();
    const patch = await this.patch(git, before, after);
    return {
      state: "available",
      text: patch,
      before: beforeText,
      after: afterText,
      oldOwners: oldOwned.ids,
      newOwners: newOwned.ids,
      owners: [...new Map([...oldOwned.owners, ...newOwned.owners].map(owner => [owner.id, owner])).values()],
      attributionComplete: oldOwned.complete && newOwned.complete,
    };
  }
}
