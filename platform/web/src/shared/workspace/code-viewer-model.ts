import { applyPatch, diffLines, diffWordsWithSpace, parsePatch, type StructuredPatch } from "diff";
import { MAX_EDIT_BYTES } from "./workspace-mutations.ts";
import type { FileHistoryOwner } from "pylon-core/src/file-history.ts";

export interface CodeAttribution {
  oldOwners?: readonly (string | null)[];
  newOwners?: readonly (string | null)[];
  owners: ReadonlyMap<string, FileHistoryOwner>;
  selected?: string;
  selectable: ReadonlySet<string>;
}

/** Diff deletions belong to the old snapshot, not the line now occupying that position. */
export function attributedOwner(line: CodeLine, attribution?: CodeAttribution): FileHistoryOwner | undefined {
  const number = line.kind === "deletion" ? line.oldLine : line.newLine;
  const ids = line.kind === "deletion" ? attribution?.oldOwners : attribution?.newOwners;
  const id = number === undefined ? undefined : ids?.[number - 1];
  return id ? attribution?.owners.get(id) : undefined;
}

export function historyColor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (Math.imul(hash, 31) + id.charCodeAt(index)) | 0;
  return `hsl(${(hash >>> 0) % 360} var(--history-saturation, 55%) var(--history-lightness, 48%))`;
}

export interface DiffContents {
  oldFile: { contents: string };
  newFile: { contents: string };
}

export type DiffContentsLoader = (path: string) => Promise<DiffContents>;
export interface ChangeRange {
  start: number;
  end: number;
}
export interface CodeLine {
  kind: "context" | "addition" | "deletion" | "note";
  text: string;
  oldLine?: number;
  newLine?: number;
  changes?: ChangeRange[];
}
export interface DiffFile {
  path: string;
  oldPath: string;
  patch: StructuredPatch;
  hunks: CodeLine[][];
}
export interface ContextGap {
  kind: "gap";
  id: number;
  oldStart: number;
  newStart: number;
  count?: number;
}
export type DiffRow = CodeLine | ContextGap;
export type ExpandedContext = Record<number, { start: number; end: number }>;

export function sourceLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export type GitLineChange = { kind: "added" | "modified" } | { kind: "deleted"; edge: "before" | "after" | "both" };

/** Display-only index-to-draft markers; never used to write patches or attribute history. */
export function gitGutterChanges(indexText: string | undefined, text: string): Map<number, GitLineChange> | undefined {
  if (indexText === undefined) return undefined;
  const result = new Map<number, GitLineChange>();
  if (indexText === text) return result;
  if (Math.max(indexText.length, text.length) > MAX_EDIT_BYTES) return undefined;
  const lineCount = sourceLines(text).length;
  if (Math.max(lineCount, sourceLines(indexText).length) > 20_000) return undefined;
  if (!indexText) {
    for (let line = 1; line <= lineCount; line++) result.set(line, { kind: "added" });
    return result;
  }
  if (!text) return new Map([[1, { kind: "deleted", edge: "before" }]]);
  const changes = diffLines(indexText, text, { timeout: 40, maxEditLength: 2000 });
  if (!changes) return undefined;
  let line = 1;
  for (let index = 0; index < changes.length;) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      line += change.count;
      index++;
      continue;
    }
    let added = 0;
    let removed = 0;
    while (index < changes.length && (changes[index].added || changes[index].removed)) {
      const part = changes[index++];
      if (part.added) added += part.count;
      else removed += part.count;
    }
    if (added) {
      for (let offset = 0; offset < added; offset++)
        result.set(line + offset, { kind: removed ? "modified" : "added" });
      line += added;
    } else {
      // Deletions occupy a boundary, not a line that still exists. Empty editors still have line 1.
      const before = line <= lineCount || !lineCount;
      const anchor = before ? line : lineCount;
      result.set(anchor, { kind: "deleted", edge: result.has(anchor) ? "both" : before ? "before" : "after" });
    }
  }
  return result;
}

