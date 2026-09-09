import { Component, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { IconNote, IconPlus } from "@tabler/icons-react";
import { EditableCode, type CodeEditing } from "../rendering/editable-code";
import { AnnotationCard, AnnotationEditor, useAnnotations } from "./annotations";
import { captureAnnotation, sourceHash, type Annotation } from "../../shared/workspace/annotations";
import type { WorkspaceSearchQuery } from "../../shared/workspace/workspace-search";

interface Props {
  path: string;
  text: string;
  revision: string;
  targetLine?: number;
  searchQuery?: WorkspaceSearchQuery;
  editing: CodeEditing;
  renderToolbar: (actions: ReactNode) => ReactNode;
}

class EditorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error("Workspace editor failed; using plain text", error); }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

export default function WorkspaceCodeEditor(props: Props) {
  return <EditorBoundary key={props.path} fallback={<>
    {props.renderToolbar(null)}
    <div className="code-viewer-error" role="alert">Code editing failed. Your draft is preserved; plain-text editing is available.</div>
    <textarea className="workspace-text-input" aria-label={`Edit ${props.path}`} value={props.text}
      readOnly={props.editing.readOnly} maxLength={props.editing.maxLength} spellCheck={false} wrap="off"
      onChange={event => props.editing.onChange(event.target.value)} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !event.nativeEvent.isComposing) {
          event.preventDefault(); props.editing.onSave();
        }
      }} />
  </>}><Editor {...props} /></EditorBoundary>;
}

/** React manages notes and chrome. CodeMirror owns input, selection and undo; Shiki runs off-thread. */
function Editor({ path, text, revision, targetLine, searchQuery, editing, renderToolbar }: Props) {
  const annotations = useAnnotations();
  const placement = useId();
  const release = useRef(annotations?.releaseEditor);
  release.current = annotations?.releaseEditor;
  useEffect(() => () => release.current?.(placement), [placement]);
  const identity = useMemo(() => ({ path, text, revision }), [path, text, revision]);
  const current = useRef(identity);
  current.current = identity;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const notes = useMemo(() => (annotations?.notes ?? []).filter(note => note.kind === "current" && note.path === path), [annotations?.notes, path]);
  const edit = annotations?.editor?.placement === placement ? annotations.editor : undefined;
  const [hashed, setHashed] = useState<{ identity: typeof identity; hash: string }>();
  const [error, setError] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [selection, setSelection] = useState<{ from: number; to: number; code: string }>();
  const [open, setOpen] = useState(new Set<string>());
  const shell = useRef<HTMLDivElement>(null);
  const [noteTarget, setNoteTarget] = useState<{ line: number; token: number }>();
  const hash = hashed?.identity === identity ? hashed.hash : undefined;
  const needsHash = notes.length > 0 || Boolean(edit);
  useEffect(() => {
    if (!needsHash) return;
    let active = true;
    // Edits invalidate markers immediately; only matching settled text restores them.
    const timer = setTimeout(() => {
      void sourceHash(text).then(hash => {
        if (active) setHashed({ identity, hash });
      }).catch(() => { if (active) setError("Source fingerprint unavailable; notes cannot be matched safely."); });
    }, 120);
    return () => { active = false; clearTimeout(timer); };
  }, [identity, needsHash]);
  const matching = useMemo(() => hash ? notes.filter(note => note.hash === hash).sort((a, b) => a.from - b.from) : [], [notes, hash]);
  const inlineEdit = edit?.anchor.hash === hash && hash !== undefined ? edit : undefined;
  const reveal = useRef<(note: Annotation) => boolean>(() => false);
  reveal.current = note => {
    if (!shell.current?.getClientRects().length || !matching.some(item => item.id === note.id && item.version === note.version)) return false;
    if (text.split("\n").slice(note.from - 1, note.to).join("\n") !== note.code) return false;
    setOpen(current => new Set(current).add(note.id));
    setNoteTarget(current => ({ line: note.from, token: (current?.token ?? 0) + 1 }));
    annotations?.showNote(note.id, placement);
    return true;
  };
  useEffect(() => annotations?.registerViewer(placement, note => reveal.current(note)), [placement, Boolean(annotations), matching]);
  useEffect(() => {
    if (annotations?.activeNote && !annotations.sourceShown) reveal.current(annotations.activeNote);
  }, [annotations?.activeNote, annotations?.sourceShown, matching]);
  const closeNote = (id: string) => {
    setOpen(current => { const next = new Set(current); next.delete(id); return next; });
    if (annotations?.activeNote?.id === id) annotations.showNote(undefined, placement);
  };
  const blocks = useMemo(() => {
    const byLine = new Map<number, ReactNode[]>();
    const append = (line: number, child: ReactNode) => byLine.set(line, [...(byLine.get(line) ?? []), child]);
    if (inlineEdit) append(inlineEdit.anchor.to, <AnnotationEditor key={inlineEdit.id} />);
    for (const note of matching) if (open.has(note.id) && note.id !== inlineEdit?.original?.id) {
      append(note.to, <AnnotationCard key={note.id} note={note} placement={placement} onClose={() => closeNote(note.id)} />);
    }
    return [...byLine].map(([line, children]) => ({ key: `line:${line}`, line, children }));
  }, [matching, open, inlineEdit, placement, annotations?.activeNote?.id]);

  const addNote = async () => {
    if (!selection || !annotations || capturing) return;
    const captured = identity;
    setCapturing(true); setError("");
    try {
      const anchor = await captureAnnotation(selection, path, { kind: "current", revision: `Working copy: ${revision}` }, text);
      annotations.assertSession();
      if (!mounted.current || current.current !== captured) throw new Error("Displayed source changed. Select the lines again.");
      annotations.beginEdit(anchor, undefined, placement);
      setHashed({ identity, hash: anchor.hash! });
    } catch (error) { if (mounted.current) setError((error as Error).message); }
    finally { if (mounted.current) setCapturing(false); }
  };
  const actions = annotations ? <div className="annotation-actions" role="group" aria-label="Notes">
    <button className="secondary-button" type="button" disabled={!selection || capturing || Boolean(edit) || !annotations.ready}
      onClick={() => void addNote()}><IconPlus size={14} aria-hidden="true" />{capturing ? "Capturing…" : "Add note"}</button>
    <button className="secondary-button" type="button" onClick={() => annotations.open()}><IconNote size={14} aria-hidden="true" />Notes <span className="annotation-count">{annotations.notes.length}</span></button>
    {annotations.editor && !inlineEdit && <button className="secondary-button" type="button" onClick={() => annotations.open()}>Resume note</button>}
  </div> : null;
  return <div className="code-viewer-shell" ref={shell}>
    {renderToolbar(actions)}
    {notes.length > matching.length && <div className="annotation-notice" role="status">{notes.length - matching.length} notes don’t match this source. View captured code in Notes.</div>}
    {error && <div className="code-viewer-error" role="alert">{error}</div>}
    <EditableCode text={text} path={path} editing={editing} targetLine={noteTarget?.line ?? targetLine} navigationToken={noteTarget?.token} searchQuery={searchQuery} notes={matching} openNotes={open}
      onToggleNote={id => { if (open.has(id)) closeNote(id); else { setOpen(current => new Set(current).add(id)); annotations?.showNote(id, placement); } }}
      onSelection={(from, to, code) => setSelection(previous => code === undefined
        ? undefined
        : previous?.from === from && previous.to === to && previous.code === code ? previous : { from, to, code })}
      noteActionLine={annotations?.ready && !edit && !capturing ? selection?.to : undefined}
      onAddNote={() => void addNote()} blocks={blocks} />
  </div>;
}
