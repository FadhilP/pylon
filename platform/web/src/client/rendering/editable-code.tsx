import {
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  WidgetType,
  Decoration,
  ViewPlugin,
  drawSelection,
  gutter,
  highlightActiveLine,
  keymap,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Annotation } from "../../shared/workspace/annotations";
import { codeEditLimit, selectedCodeLines, paintedSyntax, paintSyntax, paintCode, paintedCode } from "./editable-code-state";
import type { GitLineChange } from "../../shared/workspace/code-viewer-model";
import { getSyntaxTheme, subscribeSyntaxHighlighting, installTokenStyles } from "./syntax-highlighting";
import { EditorAnalysisRequests, type EditorAnalysisInput, type EditorAnalysisResult } from "./editor-analysis";
import { lintKeymap, setDiagnostics } from "@codemirror/lint";
import { search, searchKeymap, setSearchQuery, openSearchPanel, closeSearchPanel } from "@codemirror/search";
import { findWidget } from "./find-widget";
import type { WorkspaceSearchQuery } from "../../shared/workspace/workspace-search";
import { fileSearchQuery } from "../../shared/workspace/text-search";
import { editorAssistance } from "./editor-language";
import "./editable-code.css";

export interface CodeEditing {
  readOnly: boolean;
  maxLength: number;
  gitIndexText?: string;
  onChange: (text: string) => void;
  onSave: () => void;
}
interface CodeBlock {
  key: string;
  line: number;
  children: ReactNode;
}
interface Props {
  text: string;
  path: string;
  editing: CodeEditing;
  targetLine?: number;
  searchQuery?: WorkspaceSearchQuery;
  navigationToken?: number;
  notes: readonly Annotation[];
  openNotes: Set<string>;
  onToggleNote: (id: string) => void;
  onSelection: (from: number, to: number, code?: string) => void;
  noteActionLine?: number;
  onAddNote: () => void;
  blocks: CodeBlock[];
}


class NoteBlock extends WidgetType {
  private observer?: ResizeObserver;
  constructor(readonly dom: HTMLElement) {
    super();
  }
  eq(other: NoteBlock) {
    return this.dom === other.dom;
  }
  toDOM(view: EditorView) {
    this.observer = new ResizeObserver(() => {
      if (this.dom.isConnected) this.dom.dataset.height = String(this.dom.getBoundingClientRect().height);
      view.requestMeasure();
    });
    this.observer.observe(this.dom);
    return this.dom;
  }
  get estimatedHeight() {
    return Number(this.dom.dataset.height) || 200;
  }
  destroy() {
    this.observer?.disconnect();
  }
}

class LineMarker extends GutterMarker {
  constructor(
    readonly line: number,
    readonly selected: boolean,
    readonly note: Annotation | undefined,
    readonly expanded: boolean,
    readonly canAdd: boolean,
    readonly current: { current: Props },
    readonly gitChange: GitLineChange | undefined,
  ) {
    super();
  }
  eq(other: LineMarker) {
    return (
      this.line === other.line &&
      this.selected === other.selected &&
      this.note === other.note &&
      this.expanded === other.expanded &&
      this.canAdd === other.canAdd && this.gitChange === other.gitChange
    );
  }
  toDOM(view: EditorView) {
    const wrapper = document.createElement("span");
    wrapper.className = `code-viewer-gutter${this.selected ? " code-editor-selected-gutter" : ""}`;
    if (this.gitChange) {
      const change = this.gitChange;
      const marker = document.createElement("span");
      marker.className = `code-editor-git is-${change.kind}${change.kind === "deleted" ? ` is-${change.edge}` : ""}`;
      marker.title = change.kind === "deleted" ? `Lines deleted ${change.edge === "both" ? "before and after" : change.edge} line ${this.line} relative to Git index` : `Line ${this.line} ${change.kind} relative to Git index`;
      marker.setAttribute("role", "img");
      marker.setAttribute("aria-label", marker.title);
      wrapper.append(marker);
    }
    if (this.note) {
      const note = this.note;
      const edge = document.createElement("button");
      edge.type = "button";
      edge.className = `annotation-edge${note.from === this.line ? " is-first" : ""}${note.to === this.line ? " is-last" : ""}`;
      edge.title = `Note: ${note.body}`;
      edge.setAttribute("aria-label", `Read note on lines ${note.from} to ${note.to}`);
      edge.setAttribute("aria-expanded", String(this.expanded));
      edge.onclick = () => this.current.current.onToggleNote(note.id);
      edge.dataset.noteId = note.id;
      const hover = (active: boolean) => view.dom.querySelectorAll<HTMLElement>(".annotation-edge").forEach(item => item.classList.toggle("is-note-hot", active && item.dataset.noteId === note.id));
      edge.onmouseenter = () => hover(true);
      edge.onmouseleave = () => hover(false);
      wrapper.append(edge);
    }
    if (this.canAdd) {
      const add = document.createElement("button");
      add.type = "button";
      add.className = "annotation-add";
      add.title = "Note selected lines";
      add.setAttribute("aria-label", "Create note on selected lines");
      add.onclick = () => this.current.current.onAddNote();
      wrapper.append(add);
    }
    const number = document.createElement("button");
    number.type = "button";
    number.tabIndex = -1;
    number.textContent = String(this.line);
    number.setAttribute("aria-label", `New line ${this.line}`);
    number.onmousedown = event => {
      if (event.button !== 0) return;
      event.preventDefault();
      const line = view.state.doc.line(this.line);
      const origin = view.state.doc.lineAt(view.state.selection.main.anchor);
      const backwards = event.shiftKey && line.number < origin.number;
      const anchor = event.shiftKey ? (backwards ? origin.to : origin.from) : line.from;
      view.dispatch({
        selection: EditorSelection.single(anchor, backwards ? line.from : line.to),
        scrollIntoView: true,
      });
      view.focus();
    };
    wrapper.append(number);
    return wrapper;
  }
}

