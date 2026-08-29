import {
  IconArchive,
  IconChevronRight,
  IconCopy,
  IconDots,
  IconFolder,
  IconFolderOpen,
  IconPencil,
  IconPin,
  IconPlus,
  IconPower,
  IconSearch,
  IconSettings,
  IconTerminal2,
  IconTrash,
  IconX,
  IconLibrary,
} from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import type {
  SessionProjectPage,
  SessionSummary,
} from "../shared/protocol/snapshots";
import { formatSessionActivity } from "../shared/format";
import {
  SESSION_LIST_INITIAL_LIMIT,
  SESSION_LIST_MORE_LIMIT,
} from "../shared/session-list";
import { showSessionRuntimeState } from "../shared/session-completions";
import { ChangelogDialog } from "./changelog-dialog";
import { copyText } from "./clipboard";
import { displayDate, displayTime } from "./format";

export interface SessionProject {
  id: string;
  label: string;
  cwd: string;
  sessions: SessionSummary[];
  active: boolean;
}

export function sessionTitle(session: SessionSummary): string {
  return session.name || session.preview || "Untitled session";
}

interface SidebarProps {
  activeSessions: SessionSummary[];
  unseenCompletions?: Record<string, true>;
  projects: SessionProject[];
  general?: SessionProject;
  pages: SessionProjectPage[];
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  expandedProjects: Set<string>;
  loading: boolean;
  busy: string;
  deleting: string;
  projectLoading: string;
  projectBusy: string;
  isOpen: boolean;
  contextual?: boolean;
  mobile: boolean;
  onClose: () => void;
  onShowFiles?: () => void;
  onQuery: (query: string) => void;
  onToggleProject: (projectId: string) => void;
  onSelectSession: (session: SessionSummary) => void;
  onDeleteSession: (session: SessionSummary) => void;
  onRenameSession: (session: SessionSummary) => void;
  onSetSessionActive: (session: SessionSummary, active: boolean) => void;
  onSetSessionPinned: (session: SessionSummary, pinned: boolean) => void;
  onLoadMore: (project: SessionProject) => void;
  onShowLess: (project: SessionProject) => void;
  onAddProject: () => void;
  onOpenArchives: () => void;
  terminalOpen: boolean;
  terminalAvailable: boolean;
  onToggleTerminal: () => void;
  onOpenSettings: () => void;
  onArchiveProject: (project: SessionProject) => void;
  onRenameProject: (project: SessionProject) => void;
  onRemoveProject: (project: SessionProject) => void;
  onArchiveSession: (session: SessionSummary) => void;
  onNewSession: (project: SessionProject) => void;
  onNewGeneral: () => void;
  onWorktreeSetup: (project: SessionProject) => void;
  onReorderProject: (
    projectId: string,
    beforeProjectId?: string,
  ) => Promise<void>;
  onReorderActiveSession: (
    sessionId: string,
    beforeSessionId?: string,
  ) => Promise<void>;
}

