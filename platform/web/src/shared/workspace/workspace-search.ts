import { validRelativePath } from "./file-search.ts";

export interface WorkspaceSearchQuery {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  glob?: string;
  touched?: boolean;
}

export interface WorkspaceSearchMatch {
  line: number;
  text: string;
  /** UTF-16 offsets in text. Regex results may intentionally omit ranges. */
  ranges: { start: number; end: number }[];
}

export interface WorkspaceSearchFile {
  path: string;
  matches: WorkspaceSearchMatch[];
  capped: boolean;
  changed: boolean;
}

export interface WorkspaceSearchResult {
  protocolVersion: number;
  sessionGeneration: number;
  engine: "rg" | "grep";
  files: WorkspaceSearchFile[];
  truncated: boolean;
  inventoryTruncated: boolean;
  skipped: number;
  elapsedMs: number;
  timedOut: boolean;
}

export interface WorkspaceSymbol {
  name: string;
  kind: string;
  path: string;
  line: number;
  column: number;
  signature: string;
}

export interface WorkspaceSymbolResult {
  protocolVersion: number;
  sessionGeneration: number;
  symbols: WorkspaceSymbol[];
  moreAvailable: boolean;
}

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object";
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Validate streamed data before it can update navigation or render source ranges. */
export function isWorkspaceSearchResult(value: unknown): value is WorkspaceSearchResult {
  return (
    record(value) &&
    nonnegative(value.protocolVersion) &&
    nonnegative(value.sessionGeneration) &&
    (value.engine === "rg" || value.engine === "grep") &&
    typeof value.truncated === "boolean" &&
    typeof value.inventoryTruncated === "boolean" &&
    typeof value.timedOut === "boolean" &&
    nonnegative(value.skipped) &&
    nonnegative(value.elapsedMs) &&
    Array.isArray(value.files) &&
    value.files.length <= 100 &&
    value.files.every(
      (file: unknown) =>
        record(file) &&
        typeof file.path === "string" &&
        validRelativePath(file.path) &&
        typeof file.capped === "boolean" &&
        typeof file.changed === "boolean" &&
        Array.isArray(file.matches) &&
        file.matches.length <= 20 &&
        file.matches.every(
          (match: unknown) =>
            record(match) &&
            nonnegative(match.line) &&
            match.line > 0 &&
            typeof match.text === "string" &&
            match.text.length <= 4000 &&
            Array.isArray(match.ranges) &&
            match.ranges.length <= 100 &&
            match.ranges.every(
              (range: unknown) =>
                record(range) &&
                nonnegative(range.start) &&
                nonnegative(range.end) &&
                range.end >= range.start &&
                range.end <= match.text.length,
            ),
        ),
    )
  );
}

export function isWorkspaceSymbolResult(value: unknown): value is WorkspaceSymbolResult {
  return (
    record(value) &&
    nonnegative(value.protocolVersion) &&
    nonnegative(value.sessionGeneration) &&
    typeof value.moreAvailable === "boolean" &&
    Array.isArray(value.symbols) &&
    value.symbols.length <= 200 &&
    value.symbols.every(
      (symbol: unknown) =>
        record(symbol) &&
        typeof symbol.path === "string" &&
        validRelativePath(symbol.path) &&
        typeof symbol.name === "string" &&
        symbol.name.length <= 500 &&
        typeof symbol.kind === "string" &&
        symbol.kind.length <= 100 &&
        typeof symbol.signature === "string" &&
        symbol.signature.length <= 1000 &&
        nonnegative(symbol.line) &&
        symbol.line > 0 &&
        nonnegative(symbol.column),
    )
  );
}
