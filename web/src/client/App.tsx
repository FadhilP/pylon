import {
  IconBrandGit,
  IconGitBranch,
  IconLayoutDashboard,
  IconMenu2,
  IconMoon,
  IconSun,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PackageSummary, SessionProjectPage, SessionSummary } from "../shared/protocol/snapshots";
import { ConversationPanel } from "./conversation-panel";
import { Inspector, type ViewId } from "./inspector";
import { runtimeStore, useRuntimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";
import { SessionSidebar, sessionTitle, type SessionProject } from "./session-sidebar";
import { UiDialog } from "./ui-dialog";

type Theme = "light" | "dark";

function readInitialTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function App() {
  const [view, setView] = useState<ViewId>("overview");
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [sessionPages, setSessionPages] = useState<SessionProjectPage[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState("");
  const [sessionBusy, setSessionBusy] = useState("");
  const [sessionDeleting, setSessionDeleting] = useState("");
  const [projectLoading, setProjectLoading] = useState("");
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [packagesError, setPackagesError] = useState("");
  const [packageBusy, setPackageBusy] = useState("");
  const [query, setQuery] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const previousSidebarOpen = useRef(sidebarOpen);
  const previousInspectorOpen = useRef(inspectorOpen);
  const sessionListRequest = useRef(0);
  const mobile = useMediaQuery("(max-width: 900px)");
  const inspectorOverlay = useMediaQuery("(max-width: 1179px)");
  const live = useRuntimeStore();
  const projects = useMemo<SessionProject[]>(() => sessionPages.map((page) => ({
    id: page.id,
    label: page.label,
    sessions: page.sessions,
    active: page.sessions.some((session) => session.active),
  })), [sessionPages]);
  const sessions = useMemo(() => sessionPages.flatMap((page) => page.sessions), [sessionPages]);
  const activeSession = sessions.find((session) => session.active);
  const activePackages = useMemo(() => new Set(packages.filter((item) => item.active).map((item) => item.id)), [packages]);
  const availableViews = useMemo(() => new Set<ViewId>([
    "overview",
    ...(activePackages.has("pi-timeline") ? ["timeline" as const] : []),
    "tools",
    "settings",
  ]), [activePackages]);

  useEffect(() => { runtimeStore.start(); }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pylon-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#111318" : "#e9eaec");
  }, [theme]);

  useEffect(() => { document.title = live.runtime?.extensionUi.title || "Pylon"; }, [live.runtime?.extensionUi.title]);

  useEffect(() => {
    if (mobile && previousSidebarOpen.current && !sidebarOpen) navigationToggleRef.current?.focus();
    previousSidebarOpen.current = sidebarOpen;
  }, [mobile, sidebarOpen]);

  useEffect(() => {
    if (inspectorOverlay && previousInspectorOpen.current && !inspectorOpen) inspectorToggleRef.current?.focus();
    previousInspectorOpen.current = inspectorOpen;
  }, [inspectorOpen, inspectorOverlay]);

  useEffect(() => {
    if (live.connection !== "connected" || !live.runtime?.ready) return;
    let active = true;
    const request = ++sessionListRequest.current;
    setSessionsLoading(true);
    setSessionsError("");
    const timer = window.setTimeout(() => void runtimeStore.listSessions({ query: query.trim() || undefined, limit: 10 }).then((result) => {
      if (!active || request !== sessionListRequest.current) return;
      setSessionPages(result.projects);
      const projectId = result.projects.find((page) => page.sessions.some((session) => session.active))?.id;
      if (projectId) setExpandedProjects((current) => new Set([...current, projectId]));
    }).catch((cause) => {
      if (active && request === sessionListRequest.current) setSessionsError(cause instanceof Error ? cause.message : "Unable to list sessions");
    }).finally(() => {
      if (active && request === sessionListRequest.current) setSessionsLoading(false);
    }), query ? 200 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [live.connection, live.runtime?.ready, live.runtime?.sessionGeneration, query]);

  useEffect(() => {
    if (live.connection !== "connected" || !live.runtime?.ready) return;
    let active = true;
    setPackagesLoading(true);
    setPackagesError("");
    void runtimeStore.listPackages().then((result) => {
      if (active) setPackages(result.packages);
    }).catch((cause) => {
      if (active) setPackagesError(cause instanceof Error ? cause.message : "Unable to list packages");
    }).finally(() => {
      if (active) setPackagesLoading(false);
    });
    return () => { active = false; };
  }, [live.connection, live.runtime?.ready, live.runtime?.sessionGeneration]);

  useEffect(() => {
    if (!availableViews.has(view)) setView("overview");
  }, [availableViews, view]);

  useEffect(() => {
    if (!live.sessionStatuses) return;
    setSessionPages((pages) => pages.map((page) => ({
      ...page,
      sessions: page.sessions.map((session) => ({
        ...session,
        runtimeState: live.sessionStatuses?.[session.id] ?? session.runtimeState,
      })),
    })));
  }, [live.sessionStatuses]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (live.pendingUi?.owned) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSidebarCollapsed(false);
        if (mobile) setSidebarOpen(true);
        requestAnimationFrame(() => searchRef.current?.focus());
      }
      if (event.key === "Escape") {
        setSidebarOpen(false);
        if (inspectorOverlay) setInspectorOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspectorOverlay, live.pendingUi?.owned, mobile]);

  const selectView = (next: ViewId) => {
    setView(next);
    setInspectorOpen(true);
  };

  const switchSession = async (session: SessionSummary) => {
    if (session.active || sessionBusy || sessionDeleting) {
      if (mobile) setSidebarOpen(false);
      return;
    }
    setSessionBusy(session.id);
    setSessionsError("");
    try {
      await runtimeStore.switchSession(session.id);
      if (mobile) setSidebarOpen(false);
    } catch (cause) {
      setSessionsError(cause instanceof Error ? cause.message : "Unable to switch session");
    } finally {
      setSessionBusy("");
    }
  };

  const newSession = async (project: SessionProject) => {
    if (sessionBusy || sessionDeleting || !project.sessions[0]) return;
    setSessionBusy(project.id);
    setSessionsError("");
    try {
      await runtimeStore.newSession(project.sessions[0].id);
      if (mobile) setSidebarOpen(false);
    } catch (cause) {
      setSessionsError(cause instanceof Error ? cause.message : "Unable to create session");
    } finally {
      setSessionBusy("");
    }
  };

  const deleteSession = async (session: SessionSummary) => {
    if (session.active || sessionBusy || sessionDeleting) return;
    const title = sessionTitle(session);
    if (!window.confirm(`Delete "${title}"?\n\nThis removes its saved history. If system trash is unavailable, deletion is permanent.`)) return;
    setSessionDeleting(session.id);
    setSessionsError("");
    sessionListRequest.current++;
    try {
      await runtimeStore.deleteSession(session.id);
      setSessionPages((current) => current.map((page) => ({
        ...page,
        totalCount: page.id === session.projectId ? Math.max(0, page.totalCount - 1) : page.totalCount,
        sessions: page.sessions.filter((candidate) => candidate.id !== session.id),
      })).filter((page) => page.totalCount > 0));
      const request = ++sessionListRequest.current;
      try {
        const result = await runtimeStore.listSessions({ query: query.trim() || undefined, limit: 10 });
        if (request === sessionListRequest.current) setSessionPages(result.projects);
      } catch (cause) {
        setSessionsError(cause instanceof Error ? `Session deleted, but refresh failed: ${cause.message}` : "Session deleted, but refresh failed");
      }
    } catch (cause) {
      setSessionsError(cause instanceof Error ? cause.message : "Unable to delete session");
    } finally {
      setSessionDeleting("");
    }
  };

  const loadMoreSessions = async (project: SessionProject) => {
    const current = sessionPages.find((page) => page.id === project.id);
    if (!current?.nextCursor || projectLoading) return;
    setProjectLoading(project.id);
    setSessionsError("");
    try {
      const result = await runtimeStore.listSessions({
        projectId: project.id,
        cursor: current.nextCursor,
        query: query.trim() || undefined,
        limit: 10,
      });
      const next = result.projects[0];
      if (!next) return;
      setSessionPages((pages) => pages.map((page) => page.id === project.id ? {
        ...page,
        sessions: [...page.sessions, ...next.sessions.filter((session) => !page.sessions.some((old) => old.id === session.id))],
        nextCursor: next.nextCursor,
      } : page));
    } catch (cause) {
      setSessionsError(cause instanceof Error ? cause.message : "Unable to load more sessions");
    } finally {
      setProjectLoading("");
    }
  };

  const toggleSidebar = () => {
    if (mobile) {
      setInspectorOpen(false);
      setSidebarOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((collapsed) => !collapsed);
  };

  const toggleInspector = () => {
    if (inspectorOverlay) setSidebarOpen(false);
    setInspectorOpen((open) => !open);
  };

  const setPackageEnabled = async (item: PackageSummary, enabled: boolean) => {
    if (packageBusy) return;
    setPackageBusy(item.id);
    setPackagesError("");
    try {
      await runtimeStore.setPackageEnabled(item.id, enabled);
    } catch (cause) {
      setPackagesError(cause instanceof Error ? cause.message : "Unable to update package");
    } finally {
      setPackageBusy("");
    }
  };

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <SessionSidebar
        live={live}
        projects={projects}
        pages={sessionPages}
        query={query}
        searchRef={searchRef}
        expandedProjects={expandedProjects}
        loading={sessionsLoading}
        error={sessionsError}
        busy={sessionBusy}
        deleting={sessionDeleting}
        projectLoading={projectLoading}
        isOpen={sidebarOpen}
        mobile={mobile}
        onClose={() => setSidebarOpen(false)}
        onQuery={setQuery}
        onToggleProject={(projectId) => setExpandedProjects((current) => {
          const next = new Set(current);
          if (next.has(projectId)) next.delete(projectId);
          else next.add(projectId);
          return next;
        })}
        onSelectSession={(session) => void switchSession(session)}
        onDeleteSession={(session) => void deleteSession(session)}
        onLoadMore={(project) => void loadMoreSessions(project)}
        onNewSession={(project) => {
          const unfiltered = projects.find((candidate) => candidate.id === project.id);
          if (unfiltered) void newSession(unfiltered);
        }}
      />
      {mobile && sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}

      <main className="content-card" id="main-content">
        <Topbar
          live={live}
          session={activeSession}
          theme={theme}
          onToggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")}
          menuOpen={mobile ? sidebarOpen : !sidebarCollapsed}
          inspectorOpen={inspectorOpen}
          menuButtonRef={navigationToggleRef}
          inspectorButtonRef={inspectorToggleRef}
          onToggleMenu={toggleSidebar}
          onToggleInspector={toggleInspector}
        />
        <div className={`workspace-layout ${inspectorOpen ? "has-inspector" : ""}`}>
          <ConversationPanel key={live.runtime?.sessionId || "loading"} live={live} />
          {inspectorOpen && inspectorOverlay && <button className="inspector-scrim" aria-label="Close inspector" onClick={() => setInspectorOpen(false)} />}
          <Inspector
            current={view}
            live={live}
            packages={packages}
            packagesLoading={packagesLoading}
            packagesError={packagesError}
            packageBusy={packageBusy}
            availableViews={availableViews}
            isOpen={inspectorOpen}
            overlay={inspectorOverlay}
            onClose={() => setInspectorOpen(false)}
            onNavigate={selectView}
            onSetPackageEnabled={(item, enabled) => void setPackageEnabled(item, enabled)}
          />
        </div>
        {(sessionBusy || packageBusy) && <div className="session-transition" role="status"><span className="status-orb success" />{packageBusy ? "Reloading packages..." : "Changing session..."}</div>}
      </main>

      {live.pendingUi && <UiDialog key={live.pendingUi.requestId} request={live.pendingUi} />}
    </div>
  );
}

function Topbar({ live, session, theme, menuOpen, inspectorOpen, menuButtonRef, inspectorButtonRef, onToggleTheme, onToggleMenu, onToggleInspector }: { live: RuntimeStoreSnapshot; session?: SessionSummary; theme: Theme; menuOpen: boolean; inspectorOpen: boolean; menuButtonRef: React.RefObject<HTMLButtonElement | null>; inspectorButtonRef: React.RefObject<HTMLButtonElement | null>; onToggleTheme: () => void; onToggleMenu: () => void; onToggleInspector: () => void }) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button ref={menuButtonRef} className="icon-button navigation-toggle" onClick={onToggleMenu} aria-label="Toggle project navigation" aria-controls="primary-navigation" aria-expanded={menuOpen}><IconMenu2 size={18} /></button>
        <div className="repo-crumb">
          <IconBrandGit size={16} stroke={1.7} />
          <span>{live.runtime?.cwdLabel || "Pylon"} / <strong>{session ? sessionTitle(session) : live.connection}</strong></span>
        </div>
        <span className="topbar-divider" />
        <div className="branch-label"><IconGitBranch size={14} /><span>{live.connection} · generation {live.runtime?.sessionGeneration ?? 0}</span></div>
      </div>
      <div className="topbar-actions">
        <span className="preview-badge">{live.runtime?.ready ? "Live runtime" : "Connecting"}</span>
        <button ref={inspectorButtonRef} className={`icon-button ${inspectorOpen ? "is-active" : ""}`} onClick={onToggleInspector} aria-label="Toggle inspector" aria-controls="session-inspector" aria-expanded={inspectorOpen}><IconLayoutDashboard size={17} /></button>
        <button className="icon-button" onClick={onToggleTheme} aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}>
          {theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
        </button>
        <span className="avatar-button" aria-label="Current user">FP</span>
      </div>
    </header>
  );
}
