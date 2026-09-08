import type { GitConflictBlock } from "../../shared/workspace/git.ts";

export type ConflictChoice = "ours" | "theirs" | "both";
export type ConflictChoices = Readonly<Record<number, ConflictChoice | undefined>>;

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
