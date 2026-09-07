import { IconArchive, IconChevronRight, IconFolder, IconLoader2, IconMessage, IconSearch, IconX } from "@tabler/icons-react";
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { ArchiveListSnapshot, ArchivedSessionSummary } from "../shared/protocol/snapshots";
import { runtimeStore } from "./runtime/event-store";
import { sessionTitle } from "./session-sidebar";

interface ArchiveDialogProps {
  revision: number;
  onClose: () => void;
  onError: (error: unknown, fallback: string) => void;
}

const ALL_SOURCES = "all";

/** Relative like the sidebar; the exact date moves to the title attribute. */
function age(iso: string): string {
  const elapsed = Date.now() - Date.parse(iso);
  if (elapsed < 36e5) return `${Math.max(1, Math.round(elapsed / 6e4))}m ago`;
  if (elapsed < 864e5) return `${Math.round(elapsed / 36e5)}h ago`;
  if (elapsed < 30 * 864e5) return `${Math.round(elapsed / 864e5)}d ago`;
  return `${Math.round(elapsed / (30 * 864e5))}mo ago`;
}

export function ArchiveDialog({ revision, onClose, onError }: ArchiveDialogProps) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState(ALL_SOURCES);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [snapshot, setSnapshot] = useState<ArchiveListSnapshot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [confirmRestoreAll, setConfirmRestoreAll] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const requestRevision = useRef(0);

  const filter = () => ({
    query: query.trim() || undefined,
    ...(source === ALL_SOURCES ? {} : { projectId: source }),
  });

  const load = async (cursor?: string) => {
    const revision = ++requestRevision.current;
    const result = await runtimeStore.listArchived({ ...filter(), cursor, limit: 20 });
    if (revision !== requestRevision.current) return;
    setSnapshot(current =>
      cursor && current
        ? {
            ...result,
            sessions: [
              ...current.sessions,
              ...result.sessions.filter(session => !current.sessions.some(old => old.id === session.id)),
            ],
          }
        : result,
    );
  };

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    const request = ++requestRevision.current;
    setLoading(true);
    setConfirmRestoreAll(false);
    const timer = window.setTimeout(
      () => {
        void runtimeStore
          .listArchived({ ...filter(), limit: 20 })
          .then(result => {
            if (active && request === requestRevision.current) setSnapshot(result);
          })
          .catch(error => {
            if (active) onError(error, "Unable to load archived items");
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      query ? 200 : 0,
    );
    return () => {
      active = false;
      requestRevision.current++;
      window.clearTimeout(timer);
    };
  }, [query, source, revision]);

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

  /* Restore acts on everything the filter matched, not on the page that
     happens to be loaded, so the pages past the first are walked first. */
  const restoreEverything = async () => {
    setConfirmRestoreAll(false);
    setBusy("all");
    try {
      for (const project of snapshot?.projects ?? []) await runtimeStore.restoreProject(project.id);
      let cursor: string | undefined;
      do {
        const page = await runtimeStore.listArchived({ ...filter(), cursor, limit: 100 });
        for (const session of page.sessions) await runtimeStore.restoreSession(session.id);
        cursor = page.nextCursor;
      } while (cursor);
      await load();
    } catch (error) {
      onError(error, "Unable to restore archived items");
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
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      "input:not([disabled]), select:not([disabled]), button:not([disabled])",
    );
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

  const toggleFold = (id: string) =>
    setFolded(current => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const sources = snapshot?.sources ?? [];
  const projects = snapshot?.projects ?? [];
  const sessions = snapshot?.sessions ?? [];
  /* Sessions are spined by the project they came from, in the order the source
     list gives, so picking a source leaves the group it already had. */
  const groups = sources
    .map(entry => ({ ...entry, sessions: sessions.filter(session => session.projectId === entry.id) }))
    .filter(group => group.sessions.length);
  const restorable = projects.length + (snapshot?.totalSessionCount ?? 0);
  const empty = !loading && !projects.length && !sessions.length;

  const restoreButton = (id: string, label: string, onClick: () => void) => (
    <button
      className="archive-restore"
      type="button"
      disabled={Boolean(busy)}
      aria-busy={busy === id}
      onClick={onClick}>
      {busy === id && <IconLoader2 className="feedback-spinner" size={13} />}
      {busy === id ? "Restoring…" : label}
    </button>
  );

  const groupHeader = (id: string, label: string, count: number) => (
    <button
      className={`archive-group${folded.has(id) ? "" : " is-open"}`}
      type="button"
      aria-expanded={!folded.has(id)}
      onClick={() => toggleFold(id)}>
      <IconChevronRight size={12} />
      <span>{label}</span>
      <b>{count}</b>
    </button>
  );

  const sessionRow = (session: ArchivedSessionSummary) => (
    <div className="archive-row" key={session.id}>
      <IconMessage size={14} />
      <span className="archive-name">{sessionTitle(session)}</span>
      {source === ALL_SOURCES && <span className="archive-where">{session.cwdLabel}</span>}
      <span className="archive-when" title={`Archived ${new Date(session.archivedAt).toLocaleString()}`}>
        {age(session.archivedAt)}
      </span>
      {restoreButton(session.id, "Restore", () => void restoreSession(session.id))}
    </div>
  );

  return (
    <div className="archive-backdrop" onMouseDown={closeBackdrop}>
      <div
        ref={dialogRef}
        className="archive-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archive-dialog-title"
        onKeyDown={onKeyDown}>
        <header>
          <div>
            <IconArchive size={18} />
            <strong id="archive-dialog-title">Archived</strong>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close archived items">
            <IconX size={17} />
          </button>
        </header>
        <label className="archive-search">
          <IconSearch size={15} />
          <span className="sr-only">Search archived projects and sessions</span>
          <input
            data-autofocus
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search archived items"
          />
          <select aria-label="Source" value={source} onChange={event => setSource(event.target.value)}>
            <option value={ALL_SOURCES}>All sources</option>
            {sources.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.label} ({entry.count})
              </option>
            ))}
          </select>
        </label>
        <div className="archive-content">
          {loading && !snapshot && <div className="archive-empty">Loading archived items…</div>}
          {Boolean(projects.length) && (
            <>
              {groupHeader("archive-projects", "Projects", projects.length)}
              {!folded.has("archive-projects") &&
                projects.map(project => (
                  <div className="archive-row" key={project.id}>
                    <IconFolder size={14} />
                    <span className="archive-name">{project.label}</span>
                    <span className="archive-where">
                      {project.sessionCount} session{project.sessionCount === 1 ? "" : "s"}
                    </span>
                    <span className="archive-when" title={`Archived ${new Date(project.archivedAt).toLocaleString()}`}>
                      {age(project.archivedAt)}
                    </span>
                    {restoreButton(project.id, "Restore", () => void restoreProject(project.id))}
                  </div>
                ))}
            </>
          )}
          {groups.map(group => (
            <div key={group.id}>
              {groupHeader(group.id, group.label, group.count)}
              {!folded.has(group.id) && group.sessions.map(sessionRow)}
            </div>
          ))}
          {snapshot?.nextCursor && (
            <button
              className="archive-more"
              type="button"
              disabled={loading}
              aria-busy={loading}
              onClick={() => {
                setLoading(true);
                void load(snapshot.nextCursor)
                  .catch(error => onError(error, "Unable to load more archived sessions"))
                  .finally(() => setLoading(false));
              }}>
              {loading && <IconLoader2 className="feedback-spinner" size={14} />}
              {loading ? "Loading…" : `Show ${Math.min(20, snapshot.totalSessionCount - sessions.length)} more`}
            </button>
          )}
          {empty && (
            <div className="archive-empty">
              <IconArchive size={22} />
              <strong>No archived items</strong>
              <span>
                {query || source !== ALL_SOURCES
                  ? "Nothing archived matches this search. Clear it to see everything you have archived."
                  : "Archived projects and sessions will appear here."}
              </span>
            </div>
          )}
        </div>
        <footer className="archive-foot">
          <span>
            {sessions.length} of {snapshot?.totalSessionCount ?? 0} session
            {snapshot?.totalSessionCount === 1 ? "" : "s"} shown
          </span>
          {Boolean(restorable) &&
            (confirmRestoreAll ? (
              <span className="archive-confirm">
                Restore {restorable}?
                <button className="archive-restore" type="button" onClick={() => void restoreEverything()}>
                  Yes, restore
                </button>
                <button className="archive-cancel" type="button" onClick={() => setConfirmRestoreAll(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="archive-restore"
                type="button"
                disabled={Boolean(busy)}
                aria-busy={busy === "all"}
                onClick={() => setConfirmRestoreAll(true)}>
                {busy === "all" && <IconLoader2 className="feedback-spinner" size={13} />}
                {busy === "all" ? "Restoring…" : `Restore ${restorable}`}
              </button>
            ))}
        </footer>
      </div>
    </div>
  );
}
