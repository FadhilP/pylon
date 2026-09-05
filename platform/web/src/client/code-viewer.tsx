import {
  Component,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  diffRows,
  parseDiff,
  selectedText,
  sourceLines,
  validateDiffContents,
  type CodeLine,
  type ContextGap,
  type DiffContents,
  type DiffContentsLoader,
  type DiffFile,
  type ExpandedContext,
} from "../shared/code-viewer-model";
import { sourceLanguage } from "../shared/markdown";
import { loadSyntaxLanguage, syntaxTokens, type SyntaxToken } from "../shared/syntax-highlighting";
import { useSyntaxHighlightingRevision } from "./use-chrome";
import { IconChevronDown, IconChevronRight, IconChevronUp } from "@tabler/icons-react";

interface ViewerProps {
  mode: "file" | "diff";
  path: string;
  text: string;
  revision: string;
  targetLine?: number;
  loadDiffFiles?: DiffContentsLoader;
  unifiedDiff?: string;
  showFileHeaders?: boolean;
  renderHeaderIcon?: (path: string) => ReactNode;
  scrollToFile?: { path: string; token: number };
}

type ViewerRow = { key: string; file: number; top: number; height: number } & (
  { kind: "header"; text: string } | ContextGap | CodeLine
);

class ViewerErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("Code viewer failed; using raw text fallback", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export default function CodeViewer(props: ViewerProps) {
  return (
    <ViewerErrorBoundary
      key={`${props.mode}:${props.path}:${props.revision}`}
      fallback={<RawText text={props.unifiedDiff ?? props.text} />}>
      <Viewer {...props} />
    </ViewerErrorBoundary>
  );
}

function RawText({ text }: { text: string }) {
  return (
    <pre className="file-code">
      <code>{text}</code>
    </pre>
  );
}

function Viewer({
  mode,
  path,
  text,
  targetLine,
  loadDiffFiles,
  unifiedDiff,
  showFileHeaders,
  renderHeaderIcon,
  scrollToFile,
}: ViewerProps) {
  const root = useRef<HTMLDivElement>(null);
  const syntaxRevision = useSyntaxHighlightingRevision();
  const files = useMemo(() => (mode === "diff" ? parseDiff(unifiedDiff ?? text) : []), [mode, text, unifiedDiff]);
  const plainLines = useMemo<CodeLine[]>(
    () =>
      mode === "file" ? sourceLines(text).map((text, index) => ({ kind: "context", text, newLine: index + 1 })) : [],
    [mode, text],
  );
  const [contents, setContents] = useState<Record<number, DiffContents>>({});
  const [expanded, setExpanded] = useState<Record<number, ExpandedContext>>({});
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string>();
  const requests = useRef(new Map<number, Promise<DiffContents>>());
  const mounted = useRef(true);
  const [viewport, setViewport] = useState({ top: 0, left: 0, height: 600, width: 800 });
  const [selection, setSelection] = useState<{ start: number; end: number }>();
  const drag = useRef<{ start: number; y: number } | undefined>(undefined);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    for (const language of new Set(
      mode === "file"
        ? [sourceLanguage(path)]
        : files.flatMap(file => [sourceLanguage(file.path), sourceLanguage(file.oldPath)]),
    ))
      void loadSyntaxLanguage(language);
  }, [files, mode, path]);

  const rows = useMemo(() => {
    const result: ViewerRow[] = [];
    let top = 8;
    const append = (file: number, key: string, row: CodeLine | ContextGap | { kind: "header"; text: string }) => {
      const height = row.kind === "header" ? 44 : row.kind === "gap" ? 32 : 20;
      const previous = result.at(-1);
      if (row.kind === "gap" && previous?.file === file && previous.kind !== "header") top += 8;
      result.push({ ...row, file, key, top, height });
      top += height;
      if (row.kind === "gap") top += 8;
    };
    if (mode === "file") plainLines.forEach((line, index) => append(0, `line:${index}`, line));
    files.forEach((file, index) => {
      if (index > 0 && result.length) top = result.at(-1)!.top + result.at(-1)!.height + 8;
      if (showFileHeaders) append(index, `header:${index}`, { kind: "header", text: file.path });
      if (collapsed.has(index)) return;
      const lines = diffRows(file, expanded[index], contents[index]);
      for (const [lineIndex, line] of lines.entries()) {
        if (line.kind === "gap" && line.count === undefined && !loadDiffFiles) continue;
        const key =
          line.kind === "gap" ? `gap:${line.id}` : `${line.kind}:${line.oldLine}:${line.newLine}:${lineIndex}`;
        append(index, `${index}:${key}`, line);
      }
      if (!file.hunks.length) append(index, `metadata:${index}`, { kind: "note", text: fileDescription(file) });
    });
    return result;
  }, [files, mode, plainLines, showFileHeaders, collapsed, expanded, contents, Boolean(loadDiffFiles)]);

  const highlighted = useMemo(() => {
    const result = new Map<string, SyntaxToken[]>();
    if (mode === "file") {
      const tokens = syntaxTokens(text, sourceLanguage(path));
      rows.forEach((row, index) => result.set(row.key, tokens[index]));
      return result;
    }
    const fileTokens = files.map((file, fileIndex) => {
      const language = sourceLanguage(file.path);
      const full = contents[fileIndex];
      const oldTokens = new Map<number, SyntaxToken[]>();
      const newTokens = new Map<number, SyntaxToken[]>();
      if (full) {
        syntaxTokens(full.oldFile.contents, sourceLanguage(file.oldPath)).forEach((tokens, index) =>
          oldTokens.set(index + 1, tokens),
        );
        syntaxTokens(full.newFile.contents, language).forEach((tokens, index) => newTokens.set(index + 1, tokens));
      } else {
        for (const hunk of file.hunks) {
          for (const side of ["oldLine", "newLine"] as const) {
            const lines = hunk.filter(line => line[side] !== undefined);
            const tokens = syntaxTokens(
              lines.map(line => line.text).join("\n"),
              side === "oldLine" ? sourceLanguage(file.oldPath) : language,
            );
            lines.forEach((line, index) =>
              (side === "oldLine" ? oldTokens : newTokens).set(line[side]!, tokens[index]),
            );
          }
        }
      }
      return { oldTokens, newTokens };
    });
    for (const row of rows) {
      if (row.kind === "gap" || row.kind === "header" || row.kind === "note") continue;
      const file = fileTokens[row.file];
      const tokens = row.kind === "deletion" ? file.oldTokens.get(row.oldLine!) : file.newTokens.get(row.newLine!);
      if (tokens) result.set(row.key, tokens);
    }
    return result;
  }, [files, rows, contents, mode, path, text, syntaxRevision]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () =>
      setViewport({
        top: element.scrollTop,
        left: element.scrollLeft,
        height: element.clientHeight,
        width: element.clientWidth,
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode, files.length === 0]);

  const getContents = async (file: number) => {
    if (contents[file]) return contents[file];
    let request = requests.current.get(file);
    if (!request) {
      request = loadDiffFiles!(files[file].path).then(value => {
        validateDiffContents(files[file], value);
        if (mounted.current) setContents(current => ({ ...current, [file]: value }));
        return value;
      });
      requests.current.set(file, request);
    }
    try {
      return await request;
    } finally {
      requests.current.delete(file);
    }
  };

  const expand = async (file: number, gap: ContextGap, direction: "start" | "end" | "all") => {
    if (!loadDiffFiles || loading.has(file)) return;
    setLoading(current => new Set(current).add(file));
    setError(undefined);
    try {
      await getContents(file);
      if (!mounted.current) return;
      setExpanded(current => {
        const previous = current[file]?.[gap.id] ?? { start: 0, end: 0 };
        const next =
          direction === "all"
            ? { start: Number.MAX_SAFE_INTEGER, end: 0 }
            : { ...previous, [direction]: previous[direction] + 15 };
        return { ...current, [file]: { ...current[file], [gap.id]: next } };
      });
      setSelection(undefined);
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current)
        setLoading(current => {
          const next = new Set(current);
          next.delete(file);
          return next;
        });
    }
  };

  const navigatedLine = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!targetLine) {
      navigatedLine.current = undefined;
      return;
    }
    if (navigatedLine.current === targetLine) return;
    const index = rows.findIndex(row => row.kind !== "gap" && row.kind !== "header" && row.newLine === targetLine);
    if (index < 0) {
      if (files.length !== 1 || !loadDiffFiles || loading.has(0) || error) return;
      const gap = rows.find(
        row =>
          row.kind === "gap" &&
          targetLine >= row.newStart &&
          (row.count === undefined || targetLine < row.newStart + row.count),
      );
      if (gap?.kind === "gap") void expand(0, gap, "all");
      return;
    }
    navigatedLine.current = targetLine;
    setSelection({ start: index, end: index });
    root.current?.scrollTo({ top: Math.max(0, rows[index].top - root.current.clientHeight / 2 + 10) });
  }, [targetLine, rows, loading, error]);

  useEffect(() => {
    if (!scrollToFile) return;
    const file = files.findIndex(file => file.path === scrollToFile.path);
    const row = rows.find(row => row.file === file);
    if (row) root.current?.scrollTo({ top: row.top });
  }, [scrollToFile?.path, scrollToFile?.token]);

  // Keep drag selection moving over unmounted rows when the pointer leaves the viewport.
  useEffect(() => {
    let frame = 0;
    const move = () => {
      const element = root.current;
      if (element && drag.current) {
        const bounds = element.getBoundingClientRect();
        const y = drag.current.y;
        if (y < bounds.top + 24) element.scrollTop -= 12;
        if (y > bounds.bottom - 24) element.scrollTop += 12;
        const end = rowAt(rows, element.scrollTop + Math.max(0, Math.min(element.clientHeight - 1, y - bounds.top)));
        setSelection(current => (current?.end === end ? current : { start: drag.current!.start, end }));
      }
      frame = requestAnimationFrame(move);
    };
    if (dragging) frame = requestAnimationFrame(move);
    return () => cancelAnimationFrame(frame);
  }, [dragging, rows]);

  const metrics = useMemo(() => {
    let widest = 0;
    let lastLine = 0;
    for (const row of rows) {
      if (row.kind === "gap" || row.kind === "header" || row.kind === "note") continue;
      widest = Math.max(widest, row.text.replaceAll("\t", "  ").length);
      lastLine = Math.max(lastLine, row.oldLine ?? 0, row.newLine ?? 0);
    }
    return { widest, gutter: String(lastLine).length + 3 };
  }, [rows]);

  if (mode === "diff" && !files.length) return <RawText text={unifiedDiff ?? text} />;
  const totalHeight = rows.length ? rows.at(-1)!.top + rows.at(-1)!.height + 8 : 36;
  const first = Math.max(0, rowAt(rows, viewport.top) - 12);
  const last = Math.min(rows.length, rowAt(rows, viewport.top + viewport.height) + 13);
  const selectionStart = selection ? Math.min(selection.start, selection.end) : -1;
  const selectionEnd = selection ? Math.max(selection.start, selection.end) : -1;

  const selectLine = (index: number, shift: boolean) => {
    setSelection(current => ({ start: shift && current ? current.start : index, end: index }));
  };

  return (
    <div className="code-viewer-shell">
      {error && (
        <div className="code-viewer-error" role="alert">
          {error}
        </div>
      )}
      <div
        ref={root}
        className={`code-viewer${mode === "diff" ? " is-diff" : ""}`}
        tabIndex={0}
        style={
          {
            "--viewer-gutter-width": `${metrics.gutter}ch`,
            "--viewer-scroll-left": `${viewport.left}px`,
            "--viewer-width": `${viewport.width}px`,
          } as CSSProperties
        }
        role="region"
        aria-label={mode === "diff" ? "File changes" : path}
        onScroll={event =>
          setViewport({
            top: event.currentTarget.scrollTop,
            left: event.currentTarget.scrollLeft,
            height: event.currentTarget.clientHeight,
            width: event.currentTarget.clientWidth,
          })
        }
        onPointerDown={event => {
          if ((event.target as HTMLElement).closest("code")) setSelection(undefined);
        }}
        onPointerMove={event => {
          if (drag.current) drag.current.y = event.clientY;
        }}
        onPointerUp={() => {
          drag.current = undefined;
          setDragging(false);
        }}
        onPointerCancel={() => {
          drag.current = undefined;
          setDragging(false);
        }}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
            event.preventDefault();
            setSelection({ start: 0, end: rows.length - 1 });
          }
          if (event.key === "Escape") setSelection(undefined);
          if (event.target !== event.currentTarget || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const direction = event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
          let index =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? rows.length - 1
                : selection
                  ? selection.end + direction
                  : rowAt(rows, viewport.top);
          while (index >= 0 && index < rows.length && ["header", "gap", "note"].includes(rows[index].kind))
            index += direction;
          if (index < 0 || index >= rows.length) return;
          selectLine(index, event.shiftKey);
          if (rows[index].top < viewport.top) root.current?.scrollTo({ top: rows[index].top });
          else if (rows[index].top + 20 > viewport.top + viewport.height)
            root.current?.scrollTo({ top: rows[index].top + 20 - viewport.height });
        }}
        onCopy={event => {
          if (!selection) return;
          event.clipboardData.setData("text/plain", selectedText(rows, selectionStart, selectionEnd));
          event.preventDefault();
        }}>
        <div
          className="code-viewer-content"
          style={{ height: totalHeight, minWidth: `${metrics.widest + metrics.gutter + 2}ch` }}>
          {rows.slice(first, last).map((row, offset) => {
            const index = first + offset;
            const style = { top: row.top, height: row.height };
            if (row.kind === "header") {
              const file = files[row.file];
              const additions = file.hunks.reduce(
                (count, hunk) => count + hunk.filter(line => line.kind === "addition").length,
                0,
              );
              const deletions = file.hunks.reduce(
                (count, hunk) => count + hunk.filter(line => line.kind === "deletion").length,
                0,
              );
              return (
                <button
                  key={row.key}
                  className="code-viewer-header"
                  style={style}
                  aria-expanded={!collapsed.has(row.file)}
                  onClick={() => {
                    setSelection(undefined);
                    setCollapsed(current => {
                      const next = new Set(current);
                      if (next.has(row.file)) next.delete(row.file);
                      else next.add(row.file);
                      return next;
                    });
                  }}>
                  {collapsed.has(row.file) ? (
                    <IconChevronRight size={14} aria-hidden="true" />
                  ) : (
                    renderHeaderIcon?.(row.text)
                  )}
                  <span className="code-viewer-path">{row.text}</span>
                  <span className="code-viewer-counts">
                    {file.hunks.length ? (
                      <>
                        <del>−{deletions}</del>
                        <ins>+{additions}</ins>
                      </>
                    ) : (
                      fileDescription(file)
                    )}
                  </span>
                </button>
              );
            }
            if (row.kind === "gap")
              return (
                <div key={row.key} className="code-viewer-gap" style={style}>
                  {loadDiffFiles && (
                    <span className="code-viewer-expand">
                      {row.id > 0 && (
                        <button
                          disabled={loading.has(row.file)}
                          aria-label="Expand 15 lines below"
                          onClick={() => void expand(row.file, row, "start")}>
                          <IconChevronDown size={14} aria-hidden="true" />
                        </button>
                      )}
                      {row.id < files[row.file].hunks.length && (
                        <button
                          disabled={loading.has(row.file)}
                          aria-label="Expand 15 lines above"
                          onClick={() => void expand(row.file, row, "end")}>
                          <IconChevronUp size={14} aria-hidden="true" />
                        </button>
                      )}
                    </span>
                  )}
                  <span className="code-viewer-context-label">
                    {loading.has(row.file)
                      ? "Loading context…"
                      : row.count === undefined
                        ? "More unchanged context may be available"
                        : `${row.count} unmodified lines`}
                  </span>
                  {loadDiffFiles && (
                    <button
                      className="code-viewer-expand-all"
                      disabled={loading.has(row.file)}
                      aria-label="Expand all unchanged lines"
                      onClick={() => void expand(row.file, row, "all")}>
                      Expand all
                    </button>
                  )}
                </div>
              );
            if (row.kind === "note")
              return (
                <div key={row.key} className="code-viewer-note" style={style}>
                  {row.text}
                </div>
              );
            const gutter = (side: "oldLine" | "newLine") =>
              row[side] === undefined ? (
                <span />
              ) : (
                <button
                  aria-label={`${side === "oldLine" ? "Old" : "New"} line ${row[side]}`}
                  tabIndex={-1}
                  onPointerDown={event => {
                    event.preventDefault();
                    const start = event.shiftKey && selection ? selection.start : index;
                    drag.current = { start, y: event.clientY };
                    setDragging(true);
                    root.current?.setPointerCapture(event.pointerId);
                    root.current?.focus({ preventScroll: true });
                    selectLine(index, event.shiftKey);
                  }}>
                  {row[side]}
                </button>
              );
            return (
              <div
                key={row.key}
                className={`code-viewer-line is-${row.kind}${index >= selectionStart && index <= selectionEnd ? " is-selected" : ""}`}
                style={style}
                data-row={index}
                role="group"
                aria-label={`${row.kind === "deletion" ? "Deleted line" : row.kind === "addition" ? "Added line" : "Line"} ${row.newLine ?? row.oldLine}`}>
                <span className="code-viewer-gutter" aria-hidden="true">
                  {gutter(row.kind === "deletion" ? "oldLine" : "newLine")}
                </span>
                <code>
                  <HighlightedLine line={row} tokens={highlighted.get(row.key)} />
                </code>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function rowAt(rows: ViewerRow[], top: number): number {
  let low = 0;
  let high = rows.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (rows[middle].top <= top) low = middle;
    else high = middle - 1;
  }
  return low;
}

function fileDescription(file: DiffFile): string {
  const patch = file.patch;
  if (patch.isBinary) return "Binary file";
  if (patch.isRename || patch.isCopy) return `${patch.isCopy ? "Copied" : "Renamed"} from ${file.oldPath}`;
  if (patch.oldMode && patch.newMode && patch.oldMode !== patch.newMode) return `${patch.oldMode} → ${patch.newMode}`;
  const additions = file.hunks.reduce((count, hunk) => count + hunk.filter(line => line.kind === "addition").length, 0);
  const deletions = file.hunks.reduce((count, hunk) => count + hunk.filter(line => line.kind === "deletion").length, 0);
  if (!additions && !deletions)
    return patch.isCreate ? "Empty file added" : patch.isDelete ? "Empty file deleted" : "File metadata changed";
  return `+${additions} −${deletions}`;
}

function HighlightedLine({ line, tokens }: { line: CodeLine; tokens?: SyntaxToken[] }) {
  let offset = 0;
  return (tokens ?? [{ content: line.text, className: "" }]).map((token, index) => {
    const start = offset;
    offset += token.content.length;
    const parts: ReactNode[] = [];
    let cursor = 0;
    for (const range of line.changes ?? []) {
      const from = Math.max(0, range.start - start);
      const to = Math.min(token.content.length, range.end - start);
      if (from >= to) continue;
      parts.push(token.content.slice(cursor, from), <mark key={from}>{token.content.slice(from, to)}</mark>);
      cursor = to;
    }
    parts.push(token.content.slice(cursor));
    return (
      <span key={index} className={token.className || undefined}>
        {parts}
      </span>
    );
  });
}
