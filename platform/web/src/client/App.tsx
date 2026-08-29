import {
  IconArchive,
  IconBrandGit,
  IconCopy,
  IconGitBranch,
  IconDots,
  IconPencil,
  IconPin,
  IconPlus,
  IconPower,
  IconMenu2,
  IconMessageCircle,
  IconMoon,
  IconSun,
  IconX,
  IconTrash,
} from "@tabler/icons-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { FileReference } from "../shared/file-reference";
import { formatSessionActivity } from "../shared/format";
import { DEFAULT_GUARD_RULES } from "../shared/guard-policy";
import { GENERAL_PROJECT_ID } from "../shared/general-session";
import type {
  MessageAttachmentReadModel,
  MessageReadModel,
} from "../shared/protocol/events";
import type {
  HookSettingsReadModel,
  NativeExtensionReadModel,
  PackageSettingsReadModel,
  PackageSummary,
  SessionListSnapshot,
  SessionProjectPage,
  SessionSummary,
} from "../shared/protocol/snapshots";
import {
  listSessionsPreservingPages,
  SESSION_LIST_INITIAL_LIMIT,
  SESSION_LIST_MORE_LIMIT,
} from "../shared/session-list";
import { showSessionRuntimeState } from "../shared/session-completions";
import type { ComposerDraft } from "../shared/composer-drafts";
import { ActionDialog } from "./action-dialog";
import { AgentPanel } from "./agent-drawer";
import { AttachmentPanel } from "./attachment-panel";
import { useAgentColors } from "./agent-color";
import { copyText } from "./clipboard";
import { ArchiveDialog } from "./archive-dialog";
import {
  ConversationPanel,
  type ComposerSelection,
} from "./conversation-panel";
import { CompactionPanel } from "./compaction-panel";
import { BrowserPanel } from "./browser-panel";
import { DatabasePanel } from "./database-panel";
import { FilesPanel, type FileView } from "./files-panel";
import {
  FileWorkspace,
  type FileWorkspaceContentStore,
} from "./file-workspace";
import type { FileWorkspaceState } from "../shared/file-workspace-state";
import { Inspector, type ViewId } from "./inspector";
import {
  clampPanelWidth,
  initialPanelWidths,
  PANELS,
  panelDefinition,
  panelWidthSlot,
  WORKSPACE_MODES,
  workspaceModeDefinition,
  type PanelContext,
  type PanelId,
  type RightPanel,
  type WorkspaceModeId,
} from "./panels";
import { startsHeliosBrowser } from "../shared/browser-tool-activity";
import {
  runtimeStore,
  useRuntimeStore,
  type RuntimeStoreSnapshot,
} from "./runtime/event-store";
import {
  SessionSidebar,
  sessionTitle,
  type SessionProject,
} from "./session-sidebar";
import { SettingsDialog } from "./settings-dialog";
import { TerminalPanel } from "./terminal-panel";
import {
  runtimeRequestStillCurrent,
  useSessionCatalog,
} from "./use-session-catalog";
import { useComposerDrafts } from "./use-composer-drafts";
import {
  rememberSetting,
  readStoredNumber,
  useDocumentTitle,
  useTheme,
  type Theme,
} from "./use-chrome";
import { useSettingsDialog } from "./use-settings-dialog";
import {
  useMarkSessionSeen,
  useTerminalDrawer,
  type RetainedTerminal,
} from "./use-terminal-drawer";
import { enqueueWebAudioCues, unlockWebAudio } from "./web-audio";

