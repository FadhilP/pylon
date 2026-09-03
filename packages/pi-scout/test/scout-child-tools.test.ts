import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import registerScoutChildTools, {
  boundedSearch,
  SCOUT_TOOL_MAX_BYTES,
  workspacePath,
} from "../src/scout-child-tools.ts";

const execFileAsync = promisify(execFile);
const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

async function gitAt(root: string, ...args: string[]) {
  return execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "pi-scout-git-"));
  await gitAt(root, "init", "--quiet");
  await gitAt(root, "config", "user.name", "Scout Test");
  await gitAt(root, "config", "user.email", "scout@example.invalid");
  await writeFile(join(root, ".gitattributes"), "tracked.txt diff=scout-sentinel\n");
  await writeFile(join(root, "tracked.txt"), "first\nsecond\nthird\n");
  await gitAt(root, "add", ".");
  await gitAt(root, "commit", "--quiet", "-m", "initial evidence");
  await writeFile(join(root, "tracked.txt"), "first\nsecond revision\nthird\n");
  await gitAt(root, "add", "tracked.txt");
  await gitAt(root, "commit", "--quiet", "-m", "revise second line");
  return root;
}


test("search paths cannot escape workspace", () => {
  assert.equal(workspacePath("/workspace", "src"), "src");
  assert.throws(() => workspacePath("/workspace", "../secret"), /within workspace/);
});

test("read override applies the child-local cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-scout-read-"));
  const tools = new Map<string, any>();
  registerScoutChildTools({
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
  } as any);
  try {
    await writeFile(join(root, "large.txt"), "x".repeat(SCOUT_TOOL_MAX_BYTES * 2));
    const result = await tools.get("read").execute("id", { path: "large.txt" }, undefined, undefined, { cwd: root });
    const text = result.content.find((part: any) => part.type === "text")?.text ?? "";
    assert.ok(Buffer.byteLength(text) <= SCOUT_TOOL_MAX_BYTES);
    assert.match(text, /omitted output/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search_excerpt returns bounded cited context, contains paths, and falls back safely", async () => {
  const tools = new Map<string, any>();
  const calls: Array<{ command: string; args: string[] }> = [];
  registerScoutChildTools(
    {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      async exec(command: string, args: string[]) {
        calls.push({ command, args });
        if (command === "rg") return { stdout: "", stderr: "", code: 1, killed: false };
        return {
          stdout: "src/a.ts-9-before\nsrc/a.ts:10:needle\nsrc/a.ts-11-after\n",
          stderr: "",
          code: 0,
          killed: false,
        };
      },
    } as any,
    async command => command === "grep",
  );
  const result = await tools
    .get("search_excerpt")
    .execute("id", { pattern: "needle", path: "src", glob: "*.ts", context: 1 }, undefined, undefined, {
      cwd: process.cwd(),
    });
  assert.deepEqual(
    calls.map(call => call.command),
    ["rg", "grep"],
  );
  assert.ok(calls[0].args.includes("--sort"));
  assert.ok(calls[0].args.includes("path"));
  assert.ok(calls[1].args.includes("--include=*.ts"));
  assert.match(result.content[0].text, /src\/a\.ts:10:needle/);
  assert.equal(result.details.command, "grep");
  await assert.rejects(
    tools
      .get("search_excerpt")
      .execute("id", { pattern: "x", path: "../secret" }, undefined, undefined, { cwd: process.cwd() }),
    /within workspace/,
  );
});

test("search_excerpt does not treat an invalid path as a missing ripgrep executable", async () => {
  const tools = new Map<string, any>();
  const calls: string[] = [];
  registerScoutChildTools(
    {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
      async exec(command: string) {
        calls.push(command);
        return { stdout: "", stderr: "The system cannot find the path specified", code: 2, killed: false };
      },
    } as any,
    async () => true,
  );
  await assert.rejects(
    tools
      .get("search_excerpt")
      .execute("id", { pattern: "needle", path: "missing" }, undefined, undefined, { cwd: process.cwd() }),
    /ripgrep failed.*cannot find the path/i,
  );
  assert.deepEqual(calls, ["rg"]);
});

