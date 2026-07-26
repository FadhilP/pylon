import {
  IconActivity,
  IconArrowUp,
  IconArrowUpRight,
  IconBolt,
  IconBrandGit,
  IconCheck,
  IconChevronRight,
  IconCircle,
  IconClock,
  IconCpu,
  IconGitBranch,
  IconLayoutDashboard,
  IconListCheck,
  IconMenu2,
  IconMoon,
  IconPhoto,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShieldCheck,
  IconStack2,
  IconSun,
  IconTerminal2,
  IconTimeline,
  IconTool,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type ComponentType, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { groupConversationMessages } from "./shared/conversation";
import { runtimeStore, useRuntimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";
import { activeProjectId, sessionTitle, type SessionProject } from "./session-navigation";
import type { PromptImage } from "./shared/protocol/commands";
import type { MessageReadModel } from "./shared/protocol/events";
import type { PackageSummary, SessionProjectPage, SessionSummary } from "./shared/protocol/snapshots";

type ViewId = "overview" | "timeline" | "tools" | "settings";
type Tone = "success" | "warning" | "danger" | "neutral" | "active";
type IconComponent = ComponentType<{ size?: number; stroke?: number; className?: string }>;
type Theme = "light" | "dark";

const navigation: Array<{ label: string; items: Array<{ id: ViewId; label: string; icon: IconComponent; hint: string }> }> = [
  {
    label: "Workspace",
    items: [
      { id: "overview", label: "Overview", icon: IconLayoutDashboard, hint: "Run summary" },
      { id: "timeline", label: "Timeline", icon: IconTimeline, hint: "Checkpoints" },
    ],
  },
  {
    label: "System",
    items: [
      { id: "tools", label: "Tools", icon: IconTool, hint: "Policies and usage" },
      { id: "settings", label: "Settings", icon: IconSettings, hint: "Optional packages" },
    ],
  },
];

const viewCopy: Record<ViewId, { title: string; description: string }> = {
  overview: { title: "Workspace overview", description: "Live state for the active Pylon session." },
  timeline: { title: "Timeline", description: "Recoverable checkpoints across the current run." },
  tools: { title: "Tools", description: "Package policies, availability, and session usage." },
  settings: { title: "Settings", description: "Choose which local Pi packages run in every session." },
};

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
      const projectId = activeProjectId(result.projects.map((page) => ({
        id: page.id,
        label: page.label,
        sessions: page.sessions,
        active: page.sessions.some((session) => session.active),
      })));
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
      <Sidebar
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

interface SidebarProps {
  live: RuntimeStoreSnapshot;
  projects: SessionProject[];
  pages: SessionProjectPage[];
  query: string;
  searchRef: React.RefObject<HTMLInputElement | null>;
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

function Sidebar({ live, projects, pages, query, searchRef, expandedProjects, loading, error, busy, deleting, projectLoading, isOpen, mobile, onClose, onQuery, onToggleProject, onSelectSession, onDeleteSession, onLoadMore, onNewSession }: SidebarProps) {
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

interface InspectorProps {
  current: ViewId;
  live: RuntimeStoreSnapshot;
  packages: PackageSummary[];
  packagesLoading: boolean;
  packagesError: string;
  packageBusy: string;
  availableViews: Set<ViewId>;
  isOpen: boolean;
  overlay: boolean;
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
  onSetPackageEnabled: (item: PackageSummary, enabled: boolean) => void;
}

function Inspector({ current, live, packages, packagesLoading, packagesError, packageBusy, availableViews, isOpen, overlay, onClose, onNavigate, onSetPackageEnabled }: InspectorProps) {
  const copy = viewCopy[current];
  const items = navigation.flatMap((group) => group.items).filter((item) => availableViews.has(item.id));
  const activePackages = new Set(packages.filter((item) => item.active).map((item) => item.id));
  return (
    <aside id="session-inspector" className={`inspector ${isOpen ? "is-open" : ""}`} aria-label="Session inspector" aria-hidden={!isOpen} inert={!isOpen}>
      <header className="inspector-header">
        <div><span className="section-kicker">Inspector</span><h2>{copy.title}</h2></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label={overlay ? "Close inspector" : "Collapse inspector"}><IconX size={17} /></button>
      </header>
      <div className="inspector-tabs" role="tablist" aria-label="Session details">
        {items.map((item) => {
          const Icon = item.icon;
          return <button type="button" role="tab" aria-label={item.label} aria-selected={current === item.id} className={current === item.id ? "is-active" : ""} key={item.id} onClick={() => onNavigate(item.id)}>
            <Icon size={14} /><span>{item.label}</span>
          </button>;
        })}
      </div>
      <p className="inspector-description">{copy.description}</p>
      <div className="inspector-scroll" role="tabpanel">
        {current === "overview" && <Overview onNavigate={onNavigate} live={live} activePackages={activePackages} />}
        {current === "timeline" && <Timeline live={live} />}
        {current === "tools" && <Tools live={live} pylonPolicies={activePackages.has("pylon-core")} />}
        {current === "settings" && <Settings
          live={live}
          packages={packages}
          loading={packagesLoading}
          error={packagesError}
          busy={packageBusy}
          onSetEnabled={onSetPackageEnabled}
        />}
      </div>
    </aside>
  );
}

function Overview({ onNavigate, live, activePackages }: { onNavigate: (view: ViewId) => void; live: RuntimeStoreSnapshot; activePackages: Set<string> }) {
  const runtime = live.runtime;
  const metrics = runtime?.metrics;
  const operational = runtime?.operational;
  const work = operational?.continuity.work;
  const recentActivity = [
    activePackages.has("pi-guard") && operational?.guard.decision ? { id: "guard", source: "Guard", action: operational.guard.reason || operational.guard.decision, tone: operational.guard.decision === "blocked" ? "warning" as Tone : "success" as Tone } : undefined,
    activePackages.has("pi-verify") && operational?.verification.state ? { id: "verify", source: "Verify", action: `Verification ${operational.verification.state}`, tone: operational.verification.state === "passed" ? "success" as Tone : "neutral" as Tone } : undefined,
    ...(activePackages.has("pi-heartbeat") ? (operational?.jobs.items ?? []).slice(-2).reverse().map((job) => ({ id: job.id, source: "Heartbeat", action: `${job.label}: ${job.state}`, tone: job.state === "failed" ? "warning" as Tone : "neutral" as Tone })) : []),
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));
  return (
    <div className="page-grid">
      <section className="metric-strip" aria-label="Session metrics">
        <Metric label="Context used" value={metrics ? `${metrics.contextPercent.toLocaleString(undefined, { maximumFractionDigits: 2 })}%` : "—"} detail={metrics ? `${metrics.contextTokens.toLocaleString()} of ${metrics.contextLimit.toLocaleString()}` : "No metrics yet"} icon={IconCpu} />
        <Metric label="Tool calls" value={metrics ? String(metrics.toolCalls) : "—"} detail={runtime?.conversation.streaming ? "Agent streaming" : "Agent idle"} icon={IconActivity} />
        <Metric label="Session cost" value={metrics ? `$${metrics.cost.toFixed(2)}` : "—"} detail={metrics?.model || "No model connected"} icon={IconTerminal2} />
      </section>

      <div className="overview-columns">
        {activePackages.has("pi-continuity") && <section className="panel run-panel">
          <PanelHeader title="Current run" meta={work ? displayTime(work.updatedAt) : undefined} />
          {operational?.continuity.availability === "unavailable" ? <FeatureUnavailable name="Continuity" /> : work ? <>
            <div className="run-title-row">
              <div className="run-icon"><IconListCheck size={20} /></div>
              <div><h2>{work.goal}</h2><p className="mono">{work.runId || "Current session"}</p></div>
            </div>
            <div className="run-meta-row">
              <Status tone={work.mode === "executing" ? "active" : work.mode === "completed" ? "success" : "neutral"}>{work.mode}</Status>
              <span>{work.todos.filter((todo) => todo.status === "done").length} of {work.todos.length} complete</span>
            </div>
            <TodoList work={work} />
          </> : <div className="empty-state"><IconListCheck size={20} /><strong>No active work</strong><span>Continuity has no plan for this session.</span></div>}
        </section>}

        {(activePackages.has("pi-guard") || activePackages.has("pi-verify") || activePackages.has("pi-heartbeat")) && <section className="panel activity-panel">
          <PanelHeader title="Activity" meta="Live package state" />
          <div className="activity-list">
            {recentActivity.map((event) => (
              <div className="activity-row" key={event.id}>
                <span className={`activity-icon tone-${event.tone}`}><IconBolt size={14} /></span>
                <div><strong>{event.source}</strong><p>{event.action}</p></div>
              </div>
            ))}
            {recentActivity.length === 0 && <div className="conversation-state">No operational activity yet.</div>}
          </div>
          {activePackages.has("pi-timeline") && <button className="text-button" type="button" onClick={() => onNavigate("timeline")}>View full timeline<IconArrowUpRight size={14} /></button>}
        </section>}
      </div>

      <div className="overview-lower">
        {activePackages.has("pi-verify") && <section className="panel verification-panel">
          <PanelHeader title="Verification" meta={operational?.verification.scope || "No run"} />
          {operational?.verification.availability === "unavailable" ? <FeatureUnavailable name="Verify" /> : <div className="check-list">
            {operational?.verification.checks.map((check) => (
              <div className="check-row" key={check.id}>
                <span className={`check-icon ${check.status}`}>
                  {check.status === "passed" ? <IconCheck size={13} /> : <IconClock size={13} />}
                </span>
                <div><strong>{check.label}</strong><small>{check.command || check.status}</small></div>
                <span className="mono">{formatDuration(check.durationMs)}</span>
              </div>
            ))}
            {operational?.verification.checks.length === 0 && <div className="conversation-state">{operational?.verification.message || (operational?.verification.state ? `Verification ${operational.verification.state}.` : "No verification run yet.")}</div>}
          </div>}
        </section>}

        <section className="panel tools-summary">
          <PanelHeader title="Tool surface" meta={`${operational?.tools.policies.length ?? 0} policies`} action="Manage" onAction={() => onNavigate("tools")} />
          <div className="tool-summary-grid">
            <div><span>{runtime?.activeTools.length ?? 0}</span><small>Active tools</small></div>
            <div><span>{operational?.tools.policies.reduce((total, policy) => total + policy.deferredTools.length, 0) ?? 0}</span><small>Deferred</small></div>
            <div><span>{activePackages.has("pi-guard") ? operational?.guard.blocked ?? 0 : runtime?.availableTools.length ?? 0}</span><small>{activePackages.has("pi-guard") ? "Blocked" : "Available"}</small></div>
          </div>
          {activePackages.has("pi-guard") && <div className="policy-note"><IconShieldCheck size={16} /><span><strong>{operational?.guard.availability === "available" ? "Guard available" : "Guard unavailable"}</strong><small>{operational?.guard.reason || "Destructive writes require package confirmation."}</small></span></div>}
        </section>
      </div>
    </div>
  );
}

function ConversationPanel({ live }: { live: RuntimeStoreSnapshot }) {
  const [message, setMessage] = useState("");
  const [images, setImages] = useState<Array<PromptImage & { id: string }>>([]);
  const [imageError, setImageError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [controlBusy, setControlBusy] = useState("");
  const streamRef = useRef<HTMLDivElement>(null);
  const runtime = live.runtime;
  const controls = runtime?.sessionControls;
  const editorRevision = runtime?.extensionUi.editorRevision ?? 0;
  const editorText = runtime?.extensionUi.editorText ?? "";
  useEffect(() => { if (editorRevision > 0) setMessage(editorText); }, [editorRevision, editorText]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (streamRef.current) streamRef.current.scrollTop = streamRef.current.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [runtime?.sessionId]);
  const connected = live.connection === "connected" && runtime?.ready === true;
  const streaming = runtime?.conversation.streaming === true;
  const visibleMessages = runtime?.conversation.messages.filter((item) => {
    const text = item.text.trim();
    return item.role !== "assistant" || !["", "...", "…"].includes(text);
  }) ?? [];
  const conversationBlocks = groupConversationMessages(visibleMessages, streaming);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = message.trim();
    if ((!value && images.length === 0) || !connected) return;
    setSubmitting(true);
    try {
      await runtimeStore.sendMessage(value, images.map(({ data, mimeType }) => ({ data, mimeType })));
      setMessage("");
      setImages([]);
      setImageError("");
    }
    catch { /* Store exposes the command error in the live connection state. */ }
    finally { setSubmitting(false); }
  };
  const onPaste = async (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.type))
      .flatMap((item) => item.getAsFile() ?? []);
    if (!files.length) return;
    event.preventDefault();
    const available = 4 - images.length;
    if (files.length > available) {
      setImageError("You can attach up to 4 images.");
      return;
    }
    if (files.some((file) => file.size > 5 * 1024 * 1024)
      || files.reduce((total, file) => total + file.size, 0) + imageBytes(images) > 15 * 1024 * 1024) {
      setImageError("Images must be 5 MB each and 15 MB total.");
      return;
    }
    try {
      const pasted = await Promise.all(files.map(async (file) => ({
        id: crypto.randomUUID(),
        mimeType: file.type as PromptImage["mimeType"],
        data: await fileBase64(file),
      })));
      setImages((current) => [...current, ...pasted]);
      setImageError("");
    } catch {
      setImageError("The pasted image could not be read.");
    }
  };
  const setModel = async (value: string) => {
    const model = controls?.models.find((item) => `${item.provider}/${item.id}` === value);
    if (!model) return;
    setControlBusy("model");
    try { await runtimeStore.setModel(model.provider, model.id); }
    catch { /* Store exposes the command error in the live connection state. */ }
    finally { setControlBusy(""); }
  };
  const setThinking = async (level: NonNullable<typeof controls>["thinkingLevels"][number]) => {
    setControlBusy("thinking");
    try { await runtimeStore.setThinkingLevel(level); }
    catch { /* Store exposes the command error in the live connection state. */ }
    finally { setControlBusy(""); }
  };
  const controlsDisabled = !connected || streaming || submitting || Boolean(controlBusy);
  const onPromptKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };
  return (
    <section className="conversation-panel" aria-label="Live conversation">
      {live.connection === "loading" && <div className="conversation-state">Loading runtime…</div>}
      {live.connection === "error" && <div className="conversation-state error">{live.error || "Unable to load runtime."}</div>}
      {live.connection === "disconnected" && <div className="conversation-state">Disconnected. Waiting to reconnect…</div>}
      {runtime && <div ref={streamRef} className="message-stream" aria-live="polite">
        {conversationBlocks.length === 0 && live.connection === "connected" && <div className="conversation-state">No messages yet. Start the conversation below.</div>}
        {conversationBlocks.map((block) => "tools" in block
          ? <ToolTurnGroup key={block.id} tools={block.tools} />
          : block.role === "tool"
            ? <ToolDisclosure key={block.id} name={block.tool?.name || "Tool"} status={block.tool?.status || "completed"} input={block.tool?.input} output={block.text} />
            : block.role === "system"
              ? <SystemDisclosure key={block.id} message={block} />
              : <article className={`conversation-message role-${block.role}`} key={block.id}>
                <small>{block.role}{block.streaming ? " · streaming" : ""}</small>
                {block.text && <p>{block.text}</p>}
                {Boolean(block.attachmentCount) && <span className="message-attachments"><IconPhoto size={14} />{block.attachmentCount} {block.attachmentCount === 1 ? "image" : "images"}</span>}
              </article>)}
        {runtime.conversation.tools.filter((tool) => tool.status === "running").map((tool) => <ToolDisclosure key={tool.id} name={tool.name || "Tool"} status={tool.status} input={tool.input} output={tool.summary} />)}
      </div>}
      {live.error && live.connection === "connected" && <p className="conversation-note">{live.error}</p>}
      {runtime?.conversation.retry.active && <p className="conversation-note">Retrying{runtime.conversation.retry.attempt ? ` (${runtime.conversation.retry.attempt})` : ""}…</p>}
      {runtime?.conversation.compaction.active && <p className="conversation-note">Compacting context…</p>}
      {runtime && <ExtensionUiSurface runtime={runtime} placement="aboveEditor" />}
      <form className="prompt-form" onSubmit={submit}>
        {images.length > 0 && <div className="prompt-images" aria-label="Attached images">
          {images.map((image, index) => <div className="prompt-image" key={image.id}>
            <img src={`data:${image.mimeType};base64,${image.data}`} alt={`Pasted image ${index + 1}`} />
            <button type="button" onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))} aria-label={`Remove pasted image ${index + 1}`}><IconX size={13} /></button>
          </div>)}
        </div>}
        <label className="sr-only" htmlFor="runtime-prompt">Message</label>
        <textarea id="runtime-prompt" rows={1} value={message} onChange={(event) => setMessage(event.target.value)} onPaste={(event) => void onPaste(event)} onKeyDown={onPromptKeyDown} placeholder={connected ? (streaming ? "Send follow-up" : "Send a prompt") : "Runtime must be connected"} disabled={!connected || submitting} />
        {imageError && <p className="prompt-error" role="alert">{imageError}</p>}
        <div className="prompt-toolbar">
          <div className="prompt-controls">
            <label>
              <span className="sr-only">Model</span>
              <select
                aria-label="Model"
                value={controls?.model ? `${controls.model.provider}/${controls.model.id}` : ""}
                onChange={(event) => void setModel(event.target.value)}
                disabled={controlsDisabled || !controls?.models.length}
              >
                {!controls?.model && <option value="">No model</option>}
                {controls?.models.map((model) => <option value={`${model.provider}/${model.id}`} key={`${model.provider}/${model.id}`}>{model.name} · {model.provider}</option>)}
              </select>
            </label>
            <label>
              <span className="sr-only">Thinking level</span>
              <select
                aria-label="Thinking level"
                value={controls?.thinkingLevel ?? ""}
                onChange={(event) => void setThinking(event.target.value as NonNullable<typeof controls>["thinkingLevels"][number])}
                disabled={controlsDisabled || !controls?.thinkingLevels.length}
              >
                {!controls?.thinkingLevels.length && <option value="">Thinking unavailable</option>}
                {controls?.thinkingLevels.map((level) => <option value={level} key={level}>{thinkingLabel(level)}</option>)}
              </select>
            </label>
          </div>
          <div className="prompt-actions">
            {streaming && <button className="prompt-abort" type="button" onClick={() => void runtimeStore.abort().catch(() => undefined)} disabled={!connected} aria-label="Stop response"><IconX size={15} /></button>}
            <button className="prompt-send" disabled={!connected || submitting || (!message.trim() && images.length === 0) || !controls?.model} type="submit" aria-label={streaming ? "Send follow-up" : "Send message"}><IconArrowUp size={16} /></button>
          </div>
        </div>
      </form>
      {runtime && <ExtensionUiSurface runtime={runtime} placement="belowEditor" />}
    </section>
  );
}

