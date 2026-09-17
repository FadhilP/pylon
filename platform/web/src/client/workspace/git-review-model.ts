import type { GitConflictBlock } from "../../shared/workspace/git.ts";

export type ConflictChoice = "ours" | "theirs" | "both";
export const CONFLICT_EMPTY_PLACEHOLDER = "\u200b";
export type ConflictChoices = Readonly<Record<number, ConflictChoice | undefined>>;

export type ConflictLineKind = "marker" | "base" | "ours" | "theirs";
export type ConflictTextRange = { from: number; to: number };
export type EditableConflictBlock = GitConflictBlock & {
  startLine: number;
  oursFrom: number;
  oursTargetLine: number;
  theirsStartLine: number;
  theirsTargetLine: number;
  theirsFrom: number;
  endLine: number;
};
export type EditableConflictText = {
  valid: boolean;
  blocks: EditableConflictBlock[];
  protectedRanges: ConflictTextRange[];
  lines: Array<{ line: number; kind: ConflictLineKind }>;
};

/** Parses the live marker-bearing editor text so side edits can change length safely. */
export function parseEditableConflictText(text: string, size = 7): EditableConflictText {
  const startMarker = "<".repeat(size);
  const baseMarker = "|".repeat(size);
  const middleMarker = "=".repeat(size);
  const endMarker = ">".repeat(size);
  const sourceLines = text.split(/(?<=\n)/);
  const blocks: EditableConflictBlock[] = [];
  const protectedRanges: ConflictTextRange[] = [];
  const lines: EditableConflictText["lines"] = [];
  const invalid = (): EditableConflictText => ({ valid: false, blocks: [], protectedRanges: [], lines: [] });
  const markerKind = (line: string): "start" | "base" | "middle" | "end" | undefined => {
    const value = line.replace(/\r?\n$/, "");
    if (value === startMarker || value.startsWith(`${startMarker} `)) return "start";
    if (value === baseMarker || value.startsWith(`${baseMarker} `)) return "base";
    if (value === middleMarker) return "middle";
    if (value === endMarker || value.startsWith(`${endMarker} `)) return "end";
    return undefined;
  };
  let offset = 0;
  for (let index = 0; index < sourceLines.length; index++) {
    const first = sourceLines[index]!;
    const firstKind = markerKind(first);
    if (firstKind !== "start") {
      if (firstKind) return invalid();
      offset += first.length;
      continue;
    }
    if (!first.startsWith(`${startMarker} `)) return invalid();
    const start = offset;
    const startLine = index + 1;
    const oursLabel = first.slice(size + 1).replace(/\r?\n$/, "");
    protectedRanges.push({ from: offset, to: offset + first.length });
    lines.push({ line: startLine, kind: "marker" });
    offset += first.length;
    const oursFrom = offset;
    const ours: string[] = [];
    const base: string[] = [];
    const theirs: string[] = [];
    const oursLines: number[] = [];
    const theirsLines: number[] = [];
    let baseLabel: string | undefined;
    let theirsLabel: string | undefined;
    let baseLine: number | undefined;
    let middleLine: number | undefined;
    let endLine: number | undefined;
    let part: "ours" | "base" | "theirs" = "ours";
    let theirsContentFrom: number | undefined;
    for (index++; index < sourceLines.length; index++) {
      const line = sourceLines[index]!;
      const lineNumber = index + 1;
      const kind = markerKind(line);
      if (kind === "base" && part === "ours" && line.startsWith(`${baseMarker} `)) {
        baseLabel = line.slice(size + 1).replace(/\r?\n$/, "");
        baseLine = lineNumber;
        part = "base";
        protectedRanges.push({ from: offset, to: offset + line.length });
        lines.push({ line: lineNumber, kind: "marker" });
        offset += line.length;
        continue;
      }
      if (kind === "middle" && part !== "theirs") {
        middleLine = lineNumber;
        part = "theirs";
        protectedRanges.push({ from: offset, to: offset + line.length });
        lines.push({ line: lineNumber, kind: "marker" });
        offset += line.length;
        theirsContentFrom = offset;
        continue;
      }
      if (kind === "end" && part === "theirs" && line.startsWith(`${endMarker} `)) {
        theirsLabel = line.slice(size + 1).replace(/\r?\n$/, "");
        endLine = lineNumber;
        protectedRanges.push({ from: offset, to: offset + line.length });
        lines.push({ line: lineNumber, kind: "marker" });
        offset += line.length;
        break;
      }
      if (kind) return invalid();
      if (part === "ours") {
        ours.push(line);
        oursLines.push(lineNumber);
        lines.push({ line: lineNumber, kind: "ours" });
      } else if (part === "base") {
        base.push(line);
        protectedRanges.push({ from: offset, to: offset + line.length });
        lines.push({ line: lineNumber, kind: "base" });
      } else {
        theirs.push(line);
        theirsLines.push(lineNumber);
        lines.push({ line: lineNumber, kind: "theirs" });
      }
      offset += line.length;
    }
    if (middleLine === undefined || endLine === undefined) return invalid();
    blocks.push({
      start,
      end: offset,
      ours: ours.join(""),
      theirs: theirs.join(""),
      ...(base.length ? { base: base.join("") } : {}),
      oursLabel,
      ...(baseLabel ? { baseLabel } : {}),
      oursFrom,
      theirsLabel,
      startLine,
      oursTargetLine: oursLines[0] ?? baseLine ?? middleLine,
      theirsFrom: theirsContentFrom!,
      theirsStartLine: middleLine,
      theirsTargetLine: theirsLines[0] ?? endLine,
      endLine,
    });
  }
  return { valid: true, blocks, protectedRanges, lines };
}


