import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type EvidenceRef = { path: string; start: number; end: number };

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_LINES = 400;
const MAX_TOTAL_CHARS = 32 * 1024;

export async function loadEvidence(
  cwd: string,
  references: EvidenceRef[] = [],
): Promise<string> {
  if (!references.length) return "";
  const root = await realpath(cwd);
  const excerpts: string[] = [];
  let remainingLines = MAX_TOTAL_LINES;
  let remainingChars = MAX_TOTAL_CHARS;

  for (const reference of references) {
    const label = `${reference.path}:${reference.start}-${reference.end}`;
    try {
      if (reference.end < reference.start || reference.end - reference.start + 1 > 200)
        throw Error("range must contain 1..200 lines");
      if (isAbsolute(reference.path) || reference.path.split(/[\\/]/).includes(".git"))
        throw Error("path must be workspace-relative and outside .git");
      const path = await realpath(resolve(root, reference.path));
      const fromRoot = relative(root, path);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
        throw Error("path escapes workspace");
      const info = await stat(path);
      if (!info.isFile()) throw Error("path is not a regular file");
      if (info.size > MAX_FILE_BYTES) throw Error("file exceeds 1 MiB");
      const data = await readFile(path);
      if (data.includes(0)) throw Error("binary file rejected");
      if (!remainingLines || !remainingChars) throw Error("evidence budget exhausted");
      const lines = data.toString("utf8").split(/\r?\n/);
      const start = Math.min(reference.start, lines.length + 1);
      const end = Math.min(reference.end, lines.length);
      const selected = end >= start
        ? lines.slice(start - 1, Math.min(end, start + remainingLines - 1))
        : [];
      let excerpt = selected
        .map((line, index) => `${start + index}: ${line}`)
        .join("\n");
      if (excerpt.length > remainingChars)
        excerpt = `${excerpt.slice(0, remainingChars)}\n[evidence byte budget reached]`;
      excerpts.push(`--- ${label} ---\n${excerpt || "[range beyond end of file]"}`);
      remainingLines -= selected.length;
      remainingChars -= Math.min(excerpt.length, remainingChars);
    } catch (error: any) {
      excerpts.push(`--- ${label} ---\n[evidence unavailable: ${error?.message ?? String(error)}]`);
    }
  }
  return `<high-priority-evidence>\n${excerpts.join("\n\n")}\n</high-priority-evidence>`;
}