function ToolTurnGroup({ tools }: { tools: MessageReadModel[] }) {
  const names = [...new Set(tools.map((tool) => tool.tool?.name || "Tool"))];
  return <details className="tool-turn-group">
    <summary><IconTool size={15} /><strong>{tools.length} tool {tools.length === 1 ? "call" : "calls"}</strong><span>{names.slice(0, 3).join(", ")}{names.length > 3 ? "…" : ""}</span></summary>
    <div className="tool-turn-items">
      {tools.map((tool) => <ToolDisclosure key={tool.id} name={tool.tool?.name || "Tool"} status={tool.tool?.status || "completed"} input={tool.tool?.input} output={tool.text} />)}
    </div>
  </details>;
}

function SystemDisclosure({ message }: { message: MessageReadModel }) {
  return <details className="system-disclosure">
    <summary><strong>System context</strong>{message.systemSource && <span>{message.systemSource}</span>}</summary>
    <p>{message.text}</p>
  </details>;
}

function imageBytes(images: PromptImage[]): number {
  return images.reduce((total, image) => total + Math.floor(image.data.length * 3 / 4), 0);
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

function ToolDisclosure({ name, status, input, output }: { name: string; status: "running" | "completed" | "failed"; input?: string; output?: string }) {
  const inputPreview = input?.replace(/\s+/g, " ").trim();

  return <details className={`tool-disclosure is-${status}`}>
    <summary>
      <IconTool size={15} />
      <span className="tool-summary-copy">
        <strong>{name}</strong>
        {inputPreview && <code>{inputPreview}</code>}
      </span>
      <span className="tool-status">{status}</span>
    </summary>
    <div className="tool-details">
      <section><small>Input</small><pre>{input || "No input"}</pre></section>
      <section><small>Output</small><pre>{output || (status === "running" ? "Waiting for output…" : "No output")}</pre></section>
    </div>
  </details>;
}

function ExtensionUiSurface({ runtime, placement }: { runtime: NonNullable<RuntimeStoreSnapshot["runtime"]>; placement: "aboveEditor" | "belowEditor" }) {
  const widgets = runtime.extensionUi.widgets.filter((widget) => (widget.placement ?? "aboveEditor") === placement);
  if (placement === "belowEditor" && runtime.extensionUi.notifications.length === 0 && runtime.extensionUi.statuses.length === 0 && widgets.length === 0) return null;
  if (placement === "aboveEditor" && widgets.length === 0) return null;
  return <div className={`extension-ui extension-ui-${placement}`}>
    {widgets.map((widget) => <section className="extension-widget" key={widget.key} aria-label={widget.key}>{widget.lines.map((line, index) => <p key={index}>{line}</p>)}</section>)}
    {placement === "belowEditor" && runtime.extensionUi.statuses.length > 0 && <dl className="extension-statuses">{runtime.extensionUi.statuses.map((status) => <div key={status.key}><dt>{status.key}</dt><dd>{status.text}</dd></div>)}</dl>}
    {placement === "belowEditor" && <div className="extension-notifications" aria-live="polite" aria-atomic="true">{runtime.extensionUi.notifications.slice(-3).map((item) => <p className={`tone-${item.type}`} key={item.id}>{item.message}</p>)}</div>}
  </div>;
}

function UiDialog({ request }: { request: NonNullable<RuntimeStoreSnapshot["pendingUi"]> }) {
  const payload = request.payload;
  const [value, setValue] = useState(() => typeof payload.prefill === "string" ? payload.prefill : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remaining, setRemaining] = useState(() => request.expiresAt ? Math.max(0, Date.parse(request.expiresAt) - Date.now()) : undefined);
  const dialogRef = useRef<HTMLDivElement>(null);
  const actionLock = useRef(false);
  const title = typeof payload.title === "string" ? payload.title : "Input requested";
  const description = typeof payload.message === "string" ? payload.message : typeof payload.label === "string" ? payload.label : "The runtime needs a response.";
  const titleId = `ui-title-${request.requestId}`;
  const descriptionId = `ui-description-${request.requestId}`;
  const expired = remaining !== undefined && remaining <= 0;
  const options = Array.isArray(payload.options) ? payload.options : [];

  useEffect(() => {
    if (!request.expiresAt) return;
    const update = () => setRemaining(Math.max(0, Date.parse(request.expiresAt!) - Date.now()));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [request.expiresAt]);

  useEffect(() => {
    if (!request.owned) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus], button:not([disabled])")?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [request.owned]);

  const respond = async (body: Record<string, unknown>) => {
    if (actionLock.current || expired) return;
    actionLock.current = true; setBusy(true); setError("");
    try { await runtimeStore.answerUi(request, body); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Response was rejected"); }
    finally { actionLock.current = false; setBusy(false); }
  };
  const ownership = async (action: "claim" | "release") => {
    if (actionLock.current || expired) return;
    actionLock.current = true; setBusy(true); setError("");
    try { await runtimeStore.changeUiOwnership(request, action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Ownership change was rejected"); }
    finally { actionLock.current = false; setBusy(false); }
  };
  const submit = () => request.method === "confirm" ? respond({ confirmed: true }) : respond({ value });
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!busy && !expired) void respond({ cancelled: true }); return; }
    if (event.key === "Enter" && request.method === "input" && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); if (!busy && !expired) void submit(); return; }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])');
    if (!focusable?.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  if (!request.owned) return <div className="ui-request ui-request-observer" role="status" aria-live="polite">
    <strong>{title}</strong>
    <p>{request.ownershipAvailable ? "Response ownership is available." : "A response is pending in another tab."}</p>
    {request.ownershipAvailable ? <button className="secondary-button" type="button" disabled={busy || expired} onClick={() => void ownership("claim")}>Respond in this tab</button> : <button className="secondary-button" type="button" disabled>Awaiting owner response</button>}
    {error && <p className="ui-request-error" role="alert">{error}</p>}
  </div>;

  return <div className="ui-request-backdrop">
    <div ref={dialogRef} className="ui-request" role={request.method === "confirm" ? "alertdialog" : "dialog"} aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={onKeyDown}>
      <strong id={titleId}>{title}</strong><p id={descriptionId}>{description}</p>
      {request.method === "select" && <select data-autofocus value={value} onChange={(event) => setValue(event.target.value)} disabled={busy || expired}><option value="">Select an option</option>{options.map((option, index) => { const item = typeof option === "object" && option ? option as Record<string, unknown> : {}; const optionValue = typeof option === "string" ? option : typeof item.value === "string" ? item.value : String(index); const label = typeof option === "string" ? option : typeof item.label === "string" ? item.label : optionValue; return <option key={optionValue} value={optionValue}>{label}</option>; })}</select>}
      {(request.method === "input" || request.method === "editor") && (request.method === "editor" ? <textarea data-autofocus value={value} onChange={(event) => setValue(event.target.value)} disabled={busy || expired} /> : <input data-autofocus value={value} placeholder={typeof payload.placeholder === "string" ? payload.placeholder : undefined} onChange={(event) => setValue(event.target.value)} disabled={busy || expired} />)}
      {remaining !== undefined && <p className="ui-request-expiry" aria-live="polite">{expired ? "Request expired. Waiting for runtime closure." : `Expires in ${Math.ceil(remaining / 1_000)} seconds.`}</p>}
      {error && <p className="ui-request-error" role="alert">{error}</p>}
      <div className="ui-request-actions">
        {request.method === "confirm" ? <button data-autofocus className="primary-button" type="button" disabled={busy || expired} onClick={() => void submit()}>Confirm</button> : <button className="primary-button" type="button" disabled={busy || expired || (request.method === "select" && !value)} onClick={() => void submit()}>Submit</button>}
        <button className="secondary-button" type="button" disabled={busy || expired} onClick={() => void respond({ cancelled: true })}>Cancel</button>
        <button className="text-button ui-transfer" type="button" disabled={busy || expired} onClick={() => void ownership("release")}>Let another tab respond</button>
      </div>
    </div>
  </div>;
}

function Timeline({ live }: { live: RuntimeStoreSnapshot }) {
  const timeline = live.runtime?.operational.timeline;
  const checkpoints = timeline?.checkpoints ?? [];
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const active = checkpoints.find((checkpoint) => checkpoint.id === selected) ?? checkpoints[0];
  const enabled = live.connection === "connected" && live.runtime?.ready === true && !busy;
  const act = async (action: "restore" | "fork" | "clear", checkpointId?: string) => {
    if (!enabled) return;
    setBusy(action); setError("");
    try { await runtimeStore.timeline(action, checkpointId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Timeline action failed"); }
    finally { setBusy(""); }
  };
  return timeline?.availability === "unavailable" ? <FeatureUnavailable name="Timeline" /> : (
    <div className="timeline-layout">
      <section className="timeline-list" aria-label="Checkpoints">
        <div className="timeline-toolbar"><span>{checkpoints.length} checkpoints</span><button className="text-button danger" type="button" disabled={!enabled || checkpoints.length === 0} onClick={() => void act("clear")}><IconTrash size={13} />{busy === "clear" ? "Clearing…" : "Clear timeline"}</button></div>
        {checkpoints.map((checkpoint, index) => (
          <button className={`checkpoint-row ${active?.id === checkpoint.id ? "is-selected" : ""}`} key={checkpoint.id} onClick={() => setSelected(checkpoint.id)}>
            <span className="timeline-node"><span />{index < checkpoints.length - 1 && <i />}</span>
            <span className="checkpoint-copy">
              <span><strong>{checkpoint.title}</strong><time>{displayTime(checkpoint.createdAt)}</time></span>
              <span className="checkpoint-meta"><span className="mono">{checkpoint.id}</span>{checkpoint.branch && <span><IconGitBranch size={12} />{checkpoint.branch}</span>}{checkpoint.verified && <span className="verified"><IconCheck size={12} />Verified</span>}</span>
            </span>
          </button>
        ))}
        {checkpoints.length === 0 && <div className="empty-state"><IconTimeline size={20} /><strong>No checkpoints</strong><span>Timeline has not captured this run.</span></div>}
      </section>
      {active && <aside className="panel checkpoint-detail">
        <span className="section-kicker">Selected checkpoint</span>
        <h2>{active.title}</h2>
        <dl>
          <div><dt>Checkpoint</dt><dd className="mono">{active.id}</dd></div>
          <div><dt>Branch</dt><dd>{active.branch || "Detached or unavailable"}</dd></div>
          <div><dt>Verification</dt><dd>{active.verified ? "Passed" : "Not attached"}</dd></div>
        </dl>
        <button className="primary-button" type="button" disabled={!enabled} onClick={() => void act("fork", active.id)}>{busy === "fork" ? "Forking…" : "Fork & continue"}</button>
        <button className="secondary-button full" type="button" disabled={!enabled} onClick={() => void act("restore", active.id)}>{busy === "restore" ? "Restoring…" : "Restore checkpoint"}</button>
        <div className="runtime-note"><IconShieldCheck size={15} /><span>Timeline confirms every restore, fork, and clear through its remote safety dialog.</span></div>
        {error && <p className="ui-request-error" role="alert">{error}</p>}
      </aside>}
    </div>
  );
}

function Tools({ live, pylonPolicies }: { live: RuntimeStoreSnapshot; pylonPolicies: boolean }) {
  const [query, setQuery] = useState("");
  const runtime = live.runtime;
  const policies = runtime?.operational.tools.policies ?? [];
  const tools = runtime?.availableTools ?? [];
  const visibleTools = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const items = tools.map((name) => ({ name, active: runtime?.activeTools.includes(name) === true }));
    return normalized ? items.filter((item) => item.name.toLowerCase().includes(normalized)) : items;
  }, [query, runtime?.activeTools, tools]);
  const metrics = runtime?.metrics;

  return (
    <div className="tools-page">
      <section className="usage-strip">
        <div><small>Input</small><strong>{metrics?.inputTokens.toLocaleString() ?? "—"}</strong><span>tokens</span></div>
        <div><small>Output</small><strong>{metrics?.outputTokens.toLocaleString() ?? "—"}</strong><span>tokens</span></div>
        <div><small>Cache reads</small><strong>{metrics?.cacheReadTokens.toLocaleString() ?? "—"}</strong><span>tokens</span></div>
        <div><small>Tool calls</small><strong>{metrics?.toolCalls ?? "—"}</strong><span>session total</span></div>
      </section>
      <section className="panel tool-table-panel">
        <div className="table-toolbar">
          <div><h2>Available tools</h2><p>Effective state for this session.</p></div>
          <label className="table-search"><IconSearch size={15} /><span className="sr-only">Filter tools</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter tools" /></label>
        </div>
        <div className="generic-tool-list">
          {visibleTools.map((tool) => <div className="generic-tool-row" key={tool.name}>
            <span className="tool-glyph"><IconTool size={15} /></span>
            <strong>{tool.name}</strong>
            <Status tone={tool.active ? "success" : "neutral"}>{tool.active ? "active" : "available"}</Status>
          </div>)}
          {visibleTools.length === 0 && <div className="empty-state"><IconSearch size={20} /><strong>{tools.length ? "No matching tools" : "No tools available"}</strong><span>{tools.length ? "Try another tool name." : "Enable a package or configure Pi tools for this workspace."}</span></div>}
        </div>
      </section>
      {pylonPolicies && <section className="panel tool-table-panel">
        <div className="table-toolbar"><div><h2>Package policies</h2><p>Pylon coordination state.</p></div></div>
        {runtime?.operational.tools.availability === "unavailable" ? <FeatureUnavailable name="Tool policy" /> : <div className="tool-table" role="table" aria-label="Pylon package policies">
          <div className="tool-table-head" role="row"><span role="columnheader">Package</span><span role="columnheader">Managed tools</span><span role="columnheader">State</span><span role="columnheader">Count</span></div>
          {policies.map((policy) => {
            const deferred = policy.deferredTools.length > 0;
            return <div className="tool-table-row" role="row" key={policy.owner}>
              <span className="tool-name" role="cell"><span className="tool-glyph"><IconTool size={15} /></span><span><strong>{policy.owner.replace(/^pi-/, "")}</strong><small>{policy.owner}</small></span></span>
              <span className="tool-purpose" role="cell">{policy.managedTools.join(", ")}</span>
              <span role="cell"><Status tone={policy.allowOnly ? "warning" : deferred ? "neutral" : "success"}>{policy.allowOnly ? "guarded" : deferred ? "deferred" : "active"}</Status></span>
              <span className="mono tool-calls" role="cell">{policy.enabledTools.length}</span>
            </div>;
          })}
          {policies.length === 0 && <div className="empty-state"><IconTool size={20} /><strong>No package policies</strong><span>No policy owners registered for this session.</span></div>}
        </div>}
      </section>}
    </div>
  );
}

function Settings({ live, packages, loading, error, busy, onSetEnabled }: {
  live: RuntimeStoreSnapshot;
  packages: PackageSummary[];
  loading: boolean;
  error: string;
  busy: string;
  onSetEnabled: (item: PackageSummary, enabled: boolean) => void;
}) {
  const runningJob = live.runtime?.operational.jobs.items.some((job) => job.state === "running") === true;
  const idle = live.connection === "connected"
    && live.runtime?.ready === true
    && live.runtime.conversation.streaming === false
    && !live.pendingUi
    && !runningJob
    && !busy;
  return <div className="settings-page">
    <section className="panel package-settings">
      <PanelHeader title="Local Pi packages" meta={`${packages.filter((item) => item.active).length} active`} />
      <p className="settings-note">Packages are detected from this installation's <span className="mono">packages/</span> directory. Changes apply globally and reload the current session.</p>
      {loading && <div className="conversation-state">Detecting packages...</div>}
      {!loading && packages.map((item) => {
        const state = item.error ? "failed" : item.active ? "active" : item.enabled ? "unavailable" : "disabled";
        return <label className="package-row" key={item.id}>
          <span className="package-copy">
            <strong>{item.name}</strong>
            <small>{item.description || `${item.extensionCount} Pi extension${item.extensionCount === 1 ? "" : "s"}`}</small>
            {item.error && <span className="package-error">{item.error}</span>}
          </span>
          <span className={`package-state is-${state}`}>{state}</span>
          <input
            type="checkbox"
            role="switch"
            checked={item.enabled}
            disabled={!idle}
            onChange={(event) => onSetEnabled(item, event.target.checked)}
            aria-label={`${item.enabled ? "Disable" : "Enable"} ${item.name}`}
          />
        </label>;
      })}
      {!loading && packages.length === 0 && <div className="empty-state"><IconStack2 size={20} /><strong>No local Pi packages</strong><span>The web runtime remains available with Pi's standard workspace configuration.</span></div>}
      {!idle && !loading && <p className="settings-note" role="status">Package changes are available when the session and background work are idle.</p>}
      {error && <p className="ui-request-error" role="alert">{error}</p>}
    </section>
  </div>;
}

function TodoList({ work }: { work: NonNullable<NonNullable<RuntimeStoreSnapshot["runtime"]>["operational"]["continuity"]["work"]> }) {
  return <ol className="todo-list">
    {work.todos.map((todo) => {
      const active = todo.status === "in_progress";
      return <li className={`todo-item is-${active ? "active" : todo.status}`} key={todo.id}>
        <span className="todo-state" aria-label={todo.status}>{todo.status === "done" ? <IconCheck size={13} /> : active ? <span /> : <IconCircle size={10} />}</span>
        <span className="todo-label">{todo.text}</span>
        <small>{active ? "In progress" : todo.status}</small>
      </li>;
    })}
  </ol>;
}

function FeatureUnavailable({ name }: { name: string }) {
  return <div className="empty-state" role="status"><IconX size={20} /><strong>{name} unavailable</strong><span>Installed package version does not expose compatible state.</span></div>;
}

function displayTime(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? "Unknown" : new Date(time).toLocaleString();
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(1)}s`;
}

function thinkingLabel(level: string): string {
  if (level === "xhigh") return "Extra high";
  return level[0]!.toUpperCase() + level.slice(1);
}

function Metric({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: IconComponent }) {
  return <div className="metric"><span className="metric-icon"><Icon size={16} /></span><div><small>{label}</small><strong>{value}</strong><span>{detail}</span></div></div>;
}

function PanelHeader({ title, meta, action, onAction }: { title: string; meta?: string; action?: string; onAction?: () => void }) {
  return <header className="panel-header"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action && onAction && <button className="text-button" type="button" onClick={onAction}>{action}<IconChevronRight size={14} /></button>}</header>;
}

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status status-${tone}`}><span aria-hidden="true" />{children}</span>;
}
