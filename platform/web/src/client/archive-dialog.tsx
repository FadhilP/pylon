import { IconArchive, IconSearch, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { ArchiveListSnapshot } from "../shared/protocol/snapshots";
import { runtimeStore } from "./runtime/event-store";
import { sessionTitle } from "./session-sidebar";

interface ArchiveDialogProps {
  revision: number;
  onClose: () => void;
  onError: (error: unknown, fallback: string) => void;
}

export function ArchiveDialog({ revision, onClose, onError }: ArchiveDialogProps) {
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<ArchiveListSnapshot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestRevision = useRef(0);

  const load = async (cursor?: string) => {
    const revision = ++requestRevision.current;
    const result = await runtimeStore.listArchived({ query: query.trim() || undefined, cursor, limit: 20 });
    if (revision !== requestRevision.current) return;
    setSnapshot((current) => cursor && current ? {
      ...result,
      sessions: [...current.sessions, ...result.sessions.filter((session) => !current.sessions.some((old) => old.id === session.id))],
    } : result);
  };

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    let active = true;
    const request = ++requestRevision.current;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void runtimeStore.listArchived({ query: query.trim() || undefined, limit: 20 })
        .then((result) => { if (active && request === requestRevision.current) setSnapshot(result); })
        .catch((error) => { if (active) onError(error, "Unable to load archived items"); })
        .finally(() => { if (active) setLoading(false); });
    }, query ? 200 : 0);
    return () => { active = false; requestRevision.current++; window.clearTimeout(timer); };
  }, [query, revision]);

  const restoreProject = async (projectId: string) => {
    setBusy(projectId);
    try {
      await runtimeStore.restoreProject(projectId);
      await load();
    } catch (error) {
      onError(error, "Unable to restore project");
    } finally {
      setBusy("");
    }
  };

  const restoreSession = async (sessionId: string) => {
    setBusy(sessionId);
    try {
      await runtimeStore.restoreSession(sessionId);
      await load();
    } catch (error) {
      onError(error, "Unable to restore session");
    } finally {
      setBusy("");
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled])');
    if (!focusable?.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const closeBackdrop = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const empty = !loading && !snapshot?.projects.length && !snapshot?.sessions.length;
  return <div className="archive-backdrop" onMouseDown={closeBackdrop}>
    <div ref={dialogRef} className="archive-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-dialog-title" onKeyDown={onKeyDown}>
      <header>
        <div><IconArchive size={18} /><strong id="archive-dialog-title">Archived</strong></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close archived items"><IconX size={17} /></button>
      </header>
      <label className="archive-search">
        <IconSearch size={15} />
        <span className="sr-only">Search archived projects and sessions</span>
        <input data-autofocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search archived items" />
      </label>
      <div className="archive-content">
        {loading && !snapshot && <div className="archive-empty">Loading archived items…</div>}
        {Boolean(snapshot?.projects.length) && <section>
          <h2>Projects</h2>
          {snapshot!.projects.map((project) => <article className="archive-row" key={project.id}>
            <div><strong>{project.label}</strong><small>{project.sessionCount} saved session{project.sessionCount === 1 ? "" : "s"} · Archived {new Date(project.archivedAt).toLocaleDateString()}</small></div>
            <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void restoreProject(project.id)}>{busy === project.id ? "Restoring…" : "Restore"}</button>
          </article>)}
        </section>}
        {Boolean(snapshot?.sessions.length) && <section>
          <h2>Sessions</h2>
          {snapshot!.sessions.map((session) => <article className="archive-row" key={session.id}>
            <div><strong>{sessionTitle(session)}</strong><small>{session.cwdLabel} · Archived {new Date(session.archivedAt).toLocaleDateString()}</small></div>
            <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void restoreSession(session.id)}>{busy === session.id ? "Restoring…" : "Restore"}</button>
          </article>)}
          {snapshot?.nextCursor && <button className="archive-more" type="button" disabled={loading} onClick={() => {
            setLoading(true);
            void load(snapshot.nextCursor).catch((error) => onError(error, "Unable to load more archived sessions")).finally(() => setLoading(false));
          }}>{loading ? "Loading…" : `Show ${Math.min(20, snapshot.totalSessionCount - snapshot.sessions.length)} more`}</button>}
        </section>}
        {empty && <div className="archive-empty"><IconArchive size={22} /><strong>No archived items</strong><span>{query ? "No archived items match this search." : "Archived projects and sessions will appear here."}</span></div>}
      </div>
    </div>
  </div>;
}
