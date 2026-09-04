import { IconChevronDown, IconFolder, IconGitBranch, IconPlus, IconSearch } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupSessionSwitcherSessions, type SessionSwitcherCatalog } from "../shared/session-list";
import type { SessionSummary } from "../shared/protocol/snapshots";
import { copyText } from "./clipboard";
import { runtimeStore } from "./runtime/event-store";
import { SessionRow } from "./session-sidebar";

export interface ComposerSessionSwitcherProps {
  projectAvailable: boolean;
  projectId?: string;
  projectLabel?: string;
  sessionLabel?: string;
  branchLabel?: string;
  catalog: SessionSwitcherCatalog;
  catalogRevision: number;
  canLoadCatalog: boolean;
  unseenCompletions?: Record<string, true>;
  busy: string;
  deleting: string;
  onSelect: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  onArchive: (session: SessionSummary) => void;
  onRename: (session: SessionSummary) => void;
  onSetActive: (session: SessionSummary, active: boolean) => void;
  onSetPinned: (session: SessionSummary, pinned: boolean) => void;
  onNewSession: () => void;
  onAddProject: () => void;
  onError: (cause: unknown) => void;
  dismissed?: boolean;
  onOpen?: () => void;
}

export function ComposerSessionSwitcher({
  projectAvailable,
  projectId,
  projectLabel,
  sessionLabel,
  branchLabel,
  catalog,
  catalogRevision,
  canLoadCatalog,
  unseenCompletions,
  busy,
  deleting,
  onSelect,
  onDelete,
  onArchive,
  onRename,
  onSetActive,
  onSetPinned,
  onNewSession,
  onAddProject,
  onError,
  dismissed = false,
  onOpen,
}: ComposerSessionSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [visibleCatalog, setVisibleCatalog] = useState(catalog);
  const [loading, setLoading] = useState(false);
  const [openMenu, setOpenMenu] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const working = visibleCatalog.activeSessions.some(session => session.workStartedAt);
  const groups = useMemo(
    () => groupSessionSwitcherSessions(visibleCatalog, query, projectId),
    [projectId, query, visibleCatalog],
  );

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setOpenMenu("");
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (openMenu) {
        setOpenMenu("");
        requestAnimationFrame(() => menuTrigger.current?.focus());
      } else {
        close(true);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [close, open, openMenu]);

  useEffect(() => {
    if (!open || !canLoadCatalog) return;
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        void runtimeStore
          .listSessions(
            {
              ...(query.trim() ? { query: query.trim() } : {}),
              limit: query.trim() ? 100 : 5,
            },
            controller.signal,
          )
          .then(result => {
            if (active) setVisibleCatalog(result);
          })
          .catch(cause => {
            if (active && !(cause instanceof DOMException && cause.name === "AbortError")) onError(cause);
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      query.trim() ? 160 : 0,
    );
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [canLoadCatalog, catalogRevision, open, query]);

  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), working ? 1_000 : 60_000);
    return () => window.clearInterval(interval);
  }, [working]);

  useEffect(() => {
    if (dismissed && open) close();
  }, [close, dismissed, open]);

  const toggle = () => {
    if (!projectAvailable) {
      onAddProject();
      return;
    }
    if (open) close(true);
    else {
      setVisibleCatalog(catalog);
      onOpen?.();
      setOpen(true);
    }
  };
  const toggleMenu = (menuId: string, trigger: HTMLElement) => {
    menuTrigger.current = trigger;
    setOpenMenu(current => (current === menuId ? "" : menuId));
  };
  const closeMenu = (restoreFocus = false) => {
    setOpenMenu("");
    if (restoreFocus) requestAnimationFrame(() => menuTrigger.current?.focus());
  };
  const closeAndRun = (action: (session: SessionSummary) => void) => (session: SessionSummary) => {
    close();
    action(session);
  };
  const copySessionId = (sessionId: string) => {
    setAnnouncement("");
    void copyText(sessionId).then(copied =>
      setAnnouncement(copied ? "Session ID copied" : "Copying session ID failed"),
    );
  };
  const rows = (sessions: SessionSummary[]) =>
    sessions.map(session => (
      <SessionRow
        key={session.id}
        session={session}
        menuId={`composer-${session.id}`}
        menuOpen={openMenu === `composer-${session.id}`}
        busy={busy}
        deleting={deleting}
        completed={Boolean(unseenCompletions?.[session.id])}
        now={now}
        showProject
        onSelect={closeAndRun(onSelect)}
        onDelete={closeAndRun(onDelete)}
        onArchive={closeAndRun(onArchive)}
        onRename={closeAndRun(onRename)}
        onSetActive={(session, active) => {
          close();
          onSetActive(session, active);
        }}
        onSetPinned={(session, pinned) => {
          close();
          onSetPinned(session, pinned);
        }}
        onToggleMenu={toggleMenu}
        onCloseMenu={() => closeMenu(true)}
        onCopySessionId={copySessionId}
      />
    ));
  const empty = !groups.active.length && !groups.inactive.length;

  return (
    <div className="composer-context">
      <div ref={rootRef} className="composer-session-root">
        <button
          ref={triggerRef}
          className="composer-session-trigger"
          type="button"
          aria-haspopup={projectAvailable ? "dialog" : undefined}
          aria-expanded={projectAvailable ? open : undefined}
          onClick={toggle}>
          <IconFolder size={13} aria-hidden />
          <strong>{projectAvailable ? projectLabel || "Project" : "Add a project"}</strong>
          {projectAvailable && (
            <>
              <span className="composer-context-separator">/</span>
              <span className="composer-context-session">{sessionLabel || "Untitled session"}</span>
              <IconChevronDown className="composer-session-caret" size={12} aria-hidden />
            </>
          )}
        </button>
        {open && (
          <div className="composer-session-switcher" role="dialog" aria-label="Switch session">
            <label className="composer-session-search">
              <IconSearch size={14} aria-hidden />
              <span className="sr-only">Search sessions and projects</span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter") event.preventDefault();
                }}
                placeholder="Search sessions and projects"
              />
            </label>
            <div className="composer-session-list">
              {groups.active.length > 0 && (
                <section aria-labelledby="composer-active-sessions">
                  <h3 className="composer-session-group" id="composer-active-sessions">
                    Active <span>{groups.active.length}</span>
                  </h3>
                  {rows(groups.active)}
                </section>
              )}
              {groups.inactive.length > 0 && (
                <section aria-labelledby="composer-inactive-sessions">
                  <h3 className="composer-session-group" id="composer-inactive-sessions">
                    Not active <span>{groups.inactiveLimited ? `last ${groups.inactive.length}` : groups.inactive.length}</span>
                  </h3>
                  {rows(groups.inactive)}
                </section>
              )}
              {empty && <p className="composer-session-empty">{loading ? "Loading sessions…" : "No matching sessions."}</p>}
            </div>
            <footer className="composer-session-footer">
              <button
                type="button"
                disabled={!projectId || Boolean(busy || deleting)}
                onClick={() => {
                  close();
                  onNewSession();
                }}>
                <IconPlus size={14} aria-hidden />
                New session
              </button>
            </footer>
          </div>
        )}
      </div>
      {projectAvailable && branchLabel && (
        <span className="composer-context-branch" title={branchLabel}>
          <IconGitBranch size={13} aria-hidden />
          <span>{branchLabel}</span>
        </span>
      )}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
