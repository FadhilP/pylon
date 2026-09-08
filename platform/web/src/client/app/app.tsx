import { AnnotationProvider } from "../workspace/annotations";
import {
  IconArchive,
  IconCopy,
  IconDots,
  IconPencil,
  IconPin,
  IconPlus,
  IconPower,
  IconX,
  IconTrash,
} from "@tabler/icons-react";
import {
  Component,
  lazy,
  Suspense,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { FileReference } from "../workspace/file-reference";
import { formatSessionActivity } from "../ui/session-format";
import { DEFAULT_GUARD_RULES } from "../../shared/settings/guard-policy";
import { GENERAL_PROJECT_ID } from "../../shared/sessions/general-session";
import type { MessageAttachmentReadModel, MessageReadModel } from "../../shared/protocol/events";
import type {
  HookSettingsReadModel,
  NativeExtensionReadModel,
  PackageSettingsReadModel,
  PackageSummary,
  SessionListSnapshot,
  SessionProjectPage,
  SessionSummary,
} from "../../shared/protocol/snapshots";
import {
  applySessionLiveFields,
  listSessionsPreservingPages,
  SESSION_LIST_INITIAL_LIMIT,
  SESSION_LIST_MORE_LIMIT,
} from "../sessions/session-list";
import type { ComposerDraft } from "../conversation/composer-drafts";
import { ActionDialog } from "../ui/action-dialog";
import { AgentPanel } from "../sessions/agent-panel";
import { AttachmentPanel } from "../conversation/attachment-panel";
import { agentColor, useAgentColors } from "../sessions/agent-color";
import { copyText } from "../ui/clipboard";
const ArchiveDialog = lazy(() => import("../sessions/archive-dialog").then(module => ({ default: module.ArchiveDialog })));
const ChangelogDialog = lazy(() => import("../settings/changelog-dialog").then(module => ({ default: module.ChangelogDialog })));
import { version } from "../../../../../package.json";
import { ConversationPanel, type ComposerSelection } from "../conversation/conversation-panel";
import { CompactionPanel } from "../conversation/compaction-panel";
const BrowserPanel = lazy(() => import("../browser/browser-panel").then(module => ({ default: module.BrowserPanel })));
const DatabasePanel = lazy(() => import("../database/database-panel").then(module => ({ default: module.DatabasePanel })));
const FilesPanel = lazy(() => import("../workspace/files-panel").then(module => ({ default: module.FilesPanel })));
const FileWorkspace = lazy(() => import("../workspace/file-workspace").then(module => ({ default: module.FileWorkspace })));
import { useGitWorkspace } from "../workspace/git-controller";
import type { GitDetailQuery } from "../../shared/workspace/git";
const GitPanel = lazy(() => import("../workspace/git-workspace").then(module => ({ default: module.GitPanel })));
const ReviewSurface = lazy(() => import("../workspace/git-workspace").then(module => ({ default: module.ReviewSurface })));
const GitDialogs = lazy(() => import("../workspace/git-workspace").then(module => ({ default: module.GitDialogs })));
import type { FileView } from "../workspace/files-panel";
import type { FileWorkspaceContentStore } from "../workspace/file-workspace";
import { SearchPopup } from "../workspace/search-popup";
import { openSearch } from "../workspace/workspace-search";
import { KEY_COMMANDS } from "../../shared/settings/keyboard";
import { shortcutLabel, shortcutsBlocked, useGlobalShortcuts, type ShortcutHandlers } from "../ui/keyboard-shortcuts";
import type { FileWorkspaceState } from "../workspace/file-workspace-state";
import { SessionReference, type ViewId } from "../sessions/session-inspector";
import { ReferencePanel, ReferenceRail, ScopeRail, SurfaceTabs } from "./app-chrome";

/** Reference views that render a session view body inside the shared panel. */
const SESSION_REFERENCES: ViewId[] = ["overview", "policy", "timeline", "memory", "tools", "notes"];
const UsageView = lazy(() => import("../usage/usage-view").then(module => ({ default: module.UsageView })));
import {
  clampPanelWidth,
  beginBrowserSessionSurfaceTransition,
  browserSurfaceAfterSessionStatus,
  displacesConversation,
  initialPanelWidths,
  panelWidthSlot,
  referenceDefinition,
  surfaceDefinition,
  workspaceViewDefinition,
  type ActiveReference,
  type ActiveWorkspaceView,
  type AmbientId,
  type NavContext,
  type ReferenceId,
  type SurfaceId,
  type WorkspaceViewId,
} from "./navigation";
import { startsHeliosBrowser } from "../browser/browser-tool-activity";
import { runtimeStore, useRuntimeStore, type RuntimeStoreSnapshot } from "../runtime/event-store";
import {
  currentSessionProgress,
  SessionProgress,
  SessionSidebar,
  sessionTitle,
  type SessionProject,
} from "../sessions/session-sidebar";
const SettingsDialog = lazy(() => import("../settings/settings-dialog").then(module => ({ default: module.SettingsDialog })));
const TerminalPanel = lazy(() => import("../terminal/terminal-panel").then(module => ({ default: module.TerminalPanel })));
import { TurnDiffPanel } from "../workspace/turn-diff-panel";
import { runtimeRequestStillCurrent, useSessionCatalog } from "../sessions/use-session-catalog";
import { useComposerDrafts } from "../conversation/use-composer-drafts";
import { rememberSetting, readStoredNumber, useDocumentTitle, useSyntaxTheme, useTheme } from "./use-chrome";
import { useSettingsDialog } from "../settings/use-settings-dialog";
import { useMarkSessionSeen, useTerminalDrawer } from "../terminal/use-terminal-drawer";
import { enqueueWebAudioCues, unlockWebAudio } from "../ui/web-audio";
import { exitDelay } from "../ui/motion";

type RequestedFile = FileReference & { requestId: number; sessionId?: string; view?: FileView };
type FileNavigation = "explorer" | "sessions";
type SelectedCompaction = { sessionId: string; message: MessageReadModel };
type SelectedAttachment = {
  sessionId: string;
  attachments: MessageAttachmentReadModel[];
  index: number;
  trigger: HTMLButtonElement;
};
type SelectedTurnDiff = {
  sessionId: string;
  entryId: string;
  files: NonNullable<MessageReadModel["changedFiles"]>;
  trigger: HTMLButtonElement;
};
type PendingSession = {
  requestId: number;
  project: SessionProject;
  previousSessionId?: string;
  expectedGeneration?: number;
  phase: "preparing" | "failed";
  error?: string;
  recoveredDraftSessionId?: string;
};
type SidebarAction = {
  key: string;
  title: string;
  description: string;
  confirmLabel: string;
  busyLabel: string;
  danger?: boolean;
  inputLabel?: string;
  initialValue?: string;
  multiline?: boolean;
  maxLength?: number;
  allowEmpty?: boolean;
  onConfirm: (value: string) => void;
};
const LEFT_PANEL_WIDTH_KEY = "pylon-left-panel-width";
const DEFAULT_LEFT_PANEL_WIDTH = 280;
const TERMINAL_HEIGHT_KEY = "pylon-terminal-height";
const DEFAULT_TERMINAL_HEIGHT = 280;

function currentSessionLiveFields() {
  const current = runtimeStore.getSnapshot();
  return {
    states: current.sessionStatuses,
    workStartedAts: current.sessionWorkStartedAts,
    todoProgress: current.sessionTodoProgress,
  };
}

function leftPanelWidth(value: number): number {
  const maximum = Math.min(520, window.innerWidth * 0.45);
  return Math.round(Math.max(220, Math.min(maximum, value)));
}
function initialLeftPanelWidth(): number {
  return leftPanelWidth(readStoredNumber(LEFT_PANEL_WIDTH_KEY, DEFAULT_LEFT_PANEL_WIDTH));
}
function terminalHeight(value: number): number {
  return Math.round(Math.max(160, Math.min(window.innerHeight * 0.7, value)));
}
function initialTerminalHeight(): number {
  return terminalHeight(readStoredNumber(TERMINAL_HEIGHT_KEY, DEFAULT_TERMINAL_HEIGHT));
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
  const composerDrafts = useComposerDrafts();
  const [workspaceView, setWorkspaceView] = useState<ActiveWorkspaceView>(null);
  const [theme, setTheme, resolvedTheme] = useTheme();
  const [syntaxTheme, setSyntaxTheme] = useSyntaxTheme(resolvedTheme);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(initialLeftPanelWidth);
  const [reference, setReference] = useState<ActiveReference>("overview");
  const [panelWidths, setPanelWidths] = useState(initialPanelWidths);
  const [browserMirrorRequest, setBrowserMirrorRequest] = useState("");
  const [browserActive, setBrowserActive] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [requestedFile, setRequestedFile] = useState<RequestedFile>();
  const [surface, setSurface] = useState<SurfaceId>("chat");
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [fileNavigation, setFileNavigation] = useState<FileNavigation>("explorer");
  const [selectedCompaction, setSelectedCompaction] = useState<SelectedCompaction>();
  const [selectedAttachment, setSelectedAttachment] = useState<SelectedAttachment>();
  const [selectedTurnDiff, setSelectedTurnDiff] = useState<SelectedTurnDiff>();
  const [sessionPages, setSessionPages] = useState<SessionProjectPage[]>([]);
  const [activeSessions, setActiveSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const { settings, settingsOpen, openSettings: showSettings, closeSettings } = useSettingsDialog();
  const [toast, setToast] = useState<{ id: number; message: string }>();
  const [sidebarAction, setSidebarAction] = useState<SidebarAction>();
  const [sessionBusy, setSessionBusy] = useState("");
  const [sessionTransition, setSessionTransition] = useState(false);
  const [pendingSession, setPendingSession] = useState<PendingSession>();
  const [composerFocusTarget, setComposerFocusTarget] = useState<string>();
  const [sessionDeleting, setSessionDeleting] = useState("");
  const [projectLoading, setProjectLoading] = useState("");
  const [projectBusy, setProjectBusy] = useState("");
  const [modelRefreshBusy, setModelRefreshBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);
  const panelToggles = useRef(new Map<ReferenceId, HTMLButtonElement>());
  const appShellRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previousSidebarOpen = useRef(sidebarOpen);
  const previousReference = useRef(reference);
  /** What was docked before a surface displaced the conversation into the rail. */
  const displacedReference = useRef<ActiveReference>(reference);
  const browserToolSession = useRef<string | undefined>(undefined);
  const browserSurfaceSessions = useRef(new Set<string>());
  const browserSurfaceSession = useRef<string | undefined>(undefined);
  const browserSurfaceRequest = useRef<string | undefined>(undefined);
  const changeSurfaceRef = useRef<(next: SurfaceId) => void>(() => undefined);
  const observedBrowserTools = useRef(new Set<string>());
  const sessionListRequest = useRef(0);
  const sessionListApplied = useRef(false);
  const sessionPagesRef = useRef<SessionProjectPage[]>([]);
  const sessionPagesQuery = useRef("");
  const pendingSessionRequest = useRef(0);
  const pendingSessionDraft = useRef("");
  const pendingSessionSelection = useRef<ComposerSelection | undefined>(undefined);
  const pendingSessionInFlight = useRef(false);
  const fileWorkspaceStates = useRef(new Map<string, FileWorkspaceState>());
  const fileWorkspaceContents = useRef<FileWorkspaceContentStore>(new Map());
  const toastId = useRef(0);
  const lastError = useRef({ message: "", at: 0 });
  const mobile = useMediaQuery("(max-width: 900px)");
  const inspectorOverlay = useMediaQuery("(max-width: 1179px)");
  const live = useRuntimeStore();
  const agentColors = useAgentColors(live.runtime?.sessionId, live.runtime?.conversation.delegatedRuns ?? []);
  const toSessionProject = (page: SessionProjectPage): SessionProject => ({
    id: page.id,
    label: page.label,
    cwd: page.cwd,
    sessions: page.sessions,
    active:
      activeSessions.some(session => session.projectId === page.id && session.active) ||
      page.sessions.some(session => session.active),
  });
  const projects = useMemo<SessionProject[]>(
    () => sessionPages.filter(page => page.id !== GENERAL_PROJECT_ID).map(toSessionProject),
    [activeSessions, sessionPages],
  );
  const general = useMemo<SessionProject | undefined>(() => {
    const page = sessionPages.find(candidate => candidate.id === GENERAL_PROJECT_ID);
    return page ? toSessionProject(page) : undefined;
  }, [activeSessions, sessionPages]);
  const reportError = (cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message : fallback;
    if (/session changed while listing sessions|session list is stale/i.test(message)) return;
    const now = Date.now();
    if (lastError.current.message === message && now - lastError.current.at < 100) return;
    lastError.current = { message, at: now };
    setToast({ id: ++toastId.current, message });
  };

  const {
    packages,
    setPackages,
    packagesLoading,
    packageBusy,
    setPackageBusy,
    extensions,
    setExtensions,
    extensionsLoading,
    skills,
    skillsLoading,
    extensionBusy,
    setExtensionBusy,
    hookSettings,
    setHookSettings,
    hooksLoading,
    hooksBusy,
    setHooksBusy,
    androidTooling,
    setAndroidTooling,
    androidToolingBusy,
    setAndroidToolingBusy,
  } = useSessionCatalog(live, settingsOpen, reportError);

  const {
    terminalOpen,
    setTerminalOpen,
    closeTerminal,
    terminalSessionId,
    retainedTerminals,
    releaseTerminal,
    terminalDrawerHeight,
    setTerminalDrawerHeight,
    toggleTerminal: openTerminalDrawer,
  } = useTerminalDrawer(live, initialTerminalHeight);
  useMarkSessionSeen(live);

  const sessions = useMemo(() => sessionPages.flatMap(page => page.sessions), [sessionPages]);
  const activeSession = activeSessions.find(session => session.active) ?? sessions.find(session => session.active);
  const activePackages = useMemo(() => new Set(packages.filter(item => item.active).map(item => item.id)), [packages]);
  const browserAvailable = activePackages.has("pi-helios");
  const browserToolRevision = useMemo(
    () =>
      (live.runtime?.conversation.tools ?? [])
        .filter(tool => tool.name === "helios_browser")
        .map(tool => `${tool.id}:${tool.status}`)
        .join("|"),
    [live.runtime?.conversation.tools],
  );
  const timelinePackageAvailable =
    activePackages.has("pi-timeline") || live.runtime?.operational.timeline.availability === "available";
  const timelineEnabled = timelinePackageAvailable && (live.runtime?.runtimePolicy.effective.timelineEnabled ?? true);
  const memoryEnabled =
    activePackages.has("pi-continuity") || live.runtime?.operational.continuity.availability === "available";
  const papercutEnabled =
    activePackages.has("pi-papercut") || live.runtime?.operational.papercuts.availability === "available";
  const continuitySettings = packages.find(item => item.id === "pi-continuity")?.settings;
  const memoryReviewerConfigured =
    !packagesLoading && continuitySettings?.kind === "continuity"
      ? Boolean(continuitySettings.memoryReviewer?.model)
      : undefined;
  const stateqlEnabled = activePackages.has("pi-stateql");
  const git = useGitWorkspace(live, reference === "git" || surface === "review");
  const reviewAvailable = !reviewDismissed && (!!live.runtime?.workspace?.changedCount || !!git.state?.files.length || !!git.state?.operation);
  const navContext = useMemo<NavContext>(
    () => ({
      surface,
      stateqlEnabled,
      browserAvailable,
      browserActive,
      timelineEnabled,
      memoryEnabled,
      papercutEnabled,
      reviewAvailable,
    }),
    [surface, stateqlEnabled, browserAvailable, browserActive, timelineEnabled, memoryEnabled, papercutEnabled, reviewAvailable],
  );
  const rightPanelWidth = panelWidths[panelWidthSlot(reference).key];
  const shellModeClass = surfaceDefinition(surface).shellClass;

  const updateSessionPages = (update: (pages: SessionProjectPage[]) => SessionProjectPage[]) => {
    setSessionPages(current => {
      const next = update(current);
      sessionPagesRef.current = next;
      return next;
    });
  };
  const applySessionList = (result: SessionListSnapshot, appliedQuery = query.trim()) => {
    const liveFields = currentSessionLiveFields();
    const projectsWithLiveFields = result.projects.map(project => ({
      ...project,
      sessions: project.sessions.map(session => applySessionLiveFields(session, liveFields)),
    }));
    const activeWithLiveFields = result.activeSessions
      .map(session => applySessionLiveFields(session, liveFields))
      .filter(session => session.runtimeState !== "sleeping");
    let draftsChanged = false;
    for (const project of projectsWithLiveFields) {
      for (const session of project.sessions) draftsChanged = composerDrafts.rememberProject(session) || draftsChanged;
    }
    for (const session of activeWithLiveFields)
      draftsChanged = composerDrafts.rememberProject(session) || draftsChanged;
    if (draftsChanged) composerDrafts.persist();
    sessionPagesRef.current = projectsWithLiveFields;
    sessionPagesQuery.current = appliedQuery;
    setSessionPages(projectsWithLiveFields);
    setActiveSessions(activeWithLiveFields);
    const firstList = !query.trim() && !sessionListApplied.current;
    if (!query.trim()) sessionListApplied.current = true;
    const projectId =
      activeWithLiveFields.find(session => session.active)?.projectId ??
      projectsWithLiveFields.find(page => page.sessions.some(session => session.active))?.id;
    if (firstList && !query.trim() && projectId) setExpandedProjects(current => new Set([...current, projectId]));
  };

  useEffect(() => {
    runtimeStore.start();
  }, []);

  useEffect(() => {
    const unlock = () => unlockWebAudio();
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  useEffect(() => {
    if (!live.audioCues.length) return;
    enqueueWebAudioCues(live.audioCues.map(cue => cue.kind));
    runtimeStore.consumeAudioCues(live.audioCues.map(cue => cue.id));
  }, [live.audioCues]);

  useDocumentTitle(live.runtime?.extensionUi.title);
  useEffect(() => {
    const sessionId = live.runtime?.sessionId;
    if (sessionId && browserSurfaceSession.current !== sessionId) {
      const transition = beginBrowserSessionSurfaceTransition(
        browserSurfaceSessions.current,
        browserSurfaceSession.current,
        sessionId,
        surface,
      );
      browserSurfaceSessions.current = transition.browserSessions;
      browserSurfaceSession.current = sessionId;
      browserSurfaceRequest.current = transition.requested ? sessionId : undefined;
    }
    setSelectedAgentId(undefined);
    setSelectedCompaction(undefined);
    setSelectedAttachment(undefined);
    setSelectedTurnDiff(undefined);
    setReference(current =>
      current === "compaction" || current === "attachment" || current === "turn-diff" ? null : current,
    );
    setBrowserActive(false);
  }, [live.runtime?.sessionId]);
  const reconcileBrowserSurface = (sessionId: string, active: boolean) => {
    const next = browserSurfaceAfterSessionStatus(browserSurfaceRequest.current, sessionId, active);
    if (!next) return;
    browserSurfaceRequest.current = undefined;
    changeSurfaceRef.current(next);
  };
  useEffect(() => {
    if (live.connection !== "connected" || !live.runtime?.ready) {
      setBrowserActive(false);
      return;
    }
    const sessionId = live.runtime.sessionId;
    const requested = browserSurfaceRequest.current === sessionId;
    if (!browserAvailable && !requested) {
      setBrowserActive(false);
      return;
    }
    let current = true;
    const generation = live.runtime.sessionGeneration;
    void runtimeStore
      .heliosBrowser({ action: "status" })
      .then(result => {
        if (!current || !runtimeRequestStillCurrent(runtimeStore.getSnapshot(), sessionId, generation)) return;
        setBrowserActive(result.active);
        reconcileBrowserSurface(sessionId, result.active);
      })
      .catch(() => {
        if (!current || !runtimeRequestStillCurrent(runtimeStore.getSnapshot(), sessionId, generation)) return;
        setBrowserActive(false);
        reconcileBrowserSurface(sessionId, false);
      });
    return () => {
      current = false;
    };
  }, [
    browserAvailable,
    browserToolRevision,
    live.connection,
    live.runtime?.ready,
    live.runtime?.sessionId,
    live.runtime?.sessionGeneration,
  ]);
  useEffect(() => {
    const sessionId = live.runtime?.sessionId;
    const tools = live.runtime?.conversation.tools ?? [];
    if (!sessionId) return;
    if (browserToolSession.current !== sessionId) {
      browserToolSession.current = sessionId;
      observedBrowserTools.current = new Set(tools.map(tool => tool.id));
      const runningStart = [...tools].reverse().find(tool => tool.status === "running" && startsHeliosBrowser(tool));
      setBrowserMirrorRequest(runningStart ? `${sessionId}:${runningStart.id}` : "");
      if (runningStart) {
        setSidebarOpen(false);
        changeSurface("browser");
      }
      return;
    }
    const start = [...tools]
      .reverse()
      .find(
        tool => tool.status !== "failed" && !observedBrowserTools.current.has(tool.id) && startsHeliosBrowser(tool),
      );
    for (const tool of tools) observedBrowserTools.current.add(tool.id);
    if (!start) return;
    setBrowserMirrorRequest(`${sessionId}:${start.id}`);
    setSidebarOpen(false);
    changeSurface("browser");
  }, [live.runtime?.sessionId, live.runtime?.conversation.tools]);

  useEffect(() => {
    if (mobile && previousSidebarOpen.current && !sidebarOpen)
      document.querySelector<HTMLButtonElement>('.scope-rail [data-label="All sessions"]')?.focus();
    previousSidebarOpen.current = sidebarOpen;
  }, [mobile, sidebarOpen]);

  useEffect(() => {
    const closed = previousReference.current;
    previousReference.current = reference;
    if (!closed || reference) return;
    // Rail references return focus to their own button, never to another's.
    if (referenceDefinition(closed)) {
      panelToggles.current.get(closed)?.focus();
      return;
    }
    // Panels opened from the conversation have no button of their own.
    if (closed === "attachment") selectedAttachment?.trigger.focus();
    else if (closed === "turn-diff") selectedTurnDiff?.trigger.focus();
    else panelToggles.current.get("overview")?.focus();
  }, [reference]);

  useLayoutEffect(() => {
    const drawer = workspaceRef.current?.querySelector<HTMLElement>(":scope > .inspector");
    if (!drawer) return;
    drawer.inert = Boolean(pendingSession);
    return () => {
      drawer.inert = false;
    };
  }, [Boolean(pendingSession), reference, live.runtime?.sessionId]);

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const reference =
        typeof detail === "string"
          ? { path: detail }
          : detail && typeof detail === "object" && typeof (detail as FileReference).path === "string"
            ? (detail as FileReference & { view?: "current" | "diff"; annotationNote?: boolean })
            : undefined;
      if (!reference) return;
      setRequestedFile({
        ...reference,
        sessionId: runtimeStore.getSnapshot().runtime?.sessionId,
        requestId: Date.now(),
      });
      if ("annotationNote" in reference && reference.annotationNote) { setSurface("files"); setReference("notes"); }
      else if (surface !== "files") setReference("changes");
    };
    window.addEventListener("pylon:open-file", open);
    return () => window.removeEventListener("pylon:open-file", open);
  }, [surface]);

  useEffect(() => {
    if (
      live.connection !== "connected" ||
      live.generation === undefined ||
      (live.runtime !== undefined && !live.runtime.ready)
    )
      return;
    let active = true;
    const controller = new AbortController();
    const request = ++sessionListRequest.current;
    const sessionId = live.runtime?.sessionId;
    const sessionGeneration = live.generation;
    const selectionStillCurrent = () => {
      const snapshot = runtimeStore.getSnapshot();
      return (
        snapshot.connection === "connected" &&
        snapshot.generation === sessionGeneration &&
        snapshot.runtime?.sessionId === sessionId
      );
    };
    const requestQuery = query.trim();
    const previousPages = sessionPagesQuery.current === requestQuery ? sessionPagesRef.current : [];
    setSessionsLoading(true);
    const timer = window.setTimeout(
      () =>
        void listSessionsPreservingPages(
          (input, signal) => runtimeStore.listSessions(input, signal),
          previousPages,
          requestQuery,
          controller.signal,
        )
          .then(result => {
            if (!active || request !== sessionListRequest.current || !selectionStillCurrent()) return;
            applySessionList(result, requestQuery);
          })
          .catch(cause => {
            if (active && request === sessionListRequest.current && selectionStillCurrent()) {
              reportError(cause, "Unable to list sessions");
            }
          })
          .finally(() => {
            if (active && request === sessionListRequest.current) setSessionsLoading(false);
          }),
      query ? 200 : 0,
    );
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [
    live.connection,
    live.generation,
    live.runtime?.ready,
    live.runtime?.sessionId,
    live.runtime?.sessionName,
    live.sessionRevision,
    query,
  ]);

  useEffect(() => {
    if (live.connection === "connected" && live.errorRevision && live.error) {
      reportError(new Error(live.error), "Command failed");
    }
  }, [live.errorRevision]);

  useEffect(() => {
    if (!pendingSession || pendingSession.phase !== "preparing" || pendingSession.expectedGeneration === undefined)
      return;
    const runtime = live.runtime;
    if (
      live.connection !== "connected" ||
      runtime?.ready !== true ||
      runtime.sessionGeneration !== pendingSession.expectedGeneration ||
      runtime.sessionId === pendingSession.previousSessionId
    )
      return;
    const draft = pendingSessionDraft.current;
    composerDrafts.adopt(runtime.sessionId, pendingSession.project.id, draft, pendingSession.recoveredDraftSessionId);
    if (document.activeElement instanceof HTMLTextAreaElement && document.activeElement.id === "runtime-prompt") {
      pendingSessionSelection.current = {
        start: document.activeElement.selectionStart,
        end: document.activeElement.selectionEnd,
        direction: document.activeElement.selectionDirection,
      };
      setComposerFocusTarget(runtime.sessionId);
    }
    pendingSessionDraft.current = "";
    setPendingSession(current => (current?.requestId === pendingSession.requestId ? undefined : current));
    setSessionBusy("");
  }, [live.connection, live.runtime?.ready, live.runtime?.sessionId, live.runtime?.sessionGeneration, pendingSession]);

  useEffect(() => {
    if (!live.notificationRevision || !live.notification?.message) return;
    setToast({ id: ++toastId.current, message: live.notification.message });
  }, [live.notificationRevision]);

  useEffect(() => {
    const definition = referenceDefinition(reference);
    if (definition && !(definition.available?.(navContext) ?? true)) setReference("overview");
  }, [reference, navContext]);

  useEffect(() => {
    if (!(surfaceDefinition(surface).available?.(navContext) ?? true)) changeSurface("chat");
  }, [surface, navContext]);

  useEffect(() => {
    if (!live.sessionStatuses && !live.sessionWorkStartedAts && !live.sessionTodoProgress) return;
    const liveFields = {
      states: live.sessionStatuses,
      workStartedAts: live.sessionWorkStartedAts,
      todoProgress: live.sessionTodoProgress,
    };
    const updateSession = (session: SessionSummary) => applySessionLiveFields(session, liveFields);
    updateSessionPages(pages => pages.map(page => ({ ...page, sessions: page.sessions.map(updateSession) })));
    setActiveSessions(sessions => sessions.map(updateSession).filter(session => session.runtimeState !== "sleeping"));
  }, [live.sessionStatuses, live.sessionWorkStartedAts, live.sessionTodoProgress]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (live.pendingUi || shortcutsBlocked(event)) return;
      if (event.key === "Escape") {
        setSidebarOpen(false);
        if (workspaceView) setWorkspaceView(null);
        else if (inspectorOverlay) setReference(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspectorOverlay, live.pendingUi?.owned, mobile, workspaceView]);

  const switchSession = async (
    session: Pick<SessionSummary, "id"> & Partial<Pick<SessionSummary, "active" | "runningUnderParentSessionId">>,
  ) => {
    setWorkspaceView(null);
    if (sessionBusy || sessionDeleting) {
      if (mobile) setSidebarOpen(false);
      return;
    }
    if (pendingSession) {
      setPendingSession(undefined);
      pendingSessionDraft.current = "";
      pendingSessionSelection.current = undefined;
    }
    if (session.active) {
      if (mobile) setSidebarOpen(false);
      return;
    }
    const listedParentId = session.runningUnderParentSessionId;
    const openParentActivity = async (parentId: string) => {
      if (runtimeStore.getSnapshot().runtime?.sessionId !== parentId) await runtimeStore.switchSession(parentId);
      const run = [...(runtimeStore.getSnapshot().runtime?.conversation.delegatedRuns ?? [])]
        .reverse()
        .find(candidate => candidate.kind === "spawn_session" && candidate.threadId === session.id);
      if (!run) {
        try {
          await runtimeStore.switchSession(session.id);
          return;
        } catch {
          throw new Error("Spawned session activity is not available yet. Try again.");
        }
      }
      setSelectedAgentId(run.id);
      setReference("agents");
    };
    setSessionBusy(session.id);
    setSessionTransition(!listedParentId || live.runtime?.sessionId !== listedParentId);
    try {
      if (listedParentId) {
        await openParentActivity(listedParentId);
      } else {
        try {
          await runtimeStore.switchSession(session.id);
        } catch (cause) {
          const parentId =
            cause instanceof Error
              ? /currently running under its parent session \(([^)]+)\)/i.exec(cause.message)?.[1]
              : undefined;
          if (!parentId) throw cause;
          await openParentActivity(parentId);
        }
      }
      if (mobile) setSidebarOpen(false);
    } catch (cause) {
      reportError(cause, "Unable to open session");
    } finally {
      setSessionBusy("");
      setSessionTransition(false);
    }
  };

  const newSession = async (project: SessionProject, retry = false) => {
    if (pendingSessionInFlight.current || sessionBusy || sessionDeleting || projectBusy) return;
    setWorkspaceView(null);
    let recoveredDraft: ComposerDraft | undefined;
    if (!retry) {
      const draft = composerDrafts.latestForProject(project.id);
      if (draft && draft.sessionId !== live.runtime?.sessionId) {
        pendingSessionInFlight.current = true;
        setSessionBusy(draft.sessionId);
        setSessionTransition(true);
        try {
          await runtimeStore.switchSession(draft.sessionId);
          setComposerFocusTarget(draft.sessionId);
          if (mobile) setSidebarOpen(false);
          return;
        } catch {
          recoveredDraft = draft;
        } finally {
          pendingSessionInFlight.current = false;
          setSessionBusy("");
          setSessionTransition(false);
        }
      }
    }
    pendingSessionInFlight.current = true;
    const requestId = retry && pendingSession ? pendingSession.requestId : ++pendingSessionRequest.current;
    if (!retry) {
      pendingSessionDraft.current = recoveredDraft?.text ?? "";
      pendingSessionSelection.current = undefined;
    }
    setPendingSession({
      requestId,
      project,
      previousSessionId: live.runtime?.sessionId,
      recoveredDraftSessionId: retry ? pendingSession?.recoveredDraftSessionId : recoveredDraft?.sessionId,
      phase: "preparing",
    });
    setTerminalOpen(false);
    setSessionBusy(project.id);
    let accepted = false;
    try {
      const expectedGeneration = await runtimeStore.newSession(project.id);
      accepted = true;
      setPendingSession(current => (current?.requestId === requestId ? { ...current, expectedGeneration } : current));
      if (mobile) setSidebarOpen(false);
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : "Unable to create session";
      setPendingSession(current =>
        current?.requestId === requestId ? { ...current, phase: "failed", error } : current,
      );
    } finally {
      pendingSessionInFlight.current = false;
      if (!accepted) setSessionBusy("");
    }
  };

  const deleteSession = async (session: SessionSummary) => {
    if (session.active || sessionBusy || sessionDeleting) return;
    setSessionDeleting(session.id);
    sessionListRequest.current++;
    try {
      await runtimeStore.deleteSession(session.id);
      composerDrafts.dropSession(session.id);
      setActiveSessions(current => current.filter(candidate => candidate.id !== session.id));
      updateSessionPages(current =>
        current
          .map(page => ({
            ...page,
            totalCount: page.id === session.projectId ? Math.max(0, page.totalCount - 1) : page.totalCount,
            sessions: page.sessions.filter(candidate => candidate.id !== session.id),
          }))
          .filter(page => page.totalCount > 0),
      );
      const request = ++sessionListRequest.current;
      try {
        const requestQuery = query.trim();
        const previousPages = sessionPagesQuery.current === requestQuery ? sessionPagesRef.current : [];
        const result = await listSessionsPreservingPages(
          (input, signal) => runtimeStore.listSessions(input, signal),
          previousPages,
          requestQuery,
        );
        if (request === sessionListRequest.current) applySessionList(result, requestQuery);
      } catch (cause) {
        reportError(
          cause instanceof Error ? new Error(`Session deleted, but refresh failed: ${cause.message}`) : cause,
          "Session deleted, but refresh failed",
        );
      }
      setSidebarAction(undefined);
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
    setProjectBusy(project.id);
    try {
      await runtimeStore.removeProject(project.id);
      composerDrafts.dropProject(project.id);
      setSidebarAction(undefined);
    } catch (cause) {
      reportError(cause, "Unable to remove project");
    } finally {
      setProjectBusy("");
    }
  };

  const updateWorktreeSetup = async (project: SessionProject, setupCommand: string) => {
    setProjectBusy(project.id);
    try {
      await runtimeStore.updateProjectWorktreeSettings(project.id, setupCommand);
      setSidebarAction(undefined);
    } catch (cause) {
      reportError(cause, "Unable to save worktree setup");
    } finally {
      setProjectBusy("");
    }
  };

  const renameSession = async (session: SessionSummary, value: string) => {
    if (sessionBusy || sessionDeleting) return;
    const name = value.trim();
    if (!name || name === session.name) {
      setSidebarAction(undefined);
      return;
    }
    setSessionBusy(session.id);
    try {
      await runtimeStore.renameSession(session.id, name);
      const rename = (candidate: SessionSummary) => (candidate.id === session.id ? { ...candidate, name } : candidate);
      setActiveSessions(current => current.map(rename));
      updateSessionPages(current => current.map(page => ({ ...page, sessions: page.sessions.map(rename) })));
      setSidebarAction(undefined);
    } catch (cause) {
      reportError(cause, "Unable to rename session");
    } finally {
      setSessionBusy("");
    }
  };

  const renameProject = async (project: SessionProject, value: string) => {
    if (projectBusy || sessionBusy || sessionDeleting) return;
    const name = value.trim();
    if (!name || name === project.label) {
      setSidebarAction(undefined);
      return;
    }
    setProjectBusy(project.id);
    try {
      await runtimeStore.renameProject(project.id, name);
      updateSessionPages(current => current.map(page => (page.id === project.id ? { ...page, label: name } : page)));
      setActiveSessions(current =>
        current.map(session => (session.projectId === project.id ? { ...session, cwdLabel: name } : session)),
      );
      setSidebarAction(undefined);
    } catch (cause) {
      reportError(cause, "Unable to rename project");
    } finally {
      setProjectBusy("");
    }
  };

  const setSessionActive = async (session: SessionSummary, active: boolean) => {
    if (sessionBusy || sessionDeleting || (!active && session.runtimeState !== "idle")) return;
    setSessionBusy(session.id);
    try {
      await runtimeStore.setSessionActive(session.id, active);
    } catch (cause) {
      reportError(cause, `Unable to ${active ? "activate" : "deactivate"} session`);
    } finally {
      setSessionBusy("");
    }
  };

  const setSessionPinned = async (session: SessionSummary, pinned: boolean) => {
    if (sessionBusy || sessionDeleting) return;
    setSessionBusy(session.id);
    try {
      await runtimeStore.setSessionPinned(session.id, pinned);
    } catch (cause) {
      reportError(cause, `Unable to ${pinned ? "pin" : "unpin"} session`);
    } finally {
      setSessionBusy("");
    }
  };

  const loadMoreSessions = async (project: SessionProject) => {
    const current = sessionPages.find(page => page.id === project.id);
    if (!current?.nextCursor || projectLoading) return;
    const request = sessionListRequest.current;
    const requestQuery = query.trim();
    const runtime = live.runtime;
    setProjectLoading(project.id);
    try {
      const result = await runtimeStore.listSessions({
        projectId: project.id,
        cursor: current.nextCursor,
        query: requestQuery || undefined,
        limit: SESSION_LIST_MORE_LIMIT,
      });
      if (
        request !== sessionListRequest.current ||
        query.trim() !== requestQuery ||
        !runtime ||
        !runtimeRequestStillCurrent(runtimeStore.getSnapshot(), runtime.sessionId, runtime.sessionGeneration)
      )
        return;
      const liveFields = currentSessionLiveFields();
      const updateSession = (session: SessionSummary) => applySessionLiveFields(session, liveFields);
      setActiveSessions(result.activeSessions.map(updateSession).filter(session => session.runtimeState !== "sleeping"));
      const next = result.projects[0];
      if (!next) return;
      updateSessionPages(pages =>
        pages.map(page =>
          page.id === project.id
            ? {
                ...page,
                sessions: [
                  ...page.sessions.map(updateSession),
                  ...next.sessions
                    .filter(session => !page.sessions.some(old => old.id === session.id))
                    .map(updateSession),
                ],
                nextCursor: next.nextCursor,
              }
            : page,
        ),
      );
    } catch (cause) {
      reportError(cause, "Unable to load more sessions");
    } finally {
      setProjectLoading("");
    }
  };

  const showLessSessions = async (project: SessionProject) => {
    const current = sessionPages.find(page => page.id === project.id);
    if (!current || current.sessions.length <= SESSION_LIST_INITIAL_LIMIT || projectLoading) return;
    const request = sessionListRequest.current;
    const requestQuery = query.trim();
    const runtime = live.runtime;
    setProjectLoading(project.id);
    try {
      const result = await runtimeStore.listSessions({
        projectId: project.id,
        query: requestQuery || undefined,
        limit: SESSION_LIST_INITIAL_LIMIT,
      });
      if (
        request !== sessionListRequest.current ||
        query.trim() !== requestQuery ||
        !runtime ||
        !runtimeRequestStillCurrent(runtimeStore.getSnapshot(), runtime.sessionId, runtime.sessionGeneration)
      )
        return;
      const liveFields = currentSessionLiveFields();
      const updateSession = (session: SessionSummary) => applySessionLiveFields(session, liveFields);
      const next = result.projects[0];
      if (!next) return;
      const nextWithLiveFields = { ...next, sessions: next.sessions.map(updateSession) };
      setActiveSessions(result.activeSessions.map(updateSession).filter(session => session.runtimeState !== "sleeping"));
      updateSessionPages(pages => pages.map(page => (page.id === project.id ? nextWithLiveFields : page)));
    } catch (cause) {
      reportError(cause, "Unable to show fewer sessions");
    } finally {
      setProjectLoading("");
    }
  };

  const archiveProject = async (project: SessionProject) => {
    if (projectBusy || sessionBusy || sessionDeleting) return;
    setProjectBusy(project.id);
    try {
      await runtimeStore.archiveProject(project.id);
      for (const session of project.sessions) composerDrafts.forgetInMemory(session.id);
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
      composerDrafts.forgetInMemory(session.id);
    } catch (cause) {
      reportError(cause, "Unable to archive session");
    } finally {
      setSessionBusy("");
    }
  };

  const toggleReference = (next: ReferenceId) => {
    if (inspectorOverlay) setSidebarOpen(false);
    setReference(current => (current === next ? null : next));
  };

  const setPackageEnabled = async (item: PackageSummary, enabled: boolean) => {
    if (packageBusy) return;
    setPackageBusy(item.id);
    try {
      await runtimeStore.setPackageEnabled(item.id, enabled);
      setPackages(current =>
        current.map(candidate => (candidate.id === item.id ? { ...candidate, enabled } : candidate)),
      );
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
      setPackages(current =>
        current.map(candidate => (candidate.id === item.id ? { ...candidate, settings } : candidate)),
      );
    } catch (cause) {
      reportError(cause, `Unable to update ${item.name}`);
    } finally {
      setPackageBusy("");
    }
  };

  const refreshExtensions = async () => setExtensions(await runtimeStore.listExtensions());
  const manageExtension = async (key: string, action: () => Promise<void>, failure: string) => {
    if (extensionBusy) throw new Error("Another extension operation is still running");
    setExtensionBusy(key);
    try {
      await action();
      await refreshExtensions();
    } catch (cause) {
      reportError(cause, failure);
      throw cause;
    } finally {
      setExtensionBusy("");
    }
  };
  const toggleExtension = (extension: NativeExtensionReadModel, enabled: boolean) =>
    manageExtension(
      extension.id,
      () => runtimeStore.setExtensionEnabled(extension.id, enabled),
      "Unable to update extension",
    );
  const installExtensionPackage = (source: string, scope: "user" | "project", projectId?: string) =>
    manageExtension(
      `install:${source}`,
      () => runtimeStore.installExtensionPackage(source, scope, projectId),
      "Unable to install extension package",
    );
  const removeExtensionPackage = (source: string, scope: "user" | "project") =>
    manageExtension(
      `remove:${source}`,
      () => runtimeStore.removeExtensionPackage(source, scope),
      "Unable to remove extension package",
    );
  const setProjectTrust = (trusted: boolean) =>
    manageExtension("trust", () => runtimeStore.setProjectTrust(trusted), "Unable to update project trust");
  const reloadExtensions = () =>
    manageExtension("reload", () => runtimeStore.reloadExtensions(), "Unable to reload extensions");
  const refreshModels = async () => {
    if (modelRefreshBusy) return;
    setModelRefreshBusy(true);
    try {
      await runtimeStore.refreshModelCatalogs();
    } catch {
      // The runtime store routes the failure through the application toast.
    } finally {
      setModelRefreshBusy(false);
    }
  };

  const manageAndroidTooling = async (action: "status" | "install" | "remove") => {
    if (androidToolingBusy) throw new Error("Another Android tooling operation is still running");
    if (action !== "status") setAndroidToolingBusy(action);
    try {
      const result = await runtimeStore.heliosAndroidTooling(
        action === "status" ? { action } : { action, confirmed: true },
      );
      setAndroidTooling(result);
    } catch (cause) {
      reportError(cause, `Unable to ${action === "install" ? "set up" : action} Android tooling`);
      throw cause;
    } finally {
      if (action !== "status") setAndroidToolingBusy("");
    }
  };

  const updateHookSettings = async (settings: HookSettingsReadModel) => {
    if (hooksBusy) throw new Error("Another hook settings update is still saving");
    setHooksBusy(true);
    try {
      await runtimeStore.updateHookSettings(settings);
      setHookSettings(settings);
    } catch (cause) {
      reportError(cause, "Unable to update hook settings");
      throw cause;
    } finally {
      setHooksBusy(false);
    }
  };

  const currentProjectPage = sessionPages.find(page => page.id === activeSession?.projectId);
  const currentProject = currentProjectPage ? toSessionProject(currentProjectPage) : (projects[0] ?? general);
  const composerProject =
    pendingSession?.project ??
    (currentProjectPage ? toSessionProject(currentProjectPage) : live.runtime ? undefined : currentProject);
  const composerProjectLabel = composerProject?.label ?? activeSession?.cwdLabel ?? live.runtime?.cwdLabel ?? "Project";
  const toggleTerminal = () => {
    openTerminalDrawer();
    if (mobile) setSidebarOpen(false);
  };
  const openSettings = () => {
    showSettings();
    if (mobile) setSidebarOpen(false);
  };
  const requestDeleteSession = (session: SessionSummary) =>
    setSidebarAction({
      key: `delete-session-${session.id}`,
      title: `Delete “${sessionTitle(session)}”?`,
      description: "This removes saved history. If system trash is unavailable, deletion is permanent.",
      confirmLabel: "Delete session",
      busyLabel: "Deleting…",
      danger: true,
      onConfirm: () => void deleteSession(session),
    });
  const requestRenameSession = (session: SessionSummary) =>
    setSidebarAction({
      key: `rename-session-${session.id}`,
      title: "Rename session",
      description: "Choose a name that makes this session easy to find.",
      confirmLabel: "Save name",
      busyLabel: "Saving…",
      inputLabel: "Session name",
      initialValue: sessionTitle(session),
      onConfirm: (value: string) => void renameSession(session, value),
    });
  /**
   * Switching surface hands the conversation between its two homes: a surface
   * that fills the main area displaces it into the rail, and coming back
   * gives the rail to whatever was there before — unless you chose something
   * else while it was docked, in which case that choice stands.
   */
  const changeSurface = (next: SurfaceId) => {
    if (next === "review") setReviewDismissed(false);
    const sessionId = live.runtime?.sessionId;
    if (sessionId) {
      if (next === "browser") browserSurfaceSessions.current.add(sessionId);
      else browserSurfaceSessions.current.delete(sessionId);
      if (browserSurfaceRequest.current === sessionId) browserSurfaceRequest.current = undefined;
    }
    setWorkspaceView(null);
    setSidebarOpen(false);
    if (next === surface) return;
    const wasDisplaced = displacesConversation(surface);
    setSurface(next);
    if (displacesConversation(next)) {
      if (!wasDisplaced) displacedReference.current = reference;
      setReference("chat");
    } else if (reference === "chat") {
      setReference(displacedReference.current);
    }
  };
  changeSurfaceRef.current = changeSurface;
  const openGitReview = (query?: GitDetailQuery) => { git.select(query); changeSurface("review"); setReference(null); };
  const openGitFile = (path: string, view: FileView = "current") => {
    setRequestedFile({ path, view, sessionId: live.runtime?.sessionId, requestId: Date.now() });
    changeSurface("files");
  };
  useEffect(() => {
    if (live.pendingUi?.surface === "database" && live.pendingUi.owned) changeSurfaceRef.current("database");
  }, [live.pendingUi?.requestId, live.pendingUi?.owned]);

  const openWorkspaceView = (next: WorkspaceViewId) => {
    if (next === "sessions") {
      if (workspaceView) {
        setWorkspaceView(null);
        setSidebarCollapsed(false);
        setSidebarOpen(mobile);
        return;
      }
      if (mobile) {
        setSidebarOpen(open => !open);
        return;
      }
      setSidebarCollapsed(collapsed => {
        if (collapsed) queueMicrotask(() => searchRef.current?.focus());
        return !collapsed;
      });
      return;
    }
    if (next === "archive") {
      setArchivesOpen(true);
      setSidebarOpen(false);
      return;
    }
    setWorkspaceView(current => (current === next ? null : next));
    setSidebarOpen(false);
  };

  const runAmbient = (id: AmbientId) => {
    if (id === "theme") setTheme(resolvedTheme === "dark" ? "light" : "dark");
    if (id === "settings") openSettings();
    if (id === "changelog") setChangelogOpen(true);
    if (id === "terminal") toggleTerminal();
  };
  const [applyRequest, setApplyRequest] = useState<{ sessionId: string; revision: string }>();
  const keyboardReady = live.connection === "connected" && !!live.runtime?.ready && !pendingSession;
  const reviewChanges = () => { changeSurface("chat"); setReference("changes"); };
  const keyboardHandlers: ShortcutHandlers = {
    "find-file": keyboardReady ? () => openSearch("files") : undefined,
    "find-text": keyboardReady ? () => openSearch("text") : undefined,
    "find-symbol": keyboardReady ? () => openSearch("symbols") : undefined,
    "last-tab": keyboardReady ? () => window.dispatchEvent(new CustomEvent("pylon:search")) : undefined,
    sessions: () => { setSidebarCollapsed(false); if (mobile) setSidebarOpen(true); requestAnimationFrame(() => searchRef.current?.focus()); },
    "new-session": live.connection === "connected" && currentProject && !sessionBusy && !sessionDeleting && !projectBusy && !pendingSession ? () => newSession(currentProject) : undefined,
    "stop-turn": keyboardReady && live.runtime?.conversation.workStartedAt && !live.runtime.conversation.stopping ? () => runtimeStore.abort() : undefined,
    archive: keyboardReady && activeSession && !sessionBusy && !sessionDeleting && !projectBusy ? () => setSidebarAction({
      key: `archive-session-${activeSession.id}`, title: "Archive this session?", description: "The session will move to the archive. Saved history is retained.",
      confirmLabel: "Archive session", busyLabel: "Archiving…", onConfirm: () => { void archiveSession(activeSession).then(() => setSidebarAction(undefined)); },
    }) : undefined,
    worktree: keyboardReady && live.runtime?.workspace?.canMoveToWorktree ? () => runtimeStore.handoffSession("worktree") : undefined,
    terminal: keyboardReady && live.runtime?.projectAvailable !== false ? toggleTerminal : undefined,
    changes: keyboardReady ? reviewChanges : undefined,
    inspector: keyboardReady ? () => setReference(current => current ? null : "overview") : undefined,
    theme: () => runAmbient("theme"),
    settings: openSettings,
    apply: keyboardReady && live.runtime?.workspace?.canApplyChanges && live.runtime.workspace.revision ? () => {
      setApplyRequest({ sessionId: live.runtime!.sessionId, revision: live.runtime!.workspace!.revision! }); reviewChanges();
    } : undefined,
    reindex: keyboardReady && live.runtime?.discoverIndex && live.runtime.discoverIndex.state !== "indexing" ? () => runtimeStore.rebuildDiscoverIndex() : undefined,
  };
  useGlobalShortcuts(keyboardHandlers, !!live.pendingUi);

  const branchLabel = pendingSession
    ? pendingSession.phase === "failed"
      ? "setup failed"
      : "workspace pending"
    : `${live.runtime?.gitBranch || "No Git branch"} · Turn ${live.runtime?.metrics.userMessages ?? 0}`;
  const topbar = (
    <div className="workspace-search-surface-header">
    <SurfaceTabs
      surface={surface}
      context={navContext}
      runtime={pendingSession ? undefined : live.runtime}
      disabled={Boolean(pendingSession)}
      branchLabel={branchLabel}
      onSurface={changeSurface}
    />
      <button type="button" className="workspace-search-launcher" disabled={!live.runtime?.ready || Boolean(pendingSession)}
        title={`Search workspace · Files: ${shortcutLabel("find-file")} · Text: ${shortcutLabel("find-text")}`} onClick={() => openSearch()}>Search</button>
    </div>
  );
  /**
   * The sidebar, and so its scrim. A workspace view keeps it: the session list is
   * workspace scope itself, so Usage replaces the surface and its reference panel
   * rather than the list you navigate from.
   *
   * The resizer is not tied to this: when the sidebar gives way to the file
   * explorer, that column is still --sidebar-width, so it still wants the handle.
   */
  const sidebarVisible = workspaceView ? true : surface !== "files" || fileNavigation === "sessions";
  const surfaceMain =
    surface === "review" ? (
      <ReviewSurface key={`review:${live.runtime?.sessionId ?? "loading"}:${live.runtime?.sessionGeneration ?? 0}`} live={live} git={git} onClose={() => { setReviewDismissed(true); changeSurface("files"); }} onOpenFile={openGitFile} />
    ) : surface === "database" ? (
      <DatabasePanel
        key={`database:${live.runtime?.sessionId ?? "loading"}`}
        live={live}
        onClose={() => changeSurface("chat")}
      />
    ) : surface === "browser" ? (
      <BrowserPanel
        key={`browser:${live.runtime?.sessionId ?? "loading"}`}
        connected={live.connection === "connected" && live.runtime?.ready === true}
        generation={live.runtime?.sessionGeneration}
        mirrorRequest={browserMirrorRequest}
        onActiveChange={setBrowserActive}
        onClose={() => changeSurface("chat")}
        onError={reportError}
      />
    ) : null;
  const selectedAgent = live.runtime?.conversation.delegatedRuns.find(run => run.id === selectedAgentId);
  const referenceRail = (
    <ReferenceRail
      reference={reference}
      context={navContext}
      runtime={pendingSession ? undefined : live.runtime}
      disabled={Boolean(pendingSession)}
      agentTone={selectedAgent ? agentColor(selectedAgent, agentColors)["--agent-color"] : undefined}
      registerButton={(id, node) => {
        if (node) panelToggles.current.set(id, node);
        else panelToggles.current.delete(id);
      }}
      onReference={toggleReference}
    />
  );
  const conversationPanel = (
    <ConversationPanel
      key={
        pendingSession
          ? `conversation:pending:${pendingSession.requestId}`
          : `conversation:${live.runtime?.sessionId ?? (live.connection === "connected" ? "empty" : "loading")}:${surface}`
      }
      live={live}
      projectAvailable={live.runtime?.projectAvailable !== false}
      showActiveAgents={reference !== "agents"}
      pendingSession={
        pendingSession
          ? {
              phase: pendingSession.phase,
              projectLabel: pendingSession.project.label,
              cwd: pendingSession.project.cwd,
              connected: live.connection === "connected",
              error: pendingSession.error,
              onRetry: () => void newSession(pendingSession.project, true),
            }
          : undefined
      }
      composerSessionSwitcher={{
        projectAvailable: live.runtime?.projectAvailable !== false,
        projectId: composerProject?.id,
        projectLabel: composerProjectLabel,
        sessionLabel: pendingSession
          ? "New session"
          : activeSession
            ? sessionTitle(activeSession)
            : live.runtime
              ? live.runtime.sessionName || "Untitled session"
              : "No session selected",
        branchLabel: pendingSession
          ? "workspace pending"
          : live.runtime
            ? live.runtime.gitBranch || "No Git branch"
            : "Select a session",
        catalog: { activeSessions, projects: sessionPages },
        catalogRevision: live.sessionRevision ?? 0,
        canLoadCatalog:
          live.connection === "connected" && live.generation !== undefined && live.runtime?.ready !== false && !pendingSession,
        branchAvailable: live.runtime?.workspace?.gitAvailable === true && !pendingSession,
        unseenCompletions: live.unseenCompletions,
        busy: sessionBusy || projectBusy,
        deleting: sessionDeleting,
        onSelect: session => void switchSession(session),
        onDelete: requestDeleteSession,
        onArchive: session => void archiveSession(session),
        onRename: requestRenameSession,
        onSetActive: (session, active) => void setSessionActive(session, active),
        onSetPinned: (session, pinned) => void setSessionPinned(session, pinned),
        onNewSession: () => {
          if (!composerProject) return;
          changeSurface("chat");
          void newSession(composerProject);
        },
        onAddProject: () => void addProject(),
        onError: cause => reportError(cause, "Unable to list sessions"),
      }}
      initialDraft={
        pendingSession
          ? pendingSessionDraft.current
          : live.runtime?.sessionId
            ? composerDrafts.textFor(live.runtime.sessionId)
            : undefined
      }
      restoreComposerFocus={composerFocusTarget === live.runtime?.sessionId}
      restoreComposerSelection={
        composerFocusTarget === live.runtime?.sessionId ? pendingSessionSelection.current : undefined
      }
      onComposerFocusRestored={() => {
        pendingSessionSelection.current = undefined;
        setComposerFocusTarget(current => (current === live.runtime?.sessionId ? undefined : current));
      }}
      onDraftChange={draft => {
        if (pendingSession) {
          pendingSessionDraft.current = draft;
          if (pendingSession.recoveredDraftSessionId)
            composerDrafts.save(pendingSession.recoveredDraftSessionId, pendingSession.project.id, draft);
          const runtime = live.runtime;
          if (
            pendingSession.expectedGeneration !== undefined &&
            runtime?.ready === true &&
            runtime.sessionGeneration === pendingSession.expectedGeneration &&
            runtime.sessionId !== pendingSession.previousSessionId
          )
            composerDrafts.save(runtime.sessionId, pendingSession.project.id, draft);
          return;
        }
        const sessionId = live.runtime?.sessionId;
        if (sessionId) composerDrafts.save(sessionId, activeSession?.projectId, draft);
      }}
      onSelectAgent={id => {
        setSelectedAgentId(id);
        setReference("agents");
      }}
      onOpenCompaction={message => {
        const sessionId = live.runtime?.sessionId;
        if (!sessionId) return;
        setSelectedCompaction({ sessionId, message });
        setReference("compaction");
      }}
      openAttachment={
        reference === "attachment" && selectedAttachment
          ? {
              sourceEntryId: selectedAttachment.attachments[selectedAttachment.index]?.sourceEntryId ?? "",
              index: selectedAttachment.attachments[selectedAttachment.index]?.index ?? -1,
            }
          : undefined
      }
      openTurnDiffEntryId={
        reference === "turn-diff" && selectedTurnDiff?.sessionId === live.runtime?.sessionId
          ? selectedTurnDiff?.entryId
          : undefined
      }
      onOpenTurnDiff={(entryId, files, trigger) => {
        const sessionId = live.runtime?.sessionId;
        if (!sessionId) return;
        if (
          reference === "turn-diff" &&
          selectedTurnDiff?.sessionId === sessionId &&
          selectedTurnDiff.entryId === entryId
        ) {
          setReference(null);
          return;
        }
        setSelectedTurnDiff({ sessionId, entryId, files, trigger });
        setReference("turn-diff");
      }}
      onOpenAttachment={(attachments, index, trigger) => {
        const sessionId = live.runtime?.sessionId;
        if (!sessionId) return;
        setSelectedAttachment({ sessionId, attachments, index, trigger });
        setReference("attachment");
      }}
      agentColors={agentColors}
      onOpenLogin={provider => {
        showSettings({ tab: "providers", providerQuery: provider ?? "" });
      }}
    />
  );

  const sidePanel = (
    <DeferredPanel key={reference ?? "closed"}>
      {reference && inspectorOverlay && (
        <button className="inspector-scrim" aria-label={`Close ${reference}`} onClick={() => setReference(null)} />
      )}
      {reference && (
        <PanelResizer
          container={workspaceRef}
          width={rightPanelWidth}
          onCommit={width => {
            const slot = panelWidthSlot(reference);
            setPanelWidths(current => ({ ...current, [slot.key]: width }));
            rememberSetting(slot.key, width);
          }}
        />
      )}
      {reference === "chat" && (
        <ReferencePanel reference="chat" overlay={inspectorOverlay} fill onClose={() => setReference(null)}>
          {conversationPanel}
        </ReferencePanel>
      )}
      {SESSION_REFERENCES.includes(reference as ViewId) && (
        <ReferencePanel
          key={`reference:${live.runtime?.sessionId ?? "loading"}`}
          reference={reference as ViewId}
          overlay={inspectorOverlay}
          fill={reference === "notes"}
          onClose={() => setReference(null)}>
          <SessionReference
            view={reference as ViewId}
            live={live}
            timelineEnabled={timelineEnabled}
            memoryReviewerConfigured={memoryReviewerConfigured}
            memoryEnabled={memoryEnabled}
            papercutEnabled={papercutEnabled}
            onOpenGlobalPolicy={() => {
              setReference(null);
              showSettings({ tab: "policy" });
            }}
            onOpenMemoryReviewerSettings={() => {
              setReference(null);
              showSettings({ packageQuery: "continuity" });
            }}
          />
        </ReferencePanel>
      )}
      {reference === "agents" && (
        <AgentPanel
          key={`agents:${live.runtime?.sessionId ?? "loading"}`}
          runs={live.runtime?.conversation.delegatedRuns ?? []}
          models={live.runtime?.sessionControls.models ?? []}
          colors={agentColors}
          selectedId={selectedAgentId}
          onSelect={setSelectedAgentId}
          onClose={() => setReference(null)}
        />
      )}
      {reference === "compaction" && selectedCompaction && selectedCompaction.sessionId === live.runtime?.sessionId && (
        <CompactionPanel
          key={`compaction:${selectedCompaction.message.id}`}
          message={selectedCompaction.message}
          contextLimit={live.runtime?.metrics.contextLimit}
          onClose={() => setReference(null)}
        />
      )}
      {reference === "attachment" && selectedAttachment && selectedAttachment.sessionId === live.runtime?.sessionId && (
        <AttachmentPanel
          key={`attachment:${selectedAttachment.attachments[0]?.sourceEntryId ?? ""}`}
          attachments={selectedAttachment.attachments}
          index={selectedAttachment.index}
          onSelect={index => setSelectedAttachment(current => (current ? { ...current, index } : current))}
          onClose={() => setReference(null)}
        />
      )}
      {reference === "turn-diff" && selectedTurnDiff && selectedTurnDiff.sessionId === live.runtime?.sessionId && (
        <TurnDiffPanel
          key={`turn-diff:${selectedTurnDiff.entryId}`}
          entryId={selectedTurnDiff.entryId}
          files={selectedTurnDiff.files}
          onClose={() => setReference(null)}
        />
      )}
      {reference === "git" && <GitPanel key={`git:${live.runtime?.sessionId ?? "loading"}:${live.runtime?.sessionGeneration ?? 0}`} live={live} git={git}
        onClose={() => setReference(null)} onReview={openGitReview} onOpenFile={openGitFile}
        onApply={live.runtime?.workspace?.canApplyChanges ? () => {
          setApplyRequest({ sessionId: live.runtime!.sessionId, revision: live.runtime!.workspace!.revision! });
          reviewChanges();
        } : undefined}
        onHandoff={live.runtime?.workspace?.canMoveToWorktree ? () => { void runtimeStore.handoffSession("worktree").catch(error => reportError(error, "Could not move to worktree")); } : undefined}
        onCheckout={live.runtime?.workspace?.mode === "local" ? branch => {
          setSidebarAction({ key: `git-checkout-${branch}`, title: "Switch branch?", description: `Switch this Local workspace to ${branch}. Git will refuse to overwrite conflicting local work.`, confirmLabel: "Switch branch", busyLabel: "Switching…", onConfirm: () => {
            void runtimeStore.checkoutBranch(branch).then(() => setSidebarAction(undefined)).catch(error => reportError(error, "Could not switch branch"));
          } });
        } : undefined} />}
      {reference === "changes" && (
        <FilesPanel
          key={`files:${live.runtime?.sessionId ?? "loading"}`}
          live={live}
          projectId={activeSession?.projectId}
          requestedPath={requestedFile}
          applyRequest={applyRequest}
          onApplyRequestHandled={() => setApplyRequest(undefined)}
          onClose={() => setReference(null)}
          onExpand={(path, fileView) => {
            if (path)
              setRequestedFile({ path, view: fileView, sessionId: live.runtime?.sessionId, requestId: Date.now() });
            setReference(null);
            changeSurface("files");
          }}
          onError={reportError}
        />
      )}
    </DeferredPanel>
  );

  const terminalChrome = (
    <>
      {terminalOpen && !mobile && (
        <TerminalResizer
          container={appShellRef}
          height={terminalDrawerHeight}
          onCommit={height => {
            setTerminalDrawerHeight(height);
            rememberSetting(TERMINAL_HEIGHT_KEY, height);
          }}
        />
      )}
      {retainedTerminals.map(terminal => (
        <TerminalPanel
          key={`terminal:${terminal.sessionId}`}
          open={terminalOpen && terminalSessionId === terminal.sessionId}
          generation={terminal.generation}
          cwdLabel={terminal.cwdLabel}
          onClose={() => setTerminalOpen(false)}
          onShutdown={() => {
            releaseTerminal(terminal.sessionId);
            closeTerminal();
          }}
        />
      ))}
    </>
  );

  return (
    <AnnotationProvider sessionId={live.runtime?.sessionId ?? ""} generation={live.runtime?.sessionGeneration ?? 0} onOpen={() => setReference("notes")}>
    {git.confirmation && <DeferredPanel><GitDialogs git={git} /></DeferredPanel>}
    <div
      ref={appShellRef}
      className={`app-shell has-scope-rail has-session-strip ${
        sidebarCollapsed ? "sidebar-collapsed" : ""
      }${shellModeClass ? ` ${shellModeClass}` : ""}`}
      style={
        {
          "--sidebar-width": `${leftPanelWidth}px`,
          "--terminal-height": terminalOpen ? `${terminalDrawerHeight}px` : "0px",
        } as CSSProperties
      }>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <ScopeRail
        workspaceView={workspaceView}
        theme={resolvedTheme}
        terminalOpen={terminalOpen}
        terminalAvailable={Boolean(live.runtime?.ready && live.runtime.projectAvailable !== false)}
        onWorkspaceView={openWorkspaceView}
        onAmbient={runAmbient}
      />
      {/* The bar's leading segment: it claims the cell above the panel, so the
          strip's rule runs unbroken and the corner is not a hole in Files, where
          the explorer sits a row lower than the session list does. Kept beside
          the strip rather than inside it so the strip still measures only the
          width its tabs actually get. The version is the changelog's handle —
          the one place the build number is worth being, and worth clicking. */}
      <button
        className="session-workspace-lead"
        type="button"
        onClick={() => setChangelogOpen(true)}
        title={`Pylon v${version} — what's new`}>
        Pylon
        <small>v{version}</small>
      </button>
      <ActiveSessionStrip
        sessions={activeSessions}
        unseenCompletions={live.unseenCompletions}
        selectedId={pendingSession ? undefined : live.runtime?.sessionId}
        pendingLabel={pendingSession?.project.label}
        busy={Boolean(sessionBusy || sessionDeleting || projectBusy)}
        busySessionId={sessionBusy}
        deletingSessionId={sessionDeleting}
        onSelect={session => void switchSession(session)}
        onDelete={requestDeleteSession}
        onRename={requestRenameSession}
        onArchive={session => void archiveSession(session)}
        onSetActive={(session, active) => void setSessionActive(session, active)}
        onSetPinned={(session, pinned) => void setSessionPinned(session, pinned)}
        onNew={() => {
          if (!currentProject) return;
          changeSurface("chat");
          void newSession(currentProject);
        }}
      />
      {sidebarVisible && (
        <SessionSidebar
          activeSessions={activeSessions}
          unseenCompletions={live.unseenCompletions}
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
          onShowFiles={
            surface === "files"
              ? () => {
                  setFileNavigation("explorer");
                  if (mobile) setSidebarOpen(false);
                }
              : undefined
          }
          onQuery={setQuery}
          onToggleProject={projectId =>
            setExpandedProjects(current => {
              const next = new Set(current);
              if (next.has(projectId)) next.delete(projectId);
              else next.add(projectId);
              return next;
            })
          }
          onSelectSession={session => void switchSession(session)}
          onDeleteSession={requestDeleteSession}
          onRenameSession={requestRenameSession}
          onSetSessionActive={(session, active) => void setSessionActive(session, active)}
          onSetSessionPinned={(session, pinned) => void setSessionPinned(session, pinned)}
          onLoadMore={project => void loadMoreSessions(project)}
          onShowLess={project => void showLessSessions(project)}
          onAddProject={() => void addProject()}
          general={general}
          onOpenArchives={() => {
            setArchivesOpen(true);
            if (mobile) setSidebarOpen(false);
          }}
          onArchiveProject={project => void archiveProject(project)}
          onRenameProject={project =>
            setSidebarAction({
              key: `rename-project-${project.id}`,
              title: "Rename project",
              description: "This changes only the project name shown in Pylon. Folder name and files stay unchanged.",
              confirmLabel: "Save name",
              busyLabel: "Saving…",
              inputLabel: "Project name",
              initialValue: project.label,
              onConfirm: value => void renameProject(project, value),
            })
          }
          onRemoveProject={project => {
            const count =
              sessionPages.find(candidate => candidate.id === project.id)?.totalCount ?? project.sessions.length;
            setSidebarAction({
              key: `remove-project-${project.id}`,
              title: `Remove “${project.label}”?`,
              description: `This deletes ${count} saved session${count === 1 ? "" : "s"}. Project files and Continuity memory stay unchanged.`,
              confirmLabel: "Remove project",
              busyLabel: "Removing…",
              danger: true,
              onConfirm: () => void removeProject(project),
            });
          }}
          onArchiveSession={session => void archiveSession(session)}
          onNewSession={project => {
            const unfiltered = projects.find(candidate => candidate.id === project.id);
            if (unfiltered) void newSession(unfiltered);
          }}
          onNewGeneral={() => {
            if (general) void newSession(general);
          }}
          onWorktreeSetup={project =>
            setSidebarAction({
              key: `worktree-setup-${project.id}`,
              title: `Worktree setup for ${project.label}`,
              description: "This command runs once after Pylon creates a new isolated worktree.",
              confirmLabel: "Save setup",
              busyLabel: "Saving…",
              inputLabel: "Setup command",
              multiline: true,
              maxLength: 2_000,
              allowEmpty: true,
              onConfirm: value => void updateWorktreeSetup(project, value),
            })
          }
          onReorderProject={(projectId, beforeProjectId) =>
            runtimeStore.reorderProject(projectId, beforeProjectId).catch(cause => {
              reportError(cause, "Unable to reorder project");
              throw cause;
            })
          }
          onReorderActiveSession={(sessionId, beforeSessionId) =>
            runtimeStore.reorderActiveSession(sessionId, beforeSessionId).catch(cause => {
              reportError(cause, "Unable to reorder active session");
              throw cause;
            })
          }
        />
      )}
      {!mobile && !sidebarCollapsed && (
        <SidebarResizer
          container={appShellRef}
          width={leftPanelWidth}
          onCommit={width => {
            setLeftPanelWidth(width);
            rememberSetting(LEFT_PANEL_WIDTH_KEY, width);
          }}
        />
      )}
      {mobile && sidebarOpen && sidebarVisible && (
        <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />
      )}

      {/* A workspace view replaces the session column entirely; the strip
          above stays, so the session you left is one click away. Otherwise
          the surface decides which shell fills the main area — Files brings
          its own, everything else uses the card. */}
      {workspaceView ? (
        <main className="content-card is-workspace-view" id="main-content">
          <WorkspaceViewHeader view={workspaceView} onClose={() => setWorkspaceView(null)} />
          <div className="workspace-view-body">
            {workspaceView === "usage" && (
              <DeferredPanel>
                <UsageView onSelectSession={id => void switchSession({ id, active: live.runtime?.sessionId === id })} />
              </DeferredPanel>
            )}
          </div>
        </main>
      ) : surface !== "files" ? (
        <main className="content-card" id="main-content">
          {topbar}
          {(toast || live.connection === "disconnected" || live.recovery) && (
            <div className="app-toast-stack">
              {live.connection === "disconnected" && !live.recovery && (
                <div className="app-connection-toast" role="status">
                  Disconnected. Waiting to reconnect…
                </div>
              )}
              {live.recovery && (
                <RecoveryToast
                  recovery={live.recovery}
                  onAction={() => {
                    if (live.recovery?.action === "reload") window.location.reload();
                    else runtimeStore.retryBootstrap();
                  }}
                />
              )}
              {toast && <ErrorToast key={toast.id} message={toast.message} onClose={() => setToast(undefined)} />}
            </div>
          )}
          <div
            ref={workspaceRef}
            className={`workspace-layout ${reference ? "has-inspector" : ""}${pendingSession ? " is-session-pending" : ""}`}
            style={
              {
                "--inspector-width": `${rightPanelWidth}px`,
                ...(referenceDefinition(reference)?.tone
                  ? { "--rail-tone": referenceDefinition(reference)?.tone }
                  : {}),
              } as CSSProperties
            }>
            {surface === "chat" ? conversationPanel : <DeferredPanel key={surface}>{surfaceMain}</DeferredPanel>}
            {sidePanel}
            {referenceRail}
          </div>
          {(sessionTransition || packageBusy) && (
            <div className="session-transition" role="status">
              <span className="status-orb success" />
              {packageBusy ? "Reloading packages..." : "Changing session..."}
            </div>
          )}
        </main>
      ) : (
        <DeferredPanel>
        <FileWorkspace
          live={live}
          projectId={activeSession?.projectId}
          requestedPath={requestedFile}
          stateStore={fileWorkspaceStates}
          contentStore={fileWorkspaceContents}
          header={topbar}
          workspaceRef={workspaceRef}
          sidePanel={
            <>
              {sidePanel}
              {referenceRail}
            </>
          }
          rightPanelOpen={Boolean(reference)}
          inspectorWidth={rightPanelWidth}
          showExplorer={fileNavigation === "explorer" && (mobile || !sidebarCollapsed)}
          navigationOpen={sidebarOpen}
          mobile={mobile}
          onCloseNavigation={() => setSidebarOpen(false)}
          onSessions={() => {
            setFileNavigation("sessions");
            setSidebarCollapsed(false);
            if (mobile) setSidebarOpen(true);
          }}
          onError={reportError}
        />
        </DeferredPanel>
      )}
      <div className="terminal-layer"><DeferredPanel>{terminalChrome}</DeferredPanel></div>
      <SearchPopup live={live} onError={reportError}
        onOpen={(path, line) => {
          setRequestedFile({ path, line, view: "current", sessionId: live.runtime?.sessionId, requestId: Date.now() });
          changeSurface("files");
        }}
        actions={[
          { id: "files", label: "Open workspace files", run: () => changeSurface("files") },
          ...KEY_COMMANDS.filter(command => command.scope === "global" && !["find-file", "find-text", "find-symbol", "last-tab"].includes(command.id)).map(command => ({
            id: command.id, label: command.label, shortcut: shortcutLabel(command.id), disabled: !keyboardHandlers[command.id],
            run: () => { const result = keyboardHandlers[command.id]?.(); return result instanceof Promise ? result : undefined; },
          })),
        ]} />

      {sidebarAction && (
        <ActionDialog
          key={sidebarAction.key}
          title={sidebarAction.title}
          description={sidebarAction.description}
          confirmLabel={sidebarAction.confirmLabel}
          busyLabel={sidebarAction.busyLabel}
          busy={Boolean(sessionBusy || sessionDeleting || projectBusy)}
          danger={sidebarAction.danger}
          inputLabel={sidebarAction.inputLabel}
          initialValue={sidebarAction.initialValue}
          multiline={sidebarAction.multiline}
          maxLength={sidebarAction.maxLength}
          allowEmpty={sidebarAction.allowEmpty}
          onCancel={() => setSidebarAction(undefined)}
          onConfirm={sidebarAction.onConfirm}
        />
      )}
      {changelogOpen && <DeferredPanel><ChangelogDialog onClose={() => setChangelogOpen(false)} /></DeferredPanel>}
      {archivesOpen && (
        <DeferredPanel>
        <ArchiveDialog
          revision={live.sessionRevision ?? 0}
          onClose={() => setArchivesOpen(false)}
          onError={reportError}
        />
        </DeferredPanel>
      )}
      {settings && (
        <DeferredPanel>
        <SettingsDialog
          initialTab={settings.tab}
          initialProviderQuery={settings.providerQuery}
          initialPackageQuery={settings.packageQuery}
          providerAuth={live.runtime?.providerAuth}
          pendingUi={live.pendingUi}
          packages={packages}
          projects={projects.map(({ id, label }) => ({ id, label }))}
          extensions={extensions}
          skills={skills}
          hookSettings={hookSettings}
          runtimePolicy={live.runtime?.runtimePolicy}
          toolPolicies={live.runtime?.operational.tools.policies ?? []}
          policyDisabled={
            live.connection !== "connected" ||
            live.runtime?.ready !== true ||
            Boolean(live.pendingUi) ||
            activeSessions.some(session => session.runtimeState === "running" || session.runtimeState === "attention")
          }
          loading={packagesLoading}
          extensionLoading={extensionsLoading}
          skillLoading={skillsLoading}
          hookLoading={hooksLoading}
          busy={packageBusy}
          extensionBusy={Boolean(extensionBusy)}
          hookBusy={hooksBusy}
          androidTooling={androidTooling}
          androidToolingBusy={androidToolingBusy}
          onAndroidTooling={manageAndroidTooling}
          providerLogoutDisabled={activeSessions.some(
            session => session.runtimeState === "running" || session.runtimeState === "attention",
          )}
          models={live.runtime?.sessionControls.models ?? []}
          modelRefreshBusy={modelRefreshBusy}
          modelRefreshDisabled={live.connection !== "connected" || live.runtime?.ready !== true}
          onRefreshModels={refreshModels}
          sessionThinkingLevels={live.runtime?.sessionControls.thinkingLevels ?? []}
          theme={theme}
          onThemeChange={setTheme}
          syntaxTheme={syntaxTheme}
          onSyntaxThemeChange={setSyntaxTheme}
          onClose={() => {
            if (live.runtime?.providerAuth?.flow?.status === "running") void runtimeStore.cancelProviderLogin();
            closeSettings();
          }}
          onProviderLogin={(provider, authType) => void runtimeStore.startProviderLogin(provider, authType)}
          onProviderLogout={provider => void runtimeStore.logoutProvider(provider)}
          onProviderCancel={() => void runtimeStore.cancelProviderLogin()}
          onSetEnabled={(item, enabled) => void setPackageEnabled(item, enabled)}
          onUpdate={(item, settings) => void updatePackageSettings(item, settings)}
          onToggleExtension={toggleExtension}
          onInstallExtensionPackage={installExtensionPackage}
          onRemoveExtensionPackage={removeExtensionPackage}
          onSetProjectTrust={setProjectTrust}
          onReloadExtensions={reloadExtensions}
          onUpdateHooks={updateHookSettings}
          onUpdateGlobalPolicy={(settings, expectedRevision) =>
            runtimeStore.updateRuntimePolicy(
              "global",
              "inherit",
              settings.timelineEnabled,
              settings.guardEnabled,
              settings.workspace,
              settings.guardTimeoutSeconds,
              settings.clarifyTimeoutSeconds,
              expectedRevision,
              settings.guardRules ?? DEFAULT_GUARD_RULES,
            )
          }
          onUpdateGlobalToolPolicy={(tool, mode, expectedRevision) =>
            runtimeStore.updateToolPolicy("global", tool, mode, expectedRevision)
          }
        />
        </DeferredPanel>
      )}
    </div>
    </AnnotationProvider>
  );
}

/** A failed optional chunk must not take down the conversation or its drafts. */
class DeferredPanel extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { console.error("Optional panel failed to load", error); }
  render() {
    if (this.state.failed) return <div className="conversation-state" role="alert">This panel could not be loaded. Reload the page to retry.</div>;
    return <Suspense fallback={<div className="conversation-state" role="status">Loading…</div>}>{this.props.children}</Suspense>;
  }
}

function TerminalResizer({
  container,
  height,
  onCommit,
}: {
  container: React.RefObject<HTMLDivElement | null>;
  height: number;
  onCommit: (height: number) => void;
}) {
  const resize = (clientY: number) => {
    const next = terminalHeight(window.innerHeight - clientY - 7);
    container.current?.style.setProperty("--terminal-height", `${next}px`);
    return next;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    let next = height;
    const move = (moveEvent: PointerEvent) => {
      next = resize(moveEvent.clientY);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    const up = () => {
      cleanup();
      onCommit(next);
    };
    const cancel = () => {
      cleanup();
      container.current?.style.setProperty("--terminal-height", `${height}px`);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };
  return (
    <div
      className="terminal-resizer"
      role="separator"
      aria-label="Resize terminal"
      aria-orientation="horizontal"
      aria-valuemin={160}
      aria-valuemax={Math.floor(window.innerHeight * 0.7)}
      aria-valuenow={height}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={event => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const next = terminalHeight(height + (event.key === "ArrowUp" ? 16 : -16));
        container.current?.style.setProperty("--terminal-height", `${next}px`);
        onCommit(next);
      }}
    />
  );
}

function PanelResizer({
  container,
  width,
  onCommit,
}: {
  container: React.RefObject<HTMLDivElement | null>;
  width: number;
  onCommit: (width: number) => void;
}) {
  const resize = (clientX: number) => {
    const panelRight =
      container.current?.querySelector<HTMLElement>(":scope > .inspector")?.getBoundingClientRect().right ??
      window.innerWidth;
    const next = clampPanelWidth(panelRight - clientX);
    container.current?.style.setProperty("--inspector-width", `${next}px`);
    return next;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 680) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    let next = width;
    const move = (moveEvent: PointerEvent) => {
      next = resize(moveEvent.clientX);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    const up = () => {
      cleanup();
      onCommit(next);
    };
    const cancel = () => {
      cleanup();
      container.current?.style.setProperty("--inspector-width", `${width}px`);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };
  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-label="Resize details panel"
      aria-orientation="vertical"
      aria-valuemin={300}
      aria-valuemax={window.innerWidth}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = clampPanelWidth(width + (event.key === "ArrowLeft" ? 16 : -16));
        container.current?.style.setProperty("--inspector-width", `${next}px`);
        onCommit(next);
      }}
    />
  );
}

function SidebarResizer({
  container,
  width,
  onCommit,
}: {
  container: React.RefObject<HTMLDivElement | null>;
  width: number;
  onCommit: (width: number) => void;
}) {
  const resize = (value: number) => {
    const next = leftPanelWidth(value);
    container.current?.style.setProperty("--sidebar-width", `${next}px`);
    return next;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // The shell eases grid-template-columns for the collapse toggle; during a drag
    // that easing lags the pointer, so it is suspended for the length of the drag.
    container.current?.classList.add("is-resizing");
    // Track the pointer delta: the sidebar's left edge is not always at x = 0 (the scope rail sits before it).
    const startX = event.clientX;
    let next = width;
    const move = (moveEvent: PointerEvent) => {
      next = resize(width + moveEvent.clientX - startX);
    };
    const up = () => {
      cleanup();
      onCommit(next);
    };
    const cancel = () => {
      cleanup();
      container.current?.style.setProperty("--sidebar-width", `${width}px`);
    };
    const cleanup = () => {
      container.current?.classList.remove("is-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };
  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-label="Resize navigation"
      aria-orientation="vertical"
      aria-valuemin={220}
      aria-valuemax={Math.floor(Math.min(520, window.innerWidth * 0.45))}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = leftPanelWidth(width + (event.key === "ArrowRight" ? 16 : -16));
        container.current?.style.setProperty("--sidebar-width", `${next}px`);
        onCommit(next);
      }}
    />
  );
}

function ErrorToast({ message, onClose }: { message: string; onClose: () => void }) {
  const [exiting, setExiting] = useState(false);
  const close = () => {
    if (exiting) return;
    setExiting(true);
    window.setTimeout(onClose, exitDelay(140));
  };
  useEffect(() => {
    const timer = window.setTimeout(close, 8_000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div className={`app-error-toast${exiting ? " is-exiting" : ""}`} role="alert">
      <span>{message}</span>
      <button type="button" onClick={close} aria-label="Dismiss error">
        <IconX size={15} />
      </button>
    </div>
  );
}

function RecoveryToast({
  recovery,
  onAction,
}: {
  recovery: NonNullable<RuntimeStoreSnapshot["recovery"]>;
  onAction: () => void;
}) {
  return (
    <div className="app-error-toast app-recovery-toast" role="alert">
      <span>{recovery.message}</span>
      <button className="text-button" type="button" onClick={onAction}>
        {recovery.action === "reload" ? "Reload" : "Retry"}
      </button>
    </div>
  );
}

function ActiveSessionStrip({
  sessions,
  unseenCompletions,
  selectedId,
  pendingLabel,
  busy,
  busySessionId,
  deletingSessionId,
  onSelect,
  onDelete,
  onArchive,
  onRename,
  onSetActive,
  onSetPinned,
  onNew,
}: {
  sessions: SessionSummary[];
  unseenCompletions?: Record<string, true>;
  selectedId?: string;
  pendingLabel?: string;
  busy: boolean;
  busySessionId: string;
  deletingSessionId: string;
  onSelect: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
  onArchive: (session: SessionSummary) => void;
  onRename: (session: SessionSummary) => void;
  onSetActive: (session: SessionSummary, active: boolean) => void;
  onSetPinned: (session: SessionSummary, pinned: boolean) => void;
  onNew: () => void;
}) {
  const stripRef = useRef<HTMLElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const overflowTrigger = useRef<HTMLButtonElement | null>(null);
  const [stripWidth, setStripWidth] = useState(0);
  const [menu, setMenu] = useState<{ sessionId: string; left: number }>();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const working = sessions.some(session => session.workStartedAt);
  const [now, setNow] = useState(() => Date.now());
  const capacity = activeSessionStripCapacity(stripWidth, sessions.length, Boolean(pendingLabel));
  const visibleSessions = activeSessionsForCapacity(sessions, selectedId, capacity);
  const visibleIds = new Set(visibleSessions.map(session => session.id));
  const overflowSessions = sessions.filter(session => !visibleIds.has(session.id));
  const menuSession = sessions.find(session => session.id === menu?.sessionId);

  useLayoutEffect(() => {
    const node = stripRef.current;
    if (!node) return;
    const update = () => setStripWidth(node.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), working ? 1_000 : 60_000);
    return () => window.clearInterval(interval);
  }, [working]);

  useEffect(() => {
    if (menu && !visibleIds.has(menu.sessionId)) setMenu(undefined);
    if (!overflowSessions.length) setOverflowOpen(false);
  }, [menu, overflowSessions.length, visibleSessions]);

  useEffect(() => {
    if (!menu && !overflowOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          ".active-session-options, .active-session-menu-popover, .active-session-overflow-button, .active-session-overflow-menu",
        )
      )
        return;
      setMenu(undefined);
      setOverflowOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menu) {
        setMenu(undefined);
        menuTrigger.current?.focus();
      } else {
        setOverflowOpen(false);
        overflowTrigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menu, overflowOpen]);

  const toggleMenu = (session: SessionSummary, trigger: HTMLButtonElement) => {
    menuTrigger.current = trigger;
    setOverflowOpen(false);
    if (menu?.sessionId === session.id) {
      setMenu(undefined);
      return;
    }
    const stripRect = stripRef.current?.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const menuWidth = 168;
    const maxLeft = Math.max(8, (stripRect?.width ?? window.innerWidth) - menuWidth - 8);
    setMenu({
      sessionId: session.id,
      left: Math.min(Math.max(triggerRect.right - (stripRect?.left ?? 0) - menuWidth, 8), maxLeft),
    });
  };
  const closeAndRun = (action: (session: SessionSummary) => void) => {
    if (!menuSession) return;
    setMenu(undefined);
    action(menuSession);
  };
  const copySessionId = () => {
    if (!menuSession) return;
    const id = menuSession.id;
    setMenu(undefined);
    setAnnouncement("");
    void copyText(id).then(copied => setAnnouncement(copied ? "Session ID copied" : "Copying session ID failed"));
  };
  const sleeping = menuSession?.runtimeState === "sleeping";

  return (
    <nav ref={stripRef} className="active-session-strip" aria-label="Active sessions">
      <div className="active-session-tabs">
        {visibleSessions.map(session => {
          const selected = session.id === selectedId;
          const completed = Boolean(unseenCompletions?.[session.id]);
          const activity = formatSessionActivity(session.modifiedAt, session.workStartedAt, now)
            .replace(/^Working for /, "")
            .replace(/ ago$/, "");
          const menuOpen = menu?.sessionId === session.id;
          /* A todo list left over from an earlier turn is not current progress, so the
             bar belongs only to the turn that is actively working on that list. */
          const progress = currentSessionProgress(session);
          const state = completed ? "complete" : session.runtimeState;
          const stateLabel = completed ? "New response" : session.runtimeState;
          return (
            <div
              key={session.id}
              data-session-id={session.id}
              className={`active-session-tab-shell${selected ? " is-active" : ""}`}>
              <button
                type="button"
                className={`active-session-tab${selected ? " is-active" : ""}`}
                disabled={busy}
                aria-current={selected ? "page" : undefined}
                onClick={() => {
                  setMenu(undefined);
                  onSelect(session);
                }}>
                {busySessionId === session.id || deletingSessionId === session.id ? (
                  <i
                    className="active-session-state status-orb success"
                    aria-label={deletingSessionId === session.id ? "Deleting" : "Updating"}
                  />
                ) : (
                  <i
                    className={`active-session-state session-runtime-state is-${state}`}
                    aria-label={stateLabel}
                    title={stateLabel}
                  />
                )}
                <span className="active-session-label">
                  <strong title={sessionTitle(session)}>{sessionTitle(session).slice(0, 50)}</strong>
                  <small>{session.cwdLabel} · {activity}</small>
                </span>
                <SessionProgress progress={progress} className="active-session-progress" />
              </button>
              <button
                className="active-session-options"
                type="button"
                aria-label={`More options for ${sessionTitle(session)}`}
                aria-expanded={menuOpen}
                aria-controls="active-session-options-menu"
                title="More options"
                onClick={event => toggleMenu(session, event.currentTarget)}>
                <IconDots size={15} />
              </button>
            </div>
          );
        })}
        {pendingLabel && (
          <button type="button" className="active-session-tab active-session-pending is-active" disabled>
            <span className="active-session-label">
              <strong>New session</strong>
              <small>{pendingLabel}</small>
            </span>
          </button>
        )}
      </div>
      {overflowSessions.length > 0 && (
        <button
          ref={overflowTrigger}
          className="active-session-overflow-button"
          type="button"
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          aria-controls="active-session-overflow-menu"
          title={`${overflowSessions.length} more active sessions`}
          onClick={() => {
            setMenu(undefined);
            setOverflowOpen(open => !open);
          }}>
          +{overflowSessions.length}
        </button>
      )}
      <button
        className="active-session-new"
        type="button"
        disabled={busy}
        onClick={onNew}
        aria-label="New session"
        title="New session">
        <IconPlus size={17} />
      </button>
      {overflowOpen && overflowSessions.length > 0 && (
        <div id="active-session-overflow-menu" className="active-session-overflow-menu" role="menu">
          {overflowSessions.map(session => {
            const completed = Boolean(unseenCompletions?.[session.id]);
            const state = completed ? "complete" : session.runtimeState;
            const activity = formatSessionActivity(session.modifiedAt, session.workStartedAt, now)
              .replace(/^Working for /, "")
              .replace(/ ago$/, "");
            return (
              <button
                key={session.id}
                role="menuitem"
                type="button"
                disabled={busy}
                onClick={() => {
                  setOverflowOpen(false);
                  onSelect(session);
                }}>
                <i className={`session-runtime-state is-${state}`} aria-hidden="true" />
                <strong>{sessionTitle(session)}</strong>
                <small>{session.cwdLabel} · {activity}</small>
              </button>
            );
          })}
        </div>
      )}
      {menuSession && (
        <div
          id="active-session-options-menu"
          className="session-menu-popover active-session-menu-popover"
          role="menu"
          style={{ left: menu?.left }}>
          <button role="menuitem" type="button" disabled={busy} onClick={() => closeAndRun(onRename)}>
            <IconPencil size={14} />
            Rename
          </button>
          <button role="menuitem" type="button" onClick={copySessionId}>
            <IconCopy size={14} />
            Copy session ID
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={busy}
            onClick={() => closeAndRun(session => onSetPinned(session, !session.pinned))}>
            <IconPin size={14} />
            {menuSession.pinned ? "Unpin" : "Pin"}
          </button>
          <button role="menuitem" type="button" disabled={busy} onClick={() => closeAndRun(onArchive)}>
            <IconArchive size={14} />
            Archive
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={busy || menuSession.pinned || (!sleeping && menuSession.runtimeState !== "idle")}
            title={
              menuSession.pinned
                ? "Unpin before deactivating"
                : !sleeping && menuSession.runtimeState !== "idle"
                  ? "Wait for the session to become idle before deactivating"
                  : undefined
            }
            onClick={() => closeAndRun(session => onSetActive(session, sleeping))}>
            <IconPower size={14} />
            {sleeping ? "Activate" : "Deactivate"}
          </button>
          <button
            role="menuitem"
            className="is-danger"
            type="button"
            disabled={busy || menuSession.active}
            title={menuSession.active ? "Active session cannot be deleted" : undefined}
            onClick={() => closeAndRun(onDelete)}>
            <IconTrash size={14} />
            Delete
          </button>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </nav>
  );
}

/** Matches --session-tab-width in styles.css; tabs never shrink below it. */
const ACTIVE_SESSION_TAB_WIDTH = 230;

function activeSessionStripCapacity(width: number, sessionCount: number, pending: boolean): number {
  if (!width) return sessionCount;
  const fixed = 34 + (pending ? ACTIVE_SESSION_TAB_WIDTH : 0);
  const withoutOverflow = Math.max(1, Math.floor((width - fixed) / ACTIVE_SESSION_TAB_WIDTH));
  if (sessionCount <= withoutOverflow) return sessionCount;
  return Math.max(1, Math.floor((width - fixed - 42) / ACTIVE_SESSION_TAB_WIDTH));
}

function activeSessionsForCapacity(
  sessions: SessionSummary[],
  selectedId: string | undefined,
  capacity: number,
): SessionSummary[] {
  if (sessions.length <= capacity) return sessions;
  const selectedIndex = selectedId ? sessions.findIndex(session => session.id === selectedId) : -1;
  if (selectedIndex < 0 || selectedIndex < capacity) return sessions.slice(0, capacity);
  return [...sessions.slice(0, Math.max(0, capacity - 1)), sessions[selectedIndex]!];
}

function WorkspaceViewHeader({ view, onClose }: { view: WorkspaceViewId; onClose: () => void }) {
  const definition = workspaceViewDefinition(view);
  if (!definition) return null;
  const Icon = definition.icon;
  return (
    <header className="workspace-view-head">
      <Icon size={17} />
      <strong>{definition.label}</strong>
      <span>every project in this workspace</span>
      <button className="icon-button" type="button" onClick={onClose} aria-label={`Close ${definition.label}`}>
        <IconX size={17} />
      </button>
    </header>
  );
}
