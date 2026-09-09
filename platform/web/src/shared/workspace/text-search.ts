import { Text } from "@codemirror/state";
import { SearchQuery } from "@codemirror/search";
import type { WorkspaceSearchQuery } from "./workspace-search.ts";

export type TextSearchRange = { start: number; end: number };
export type TextSearchHit = { line: number; start: number; end: number };
export interface TextSearchMatches {
  /** Ranges are UTF-16 offsets relative to each source line. */
  ranges: Map<number, TextSearchRange[]>;
  hits: TextSearchHit[];
  invalidRegex: boolean;
  truncated: boolean;
}

/** Both file surfaces use CodeMirror's matching rules; workspace-only filters do not apply. */
export function fileSearchQuery(query?: WorkspaceSearchQuery): SearchQuery {
  return new SearchQuery({ search: query?.query ?? "", regexp: query?.regex,
    caseSensitive: query?.caseSensitive, wholeWord: query?.wholeWord, literal: true });
}

/** Recompute against the displayed source, never stale server snippet offsets. */
export function findTextMatches(text: string, query: WorkspaceSearchQuery): TextSearchMatches {
  const result: TextSearchMatches = { ranges: new Map(), hits: [], invalidRegex: false, truncated: false };
  const search = fileSearchQuery(query);
  if (!search.valid) {
    result.invalidRegex = Boolean(query.query && query.regex);
    return result;
  }
  const doc = Text.of(text.split("\n"));
  const cursor = search.getCursor(doc);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    const { from: start, to: end } = next.value;
    if (start === end) continue;
    if (result.hits.length === 10000) { result.truncated = true; break; }
    const first = doc.lineAt(start);
    result.hits.push({ line: first.number, start, end });
    for (let number = first.number; number <= doc.lines; number++) {
      const line = doc.line(number);
      if (line.from >= end) break;
      const from = Math.max(start, line.from) - line.from;
      const to = Math.min(end, line.to) - line.from;
      if (from >= to) continue;
      const ranges = result.ranges.get(number) ?? [];
      ranges.push({ start: from, end: to });
      result.ranges.set(number, ranges);
    }
  }
  return result;
}
