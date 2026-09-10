import {
  annotationRange,
  captureAnnotation,
  sourceHash,
  type Annotation,
  type AnnotationSource,
} from "../../shared/workspace/annotations";
import { AnnotationCard, AnnotationEditor, useAnnotations } from "../workspace/annotations";
import {
  Component,
  Fragment,
  useId,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  attributedOwner,
  historyColor,
  type CodeAttribution,
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
} from "../../shared/workspace/code-viewer-model";
import { sourceLanguage } from "./markdown";
import { loadSyntaxLanguage, syntaxTokens, type SyntaxToken } from "./syntax-highlighting";
import type { WorkspaceSearchQuery } from "../../shared/workspace/workspace-search";
import { findTextMatches } from "../../shared/workspace/text-search";
import { useSyntaxHighlightingRevision } from "../app/use-chrome";
import { IconChevronDown, IconChevronRight, IconChevronUp, IconNote, IconPlus } from "@tabler/icons-react";

interface ViewerProps {
  mode: "file" | "diff";
  path: string;
  text: string;
  revision: string;
  targetLine?: number;
  /** Project-search context, supported only for normal full-file rendering. */
  searchQuery?: WorkspaceSearchQuery;
  wrap?: boolean;
  loadDiffFiles?: DiffContentsLoader;
  unifiedDiff?: string;
  showFileHeaders?: boolean;
  renderHeaderIcon?: (path: string) => ReactNode;
  scrollToFile?: { path: string; token: number };
  attribution?: CodeAttribution;
  onSelectOwner?: (id: string) => void;
  annotationSource?: AnnotationSource;
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

function viewerSearchQuery(query?: WorkspaceSearchQuery): WorkspaceSearchQuery {
  return {
    query: query?.query ?? "",
    regex: query?.regex,
    caseSensitive: query?.caseSensitive,
    wholeWord: query?.wholeWord,
  };
}

function Viewer({
  mode,
  path,
  text,
  revision,
  targetLine,
  searchQuery,
  wrap = false,
  loadDiffFiles,
  unifiedDiff,
  showFileHeaders,
  renderHeaderIcon,
  scrollToFile,
  attribution,
  onSelectOwner,
  annotationSource,
}: ViewerProps) {
  const root = useRef<HTMLDivElement>(null);
  const findNavigated = useRef(false);
  const findInput = useRef<HTMLInputElement>(null);
  const [find, setFind] = useState<WorkspaceSearchQuery>(() => viewerSearchQuery(searchQuery));
  const [activeFind, setActiveFind] = useState<number>();
  const [findNavigation, setFindNavigation] = useState(0);
  useEffect(() => {
    findNavigated.current = false;
    setFind(viewerSearchQuery(searchQuery));
    setActiveFind(undefined);
  }, [path, revision, searchQuery?.query, searchQuery?.regex, searchQuery?.caseSensitive, searchQuery?.wholeWord]);
  const syntaxRevision = useSyntaxHighlightingRevision();
  const files = useMemo(() => (mode === "diff" ? parseDiff(unifiedDiff ?? text) : []), [mode, text, unifiedDiff]);
  const plainLines = useMemo<CodeLine[]>(
    () =>
      mode === "file" ? sourceLines(text).map((text, index) => ({ kind: "context", text, newLine: index + 1 })) : [],
    [mode, text],
  );
  const searchMatches = useMemo(
    () => findTextMatches(mode === "file" ? text : "", mode === "file" ? find : { query: "" }),
    [mode, text, find],
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
  const annotations = useAnnotations();
  const placement = useId();
  const release = useRef(annotations?.releaseEditor);
  release.current = annotations?.releaseEditor;
  useEffect(() => () => release.current?.(placement), [placement]);
  const edit = annotations?.editor;
  const draft = useMemo(() => {
    if (!edit || edit.placement !== placement) return;
    const file =
      mode === "file" ? (edit.anchor.path === path ? 0 : -1) : files.findIndex(file => file.path === edit.anchor.path);
    return file < 0 ? undefined : { file, anchor: edit.anchor };
  }, [edit?.anchor, edit?.placement, placement, files, mode, path]);
  const sourceIdentity = useMemo(
    () => ({}),
    [mode, path, text, revision, annotationSource?.kind, annotationSource?.revision],
  );
  const identity = useRef(sourceIdentity);
  identity.current = sourceIdentity;
  const [capturing, setCapturing] = useState(false);
  const [openNotes, setOpenNotes] = useState<Set<string>>(new Set());
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const [lineHeights, setLineHeights] = useState<{ width: number; values: Record<string, number> }>({ width: 0, values: {} });
  const [hashed, setHashed] = useState<{
    identity: object;
    contents: typeof contents;
    values: Record<number, string>;
  }>();
  const hashes = useMemo(
    () => (hashed?.identity === sourceIdentity && hashed.contents === contents ? hashed.values : {}),
    [hashed, sourceIdentity, contents],
  );
  const notePaths = (annotations?.notes ?? [])
    .map(note => note.path)
    .sort()
    .join("\0");
  useEffect(() => {
    if (!annotationSource || !notePaths || (mode === "file" && !notePaths.split("\0").includes(path))) return;
    let active = true;
    const sources =
      mode === "file"
        ? [[0, text] as const]
        : Object.entries(contents).map(([index, full]) => [Number(index), full.newFile.contents] as const);
    void Promise.all(sources.map(async ([index, source]) => [index, await sourceHash(source)] as const))
      .then(values => {
        if (active) setHashed({ identity: sourceIdentity, contents, values: Object.fromEntries(values) });
      })
      .catch(() => {
        if (active) setError("Source fingerprint unavailable; notes cannot be matched safely.");
      });
    return () => {
      active = false;
    };
  }, [mode, path, text, contents, sourceIdentity, Boolean(annotationSource), notePaths]);
  const matchingNotes = useMemo(() => {
    const result = new Map<number, Annotation[]>();
    if (!annotationSource) return result;
    for (const note of annotations?.notes ?? []) {
      const file = mode === "file" ? (note.path === path ? 0 : -1) : files.findIndex(file => file.path === note.path);
      if (file < 0 || note.kind !== annotationSource.kind) continue;
      const matches = note.hash
        ? note.hash === hashes[file]
        : annotationSource.kind === "historical" && note.revision === annotationSource.revision;
      if (matches) result.set(file, [...(result.get(file) ?? []), note]);
    }
    for (const notes of result.values()) notes.sort((a, b) => a.from - b.from);
    return result;
  }, [annotations?.notes, annotationSource?.kind, annotationSource?.revision, files, mode, path, hashes]);

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

  const sourceRows = useMemo(() => {
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

  const markers = useMemo(() => {
    const result = new Map<string, Annotation>();
    for (const [file, notes] of matchingNotes) {
      let next = 0;
      const active = new Map<string, Annotation>();
      for (const row of sourceRows) {
        if (row.file !== file || row.kind === "gap" || row.kind === "header" || row.newLine === undefined) continue;
        while (next < notes.length && notes[next].from <= row.newLine) {
          const note = notes[next++];
          active.set(note.id, note);
        }
        for (const [id, note] of active) if (note.to < row.newLine) active.delete(id);
        const note = active.values().next().value;
        if (note) result.set(row.key, note);
      }
    }
    return result;
  }, [sourceRows, matchingNotes]);
  const inline = useMemo(() => {
    const result = new Map<string, Annotation[]>();
    for (const row of sourceRows) {
      if (row.kind === "gap" || row.kind === "header" || row.kind === "deletion") continue;
      const notes = (matchingNotes.get(row.file) ?? []).filter(
        note => openNotes.has(note.id) && note.to === row.newLine,
      );
      if (notes.length || (draft?.file === row.file && draft.anchor.to === row.newLine)) result.set(row.key, notes);
    }
    return result;
  }, [sourceRows, matchingNotes, openNotes, draft]);
  const rows = useMemo(() => {
    let offset = 0;
    return sourceRows.map(row => {
      const extra = inline.has(row.key) ? (cardHeights[row.key] ?? 260) : 0;
      const codeHeight = wrap && "text" in row && row.kind !== "header" && row.kind !== "note"
        ? (lineHeights.width === viewport.width ? lineHeights.values[row.key] : undefined) ?? row.height
        : row.height;
      const next = { ...row, top: row.top + offset, height: codeHeight + extra, codeHeight };
      offset += extra + codeHeight - row.height;
      return next;
    });
  }, [sourceRows, inline, cardHeights, wrap, lineHeights, viewport.width]);
  useEffect(() => {
    const initial = searchQuery?.query && targetLine ? searchMatches.hits.findIndex(hit => hit.line >= targetLine) : -1;
    setActiveFind(initial < 0 ? undefined : initial);
    findNavigated.current = false;
  }, [searchMatches.hits, targetLine, searchQuery]);
  useEffect(() => {
    if (!findNavigated.current || activeFind === undefined) return;
    const hit = searchMatches.hits[activeFind];
    const index = hit ? rows.findIndex(row => row.kind !== "gap" && row.kind !== "header" && row.newLine === hit.line) : -1;
    if (index >= 0) {
      setSelection({ start: index, end: index });
      root.current?.scrollTo({ top: Math.max(0, rows[index].top - root.current.clientHeight / 2 + 10) });
    }
  }, [activeFind, findNavigation, searchMatches.hits, rows]);
  useLayoutEffect(() => {
    if (!wrap || !root.current) return;
    const width = viewport.width;
    const observer = new ResizeObserver(entries => setLineHeights(current => {
      const values = current.width === width ? { ...current.values } : {};
      let changed = current.width !== width;
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.wrapKey!;
        const height = Math.max(20, Math.ceil(entry.contentRect.height));
        if (values[key] !== height) { values[key] = height; changed = true; }
      }
      return changed ? { width, values } : current;
    }));
    root.current.querySelectorAll<HTMLElement>("code[data-wrap-key]").forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [wrap, viewport.width, viewport.top, rows]);

  const highlighted = useMemo(() => {
    const result = new Map<string, SyntaxToken[]>();
    if (mode === "file") {
      const tokens = syntaxTokens(text, sourceLanguage(path));
      sourceRows.forEach((row, index) => result.set(row.key, tokens[index]));
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
    for (const row of sourceRows) {
      if (row.kind === "gap" || row.kind === "header" || row.kind === "note") continue;
      const file = fileTokens[row.file];
      const tokens = row.kind === "deletion" ? file.oldTokens.get(row.oldLine!) : file.newTokens.get(row.newLine!);
      if (tokens) result.set(row.key, tokens);
    }
    return result;
  }, [files, sourceRows, contents, mode, path, text, syntaxRevision]);

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

  useEffect(() => {
    if (!annotationSource || !loadDiffFiles || mode !== "diff") return;
    let active = true;
    // Only annotated files need extra reads. Share the existing validated context loader.
    void (async () => {
      for (const [index, file] of files.entries()) {
        if (!active) return;
        if (!notePaths.split("\0").includes(file.path)) continue;
        try {
          await getContents(index);
        } catch {
          /* Notes remain available in the panel as captured snapshots. */
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [files, notePaths, Boolean(loadDiffFiles), Boolean(annotationSource)]);
  useEffect(() => {
    if (!matchingNotes.size || dragging || draft) return;
    setExpanded(current => {
      let next = current;
      for (const [file, notes] of matchingNotes) {
        if (!contents[file]) continue;
        for (const gap of diffRows(files[file], undefined, contents[file])) {
          if (gap.kind !== "gap") continue;
          const end = Math.max(
            0,
            ...notes
              .filter(note => note.to >= gap.newStart && note.from < gap.newStart + (gap.count ?? 0))
              .map(note => Math.min(note.to - gap.newStart + 1, gap.count ?? 0)),
          );
          if (end <= (current[file]?.[gap.id]?.start ?? 0)) continue;
          next = {
            ...next,
            [file]: { ...next[file], [gap.id]: { start: end, end: current[file]?.[gap.id]?.end ?? 0 } },
          };
        }
      }
      return next;
    });
  }, [matchingNotes, contents, files, dragging, draft]);

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

  useEffect(() => {
    setSelection(undefined);
  }, [sourceRows]);
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
    for (const row of sourceRows) {
      if (row.kind === "gap" || row.kind === "header" || row.kind === "note") continue;
      widest = Math.max(widest, row.text.replaceAll("\t", "  ").length);
      lastLine = Math.max(lastLine, row.oldLine ?? 0, row.newLine ?? 0);
    }
    return { widest, gutter: String(lastLine).length + (annotationSource ? 5 : 3) };
  }, [sourceRows, Boolean(annotationSource)]);

  const range = useMemo(
    () => (selection ? annotationRange(sourceRows, selection.start, selection.end) : undefined),
    [sourceRows, selection],
  );
  const pinnedIndices = useMemo(
    () => sourceRows.flatMap((row, index) => (inline.has(row.key) ? [index] : [])),
    [sourceRows, inline],
  );
  const unmatchedNotes = useMemo(
    () =>
      annotationSource && annotations
        ? annotations.notes.filter(
            note =>
              note.kind === annotationSource.kind &&
              (mode === "file" ? note.path === path : files.some(file => file.path === note.path)),
          ).length - [...matchingNotes.values()].reduce((count, notes) => count + notes.length, 0)
        : 0,
    [annotations?.notes, annotationSource?.kind, mode, path, files, matchingNotes],
  );
  const reveal = useRef<(note: Annotation) => boolean>(() => false);
  reveal.current = note => {
    const file = [...matchingNotes].find(([, notes]) => notes.some(item => item.id === note.id && item.version === note.version))?.[0];
    if (file === undefined || !root.current?.getClientRects().length || (note.kind === "historical" && note.revision !== annotationSource?.revision)) return false;
    const captured = sourceRows.filter(row => row.file === file && "newLine" in row && row.newLine !== undefined && row.newLine >= note.from && row.newLine <= note.to);
    if (captured.map(row => "text" in row ? row.text : "").join("\n") !== note.code) {
      const gap = sourceRows.find(row => row.file === file && row.kind === "gap" && row.newStart <= note.to && (row.count === undefined || row.newStart + row.count > note.from));
      if (gap?.kind === "gap" && loadDiffFiles && !loading.has(file)) void expand(file, gap, "all");
      return false;
    }
    const row = rows.find(row => row.file === file && "newLine" in row && row.newLine === note.from);
    if (!row) return false;
    setOpenNotes(current => new Set(current).add(note.id));
    root.current.scrollTo({ top: Math.max(0, row.top - 24) });
    annotations?.showNote(note.id, placement);
    return true;
  };
  useEffect(() => annotations?.registerViewer(placement, note => reveal.current(note)), [placement, Boolean(annotations), matchingNotes]);
  useEffect(() => {
    if (annotations?.activeNote && !annotations.sourceShown) reveal.current(annotations.activeNote);
  }, [annotations?.activeNote, annotations?.sourceShown, matchingNotes, rows]);
  const toggleNote = (id: string) => {
    const closing = openNotes.has(id);
    setOpenNotes(current => { const next = new Set(current); if (closing) next.delete(id); else next.add(id); return next; });
    if (!closing || annotations?.activeNote?.id === id) annotations?.showNote(closing ? undefined : id, placement);
  };
  const hoverNote = (id?: string) => root.current?.querySelectorAll<HTMLElement>(".annotation-edge").forEach(edge => edge.classList.toggle("is-note-hot", edge.dataset.noteId === id));
  if (mode === "diff" && !files.length) return <RawText text={unifiedDiff ?? text} />;
  const finalRow = rows.at(-1);
  const trailingSpace = mode === "file" && finalRow ? Math.max(8, viewport.height - finalRow.height) : 8;
  const totalHeight = finalRow ? finalRow.top + finalRow.height + trailingSpace : 36;
  const first = Math.max(0, rowAt(rows, viewport.top) - 12);
  const last = Math.min(rows.length, rowAt(rows, viewport.top + viewport.height) + 13);
  const selectionStart = selection ? Math.min(selection.start, selection.end) : -1;
  const selectionEnd = selection ? Math.max(selection.start, selection.end) : -1;

  const selectLine = (index: number, shift: boolean) => {
    setSelection(current => ({ start: shift && current ? current.start : index, end: index }));
  };
  const moveFind = (direction: -1 | 1) => {
    if (!searchMatches.hits.length) return;
    setActiveFind(current =>
      ((current ?? (direction > 0 ? -1 : 0)) + direction + searchMatches.hits.length) % searchMatches.hits.length,
    );
    findNavigated.current = true;
    setFindNavigation(current => current + 1);
  };
  const findControls = mode === "file" && (
    <div className="code-viewer-find" role="search" aria-label="Find in file">
      <input
        ref={findInput}
        aria-label="Find in file"
        maxLength={2000}
        value={find.query}
        onChange={event => setFind(current => ({ ...current, query: event.target.value }))}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") { event.preventDefault(); moveFind(event.shiftKey ? -1 : 1); }
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setFind(current => ({ ...current, query: "" })); }
        }}
      />
      <span role="status">{searchMatches.invalidRegex ? "Invalid regular expression" : `${activeFind === undefined ? "" : `${activeFind + 1} / `}${searchMatches.hits.length}${searchMatches.truncated ? "+ (first 10,000)" : ""} matches`}</span>
      <button type="button" aria-label="Previous match" disabled={!searchMatches.hits.length} onClick={() => moveFind(-1)}>↑</button>
      <button type="button" aria-label="Next match" disabled={!searchMatches.hits.length} onClick={() => moveFind(1)}>↓</button>
      {(["caseSensitive", "wholeWord", "regex"] as const).map(flag => (
        <button
          key={flag}
          type="button"
          aria-label={flag === "caseSensitive" ? "Match case" : flag === "wholeWord" ? "Whole word" : "Regular expression"}
          aria-pressed={!!find[flag]}
          onClick={() => setFind(current => ({ ...current, [flag]: !current[flag] }))}>
          {flag === "caseSensitive" ? "Aa" : flag === "wholeWord" ? "|ab|" : ".*"}
        </button>
      ))}
    </div>
  );

  const addNote = async () => {
    if (!range || !annotationSource || !annotations || capturing) return;
    setCapturing(true);
    setError(undefined);
    try {
      const full =
        mode === "file" ? text : loadDiffFiles ? (await getContents(range.file)).newFile.contents : undefined;
      const anchor = await captureAnnotation(
        range,
        mode === "file" ? path : files[range.file].path,
        annotationSource,
        full,
      );
      annotations.assertSession();
      if (identity.current !== sourceIdentity) throw new Error("Displayed source changed. Select the lines again.");
      if (mounted.current) {
        annotations.beginEdit(anchor, undefined, placement);
        setSelection(undefined);
      }
    } catch (error) {
      if (mounted.current) setError((error as Error).message);
    } finally {
      if (mounted.current) setCapturing(false);
    }
  };
  // Expanded cards remain mounted offscreen so scrolling cannot discard an in-progress edit.
  const visibleIndices = [
    ...new Set([...Array.from({ length: last - first }, (_, offset) => first + offset), ...pinnedIndices]),
  ].sort((a, b) => a - b);

  const annotationCards = (row: ViewerRow) => <>
    {draft?.file === row.file && draft.anchor.to === ("newLine" in row ? row.newLine : undefined) && <AnnotationEditor key={edit?.id} />}
    {(inline.get(row.key) ?? []).filter(note => edit?.original?.id !== note.id || !draft).map(note => (
      <AnnotationCard key={note.id} note={note} placement={placement} onClose={() => toggleNote(note.id)} />
    ))}
  </>;

  const noteActions = annotationSource && annotations ? (
    <div className="annotation-actions" role="group" aria-label="Notes">
      <button
        className="secondary-button"
        type="button"
        title={range ? `Note selected lines ${range.from}–${range.to}` : "Select lines to add a note"}
        disabled={!range || capturing || Boolean(draft) || !annotations.ready}
        onClick={() => void addNote()}>
        <IconPlus size={14} aria-hidden="true" />
        {capturing ? "Capturing…" : "Add note"}
      </button>
      <button className="secondary-button" type="button" onClick={() => annotations.open()}>
        <IconNote size={14} aria-hidden="true" />
        Notes <span className="annotation-count">{annotations.notes.length}</span>
      </button>
      {annotations.editor && !draft && (
        <button className="secondary-button" type="button" onClick={() => annotations.open()}>
          Resume note
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="code-viewer-shell" onKeyDown={event => {
      if (mode !== "file" || event.defaultPrevented || event.nativeEvent.isComposing || event.shiftKey || event.altKey ||
        !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f" ||
        (event.target as HTMLElement).closest(".annotation-inline")) return;
      event.preventDefault();
      findInput.current?.focus();
      findInput.current?.select();
    }}>
      {findControls}
      {noteActions && <div className="annotation-toolbar">{noteActions}</div>}
      {unmatchedNotes > 0 && (
        <div className="annotation-notice" role="status">
          {unmatchedNotes} {unmatchedNotes === 1 ? "note doesn’t" : "notes don’t"} match this source. View captured code in Notes.
        </div>
      )}
      {error && (
        <div className="code-viewer-error" role="alert">
          {error}
        </div>
      )}
      <div
        ref={root}
        className={`code-viewer${mode === "diff" ? " is-diff" : ""}${wrap ? " is-wrapped" : ""}`}
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
          const target = event.target as HTMLElement;
          if (!target.closest(".code-viewer-line > code")) return;
          if (!annotationSource || !annotations) {
            setSelection(undefined);
            return;
          }
          if (event.button !== 0) return;
          const index = Number(target.closest("[data-row]")?.getAttribute("data-row"));
          event.preventDefault();
          drag.current = { start: event.shiftKey && selection ? selection.start : index, y: event.clientY };
          setDragging(true);
          root.current?.setPointerCapture(event.pointerId);
          root.current?.focus({ preventScroll: true });
          selectLine(index, event.shiftKey);
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
          if ((event.target as HTMLElement).closest(".annotation-inline")) return;
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
          if (!selection || (event.target as HTMLElement).closest(".annotation-inline")) return;
          event.clipboardData.setData("text/plain", selectedText(rows, selectionStart, selectionEnd));
          event.preventDefault();
        }}>
        <div
          className="code-viewer-content"
          style={{ height: totalHeight, minWidth: wrap ? undefined : `${metrics.widest + metrics.gutter + 2}ch` }}>
          {visibleIndices.map(index => {
            const row = rows[index];
            const style = { top: row.top, height: row.codeHeight };
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
            const owner = attributedOwner(row, attribution);
            const note = markers.get(row.key);
            const noteOpen = row.newLine !== undefined && matchingNotes.get(row.file)?.some(note => openNotes.has(note.id) && note.from <= row.newLine! && note.to >= row.newLine!);
            return (
              <Fragment key={row.key}>
                <div
                  className={`code-viewer-line is-${row.kind}${index >= selectionStart && index <= selectionEnd ? " is-selected" : ""}${owner && owner.id === attribution?.selected ? " is-history-owner" : ""}${noteOpen ? " is-note-open" : ""}`}
                  style={{ ...style, ...(owner ? { "--history-color": historyColor(owner.id) } : {}) } as CSSProperties}
                  data-row={index}
                  role="group"
                  aria-label={`${row.kind === "deletion" ? "Deleted line" : row.kind === "addition" ? "Added line" : "Line"} ${row.newLine ?? row.oldLine}`}>
                  <span
                    className={`code-viewer-gutter${attribution ? " has-attribution" : ""}`}
                    aria-hidden={attribution || note || annotationSource ? undefined : true}>
                    {note && (
                      <button
                        type="button"
                        className={`annotation-edge${row.newLine === note.from ? " is-first" : ""}${row.newLine === note.to ? " is-last" : ""}`}
                        title={`Note: ${note.body}`}
                        aria-label={`Read note on lines ${note.from} to ${note.to}`}
                        aria-expanded={openNotes.has(note.id)}
                        data-note-id={note.id}
                        onMouseEnter={() => hoverNote(note.id)}
                        onMouseLeave={() => hoverNote()}
                        onClick={() => toggleNote(note.id)}
                      />
                    )}
                    {annotationSource &&
                      annotations?.ready &&
                      range?.file === row.file &&
                      range.to === row.newLine &&
                      !dragging &&
                      !draft && (
                        <button
                          type="button"
                          className="annotation-add"
                          aria-label={`Create note on lines ${range.from} to ${range.to}`}
                          title="Note selected lines"
                          disabled={capturing}
                          onClick={() => void addNote()}
                        />
                      )}
                    {attribution && owner && (
                      <button
                        className="code-viewer-owner"
                        type="button"
                        disabled={!attribution.selectable.has(owner.id)}
                        title={`${owner.author ? `${owner.author} · ` : ""}${owner.title}${attribution.selectable.has(owner.id) ? "" : " · outside loaded history"}`}
                        aria-label={`Show ${owner.kind === "commit" ? "commit" : "checkpoint"}: ${owner.title}${owner.author ? ` by ${owner.author}` : ""}`}
                        onClick={() => onSelectOwner?.(owner.id)}
                      />
                    )}
                    {gutter(row.kind === "deletion" ? "oldLine" : "newLine")}
                  </span>
                  <code data-wrap-key={wrap ? row.key : undefined}>
                    <HighlightedLine line={row} tokens={highlighted.get(row.key)} highlights={mode === "file" ? searchMatches.ranges.get(row.newLine!) : undefined} />
                  </code>
                </div>
                {inline.has(row.key) && (
                  <AnnotationInline
                    top={row.top + row.codeHeight}
                    onHeight={height =>
                      setCardHeights(current =>
                        current[row.key] === height ? current : { ...current, [row.key]: height },
                      )
                    }>
                    {annotationCards(row)}
                  </AnnotationInline>
                )}
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function AnnotationInline({
  top,
  onHeight,
  children,
}: {
  top: number;
  onHeight: (height: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const report = useRef(onHeight);
  report.current = onHeight;
  useLayoutEffect(() => {
    const element = ref.current!;
    const update = () => report.current(Math.ceil(element.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="annotation-inline" style={{ top }}>
      {children}
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

export function HighlightedLine({
  line,
  tokens,
  highlights,
}: {
  line: CodeLine;
  tokens?: SyntaxToken[];
  highlights?: { start: number; end: number }[];
}) {
  const ranges = [...(line.changes ?? []), ...(highlights ?? [])].sort((left, right) => left.start - right.start || left.end - right.end);
  let offset = 0;
  return (tokens ?? [{ content: line.text, className: "" }]).map((token, index) => {
    const start = offset;
    offset += token.content.length;
    const parts: ReactNode[] = [];
    let cursor = 0;
    for (const range of ranges) {
      const from = Math.max(cursor, range.start - start);
      const to = Math.min(token.content.length, range.end - start);
      if (from >= to) continue;
      parts.push(token.content.slice(cursor, from), <mark key={`${from}:${to}`}>{token.content.slice(from, to)}</mark>);
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
