import { IconGitBranch, IconMoon, IconSun, IconX } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { RuntimeStoreSnapshot } from "../runtime/event-store";
import { AnnotationCount } from "../workspace/annotations";
import {
  AMBIENT,
  SURFACES,
  WORKSPACE_VIEWS,
  referenceRailItems,
  type ActiveReference,
  type ActiveWorkspaceView,
  type AmbientId,
  type NavBadge,
  type NavContext,
  type ReferenceId,
  type SurfaceId,
  type WorkspaceViewId,
} from "./navigation";
import { referenceDefinition } from "./navigation";
import type { Theme } from "./use-chrome";

type Runtime = RuntimeStoreSnapshot["runtime"];

/** One icon size for both rails, so the scope and reference sides stay level. */
const RAIL_ICON_SIZE = 19;

/** Icon-only rail control. The label is the accessible name and the tooltip. */
function RailButton({
  label,
  icon: Icon,
  active,
  tone,
  disabled,
  badge,
  ariaControls,
  buttonRef,
  onClick,
}: {
  label: string;
  icon: (props: { size?: number }) => React.ReactNode;
  active?: boolean;
  /** Colour the icon takes while active; the registry owns the mapping. */
  tone?: string;
  disabled?: boolean;
  badge?: NavBadge;
  ariaControls?: string;
  buttonRef?: (node: HTMLButtonElement | null) => void;
  onClick: () => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`rail-item ${active ? "is-active" : ""} ${badge?.live ? "is-live" : ""}`}
      data-label={label}
      disabled={disabled}
      style={tone ? ({ "--rail-tone": tone } as React.CSSProperties) : undefined}
      aria-label={badge?.ariaLabel ?? label}
      aria-pressed={active ?? false}
      aria-controls={ariaControls}
      onClick={onClick}>
      <Icon size={RAIL_ICON_SIZE} />
      {badge?.count ? <small>{badge.count}</small> : undefined}
    </button>
  );
}

export function ScopeRail({
  workspaceView,
  theme,
  terminalOpen,
  terminalAvailable,
  onWorkspaceView,
  onAmbient,
}: {
  workspaceView: ActiveWorkspaceView;
  theme: Theme;
  terminalOpen: boolean;
  terminalAvailable: boolean;
  onWorkspaceView: (view: WorkspaceViewId) => void;
  onAmbient: (id: AmbientId) => void;
}) {
  return (
    <nav className="scope-rail" aria-label="Workspace">
      <span className="rail-mark" aria-hidden="true">
        <img src="/pylon-mark.svg" alt="" />
      </span>
      {WORKSPACE_VIEWS.map(item => (
        <RailButton
          key={item.id}
          label={item.label}
          icon={item.icon}
          active={workspaceView === item.id}
          ariaControls={item.ariaId}
          onClick={() => onWorkspaceView(item.id)}
        />
      ))}
      <span className="rail-push" />
      {AMBIENT.map(item => (
        <RailButton
          key={item.id}
          label={item.id === "theme" ? `Use ${theme === "dark" ? "light" : "dark"} theme` : item.label}
          icon={item.id === "theme" ? (theme === "dark" ? IconSun : IconMoon) : item.icon}
          active={item.id === "terminal" ? terminalOpen : undefined}
          disabled={item.id === "terminal" && !terminalAvailable}
          onClick={() => onAmbient(item.id)}
        />
      ))}
    </nav>
  );
}

export function SurfaceTabs({
  surface,
  context,
  runtime,
  disabled,
  branchLabel,
  onSurface,
}: {
  surface: SurfaceId;
  context: NavContext;
  runtime: Runtime;
  disabled: boolean;
  branchLabel: string;
  onSurface: (surface: SurfaceId) => void;
}) {
  return (
    <div className="surface-tabs" role="tablist" aria-label="Workspace surface">
      {SURFACES.filter(item => item.available?.(context) ?? true).map(item => {
        const badge = item.badge?.(runtime, context);
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            className={`surface-tab ${surface === item.id ? "is-active" : ""} ${badge?.live ? "is-live" : ""}`}
            aria-selected={surface === item.id}
            aria-label={badge?.ariaLabel ?? item.label}
            disabled={disabled && Boolean(item.requiresSession)}
            onClick={() => onSurface(item.id)}>
            <Icon size={16} />
            <span data-label={item.label}>{item.label}</span>
            {badge?.count ? <small>{badge.count}</small> : undefined}
          </button>
        );
      })}
      <span className="surface-branch">
        <IconGitBranch size={14} />
        {branchLabel}
      </span>
    </div>
  );
}

export function ReferenceRail({
  reference,
  context,
  runtime,
  disabled,
  agentTone,
  registerButton,
  onReference,
}: {
  reference: ActiveReference;
  context: NavContext;
  runtime: Runtime;
  disabled: boolean;
  agentTone?: string;
  registerButton: (id: ReferenceId, node: HTMLButtonElement | null) => void;
  onReference: (reference: ReferenceId) => void;
}) {
  return (
    <nav className="reference-rail" aria-label="Session reference">
      {referenceRailItems(context).map((item, index) =>
        item === null ? (
          <hr key={`divider-${index}`} />
        ) : (
          <RailButton
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={reference === item.id}
            tone={item.id === "agents" && agentTone ? agentTone : item.tone}
            badge={item.badge?.(runtime, context)}
            ariaControls={item.ariaId}
            buttonRef={node => registerButton(item.id, node)}
            onClick={() => (disabled && item.id !== "android" ? undefined : onReference(item.id))}
          />
        ),
      )}
    </nav>
  );
}

/** Shared header and body shell for docked reference views. */
export function ReferencePanel({
  reference,
  overlay,
  fill,
  children,
  onClose,
}: {
  reference: ReferenceId;
  overlay: boolean;
  /** Fill the panel when content manages its own scrolling. */
  fill?: boolean;
  children: ReactNode;
  onClose: () => void;
}) {
  const definition = referenceDefinition(reference);
  if (!definition) return null;
  const Icon = definition.icon;
  const titleId = `${definition.ariaId}-title`;
  return (
    <aside id={definition.ariaId} className="inspector" aria-labelledby={titleId}>
      <header className="inspector-header">
        <div style={definition.tone ? ({ "--rail-tone": definition.tone } as React.CSSProperties) : undefined}>
          <Icon size={17} />
          <strong id={titleId}>{definition.label}</strong>
          {reference === "notes" && <AnnotationCount />}
        </div>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          aria-label={overlay ? `Close ${definition.label}` : `Collapse ${definition.label}`}>
          <IconX size={17} />
        </button>
      </header>
      <p className="inspector-description">{definition.description}</p>
      <div className={fill ? "inspector-fill" : "inspector-scroll"}>{children}</div>
    </aside>
  );
}
