import { isAbsolute, relative, resolve } from "node:path";
import {
  createReadToolDefinition,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
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
  const raw = /\r?\n--\r?\n/.test(output)
    ? output.split(/\r?\n--\r?\n/)
    : output.split(/\r?\n/).filter(Boolean);
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
  return Array.from({ length: count }, (_, index) =>
    items[Math.round(index * (items.length - 1) / (count - 1))]);
}

export function boundedSearch(output: string, maxBytes = SCOUT_TOOL_MAX_BYTES): string {
  const result = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes });
  if (!result.truncated) return result.content;
  const { blocks, fileCount } = citationBlocks(output);
  if (!blocks.length) return bounded(output, maxBytes);
  const notice = `\n\n[Output sampled across ${fileCount} files; some matching excerpts omitted. Original: ${result.totalLines} lines/${formatSize(result.totalBytes)}. Cap: ${formatSize(maxBytes)}.]`;
  const bodyBudget = maxBytes - Buffer.byteLength(notice, "utf8");
  const prepared = blocks.map((block) => fit(block, Math.min(4 * 1024, bodyBudget)));
  let count = prepared.length;
  while (count > 1) {
    const sampled = evenlySample(prepared, count).join("\n--\n");
    if (Buffer.byteLength(sampled, "utf8") <= bodyBudget) return `${sampled}${notice}`;
    count = Math.max(1, Math.min(count - 1, Math.floor(count * bodyBudget / Buffer.byteLength(sampled, "utf8"))));
  }
  return `${fit(evenlySample(prepared, 1)[0], bodyBudget)}${notice}`;
}

function unavailable(error: unknown): boolean {
  return /ENOENT|not recognized|not found|cannot find/i.test(String(error));
}

async function excerptSearch(
  pi: ExtensionAPI,
  pattern: string,
  path: string,
  glob: string | undefined,
  context: number,
  signal: AbortSignal | undefined,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const rgArgs = [
    "--line-number", "--no-heading", "--color=never", "--sort", "path",
    "--max-columns=500", "--max-columns-preview", "--max-count", String(MAX_MATCHES),
    "--context", String(context),
  ];
  if (glob) rgArgs.push("--glob", glob);
  rgArgs.push("--", pattern, path);
  try {
    const result = await pi.exec("rg", rgArgs, { signal, timeout: TIMEOUT_MS });
    if (result.code === 0) return { text: boundedSearch(result.stdout) || "No matches found", details: { command: "rg", code: 0 } };
    if (result.code === 1) return { text: "No matches found", details: { command: "rg", code: 1 } };
    if (!unavailable(result.stderr)) throw new Error(`ripgrep failed (${result.code}): ${result.stderr.trim()}`);
  } catch (error) {
    if (!unavailable(error)) throw error;
  }

  const grepArgs = ["-r", "-n", "-H", "--color=never", "-m", String(MAX_MATCHES), "-C", String(context)];
  if (glob) grepArgs.push(`--include=${glob}`);
  grepArgs.push("--", pattern, path);
  try {
    const result = await pi.exec("grep", grepArgs, { signal, timeout: TIMEOUT_MS });
    if (result.code === 0) return { text: boundedSearch(result.stdout) || "No matches found", details: { command: "grep", code: 0, fallback: true } };
    if (result.code === 1) return { text: "No matches found", details: { command: "grep", code: 1, fallback: true } };
    if (unavailable(result.stderr)) return { text: "ripgrep and grep unavailable; no excerpt search was run.", details: { unavailable: true } };
    throw new Error(`grep failed (${result.code}): ${result.stderr.trim()}`);
  } catch (error) {
    if (unavailable(error)) return { text: "ripgrep and grep unavailable; no excerpt search was run.", details: { unavailable: true } };
    throw error;
  }
}

export default function scoutChildToolsExtension(pi: ExtensionAPI) {
  const read = createReadToolDefinition(process.cwd());
  pi.registerTool({
    ...read,
    description: `Read workspace files with child-local output capped at ${formatSize(SCOUT_TOOL_MAX_BYTES)}. Use offset/limit for focused ranges.`,
    promptSnippet: "Read a focused workspace file range",
    promptGuidelines: ["Read the smallest range supported by existing evidence; use offset and limit instead of paging through files."],
    async execute(id, params, signal, update, ctx) {
      const result = await createReadToolDefinition(ctx.cwd).execute(id, params, signal, update, ctx);
      return {
        ...result,
        content: result.content.map((part) => part.type === "text" ? { ...part, text: bounded(part.text, SCOUT_TOOL_MAX_BYTES) } : part),
      };
    },
  });

  pi.registerTool({
    name: "search_excerpt",
    label: "Search excerpts",
    description: `Read-only text search returning deterministic line-numbered matching excerpts and context in one call. Output capped at ${formatSize(SCOUT_TOOL_MAX_BYTES)}; matching results beyond the cap are reported as omitted.`,
    promptSnippet: "Search text once and return bounded line-numbered matching excerpts with context",
    promptGuidelines: ["Use search_excerpt for citation-ready evidence. Give a workspace-relative path or glob when known; refine a truncated search rather than repeating it. It tries rg and then grep without running shell commands."],
    parameters: Type.Object({
      pattern: Type.String({ minLength: 1, maxLength: 300, description: "Regular expression to search" }),
      path: Type.Optional(Type.String({ maxLength: 500, description: "Workspace-relative file or directory; default ." })),
      glob: Type.Optional(Type.String({ maxLength: 200, description: "Optional file glob, such as *.ts" })),
      context: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: "Lines of context on each side; default 2" })),
    }, { additionalProperties: false }),
    async execute(_id, params, signal, _update, ctx) {
      const result = await excerptSearch(pi, params.pattern, workspacePath(ctx.cwd, params.path), params.glob, params.context ?? 2, signal);
      return { content: [{ type: "text" as const, text: result.text }], details: result.details };
    },
  });
}
