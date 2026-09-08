import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { IconNote, IconRefresh, IconTrash, IconX } from "@tabler/icons-react";
import { createPortal } from "react-dom";
import { ActionDialog } from "../ui/action-dialog";
import { sourceLanguage } from "../rendering/markdown";
import { loadSyntaxLanguage, syntaxTokens } from "../rendering/syntax-highlighting";
import { useSyntaxHighlightingRevision } from "../app/use-chrome";
import { FileTypeIcon } from "../rendering/file-icons";
import {
  AnnotationReads,
  annotationPrompt,
  persistAnnotation,
  reviewAnnotations,
  type Annotation,
  type AnnotationAnchor,
  type AnnotationList,
} from "../../shared/workspace/annotations";
import { runtimeStore } from "../runtime/event-store";
import "./annotations.css";

interface AnnotationEdit {
  id: string;
  scope: string;
  anchor: AnnotationAnchor;
  original?: Annotation;
  body: string;
  placement?: string;
}
type NotesContext = {
  notes: Annotation[];
  picked: Annotation[];
  ready: boolean;
  busy: boolean;
  error: string;
  editor?: AnnotationEdit;
  remove: (note: Annotation) => Promise<void>;
  save: (edit: AnnotationEdit) => Promise<Annotation>;
  beginEdit: (anchor: AnnotationAnchor, original?: Annotation, placement?: string) => void;
  changeEdit: (id: string, change: { body: string }) => void;
  finishEdit: (id: string) => void;
  releaseEditor: (placement: string) => void;
  toggle: (note: Annotation, selected: boolean) => void;
  clearSubmitted: (notes: readonly Annotation[]) => void;
  reload: () => Promise<AnnotationList | undefined>;
  prepare: (message: string) => Promise<{ text: string; notes: Annotation[] } | undefined>;
  assertSession: () => void;
  open: (note?: Annotation) => void;
  activeNote?: Annotation;
  sourceShown: boolean;
  showNote: (id: string | undefined, placement: string) => void;
  registerViewer: (placement: string, reveal: (note: Annotation) => boolean) => () => void;
};
const Context = createContext<NotesContext | undefined>(undefined);
export const useAnnotations = () => useContext(Context);

export function AnnotationCount() {
  const store = useAnnotations();
  return store?.ready ? <span className="annotation-total" aria-label={`${store.notes.length} saved notes`}>{store.notes.length}</span> : null;
}

