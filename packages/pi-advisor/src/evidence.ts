import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type EvidenceRef = {
  path: string;
  start: number;
  end: number;
  claim?: string;
  claims?: string[];
  revision?: string;
  verification?: string;
  verifications?: string[];
};
export type EvidenceRecord = {
  ref: EvidenceRef;
  excerpt: string;
  text: string;
  unavailable: boolean;
};

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_LINES = 400;
const MAX_TOTAL_CHARS = 32 * 1024;

function validRange(ref: EvidenceRef): boolean {
  return Number.isInteger(ref.start) && Number.isInteger(ref.end) && ref.start >= 1 && ref.end >= ref.start && ref.end - ref.start + 1 <= 200;
}

function safeField(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").replace(/[<>]/g, "").trim();
}

function annotations(ref: EvidenceRef, field: "claim" | "verification"): string[] {
  const values = field === "claim" ? [ref.claim, ...(ref.claims ?? [])] : [ref.verification, ...(ref.verifications ?? [])];
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function mergeAnnotations(target: EvidenceRef, earlier: EvidenceRef): void {
  const claims = [...new Set([...annotations(earlier, "claim"), ...annotations(target, "claim")])];
  const verifications = [...new Set([...annotations(earlier, "verification"), ...annotations(target, "verification")])];
  delete target.claim;
  delete target.claims;
  delete target.verification;
  delete target.verifications;
  if (claims.length === 1) target.claim = claims[0];
  else if (claims.length) target.claims = claims;
  if (verifications.length === 1) target.verification = verifications[0];
  else if (verifications.length) target.verifications = verifications;
}

function sameEvidenceVersion(a: EvidenceRef, b: EvidenceRef): boolean {
  return a.path.replace(/\\/g, "/") === b.path.replace(/\\/g, "/") && a.revision === b.revision;
}

export function mergeEvidenceRefs(references: readonly EvidenceRef[]): EvidenceRef[] {
  const merged: EvidenceRef[] = [];
  for (const reference of references) {
    const next = { ...reference };
    if (!validRange(next)) {
      merged.push(next);
      continue;
    }
    let insertAt = merged.length;
    for (let index = 0; index < merged.length; index++) {
      const current = merged[index];
      if (
        !validRange(current) ||
        !sameEvidenceVersion(current, next) ||
        next.end + 1 < current.start ||
        next.start > current.end + 1
      ) continue;
      const start = Math.min(next.start, current.start);
      const end = Math.max(next.end, current.end);
      if (end - start + 1 > 200) continue;
      next.path = current.path;
      next.start = start;
      next.end = end;
      mergeAnnotations(next, current);
      insertAt = Math.min(insertAt, index);
      merged.splice(index, 1);
      index--;
    }
    merged.splice(insertAt, 0, next);
  }
  return merged;
}

function formatRecord(ref: EvidenceRef, excerpt: string): string {
  const metadata = [
    ...annotations(ref, "claim").map((claim) => `Claim: ${safeField(claim)}`),
    ref.revision ? `Revision: ${safeField(ref.revision)}` : "",
    ...annotations(ref, "verification").map((verification) => `Verification: ${safeField(verification)}`),
  ].filter(Boolean);
  return [`--- ${safeField(ref.path)}:${ref.start}-${ref.end} ---`, ...metadata, excerpt].join("\n");
}

export async function loadEvidenceRecords(
  cwd: string,
  references: readonly EvidenceRef[] = [],
): Promise<EvidenceRecord[]> {
  if (!references.length) return [];
  const root = await realpath(cwd);
  const records: EvidenceRecord[] = [];

  for (const ref of mergeEvidenceRefs(references)) {
    let excerpt = "";
    let unavailable = false;
    try {
      if (!validRange(ref)) throw Error("range must contain 1..200 lines");
      if (isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes(".git"))
        throw Error("path must be workspace-relative and outside .git");
      const path = await realpath(resolve(root, ref.path));
      const fromRoot = relative(root, path);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))
        throw Error("path escapes workspace");
      const info = await stat(path);
      if (!info.isFile()) throw Error("path is not a regular file");
      if (info.size > MAX_FILE_BYTES) throw Error("file exceeds 1 MiB");
      const data = await readFile(path);
      if (data.includes(0)) throw Error("binary file rejected");
      const lines = data.toString("utf8").split(/\r?\n/);
      const start = Math.min(ref.start, lines.length + 1);
      const end = Math.min(ref.end, lines.length);
      excerpt = end >= start
        ? lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n")
        : "[range beyond end of file]";
    } catch (error: any) {
      unavailable = true;
      excerpt = `[evidence unavailable: ${error?.message ?? String(error)}]`;
    }
    records.push({ ref, excerpt, text: formatRecord(ref, excerpt), unavailable });
  }
  return records;
}

export async function loadEvidence(
  cwd: string,
  references: readonly EvidenceRef[] = [],
): Promise<string> {
  if (!references.length) return "";
  const root = await realpath(cwd);
  const excerpts: string[] = [];
  let remainingLines = MAX_TOTAL_LINES;
  let remainingChars = MAX_TOTAL_CHARS;

  for (const ref of mergeEvidenceRefs(references)) {
    const label = `${safeField(ref.path)}:${ref.start}-${ref.end}`;
    try {
      if (!validRange(ref)) throw Error("range must contain 1..200 lines");
      if (isAbsolute(ref.path) || ref.path.split(/[\\/]/).includes(".git"))
        throw Error("path must be workspace-relative and outside .git");
      const path = await realpath(resolve(root, ref.path));
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
      const start = Math.min(ref.start, lines.length + 1);
      const end = Math.min(ref.end, lines.length);
      const selected = end >= start ? lines.slice(start - 1, Math.min(end, start + remainingLines - 1)) : [];
      let excerpt = selected.map((line, index) => `${start + index}: ${line}`).join("\n");
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