export function SessionSidebar({
  activeSessions,
  unseenCompletions,
  projects,
  general,
  pages,
  query,
  searchRef,
  expandedProjects,
  loading,
  busy,
  deleting,
  projectLoading,
  projectBusy,
  isOpen,
  mobile,
  contextual = false,
  onClose,
  onShowFiles,
  onQuery,
  onToggleProject,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onSetSessionActive,
  onSetSessionPinned,
  onLoadMore,
  onShowLess,
  onAddProject,
  onOpenArchives,
  terminalOpen,
  terminalAvailable,
  onToggleTerminal,
  onOpenSettings,
  onArchiveProject,
  onRenameProject,
  onRemoveProject,
  onArchiveSession,
  onNewSession,
  onNewGeneral,
  onWorktreeSetup,
  onReorderProject,
  onReorderActiveSession,
}: SidebarProps) {
  const [openMenu, setOpenMenu] = useState("");
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [activeSessionsOpen, setActiveSessionsOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [generalOpen, setGeneralOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const menuTrigger = useRef<HTMLElement | null>(null);
  const [preview, setPreview] = useState<{
    kind: "project" | "active";
    id: string;
    ids: string[];
  }>();
  const [announcement, setAnnouncement] = useState("");
  const visibleProjects = useMemo(
    () =>
      orderByIds(
        projects,
        preview?.kind === "project" ? preview.ids : undefined,
      ),
    [preview, projects],
  );
  const visibleActiveSessions = useMemo(
    () =>
      orderByIds(
        activeSessions,
        preview?.kind === "active" ? preview.ids : undefined,
      ),
    [activeSessions, preview],
  );
  const generalPage = general
    ? pages.find((page) => page.id === general.id)
    : undefined;
  const working =
    activeSessions.some((session) => session.workStartedAt) ||
    projects.some((project) =>
      project.sessions.some((session) => session.workStartedAt),
    ) ||
    general?.sessions.some((session) => session.workStartedAt);
  const announceCopy = (value: string, label: string) => {
    setAnnouncement("");
    void copyText(value).then((copied) => {
      setAnnouncement(
        copied ? `${label} copied` : `Copying ${label.toLowerCase()} failed`,
      );
    });
  };

  useEffect(() => {
    setNow(Date.now());
    const interval = window.setInterval(
      () => setNow(Date.now()),
      working ? 1_000 : 60_000,
    );
    return () => window.clearInterval(interval);
  }, [working]);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target =
        event.target instanceof Element
          ? event.target.closest(".session-menu")
          : null;
      if (target?.getAttribute("data-menu-id") !== openMenu) setOpenMenu("");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenMenu("");
      menuTrigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  const selectSession = (session: SessionSummary) => {
    setOpenMenu("");
    onSelectSession(session);
  };
  const toggleMenu = (menuId: string, trigger: HTMLElement) => {
    menuTrigger.current = trigger;
    setOpenMenu((current) => (current === menuId ? "" : menuId));
  };
  const closeMenu = (restoreFocus = false) => {
    setOpenMenu("");
    if (restoreFocus) requestAnimationFrame(() => menuTrigger.current?.focus());
  };
  const reorder = async (
    kind: "project" | "active",
    id: string,
    ids: string[],
  ) => {
    const before = ids[ids.indexOf(id) + 1];
    setPreview({ kind, id, ids });
    try {
      if (kind === "project") await onReorderProject(id, before);
      else await onReorderActiveSession(id, before);
      setAnnouncement(
        `${kind === "project" ? "Project" : "Active session"} moved to position ${ids.indexOf(id) + 1}`,
      );
    } catch {
      setAnnouncement("Reordering failed");
    } finally {
      setPreview(undefined);
    }
  };
  const startPointerReorder = (
    event: ReactPointerEvent<HTMLElement>,
    kind: "project" | "active",
    id: string,
    ids: string[],
  ) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let nextIds = ids;
    const stopClick = (click: MouseEvent) => {
      click.preventDefault();
      click.stopPropagation();
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keydown);
      document.body.classList.remove("is-reordering");
    };
    const cancel = () => {
      cleanup();
      if (!dragging) return;
      setPreview(undefined);
      setAnnouncement("Reordering cancelled");
    };
    const move = (pointer: PointerEvent) => {
      if (
        !dragging &&
        Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 5
      )
        return;
      if (!dragging) {
        dragging = true;
        setOpenMenu("");
        document.body.classList.add("is-reordering");
        setPreview({ kind, id, ids: nextIds });
      }
      pointer.preventDefault();
      const target = document
        .elementFromPoint(pointer.clientX, pointer.clientY)
        ?.closest<HTMLElement>(`[data-reorder-kind="${kind}"]`);
      const targetId = target?.dataset.reorderId;
      if (!target || !targetId || targetId === id) return;
      const after =
        pointer.clientY >
        target.getBoundingClientRect().top + target.offsetHeight / 2;
      const targetIndex = nextIds.indexOf(targetId);
      const before = after ? nextIds[targetIndex + 1] : targetId;
      const reordered = moveBefore(nextIds, id, before);
      if (sameIds(nextIds, reordered)) return;
      nextIds = reordered;
      setPreview({ kind, id, ids: nextIds });
    };
    const up = () => {
      cleanup();
      if (!dragging) return;
      document.addEventListener("click", stopClick, {
        capture: true,
        once: true,
      });
      window.setTimeout(
        () => document.removeEventListener("click", stopClick, true),
        0,
      );
      if (sameIds(ids, nextIds)) {
        setPreview(undefined);
        return;
      }
      void reorder(kind, id, nextIds);
    };
    const keydown = (key: KeyboardEvent) => {
      if (key.key === "Escape") cancel();
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
    window.addEventListener("keydown", keydown);
  };
  const keyboardReorder = (
    event: ReactKeyboardEvent,
    kind: "project" | "active",
    id: string,
    ids: string[],
  ) => {
    if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const current = ids.indexOf(id);
    const target = Math.max(
      0,
      Math.min(ids.length - 1, current + (event.key === "ArrowUp" ? -1 : 1)),
    );
    if (target === current) return;
    const reordered = [...ids];
    reordered.splice(current, 1);
    reordered.splice(target, 0, id);
    void reorder(kind, id, reordered);
  };

  return (
    <>
      <aside
        id="primary-navigation"
        className={`sidebar ${isOpen ? "is-open" : ""}`}
        aria-label="Projects and sessions"
        aria-hidden={mobile && !isOpen}
        inert={mobile && !isOpen}
      >
        {contextual ? (
          <div className="session-context-header">
            <strong>All sessions</strong>
            {onShowFiles && (
              <button
                className="session-context-files"
                type="button"
                onClick={onShowFiles}
              >
                <IconFolder size={14} />
                Files
              </button>
            )}
            <span>
              <button
                className="icon-button"
                type="button"
                onClick={() => setChangelogOpen(true)}
                aria-label="Open changelog"
              >
                <IconLibrary size={16} />
              </button>
              <button
                className="icon-button mobile-close"
                onClick={onClose}
                aria-label="Close navigation"
              >
                <IconX size={18} />
              </button>
            </span>
          </div>
        ) : (
          <div className="brand-row-shell">
            <button
              className="brand-row"
              type="button"
              onClick={() => setChangelogOpen(true)}
              aria-label="Open changelog"
            >
              <span className="brand-row-identity">
                <span className="brand-mark" aria-hidden="true">
                  <img src="/pylon-mark.svg" alt="" />
                </span>
                <span className="brand-copy">
                  <strong>Pylon</strong>
                </span>
              </span>
              <IconLibrary className="brand-changelog-icon" size={16} />
            </button>
            <button
              className="icon-button mobile-close"
              onClick={onClose}
              aria-label="Close navigation"
            >
              <IconX size={18} />
            </button>
          </div>
        )}

        <label className="session-search">
          <IconSearch size={15} />
          <span className="sr-only">Search projects and sessions</span>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="Search sessions"
          />
          <kbd>Ctrl K</kbd>
        </label>

        <nav className="project-list">
          {!contextual && (
            <section
              className="active-session-group"
              aria-labelledby="active-sessions-heading"
            >
              <h2
                style={{ marginBottom: 4 }}
                className="nav-label"
                id="active-sessions-heading"
              >
                <button
                  type="button"
                  aria-expanded={activeSessionsOpen}
                  onClick={() => setActiveSessionsOpen((open) => !open)}
                >
                  <span>Active sessions</span>
                  <IconChevronRight
                    className={activeSessionsOpen ? "is-expanded" : ""}
                    size={13}
                  />
                  <small>{activeSessions.length}</small>
                </button>
              </h2>
              {activeSessionsOpen &&
                (visibleActiveSessions.length > 0 ? (
                  <div className="active-session-list">
                    {visibleActiveSessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        menuId={`active-${session.id}`}
                        menuOpen={openMenu === `active-${session.id}`}
                        busy={busy}
                        deleting={deleting}
                        completed={Boolean(unseenCompletions?.[session.id])}
                        showProject
                        now={now}
                        onSelect={selectSession}
                        onDelete={onDeleteSession}
                        onArchive={onArchiveSession}
                        onRename={onRenameSession}
                        onSetActive={onSetSessionActive}
                        onSetPinned={onSetSessionPinned}
                        onToggleMenu={toggleMenu}
                        onCloseMenu={() => closeMenu(true)}
                        onCopySessionId={(id) => announceCopy(id, "Session ID")}
                        reorderKind="active"
                        dragging={
                          preview?.kind === "active" &&
                          preview.id === session.id
                        }
                        onPointerDown={(event) =>
                          startPointerReorder(
                            event,
                            "active",
                            session.id,
                            visibleActiveSessions.map((item) => item.id),
                          )
                        }
                        onKeyDown={(event) =>
                          keyboardReorder(
                            event,
                            "active",
                            session.id,
                            visibleActiveSessions.map((item) => item.id),
                          )
                        }
                      />
                    ))}
                  </div>
                ) : (
                  <p className="active-session-empty">No active sessions</p>
                ))}
            </section>
          )}
          <div className="project-heading">
            <h2 className="nav-label">
              <button
                type="button"
                aria-expanded={projectsOpen || Boolean(query.trim())}
                onClick={() => setProjectsOpen((open) => !open)}
              >
                <span>Projects</span>
                <IconChevronRight
                  className={projectsOpen || query.trim() ? "is-expanded" : ""}
                  size={13}
                />
              </button>
            </h2>
            <div>
              <button
                className="project-add"
                type="button"
                onClick={onOpenArchives}
                disabled={Boolean(projectBusy || deleting)}
              >
                <IconArchive size={13} />
                Archived
              </button>
              <button
                className="project-add"
                type="button"
                onClick={onAddProject}
                disabled={Boolean(projectBusy || deleting)}
                aria-label="Add project"
              >
                <IconPlus size={14} />
                Add project
              </button>
            </div>
          </div>
          {(projectsOpen || Boolean(query.trim())) &&
            loading &&
            projects.length === 0 && (
              <div className="sidebar-state">Loading sessions...</div>
            )}
          {(projectsOpen || Boolean(query.trim())) &&
            visibleProjects.map((project) => {
              const expanded =
                Boolean(query.trim()) || expandedProjects.has(project.id);
              const page = pages.find(
                (candidate) => candidate.id === project.id,
              );
              return (
                <section
                  className={`project-group${preview?.kind === "project" && preview.id === project.id ? " is-dragging" : ""}`}
                  key={project.id}
                >
                  <div
                    className="project-row"
                    data-reorder-kind="project"
                    data-reorder-id={project.id}
                  >
                    <button
                      type="button"
                      className={`project-toggle ${project.active ? "is-active" : ""}`}
                      onClick={() => onToggleProject(project.id)}
                      onPointerDown={(event) =>
                        startPointerReorder(
                          event,
                          "project",
                          project.id,
                          visibleProjects.map((item) => item.id),
                        )
                      }
                      onKeyDown={(event) =>
                        keyboardReorder(
                          event,
                          "project",
                          project.id,
                          visibleProjects.map((item) => item.id),
                        )
                      }
                      aria-expanded={expanded}
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    >
                      {expanded ? (
                        <IconFolderOpen size={14} />
                      ) : (
                        <IconFolder size={14} />
                      )}
                      <span>{project.label}</span>
                      <small>
                        {page?.totalCount ?? project.sessions.length}
                      </small>
                    </button>
                    <button
                      className="project-new"
                      type="button"
                      onClick={() => onNewSession(project)}
                      disabled={Boolean(busy || deleting || projectBusy)}
                      aria-label={`New session in ${project.label}`}
                      title={`New session in ${project.label}`}
                    >
                      <IconPlus size={14} />
                    </button>
                    <details
                      className="session-menu project-menu"
                      data-menu-id={`project-${project.id}`}
                      open={openMenu === `project-${project.id}`}
                    >
                      <summary
                        aria-label={`More options for ${project.label}`}
                        aria-expanded={openMenu === `project-${project.id}`}
                        title="More options"
                        onClick={(event) => {
                          event.preventDefault();
                          toggleMenu(
                            `project-${project.id}`,
                            event.currentTarget,
                          );
                        }}
                      >
                        <IconDots size={15} />
                      </summary>
                      <div className="session-menu-popover">
                        <button
                          type="button"
                          disabled={Boolean(projectBusy || busy || deleting)}
                          onClick={() => {
                            closeMenu(true);
                            onRenameProject(project);
                          }}
                        >
                          <IconPencil size={14} />
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            closeMenu(true);
                            announceCopy(project.cwd, "Project path");
                          }}
                        >
                          <IconCopy size={14} />
                          Copy path
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(projectBusy || busy || deleting)}
                          onClick={() => {
                            closeMenu(true);
                            onWorktreeSetup(project);
                          }}
                        >
                          <IconTerminal2 size={14} />
                          Worktree setup
                        </button>
                        <button
                          type="button"
                          disabled={Boolean(projectBusy || busy || deleting)}
                          onClick={() => {
                            closeMenu(true);
                            onArchiveProject(project);
                          }}
                        >
                          <IconArchive size={14} />
                          Archive
                        </button>
                        <button
                          className="is-danger"
                          type="button"
                          disabled={Boolean(projectBusy || busy || deleting)}
                          onClick={() => {
                            closeMenu(true);
                            onRemoveProject(project);
                          }}
                        >
                          <IconTrash size={14} />
                          Remove project
                        </button>
                      </div>
                    </details>
                  </div>
                  {expanded && (
                    <div className="project-sessions">
                      {project.sessions.map((session) => (
                        <SessionRow
                          key={session.id}
                          session={session}
                          menuId={`project-${project.id}-${session.id}`}
                          menuOpen={
                            openMenu === `project-${project.id}-${session.id}`
                          }
                          busy={busy}
                          deleting={deleting}
                          completed={Boolean(unseenCompletions?.[session.id])}
                          now={now}
                          onSelect={selectSession}
                          onDelete={onDeleteSession}
                          onArchive={onArchiveSession}
                          onRename={onRenameSession}
                          onSetActive={onSetSessionActive}
                          onSetPinned={onSetSessionPinned}
                          onToggleMenu={toggleMenu}
                          onCloseMenu={() => closeMenu(true)}
                          onCopySessionId={(id) =>
                            announceCopy(id, "Session ID")
                          }
                        />
                      ))}
                      {page &&
                        (page.sessions.length > SESSION_LIST_INITIAL_LIMIT ||
                          page.nextCursor) && (
                          <div className="session-list-controls">
                            {page.nextCursor && (
                              <button
                                className="session-list-button"
                                type="button"
                                onClick={() => onLoadMore(project)}
                                disabled={projectLoading === project.id}
                              >
                                {projectLoading === project.id
                                  ? "Loading…"
                                  : `Show ${Math.min(SESSION_LIST_MORE_LIMIT, page.totalCount - page.sessions.length)} more`}
                              </button>
                            )}
                            {page.sessions.length >
                              SESSION_LIST_INITIAL_LIMIT && (
                              <button
                                className="session-list-button"
                                type="button"
                                onClick={() => onShowLess(project)}
                                disabled={projectLoading === project.id}
                              >
                                Show less
                              </button>
                            )}
                          </div>
                        )}
                    </div>
                  )}
                </section>
              );
            })}
          {(projectsOpen || Boolean(query.trim())) &&
            !loading &&
            projects.length === 0 &&
            (!query || !general?.sessions.length) && (
              <div className="sidebar-state">
                {query
                  ? "No matching sessions."
                  : "No projects yet. Add a folder to start."}
              </div>
            )}
          {general && (
            <section
              className="general-session-group"
              aria-labelledby="general-sessions-heading"
            >
              <div className="project-heading">
                <h2 className="nav-label" id="general-sessions-heading">
                  <button
                    type="button"
                    aria-expanded={generalOpen}
                    onClick={() => setGeneralOpen((open) => !open)}
                  >
                    <span>General</span>
                    <IconChevronRight
                      className={generalOpen ? "is-expanded" : ""}
                      size={13}
                    />
                  </button>
                </h2>
                <div>
                  <button
                    className="project-add"
                    type="button"
                    onClick={onNewGeneral}
                    disabled={Boolean(busy || deleting || projectBusy)}
                    aria-label="New general session"
                    title="New general session"
                  >
                    <IconPlus size={14} />
                  </button>
                </div>
              </div>
              {generalOpen && (
                <div className="active-session-list">
                  {general.sessions.length ? (
                    general.sessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        menuId={`general-${session.id}`}
                        menuOpen={openMenu === `general-${session.id}`}
                        busy={busy}
                        deleting={deleting}
                        completed={Boolean(unseenCompletions?.[session.id])}
                        now={now}
                        onSelect={selectSession}
                        onDelete={onDeleteSession}
                        onArchive={onArchiveSession}
                        onRename={onRenameSession}
                        onSetActive={onSetSessionActive}
                        onSetPinned={onSetSessionPinned}
                        onToggleMenu={toggleMenu}
                        onCloseMenu={() => closeMenu(true)}
                        onCopySessionId={(id) => announceCopy(id, "Session ID")}
                      />
                    ))
                  ) : (
                    <p className="active-session-empty">
                      Search and work with files accessible on this PC.
                    </p>
                  )}
                  {(general.sessions.length > SESSION_LIST_INITIAL_LIMIT ||
                    generalPage?.nextCursor) && (
                    <div className="session-list-controls">
                      {generalPage?.nextCursor && (
                        <button
                          className="session-list-button"
                          type="button"
                          onClick={() => onLoadMore(general)}
                          disabled={projectLoading === general.id}
                        >
                          {projectLoading === general.id
                            ? "Loading…"
                            : "Show more"}
                        </button>
                      )}
                      {general.sessions.length > SESSION_LIST_INITIAL_LIMIT && (
                        <button
                          className="session-list-button"
                          type="button"
                          onClick={() => onShowLess(general)}
                          disabled={projectLoading === general.id}
                        >
                          Show less
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}
        </nav>

        <div className="sidebar-foot">
          <button
            className="sidebar-action"
            type="button"
            onClick={onOpenSettings}
          >
            <IconSettings size={16} />
            Settings
          </button>
          <button
            className={`sidebar-action${terminalOpen ? " is-active" : ""}`}
            type="button"
            disabled={!terminalAvailable}
            aria-pressed={terminalOpen}
            onClick={onToggleTerminal}
          >
            <IconTerminal2 size={16} />
            Terminal
          </button>
        </div>
        <div className="sr-only" aria-live="polite">
          {announcement}
        </div>
      </aside>
      {changelogOpen && (
        <ChangelogDialog onClose={() => setChangelogOpen(false)} />
      )}
    </>
  );
}

function SessionRow({
  session,
  menuId,
  menuOpen,
  busy,
  deleting,
  completed,
  now,
  showProject = false,
  reorderKind,
  dragging = false,
  onPointerDown,
  onKeyDown,
  onSelect,
  onDelete,
  onArchive,
  onRename,
  onSetActive,
  onSetPinned,
  onToggleMenu,
  onCloseMenu,
  onCopySessionId,
}: {
  session: SessionSummary;
  menuId: string;
  menuOpen: boolean;
  busy: string;
  deleting: string;
  completed: boolean;
  now: number;
  showProject?: boolean;
  reorderKind?: "active";
  dragging?: boolean;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onSelect: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  onArchive: (session: SessionSummary) => void;
  onRename: (session: SessionSummary) => void;
  onSetActive: (session: SessionSummary, active: boolean) => void;
  onSetPinned: (session: SessionSummary, pinned: boolean) => void;
  onToggleMenu: (menuId: string, trigger: HTMLElement) => void;
  onCloseMenu: () => void;
  onCopySessionId: (sessionId: string) => void;
}) {
  const unavailable = Boolean(busy || deleting);
  const sleeping = session.runtimeState === "sleeping";
  const workStartedAt = session.workStartedAt
    ? Date.parse(session.workStartedAt)
    : Number.NaN;
  const working = !Number.isNaN(workStartedAt);
  const activity = formatSessionActivity(
    session.modifiedAt,
    session.workStartedAt,
    now,
  );

  return (
    <div
      className={`session-row ${session.active ? "is-active" : ""}${reorderKind ? " is-reorderable" : ""}${dragging ? " is-dragging" : ""}`}
      data-reorder-kind={reorderKind}
      data-reorder-id={reorderKind ? session.id : undefined}
    >
      <button
        className={`session-link ${session.active ? "is-active" : ""}`}
        type="button"
        onClick={() => onSelect(session)}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        disabled={unavailable}
        title={
          session.runningUnderParentSessionId
            ? "View this running session through its parent"
            : undefined
        }
        aria-current={session.active ? "page" : undefined}
        aria-keyshortcuts={
          reorderKind ? "Alt+ArrowUp Alt+ArrowDown" : undefined
        }
      >
        <span className="session-copy">
          <strong>{sessionTitle(session)}</strong>
          <small>
            {session.parentSession && (
              <>
                Spawned from{" "}
                <span title={session.parentSession.id}>
                  {session.parentSession.title}
                </span>
                {" · "}
              </>
            )}
            {showProject ? (
              `${session.cwdLabel} · `
            ) : (
              <>
                <time
                  dateTime={session.createdAt}
                  title={`Created ${displayTime(session.createdAt)}`}
                >
                  {displayDate(session.createdAt)}
                </time>
                {" · "}
              </>
            )}
            <time
              dateTime={working ? session.workStartedAt : session.modifiedAt}
              title={
                working
                  ? `Working since ${displayTime(session.workStartedAt!)}`
                  : `Last active ${displayTime(session.modifiedAt)}`
              }
            >
              {activity}
            </time>
          </small>
        </span>
        {busy === session.id || deleting === session.id ? (
          <span
            className="status-orb success"
            aria-label={deleting === session.id ? "Deleting" : "Updating"}
          />
        ) : (
          showSessionRuntimeState(session.runtimeState, completed) && (
            <span
              className={`session-runtime-state ${completed ? "is-complete" : `is-${session.runtimeState}`}`}
              aria-label={completed ? "New response" : session.runtimeState}
              title={completed ? "New response" : session.runtimeState}
            />
          )
        )}
      </button>
      <details className="session-menu" data-menu-id={menuId} open={menuOpen}>
        <summary
          aria-label={`More options for ${sessionTitle(session)}`}
          aria-expanded={menuOpen}
          title="More options"
          onClick={(event) => {
            event.preventDefault();
            onToggleMenu(menuId, event.currentTarget);
          }}
        >
          <IconDots size={15} />
        </summary>
        <div className="session-menu-popover">
          <button
            type="button"
            disabled={unavailable}
            onClick={() => {
              onCloseMenu();
              onRename(session);
            }}
          >
            <IconPencil size={14} />
            Rename
          </button>
          <button
            type="button"
            onClick={() => {
              onCloseMenu();
              onCopySessionId(session.id);
            }}
          >
            <IconCopy size={14} />
            Copy session ID
          </button>
          <button
            type="button"
            disabled={unavailable}
            onClick={() => {
              onCloseMenu();
              onSetPinned(session, !session.pinned);
            }}
          >
            <IconPin size={14} />
            {session.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            disabled={unavailable}
            onClick={() => {
              onCloseMenu();
              onArchive(session);
            }}
          >
            <IconArchive size={14} />
            Archive
          </button>
          <button
            type="button"
            disabled={unavailable || session.active || session.pinned}
            title={
              session.active
                ? "The selected session must remain active"
                : session.pinned
                  ? "Unpin before deactivating"
                  : undefined
            }
            onClick={() => {
              onCloseMenu();
              onSetActive(session, sleeping);
            }}
          >
            <IconPower size={14} />
            {sleeping ? "Activate" : "Deactivate"}
          </button>
          <button
            className="is-danger"
            type="button"
            disabled={unavailable || session.active}
            title={
              session.active ? "Active session cannot be deleted" : undefined
            }
            onClick={() => {
              onCloseMenu();
              onDelete(session);
            }}
          >
            <IconTrash size={14} />
            Delete
          </button>
        </div>
      </details>
    </div>
  );
}

function orderByIds<T extends { id: string }>(items: T[], ids?: string[]): T[] {
  if (!ids) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  return [
    ...ids.flatMap((id) => byId.get(id) ?? []),
    ...items.filter((item) => !ids.includes(item.id)),
  ];
}

function moveBefore(ids: string[], id: string, before?: string): string[] {
  const next = ids.filter((value) => value !== id);
  const index = before ? next.indexOf(before) : -1;
  next.splice(index < 0 ? next.length : index, 0, id);
  return next;
}

function sameIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}
