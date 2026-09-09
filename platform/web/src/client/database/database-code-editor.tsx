import { useLayoutEffect, useRef, useState } from "react";
import { EditorState, StateEffect, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { lintKeymap, setDiagnostics } from "@codemirror/lint";
import { search, searchKeymap } from "@codemirror/search";
import { findWidget } from "../rendering/find-widget";
import { editorAssistance } from "../rendering/editor-language";
import { codeEditLimit } from "../rendering/editable-code-state";
import { EditorAnalysisRequests, type EditorAnalysisResult } from "../rendering/editor-analysis";
import type { DatabaseQueryEditorProps } from "./database-query-editor";

const colors = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--syntax-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
  { tag: tags.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: tags.operator, color: "var(--syntax-operator)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--syntax-function)" },
  { tag: tags.variableName, color: "var(--syntax-variable)" },
  { tag: [tags.typeName, tags.className, tags.namespace], color: "var(--syntax-type)" },
]));

/** Only the active tab owns a view/worker. Its state keeps selection and undo while hidden. */
export default function DatabaseCodeEditor(props: DatabaseQueryEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(undefined);
  const saved = useRef<EditorState>(undefined);
  const current = useRef(props);
  current.current = props;
  const syncing = useRef(false);
  const [unavailable, setUnavailable] = useState(false);
  useLayoutEffect(() => {
    if (!props.active) return;
    setUnavailable(false);
    const dialect = props.driver === "mongodb" || props.driver === "redis" ? undefined : props.driver;
    const path = dialect ? "query.sql" : "query.json";
    const label = props.driver === "mongodb" ? "MongoDB command JSON" : props.driver === "redis" ? "Redis command JSON" : "SQL query";
    let alive = true;
    let worker: Worker | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let requests: EditorAnalysisRequests | undefined;
    const analyze = () => requests?.request({ text: editor.state.doc.toString(), path, sqlDialect: dialect,
      theme: "github-light", ranges: [] });
    const extensions = [
      history(), drawSelection(), highlightActiveLine(), lineNumbers(), EditorState.tabSize.of(2), codeEditLimit(65536), colors,
      editorAssistance(path, { dialect, onLoadError: () => setUnavailable(true) }),
      search({ top: true, literal: true, createPanel: findWidget }),
      EditorView.contentAttributes.of({ "aria-label": label, "aria-multiline": "true", spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
      keymap.of([{ key: "Mod-Enter", run: view => {
        if (view.composing) return false;
        current.current.onRun(); return true;
      } }, ...searchKeymap, ...lintKeymap, ...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of(update => {
        if (!update.docChanged) return;
        if (!syncing.current) current.current.onChange(update.state.doc.toString());
        clearTimeout(debounce);
        debounce = setTimeout(analyze, 300);
      }),
    ];
    let state = saved.current
      ? saved.current.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : EditorState.create({ doc: current.current.text, extensions });
    if (state.doc.toString() !== current.current.text) state = state.update({
      changes: { from: 0, to: state.doc.length, insert: current.current.text },
      annotations: Transaction.addToHistory.of(false), filter: false,
    }).state;
    state = state.update(setDiagnostics(state, [])).state;
    const editor = new EditorView({ parent: host.current!, state });
    view.current = editor;
    const fail = () => {
      if (!alive) return;
      clearTimeout(deadline);
      requests?.dispose(); requests = undefined;
      worker?.terminate(); worker = undefined;
      setUnavailable(true);
      editor.dispatch(setDiagnostics(editor.state, []));
    };
    try {
      worker = new Worker(new URL("./database-syntax.worker.ts", import.meta.url), { type: "module" });
      requests = new EditorAnalysisRequests(request => {
        // A host-side deadline can terminate even a synchronously stuck parser.
        deadline = setTimeout(fail, 3000);
        worker!.postMessage(request);
      }, (request, result) => {
        if (!alive || request.text !== editor.state.doc.toString()) return;
        editor.dispatch(setDiagnostics(editor.state, result.diagnostics ?? []));
        if (result.error) setUnavailable(true);
      });
      worker.onmessage = (event: MessageEvent<EditorAnalysisResult>) => {
        clearTimeout(deadline);
        requests?.receive(event.data);
      };
      worker.onerror = fail;
      worker.onmessageerror = fail;
      debounce = setTimeout(analyze, 300);
    } catch { fail(); }
    return () => {
      alive = false;
      clearTimeout(debounce); clearTimeout(deadline);
      requests?.dispose(); worker?.terminate();
      saved.current = editor.state;
      editor.destroy(); view.current = undefined;
    };
  }, [props.active, props.driver]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor || props.text === editor.state.doc.toString()) return;
    syncing.current = true;
    try {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: props.text },
        annotations: Transaction.addToHistory.of(false), filter: false });
    } finally { syncing.current = false; }
  }, [props.text]);
  return <div className="database-code-editor">
    {unavailable && <small role="status">Language assistance unavailable or timed out. Editing and execution remain available.</small>}
    <div ref={host} className="database-code-host" />
  </div>;
}