export function EditableCode(props: Props) {
  const theme = useSyncExternalStore(subscribeSyntaxHighlighting, getSyntaxTheme);
  const [analysisError, setAnalysisError] = useState(false);
  const [languageError, setLanguageError] = useState(false);
  const analyses = useRef<EditorAnalysisRequests>(undefined);
  const lastAnalysis = useRef<{ doc: EditorState["doc"]; input: EditorAnalysisInput }>(undefined);
  const [comparison, setComparison] = useState<{ text: string; indexText?: string; changes?: Map<number, GitLineChange> }>();
  const comparisonCurrent = comparison?.text === props.text && comparison.indexText === props.editing.gitIndexText;
  const gitChanges = comparisonCurrent ? comparison.changes : undefined;
  // A pending comparison is not a failure. Keep the last settled status until
  // its replacement arrives so typing cannot insert/remove chrome above the editor.
  const comparisonUnavailable = props.editing.gitIndexText !== undefined && comparison !== undefined &&
    comparison.indexText === props.editing.gitIndexText && comparison.changes === undefined;
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const current = useRef(props);
  current.current = props;
  const readOnly = useRef(new Compartment());
  // Portal containers survive viewport eviction, preserving unsaved note UI and local state.
  const containers = useRef(new Map<string, NoteBlock>());
  const blocks = props.blocks.map(block => {
    let widget = containers.current.get(block.key);
    if (!widget) {
      const dom = document.createElement("div");
      dom.className = "annotation-inline code-editor-note";
      widget = new NoteBlock(dom);
      containers.current.set(block.key, widget);
    }
    return { ...block, widget, dom: widget.dom };
  });
  useLayoutEffect(() => {
    const active = new Set(props.blocks.map(block => block.key));
    for (const key of containers.current.keys()) if (!active.has(key)) containers.current.delete(key);
  }, [props.blocks]);

  const requestAnalysis = () => {
    const editor = view.current;
    if (!editor || !analyses.current) return;
    const input = current.current;
    const previous = lastAnalysis.current;
    const ranges = editor.visibleRanges.map(range => ({ from: range.from, to: range.to }));
    if (previous?.doc === editor.state.doc && previous.input.path === input.path && previous.input.theme === getSyntaxTheme() &&
      previous.input.indexText === input.editing.gitIndexText && previous.input.ranges.length === ranges.length &&
      ranges.every((range, index) => range.from === previous.input.ranges[index].from && range.to === previous.input.ranges[index].to)) return;
    const request = { text: editor.state.doc.toString(), path: input.path, theme: getSyntaxTheme(), indexText: input.editing.gitIndexText, ranges };
    lastAnalysis.current = { doc: editor.state.doc, input: request };
    analyses.current.request(request);
  };
  useEffect(() => {
    let worker: Worker;
    try { worker = new Worker(new URL("./editor-analysis.worker.ts", import.meta.url), { type: "module" }); }
    catch { setAnalysisError(true); return; }
    const requests = new EditorAnalysisRequests(request => worker.postMessage(request), (request, result) => {
      const editor = view.current;
      if (!editor || request.text !== editor.state.doc.toString() || request.path !== current.current.path ||
        request.theme !== getSyntaxTheme() || request.indexText !== current.current.editing.gitIndexText) return;
      if (result.css) installTokenStyles(result.css);
      editor.dispatch(setDiagnostics(editor.state, result.diagnostics ?? []),
        { effects: paintSyntax.of({ doc: editor.state.doc, spans: result.spans }) });
      setComparison({ text: request.text, indexText: request.indexText, changes: result.changes });
      setAnalysisError(Boolean(result.error));
    });
    analyses.current = requests;
    lastAnalysis.current = undefined;
    worker.onmessage = (event: MessageEvent<EditorAnalysisResult>) => requests.receive(event.data);
    const fail = () => {
      requests.dispose(); analyses.current = undefined; worker.terminate();
      setComparison(undefined); setAnalysisError(true);
      const editor = view.current;
      if (editor) editor.dispatch(setDiagnostics(editor.state, []),
        { effects: paintSyntax.of({ doc: editor.state.doc, spans: [] }) });
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
    requestAnalysis();
    return () => { requests.dispose(); analyses.current = undefined; worker.terminate(); };
  }, []);
  useEffect(requestAnalysis, [theme, props.path, props.editing.gitIndexText]);

  useLayoutEffect(() => {
    let analysisTimer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const scroll = view.current?.scrollDOM;
      if (!scroll) return;
      host.current?.style.setProperty("--viewer-width", `${scroll.clientWidth}px`);
      host.current?.style.setProperty("--viewer-scroll-left", `${scroll.scrollLeft}px`);
      host.current?.style.setProperty("--viewer-gutter-width", `${String(view.current!.state.doc.lines).length + 5}ch`);
    };
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: current.current.text,
        extensions: [
          history(),
          editorAssistance(current.current.path, { onLoadError: () => setLanguageError(true) }),
          search({ top: true, literal: true, createPanel: findWidget }),
          drawSelection(),
          highlightActiveLine(),
          paintedCode,
          paintedSyntax,
          ViewPlugin.fromClass(class {
            decorations = Decoration.none;
            constructor(view: EditorView) { this.paint(view); }
            update(update: { view: EditorView }) { this.paint(update.view); }
            paint(view: EditorView) {
              const ranges: ReturnType<ReturnType<typeof Decoration.line>["range"]>[] = [];
              const seen = new Set<number>();
              const notes = current.current.notes.filter(note => current.current.openNotes.has(note.id));
              for (const visible of view.visibleRanges) {
                for (let pos = visible.from; pos <= visible.to;) {
                  const line = view.state.doc.lineAt(pos);
                  if (!seen.has(line.from) && notes.some(note => note.from <= line.number && note.to >= line.number)) {
                    ranges.push(Decoration.line({ class: "is-note-open" }).range(line.from));
                    seen.add(line.from);
                  }
                  if (line.to >= view.state.doc.length) break;
                  pos = line.to + 1;
                }
              }
              this.decorations = Decoration.set(ranges, true);
            }
          }, { decorations: plugin => plugin.decorations }),
          EditorState.tabSize.of(2),
          codeEditLimit(current.current.editing.maxLength),
          readOnly.current.of(EditorState.readOnly.of(current.current.editing.readOnly)),
          EditorView.contentAttributes.of(editor => ({
            "aria-label": `Edit ${current.current.path}`,
            "aria-readonly": String(editor.state.readOnly),
            "aria-multiline": "true",
            spellcheck: "false",
            autocapitalize: "off",
            autocorrect: "off",
          })),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                current.current.editing.onSave();
                return true;
              },
            },
            ...searchKeymap,
            ...lintKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          gutter({
            class: "code-editor-numbers",
            lineMarker(editor, block) {
              const line = editor.state.doc.lineAt(block.from).number;
              const selection = selectedCodeLines(
                editor.state.doc,
                editor.state.selection.main.from,
                editor.state.selection.main.to,
              );
              const note = editor.state.field(paintedCode).notes.find(note => note.from <= line && note.to >= line);
              return new LineMarker(
                line,
                line >= selection.from && line <= selection.to,
                note,
                Boolean(note && current.current.openNotes.has(note.id)),
                current.current.noteActionLine === line,
                current,
                editor.state.field(paintedCode).gitChanges?.get(line),
              );
            },
            lineMarkerChange: update =>
              update.docChanged ||
              update.selectionSet ||
              update.transactions.some(tr => tr.effects.some(e => e.is(paintCode))),
          }),
          EditorView.updateListener.of(update => {
            if (update.docChanged) { measure(); current.current.editing.onChange(update.state.doc.toString()); }
            if (update.docChanged) {
              clearTimeout(analysisTimer);
              analysisTimer = setTimeout(requestAnalysis, 150);
            } else if (update.viewportChanged) requestAnalysis();
            if (update.docChanged || update.selectionSet) {
              const selection = selectedCodeLines(
                update.state.doc,
                update.state.selection.main.from,
                update.state.selection.main.to,
              );
              const first = update.state.doc.line(selection.from);
              const last = update.state.doc.line(selection.to);
              const hasSource = last.length > 0 || selection.to < update.state.doc.lines;
              current.current.onSelection(selection.from, selection.to,
                hasSource && last.to - first.from <= 24 * 1024 ? update.state.doc.sliceString(first.from, last.to) : undefined);
            }
          }),
          EditorView.domEventHandlers({
            scroll: () => {
              measure();
            },
          }),
        ],
      }),
    });
    view.current = editor;
    const observer = new ResizeObserver(measure);
    observer.observe(editor.scrollDOM);
    measure();
    // Gutters contain accessible note actions, not just decorative line numbers.
    editor.dom.querySelector(".cm-gutters")?.removeAttribute("aria-hidden");
    return () => {
      clearTimeout(analysisTimer);
      observer.disconnect();
      editor.destroy();
      view.current = undefined;
    };
  }, []);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    if (props.text !== editor.state.doc.toString()) {
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: props.text },
        annotations: Transaction.addToHistory.of(false),
        filter: false,
      });
    }
    editor.dispatch({
      effects: [
        ...(editor.state.readOnly !== props.editing.readOnly
          ? [readOnly.current.reconfigure(EditorState.readOnly.of(props.editing.readOnly))]
          : []),
        paintCode.of({ text: props.text, notes: props.notes, blocks, gitIndexText: props.editing.gitIndexText,
          ...(comparisonCurrent || analysisError ? { gitChanges } : {}) }),
      ],
    });
  }, [
    props.text,
    props.notes,
    props.openNotes,
    props.noteActionLine,
    props.blocks,
    props.editing.readOnly,
    props.editing.gitIndexText,
    comparisonCurrent,
    analysisError,
    gitChanges,
  ]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || !props.targetLine) return;
    const line = editor.state.doc.line(Math.min(editor.state.doc.lines, Math.max(1, props.targetLine)));
    editor.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
  }, [props.targetLine, props.navigationToken]);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const query = fileSearchQuery(props.searchQuery);
    editor.dispatch({ effects: setSearchQuery.of(query) });
    if (props.searchQuery?.query) {
      // openSearchPanel focuses the find field when the panel is already open; navigating to a
      // file must not move the caret there.
      const hadFocus = editor.hasFocus;
      openSearchPanel(editor);
      if (!hadFocus && editor.dom.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      const line = editor.state.doc.line(Math.min(editor.state.doc.lines, Math.max(1, props.targetLine ?? 1)));
      const hit = query.valid ? query.getCursor(editor.state.doc, line.from, line.to).next() : undefined;
      if (hit && !hit.done) editor.dispatch({ selection: EditorSelection.range(hit.value.from, hit.value.to),
        effects: EditorView.scrollIntoView(hit.value.from, { y: "center" }) });
    } else closeSearchPanel(editor);
  }, [props.path, props.searchQuery, props.targetLine]);

  return (
    <>
      {languageError && <div className="file-history-notice" role="status">Language assistance unavailable; document-word completion is still available.</div>}
      {analysisError && <div className="file-history-notice" role="status">Highlighting unavailable; plain-text editing is available.</div>}
      {comparisonUnavailable && <div className="file-history-notice" role="status">Git gutters unavailable: comparison exceeds the size or time limit.</div>}
      <div
        ref={host}
        className="code-viewer code-editor"
      />
      {blocks.map(block => createPortal(block.children, block.dom, block.key))}
    </>
  );
}