test("bounded search samples citations across files instead of keeping only the head", () => {
  const output = Array.from(
    { length: 80 },
    (_, index) => `src/file-${String(index).padStart(2, "0")}.ts:1:needle ${"x".repeat(500)}`,
  ).join("\n");
  const result = boundedSearch(output);
  assert.ok(Buffer.byteLength(result) <= SCOUT_TOOL_MAX_BYTES);
  assert.match(result, /src\/file-00\.ts:1:/);
  assert.match(result, /src\/file-79\.ts:1:/);
  assert.match(result, /sampled across 80 files/i);
});

test("bounded search keeps context blocks intact while sampling", () => {
  const output = Array.from({ length: 30 }, (_, index) =>
    [
      `src/file-${String(index).padStart(2, "0")}.ts-9-before`,
      `src/file-${String(index).padStart(2, "0")}.ts:10:needle`,
      `src/file-${String(index).padStart(2, "0")}.ts-11-after ${"x".repeat(900)}`,
    ].join("\n"),
  ).join("\n--\n");
  const result = boundedSearch(output);
  assert.match(result, /src\/file-29\.ts-9-before\nsrc\/file-29\.ts:10:needle\nsrc\/file-29\.ts-11-after/);
});

test("search_excerpt output is capped and reports omitted results", async () => {
  const tools = new Map<string, any>();
  registerScoutChildTools({
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    async exec() {
      return { stdout: "a.ts:1:" + "x".repeat(SCOUT_TOOL_MAX_BYTES * 2), stderr: "", code: 0, killed: false };
    },
  } as any);
  const result = await tools
    .get("search_excerpt")
    .execute("id", { pattern: "x" }, undefined, undefined, { cwd: process.cwd() });
  assert.ok(Buffer.byteLength(result.content[0].text) <= SCOUT_TOOL_MAX_BYTES);
  assert.match(result.content[0].text, /matching excerpts omitted/i);
});