export function prepareEditableConflictText(text: string): string {
  const parsed = parseEditableConflictText(text);
  if (!parsed.valid) return text;
  const insertions = parsed.blocks.flatMap(block => [
    ...(block.ours ? [] : [block.oursFrom]),
    ...(block.theirs ? [] : [block.theirsFrom]),
  ]).sort((a, b) => b - a);
  let result = text;
  for (const at of insertions) result = `${result.slice(0, at)}${CONFLICT_EMPTY_PLACEHOLDER}\n${result.slice(at)}`;
  return result;
}

export function conflictResolutionBlocks(blocks: readonly EditableConflictBlock[]): GitConflictBlock[] {
  const clean = (text: string) => text === `${CONFLICT_EMPTY_PLACEHOLDER}\n` ? "" : text.replaceAll(CONFLICT_EMPTY_PLACEHOLDER, "");
  return blocks.map(block => ({ ...block, ours: clean(block.ours), theirs: clean(block.theirs) }));
}
export function editableConflictStructureMatches(text: string, original: readonly GitConflictBlock[]): boolean {
  const parsed = parseEditableConflictText(text);
  return parsed.valid && parsed.blocks.length === original.length && parsed.blocks.every((block, index) => {
    const expected = original[index]!;
    return block.oursLabel === expected.oursLabel && block.theirsLabel === expected.theirsLabel &&
      block.baseLabel === expected.baseLabel && block.base === expected.base;
  });
}

export function conflictChoiceText(block: GitConflictBlock, choice: ConflictChoice): string {
  if (choice === "ours") return block.ours;
  if (choice === "theirs") return block.theirs;
  return block.ours + (block.ours && block.theirs && !block.ours.endsWith("\n") ? "\n" : "") + block.theirs;
}

/**
 * Replaces Git's marker-containing ranges with the choices made in the review UI.
 * Git reports offsets against LF text, so normalising first is deliberate: callers
 * can safely pass a working-copy value from a CRLF checkout.
 */
export function reconstructConflictText(
  text: string,
  blocks: readonly GitConflictBlock[],
  choices: ConflictChoices,
): string {
  const source = text.replace(/\r\n/g, "\n");
  let cursor = 0;
  let output = "";
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]!;
    const choice = choices[index];
    if (!choice) throw new Error(`Conflict ${index + 1} is unresolved.`);
    if (block.start < cursor || block.end < block.start || block.end > source.length)
      throw new Error("Conflict block offsets are invalid for this file.");
    output += source.slice(cursor, block.start);
    output += conflictChoiceText(block, choice);
    cursor = block.end;
  }
  return output + source.slice(cursor);
}
