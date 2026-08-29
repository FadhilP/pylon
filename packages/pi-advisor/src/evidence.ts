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
const MAX_RANGE_LINES = 200;

function validRange(ref: EvidenceRef): boolean {
  return (
    Number.isInteger(ref.start) &&
    Number.isInteger(ref.end) &&
    ref.start >= 1 &&
    ref.end >= ref.start &&
    ref.end - ref.start + 1 <= MAX_RANGE_LINES
  );
}

function safeField(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>]/g, "")
    .trim();
}

function annotations(
  ref: EvidenceRef,
  field: "claim" | "verification",
): string[] {
  const values =
    field === "claim"
      ? [ref.claim, ...(ref.claims ?? [])]
      : [ref.verification, ...(ref.verifications ?? [])];
  return [
    ...new Set(values.filter((value): value is string => Boolean(value))),
  ];
}

function mergeAnnotations(target: EvidenceRef, earlier: EvidenceRef): void {
  const claims = [
    ...new Set([
      ...annotations(earlier, "claim"),
      ...annotations(target, "claim"),
    ]),
  ];
  const verifications = [
    ...new Set([
      ...annotations(earlier, "verification"),
      ...annotations(target, "verification"),
    ]),
  ];
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
  return (
    a.path.replace(/\\/g, "/") === b.path.replace(/\\/g, "/") &&
    a.revision === b.revision
  );
}

/** Widens `next` to cover `current` too, or returns false when they cannot merge. */
function absorb(next: EvidenceRef, current: EvidenceRef): boolean {
  if (
    !validRange(current) ||
    !sameEvidenceVersion(current, next) ||
    next.end + 1 < current.start ||
    next.start > current.end + 1
  )
    return false;
  const start = Math.min(next.start, current.start);
  const end = Math.max(next.end, current.end);
  if (end - start + 1 > MAX_RANGE_LINES) return false;
  next.path = current.path;
  next.start = start;
  next.end = end;
  mergeAnnotations(next, current);
  return true;
}

export function mergeEvidenceRefs(
  references: readonly EvidenceRef[],
): EvidenceRef[] {
  let merged: EvidenceRef[] = [];
  for (const reference of references) {
    const next = { ...reference };
    if (!validRange(next)) {
      merged.push(next);
      continue;
    }
    const absorbed = new Set<EvidenceRef>();
    let insertAt = merged.length;
    for (const [index, current] of merged.entries()) {
      if (!absorb(next, current)) continue;
      absorbed.add(current);
      insertAt = Math.min(insertAt, index);
    }
    merged = merged.filter((ref) => !absorbed.has(ref));
    merged.splice(insertAt, 0, next);
  }
  return merged;
}

function formatRecord(ref: EvidenceRef, excerpt: string): string {
  const metadata = [
    ...annotations(ref, "claim").map((claim) => `Claim: ${safeField(claim)}`),
    ref.revision ? `Revision: ${safeField(ref.revision)}` : "",
    ...annotations(ref, "verification").map(
      (verification) => `Verification: ${safeField(verification)}`,
    ),
  ].filter(Boolean);
  return [
    `--- ${safeField(ref.path)}:${ref.start}-${ref.end} ---`,
    ...metadata,
    excerpt,
  ].join("\n");
}

async function resolveEvidencePath(
  root: string,
  referencePath: string,
): Promise<{ path: string; workspacePath: string }> {
  if (referencePath.split(/[\\/]/).includes(".git"))
    throw Error("path must be outside .git");
  const path = await realpath(resolve(root, referencePath));
  const fromRoot = relative(root, path);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw Error("path escapes workspace");
  const workspacePath = fromRoot.split(sep).join("/");
  if (workspacePath.split("/").includes(".git"))
    throw Error("path must be outside .git");
  return { path, workspacePath };
}

async function readExcerpt(path: string, ref: EvidenceRef): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw Error("path is not a regular file");
  if (info.size > MAX_FILE_BYTES) throw Error("file exceeds 1 MiB");
  const data = await readFile(path);
  if (data.includes(0)) throw Error("binary file rejected");
  const lines = data.toString("utf8").split(/\r?\n/);
  const start = Math.min(ref.start, lines.length + 1);
  const end = Math.min(ref.end, lines.length);
  if (end < start) return "[range beyond end of file]";
  return lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}: ${line}`)
    .join("\n");
}

export async function loadEvidenceRecords(
  cwd: string,
  references: readonly EvidenceRef[] = [],
): Promise<EvidenceRecord[]> {
  if (!references.length) return [];
  const root = await realpath(cwd);
  const records: EvidenceRecord[] = [];

  for (const ref of mergeEvidenceRefs(references)) {
    let recordRef = ref;
    let excerpt: string;
    let unavailable = false;
    try {
      if (!validRange(ref))
        throw Error(`range must contain 1..${MAX_RANGE_LINES} lines`);
      const resolved = await resolveEvidencePath(root, ref.path);
      recordRef = { ...ref, path: resolved.workspacePath };
      excerpt = await readExcerpt(resolved.path, ref);
    } catch (error: any) {
      unavailable = true;
      excerpt = `[evidence unavailable: ${error?.message ?? String(error)}]`;
    }
    records.push({
      ref: recordRef,
      excerpt,
      text: formatRecord(recordRef, excerpt),
      unavailable,
    });
  }
  return records;
}
