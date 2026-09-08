import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AnnotationReads,
  annotationPrompt,
  persistAnnotation,
  reviewAnnotations,
  type Annotation,
  type AnnotationAnchor,
  type AnnotationList,
} from "../shared/annotations";
import { runtimeStore } from "./runtime/event-store";
import "./annotations.css";

interface AnnotationEdit {
  id: string;
  scope: string;
  anchor: AnnotationAnchor;
  original?: Annotation;
  body: string;
  attach: boolean;
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
  changeEdit: (id: string, change: { body?: string; attach?: boolean }) => void;
  finishEdit: (id: string) => void;
  releaseEditor: (placement: string) => void;
  toggle: (note: Annotation, selected: boolean) => void;
  clearSubmitted: (notes: readonly Annotation[]) => void;
  reload: () => Promise<AnnotationList | undefined>;
  prepare: (message: string) => Promise<{ text: string; notes: Annotation[] } | undefined>;
  assertSession: () => void;
  open: (note?: Annotation) => void;
};
const Context = createContext<NotesContext | undefined>(undefined);
export const useAnnotations = () => useContext(Context);

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
  const active = useRef(key);
  active.current = key;
  const [loaded, setLoaded] = useState<AnnotationList>();
  const notes = useMemo(
    () => (loaded?.sessionId === sessionId && loaded.sessionGeneration === generation ? loaded.notes : []),
    [loaded, sessionId, generation],
  );
  const [selected, setSelected] = useState<Map<string, number>>(new Map());
  const [readyKey, setReadyKey] = useState("");
  const ready = readyKey === key;
  const [error, setError] = useState("");
  const [unfinished, setUnfinished] = useState<AnnotationEdit>();
  const editor = loaded?.sessionId === sessionId && unfinished?.scope === loaded.scope ? unfinished : undefined;
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const mounted = useRef(true);
  const reads = useRef(new AnnotationReads());
  const request = { sessionId, expectedGeneration: generation };
  const assertSession = () => {
    const live = runtimeStore.getSnapshot();
    if (
      !mounted.current ||
      active.current !== key ||
      live.connection !== "connected" ||
      !live.runtime?.ready ||
      live.runtime.sessionId !== sessionId ||
      live.runtime.sessionGeneration !== generation
    )
      throw new Error("Session changed or disconnected. Review the notes in the intended session before sending.");
  };
  const reload = async () => {
    if (!sessionId || active.current !== key || !mounted.current) return;
    return reads.current.read(
      () => runtimeStore.annotationNotes(request),
      result => {
        if (!mounted.current || active.current !== key) return;
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
        if (mounted.current && active.current === key) {
          setReadyKey("");
          setError((error as Error).message || "Note storage is unavailable.");
        }
      },
    );
  };
  useEffect(() => {
    mounted.current = true;
    setSelected(new Map());
    setError("");
    void reload();
    const refresh = () => {
      if (!document.hidden) void reload();
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      reads.current.invalidate();
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [key]);
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
        attach: original ? picked.some(note => note.id === original.id) : false,
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
      if (note)
        requestAnimationFrame(() => {
          const row = document.getElementById(`annotation-${note.id}`);
          const details = row?.querySelector("details");
          if (details) details.open = true;
          row?.scrollIntoView({ block: "nearest" });
        });
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
      className="annotation-card"
      onSubmit={async event => {
        event.preventDefault();
        if (store.busy) return;
        setError("");
        try {
          const note = await store.save(edit);
          store.assertSession();
          store.toggle(note, edit.attach);
          store.finishEdit(edit.id);
        } catch (error) {
          setError((error as Error).message);
        }
      }}>
      <strong>
        {edit.anchor.path}:{edit.anchor.from}–{edit.anchor.to}
      </strong>
      <small>
        {edit.anchor.kind === "historical" ? "Historical source" : "Captured working copy"} · {edit.anchor.revision}
      </small>
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
      <label>
        <input
          type="checkbox"
          checked={edit.attach}
          disabled={store.busy}
          onChange={event => store.changeEdit(edit.id, { attach: event.target.checked })}
        />{" "}
        Include with next message
      </label>
      {(error || store.error) && (
        <p role="alert">
          {error || store.error}{" "}
          <button type="button" onClick={() => void store.reload()}>
            Refresh saved notes
          </button>
        </p>
      )}
      <footer>
        <button
          type="button"
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
  return (
    <article className="annotation-card">
      <strong>
        {note.path}:{note.from}–{note.to}
      </strong>
      <small>
        {note.kind === "historical" ? "Historical source" : "Captured working copy"} · {note.revision}
      </small>
      <p className="annotation-body">{note.body}</p>
      <label>
        <input
          type="checkbox"
          checked={Boolean(store?.picked.some(item => item.id === note.id))}
          onChange={event => store?.toggle(note, event.target.checked)}
        />{" "}
        Include with next message
      </label>
      <details>
        <summary>Captured code</summary>
        <pre>{note.code}</pre>
      </details>
      {error && <p role="alert">{error}</p>}
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
          disabled={store?.busy}
          onClick={async () => {
            if (!window.confirm("Delete this saved note? Sent chat messages will not change.")) return;
            try {
              await store?.remove(note);
            } catch (error) {
              setError((error as Error).message);
            }
          }}>
          Delete
        </button>
        {onClose && (
          <button type="button" onClick={onClose}>
            Collapse
          </button>
        )}
      </footer>
    </article>
  );
}

export function AnnotationChips({ disabled = false }: { disabled?: boolean }) {
  const store = useAnnotations();
  if (!store?.picked.length) return null;
  return (
    <div className="annotation-chips" aria-label="Notes included with this message">
      {store.picked.map(note => (
        <span key={note.id}>
          <button type="button" onClick={() => store.open(note)}>
            {note.path}:{note.from}–{note.to}
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Remove note on ${note.path} from message`}
            onClick={() => store.toggle(note, false)}>
            ×
          </button>
        </span>
      ))}
      <small>Saved notes and captured code will appear in your chat message.</small>
    </div>
  );
}
function AnnotationPanelRow({ note }: { note: Annotation }) {
  const store = useAnnotations();
  const [opened, setOpened] = useState(false);
  return (
    <div id={`annotation-${note.id}`} className="annotation-panel-row">
      <details onToggle={event => setOpened(event.currentTarget.open)}>
        <summary>
          <code>
            {note.from}–{note.to}
          </code>
          <span>{note.body}</span>
        </summary>
        {opened && <AnnotationCard note={note} />}
      </details>
      <label className="annotation-pick" title="Include with next message">
        <input
          type="checkbox"
          aria-label={`Include note on ${note.path}:${note.from}-${note.to}`}
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
    for (const note of store?.notes ?? []) result.set(note.path, [...(result.get(note.path) ?? []), note]);
    return [...result];
  }, [store?.notes]);
  return (
    <div className="annotation-panel">
      <p className="annotation-privacy">
        Private until sent. Saved by Pylon across browsers; deleting the session or project also deletes its notes. No
        automatic tracking or relocation.
      </p>
      {store && (
        <button type="button" onClick={() => void store.reload()}>
          Refresh notes
        </button>
      )}
      {!store && <p>Select a ready session to use notes.</p>}
      {store?.error && (
        <p role="alert">
          {store.error}{" "}
          <button type="button" onClick={() => void store.reload()}>
            Retry loading
          </button>
        </p>
      )}
      {store && !store.ready && !store.error && <p role="status">Loading notes…</p>}
      {store?.editor && !store.editor.placement && <AnnotationEditor key={store.editor.id} />}
      {store?.ready && !store.notes.length && <p>Select lines in a file or diff, then choose Note selected lines.</p>}
      <div className="annotation-list">
        {groups.map(([path, notes]) => (
          <section key={path}>
            <button
              className="annotation-file-header"
              type="button"
              title={`Open current file: ${path}`}
              onClick={() => window.dispatchEvent(new CustomEvent("pylon:open-file", { detail: { path } }))}>
              <code>{path}</code>
              <span>{notes.length}</span>
            </button>
            {notes.map(note => (
              <AnnotationPanelRow key={note.id} note={note} />
            ))}
          </section>
        ))}
      </div>
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
          placeholder="Anything to add, or send the notes as they are"
          rows={3}
          value={message}
          disabled={busy}
          onChange={event => setMessage(event.target.value)}
        />
        {error && <p role="alert">{error}</p>}
        <button className="primary-button" disabled={busy || !store?.picked.length}>
          {busy
            ? "Sending…"
            : `Send with ${store?.picked.length ?? 0} ${store?.picked.length === 1 ? "note" : "notes"}`}
        </button>
        <small>
          Uses normal chat delivery; queues while the agent is working. Queued prompts are not restart-persistent. Notes
          remain saved.
        </small>
      </form>
    </div>
  );
}
