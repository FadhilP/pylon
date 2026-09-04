import { IconCheck, IconChevronDown, IconFolder, IconGitBranch, IconLoader2, IconPlus, IconSearch } from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatRelativeTime } from "../shared/format";
import { groupSessionSwitcherSessions, type SessionSwitcherCatalog } from "../shared/session-list";
import type { LocalBranchListSnapshot, SessionSummary } from "../shared/protocol/snapshots";
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
  branchAvailable: boolean;
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
  branchAvailable,
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
  const [branchOpen, setBranchOpen] = useState(false);
  const [branches, setBranches] = useState<LocalBranchListSnapshot>();
  const [branchLoading, setBranchLoading] = useState(false);
  const [branchBusy, setBranchBusy] = useState("");
  const [branchError, setBranchError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const branchRootRef = useRef<HTMLDivElement>(null);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
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

  const closeBranches = useCallback((restoreFocus = false) => {
    setBranchOpen(false);
    if (restoreFocus) requestAnimationFrame(() => branchTriggerRef.current?.focus());
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
    if (!branchOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!branchRootRef.current?.contains(event.target as Node)) closeBranches();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeBranches(true);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [branchOpen, closeBranches]);

  useEffect(() => {
    if (!branchOpen || !canLoadCatalog) return;
    const controller = new AbortController();
    let active = true;
    setBranchLoading(true);
    setBranchError("");
    void runtimeStore
      .listLocalBranches(controller.signal)
      .then(result => {
        if (active) setBranches(result);
      })
      .catch(cause => {
        if (!active || (cause instanceof DOMException && cause.name === "AbortError")) return;
        setBranchError("Unable to load branches.");
        onError(cause);
      })
      .finally(() => {
        if (active) setBranchLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [branchOpen, canLoadCatalog, catalogRevision]);

  useEffect(() => {
    if (!open || !canLoadCatalog) return;
    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        void runtimeStore
          .listSessions(
            { ...(query.trim() ? { query: query.trim() } : {}), limit: query.trim() ? 100 : 5 },
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
    if (!dismissed) return;
    if (open) close();
    if (branchOpen) closeBranches();
  }, [branchOpen, close, closeBranches, dismissed, open]);

  const toggle = () => {
    if (!projectAvailable) {
      onAddProject();
      return;
    }
    if (open) close(true);
    else {
      setVisibleCatalog(catalog);
      closeBranches();
      onOpen?.();
      setOpen(true);
    }
  };
  const toggleBranches = () => {
    if (!branchAvailable || !canLoadCatalog) return;
    if (branchOpen) closeBranches(true);
    else {
      close();
      setBranches(undefined);
      setBranchError("");
      onOpen?.();
      setBranchOpen(true);
    }
  };
  const checkoutBranch = async (branch: string) => {
    if (branchBusy) return;
    setBranchBusy(branch);
    try {
      await runtimeStore.checkoutBranch(branch);
      closeBranches();
    } catch (cause) {
      onError(cause);
    } finally {
      setBranchBusy("");
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
                    Not active{" "}
                    <span>{groups.inactiveLimited ? `last ${groups.inactive.length}` : groups.inactive.length}</span>
                  </h3>
                  {rows(groups.inactive)}
                </section>
              )}
              {empty && (
                <p className="composer-session-empty">{loading ? "Loading sessions…" : "No matching sessions."}</p>
              )}
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
        <div ref={branchRootRef} className="composer-branch-root">
          <button
            ref={branchTriggerRef}
            className="composer-context-branch"
            type="button"
            disabled={!branchAvailable || !canLoadCatalog}
            title={branchAvailable ? `Switch branch from ${branchLabel}` : branchLabel}
            aria-haspopup="dialog"
            aria-expanded={branchOpen}
            onClick={toggleBranches}>
            <IconGitBranch size={13} aria-hidden />
            <span>{branchLabel}</span>
            <IconChevronDown className="composer-branch-caret" size={11} aria-hidden />
          </button>
          {branchOpen && (
            <div className="composer-branch-switcher" role="dialog" aria-label="Switch local branch">
              <div className="composer-branch-heading">
                <strong>Local branches</strong>
                <span>Latest commit</span>
              </div>
              <div className="composer-branch-list">
                {branchLoading && !branches && <p>Loading branches…</p>}
                {branchError && !branches && <p>{branchError}</p>}
                {branches?.checkoutUnavailableReason && (
                  <p className="composer-branch-note">{branches.checkoutUnavailableReason}</p>
                )}
                {branches?.branches.map(branch => {
                  const unavailable =
                    branch.current ||
                    !branches.checkoutAvailable ||
                    !branch.checkoutAvailable ||
                    Boolean(branchBusy);
                  const reason = branch.current
                    ? "Current branch"
                    : branches.checkoutUnavailableReason || branch.checkoutUnavailableReason;
                  return (
                    <button
                      className={branch.current ? "is-current" : ""}
                      type="button"
                      key={branch.name}
                      disabled={unavailable}
                      title={reason}
                      onClick={() => void checkoutBranch(branch.name)}>
                      <span>
                        <IconGitBranch size={13} aria-hidden />
                        <strong>{branch.name}</strong>
                      </span>
                      <small>{formatRelativeTime(branch.lastCommitAt)} ago</small>
                      {branchBusy === branch.name ? (
                        <IconLoader2 className="composer-branch-spinner" size={13} aria-label="Switching branch" />
                      ) : branch.current ? (
                        <IconCheck size={13} aria-label="Current branch" />
                      ) : null}
                    </button>
                  );
                })}
                {branches && !branches.branches.length && <p>No local branches.</p>}
                {branches?.truncated && <p>Only the 500 most recently updated branches are shown.</p>}
              </div>
            </div>
          )}
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}
