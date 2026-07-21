export const MAX_BYTES = 16 * 1024;
/** Repo Scout's final child report budget; other callers retain the general default. */
export const SCOUT_REPORT_MAX_BYTES = 12 * 1024;
export type EvidenceAnchor = { path: string; start: number; end: number };
export type StructuredClaim = {
  section: "findings" | "data_flow" | "affected_files" | "gaps" | "other";
  claim: string;
  citations: EvidenceAnchor[];
};

export function mergeEvidenceAnchors(anchors: readonly EvidenceAnchor[]): EvidenceAnchor[] {
  const byPath = new Map<string, EvidenceAnchor[]>();
  for (const anchor of anchors) byPath.set(anchor.path, [...(byPath.get(anchor.path) ?? []), anchor]);
  const merged: EvidenceAnchor[] = [];
  for (const [path, pathAnchors] of byPath) {
    const sorted = [...pathAnchors].sort((a, b) => a.start - b.start || a.end - b.end);
    const unions: EvidenceAnchor[] = [];
    for (const anchor of sorted) {
      const current = unions.at(-1);
      if (current && anchor.start <= current.end + 1) current.end = Math.max(current.end, anchor.end);
      else unions.push({ path, start: anchor.start, end: anchor.end });
    }
    for (const union of unions)
      for (let start = union.start; start <= union.end; start += 200)
        merged.push({ path, start, end: Math.min(union.end, start + 199) });
  }
  return merged;
}

function trimToBytes(text: string, maxBytes: number): string {
  let output = text;
  while (Buffer.byteLength(output, "utf8") > maxBytes) output = output.slice(0, -1);
  return output;
}

function markdownBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    const block = current.join("\n").trim();
    if (block) blocks.push(block);
    current = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^\s*(```|~~~)/)?.[1];
    if (marker) fence = fence === marker ? undefined : fence ?? marker;
    if (!fence && !line.trim()) flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

function evidenceAnchors(text: string): EvidenceAnchor[] {
  const anchors: EvidenceAnchor[] = [];
  const seen = new Set<string>();
  const pattern = /(?:^|[\s`(])([^\s`():]+):(\d+)-(\d+)\b/gm;
  for (const match of text.matchAll(pattern)) {
    const path = match[1].replace(/^["']|["',.)]+$/g, "");
    const start = Number(match[2]);
    const end = Number(match[3]);
    const parts = path.split(/[\\/]/);
    if (
      !path ||
      (!path.includes(".") && parts.length < 2) ||
      path.startsWith("/") ||
      path.startsWith("\\") ||
      /^[a-z]:/i.test(path) ||
      parts.includes("..") ||
      parts.includes(".git") ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end - start + 1 > 200
    ) continue;
    const identity = `${path}:${start}-${end}`;
    if (!seen.has(identity)) {
      seen.add(identity);
      anchors.push({ path, start, end });
    }
  }
  return anchors;
}

export function structuredClaims(text: string): StructuredClaim[] {
  const claims: StructuredClaim[] = [];
  const seen = new Set<string>();
  let section: StructuredClaim["section"] = "other";
  for (const block of markdownBlocks(text)) {
    const lines = block.split(/\r?\n/);
    const heading = lines[0]?.match(/^#{1,6}\s+(.+?)\s*$/)?.[1].toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_|_$/g, "");
    if (heading) {
      section = heading === "findings" || heading === "gaps"
        ? heading
        : heading === "data_flow" || heading === "affected_files"
          ? heading
          : "other";
      lines.shift();
    }
    const first = lines.find(line => line.trim())?.trim().replace(/^[-*+]\s+/, "");
    if (!first || /^(?:```|~~~)/.test(first)) continue;
    const claim = first.slice(0, 500);
    const citations = mergeEvidenceAnchors(evidenceAnchors(block));
    const identity = JSON.stringify([section, claim.replace(/\r\n/g, "\n").trim(), citations]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    claims.push({ section, claim, citations });
  }
  return claims;
}

