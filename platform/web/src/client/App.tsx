import {
  IconBrandGit,
  IconGitBranch,
  IconLayoutDashboard,
  IconFiles,
  IconMenu2,
  IconMoon,
  IconSun,
  IconUsers,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { PackageSettingsReadModel, PackageSummary, SessionListSnapshot, SessionProjectPage, SessionSummary } from "../shared/protocol/snapshots";
import { AgentPanel } from "./agent-drawer";
import { ArchiveDialog } from "./archive-dialog";
import { ConversationPanel } from "./conversation-panel";
import { FilesPanel } from "./files-panel";
import { Inspector, type ViewId } from "./inspector";
import { runtimeStore, useRuntimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";
import { SessionSidebar, sessionTitle, type SessionProject } from "./session-sidebar";
import { SettingsDialog } from "./settings-dialog";
import { UiDialog } from "./ui-dialog";

type Theme = "light" | "dark";
type RightPanel = "inspector" | "agents" | "files" | null;
const LEFT_PANEL_WIDTH_KEY = "pylon-left-panel-width";
const DEFAULT_LEFT_PANEL_WIDTH = 280;
const RIGHT_PANEL_WIDTH_KEY = "pylon-right-panel-width";
const DEFAULT_RIGHT_PANEL_WIDTH = 380;

function leftPanelWidth(value: number): number {
  const maximum = Math.min(520, window.innerWidth * .45);
  return Math.round(Math.max(220, Math.min(maximum, value)));
}
function initialLeftPanelWidth(): number {
  let stored = Number.NaN;
  try { stored = Number(localStorage.getItem(LEFT_PANEL_WIDTH_KEY)); }
  catch { /* Storage can be unavailable in hardened browser contexts. */ }
  return leftPanelWidth(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_LEFT_PANEL_WIDTH);
}
function panelWidth(value: number): number {
  const maximum = Math.min(720, window.innerWidth * .6);
  return Math.round(Math.max(300, Math.min(maximum, value)));
}
function initialPanelWidth(): number {
  let stored = Number.NaN;
  try { stored = Number(localStorage.getItem(RIGHT_PANEL_WIDTH_KEY)); }
  catch { /* Storage can be unavailable in hardened browser contexts. */ }
  return panelWidth(Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_RIGHT_PANEL_WIDTH);
}

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
  const [leftPanelWidth, setLeftPanelWidth] = useState(initialLeftPanelWidth);
  const [rightPanel, setRightPanel] = useState<RightPanel>("inspector");
  const [rightPanelWidth, setRightPanelWidth] = useState(initialPanelWidth);
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [requestedFile, setRequestedFile] = useState<string>();
  const [sessionPages, setSessionPages] = useState<SessionProjectPage[]>([]);
  const [activeSessions, setActiveSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<{ id: number; message: string }>();
  const [sessionBusy, setSessionBusy] = useState("");
  const [sessionDeleting, setSessionDeleting] = useState("");
  const [projectLoading, setProjectLoading] = useState("");
  const [projectBusy, setProjectBusy] = useState("");
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [packagesLoading, setPackagesLoading] = useState(true);
  const [packageBusy, setPackageBusy] = useState("");
  const [query, setQuery] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const agentsToggleRef = useRef<HTMLButtonElement>(null);
  const filesToggleRef = useRef<HTMLButtonElement>(null);
  const appShellRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previousSidebarOpen = useRef(sidebarOpen);
  const previousRightPanel = useRef(rightPanel);
  const sessionListRequest = useRef(0);
  const toastId = useRef(0);
  const lastError = useRef({ message: "", at: 0 });
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
  const activeSession = activeSessions.find((session) => session.active) ?? sessions.find((session) => session.active);
  const activePackages = useMemo(() => new Set(packages.filter((item) => item.active).map((item) => item.id)), [packages]);
  const timelineEnabled = activePackages.has("pi-timeline")
    || live.runtime?.operational.timeline.availability === "available";
  const memoryEnabled = activePackages.has("pi-continuity")
    || live.runtime?.operational.continuity.availability === "available";
  const availableViews = useMemo(() => new Set<ViewId>([
    "overview",
    ...(timelineEnabled ? ["timeline" as const] : []),
    ...(memoryEnabled ? ["memory" as const] : []),
    "tools",
  ]), [memoryEnabled, timelineEnabled]);
  const applySessionList = (result: SessionListSnapshot) => {
    setSessionPages(result.projects);
    setActiveSessions(result.activeSessions);
    const projectId = result.projects.find((page) => page.sessions.some((session) => session.active))?.id;
    if (projectId) setExpandedProjects((current) => new Set([...current, projectId]));
  };
  const reportError = (cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message : fallback;
    const now = Date.now();
    if (lastError.current.message === message && now - lastError.current.at < 100) return;
    lastError.current = { message, at: now };
    setToast({ id: ++toastId.current, message });
  };

  useEffect(() => { runtimeStore.start(); }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("pylon-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#111318" : "#e9eaec");
  }, [theme]);

  useEffect(() => { document.title = live.runtime?.extensionUi.title || "Pylon"; }, [live.runtime?.extensionUi.title]);
  useEffect(() => { setSelectedAgentId(undefined); }, [live.runtime?.sessionId]);

  useEffect(() => {
    if (mobile && previousSidebarOpen.current && !sidebarOpen) navigationToggleRef.current?.focus();
    previousSidebarOpen.current = sidebarOpen;
  }, [mobile, sidebarOpen]);

  useEffect(() => {
    if (!previousRightPanel.current || rightPanel) {
      previousRightPanel.current = rightPanel;
      return;
    }
    const trigger = previousRightPanel.current === "agents"
      ? agentsToggleRef.current
      : previousRightPanel.current === "files"
        ? filesToggleRef.current
        : inspectorToggleRef.current;
    trigger?.focus();
    previousRightPanel.current = rightPanel;
  }, [rightPanel]);

  useEffect(() => {
    const open = (event: Event) => {
      const path = (event as CustomEvent<unknown>).detail;
      if (typeof path !== "string") return;
      setRequestedFile(path);
      setRightPanel("files");
    };
    window.addEventListener("pylon:open-file", open);
    return () => window.removeEventListener("pylon:open-file", open);
  }, []);

  useEffect(() => {
    if (live.connection !== "connected" || !live.runtime?.ready) return;
    let active = true;
    const request = ++sessionListRequest.current;
    setSessionsLoading(true);
    const timer = window.setTimeout(() => void runtimeStore.listSessions({ query: query.trim() || undefined, limit: 10 }).then((result) => {
      if (!active || request !== sessionListRequest.current) return;
      applySessionList(result);
    }).catch((cause) => {
      const message = cause instanceof Error ? cause.message : "Unable to list sessions";
      if (/session changed while listing sessions|session list is stale/i.test(message)) return;
      if (active && request === sessionListRequest.current) reportError(cause, "Unable to list sessions");
    }).finally(() => {
      if (active && request === sessionListRequest.current) setSessionsLoading(false);
    }), query ? 200 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [live.connection, live.runtime?.ready, live.runtime?.sessionGeneration, live.runtime?.sessionName, live.sessionRevision, query]);

  useEffect(() => {
    if (live.connection === "connected" && live.errorRevision && live.error) {
      reportError(new Error(live.error), "Command failed");
    }
  }, [live.errorRevision]);

  useEffect(() => {
    if (live.connection !== "connected" || !live.runtime?.ready) return;
    let active = true;
    const generation = live.runtime.sessionGeneration;
    setPackagesLoading(true);
    void runtimeStore.listPackages().then((result) => {
      if (active) setPackages(result.packages);
    }).catch((cause) => {
      const message = cause instanceof Error ? cause.message : "Unable to list packages";
      if (/session changed while listing packages|package list is stale/i.test(message)) return;
      if (active && runtimeStore.getSnapshot().runtime?.sessionGeneration === generation) reportError(cause, "Unable to list packages");
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
    setActiveSessions((sessions) => sessions
      .map((session) => ({
        ...session,
        runtimeState: live.sessionStatuses?.[session.id] ?? session.runtimeState,
      }))
      .filter((session) => session.runtimeState !== "sleeping"));
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
        if (inspectorOverlay) setRightPanel(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspectorOverlay, live.pendingUi?.owned, mobile]);

  const selectView = (next: ViewId) => {
    setView(next);
    setRightPanel("inspector");
  };

  const switchSession = async (session: SessionSummary) => {
    if (session.active || sessionBusy || sessionDeleting) {
      if (mobile) setSidebarOpen(false);
      return;
    }
    setSessionBusy(session.id);
    try {
      await runtimeStore.switchSession(session.id);
      if (mobile) setSidebarOpen(false);
    } catch (cause) {
      reportError(cause, "Unable to switch session");
    } finally {
      setSessionBusy("");
    }
  };

  const newSession = async (project: SessionProject) => {
    if (sessionBusy || sessionDeleting || projectBusy) return;
    setSessionBusy(project.id);
    try {
      await runtimeStore.newSession(project.id);
      if (mobile) setSidebarOpen(false);
    } catch (cause) {
      reportError(cause, "Unable to create session");
    } finally {
      setSessionBusy("");
    }
  };

  const deleteSession = async (session: SessionSummary) => {
    if (session.active || sessionBusy || sessionDeleting) return;
    const title = sessionTitle(session);
    if (!window.confirm(`Delete "${title}"?\n\nThis removes its saved history. If system trash is unavailable, deletion is permanent.`)) return;
    setSessionDeleting(session.id);
    sessionListRequest.current++;
    try {
      await runtimeStore.deleteSession(session.id);
      setActiveSessions((current) => current.filter((candidate) => candidate.id !== session.id));
      setSessionPages((current) => current.map((page) => ({
        ...page,
        totalCount: page.id === session.projectId ? Math.max(0, page.totalCount - 1) : page.totalCount,
        sessions: page.sessions.filter((candidate) => candidate.id !== session.id),
      })).filter((page) => page.totalCount > 0));
      const request = ++sessionListRequest.current;
      try {
        const result = await runtimeStore.listSessions({ query: query.trim() || undefined, limit: 10 });
        if (request === sessionListRequest.current) applySessionList(result);
      } catch (cause) {
        reportError(cause instanceof Error ? new Error(`Session deleted, but refresh failed: ${cause.message}`) : cause, "Session deleted, but refresh failed");
      }
    } catch (cause) {
      reportError(cause, "Unable to delete session");
    } finally {
      setSessionDeleting("");
    }
  };

  const addProject = async () => {
    if (projectBusy || sessionBusy || sessionDeleting) return;
    setProjectBusy("add");
    try {
      await runtimeStore.addProject();
    } catch (cause) {
      reportError(cause, "Unable to add project");
    } finally {
      setProjectBusy("");
    }
  };

  const removeProject = async (project: SessionProject) => {
    if (projectBusy || sessionBusy || sessionDeleting) return;
    const page = sessionPages.find((candidate) => candidate.id === project.id);
    const count = page?.totalCount ?? project.sessions.length;
    if (!window.confirm(`Remove "${project.label}" and delete ${count} saved session${count === 1 ? "" : "s"}?\n\nProject files and Continuity memory are not deleted.`)) return;
    setProjectBusy(project.id);
    try {
      await runtimeStore.removeProject(project.id);
    } catch (cause) {
      reportError(cause, "Unable to remove project");
    } finally {
      setProjectBusy("");
    }
  };

  const updateWorktreeSetup = async (project: SessionProject) => {
    const setupCommand = window.prompt(
      `Worktree setup for ${project.label}\n\nRuns once after a new isolated worktree is created. Leave blank to disable.`,
      "",
    );
    if (setupCommand === null) return;
    setProjectBusy(project.id);
    try {
      await runtimeStore.updateProjectWorktreeSettings(project.id, setupCommand);
    } catch (cause) {
      reportError(cause, "Unable to save worktree setup");
    } finally {
      setProjectBusy("");
    }
  };

  const renameSession = async (session: SessionSummary) => {
    if (sessionBusy || sessionDeleting) return;
    const name = window.prompt("Rename session", sessionTitle(session))?.trim();
    if (!name || name === session.name) return;
    setSessionBusy(session.id);
    try {
      await runtimeStore.renameSession(session.id, name);
      const rename = (candidate: SessionSummary) => candidate.id === session.id ? { ...candidate, name } : candidate;
      setActiveSessions((current) => current.map(rename));
      setSessionPages((current) => current.map((page) => ({ ...page, sessions: page.sessions.map(rename) })));
    } catch (cause) {
      reportError(cause, "Unable to rename session");
    } finally {
      setSessionBusy("");
    }
  };

  const setSessionActive = async (session: SessionSummary, active: boolean) => {
    if (sessionBusy || sessionDeleting || (!active && session.active)) return;
    setSessionBusy(session.id);
    try {
      await runtimeStore.setSessionActive(session.id, active);
      applySessionList(await runtimeStore.listSessions({ query: query.trim() || undefined, limit: 10 }));
    } catch (cause) {
      reportError(cause, `Unable to ${active ? "activate" : "deactivate"} session`);
    } finally {
      setSessionBusy("");
    }
  };

  const loadMoreSessions = async (project: SessionProject) => {
    const current = sessionPages.find((page) => page.id === project.id);
    if (!current?.nextCursor || projectLoading) return;
    setProjectLoading(project.id);
    try {
      const result = await runtimeStore.listSessions({
        projectId: project.id,
        cursor: current.nextCursor,
        query: query.trim() || undefined,
        limit: 10,
      });
      setActiveSessions(result.activeSessions);
      const next = result.projects[0];
      if (!next) return;
      setSessionPages((pages) => pages.map((page) => page.id === project.id ? {
        ...page,
        sessions: [...page.sessions, ...next.sessions.filter((session) => !page.sessions.some((old) => old.id === session.id))],
        nextCursor: next.nextCursor,
      } : page));
    } catch (cause) {
      reportError(cause, "Unable to load more sessions");
    } finally {
      setProjectLoading("");
    }
  };

  const archiveProject = async (project: SessionProject) => {
    if (projectBusy || sessionBusy || sessionDeleting) return;
    setProjectBusy(project.id);
    try {
      await runtimeStore.archiveProject(project.id);
    } catch (cause) {
      reportError(cause, "Unable to archive project");
    } finally {
      setProjectBusy("");
    }
  };

  const archiveSession = async (session: SessionSummary) => {
    if (projectBusy || sessionBusy || sessionDeleting) return;
    setSessionBusy(session.id);
    try {
      await runtimeStore.archiveSession(session.id);
    } catch (cause) {
      reportError(cause, "Unable to archive session");
    } finally {
      setSessionBusy("");
    }
  };

  const toggleSidebar = () => {
    if (mobile) {
      setRightPanel(null);
      setSidebarOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((collapsed) => !collapsed);
  };

  const toggleRightPanel = (panel: Exclude<RightPanel, null>) => {
    if (inspectorOverlay) setSidebarOpen(false);
    setRightPanel((current) => current === panel ? null : panel);
  };

  const setPackageEnabled = async (item: PackageSummary, enabled: boolean) => {
    if (packageBusy) return;
    setPackageBusy(item.id);
    try {
      await runtimeStore.setPackageEnabled(item.id, enabled);
    } catch (cause) {
      reportError(cause, "Unable to update package");
    } finally {
      setPackageBusy("");
    }
  };

  const updatePackageSettings = async (item: PackageSummary, settings: PackageSettingsReadModel) => {
    if (packageBusy) return;
    setPackageBusy(item.id);
    try {
      await runtimeStore.updatePackageSettings(item.id, settings);
    } catch (cause) {
      reportError(cause, `Unable to update ${item.name}`);
    } finally {
      setPackageBusy("");
    }
  };

  return (
    <div
      ref={appShellRef}
      className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}
      style={{ "--sidebar-width": `${leftPanelWidth}px` } as CSSProperties}
    >
      <a className="skip-link" href="#main-content">Skip to content</a>
      <SessionSidebar
        activeSessions={activeSessions}
        projects={projects}
        pages={sessionPages}
        query={query}
        searchRef={searchRef}
        expandedProjects={expandedProjects}
        loading={sessionsLoading}
        busy={sessionBusy}
        deleting={sessionDeleting}
        projectLoading={projectLoading}
        projectBusy={projectBusy}
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
        onRenameSession={(session) => void renameSession(session)}
        onSetSessionActive={(session, active) => void setSessionActive(session, active)}
        onLoadMore={(project) => void loadMoreSessions(project)}
        onAddProject={() => void addProject()}
        onOpenArchives={() => {
          setArchivesOpen(true);
          if (mobile) setSidebarOpen(false);
        }}
        onOpenSettings={() => {
          setSettingsOpen(true);
          if (mobile) setSidebarOpen(false);
        }}
        onArchiveProject={(project) => void archiveProject(project)}
        onRemoveProject={(project) => void removeProject(project)}
        onArchiveSession={(session) => void archiveSession(session)}
        onNewSession={(project) => {
          const unfiltered = projects.find((candidate) => candidate.id === project.id);
          if (unfiltered) void newSession(unfiltered);
        }}
        onWorktreeSetup={(project) => void updateWorktreeSetup(project)}
        onReorderProject={(projectId, beforeProjectId) =>
          runtimeStore.reorderProject(projectId, beforeProjectId).catch((cause) => {
            reportError(cause, "Unable to reorder project");
            throw cause;
          })}
        onReorderActiveSession={(sessionId, beforeSessionId) =>
          runtimeStore.reorderActiveSession(sessionId, beforeSessionId).catch((cause) => {
            reportError(cause, "Unable to reorder active session");
            throw cause;
          })}
      />
      {!mobile && !sidebarCollapsed && <SidebarResizer
        container={appShellRef}
        width={leftPanelWidth}
        onCommit={(width) => {
          setLeftPanelWidth(width);
          try { localStorage.setItem(LEFT_PANEL_WIDTH_KEY, String(width)); }
          catch { /* Resizing still works for the current page. */ }
        }}
      />}
      {mobile && sidebarOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}

      <main className="content-card" id="main-content">
        <Topbar
          live={live}
          session={activeSession}
          theme={theme}
          onToggleTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")}
          menuOpen={mobile ? sidebarOpen : !sidebarCollapsed}
          rightPanel={rightPanel}
          menuButtonRef={navigationToggleRef}
          inspectorButtonRef={inspectorToggleRef}
          agentsButtonRef={agentsToggleRef}
          filesButtonRef={filesToggleRef}
          onToggleMenu={toggleSidebar}
          onToggleInspector={() => toggleRightPanel("inspector")}
          onToggleAgents={() => toggleRightPanel("agents")}
          onToggleFiles={() => toggleRightPanel("files")}
        />
        {(toast || live.connection === "disconnected") && <div className="app-toast-stack">
          {live.connection === "disconnected" && <div className="app-connection-toast" role="status">Disconnected. Waiting to reconnect…</div>}
          {toast && <ErrorToast key={toast.id} message={toast.message} onClose={() => setToast(undefined)} />}
        </div>}
        <div
          ref={workspaceRef}
          className={`workspace-layout ${rightPanel ? "has-inspector" : ""}`}
          style={{ "--inspector-width": `${rightPanelWidth}px` } as CSSProperties}
        >
          <ConversationPanel
            key={`conversation:${live.runtime?.sessionId ?? "loading"}`}
            live={live}
            projectAvailable={live.runtime?.projectAvailable !== false}
            onSelectAgent={(id) => {
              setSelectedAgentId(id);
              setRightPanel("agents");
            }}
          />
          {rightPanel && inspectorOverlay && <button className="inspector-scrim" aria-label={`Close ${rightPanel}`} onClick={() => setRightPanel(null)} />}
          {rightPanel && <PanelResizer
            container={workspaceRef}
            width={rightPanelWidth}
            onCommit={(width) => {
              setRightPanelWidth(width);
              try { localStorage.setItem(RIGHT_PANEL_WIDTH_KEY, String(width)); }
              catch { /* Resizing still works for the current page. */ }
            }}
          />}
          {rightPanel === "inspector" && <Inspector
              current={view}
              live={live}
              availableViews={availableViews}
              timelineEnabled={timelineEnabled}
              isOpen
              overlay={inspectorOverlay}
              onClose={() => setRightPanel(null)}
              onNavigate={selectView}
            />}
          {rightPanel === "agents" && <AgentPanel
            key={`agents:${live.runtime?.sessionId ?? "loading"}`}
            runs={live.runtime?.conversation.delegatedRuns ?? []}
            models={live.runtime?.sessionControls.models ?? []}
            selectedId={selectedAgentId}
            onSelect={setSelectedAgentId}
            onClose={() => setRightPanel(null)}
          />}
          {rightPanel === "files" && <FilesPanel
            key={`files:${live.runtime?.sessionId ?? "loading"}`}
            runtime={live.runtime}
            requestedPath={requestedFile}
            onClose={() => setRightPanel(null)}
            onError={reportError}
          />}
        </div>
        {(sessionBusy || packageBusy) && <div className="session-transition" role="status"><span className="status-orb success" />{packageBusy ? "Reloading packages..." : "Changing session..."}</div>}
      </main>

      {archivesOpen && <ArchiveDialog revision={live.sessionRevision ?? 0} onClose={() => setArchivesOpen(false)} onError={reportError} />}
      {settingsOpen && <SettingsDialog
        packages={packages}
        loading={packagesLoading}
        busy={packageBusy}
        disabled={activeSessions.some((session) => session.runtimeState === "running" || session.runtimeState === "attention")}
        models={live.runtime?.sessionControls.models ?? []}
        sessionThinkingLevels={live.runtime?.sessionControls.thinkingLevels ?? []}
        onClose={() => setSettingsOpen(false)}
        onSetEnabled={(item, enabled) => void setPackageEnabled(item, enabled)}
        onUpdate={(item, settings) => void updatePackageSettings(item, settings)}
      />}
      {live.pendingUi && <UiDialog key={live.pendingUi.requestId} request={live.pendingUi} />}
    </div>
  );
}

function PanelResizer({ container, width, onCommit }: {
  container: React.RefObject<HTMLDivElement | null>;
  width: number;
  onCommit: (width: number) => void;
}) {
  const resize = (clientX: number) => {
    const next = panelWidth(window.innerWidth - clientX);
    container.current?.style.setProperty("--inspector-width", `${next}px`);
    return next;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 680) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    let next = width;
    const move = (moveEvent: PointerEvent) => { next = resize(moveEvent.clientX); };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    const up = () => {
      cleanup();
      onCommit(next);
    };
    const cancel = () => cleanup();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };
  return <div
    className="panel-resizer"
    role="separator"
    aria-label="Resize details panel"
    aria-orientation="vertical"
    aria-valuemin={300}
    aria-valuemax={Math.floor(Math.min(720, window.innerWidth * .6))}
    aria-valuenow={width}
    tabIndex={0}
    onPointerDown={onPointerDown}
    onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = panelWidth(width + (event.key === "ArrowLeft" ? 16 : -16));
      container.current?.style.setProperty("--inspector-width", `${next}px`);
      onCommit(next);
    }}
  />;
}

function SidebarResizer({ container, width, onCommit }: {
  container: React.RefObject<HTMLDivElement | null>;
  width: number;
  onCommit: (width: number) => void;
}) {
  const resize = (clientX: number) => {
    const next = leftPanelWidth(clientX);
    container.current?.style.setProperty("--sidebar-width", `${next}px`);
    return next;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    let next = width;
    const move = (moveEvent: PointerEvent) => { next = resize(moveEvent.clientX); };
    const up = () => {
      cleanup();
      onCommit(next);
    };
    const cancel = () => {
      cleanup();
      container.current?.style.setProperty("--sidebar-width", `${width}px`);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };
  return <div
    className="sidebar-resizer"
    role="separator"
    aria-label="Resize navigation"
    aria-orientation="vertical"
    aria-valuemin={220}
    aria-valuemax={Math.floor(Math.min(520, window.innerWidth * .45))}
    aria-valuenow={width}
    tabIndex={0}
    onPointerDown={onPointerDown}
    onKeyDown={(event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const next = leftPanelWidth(width + (event.key === "ArrowRight" ? 16 : -16));
      container.current?.style.setProperty("--sidebar-width", `${next}px`);
      onCommit(next);
    }}
  />;
}

function ErrorToast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onClose, 8_000);
    return () => window.clearTimeout(timer);
  }, []);
  return <div className="app-error-toast" role="alert">
    <span>{message}</span>
    <button type="button" onClick={onClose} aria-label="Dismiss error"><IconX size={15} /></button>
  </div>;
}

