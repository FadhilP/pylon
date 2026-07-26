import {
  IconActivity,
  IconArrowUpRight,
  IconBolt,
  IconCheck,
  IconChevronRight,
  IconCircle,
  IconClock,
  IconCpu,
  IconGitBranch,
  IconLayoutDashboard,
  IconListCheck,
  IconSearch,
  IconSettings,
  IconShieldCheck,
  IconStack2,
  IconTerminal2,
  IconTimeline,
  IconTool,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import type { PackageSummary } from "../shared/protocol/snapshots";
import { displayTime, formatDuration } from "./format";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";

export type ViewId = "overview" | "timeline" | "tools" | "settings";
type Tone = "success" | "warning" | "danger" | "neutral" | "active";
type IconComponent = ComponentType<{ size?: number; stroke?: number; className?: string }>;

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

export function Inspector({ current, live, packages, packagesLoading, packagesError, packageBusy, availableViews, isOpen, overlay, onClose, onNavigate, onSetPackageEnabled }: InspectorProps) {
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

function Metric({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: IconComponent }) {
  return <div className="metric"><span className="metric-icon"><Icon size={16} /></span><div><small>{label}</small><strong>{value}</strong><span>{detail}</span></div></div>;
}

function PanelHeader({ title, meta, action, onAction }: { title: string; meta?: string; action?: string; onAction?: () => void }) {
  return <header className="panel-header"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div>{action && onAction && <button className="text-button" type="button" onClick={onAction}>{action}<IconChevronRight size={14} /></button>}</header>;
}

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status status-${tone}`}><span aria-hidden="true" />{children}</span>;
}