function omissionNotice(count: number, anchors: readonly EvidenceAnchor[], maxBytes: number): string {
  const prefix = `\n\n[Omitted content: ${count} complete report block${count === 1 ? "" : "s"}.`;
  const suffix = ` Cap: ${maxBytes} bytes.]`;
  const kept: string[] = [];
  for (const anchor of anchors) {
    const candidate = [...kept, `${anchor.path}:${anchor.start}-${anchor.end}`];
    const text = `${prefix} Evidence available for focused retrieval: ${candidate.join(", ")}.${suffix}`;
    if (Buffer.byteLength(text, "utf8") > Math.min(512, maxBytes)) break;
    kept.push(candidate.at(-1)!);
  }
  return kept.length
    ? `${prefix} Evidence available for focused retrieval: ${kept.join(", ")}.${suffix}`
    : `${prefix}${suffix}`;
}

export type CappedReport = {
  text: string;
  truncated: boolean;
  omittedEvidence: EvidenceAnchor[];
  deduplicatedBlocks: number;
  deduplicatedBytes: number;
};

function dedupeMarkdownBlocks(text: string): { text: string; blocks: string[]; count: number; bytes: number } {
  const blocks = markdownBlocks(text);
  const seen = new Set<string>();
  const unique = blocks.filter((block) => {
    const identity = block.replace(/\r\n/g, "\n").trim();
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  if (unique.length === blocks.length) return { text, blocks, count: 0, bytes: 0 };
  const deduplicated = unique.join("\n\n");
  return {
    text: deduplicated,
    blocks: unique,
    count: blocks.length - unique.length,
    bytes: Math.max(0, Buffer.byteLength(text, "utf8") - Buffer.byteLength(deduplicated, "utf8")),
  };
}

export function capReport(
  text: string,
  maxBytes = SCOUT_REPORT_MAX_BYTES,
): CappedReport {
  const deduplicated = dedupeMarkdownBlocks(text);
  if (Buffer.byteLength(deduplicated.text, "utf8") <= maxBytes)
    return { text: deduplicated.text, truncated: false, omittedEvidence: [], deduplicatedBlocks: deduplicated.count, deduplicatedBytes: deduplicated.bytes };
  const blocks = deduplicated.blocks;
  const kept: string[] = [];
  const omittedBlocks: string[] = [];
  const noticeReserve = Math.min(512, maxBytes);
  for (const block of blocks) {
    const candidate = [...kept, block].join("\n\n");
    if (Buffer.byteLength(candidate, "utf8") + noticeReserve <= maxBytes) kept.push(block);
    else omittedBlocks.push(block);
  }
  const omittedEvidence = mergeEvidenceAnchors(evidenceAnchors(omittedBlocks.join("\n\n"))).slice(0, 20);
  const notice = omissionNotice(omittedBlocks.length, omittedEvidence, maxBytes);
  const output = [kept.join("\n\n"), notice.trim()].filter(Boolean).join("\n\n");
  return {
    text: Buffer.byteLength(output, "utf8") <= maxBytes ? output : trimToBytes(notice.trim(), maxBytes),
    truncated: true,
    omittedEvidence,
    deduplicatedBlocks: deduplicated.count,
    deduplicatedBytes: deduplicated.bytes,
  };
}

export function capText(
  text: string,
  maxBytes = MAX_BYTES,
  maxLines?: number,
): { text: string; truncated: boolean; omittedEvidence: EvidenceAnchor[] } {
  const lines = text.split(/\r?\n/);
  let output = maxLines === undefined ? lines.join("\n") : lines.slice(0, maxLines).join("\n");
  const truncated = maxLines !== undefined && lines.length > maxLines || Buffer.byteLength(output, "utf8") > maxBytes;
  if (!truncated) return { text: output, truncated: false, omittedEvidence: [] };

  const limit = `${maxBytes} bytes${maxLines === undefined ? "" : `/${maxLines} lines`}`;
  const notice = `\n\n[Truncated; omitted content. Cap: ${limit}.]`;
  if (Buffer.byteLength(notice, "utf8") > maxBytes)
    return { text: trimToBytes("[Truncated; omitted content.]", maxBytes), truncated: true, omittedEvidence: [] };
  output = trimToBytes(output, maxBytes - Buffer.byteLength(notice, "utf8"));
  return { text: `${output}${notice}`, truncated: true, omittedEvidence: [] };
}