test("git_evidence distinguishes repository state and returns bounded history and blame", { skip: !hasGit }, async () => {
  const root = await repository();
  const tools = new Map<string, any>();
  registerScoutChildTools({
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
  } as any);
  const evidence = tools.get("git_evidence");
  const execute = (params: Record<string, unknown>) =>
    evidence.execute("id", params, undefined, undefined, { cwd: root });
  try {
    await writeFile(join(root, "staged.txt"), "staged evidence\n");
    await gitAt(root, "add", "staged.txt");
    await writeFile(join(root, "tracked.txt"), "first\nsecond revision\nthird\nworking evidence\n");
    await writeFile(join(root, "untracked.txt"), "untracked evidence\n");

    const status = await execute({ action: "status" });
    assert.match(status.content[0].text, /staged\.txt/);
    assert.match(status.content[0].text, /tracked\.txt/);
    assert.match(status.content[0].text, /untracked\.txt/);

    const unstaged = await execute({ action: "diff", path: "tracked.txt" });
    assert.match(unstaged.content[0].text, /working evidence/);
    assert.doesNotMatch(unstaged.content[0].text, /staged evidence/);
    assert.equal(unstaged.details.mode, "unstaged tracked changes");

    const staged = await execute({ action: "diff", staged: true });
    assert.match(staged.content[0].text, /staged evidence/);
    assert.doesNotMatch(staged.content[0].text, /working evidence/);

    const log = await execute({ action: "log", path: "tracked.txt", limit: 2 });
    assert.match(log.content[0].text, /revise second line/);
    assert.match(log.content[0].text, /initial evidence/);

    const shown = await execute({ action: "show", ref: "HEAD", path: "tracked.txt" });
    assert.match(shown.content[0].text, /second revision/);
    assert.match(shown.details.ref, /^[0-9a-f]{40,64}$/);

    const blame = await execute({ action: "blame", path: "tracked.txt", startLine: 1, endLine: 2 });
    assert.match(blame.content[0].text, /first/);
    assert.match(blame.content[0].text, /second revision/);
    assert.equal(blame.details.range, "1-2");

    const hook = join(root, "external-diff.cjs");
    const sentinel = join(root, "external-diff-ran");
    await writeFile(hook, 'require("node:fs").writeFileSync(process.argv[2], "ran");\n');
    const quoted = (value: string) => `"${value.replaceAll("\\", "/").replaceAll('"', '\\"')}"`;
    await gitAt(root, "config", "diff.scout-sentinel.command", `${quoted(process.execPath)} ${quoted(hook)} ${quoted(sentinel)}`);
    await gitAt(root, "diff", "--", "tracked.txt");
    await access(sentinel);
    await rm(sentinel, { force: true });
    await execute({ action: "diff", path: "tracked.txt" });
    await assert.rejects(access(sentinel));

    await writeFile(join(root, "tracked.txt"), `${"large evidence ".repeat(12_000)}\n`);
    const large = await execute({ action: "diff", path: "tracked.txt" });
    assert.ok(Buffer.byteLength(large.content[0].text) <= SCOUT_TOOL_MAX_BYTES);
    assert.equal(large.details.truncated, true);
    assert.match(large.content[0].text, /partial evidence|output truncated/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("git_evidence canonicalizes refs, treats paths literally, and rejects ambiguous inputs", async () => {
  const root = await realpath(process.cwd());
  const tools = new Map<string, any>();
  const calls: string[][] = [];
  const first = "1".repeat(40);
  const second = "2".repeat(40);
  registerScoutChildTools(
    {
      registerTool(tool: any) {
        tools.set(tool.name, tool);
      },
    } as any,
    undefined,
    async (_cwd, args) => {
      calls.push([...args]);
      if (args.includes("--show-toplevel")) return { stdout: `${root}\n`, stderr: "", code: 0, receivedBytes: root.length };
      if (args.includes("--verify")) {
        const input = args.at(-1) ?? "";
        const oid = input.startsWith("HEAD~1") ? first : second;
        return { stdout: `${oid}\n`, stderr: "", code: 0, receivedBytes: oid.length };
      }
      return { stdout: "diff evidence\n", stderr: "", code: 0, receivedBytes: 14 };
    },
  );
  const evidence = tools.get("git_evidence");
  const execute = (params: Record<string, unknown>) =>
    evidence.execute("id", params, undefined, undefined, { cwd: root });

  await execute({ action: "diff", base: "HEAD~1", target: "HEAD", path: "-odd name.txt" });
  const diff = calls.find(args => args.includes("diff")) ?? [];
  assert.ok(diff.includes("--literal-pathspecs"));
  assert.ok(diff.includes(first));
  assert.ok(diff.includes(second));
  assert.ok(!diff.includes("HEAD~1") && !diff.includes("HEAD"));
  assert.deepEqual(diff.slice(-2), ["--", "-odd name.txt"]);

  await assert.rejects(execute({ action: "diff", base: "HEAD..main" }), /unsupported revision syntax/);
  await assert.rejects(execute({ action: "show", ref: "HEAD:secret" }), /unsupported revision syntax/);
  await assert.rejects(
    execute({ action: "blame", path: "tracked.txt", startLine: 1, endLine: 201 }),
    /cannot exceed 200 lines/,
  );
  await assert.rejects(execute({ action: "status", ref: "HEAD" }), /status does not accept ref/);
});

test("git_evidence rejects an ancestor repository outside the workspace root", { skip: !hasGit }, async () => {
  const root = await repository();
  const child = join(root, "nested");
  await mkdir(child);
  const tools = new Map<string, any>();
  registerScoutChildTools({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
  try {
    await assert.rejects(
      tools.get("git_evidence").execute("id", { action: "status" }, undefined, undefined, { cwd: child }),
      /workspace root to equal the repository root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