function Topbar({ live, session, theme, menuOpen, rightPanel, menuButtonRef, inspectorButtonRef, agentsButtonRef, filesButtonRef, onToggleTheme, onToggleMenu, onToggleInspector, onToggleAgents, onToggleFiles }: { live: RuntimeStoreSnapshot; session?: SessionSummary; theme: Theme; menuOpen: boolean; rightPanel: RightPanel; menuButtonRef: React.RefObject<HTMLButtonElement | null>; inspectorButtonRef: React.RefObject<HTMLButtonElement | null>; agentsButtonRef: React.RefObject<HTMLButtonElement | null>; filesButtonRef: React.RefObject<HTMLButtonElement | null>; onToggleTheme: () => void; onToggleMenu: () => void; onToggleInspector: () => void; onToggleAgents: () => void; onToggleFiles: () => void }) {
  const sessionName = live.runtime?.sessionName || (session ? sessionTitle(session) : "New session");
  const branch = live.runtime?.gitBranch || "No Git branch";
  const turn = live.runtime?.metrics.userMessages ?? 0;
  const delegatedRuns = live.runtime?.conversation.delegatedRuns ?? [];
  const activeAgents = delegatedRuns.filter((run) => run.status === "running").length;
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button ref={menuButtonRef} className="icon-button navigation-toggle" onClick={onToggleMenu} aria-label="Toggle project navigation" aria-controls="primary-navigation" aria-expanded={menuOpen}><IconMenu2 size={18} /></button>
        <div className="repo-crumb">
          <IconBrandGit size={16} stroke={1.7} />
          <span>{live.runtime?.cwdLabel || "Pylon"} / <strong>{sessionName}</strong></span>
        </div>
        <span className="topbar-divider" />
        <div className="branch-label"><IconGitBranch size={14} /><span>{branch} · Turn {turn}</span></div>
      </div>
      <div className="topbar-actions">
        <button ref={filesButtonRef} className={`agents-trigger ${rightPanel === "files" ? "is-active" : ""}`} type="button" onClick={onToggleFiles} aria-label="Files" aria-controls="files-panel" aria-expanded={rightPanel === "files"}>
          <IconFiles size={16} />
          <span>Files</span>
          {(live.runtime?.workspace?.changedCount ?? 0) > 0 && <small>{live.runtime?.workspace?.changedCount}</small>}
        </button>
        <button ref={agentsButtonRef} className={`agents-trigger ${rightPanel === "agents" ? "is-active" : ""}`} type="button" onClick={onToggleAgents} aria-label={`Agents, ${delegatedRuns.length} runs${activeAgents ? `, ${activeAgents} active` : ""}`} aria-controls="agents-panel" aria-expanded={rightPanel === "agents"}>
          <IconUsers size={16} />
          <span>Agents</span>
          <small>{delegatedRuns.length}</small>
          {activeAgents > 0 && <i aria-hidden="true" />}
        </button>
        <button ref={inspectorButtonRef} className={`agents-trigger ${rightPanel === "inspector" ? "is-active" : ""}`} onClick={onToggleInspector} aria-label="Inspector" aria-controls="session-inspector" aria-expanded={rightPanel === "inspector"}><IconLayoutDashboard size={16} /><span>Inspector</span></button>
        <button className="icon-button" onClick={onToggleTheme} aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}>
          {theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
        </button>
        <span className="avatar-button" aria-label="Current user">FP</span>
      </div>
    </header>
  );
}
