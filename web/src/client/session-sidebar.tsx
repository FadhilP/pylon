import { IconArchive, IconChevronRight, IconDots, IconPencil, IconPlus, IconPower, IconSearch, IconSettings, IconStack2, IconTrash, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import type { SessionProjectPage, SessionSummary } from "../shared/protocol/snapshots";
import { formatRelativeTime } from "../shared/format";
import { displayDate, displayTime } from "./format";

export interface SessionProject {
  id: string;
  label: string;
  sessions: SessionSummary[];
  active: boolean;
}

export function sessionTitle(session: SessionSummary): string {
  return session.name || session.preview || "Untitled session";
}

interface SidebarProps {
  activeSessions: SessionSummary[];
  projects: SessionProject[];
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
  mobile: boolean;
  onClose: () => void;
  onQuery: (query: string) => void;
  onToggleProject: (projectId: string) => void;
  onSelectSession: (session: SessionSummary) => void;
  onDeleteSession: (session: SessionSummary) => void;
  onRenameSession: (session: SessionSummary) => void;
  onSetSessionActive: (session: SessionSummary, active: boolean) => void;
  onLoadMore: (project: SessionProject) => void;
  onAddProject: () => void;
  onOpenArchives: () => void;
  onOpenSettings: () => void;
  onArchiveProject: (project: SessionProject) => void;
  onRemoveProject: (project: SessionProject) => void;
  onArchiveSession: (session: SessionSummary) => void;
  onNewSession: (project: SessionProject) => void;
}

export function SessionSidebar({ activeSessions, projects, pages, query, searchRef, expandedProjects, loading, busy, deleting, projectLoading, projectBusy, isOpen, mobile, onClose, onQuery, onToggleProject, onSelectSession, onDeleteSession, onRenameSession, onSetSessionActive, onLoadMore, onAddProject, onOpenArchives, onOpenSettings, onArchiveProject, onRemoveProject, onArchiveSession, onNewSession }: SidebarProps) {
  const [openMenu, setOpenMenu] = useState("");
  const [activeSessionsOpen, setActiveSessionsOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const menuTrigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest(".session-menu") : null;
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
    setOpenMenu((current) => current === menuId ? "" : menuId);
  };
  const closeMenu = (restoreFocus = false) => {
    setOpenMenu("");
    if (restoreFocus) requestAnimationFrame(() => menuTrigger.current?.focus());
  };

  return (
    <aside id="primary-navigation" className={`sidebar ${isOpen ? "is-open" : ""}`} aria-label="Projects and sessions" aria-hidden={mobile && !isOpen} inert={mobile && !isOpen}>
      <div className="brand-row">
        <div className="brand-mark" aria-hidden="true"><IconStack2 size={18} stroke={1.8} /></div>
        <div className="brand-copy"><strong>Pylon</strong><span>Control center</span></div>
        <button className="icon-button mobile-close" onClick={onClose} aria-label="Close navigation"><IconX size={18} /></button>
      </div>

      <label className="session-search">
        <IconSearch size={15} />
        <span className="sr-only">Search projects and sessions</span>
        <input ref={searchRef} value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search sessions" />
        <kbd>Ctrl K</kbd>
      </label>

      <nav className="project-list">
        <section className="active-session-group" aria-labelledby="active-sessions-heading">
          <h2 className="nav-label" id="active-sessions-heading"><button type="button" aria-expanded={activeSessionsOpen} onClick={() => setActiveSessionsOpen((open) => !open)}>
            <IconChevronRight className={activeSessionsOpen ? "is-expanded" : ""} size={13} />
            Active sessions <small>{activeSessions.length}</small>
          </button></h2>
          {activeSessionsOpen && (activeSessions.length > 0
            ? <div className="active-session-list">{activeSessions.map((session) => <SessionRow
                key={session.id}
                session={session}
                menuId={`active-${session.id}`}
                menuOpen={openMenu === `active-${session.id}`}
                busy={busy}
                deleting={deleting}
                showProject
                now={now}
                onSelect={selectSession}
                onDelete={onDeleteSession}
                onArchive={onArchiveSession}
                onRename={onRenameSession}
                onSetActive={onSetSessionActive}
                onToggleMenu={toggleMenu}
                onCloseMenu={() => closeMenu(true)}
              />)}</div>
            : <p className="active-session-empty">No active sessions</p>)}
        </section>
        <div className="project-heading">
          <h2 className="nav-label"><button type="button" aria-expanded={projectsOpen || Boolean(query.trim())} onClick={() => setProjectsOpen((open) => !open)}>
            <IconChevronRight className={projectsOpen || query.trim() ? "is-expanded" : ""} size={13} />
            Projects
          </button></h2>
          <div>
            <button className="project-add" type="button" onClick={onOpenArchives} disabled={Boolean(projectBusy || busy || deleting)}><IconArchive size={13} />Archived</button>
            <button className="project-add" type="button" onClick={onAddProject} disabled={Boolean(projectBusy || busy || deleting)} aria-label="Add project"><IconPlus size={14} />Add project</button>
          </div>
        </div>
        {(projectsOpen || Boolean(query.trim())) && loading && projects.length === 0 && <div className="sidebar-state">Loading sessions...</div>}
        {(projectsOpen || Boolean(query.trim())) && projects.map((project) => {
          const expanded = Boolean(query.trim()) || expandedProjects.has(project.id);
          const page = pages.find((candidate) => candidate.id === project.id);
          return <section className="project-group" key={project.id}>
            <div className="project-row">
              <button type="button" className={`project-toggle ${project.active ? "is-active" : ""}`} onClick={() => onToggleProject(project.id)} aria-expanded={expanded}>
                <IconChevronRight className={expanded ? "is-expanded" : ""} size={13} />
                <IconStack2 size={14} />
                <span>{project.label}</span>
                <small>{page?.totalCount ?? project.sessions.length}</small>
              </button>
              <button className="project-new" type="button" onClick={() => onNewSession(project)} disabled={Boolean(busy || deleting || projectBusy)} aria-label={`New session in ${project.label}`} title={`New session in ${project.label}`}>
                <IconPlus size={14} />
              </button>
              <details className="session-menu project-menu" data-menu-id={`project-${project.id}`} open={openMenu === `project-${project.id}`}>
                <summary
                  aria-label={`More options for ${project.label}`}
                  aria-expanded={openMenu === `project-${project.id}`}
                  title="More options"
                  onClick={(event) => {
                    event.preventDefault();
                    toggleMenu(`project-${project.id}`, event.currentTarget);
                  }}
                ><IconDots size={15} /></summary>
                <div className="session-menu-popover">
                  <button type="button" disabled={Boolean(projectBusy || busy || deleting)} onClick={() => {
                    closeMenu(true);
                    onArchiveProject(project);
                  }}><IconArchive size={14} />Archive</button>
                  <button className="is-danger" type="button" disabled={Boolean(projectBusy || busy || deleting)} onClick={() => {
                    closeMenu(true);
                    onRemoveProject(project);
                  }}><IconTrash size={14} />Remove project</button>
                </div>
              </details>
            </div>
            {expanded && <div className="project-sessions">
              {project.sessions.map((session) => <SessionRow
                key={session.id}
                session={session}
                menuId={`project-${project.id}-${session.id}`}
                menuOpen={openMenu === `project-${project.id}-${session.id}`}
                busy={busy}
                deleting={deleting}
                now={now}
                onSelect={selectSession}
                onDelete={onDeleteSession}
                onArchive={onArchiveSession}
                onRename={onRenameSession}
                onSetActive={onSetSessionActive}
                onToggleMenu={toggleMenu}
                onCloseMenu={() => closeMenu(true)}
              />)}
              {page?.nextCursor && <button className="session-show-more" type="button" onClick={() => onLoadMore(project)} disabled={projectLoading === project.id}>
                {projectLoading === project.id ? "Loading…" : `Show ${Math.min(10, page.totalCount - page.sessions.length)} more`}
              </button>}
            </div>}
          </section>;
        })}
        {(projectsOpen || Boolean(query.trim())) && !loading && projects.length === 0 && <div className="sidebar-state">{query ? "No matching sessions." : "No projects yet. Add a folder to start."}</div>}
      </nav>

      <div className="sidebar-foot">
        <button className="sidebar-settings" type="button" onClick={onOpenSettings}><IconSettings size={16} />Settings</button>
      </div>
    </aside>
  );
}

function SessionRow({ session, menuId, menuOpen, busy, deleting, now, showProject = false, onSelect, onDelete, onArchive, onRename, onSetActive, onToggleMenu, onCloseMenu }: {
  session: SessionSummary;
  menuId: string;
  menuOpen: boolean;
  busy: string;
  deleting: string;
  now: number;
  showProject?: boolean;
  onSelect: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  onArchive: (session: SessionSummary) => void;
  onRename: (session: SessionSummary) => void;
  onSetActive: (session: SessionSummary, active: boolean) => void;
  onToggleMenu: (menuId: string, trigger: HTMLElement) => void;
  onCloseMenu: () => void;
}) {
  const unavailable = Boolean(busy || deleting);
  const sleeping = session.runtimeState === "sleeping";

  return <div className={`session-row ${session.active ? "is-active" : ""}`}>
    <button
      className={`session-link ${session.active ? "is-active" : ""}`}
      type="button"
      onClick={() => onSelect(session)}
      disabled={unavailable}
      aria-current={session.active ? "page" : undefined}
    >
      <span className="session-copy">
        <strong>{sessionTitle(session)}</strong>
        <small>
          {showProject ? `${session.cwdLabel} · ` : ""}
          <time dateTime={session.createdAt} title={`Created ${displayTime(session.createdAt)}`}>{displayDate(session.createdAt)}</time>
          {" · "}
          <time dateTime={session.modifiedAt} title={`Last active ${displayTime(session.modifiedAt)}`}>Active {formatRelativeTime(session.modifiedAt, now)} ago</time>
        </small>
      </span>
      {!sleeping && <span className={`session-runtime-state is-${session.runtimeState}`} aria-label={session.runtimeState} title={session.runtimeState} />}
      {(busy === session.id || deleting === session.id) && <span className="status-orb success" aria-label={deleting === session.id ? "Deleting" : "Updating"} />}
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
      ><IconDots size={15} /></summary>
      <div className="session-menu-popover">
        <button type="button" disabled={unavailable} onClick={() => { onCloseMenu(); onRename(session); }}><IconPencil size={14} />Rename</button>
        <button type="button" disabled={unavailable} onClick={() => { onCloseMenu(); onArchive(session); }}><IconArchive size={14} />Archive</button>
        <button
          type="button"
          disabled={unavailable || session.active}
          title={session.active ? "The selected session must remain active" : undefined}
          onClick={() => { onCloseMenu(); onSetActive(session, sleeping); }}
        ><IconPower size={14} />{sleeping ? "Activate" : "Deactivate"}</button>
        <button
          className="is-danger"
          type="button"
          disabled={unavailable || session.active}
          title={session.active ? "Active session cannot be deleted" : undefined}
          onClick={() => { onCloseMenu(); onDelete(session); }}
        ><IconTrash size={14} />Delete</button>
      </div>
    </details>
  </div>;
}