type RequestedFile = FileReference & {
  requestId: number;
  sessionId?: string;
  view?: FileView;
};
type FileNavigation = "explorer" | "sessions";
type SelectedCompaction = { sessionId: string; message: MessageReadModel };
type SelectedAttachment = {
  sessionId: string;
  attachment: MessageAttachmentReadModel;
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

function leftPanelWidth(value: number): number {
  const maximum = Math.min(520, window.innerWidth * 0.45);
  return Math.round(Math.max(220, Math.min(maximum, value)));
}
function initialLeftPanelWidth(): number {
  return leftPanelWidth(
    readStoredNumber(LEFT_PANEL_WIDTH_KEY, DEFAULT_LEFT_PANEL_WIDTH),
  );
}
function terminalHeight(value: number): number {
  return Math.round(Math.max(160, Math.min(window.innerHeight * 0.7, value)));
}
function initialTerminalHeight(): number {
  return terminalHeight(
    readStoredNumber(TERMINAL_HEIGHT_KEY, DEFAULT_TERMINAL_HEIGHT),
  );
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
  const [view, setView] = useState<ViewId>("overview");
  const [theme, setTheme] = useTheme();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(initialLeftPanelWidth);
  const [rightPanel, setRightPanel] = useState<RightPanel>("inspector");
  const [panelWidths, setPanelWidths] = useState(initialPanelWidths);
  const [browserMirrorRequest, setBrowserMirrorRequest] = useState("");
  const [browserActive, setBrowserActive] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [requestedFile, setRequestedFile] = useState<RequestedFile>();
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceModeId>("chat");
  const [fileNavigation, setFileNavigation] =
    useState<FileNavigation>("explorer");
  const [selectedCompaction, setSelectedCompaction] =
    useState<SelectedCompaction>();
  const [selectedAttachment, setSelectedAttachment] =
    useState<SelectedAttachment>();
  const [sessionPages, setSessionPages] = useState<SessionProjectPage[]>([]);
  const [activeSessions, setActiveSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [archivesOpen, setArchivesOpen] = useState(false);
  const {
    settings,
    settingsOpen,
    openSettings: showSettings,
    closeSettings,
  } = useSettingsDialog();
  const [toast, setToast] = useState<{ id: number; message: string }>();
  const [sidebarAction, setSidebarAction] = useState<SidebarAction>();
  const [sessionBusy, setSessionBusy] = useState("");
  const [sessionTransition, setSessionTransition] = useState(false);
  const [pendingSession, setPendingSession] = useState<PendingSession>();
  const [composerFocusTarget, setComposerFocusTarget] = useState<string>();
  const [sessionDeleting, setSessionDeleting] = useState("");
  const [projectLoading, setProjectLoading] = useState("");
  const [projectBusy, setProjectBusy] = useState("");
  const [query, setQuery] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set(),
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const navigationToggleRef = useRef<HTMLButtonElement>(null);
  const panelToggles = useRef(new Map<PanelId, HTMLButtonElement>());
  const appShellRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const previousSidebarOpen = useRef(sidebarOpen);
  const previousRightPanel = useRef(rightPanel);
  const previousChatModePanel = useRef<RightPanel>(rightPanel);
  const browserToolSession = useRef<string | undefined>(undefined);
  const observedBrowserTools = useRef(new Set<string>());
  const sessionListRequest = useRef(0);
  const sessionListApplied = useRef(false);
  const sessionPagesRef = useRef<SessionProjectPage[]>([]);
  const sessionPagesQuery = useRef("");
  const pendingSessionRequest = useRef(0);
  const pendingSessionDraft = useRef("");
  const pendingSessionSelection = useRef<ComposerSelection | undefined>(
    undefined,
  );
  const pendingSessionInFlight = useRef(false);
  const fileWorkspaceStates = useRef(new Map<string, FileWorkspaceState>());
  const fileWorkspaceContents = useRef<FileWorkspaceContentStore>(new Map());
  const toastId = useRef(0);
  const lastError = useRef({ message: "", at: 0 });
  const mobile = useMediaQuery("(max-width: 900px)");
  const inspectorOverlay = useMediaQuery("(max-width: 1179px)");
  const live = useRuntimeStore();
  const agentColors = useAgentColors(
    live.runtime?.sessionId,
    live.runtime?.conversation.delegatedRuns ?? [],
  );
  const toSessionProject = (page: SessionProjectPage): SessionProject => ({
    id: page.id,
    label: page.label,
    cwd: page.cwd,
    sessions: page.sessions,
    active:
      activeSessions.some(
        (session) => session.projectId === page.id && session.active,
      ) || page.sessions.some((session) => session.active),
  });
  const projects = useMemo<SessionProject[]>(
    () =>
      sessionPages
        .filter((page) => page.id !== GENERAL_PROJECT_ID)
        .map(toSessionProject),
    [activeSessions, sessionPages],
  );
  const general = useMemo<SessionProject | undefined>(() => {
    const page = sessionPages.find(
      (candidate) => candidate.id === GENERAL_PROJECT_ID,
    );
    return page ? toSessionProject(page) : undefined;
  }, [activeSessions, sessionPages]);
  const reportError = (cause: unknown, fallback: string) => {
    const message = cause instanceof Error ? cause.message : fallback;
    if (
      /session changed while listing sessions|session list is stale/i.test(
        message,
      )
    )
      return;
    const now = Date.now();
    if (
      lastError.current.message === message &&
      now - lastError.current.at < 100
    )
      return;
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

  const sessions = useMemo(
    () => sessionPages.flatMap((page) => page.sessions),
    [sessionPages],
  );
  const activeSession =
    activeSessions.find((session) => session.active) ??
    sessions.find((session) => session.active);
  const activePackages = useMemo(
    () =>
      new Set(packages.filter((item) => item.active).map((item) => item.id)),
    [packages],
  );
  const browserAvailable = activePackages.has("pi-helios");
  const browserToolRevision = useMemo(
    () =>
      (live.runtime?.conversation.tools ?? [])
        .filter((tool) => tool.name === "helios_browser")
        .map((tool) => `${tool.id}:${tool.status}`)
        .join("|"),
    [live.runtime?.conversation.tools],
  );
  const timelinePackageAvailable =
    activePackages.has("pi-timeline") ||
    live.runtime?.operational.timeline.availability === "available";
  const timelineEnabled =
    timelinePackageAvailable &&
    (live.runtime?.runtimePolicy.effective.timelineEnabled ?? true);
  const memoryEnabled =
    activePackages.has("pi-continuity") ||
    live.runtime?.operational.continuity.availability === "available";
  const papercutEnabled =
    activePackages.has("pi-papercut") ||
    live.runtime?.operational.papercuts.availability === "available";
  const continuitySettings = packages.find(
    (item) => item.id === "pi-continuity",
  )?.settings;
  const memoryReviewerConfigured =
    !packagesLoading && continuitySettings?.kind === "continuity"
      ? Boolean(continuitySettings.memoryReviewer?.model)
      : undefined;
  const stateqlEnabled = activePackages.has("pi-stateql");
  const panelContext = useMemo<PanelContext>(
    () => ({ workspaceMode, stateqlEnabled, browserAvailable, browserActive }),
    [workspaceMode, stateqlEnabled, browserAvailable, browserActive],
  );
  const rightPanelWidth = panelWidths[panelWidthSlot(rightPanel).key];
  const shellModeClass = workspaceModeDefinition(workspaceMode).shellClass;
  const availableViews = useMemo(
    () =>
      new Set<ViewId>([
        "overview",
        "policy",
        ...(timelineEnabled ? ["timeline" as const] : []),
        ...(memoryEnabled || papercutEnabled ? ["memory" as const] : []),
        "tools",
      ]),
    [memoryEnabled, papercutEnabled, timelineEnabled],
  );
  const updateSessionPages = (
    update: (pages: SessionProjectPage[]) => SessionProjectPage[],
  ) => {
    setSessionPages((current) => {
      const next = update(current);
      sessionPagesRef.current = next;
      return next;
    });
  };
  const applySessionList = (
    result: SessionListSnapshot,
    appliedQuery = query.trim(),
  ) => {
    let draftsChanged = false;
    for (const project of result.projects) {
      for (const session of project.sessions)
        draftsChanged =
          composerDrafts.rememberProject(session) || draftsChanged;
    }
    for (const session of result.activeSessions)
      draftsChanged = composerDrafts.rememberProject(session) || draftsChanged;
    if (draftsChanged) composerDrafts.persist();
    sessionPagesRef.current = result.projects;
    sessionPagesQuery.current = appliedQuery;
    setSessionPages(result.projects);
    setActiveSessions(result.activeSessions);
    const firstList = !query.trim() && !sessionListApplied.current;
    if (!query.trim()) sessionListApplied.current = true;
    const projectId =
      result.activeSessions.find((session) => session.active)?.projectId ??
      result.projects.find((page) =>
        page.sessions.some((session) => session.active),
      )?.id;
    if (firstList && !query.trim() && projectId)
      setExpandedProjects((current) => new Set([...current, projectId]));
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
    enqueueWebAudioCues(live.audioCues.map((cue) => cue.kind));
    runtimeStore.consumeAudioCues(live.audioCues.map((cue) => cue.id));
  }, [live.audioCues]);

  useDocumentTitle(live.runtime?.extensionUi.title);
  useEffect(() => {
    setSelectedAgentId(undefined);
    setSelectedCompaction(undefined);
    setSelectedAttachment(undefined);
    setRightPanel((current) =>
      current === "compaction" || current === "attachment" ? null : current,
    );
    setBrowserActive(false);
  }, [live.runtime?.sessionId]);
  useEffect(() => {
    if (
      live.connection !== "connected" ||
      !live.runtime?.ready ||
      !browserAvailable
    ) {
      setBrowserActive(false);
      return;
    }
    let current = true;
    const sessionId = live.runtime.sessionId;
    const generation = live.runtime.sessionGeneration;
    void runtimeStore
      .heliosBrowser({ action: "status" })
      .then((result) => {
        if (
          current &&
          runtimeRequestStillCurrent(
            runtimeStore.getSnapshot(),
            sessionId,
            generation,
          )
        )
          setBrowserActive(result.active);
      })
      .catch(() => undefined);
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
      observedBrowserTools.current = new Set(tools.map((tool) => tool.id));
      const runningStart = [...tools]
        .reverse()
        .find((tool) => tool.status === "running" && startsHeliosBrowser(tool));
      setBrowserMirrorRequest(
        runningStart ? `${sessionId}:${runningStart.id}` : "",
      );
      if (runningStart) {
        setSidebarOpen(false);
        setRightPanel("browser");
      }
      return;
    }
    const start = [...tools]
      .reverse()
      .find(
        (tool) =>
          tool.status !== "failed" &&
          !observedBrowserTools.current.has(tool.id) &&
          startsHeliosBrowser(tool),
      );
    for (const tool of tools) observedBrowserTools.current.add(tool.id);
    if (!start) return;
    setBrowserMirrorRequest(`${sessionId}:${start.id}`);
    setSidebarOpen(false);
    setRightPanel("browser");
  }, [live.runtime?.sessionId, live.runtime?.conversation.tools]);

  useEffect(() => {
    if (mobile && previousSidebarOpen.current && !sidebarOpen)
      navigationToggleRef.current?.focus();
    previousSidebarOpen.current = sidebarOpen;
  }, [mobile, sidebarOpen]);

  useEffect(() => {
    const closed = previousRightPanel.current;
    previousRightPanel.current = rightPanel;
    if (!closed || rightPanel) return;
    // Topbar panels return focus to their own button, never to another panel's.
    if (panelDefinition(closed)) {
      panelToggles.current.get(closed)?.focus();
      return;
    }
    // Panels opened from the conversation have no button of their own.
    if (closed === "attachment") selectedAttachment?.trigger.focus();
    else panelToggles.current.get("inspector")?.focus();
  }, [rightPanel]);

  useLayoutEffect(() => {
    const drawer = workspaceRef.current?.querySelector<HTMLElement>(
      ":scope > .inspector",
    );
    if (!drawer) return;
    drawer.inert = Boolean(pendingSession);
    return () => {
      drawer.inert = false;
    };
  }, [Boolean(pendingSession), rightPanel, live.runtime?.sessionId]);

  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      const reference =
        typeof detail === "string"
          ? { path: detail }
          : detail &&
              typeof detail === "object" &&
              typeof (detail as FileReference).path === "string"
            ? (detail as FileReference & { view?: "current" | "diff" })
            : undefined;
      if (!reference) return;
      setRequestedFile({
        ...reference,
        sessionId: runtimeStore.getSnapshot().runtime?.sessionId,
        requestId: Date.now(),
      });
      if (workspaceMode !== "files") setRightPanel("files");
    };
    window.addEventListener("pylon:open-file", open);
    return () => window.removeEventListener("pylon:open-file", open);
  }, [workspaceMode]);

  useEffect(() => {
    if (live.connection !== "connected" || !live.runtime?.ready) return;
    let active = true;
    const controller = new AbortController();
    const request = ++sessionListRequest.current;
    const sessionId = live.runtime.sessionId;
    const sessionGeneration = live.runtime.sessionGeneration;
    const requestQuery = query.trim();
    const previousPages =
      sessionPagesQuery.current === requestQuery ? sessionPagesRef.current : [];
    setSessionsLoading(true);
    const timer = window.setTimeout(
      () =>
        void listSessionsPreservingPages(
          (input, signal) => runtimeStore.listSessions(input, signal),
          previousPages,
          requestQuery,
          controller.signal,
        )
          .then((result) => {
            if (
              !active ||
              request !== sessionListRequest.current ||
              !runtimeRequestStillCurrent(
                runtimeStore.getSnapshot(),
                sessionId,
                sessionGeneration,
              )
            )
              return;
            applySessionList(result, requestQuery);
          })
          .catch((cause) => {
            if (
              active &&
              request === sessionListRequest.current &&
              runtimeRequestStillCurrent(
                runtimeStore.getSnapshot(),
                sessionId,
                sessionGeneration,
              )
            ) {
              reportError(cause, "Unable to list sessions");
            }
          })
          .finally(() => {
            if (active && request === sessionListRequest.current)
              setSessionsLoading(false);
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
    live.runtime?.ready,
    live.runtime?.sessionId,
    live.runtime?.sessionGeneration,
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
    if (
      !pendingSession ||
      pendingSession.phase !== "preparing" ||
      pendingSession.expectedGeneration === undefined
    )
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
    composerDrafts.adopt(
      runtime.sessionId,
      pendingSession.project.id,
      draft,
      pendingSession.recoveredDraftSessionId,
    );
    if (
      document.activeElement instanceof HTMLTextAreaElement &&
      document.activeElement.id === "runtime-prompt"
    ) {
      pendingSessionSelection.current = {
        start: document.activeElement.selectionStart,
        end: document.activeElement.selectionEnd,
        direction: document.activeElement.selectionDirection,
      };
      setComposerFocusTarget(runtime.sessionId);
    }
    pendingSessionDraft.current = "";
    setPendingSession((current) =>
      current?.requestId === pendingSession.requestId ? undefined : current,
    );
    setSessionBusy("");
  }, [
    live.connection,
    live.runtime?.ready,
    live.runtime?.sessionId,
    live.runtime?.sessionGeneration,
    pendingSession,
  ]);

  useEffect(() => {
    if (!live.notificationRevision || !live.notification?.message) return;
    setToast({ id: ++toastId.current, message: live.notification.message });
  }, [live.notificationRevision]);

  useEffect(() => {
    if (!availableViews.has(view)) setView("overview");
  }, [availableViews, view]);

  useEffect(() => {
    const definition = panelDefinition(rightPanel);
    if (
      definition?.requiresPackage &&
      !definition.requiresPackage(panelContext)
    )
      setRightPanel(null);
  }, [rightPanel, panelContext]);

  useEffect(() => {
    if (!live.sessionStatuses && !live.sessionWorkStartedAts) return;
    const updateSession = (session: SessionSummary): SessionSummary => {
      const next = {
        ...session,
        runtimeState:
          live.sessionStatuses?.[session.id] ?? session.runtimeState,
      };
      const workStartedAt = live.sessionWorkStartedAts?.[session.id];
      if (workStartedAt === null) delete next.workStartedAt;
      else if (workStartedAt !== undefined) next.workStartedAt = workStartedAt;
      return next;
    };
    updateSessionPages((pages) =>
      pages.map((page) => ({
        ...page,
        sessions: page.sessions.map(updateSession),
      })),
    );
    setActiveSessions((sessions) =>
      sessions
        .map(updateSession)
        .filter((session) => session.runtimeState !== "sleeping"),
    );
  }, [live.sessionStatuses, live.sessionWorkStartedAts]);

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
      if (runtimeStore.getSnapshot().runtime?.sessionId !== parentId)
        await runtimeStore.switchSession(parentId);
      const run = [
        ...(runtimeStore.getSnapshot().runtime?.conversation.delegatedRuns ??
          []),
      ]
        .reverse()
        .find(
          (candidate) =>
            candidate.kind === "spawn_session" &&
            candidate.threadId === session.id,
        );
      if (!run) {
        try {
          await runtimeStore.switchSession(session.id);
          return;
        } catch {
          throw new Error(
            "Spawned session activity is not available yet. Try again.",
          );
        }
      }
      setSelectedAgentId(run.id);
      setRightPanel("agents");
    };
    setSessionBusy(session.id);
    setSessionTransition(
      !listedParentId || live.runtime?.sessionId !== listedParentId,
    );
    try {
      if (listedParentId) {
        await openParentActivity(listedParentId);
      } else {
        try {
          await runtimeStore.switchSession(session.id);
        } catch (cause) {
          const parentId =
            cause instanceof Error
              ? /currently running under its parent session \(([^)]+)\)/i.exec(
                  cause.message,
                )?.[1]
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
    if (
      pendingSessionInFlight.current ||
      sessionBusy ||
      sessionDeleting ||
      projectBusy
    )
      return;
    let recoveredDraft: ComposerDraft | undefined;
    if (!retry) {
      const draft = composerDrafts.latestForProject(project.id);
      if (draft && draft.sessionId === live.runtime?.sessionId) {
        setComposerFocusTarget(draft.sessionId);
        if (mobile) setSidebarOpen(false);
        return;
      }
      if (draft) {
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
    const requestId =
      retry && pendingSession
        ? pendingSession.requestId
        : ++pendingSessionRequest.current;
    if (!retry) {
      pendingSessionDraft.current = recoveredDraft?.text ?? "";
      pendingSessionSelection.current = undefined;
    }
    setPendingSession({
      requestId,
      project,
      previousSessionId: live.runtime?.sessionId,
      recoveredDraftSessionId: retry
        ? pendingSession?.recoveredDraftSessionId
        : recoveredDraft?.sessionId,
      phase: "preparing",
    });
    setTerminalOpen(false);
    setSessionBusy(project.id);
    let accepted = false;
    try {
      const expectedGeneration = await runtimeStore.newSession(project.id);
      accepted = true;
      setPendingSession((current) =>
        current?.requestId === requestId
          ? { ...current, expectedGeneration }
          : current,
      );
      if (mobile) setSidebarOpen(false);
    } catch (cause) {
      const error =
        cause instanceof Error ? cause.message : "Unable to create session";
      setPendingSession((current) =>
        current?.requestId === requestId
          ? { ...current, phase: "failed", error }
          : current,
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
      setActiveSessions((current) =>
        current.filter((candidate) => candidate.id !== session.id),
      );
      updateSessionPages((current) =>
        current
          .map((page) => ({
            ...page,
            totalCount:
              page.id === session.projectId
                ? Math.max(0, page.totalCount - 1)
                : page.totalCount,
            sessions: page.sessions.filter(
              (candidate) => candidate.id !== session.id,
            ),
          }))
          .filter((page) => page.totalCount > 0),
      );
      const request = ++sessionListRequest.current;
      try {
        const requestQuery = query.trim();
        const previousPages =
          sessionPagesQuery.current === requestQuery
            ? sessionPagesRef.current
            : [];
        const result = await listSessionsPreservingPages(
          (input, signal) => runtimeStore.listSessions(input, signal),
          previousPages,
          requestQuery,
        );
        if (request === sessionListRequest.current)
          applySessionList(result, requestQuery);
      } catch (cause) {
        reportError(
          cause instanceof Error
            ? new Error(`Session deleted, but refresh failed: ${cause.message}`)
            : cause,
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

  const updateWorktreeSetup = async (
    project: SessionProject,
    setupCommand: string,
  ) => {
    setProjectBusy(project.id);
    try {
      await runtimeStore.updateProjectWorktreeSettings(
        project.id,
        setupCommand,
      );
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
      const rename = (candidate: SessionSummary) =>
        candidate.id === session.id ? { ...candidate, name } : candidate;
      setActiveSessions((current) => current.map(rename));
      updateSessionPages((current) =>
        current.map((page) => ({
          ...page,
          sessions: page.sessions.map(rename),
        })),
      );
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
      updateSessionPages((current) =>
        current.map((page) =>
          page.id === project.id ? { ...page, label: name } : page,
        ),
      );
      setActiveSessions((current) =>
        current.map((session) =>
          session.projectId === project.id
            ? { ...session, cwdLabel: name }
            : session,
        ),
      );
      setSidebarAction(undefined);
    } catch (cause) {
      reportError(cause, "Unable to rename project");
    } finally {
      setProjectBusy("");
    }
  };

  const setSessionActive = async (session: SessionSummary, active: boolean) => {
    if (sessionBusy || sessionDeleting || (!active && session.active)) return;
    setSessionBusy(session.id);
    try {
      await runtimeStore.setSessionActive(session.id, active);
    } catch (cause) {
      reportError(
        cause,
        `Unable to ${active ? "activate" : "deactivate"} session`,
      );
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
    const current = sessionPages.find((page) => page.id === project.id);
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
        !runtimeRequestStillCurrent(
          runtimeStore.getSnapshot(),
          runtime.sessionId,
          runtime.sessionGeneration,
        )
      )
        return;
      setActiveSessions(result.activeSessions);
      const next = result.projects[0];
      if (!next) return;
      updateSessionPages((pages) =>
        pages.map((page) =>
          page.id === project.id
            ? {
                ...page,
                sessions: [
                  ...page.sessions,
                  ...next.sessions.filter(
                    (session) =>
                      !page.sessions.some((old) => old.id === session.id),
                  ),
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
    const current = sessionPages.find((page) => page.id === project.id);
    if (
      !current ||
      current.sessions.length <= SESSION_LIST_INITIAL_LIMIT ||
      projectLoading
    )
      return;
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
        !runtimeRequestStillCurrent(
          runtimeStore.getSnapshot(),
          runtime.sessionId,
          runtime.sessionGeneration,
        )
      )
        return;
      const next = result.projects[0];
      if (!next) return;
      setActiveSessions(result.activeSessions);
      updateSessionPages((pages) =>
        pages.map((page) => (page.id === project.id ? next : page)),
      );
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
      for (const session of project.sessions)
        composerDrafts.forgetInMemory(session.id);
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
    setRightPanel((current) => (current === panel ? null : panel));
  };

  const setPackageEnabled = async (item: PackageSummary, enabled: boolean) => {
    if (packageBusy) return;
    setPackageBusy(item.id);
    try {
      await runtimeStore.setPackageEnabled(item.id, enabled);
      setPackages((current) =>
        current.map((candidate) =>
          candidate.id === item.id ? { ...candidate, enabled } : candidate,
        ),
      );
    } catch (cause) {
      reportError(cause, "Unable to update package");
    } finally {
      setPackageBusy("");
    }
  };

  const updatePackageSettings = async (
    item: PackageSummary,
    settings: PackageSettingsReadModel,
  ) => {
    if (packageBusy) return;
    setPackageBusy(item.id);
    try {
      await runtimeStore.updatePackageSettings(item.id, settings);
      setPackages((current) =>
        current.map((candidate) =>
          candidate.id === item.id ? { ...candidate, settings } : candidate,
        ),
      );
    } catch (cause) {
      reportError(cause, `Unable to update ${item.name}`);
    } finally {
      setPackageBusy("");
    }
  };

  const refreshExtensions = async () =>
    setExtensions(await runtimeStore.listExtensions());
  const manageExtension = async (
    key: string,
    action: () => Promise<void>,
    failure: string,
  ) => {
    if (extensionBusy)
      throw new Error("Another extension operation is still running");
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
  const toggleExtension = (
    extension: NativeExtensionReadModel,
    enabled: boolean,
  ) =>
    manageExtension(
      extension.id,
      () => runtimeStore.setExtensionEnabled(extension.id, enabled),
      "Unable to update extension",
    );
  const installExtensionPackage = (source: string, scope: "user" | "project") =>
    manageExtension(
      `install:${source}`,
      () => runtimeStore.installExtensionPackage(source, scope),
      "Unable to install extension package",
    );
  const removeExtensionPackage = (source: string, scope: "user" | "project") =>
    manageExtension(
      `remove:${source}`,
      () => runtimeStore.removeExtensionPackage(source, scope),
      "Unable to remove extension package",
    );
  const setProjectTrust = (trusted: boolean) =>
    manageExtension(
      "trust",
      () => runtimeStore.setProjectTrust(trusted),
      "Unable to update project trust",
    );
  const reloadExtensions = () =>
    manageExtension(
      "reload",
      () => runtimeStore.reloadExtensions(),
      "Unable to reload extensions",
    );

  const manageAndroidTooling = async (
    action: "status" | "install" | "remove",
  ) => {
    if (androidToolingBusy)
      throw new Error("Another Android tooling operation is still running");
    if (action !== "status") setAndroidToolingBusy(action);
    try {
      const result = await runtimeStore.heliosAndroidTooling(
        action === "status" ? { action } : { action, confirmed: true },
      );
      setAndroidTooling(result);
    } catch (cause) {
      reportError(
        cause,
        `Unable to ${action === "install" ? "set up" : action} Android tooling`,
      );
      throw cause;
    } finally {
      if (action !== "status") setAndroidToolingBusy("");
    }
  };

  const updateHookSettings = async (settings: HookSettingsReadModel) => {
    if (hooksBusy)
      throw new Error("Another hook settings update is still saving");
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

  const currentProjectPage = sessionPages.find(
    (page) => page.id === activeSession?.projectId,
  );
  const currentProject = currentProjectPage
    ? toSessionProject(currentProjectPage)
    : (projects[0] ?? general);
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
      description:
        "This removes saved history. If system trash is unavailable, deletion is permanent.",
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
  const changeWorkspaceMode = (mode: WorkspaceModeId) => {
    const changingMode = mode !== workspaceMode;
    setWorkspaceMode(mode);
    setSidebarOpen(false);
    if (!changingMode) return;
    const wasDisplaced =
      workspaceModeDefinition(workspaceMode).displacesConversation;
    if (workspaceModeDefinition(mode).displacesConversation) {
      // Remember the panel the conversation displaced, but only the first time.
      if (!wasDisplaced) previousChatModePanel.current = rightPanel;
      setRightPanel("chat");
    } else if (rightPanel === "chat") {
      setRightPanel(previousChatModePanel.current);
    }
  };
  const topbar = (
    <Topbar
      live={live}
      session={activeSession}
      pendingSession={pendingSession}
      theme={theme}
      workspaceMode={workspaceMode}
      onWorkspaceMode={changeWorkspaceMode}
      onToggleTheme={() =>
        setTheme((current) => (current === "dark" ? "light" : "dark"))
      }
      menuOpen={mobile ? sidebarOpen : !sidebarCollapsed}
      rightPanel={rightPanel}
      panelContext={panelContext}
      menuButtonRef={navigationToggleRef}
      registerPanelButton={(id, node) => {
        if (node) panelToggles.current.set(id, node);
        else panelToggles.current.delete(id);
      }}
      onToggleMenu={toggleSidebar}
      onTogglePanel={toggleRightPanel}
    />
  );
  const conversationPanel = (
    <ConversationPanel
      key={
        pendingSession
          ? `conversation:pending:${pendingSession.requestId}`
          : `conversation:${live.runtime?.sessionId ?? "loading"}:${workspaceMode}`
      }
      live={live}
      projectAvailable={live.runtime?.projectAvailable !== false}
      pendingSession={
        pendingSession
          ? {
              phase: pendingSession.phase,
              projectLabel: pendingSession.project.label,
              error: pendingSession.error,
              onRetry: () => void newSession(pendingSession.project, true),
            }
          : undefined
      }
      initialDraft={
        pendingSession
          ? pendingSessionDraft.current
          : live.runtime?.sessionId
            ? composerDrafts.textFor(live.runtime.sessionId)
            : undefined
      }
      restoreComposerFocus={composerFocusTarget === live.runtime?.sessionId}
      restoreComposerSelection={
        composerFocusTarget === live.runtime?.sessionId
          ? pendingSessionSelection.current
          : undefined
      }
      onComposerFocusRestored={() => {
        pendingSessionSelection.current = undefined;
        setComposerFocusTarget((current) =>
          current === live.runtime?.sessionId ? undefined : current,
        );
      }}
      onDraftChange={(draft) => {
        if (pendingSession) {
          pendingSessionDraft.current = draft;
          if (pendingSession.recoveredDraftSessionId)
            composerDrafts.save(
              pendingSession.recoveredDraftSessionId,
              pendingSession.project.id,
              draft,
            );
          const runtime = live.runtime;
          if (
            pendingSession.expectedGeneration !== undefined &&
            runtime?.ready === true &&
            runtime.sessionGeneration === pendingSession.expectedGeneration &&
            runtime.sessionId !== pendingSession.previousSessionId
          )
            composerDrafts.save(
              runtime.sessionId,
              pendingSession.project.id,
              draft,
            );
          return;
        }
        const sessionId = live.runtime?.sessionId;
        if (sessionId)
          composerDrafts.save(sessionId, activeSession?.projectId, draft);
      }}
      onSelectAgent={(id) => {
        setSelectedAgentId(id);
        setRightPanel("agents");
      }}
      onOpenCompaction={(message) => {
        const sessionId = live.runtime?.sessionId;
        if (!sessionId) return;
        setSelectedCompaction({ sessionId, message });
        setRightPanel("compaction");
      }}
      onOpenAttachment={(attachment, trigger) => {
        const sessionId = live.runtime?.sessionId;
        if (!sessionId) return;
        setSelectedAttachment({ sessionId, attachment, trigger });
        setRightPanel("attachment");
      }}
      agentColors={agentColors}
      onOpenLogin={(provider) => {
        showSettings({ tab: "providers", providerQuery: provider ?? "" });
      }}
    />
  );

  const sidePanel = (
    <>
      {rightPanel && inspectorOverlay && (
        <button
          className="inspector-scrim"
          aria-label={`Close ${rightPanel}`}
          onClick={() => setRightPanel(null)}
        />
      )}
      {rightPanel && (
        <PanelResizer
          container={workspaceRef}
          width={rightPanelWidth}
          onCommit={(width) => {
            const slot = panelWidthSlot(rightPanel);
            setPanelWidths((current) => ({ ...current, [slot.key]: width }));
            rememberSetting(slot.key, width);
          }}
        />
      )}
      {rightPanel === "chat" && (
        <aside
          id="chat-panel"
          className="inspector workspace-chat-panel is-open"
          aria-labelledby="chat-panel-title"
        >
          <header>
            <div>
              <IconMessageCircle size={18} />
              <strong id="chat-panel-title">Chat</strong>
            </div>
            <button
              className="icon-button"
              type="button"
              onClick={() => setRightPanel(null)}
              aria-label="Close chat"
            >
              <IconX size={17} />
            </button>
          </header>
          <div className="workspace-chat-panel-body">{conversationPanel}</div>
        </aside>
      )}
      {rightPanel === "inspector" && (
        <Inspector
          key={`inspector:${live.runtime?.sessionId ?? "loading"}`}
          current={view}
          live={live}
          availableViews={availableViews}
          timelineEnabled={timelineEnabled}
          memoryReviewerConfigured={memoryReviewerConfigured}
          memoryEnabled={memoryEnabled}
          papercutEnabled={papercutEnabled}
          overlay={inspectorOverlay}
          onClose={() => setRightPanel(null)}
          onNavigate={selectView}
          onOpenGlobalPolicy={() => {
            setRightPanel(null);
            showSettings({ tab: "policy" });
          }}
          onOpenMemoryReviewerSettings={() => {
            setRightPanel(null);
            showSettings({ packageQuery: "continuity" });
          }}
        />
      )}
      {rightPanel === "database" && (
        <DatabasePanel
          key={`database:${live.runtime?.sessionId ?? "loading"}`}
          live={live}
          onClose={() => setRightPanel(null)}
        />
      )}
      {rightPanel === "agents" && (
        <AgentPanel
          key={`agents:${live.runtime?.sessionId ?? "loading"}`}
          runs={live.runtime?.conversation.delegatedRuns ?? []}
          models={live.runtime?.sessionControls.models ?? []}
          colors={agentColors}
          selectedId={selectedAgentId}
          onSelect={setSelectedAgentId}
          onClose={() => setRightPanel(null)}
        />
      )}
      {rightPanel === "compaction" &&
        selectedCompaction &&
        selectedCompaction.sessionId === live.runtime?.sessionId && (
          <CompactionPanel
            key={`compaction:${selectedCompaction.message.id}`}
            message={selectedCompaction.message}
            onClose={() => setRightPanel(null)}
          />
        )}
      {rightPanel === "attachment" &&
        selectedAttachment &&
        selectedAttachment.sessionId === live.runtime?.sessionId && (
          <AttachmentPanel
            key={`attachment:${selectedAttachment.attachment.sourceEntryId}:${selectedAttachment.attachment.index}`}
            attachment={selectedAttachment.attachment}
            onClose={() => setRightPanel(null)}
          />
        )}
      {rightPanel === "files" && (
        <FilesPanel
          key={`files:${live.runtime?.sessionId ?? "loading"}`}
          live={live}
          requestedPath={requestedFile}
          onClose={() => setRightPanel(null)}
          onExpand={(path, fileView) => {
            if (path)
              setRequestedFile({
                path,
                view: fileView,
                sessionId: live.runtime?.sessionId,
                requestId: Date.now(),
              });
            setRightPanel(null);
            changeWorkspaceMode("files");
          }}
          onError={reportError}
        />
      )}
      {rightPanel === "browser" && (
        <BrowserPanel
          key={`browser:${live.runtime?.sessionId ?? "loading"}`}
          connected={
            live.connection === "connected" && live.runtime?.ready === true
          }
          generation={live.runtime?.sessionGeneration}
          mirrorRequest={browserMirrorRequest}
          onActiveChange={setBrowserActive}
          onClose={() => setRightPanel(null)}
          onError={reportError}
        />
      )}
    </>
  );

  const terminalChrome = (
    <>
      {terminalOpen && !mobile && (
        <TerminalResizer
          container={appShellRef}
          height={terminalDrawerHeight}
          onCommit={(height) => {
            setTerminalDrawerHeight(height);
            rememberSetting(TERMINAL_HEIGHT_KEY, height);
          }}
        />
      )}
      {retainedTerminals.map((terminal) => (
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
    <div
      ref={appShellRef}
      className={`app-shell has-session-strip ${sidebarCollapsed ? "sidebar-collapsed" : ""}${shellModeClass ? ` ${shellModeClass}` : ""}`}
      style={
        {
          "--sidebar-width": `${leftPanelWidth}px`,
          "--terminal-height": terminalOpen
            ? `${terminalDrawerHeight}px`
            : "0px",
        } as CSSProperties
      }
    >
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <ActiveSessionStrip
        sessions={activeSessions}
        unseenCompletions={live.unseenCompletions}
        selectedId={pendingSession ? undefined : live.runtime?.sessionId}
        pendingLabel={pendingSession?.project.label}
        busy={Boolean(sessionBusy || sessionDeleting || projectBusy)}
        busySessionId={sessionBusy}
        deletingSessionId={sessionDeleting}
        onSelect={(session) => void switchSession(session)}
        onDelete={requestDeleteSession}
        onRename={requestRenameSession}
        onArchive={(session) => void archiveSession(session)}
        onSetActive={(session, active) =>
          void setSessionActive(session, active)
        }
        onSetPinned={(session, pinned) =>
          void setSessionPinned(session, pinned)
        }
        onNew={() => {
          if (!currentProject) return;
          changeWorkspaceMode("chat");
          void newSession(currentProject);
        }}
        onAllSessions={() => {
          if (workspaceMode === "files") setFileNavigation("sessions");
          else changeWorkspaceMode("chat");
          setSidebarCollapsed(false);
          if (mobile) setSidebarOpen(true);
        }}
      />
      {(workspaceMode === "chat" || fileNavigation === "sessions") && (
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
          contextual
          onClose={() => setSidebarOpen(false)}
          onShowFiles={
            workspaceMode === "files"
              ? () => {
                  setFileNavigation("explorer");
                  if (mobile) setSidebarOpen(false);
                }
              : undefined
          }
          onQuery={setQuery}
          onToggleProject={(projectId) =>
            setExpandedProjects((current) => {
              const next = new Set(current);
              if (next.has(projectId)) next.delete(projectId);
              else next.add(projectId);
              return next;
            })
          }
          onSelectSession={(session) => void switchSession(session)}
          onDeleteSession={requestDeleteSession}
          onRenameSession={requestRenameSession}
          onSetSessionActive={(session, active) =>
            void setSessionActive(session, active)
          }
          onSetSessionPinned={(session, pinned) =>
            void setSessionPinned(session, pinned)
          }
          onLoadMore={(project) => void loadMoreSessions(project)}
          onShowLess={(project) => void showLessSessions(project)}
          onAddProject={() => void addProject()}
          general={general}
          onOpenArchives={() => {
            setArchivesOpen(true);
            if (mobile) setSidebarOpen(false);
          }}
          terminalOpen={terminalOpen}
          terminalAvailable={Boolean(
            live.runtime?.ready && live.runtime.projectAvailable !== false,
          )}
          onToggleTerminal={toggleTerminal}
          onOpenSettings={openSettings}
          onArchiveProject={(project) => void archiveProject(project)}
          onRenameProject={(project) =>
            setSidebarAction({
              key: `rename-project-${project.id}`,
              title: "Rename project",
              description:
                "This changes only the project name shown in Pylon. Folder name and files stay unchanged.",
              confirmLabel: "Save name",
              busyLabel: "Saving…",
              inputLabel: "Project name",
              initialValue: project.label,
              onConfirm: (value) => void renameProject(project, value),
            })
          }
          onRemoveProject={(project) => {
            const count =
              sessionPages.find((candidate) => candidate.id === project.id)
                ?.totalCount ?? project.sessions.length;
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
          onArchiveSession={(session) => void archiveSession(session)}
          onNewSession={(project) => {
            const unfiltered = projects.find(
              (candidate) => candidate.id === project.id,
            );
            if (unfiltered) void newSession(unfiltered);
          }}
          onNewGeneral={() => {
            if (general) void newSession(general);
          }}
          onWorktreeSetup={(project) =>
            setSidebarAction({
              key: `worktree-setup-${project.id}`,
              title: `Worktree setup for ${project.label}`,
              description:
                "This command runs once after Pylon creates a new isolated worktree.",
              confirmLabel: "Save setup",
              busyLabel: "Saving…",
              inputLabel: "Setup command",
              multiline: true,
              maxLength: 2_000,
              allowEmpty: true,
              onConfirm: (value) => void updateWorktreeSetup(project, value),
            })
          }
          onReorderProject={(projectId, beforeProjectId) =>
            runtimeStore
              .reorderProject(projectId, beforeProjectId)
              .catch((cause) => {
                reportError(cause, "Unable to reorder project");
                throw cause;
              })
          }
          onReorderActiveSession={(sessionId, beforeSessionId) =>
            runtimeStore
              .reorderActiveSession(sessionId, beforeSessionId)
              .catch((cause) => {
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
          onCommit={(width) => {
            setLeftPanelWidth(width);
            rememberSetting(LEFT_PANEL_WIDTH_KEY, width);
          }}
        />
      )}
      {mobile &&
        sidebarOpen &&
        (workspaceMode === "chat" || fileNavigation === "sessions") && (
          <button
            className="sidebar-scrim"
            aria-label="Close navigation"
            onClick={() => setSidebarOpen(false)}
          />
        )}

      {/* Modes that own the main area are listed explicitly; anything else falls back to chat. */}
      {workspaceMode !== "files" ? (
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
                    if (live.recovery?.action === "reload")
                      window.location.reload();
                    else runtimeStore.retryBootstrap();
                  }}
                />
              )}
              {toast && (
                <ErrorToast
                  key={toast.id}
                  message={toast.message}
                  onClose={() => setToast(undefined)}
                />
              )}
            </div>
          )}
          <div
            ref={workspaceRef}
            className={`workspace-layout ${rightPanel ? "has-inspector" : ""}${pendingSession ? " is-session-pending" : ""}`}
            style={
              { "--inspector-width": `${rightPanelWidth}px` } as CSSProperties
            }
          >
            {conversationPanel}
            {sidePanel}
          </div>
          {(sessionTransition || packageBusy) && (
            <div className="session-transition" role="status">
              <span className="status-orb success" />
              {packageBusy ? "Reloading packages..." : "Changing session..."}
            </div>
          )}
        </main>
      ) : (
        <FileWorkspace
          live={live}
          requestedPath={requestedFile}
          stateStore={fileWorkspaceStates}
          contentStore={fileWorkspaceContents}
          header={topbar}
          workspaceRef={workspaceRef}
          sidePanel={sidePanel}
          terminalOpen={terminalOpen}
          terminalAvailable={Boolean(
            live.runtime?.ready && live.runtime.projectAvailable !== false,
          )}
          rightPanelOpen={Boolean(rightPanel)}
          inspectorWidth={rightPanelWidth}
          showExplorer={
            fileNavigation === "explorer" && (mobile || !sidebarCollapsed)
          }
          navigationOpen={sidebarOpen}
          mobile={mobile}
          onCloseNavigation={() => setSidebarOpen(false)}
          onToggleTerminal={toggleTerminal}
          onOpenSettings={openSettings}
          onSessions={() => {
            setFileNavigation("sessions");
            setSidebarCollapsed(false);
            if (mobile) setSidebarOpen(true);
          }}
          onError={reportError}
        />
      )}
      <div className="terminal-layer">{terminalChrome}</div>

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
      {archivesOpen && (
        <ArchiveDialog
          revision={live.sessionRevision ?? 0}
          onClose={() => setArchivesOpen(false)}
          onError={reportError}
        />
      )}
      {settings && (
        <SettingsDialog
          initialTab={settings.tab}
          initialProviderQuery={settings.providerQuery}
          initialPackageQuery={settings.packageQuery}
          providerAuth={live.runtime?.providerAuth}
          pendingUi={live.pendingUi}
          packages={packages}
          extensions={extensions}
          hookSettings={hookSettings}
          runtimePolicy={live.runtime?.runtimePolicy}
          toolPolicies={live.runtime?.operational.tools.policies ?? []}
          policyDisabled={
            live.connection !== "connected" ||
            live.runtime?.ready !== true ||
            Boolean(live.pendingUi) ||
            activeSessions.some(
              (session) =>
                session.runtimeState === "running" ||
                session.runtimeState === "attention",
            )
          }
          loading={packagesLoading}
          extensionLoading={extensionsLoading}
          hookLoading={hooksLoading}
          busy={packageBusy}
          extensionBusy={Boolean(extensionBusy)}
          hookBusy={hooksBusy}
          androidTooling={androidTooling}
          androidToolingBusy={androidToolingBusy}
          onAndroidTooling={manageAndroidTooling}
          providerLogoutDisabled={activeSessions.some(
            (session) =>
              session.runtimeState === "running" ||
              session.runtimeState === "attention",
          )}
          models={live.runtime?.sessionControls.models ?? []}
          sessionThinkingLevels={
            live.runtime?.sessionControls.thinkingLevels ?? []
          }
          theme={theme}
          onThemeChange={setTheme}
          onClose={() => {
            if (live.runtime?.providerAuth?.flow?.status === "running")
              void runtimeStore.cancelProviderLogin();
            closeSettings();
          }}
          onProviderLogin={(provider, authType) =>
            void runtimeStore.startProviderLogin(provider, authType)
          }
          onProviderLogout={(provider) =>
            void runtimeStore.logoutProvider(provider)
          }
          onProviderCancel={() => void runtimeStore.cancelProviderLogin()}
          onSetEnabled={(item, enabled) =>
            void setPackageEnabled(item, enabled)
          }
          onUpdate={(item, settings) =>
            void updatePackageSettings(item, settings)
          }
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
            runtimeStore.updateToolPolicy(
              "global",
              tool,
              mode,
              expectedRevision,
            )
          }
        />
      )}
    </div>
  );
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
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        const next = terminalHeight(
          height + (event.key === "ArrowUp" ? 16 : -16),
        );
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
    const next = clampPanelWidth(window.innerWidth - clientX);
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
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = clampPanelWidth(
          width + (event.key === "ArrowLeft" ? 16 : -16),
        );
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
  const resize = (clientX: number) => {
    const next = leftPanelWidth(clientX);
    container.current?.style.setProperty("--sidebar-width", `${next}px`);
    return next;
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    let next = width;
    const move = (moveEvent: PointerEvent) => {
      next = resize(moveEvent.clientX);
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
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const next = leftPanelWidth(
          width + (event.key === "ArrowRight" ? 16 : -16),
        );
        container.current?.style.setProperty("--sidebar-width", `${next}px`);
        onCommit(next);
      }}
    />
  );
}

function ErrorToast({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  const [exiting, setExiting] = useState(false);
  const close = () => {
    if (exiting) return;
    setExiting(true);
    window.setTimeout(onClose, 140);
  };
  useEffect(() => {
    const timer = window.setTimeout(close, 8_000);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div
      className={`app-error-toast${exiting ? " is-exiting" : ""}`}
      role="alert"
    >
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
  onAllSessions,
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
  onAllSessions: () => void;
}) {
  const stripRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<{ sessionId: string; left: number }>();
  const [announcement, setAnnouncement] = useState("");
  const menuSession = sessions.find(
    (session) => session.id === menu?.sessionId,
  );
  useEffect(() => {
    if (!selectedId) return;
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-session-id="${CSS.escape(selectedId)}"]`,
      )
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selectedId]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest(
          ".active-session-options, .active-session-menu-popover",
        )
      )
        return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      menuTrigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    listRef.current?.addEventListener("scroll", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      listRef.current?.removeEventListener("scroll", close);
    };
  }, [menu]);
  const working = sessions.some((session) => session.workStartedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(
      () => setNow(Date.now()),
      working ? 1_000 : 60_000,
    );
    return () => window.clearInterval(interval);
  }, [working]);
  const toggleMenu = (session: SessionSummary, trigger: HTMLButtonElement) => {
    menuTrigger.current = trigger;
    if (menu?.sessionId === session.id) {
      setMenu(undefined);
      return;
    }
    const stripRect = stripRef.current?.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const menuWidth = 168;
    const maxLeft = Math.max(
      8,
      (stripRect?.width ?? window.innerWidth) - menuWidth - 8,
    );
    setMenu({
      sessionId: session.id,
      left: Math.min(
        Math.max(triggerRect.right - (stripRect?.left ?? 0) - menuWidth, 8),
        maxLeft,
      ),
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
    void copyText(id).then((copied) =>
      setAnnouncement(
        copied ? "Session ID copied" : "Copying session ID failed",
      ),
    );
  };
  const sleeping = menuSession?.runtimeState === "sleeping";
  return (
    <nav
      ref={stripRef}
      className="active-session-strip"
      aria-label="Active sessions"
    >
      <div className="active-session-brand">
        <span className="brand-mark" aria-hidden="true">
          <img src="/pylon-mark.svg" alt="" />
        </span>
        <strong>Pylon</strong>
      </div>
      <div ref={listRef} className="active-session-tabs">
        {sessions.map((session) => {
          const completed = Boolean(unseenCompletions?.[session.id]);
          const activity = formatSessionActivity(
            session.modifiedAt,
            session.workStartedAt,
            now,
          );
          const preview = `${session.parentSession ? `Spawned from ${session.parentSession.title} · ` : ""}${session.cwdLabel} · ${activity}`;
          const menuOpen = menu?.sessionId === session.id;
          return (
            <div
              key={session.id}
              data-session-id={session.id}
              className={`active-session-tab-shell${session.id === selectedId ? " is-active" : ""}`}
            >
              <button
                type="button"
                className={`active-session-tab${session.id === selectedId ? " is-active" : ""}`}
                disabled={busy}
                onClick={() => {
                  setMenu(undefined);
                  onSelect(session);
                }}
              >
                <strong title={sessionTitle(session)}>
                  {sessionTitle(session).slice(0, 50)}
                </strong>
                <span title={preview}>{preview}</span>
                {busySessionId === session.id ||
                deletingSessionId === session.id ? (
                  <i
                    className="active-session-state status-orb success"
                    aria-label={
                      deletingSessionId === session.id ? "Deleting" : "Updating"
                    }
                  />
                ) : (
                  showSessionRuntimeState(session.runtimeState, completed) && (
                    <i
                      className={`active-session-state session-runtime-state ${completed ? "is-complete" : `is-${session.runtimeState}`}`}
                      aria-label={
                        completed ? "New response" : session.runtimeState
                      }
                      title={completed ? "New response" : session.runtimeState}
                    />
                  )
                )}
              </button>
              <button
                className="active-session-options"
                type="button"
                aria-label={`More options for ${sessionTitle(session)}`}
                aria-expanded={menuOpen}
                aria-controls="active-session-options-menu"
                title="More options"
                onClick={(event) => toggleMenu(session, event.currentTarget)}
              >
                <IconDots size={15} />
              </button>
            </div>
          );
        })}
        {pendingLabel && (
          <button
            type="button"
            className="active-session-tab is-active"
            disabled
          >
            <strong>New session</strong>
            <span>{pendingLabel}</span>
          </button>
        )}
        <button
          className="active-session-new"
          type="button"
          disabled={busy}
          onClick={onNew}
          aria-label="New session"
          title="New session"
        >
          <IconPlus size={17} />
        </button>
      </div>
      <button
        className="active-session-all"
        type="button"
        onClick={onAllSessions}
        aria-label="All sessions"
        title="All sessions"
      >
        <IconDots size={18} />
      </button>
      {menuSession && (
        <div
          id="active-session-options-menu"
          className="session-menu-popover active-session-menu-popover"
          role="menu"
          style={{ left: menu?.left }}
        >
          <button
            role="menuitem"
            type="button"
            disabled={busy}
            onClick={() => closeAndRun(onRename)}
          >
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
            onClick={() =>
              closeAndRun((session) => onSetPinned(session, !session.pinned))
            }
          >
            <IconPin size={14} />
            {menuSession.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={busy}
            onClick={() => closeAndRun(onArchive)}
          >
            <IconArchive size={14} />
            Archive
          </button>
          <button
            role="menuitem"
            type="button"
            disabled={busy || menuSession.active || menuSession.pinned}
            title={
              menuSession.active
                ? "The selected session must remain active"
                : menuSession.pinned
                  ? "Unpin before deactivating"
                  : undefined
            }
            onClick={() =>
              closeAndRun((session) => onSetActive(session, sleeping))
            }
          >
            <IconPower size={14} />
            {sleeping ? "Activate" : "Deactivate"}
          </button>
          <button
            role="menuitem"
            className="is-danger"
            type="button"
            disabled={busy || menuSession.active}
            title={
              menuSession.active
                ? "Active session cannot be deleted"
                : undefined
            }
            onClick={() => closeAndRun(onDelete)}
          >
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

function Topbar({
  live,
  session,
  pendingSession,
  theme,
  workspaceMode,
  menuOpen,
  rightPanel,
  panelContext,
  menuButtonRef,
  registerPanelButton,
  onWorkspaceMode,
  onToggleTheme,
  onToggleMenu,
  onTogglePanel,
}: {
  live: RuntimeStoreSnapshot;
  session?: SessionSummary;
  pendingSession?: PendingSession;
  theme: Theme;
  workspaceMode: WorkspaceModeId;
  menuOpen: boolean;
  rightPanel: RightPanel;
  panelContext: PanelContext;
  menuButtonRef: React.RefObject<HTMLButtonElement | null>;
  registerPanelButton: (id: PanelId, node: HTMLButtonElement | null) => void;
  onWorkspaceMode: (mode: WorkspaceModeId) => void;
  onToggleTheme: () => void;
  onToggleMenu: () => void;
  onTogglePanel: (panel: PanelId) => void;
}) {
  const runtime = pendingSession ? undefined : live.runtime;
  const sessionName = pendingSession
    ? "New session"
    : runtime?.sessionName || (session ? sessionTitle(session) : "New session");
  const branch = pendingSession
    ? pendingSession.phase === "failed"
      ? "setup failed"
      : "workspace pending"
    : runtime?.gitBranch || "No Git branch";
  const turn = runtime?.metrics.userMessages ?? 0;
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          ref={menuButtonRef}
          className="icon-button navigation-toggle"
          onClick={onToggleMenu}
          aria-label="Toggle project navigation"
          aria-controls="primary-navigation"
          aria-expanded={menuOpen}
        >
          <IconMenu2 size={18} />
        </button>
        <nav className="workspace-mode-switch" aria-label="Session view">
          {WORKSPACE_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={workspaceMode === mode.id ? "is-active" : ""}
              disabled={
                Boolean(pendingSession) && Boolean(mode.requiresSession)
              }
              onClick={() => onWorkspaceMode(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </nav>
        <div className="repo-crumb">
          <IconBrandGit size={16} stroke={1.7} />
          <span>
            {pendingSession?.project.label || runtime?.cwdLabel || "Pylon"} /{" "}
            <strong>{sessionName.slice(0, 128)}</strong>
          </span>
        </div>
        <span className="topbar-divider" />
        <div className="branch-label">
          <IconGitBranch size={14} />
          <span>{pendingSession ? branch : `${branch} · Turn ${turn}`}</span>
        </div>
      </div>
      <div className="topbar-actions">
        {PANELS.filter((panel) => panel.showButton?.(panelContext) ?? true).map(
          (panel) => {
            const badge = panel.badge?.(runtime, panelContext);
            const Icon = panel.icon;
            return (
              <button
                key={panel.id}
                ref={(node) => {
                  registerPanelButton(panel.id, node);
                }}
                className={`agents-trigger ${rightPanel === panel.id ? "is-active" : ""} ${badge?.live ? "is-live" : ""}`}
                type="button"
                disabled={Boolean(pendingSession)}
                onClick={() => onTogglePanel(panel.id)}
                aria-label={badge?.ariaLabel ?? panel.label}
                aria-controls={panel.ariaId}
                aria-expanded={rightPanel === panel.id}
              >
                <Icon size={16} />
                <span>{panel.label}</span>
                {badge?.count !== undefined && <small>{badge.count}</small>}
              </button>
            );
          },
        )}
        <button
          className="icon-button"
          onClick={onToggleTheme}
          aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? <IconSun size={17} /> : <IconMoon size={17} />}
        </button>
      </div>
    </header>
  );
}
