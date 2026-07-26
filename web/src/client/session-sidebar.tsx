import { IconChevronRight, IconPlus, IconSearch, IconStack2, IconTrash, IconX } from "@tabler/icons-react";
import type { RefObject } from "react";
import type { RuntimeStoreSnapshot } from "./runtime/event-store";
import type { SessionProjectPage, SessionSummary } from "../shared/protocol/snapshots";
import { displayTime } from "./format";

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
  live: RuntimeStoreSnapshot;
  projects: SessionProject[];
  pages: SessionProjectPage[];
  query: string;
  searchRef: RefObject<HTMLInputElement | null>;
  expandedProjects: Set<string>;
  loading: boolean;
  error: string;
  busy: string;
  deleting: string;
  projectLoading: string;
  isOpen: boolean;
  mobile: boolean;
  onClose: () => void;
  onQuery: (query: string) => void;
  onToggleProject: (projectId: string) => void;
  onSelectSession: (session: SessionSummary) => void;
  onDeleteSession: (session: SessionSummary) => void;
  onLoadMore: (project: SessionProject) => void;
  onNewSession: (project: SessionProject) => void;
}

export function SessionSidebar({ live, projects, pages, query, searchRef, expandedProjects, loading, error, busy, deleting, projectLoading, isOpen, mobile, onClose, onQuery, onToggleProject, onSelectSession, onDeleteSession, onLoadMore, onNewSession }: SidebarProps) {
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
        <p className="nav-label">Projects</p>
        {loading && projects.length === 0 && <div className="sidebar-state">Loading sessions...</div>}
        {projects.map((project) => {
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
              <button className="project-new" type="button" onClick={() => onNewSession(project)} disabled={Boolean(busy || deleting)} aria-label={`New session in ${project.label}`} title={`New session in ${project.label}`}>
                <IconPlus size={14} />
              </button>
            </div>
            {expanded && <div className="project-sessions">
              {project.sessions.map((session) => <div className="session-row" key={session.id}>
                <button
                  className={`session-link ${session.active ? "is-active" : ""}`}
                  type="button"
                  onClick={() => onSelectSession(session)}
                  disabled={Boolean(busy || deleting)}
                  aria-current={session.active ? "page" : undefined}
                >
                  <span className="session-copy"><strong>{sessionTitle(session)}</strong><small>{session.userMessageCount} user {session.userMessageCount === 1 ? "message" : "messages"} · {displayTime(session.modifiedAt)}</small></span>
                  {session.runtimeState !== "sleeping" && <span className={`session-runtime-state is-${session.runtimeState}`} aria-label={session.runtimeState} title={session.runtimeState} />}
                  {(busy === session.id || deleting === session.id) && <span className="status-orb success" aria-label={deleting === session.id ? "Deleting" : "Switching"} />}
                </button>
                <button
                  className="session-delete"
                  type="button"
                  onClick={() => onDeleteSession(session)}
                  disabled={session.active || Boolean(busy || deleting)}
                  aria-label={session.active ? `${sessionTitle(session)} is active and cannot be deleted` : `Delete ${sessionTitle(session)}`}
                  title={session.active ? "Active session cannot be deleted" : `Delete ${sessionTitle(session)}`}
                ><IconTrash size={13} /></button>
              </div>)}
              {page?.nextCursor && <button className="session-show-more" type="button" onClick={() => onLoadMore(project)} disabled={projectLoading === project.id}>
                {projectLoading === project.id ? "Loading…" : `Show ${Math.min(10, page.totalCount - page.sessions.length)} more`}
              </button>}
            </div>}
          </section>;
        })}
        {!loading && projects.length === 0 && <div className="sidebar-state">{query ? "No matching sessions." : "No saved sessions."}</div>}
      </nav>

      <div className="sidebar-foot">
        {error && <p className="sidebar-error" role="alert">{error}</p>}
        <div className="session-health">
          <span className={`status-orb ${live.connection === "connected" ? "success" : ""}`} aria-hidden="true" />
          <span><strong>{live.connection}</strong><small>{live.runtime?.sessionId || "Waiting for runtime"}</small></span>
        </div>
      </div>
    </aside>
  );
}
