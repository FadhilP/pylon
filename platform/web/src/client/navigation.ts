import {
  IconAdjustmentsHorizontal,
  IconArchive,
  IconBook,
  IconContrast,
  IconDatabase,
  IconFiles,
  IconGauge,
  IconLayoutDashboard,
  IconList,
  IconMessageCircle,
  IconSettings,
  IconTerminal2,
  IconThinkingMedium,
  IconTimeline,
  IconTool,
  IconBotId,
  IconWorld,
} from "@tabler/icons-react";
import type { RuntimeStoreSnapshot } from "./runtime/event-store";

/**
 * Every navigable thing in the app, at the four altitudes it actually has.
 *
 *   workspace   about the whole workspace, not the selected session
 *   surface     what fills the main area
 *   reference   what is docked beside it
 *   ambient     always-available chrome
 *
 */

type IconComponent = typeof IconDatabase;
type Runtime = RuntimeStoreSnapshot["runtime"];

/** Count and live dot shown on a nav control. */
export type NavBadge = { count?: number; live?: boolean; ariaLabel?: string };

/** App state the registries need to decide what is available. */
export type NavContext = {
  surface: SurfaceId;
  stateqlEnabled: boolean;
  browserAvailable: boolean;
  browserActive: boolean;
  timelineEnabled: boolean;
  memoryEnabled: boolean;
  papercutEnabled: boolean;
};

export type WorkspaceViewId = "sessions" | "archive" | "usage";
/** null means the session workspace is showing. */
export type ActiveWorkspaceView = WorkspaceViewId | null;

export type WorkspaceViewDefinition = { id: WorkspaceViewId; label: string; icon: IconComponent; ariaId: string };

export const WORKSPACE_VIEWS: WorkspaceViewDefinition[] = [
  { id: "sessions", label: "All sessions", icon: IconList, ariaId: "workspace-sessions" },
  { id: "archive", label: "Archive", icon: IconArchive, ariaId: "workspace-archive" },
  { id: "usage", label: "Usage", icon: IconGauge, ariaId: "workspace-usage" },
];

export function workspaceViewDefinition(view: ActiveWorkspaceView): WorkspaceViewDefinition | undefined {
  return view ? WORKSPACE_VIEWS.find(item => item.id === view) : undefined;
}

export type AmbientId = "theme" | "settings" | "changelog" | "terminal";

export type AmbientDefinition = { id: AmbientId; label: string; icon: IconComponent };

export const AMBIENT: AmbientDefinition[] = [
  { id: "theme", label: "Theme", icon: IconContrast },
  { id: "settings", label: "Settings", icon: IconSettings },
  { id: "changelog", label: "Changelog", icon: IconBook },
  { id: "terminal", label: "Terminal", icon: IconTerminal2 },
];

export type SurfaceId = "chat" | "files" | "database" | "browser";

export type SurfaceDefinition = {
  id: SurfaceId;
  label: string;
  icon: IconComponent;
  /** Extra class on the app shell while this surface is active. */
  shellClass?: string;
  /** Surfaces needing a ready workspace stay disabled while a session starts. */
  requiresSession?: boolean;
  /** Hides the tab when false. Omitted means always shown. */
  available?: (context: NavContext) => boolean;
  badge?: (runtime: Runtime, context: NavContext) => NavBadge;
};

export const SURFACES: SurfaceDefinition[] = [
  { id: "chat", label: "Chat", icon: IconMessageCircle },
  { id: "files", label: "Files", icon: IconFiles, requiresSession: true },
  {
    id: "database",
    label: "Database",
    icon: IconDatabase,
    requiresSession: true,
    available: context => context.stateqlEnabled,
  },
  {
    id: "browser",
    label: "Browser",
    icon: IconWorld,
    requiresSession: true,
    available: context => context.browserAvailable,
    badge: (_runtime, context) => ({
      live: context.browserActive,
      ariaLabel: `Helios browser${context.browserActive ? ", active" : ""}`,
    }),
  },
];

export function surfaceDefinition(surface: SurfaceId): SurfaceDefinition {
  return SURFACES.find(item => item.id === surface) ?? SURFACES[0];
}

/**
 * Any surface but chat fills the main area, which pushes the conversation
 * into the reference rail. It is the same conversation in its other home,
 * not a second copy of it.
 */
export function displacesConversation(surface: SurfaceId): boolean {
  return surface !== "chat";
}

export function beginBrowserSessionSurfaceTransition(
  browserSessions: ReadonlySet<string>,
  previousSessionId: string | undefined,
  sessionId: string,
  surface: SurfaceId,
): { browserSessions: Set<string>; requested: boolean } {
  const next = new Set(browserSessions);
  if (previousSessionId) {
    if (surface === "browser") next.add(previousSessionId);
    else next.delete(previousSessionId);
  }
  return { browserSessions: next, requested: surface === "browser" || next.has(sessionId) };
}

export function browserSurfaceAfterSessionStatus(
  requestedSessionId: string | undefined,
  sessionId: string,
  active: boolean,
): SurfaceId | undefined {
  return requestedSessionId === sessionId ? (active ? "browser" : "chat") : undefined;
}

export type ReferenceId =
  | "chat"
  | "overview"
  | "policy"
  | "timeline"
  | "memory"
  | "tools"
  | "changes"
  | "agents"
  | "compaction"
  | "attachment"
  | "turn-diff";