/** Server-owned drafts. Only the unfinished editor buffer and attachment choices are page-local. */
export function AnnotationProvider({
  sessionId,
  generation,
  onOpen,
  children,
}: {
  sessionId: string;
  generation: number;
  onOpen: () => void;
  children: ReactNode;
}) {
  const key = `${sessionId}:${generation}`;
  const isConnected = () => {
    const live = runtimeStore.getSnapshot();
    return (
      live.connection === "connected" &&
      live.runtime?.ready === true &&
      live.runtime.sessionId === sessionId &&
      live.runtime.sessionGeneration === generation
    );
  };
  const connected = useSyncExternalStore(runtimeStore.subscribe, isConnected, isConnected);
  const active = useRef(key);
  active.current = key;
  const [loaded, setLoaded] = useState<AnnotationList>();
  const notes = useMemo(
    () => (loaded?.sessionId === sessionId && loaded.sessionGeneration === generation ? loaded.notes : []),
    [loaded, sessionId, generation],
  );
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const [activeNoteId, setActiveNoteId] = useState<string>();
  const [shown, setShown] = useState<{ id: string; placement: string }>();
  const viewers = useRef(new Map<string, (note: Annotation) => boolean>());
  const [readyKey, setReadyKey] = useState("");
  const ready = connected && readyKey === key;
  const [error, setError] = useState("");
  const [unfinished, setUnfinished] = useState<AnnotationEdit>();
  const editor = loaded?.sessionId === sessionId && unfinished?.scope === loaded.scope ? unfinished : undefined;
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const mounted = useRef(true);
  const reads = useRef(new AnnotationReads());
  const request = { sessionId, expectedGeneration: generation };
  const assertSession = () => {
    if (!mounted.current || active.current !== key || !isConnected())
      throw new Error("Session changed or disconnected. Review the notes in the intended session before sending.");
  };
  const reload = async () => {
    if (!sessionId || active.current !== key || !mounted.current || !isConnected()) return;
    return reads.current.read(
      () => runtimeStore.annotationNotes(request),
      result => {
        if (!mounted.current || active.current !== key || !isConnected()) return;
        setLoaded(current =>
          current?.scope === result.scope &&
          current.sessionGeneration === result.sessionGeneration &&
          current.notes.length === result.notes.length &&
          current.notes.every(
            (note, index) => note.id === result.notes[index].id && note.version === result.notes[index].version,
          )
            ? current
            : result,
        );
        setReadyKey(key);
        setError("");
        setSelected(
          current =>
            new Map(
              [...current].filter(([id, version]) =>
                result.notes.some(note => note.id === id && note.version === version),
              ),
            ),
        );
      },
      error => {
        if (mounted.current && active.current === key && isConnected()) {
          setReadyKey("");
          setError((error as Error).message || "Note storage is unavailable.");
        }
      },
    );
  };
  useEffect(() => {
    mounted.current = true;
    setSelected(new Map());
    setActiveNoteId(undefined);
    setShown(undefined);
    return () => {
      mounted.current = false;
    };
  }, [key]);
  useEffect(() => {
    setReadyKey("");
    setError("");
    if (connected) void reload();
    const refresh = () => {
      if (!document.hidden) void reload();
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      reads.current.invalidate();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [key, connected]);
  useEffect(() => {
    if (!unfinished || unfinished.body === (unfinished.original?.body ?? "")) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unfinished]);
  const picked = useMemo(() => notes.filter(note => selected.get(note.id) === note.version), [notes, selected]);
  const mutate = async (id: string, expectedVersion?: number, note?: Annotation) => {
    assertSession();
    if (writing.current) throw new Error("Wait for the current note save to finish.");
    writing.current = true;
    setBusy(true);
    reads.current.invalidate();
    try {
      // A mutation response can precede a newer commit but arrive later. Only a fresh GET updates the list.
      await persistAnnotation(
        note,
        id,
        () => runtimeStore.annotationNotes(request, { ...request, id, expectedVersion, note }),
        reload,
        assertSession,
      );
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const toggle = (note: Annotation, picked: boolean) =>
    setSelected(current => {
      const next = new Map(current);
      if (picked) next.set(note.id, note.version);
      else next.delete(note.id);
      return next;
    });
  const prepare: NotesContext["prepare"] = async message => {
    assertSession();
    const frozen = structuredClone(picked);
    const reviewed = await reviewAnnotations(frozen, async path => {
      assertSession();
      const value = await runtimeStore.workspaceFile(path, "current");
      assertSession();
      return value.state === "available" && !value.truncated ? value.text : undefined;
    });
    assertSession();
    const text = annotationPrompt(message, reviewed);
    const stale = reviewed.filter(item => item.state !== "current");
    if (
      stale.length &&
      !window.confirm(
        `${stale.map(({ note, state }) => `${note.path}:${note.from}-${note.to} — ${state}`).join("\n")}\n\nSend the original captured code and notes, rather than the current file?`,
      )
    )
      return;
    assertSession();
    return { text, notes: frozen };
  };
  const value: NotesContext = {
    notes,
    picked,
    ready,
    busy,
    error,
    editor,
    activeNote: notes.find(note => note.id === activeNoteId),
    sourceShown: shown?.id === activeNoteId && Boolean(activeNoteId),
    showNote: (id, placement) => {
      setActiveNoteId(id);
      setShown(id ? { id, placement } : undefined);
    },
    registerViewer: (placement, reveal) => {
      viewers.current.set(placement, reveal);
      return () => {
        viewers.current.delete(placement);
        setShown(current => current?.placement === placement ? undefined : current);
      };
    },
    toggle,
    reload,
    assertSession,
    prepare,
    beginEdit: (anchor, original, placement) => {
      assertSession();
      if (!ready || !loaded || busy) return;
      if (
        unfinished &&
        unfinished.body !== (unfinished.original?.body ?? "") &&
        !window.confirm("Discard the unfinished note edit before starting another?")
      )
        return;
      setUnfinished({
        id: original?.id ?? crypto.randomUUID(),
        scope: loaded.scope,
        anchor,
        original,
        body: original?.body ?? "",
        placement,
      });
    },
    changeEdit: (id, change) => setUnfinished(current => (current?.id === id ? { ...current, ...change } : current)),
    finishEdit: id => setUnfinished(current => (current?.id === id ? undefined : current)),
    releaseEditor: placement =>
      setUnfinished(current => (current?.placement === placement ? { ...current, placement: undefined } : current)),
    save: async edit => {
      assertSession();
      if (!ready || !loaded) throw new Error(error || "Note storage is not ready.");
      if (edit.scope !== loaded.scope || (edit.original && edit.original.scope !== loaded.scope))
        throw new Error("This note belongs to another session.");
      const note: Annotation = {
        ...edit.anchor,
        body: edit.body,
        id: edit.id,
        scope: loaded.scope,
        version: (edit.original?.version ?? 0) + 1,
      };
      await mutate(note.id, edit.original?.version, note);
      assertSession();
      return note;
    },
    remove: async note => {
      assertSession();
      if (note.scope !== loaded?.scope) throw new Error("This note belongs to another session.");
      await mutate(note.id, note.version);
    },
    clearSubmitted: submitted =>
      setSelected(current => {
        const next = new Map(current);
        for (const note of submitted) if (next.get(note.id) === note.version) next.delete(note.id);
        return next;
      }),
    open: note => {
      onOpen();
      if (!note) return;
      setActiveNoteId(note.id);
      setShown(undefined);
      const revealed = [...viewers.current.values()].some(reveal => reveal(note));
      if (!revealed && note.kind === "current") {
        // Coordinates are consumed only after the destination validates the captured source.
        window.dispatchEvent(new CustomEvent("pylon:open-file", { detail: { path: note.path, view: "current", annotationNote: true } }));
      }
      requestAnimationFrame(() => document.getElementById(`annotation-${note.id}`)?.scrollIntoView({ block: "nearest" }));
    },
  };
  return <Context.Provider value={sessionId ? value : undefined}>{children}</Context.Provider>;
}

export function AnnotationEditor() {
  const store = useAnnotations();
  const [error, setError] = useState("");
  const edit = store?.editor;
  if (!store || !edit) return null;
  return (
    <form
      className="annotation-card annotation-editor"
      onSubmit={async event => {
        event.preventDefault();
        if (store.busy) return;
        setError("");
        const included = store.picked.some(note => note.id === edit.original?.id);
        try {
          const note = await store.save(edit);
          store.assertSession();
          store.toggle(note, included);
          store.finishEdit(edit.id);
        } catch (error) {
          setError((error as Error).message);
        }
      }}>
      <header className="annotation-card-header">
        <strong title={edit.anchor.path}>lines {edit.anchor.from}–{edit.anchor.to}</strong>
        <small title={edit.anchor.revision}>{edit.anchor.kind === "historical" ? "Historical" : "Working copy"} · {edit.anchor.revision}</small>
      </header>
      <textarea
        autoFocus
        aria-label="Note text"
        placeholder="What should change here?"
        value={edit.body}
        disabled={store.busy}
        onChange={event => store.changeEdit(edit.id, { body: event.target.value })}
        maxLength={4096}
        rows={3}
      />
      {(error || store.error) && (
        <p role="alert">
          {error || store.error}{" "}
          <button type="button" onClick={() => void store.reload()}>
            Refresh
          </button>
        </p>
      )}
      <footer>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            if (edit.body === (edit.original?.body ?? "") || window.confirm("Discard this unsaved note edit?"))
              store.finishEdit(edit.id);
          }}
          disabled={store.busy}>
          Cancel
        </button>
        <button className="primary-button" disabled={store.busy || !edit.body.trim() || !store.ready}>
          {store.busy ? "Saving…" : "Save note"}
        </button>
      </footer>
    </form>
  );
}

function CapturedCode({ note }: { note: Annotation }) {
  const revision = useSyntaxHighlightingRevision();
  const language = sourceLanguage(note.path);
  useEffect(() => {
    void loadSyntaxLanguage(language);
  }, [language]);
  const lines = useMemo(() => syntaxTokens(note.code, language), [note.code, language, revision]);
  return (
    <pre
      className="annotation-code"
      tabIndex={0}
      aria-label={`Captured code from ${note.path}, lines ${note.from} to ${note.to}`}>
      {lines.map((tokens, index) => (
        <span className="annotation-code-line" key={index}>
          <span
            className="annotation-code-number"
            style={{ width: `${String(note.to).length + 2}ch` }}
            aria-hidden="true">
            {note.from + index}
          </span>
          <code>
            {tokens.map((token, tokenIndex) => (
              <span key={tokenIndex} className={token.className}>
                {token.content}
              </span>
            ))}
          </code>
        </span>
      ))}
    </pre>
  );
}

export function AnnotationCard({
  note,
  onClose,
  placement,
}: {
  note: Annotation;
  onClose?: () => void;
  placement?: string;
}) {
  const store = useAnnotations();
  const [error, setError] = useState("");
  const [showCode, setShowCode] = useState(false);
  // Keep the confirmed version even if a background refresh updates this card.
  const [deleteTarget, setDeleteTarget] = useState<Annotation>();
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    if (!store || !deleteTarget || deleting || store.busy) return;
    if (!store.ready) {
      setError("Reconnect and refresh notes before deleting.");
      return;
    }
    setDeleting(true);
    setError("");
    try {
      await store.remove(deleteTarget);
      setDeleteTarget(undefined);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setDeleting(false);
    }
  };
  return (
    <article className="annotation-card" data-note-card={note.id}>
      <header className="annotation-card-header">
        <strong title={note.path}>lines {note.from}–{note.to}</strong>
        <small title={note.revision}>{note.kind === "historical" ? "Historical" : "Working copy"} · {note.revision}</small>
        {onClose && <button type="button" onClick={onClose}>Hide</button>}
      </header>
      <p className="annotation-body">{note.body}</p>
      <details onToggle={event => setShowCode(event.currentTarget.open)}>
        <summary>Captured code</summary>
        {showCode && <CapturedCode note={note} />}
      </details>
      {error && !deleteTarget && <p role="alert">{error}</p>}
      <footer>
        <button
          type="button"
          disabled={store?.busy || !store?.ready}
          onClick={() => {
            try {
              store?.beginEdit(note, note, placement);
            } catch (error) {
              setError((error as Error).message);
            }
          }}>
          Edit
        </button>
        <button
          type="button"
          className="annotation-delete"
          disabled={store?.busy || !store?.ready || deleting}
          onClick={() => {
            setError("");
            setDeleteTarget(note);
          }}>
          <IconTrash size={14} aria-hidden="true" /> Delete
        </button>
      </footer>
      {deleteTarget &&
        createPortal(
          <ActionDialog
            title="Delete note?"
            description={`${deleteTarget.path}:${deleteTarget.from}–${deleteTarget.to}. Sent messages won’t change.`}
            confirmLabel="Delete note"
            busyLabel="Deleting…"
            busy={deleting || Boolean(store?.busy)}
            danger
            error={error}
            onCancel={() => {
              setDeleteTarget(undefined);
              setError("");
            }}
            onConfirm={() => void remove()}
          />,
          document.body,
        )}
    </article>
  );
}

export function AnnotationChips({ disabled = false }: { disabled?: boolean }) {
  const store = useAnnotations();
  if (!store?.picked.length) return null;
  return (
    <ul className="annotation-chips" role="list" aria-label="Notes included with this message">
      {store.picked.map(note => {
        const label = `${note.path}:${note.from}${note.to > note.from ? `-${note.to}` : ""}`;
        return (
          <li key={note.id}>
            <FileTypeIcon path={note.path} size={14} />
            <button className="annotation-chip-label" type="button" title={label} onClick={() => store.open(note)}>
              <bdi dir="ltr">{label}</bdi>
            </button>
            <button
              className="annotation-chip-remove"
              type="button"
              disabled={disabled}
              title={`Remove ${label}`}
              aria-label={`Remove note on ${label} from message`}
              onClick={() => store.toggle(note, false)}>
              <IconX size={12} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
function AnnotationPanelRow({ note }: { note: Annotation }) {
  const store = useAnnotations();
  const active = store?.activeNote?.id === note.id;
  return (
    <div id={`annotation-${note.id}`} className={`annotation-panel-row${active ? " is-active" : ""}`}>
      <button className="annotation-open" type="button" aria-pressed={active} onClick={() => store?.open(note)}>
        <span className="annotation-row-body">{note.body}</span>
        <span className="annotation-row-meta"><span>{note.kind === "historical" ? "Historical snapshot" : "Captured snapshot"}</span><code>{note.from}{note.to > note.from ? `–${note.to}` : ""}</code></span>
      </button>
      <label className="annotation-pick" title="Include with next message">
        <input
          type="checkbox"
          aria-label={`Include note on ${note.path}:${note.from}-${note.to}`}
          disabled={store?.busy}
          checked={Boolean(store?.picked.some(item => item.id === note.id))}
          onChange={event => store?.toggle(note, event.target.checked)}
        />
      </label>
    </div>
  );
}
export function AnnotationPanel() {
  const store = useAnnotations();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const groups = useMemo(() => {
    const result = new Map<string, Annotation[]>();
    for (const note of [...(store?.notes ?? [])].sort((a, b) => a.path.localeCompare(b.path) || a.from - b.from)) result.set(note.path, [...(result.get(note.path) ?? []), note]);
    return [...result];
  }, [store?.notes]);
  return (
    <div className="annotation-panel">
      <div className="annotation-inventory">
      <div className="annotation-panel-tools">
        <p className="annotation-privacy">Private until sent.</p>
        {store && (
          <button
            className="annotation-refresh"
            type="button"
            title="Refresh notes"
            aria-label="Refresh notes"
            onClick={() => void store.reload()}>
            <IconRefresh size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      {!store && <p className="annotation-empty">Select a session to use notes.</p>}
      {store?.error && (
        <p role="alert">
          {store.error}{" "}
          <button className="secondary-button" type="button" onClick={() => void store.reload()}>
            Retry
          </button>
        </p>
      )}
      {store && !store.ready && !store.error && (
        <p className="annotation-empty" role="status">
          Connecting to notes…
        </p>
      )}
      {store?.editor && !store.editor.placement && <AnnotationEditor key={store.editor.id} />}
      {store?.ready && !store.notes.length && (
        <div className="annotation-empty">
          <strong>No notes yet</strong>
          <p>
            Select lines in a file or diff, then click <b>+</b> to add a note.
          </p>
        </div>
      )}
      <div className="annotation-list">
        {groups.map(([path, notes]) => (
          <section key={path}>
            <button
              className={`annotation-file-header${store?.sourceShown && store.activeNote?.path === path ? " is-active" : ""}`}
              type="button"
              title={`Open current file: ${path}`}
              onClick={() => window.dispatchEvent(new CustomEvent("pylon:open-file", { detail: { path, annotationNote: true } }))}>
              <FileTypeIcon path={path} size={14} />
              <code><bdi dir="ltr">{path}</bdi></code>
              <span>{notes.length}</span>
            </button>
            {notes.map(note => (
              <AnnotationPanelRow key={note.id} note={note} />
            ))}
          </section>
        ))}
      </div>
      {store?.activeNote && !store.sourceShown && (
        <div className="annotation-source-fallback">
          <p className="annotation-privacy">Captured source is not open. This is the saved snapshot.</p>
          <AnnotationCard note={store.activeNote} />
          <button className="secondary-button" onClick={() => window.dispatchEvent(new CustomEvent("pylon:open-file", { detail: { path: store.activeNote!.path, annotationNote: true } }))}>Open current file</button>
        </div>
      )}
      </div>
      {store && (
        <form
          className="annotation-send"
          onSubmit={async event => {
            event.preventDefault();
            if (!store || busy || !store.picked.length) return;
            setBusy(true);
            setError("");
            try {
              const prepared = await store.prepare(message);
              if (!prepared) return;
              store.assertSession();
              await runtimeStore.sendMessage(prepared.text);
              store.clearSubmitted(prepared.notes);
              setMessage("");
            } catch (error) {
              setError(
                `${(error as Error).message} If delivery is uncertain, check chat and the queue before sending again.`,
              );
            } finally {
              setBusy(false);
            }
          }}>
          <AnnotationChips disabled={busy} />
          <textarea
            aria-label="Message with notes"
            placeholder="Add a message (optional)"
            rows={2}
            value={message}
            disabled={busy}
            onChange={event => setMessage(event.target.value)}
          />
          {error && <p role="alert">{error}</p>}
          <button className="primary-button" disabled={busy || !store?.ready || !store?.picked.length}>
            {busy
              ? "Sending…"
              : `Send with ${store?.picked.length ?? 0} ${store?.picked.length === 1 ? "note" : "notes"}`}
          </button>
          <small>Queues while busy. Restarting clears queued messages, not saved notes.</small>
        </form>
      )}
      <details className="annotation-storage">
        <summary>About saved notes</summary>
        <p>Saved across browsers. Deleting the session or project deletes its notes. Captured code does not track file changes.</p>
      </details>
    </div>
  );
}
