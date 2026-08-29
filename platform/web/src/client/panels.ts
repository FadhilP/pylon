import {
  IconDatabase,
  IconFiles,
  IconLayoutDashboard,
  IconMessageCircle,
  IconUsers,
  IconWorld,
} from "@tabler/icons-react";
import type { RuntimeStoreSnapshot } from "./runtime/event-store";

export type PanelId = "chat" | "inspector" | "database" | "agents" | "files" | "browser" | "compaction" | "attachment";
export type RightPanel = PanelId | null;

type IconComponent = typeof IconDatabase;
type Runtime = RuntimeStoreSnapshot["runtime"];

/** Storage slot for a panel width. Panels sharing a slot share a width. */
export type PanelWidth = { key: string; default: number };

/** Count and live dot shown on a panel's topbar button. */
export type PanelBadge = { count?: number; live?: boolean; ariaLabel?: string };

export type WorkspaceModeId = "chat" | "files";

export type WorkspaceModeDefinition = {
  id: WorkspaceModeId;
  label: string;
  /** Extra class on the app shell while this mode is active. */
  shellClass?: string;
  /**
   * Modes that fill the main area with their own content move the conversation
   * into the chat panel while they are active, and hand it back on the way out.
   */
  displacesConversation?: boolean;
  /** Modes needing a ready workspace stay disabled while a session is starting. */
  requiresSession?: boolean;
};

/** Modes reachable from the topbar switch, in the order they appear there. */
export const WORKSPACE_MODES: WorkspaceModeDefinition[] = [
  { id: "chat", label: "Chat" },
  { id: "files", label: "Files", shellClass: "is-files-mode", displacesConversation: true, requiresSession: true },
];

export function workspaceModeDefinition(mode: WorkspaceModeId): WorkspaceModeDefinition {
  return WORKSPACE_MODES.find(item => item.id === mode) ?? WORKSPACE_MODES[0];
}

/** App state the topbar needs to decide what to show. */
export type PanelContext = {
  workspaceMode: WorkspaceModeId;
  stateqlEnabled: boolean;
  browserAvailable: boolean;
  browserActive: boolean;
};

export type PanelDefinition = {
  id: PanelId;
  label: string;
  icon: IconComponent;
  /** id of the panel element, wired to the toggle button's aria-controls. */
  ariaId: string;
  /** Panels needing more room than the shared width bring their own slot. */
  width?: PanelWidth;
  /** Hides the topbar button when false. Omitted means always shown. */
  showButton?: (context: PanelContext) => boolean;
  /** Closes the panel when the package behind it is turned off. */
  requiresPackage?: (context: PanelContext) => boolean;
  badge?: (runtime: Runtime, context: PanelContext) => PanelBadge;
};

export const SHARED_PANEL_WIDTH: PanelWidth = { key: "pylon-right-panel-width", default: 380 };
const DATABASE_PANEL_WIDTH: PanelWidth = { key: "pylon-database-panel-width", default: 920 };

/**
 * Panels reachable from the topbar, in the order they appear there.
 *
 * "compaction" and "attachment" are deliberately absent: they open from a
 * message in the conversation rather than a button, so they have no entry
 * here and fall back to the shared width.
 */
export const PANELS: PanelDefinition[] = [
  {
    id: "chat",
    label: "Chat",
    icon: IconMessageCircle,
    ariaId: "chat-panel",
    // Offered by any mode that pushes the conversation out of the main area.
    showButton: context => Boolean(workspaceModeDefinition(context.workspaceMode).displacesConversation),
  },
  { id: "inspector", label: "Inspector", icon: IconLayoutDashboard, ariaId: "session-inspector" },
  {
    id: "agents",
    label: "Agents",
    icon: IconUsers,
    ariaId: "agents-panel",
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
  {
    id: "files",
    label: "Files",
    icon: IconFiles,
    ariaId: "files-panel",
    // Redundant in files mode, where the workspace already shows them inline.
    showButton: context => context.workspaceMode !== "files",
    badge: runtime => ({ count: runtime?.workspace?.changedCount ?? 0 }),
  },
  {
    id: "database",
    label: "Database",
    icon: IconDatabase,
    ariaId: "database-panel",
    width: DATABASE_PANEL_WIDTH,
    showButton: context => context.stateqlEnabled,
    requiresPackage: context => context.stateqlEnabled,
  },
  {
    id: "browser",
    label: "Browser",
    icon: IconWorld,
    ariaId: "browser-panel",
    showButton: context => context.browserAvailable,
    requiresPackage: context => context.browserAvailable,
    badge: (_runtime, context) => ({
      live: context.browserActive,
      ariaLabel: `Helios browser${context.browserActive ? ", active" : ""}`,
    }),
  },
];

export function panelDefinition(panel: RightPanel): PanelDefinition | undefined {
  return panel ? PANELS.find(item => item.id === panel) : undefined;
}

export function panelWidthSlot(panel: RightPanel): PanelWidth {
  return panelDefinition(panel)?.width ?? SHARED_PANEL_WIDTH;
}

export function clampPanelWidth(value: number): number {
  return Math.round(Math.max(300, Math.min(window.innerWidth, value)));
}

export function initialPanelWidths(): Record<string, number> {
  const slots = [SHARED_PANEL_WIDTH, ...PANELS.flatMap(panel => panel.width ?? [])];
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