export type ActiveReference = ReferenceId | null;

/** Rail groups, rendered with a hairline between them. */
export type ReferenceGroup = "conversation" | "session" | "run";

export type ReferenceDefinition = {
  id: ReferenceId;
  label: string;
  /** One line under the panel header saying what the view is for. */
  description: string;
  icon: IconComponent;
  ariaId: string;
  group: ReferenceGroup;
  tone?: string;
  /** Reference views needing more room than the shared width bring their own. */
  width?: PanelWidth;
  available?: (context: NavContext) => boolean;
  badge?: (runtime: Runtime, context: NavContext) => NavBadge;
};

export const REFERENCES: ReferenceDefinition[] = [
  {
    id: "chat",
    label: "Chat",
    description: "The conversation, docked while another surface holds the main area.",
    icon: IconMessageCircle,
    ariaId: "chat-panel",
    group: "conversation",
    tone: "var(--teal)",
    // Only while something displaced it; on the chat surface it is the main area.
    available: context => displacesConversation(context.surface),
  },
  {
    id: "overview",
    label: "Overview",
    description: "Live state for the active Pylon session.",
    icon: IconLayoutDashboard,
    ariaId: "reference-overview",
    group: "session",
    tone: "var(--accent)",
  },
  {
    id: "policy",
    label: "Policy",
    description: "Project and session behavior. Global defaults live in Settings.",
    icon: IconAdjustmentsHorizontal,
    ariaId: "reference-policy",
    group: "session",
    tone: "var(--amber)",
  },
  {
    id: "timeline",
    label: "Timeline",
    description: "Recoverable checkpoints across the current run.",
    icon: IconTimeline,
    ariaId: "reference-timeline",
    group: "session",
    tone: "var(--green)",
    available: context => context.timelineEnabled,
  },
  {
    id: "memory",
    label: "Memory",
    description: "Durable project context and workflow friction.",
    icon: IconThinkingMedium,
    ariaId: "reference-memory",
    group: "session",
    tone: "var(--violet)",
    available: context => context.memoryEnabled || context.papercutEnabled,
  },
  {
    id: "tools",
    label: "Tools",
    description: "Project and session overrides for registered tools.",
    icon: IconTool,
    ariaId: "reference-tools",
    group: "session",
    tone: "var(--red)",
  },
  {
    // Named for what it shows rather than what it browses: the Files surface
    // is the explorer, this is the changed set and its diffs.
    id: "changes",
    label: "Changes",
    description: "Files this session has touched, and their diffs.",
    icon: IconFiles,
    ariaId: "changes-panel",
    group: "run",
    tone: "var(--lime)",
    // Redundant on the Files surface, where the explorer lists them inline.
    available: context => context.surface !== "files",
    badge: runtime => ({ count: runtime?.workspace?.changedCount ?? 0 }),
  },
  {
    id: "agents",
    label: "Agents",
    description: "Delegated runs spawned by this session.",
    icon: IconBotId,
    ariaId: "agents-panel",
    group: "run",
    tone: "var(--blue)",
    badge: runtime => {
      const runs = runtime?.conversation.delegatedRuns ?? [];
      const active = runs.filter(run => run.status === "running").length;
      return {
        count: runs.length,
        live: active > 0,
        ariaLabel: `Agents, ${runs.length} runs${active ? `, ${active} active` : ""}`,
      };
    },
  },
];

export function referenceDefinition(reference: ActiveReference): ReferenceDefinition | undefined {
  return reference ? REFERENCES.find(item => item.id === reference) : undefined;
}

/** Rail items in order, with `null` marking a hairline between groups. */
export function referenceRailItems(context: NavContext): Array<ReferenceDefinition | null> {
  const items = REFERENCES.filter(item => item.available?.(context) ?? true);
  return items.flatMap((item, index) => (index > 0 && item.group !== items[index - 1].group ? [null, item] : [item]));
}

/** Storage slot for a panel width. Panels sharing a slot share a width. */
export type PanelWidth = { key: string; default: number };

export const SHARED_PANEL_WIDTH: PanelWidth = { key: "pylon-right-panel-width", default: 380 };
const TURN_DIFF_PANEL_WIDTH: PanelWidth = { key: "pylon-turn-diff-panel-width", default: 620 };

export function panelWidthSlot(reference: ActiveReference): PanelWidth {
  if (reference === "turn-diff") return TURN_DIFF_PANEL_WIDTH;
  return referenceDefinition(reference)?.width ?? SHARED_PANEL_WIDTH;
}

export function clampPanelWidth(value: number): number {
  return Math.round(Math.max(300, Math.min(window.innerWidth, value)));
}

export function initialPanelWidths(): Record<string, number> {
  const slots = [SHARED_PANEL_WIDTH, TURN_DIFF_PANEL_WIDTH, ...REFERENCES.flatMap(item => item.width ?? [])];
  const widths: Record<string, number> = {};
  for (const slot of slots) {
    let stored = Number.NaN;
    try {
      stored = Number(localStorage.getItem(slot.key));
    } catch {
      /* Storage can be unavailable in hardened browser contexts. */
    }
    widths[slot.key] = clampPanelWidth(Number.isFinite(stored) && stored > 0 ? stored : slot.default);
  }
  return widths;
}