/** Only Git computes file changes; this adapter gives its patches stable source coordinates. */
export function parseDiff(text: string): DiffFile[] {
  try {
    return parsePatch(text)
      .filter(patch => patch.oldFileName && patch.newFileName)
      .map(patch => {
        const oldPath = patch.oldFileName!.replace(/^a\//, "");
        const path = patch.newFileName === "/dev/null" ? oldPath : patch.newFileName!.replace(/^b\//, "");
        const hunks = patch.hunks.map(hunk => {
          let oldLine = hunk.oldStart;
          let newLine = hunk.newStart;
          const lines: CodeLine[] = hunk.lines.map(line => {
            if (line.startsWith("\\")) return { kind: "note", text: line.slice(2) };
            if (line.startsWith("+")) return { kind: "addition", text: line.slice(1), newLine: newLine++ };
            if (line.startsWith("-")) return { kind: "deletion", text: line.slice(1), oldLine: oldLine++ };
            return { kind: "context", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ };
          });
          markChangedWords(lines);
          return lines;
        });
        return { path, oldPath, patch, hunks };
      });
  } catch {
    // Incomplete/truncated patches stay available as raw text instead of misleading line numbers.
    return [];
  }
}

function markChangedWords(lines: CodeLine[]): void {
  for (let index = 0; index < lines.length;) {
    if (lines[index].kind !== "deletion") {
      index++;
      continue;
    }
    const removed: CodeLine[] = [];
    const added: CodeLine[] = [];
    while (lines[index]?.kind === "deletion" || lines[index]?.kind === "note") {
      if (lines[index].kind === "deletion") removed.push(lines[index]);
      index++;
    }
    while (lines[index]?.kind === "addition" || lines[index]?.kind === "note") {
      if (lines[index].kind === "addition") added.push(lines[index]);
      index++;
    }
    for (let pair = 0; pair < Math.min(removed.length, added.length); pair++) {
      const before = removed[pair];
      const after = added[pair];
      // ponytail: pair changed lines in order; use sequence alignment if moved-line matching is needed.
      // Bound pathological/minified lines; their full-line addition/deletion colors remain intact.
      if (before.text.length + after.text.length > 10_000) continue;
      const changes = diffWordsWithSpace(before.text, after.text, { maxEditLength: 200 });
      if (!changes) continue;
      let oldOffset = 0;
      let newOffset = 0;
      before.changes = [];
      after.changes = [];
      for (const change of changes) {
        if (change.removed) before.changes.push({ start: oldOffset, end: oldOffset + change.value.length });
        if (change.added) after.changes.push({ start: newOffset, end: newOffset + change.value.length });
        if (!change.added) oldOffset += change.value.length;
        if (!change.removed) newOffset += change.value.length;
      }
    }
  }
}

export function loadDiffContents({
  revision,
  base,
  current,
}: {
  revision: string;
  base: { revision: string; state: string; text?: string; truncated?: boolean };
  current: { revision: string; state: string; text?: string; truncated?: boolean };
}): DiffContents {
  if (base.revision !== revision || current.revision !== revision)
    throw new Error("Workspace changed while loading diff context");
  const contents = (side: typeof base) => {
    if (!side.truncated) {
      // Added/deleted files have an explicitly absent side, represented by an empty source.
      if (side.state === "deleted") return "";
      if (side.state === "available" && side.text !== undefined) return side.text;
    }
    throw new Error("Full file context is unavailable");
  };
  return { oldFile: { contents: contents(base) }, newFile: { contents: contents(current) } };
}

/** Validate the fetched context too: a workspace revision is not an atomic pair of file reads. */
export function validateDiffContents(file: DiffFile, contents: DiffContents): void {
  const oldLines = sourceLines(contents.oldFile.contents);
  const newLines = sourceLines(contents.newFile.contents);
  for (const hunk of file.hunks) {
    for (const line of hunk) {
      if (
        (line.oldLine !== undefined && oldLines[line.oldLine - 1] !== line.text) ||
        (line.newLine !== undefined && newLines[line.newLine - 1] !== line.text)
      )
        throw new Error("Workspace changed while loading diff context");
    }
  }
  if (
    applyPatch(contents.oldFile.contents, file.patch, { autoConvertLineEndings: false }) !== contents.newFile.contents
  )
    throw new Error("Workspace changed while loading diff context");
}

export function diffRows(file: DiffFile, expanded: ExpandedContext = {}, contents?: DiffContents): DiffRow[] {
  const rows: DiffRow[] = [];
  const current = contents ? sourceLines(contents.newFile.contents) : undefined;
  let oldEnd = 1;
  let newEnd = 1;
  const appendGap = (id: number, count?: number) => {
    if (count === 0) return;
    const expansion = expanded[id];
    const start = current && expansion ? Math.min(expansion.start, count ?? 0) : 0;
    const end = current && expansion ? Math.min(expansion.end, (count ?? 0) - start) : 0;
    const appendLine = (offset: number) =>
      rows.push({
        kind: "context",
        text: current![newEnd + offset - 1],
        oldLine: oldEnd + offset,
        newLine: newEnd + offset,
      });
    for (let offset = 0; offset < start; offset++) appendLine(offset);
    const remaining = count === undefined ? undefined : count - start - end;
    if (remaining !== 0)
      rows.push({ kind: "gap", id, oldStart: oldEnd + start, newStart: newEnd + start, count: remaining });
    for (let offset = (count ?? 0) - end; offset < (count ?? 0); offset++) appendLine(offset);
  };
  file.patch.hunks.forEach((hunk, index) => {
    appendGap(index, Math.max(0, hunk.newStart - newEnd));
    rows.push(...file.hunks[index]);
    oldEnd = hunk.oldStart + hunk.oldLines;
    newEnd = hunk.newStart + hunk.newLines;
  });
  const completeFile =
    file.patch.isCreate ||
    file.patch.isDelete ||
    file.patch.oldFileName === "/dev/null" ||
    file.patch.newFileName === "/dev/null";
  if (file.hunks.length && !completeFile)
    appendGap(file.hunks.length, current ? Math.max(0, current.length - newEnd + 1) : undefined);
  return rows;
}

export function selectedText(rows: readonly { kind: string; text?: string }[], start: number, end: number): string {
  return rows
    .slice(Math.min(start, end), Math.max(start, end) + 1)
    .filter(row => row.kind === "context" || row.kind === "addition" || row.kind === "deletion")
    .map(row => row.text)
    .join("\n");
}
