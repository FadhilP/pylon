import {
  IconActivityHeartbeat,
  IconAdjustmentsHorizontal,
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconCircle,
  IconClock,
  IconDatabase,
  IconFile,
  IconGitBranch,
  IconGitFork,
  IconLayoutDashboard,
  IconListCheck,
  IconLoader2,
  IconSearch,
  IconRestore,
  IconRefresh,
  IconTimeline,
  IconTool,
  IconTrash,
  IconX,
  IconThinkingMedium
} from "@tabler/icons-react";
import DOMPurify from "dompurify";
import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { formatCacheHitRate, formatCompactNumber, formatWorkDuration } from "../shared/format";
import { DEFAULT_GUARD_RULES, GUARD_ACTIONS, GUARD_RISK_CATEGORIES, GUARD_RULE_DESCRIPTIONS, GUARD_RULE_LABELS, mergeGuardRules, resolveGuardRule, type GuardAction, type GuardRuleOverrides } from "../shared/guard-policy";
import { highlightSource } from "../shared/markdown";
import type { ContinuityMemoryNoteReadModel, JobReadModel, SessionMetricsReadModel, VerificationReadModel } from "../shared/protocol/events";
import type { DialogTimeoutSeconds, PapercutListPage, PapercutRecordReadModel, PapercutStatusReadModel, StateQLRowsPage, StateQLSnapshot, TimelineCheckpointDiff, TimelineCheckpointFiles, ToolExposureMode, VerifyPolicyReadModel, WorkspacePolicyMode } from "../shared/protocol/snapshots";
import { displayTime, displayTimelineTime, formatDuration } from "./format";
import { formatPolicyTimeout, runtimePolicySources } from "../shared/runtime-policy-format";
import { ActionDialog } from "./action-dialog";
import { RuntimePolicyTimeoutControl } from "./runtime-policy-timeout";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";
import { buildStateQLActivity, filterStateQLActivity, stateqlActivityStatus, type StateQLActivityFilter, type StateQLActivityItem } from "../shared/stateql-notebook";

export type ViewId = "overview" | "policy" | "timeline" | "memory" | "tools";
type Tone = "success" | "warning" | "danger" | "neutral" | "active";
type IconComponent = ComponentType<{ size?: number; stroke?: number; className?: string }>;

const navigation: Array<{ id: ViewId; label: string; icon: IconComponent }> = [
  { id: "overview", label: "Overview", icon: IconLayoutDashboard },
  { id: "policy", label: "Policy", icon: IconAdjustmentsHorizontal },
  { id: "timeline", label: "Timeline", icon: IconTimeline },
  { id: "memory", label: "Memory", icon: IconThinkingMedium },
  { id: "tools", label: "Tools", icon: IconTool },
];

const viewDescriptions: Record<ViewId, string> = {
  overview: "Live state for the active Pylon session.",
  policy: "Project and session behavior. Global defaults live in Settings.",
  timeline: "Recoverable checkpoints across the current run.",
  memory: "Durable project context and workflow friction.",
  tools: "Project and session overrides for registered tools.",
};

interface InspectorProps {
  current: ViewId;
  live: RuntimeStoreSnapshot;
  availableViews: Set<ViewId>;
  timelineEnabled: boolean;
  memoryReviewerConfigured?: boolean;
  memoryEnabled: boolean;
  papercutEnabled: boolean;
  overlay: boolean;
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
  onOpenGlobalPolicy: () => void;
  onOpenMemoryReviewerSettings: () => void;
}

export function Inspector({ current, live, availableViews, timelineEnabled, memoryReviewerConfigured, memoryEnabled, papercutEnabled, overlay, onClose, onNavigate, onOpenGlobalPolicy, onOpenMemoryReviewerSettings }: InspectorProps) {
  const items = navigation.filter((item) => availableViews.has(item.id));
  return (
    <aside id="session-inspector" className="inspector" aria-label="Session inspector">
      <header className="inspector-header">
        <div><span className="section-kicker">Inspector</span></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label={overlay ? "Close inspector" : "Collapse inspector"}><IconX size={17} /></button>
      </header>
      <div className="inspector-tabs" role="tablist" aria-label="Session details">
        {items.map((item) => {
          const Icon = item.icon;
          return <button type="button" role="tab" aria-label={item.label} aria-selected={current === item.id} className={current === item.id ? "is-active" : ""} data-view={item.id} key={item.id} onClick={() => onNavigate(item.id)}>
            <Icon size={14} /><span>{item.label}</span>
          </button>;
        })}
      </div>
      <p className="inspector-description">{viewDescriptions[current]}</p>
      <div className="inspector-scroll" role="tabpanel">
        {current === "overview" && <Overview live={live} />}
        {current === "policy" && live.runtime && <RuntimePolicy live={live} onOpenGlobalPolicy={onOpenGlobalPolicy} />}
        {current === "timeline" && <Timeline live={live} enabled={timelineEnabled} />}
        {current === "memory" && <Memory live={live} memoryEnabled={memoryEnabled} papercutEnabled={papercutEnabled} reviewerConfigured={memoryReviewerConfigured} onOpenReviewerSettings={onOpenMemoryReviewerSettings} />}
        {current === "tools" && <Tools live={live} />}
      </div>
    </aside>
  );
}

function Overview({ live }: { live: RuntimeStoreSnapshot }) {
  const runtime = live.runtime;
  const operational = runtime?.operational;
  const work = operational?.continuity.work;
  const workTone: Tone = work?.mode === "executing" ? "active" : work?.mode === "completed" ? "success" : "neutral";
  return (
    <div className="page-grid">
      <SessionUsage key={runtime?.sessionId ?? "empty"} metrics={runtime?.metrics} />
      <div className="overview-columns">
        {operational?.continuity.availability === "available" && <InspectorSection title="Task List" meta={work ? displayTime(work.updatedAt) : undefined} className="run-panel">
          {work ? <>
            <div className="run-title-row">
              <div className={`run-icon tone-${workTone}`}><IconListCheck size={20} /></div>
              <div><h2 className="run-goal" title={work.goal}>{oneLine(work.goal)}</h2><p className="mono">{work.runId || "Current session"}</p></div>
            </div>
            <div className="run-meta-row">
              <Status tone={workTone}>{work.mode}</Status>
              <span>{work.todos.filter((todo) => todo.status === "done").length} of {work.todos.length} complete</span>
            </div>
            {(work.latestFailure || work.nextAction) && <div className="run-issue" role={work.latestFailure ? "alert" : "status"}>
              {work.latestFailure && <strong>{work.latestFailure}</strong>}
              {work.nextAction && <span>{work.nextAction}</span>}
            </div>}
            <TodoList work={work} />
          </> : <div className="empty-state"><IconListCheck size={20} /><strong>No active work</strong><span>Continuity has no plan for this session.</span></div>}
        </InspectorSection>}

      </div>

      <div className="overview-lower">
        {operational && <InspectorSection title="Verification" meta={operational.verification.state === "running" ? "Running" : operational.verification.scope || "No run"} className="verification-panel">
          <Verification verification={operational.verification} />
        </InspectorSection>}
        {operational?.jobs.availability === "available" && <HeartbeatJobs jobs={operational.jobs.items} />}
      </div>
    </div>
  );
}

function Verification({ verification }: { verification: VerificationReadModel }) {
  const running = verification.state === "running";
  const startedAt = verification.startedAt ? Date.parse(verification.startedAt) : Number.NaN;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (verification.availability !== "available" || !running || Number.isNaN(startedAt)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running, startedAt, verification.availability]);

  if (verification.availability !== "available") {
    return <div className="empty-state"><IconCheck size={20} /><strong>Verification unavailable</strong><span>Verify is unavailable for this runtime.</span></div>;
  }

  const elapsed = Number.isNaN(startedAt) ? verification.durationMs ?? 0 : Math.max(0, now - startedAt);
  return <>
    {running && <div className="verification-run">
      <span className="verification-run-icon"><IconLoader2 size={16} /></span>
      <div role="status"><strong>Verification running</strong><small>{verification.scope ? `${verification.scope} scope` : "Checking project"}</small></div>
      <span className="mono">{formatWorkDuration(elapsed)}</span>
    </div>}
    {verification.checks.length > 0 ? <div className="check-list">
      {verification.checks.map((check) => (
        <div className="check-row" key={check.id}>
          <span className={`check-icon ${check.status}`}>
            {check.status === "passed" ? <IconCheck size={13} /> : <IconClock size={13} />}
          </span>
          <div><strong>{check.label}</strong><small>{check.command || check.status}</small></div>
          <span className="mono">{formatDuration(check.durationMs)}</span>
        </div>
      ))}
    </div> : !running && <div className="empty-state"><IconCheck size={20} /><strong>No verification run yet</strong><span>Results will appear after Verify runs.</span></div>}
  </>;
}

type EditablePolicyScope = "project" | "session";
type TogglePolicyDraft = "inherit" | "enabled" | "disabled";
type TimeoutPolicyDraft = DialogTimeoutSeconds | "inherit";

const workspaceLabels: Record<WorkspacePolicyMode, string> = {
  local: "Local",
  checkout: "Project folder",
  worktree: "Session worktree",
};

function verifyPolicyLabel(value: VerifyPolicyReadModel): string {
  return value.mode === "auto" ? "Automatic detection" : `${value.checks.length} selected check${value.checks.length === 1 ? "" : "s"}`;
}

function togglePolicyLabel(value: boolean): string {
  return value ? "Enabled" : "Disabled";
}

function guardActionLabel(value: GuardAction): string {
  return value === "allow" ? "Allow" : value === "confirm" ? "Confirm" : "Block";
}

function RuntimePolicy({ live, onOpenGlobalPolicy }: { live: RuntimeStoreSnapshot; onOpenGlobalPolicy: () => void }) {
  const runtime = live.runtime!;
  const policy = runtime.runtimePolicy;
  const [scope, setScope] = useState<EditablePolicyScope>("project");
  const [verify, setVerify] = useState<VerifyPolicyReadModel | "inherit">({ mode: "auto" });
  const [timeline, setTimeline] = useState<TogglePolicyDraft>("inherit");
  const [guard, setGuard] = useState<TogglePolicyDraft>("inherit");
  const [guardRules, setGuardRules] = useState<GuardRuleOverrides>({});
  const [workspace, setWorkspace] = useState<WorkspacePolicyMode | "inherit">("inherit");
  const [guardTimeout, setGuardTimeout] = useState<TimeoutPolicyDraft>("inherit");
  const [clarifyTimeout, setClarifyTimeout] = useState<TimeoutPolicyDraft>("inherit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const saveInFlight = useRef(false);
  const saveRequest = useRef(0);

  const resetDraft = () => {
    setVerify(scope === "project" ? policy.project.verify : policy.session.verify ?? "inherit");
    setTimeline(scope === "project"
      ? policy.project.timelineEnabled === undefined ? "inherit" : policy.project.timelineEnabled ? "enabled" : "disabled"
      : policy.session.timelineEnabled === undefined ? "inherit" : policy.session.timelineEnabled ? "enabled" : "disabled");
    setGuard(scope === "project"
      ? policy.project.guardEnabled === undefined ? "inherit" : policy.project.guardEnabled ? "enabled" : "disabled"
      : policy.session.guardEnabled === undefined ? "inherit" : policy.session.guardEnabled ? "enabled" : "disabled");
    setGuardRules({ ...(scope === "project" ? policy.project.guardRules : policy.session.guardRules) });
    setWorkspace(scope === "project" ? policy.project.workspace ?? "inherit" : policy.session.workspace ?? "inherit");
    setGuardTimeout(scope === "project"
      ? policy.project.guardTimeoutSeconds === undefined ? "inherit" : policy.project.guardTimeoutSeconds
      : policy.session.guardTimeoutSeconds === undefined ? "inherit" : policy.session.guardTimeoutSeconds);
    setClarifyTimeout(scope === "project"
      ? policy.project.clarifyTimeoutSeconds === undefined ? "inherit" : policy.project.clarifyTimeoutSeconds
      : policy.session.clarifyTimeoutSeconds === undefined ? "inherit" : policy.session.clarifyTimeoutSeconds);
    setError("");
  };

  useEffect(() => {
    resetDraft();
  }, [policy.revision, scope]);

  const idle = live.connection === "connected"
    && runtime.ready
    && !live.pendingUi
    && !busy;
  const inheritedFrom = scope === "project" ? "Global" : "Project";
  const inheritedTimeline = scope === "project" ? policy.global.timelineEnabled : policy.project.timelineEnabled ?? policy.global.timelineEnabled;
  const inheritedGuard = scope === "project" ? policy.global.guardEnabled : policy.project.guardEnabled ?? policy.global.guardEnabled;
  const draftGuardEnabled = guard === "inherit" ? inheritedGuard : guard === "enabled";
  const globalGuardRules = policy.global.guardRules ?? DEFAULT_GUARD_RULES;
  const inheritedGuardRules = scope === "project"
    ? mergeGuardRules(globalGuardRules)
    : mergeGuardRules(globalGuardRules, policy.project.guardRules ?? {});
  const inheritedWorkspace = scope === "project" ? policy.global.workspace : policy.project.workspace ?? policy.global.workspace;
  const inheritedGuardTimeout = scope === "project" ? policy.global.guardTimeoutSeconds : policy.project.guardTimeoutSeconds ?? policy.global.guardTimeoutSeconds;
  const inheritedClarifyTimeout = scope === "project" ? policy.global.clarifyTimeoutSeconds : policy.project.clarifyTimeoutSeconds ?? policy.global.clarifyTimeoutSeconds;
  const displayedVerify = verify === "inherit" ? policy.project.verify : verify;
  const checks = displayedVerify.mode === "selected" ? displayedVerify.checks : [];

  const save = async (
    nextVerify: VerifyPolicyReadModel | "inherit",
    nextTimeline: TogglePolicyDraft,
    nextWorkspace: WorkspacePolicyMode | "inherit" = workspace,
    nextGuardTimeout: TimeoutPolicyDraft = guardTimeout,
    nextClarifyTimeout: TimeoutPolicyDraft = clarifyTimeout,
    nextGuard: TogglePolicyDraft = guard,
    nextGuardRules: GuardRuleOverrides = guardRules,
  ) => {
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    const request = ++saveRequest.current;
    setVerify(nextVerify);
    setTimeline(nextTimeline);
    setGuard(nextGuard);
    setGuardRules(nextGuardRules);
    setWorkspace(nextWorkspace);
    setGuardTimeout(nextGuardTimeout);
    setClarifyTimeout(nextClarifyTimeout);
    setBusy(true);
    setError("");
    try {
      await runtimeStore.updateRuntimePolicy(
        scope,
        nextVerify,
        nextTimeline === "inherit" ? "inherit" : nextTimeline === "enabled",
        nextGuard === "inherit" ? "inherit" : nextGuard === "enabled",
        nextWorkspace,
        nextGuardTimeout,
        nextClarifyTimeout,
        policy.revision,
        nextGuardRules,
      );
    } catch (cause) {
      if (request === saveRequest.current) {
        resetDraft();
        setError(cause instanceof Error ? cause.message : "Policy could not be saved");
      }
      throw cause;
    } finally {
      if (request === saveRequest.current) {
        saveInFlight.current = false;
        setBusy(false);
      }
    }
  };

  const changeVerifyMode = (mode: "inherit" | "auto" | "selected") => {
    const next = mode === "inherit"
      ? "inherit" as const
      : mode === "auto"
        ? { mode: "auto" } as const
        : { mode: "selected", checks: displayedVerify.mode === "selected"
          ? displayedVerify.checks
          : policy.availableVerifyChecks.slice(0, 6).map((check) => check.id) } as const;
    void save(next, timeline, workspace).catch(() => undefined);
  };

  const toggleCheck = (id: string) => {
    const next = checks.includes(id)
      ? checks.filter((item) => item !== id)
      : checks.length < 6 ? [...checks, id] : checks;
    if (next === checks) return;
    void save({ mode: "selected", checks: next }, timeline, workspace).catch(() => undefined);
  };

  const sources = runtimePolicySources(policy);
  const effectiveItems = [
    { label: "Verify", value: verifyPolicyLabel(policy.effective.verify), source: sources.verify },
    { label: "Guard", value: togglePolicyLabel(policy.effective.guardEnabled), source: sources.guard },
    { label: "Timeline", value: togglePolicyLabel(policy.effective.timelineEnabled), source: sources.timeline },
    { label: "Workspace", value: workspaceLabels[policy.effective.workspace], source: sources.workspace },
    { label: "Guard wait", value: formatPolicyTimeout(policy.effective.guardTimeoutSeconds), source: sources.guardTimeout },
    { label: "Clarify wait", value: formatPolicyTimeout(policy.effective.clarifyTimeoutSeconds), source: sources.clarifyTimeout },
  ];

  return <InspectorSection title="Runtime Policy" className="runtime-policy">
    <div className="policy-toolbar">
      <div className="policy-scope" role="tablist" aria-label="Policy scope">
        <button type="button" role="tab" disabled={busy} aria-selected={scope === "project"} className={scope === "project" ? "is-active" : ""} onClick={() => setScope("project")}>Project</button>
        <button type="button" role="tab" disabled={busy} aria-selected={scope === "session"} className={scope === "session" ? "is-active" : ""} onClick={() => setScope("session")}>This session</button>
      </div>
      <button className="policy-global-link" type="button" disabled={busy} onClick={onOpenGlobalPolicy}>Global defaults <span aria-hidden="true">›</span></button>
    </div>

    <section className="policy-effective" aria-labelledby="policy-effective-title">
      <div className="policy-effective-header"><strong id="policy-effective-title">Effective for this session</strong><small>Value and source</small></div>
      <div className="policy-effective-grid">
        {effectiveItems.map((item) => <div key={item.label}><span>{item.label}</span><strong>{item.value}</strong><small>{item.source}</small></div>)}
      </div>
    </section>

    <section className="policy-group" aria-labelledby="policy-verify-title">
      <header><strong id="policy-verify-title">Verification</strong><small>Choose automatic detection or up to six declared checks.</small></header>
      <div className="policy-field">
        <div><strong>Verify checks</strong><small>{scope === "project" ? "Choose verification for this project." : "This session can inherit the Project choice."}</small></div>
        <div className="policy-field-control">
          <select value={verify === "inherit" ? "inherit" : verify.mode} disabled={!idle} aria-label="Verify policy" onChange={(event) => changeVerifyMode(event.target.value as "inherit" | "auto" | "selected")}>
            {scope === "session" && <option value="inherit">Inherit from Project ({verifyPolicyLabel(policy.project.verify)})</option>}
            <option value="auto">Automatic detection</option>
            <option value="selected">Selected checks</option>
          </select>
          <small>{scope === "project" ? "Required project policy" : verify === "inherit" ? `From Project · ${verifyPolicyLabel(policy.project.verify)}` : "Session override"}</small>
        </div>
      </div>
      {verify !== "inherit" && verify.mode === "selected" && <div className="policy-checks">
        {policy.availableVerifyChecks.map((check) => <label key={check.id} title={check.command}>
          <input type="checkbox" checked={checks.includes(check.id)} disabled={!idle || !checks.includes(check.id) && checks.length >= 6} onChange={() => toggleCheck(check.id)} />
          <span className="mono">{check.label}</span>
        </label>)}
        {checks.filter((id) => !policy.availableVerifyChecks.some((check) => check.id === id))
          .map((id) => <label className="is-missing" key={id}><input type="checkbox" checked disabled={!idle} onChange={() => toggleCheck(id)} /><span>Unknown: {id}</span></label>)}
        {policy.availableVerifyChecks.length === 0 && <small>No declared checks detected. Changed-set hygiene will still run.</small>}
      </div>}
    </section>

    <section className="policy-group" aria-labelledby="policy-safety-title">
      <header><strong id="policy-safety-title">Safety and interaction</strong><small>Control approvals, questions, and recoverable session history.</small></header>
      <PolicySelectField
        label="Guard"
        description="Confirm guarded commands and paths."
        value={guard}
        inheritedLabel={`Inherit from ${inheritedFrom} (${togglePolicyLabel(inheritedGuard)})`}
        disabled={!idle}
        options={[{ value: "enabled", label: "Enabled" }, { value: "disabled", label: "Disabled" }]}
        onChange={(value) => void save(verify, timeline, workspace, guardTimeout, clarifyTimeout, value as TogglePolicyDraft).catch(() => undefined)}
      />
      <details className="policy-disclosure">
        <summary>
          <span><strong>Guard categories</strong><small>Choose which risks inherit, allow, confirm, or block.</small></span>
          <small>{Object.keys(guardRules).length} override{Object.keys(guardRules).length === 1 ? "" : "s"}</small>
        </summary>
        <div className="policy-disclosure-body">
          {!draftGuardEnabled && <p className="policy-guard-disabled" role="status">Guard is disabled by {guard === "inherit" ? `${inheritedFrom} policy` : "this scope"}. Saved category rules apply when Guard is enabled.</p>}
          {GUARD_RISK_CATEGORIES.map((category) => {
            const effective = resolveGuardRule(
              category,
              globalGuardRules,
              scope === "project" ? guardRules : policy.project.guardRules,
              scope === "session" ? guardRules : policy.session.guardRules,
            );
            return <PolicySelectField
              key={category}
              label={GUARD_RULE_LABELS[category]}
              description={GUARD_RULE_DESCRIPTIONS[category]}
              value={guardRules[category] ?? "inherit"}
              inheritedLabel={`Use ${inheritedFrom} policy (${guardActionLabel(inheritedGuardRules[category])})`}
              stateLabel={`Effective this session · ${guardActionLabel(effective.value)} · ${effective.source}`}
              disabled={!idle || !draftGuardEnabled}
              options={GUARD_ACTIONS.map((action) => ({ value: action, label: guardActionLabel(action) }))}
              onChange={(value) => {
                const next = { ...guardRules };
                if (value === "inherit") delete next[category];
                else next[category] = value as GuardAction;
                void save(verify, timeline, workspace, guardTimeout, clarifyTimeout, guard, next).catch(() => undefined);
              }}
            />;
          })}
        </div>
      </details>
      <RuntimePolicyTimeoutControl
        label="Guard timeout"
        value={guardTimeout === "inherit" ? inheritedGuardTimeout : guardTimeout}
        inheritedFrom={guardTimeout === "inherit" ? inheritedFrom : undefined}
        disabled={!idle || !draftGuardEnabled}
        onChange={(value) => void save(verify, timeline, workspace, value, clarifyTimeout).catch(() => undefined)}
        onReset={guardTimeout !== "inherit" ? () => void save(verify, timeline, workspace, "inherit", clarifyTimeout).catch(() => undefined) : undefined}
      />
      <RuntimePolicyTimeoutControl
        label="Clarify timeout"
        value={clarifyTimeout === "inherit" ? inheritedClarifyTimeout : clarifyTimeout}
        inheritedFrom={clarifyTimeout === "inherit" ? inheritedFrom : undefined}
        disabled={!idle}
        onChange={(value) => void save(verify, timeline, workspace, guardTimeout, value).catch(() => undefined)}
        onReset={clarifyTimeout !== "inherit" ? () => void save(verify, timeline, workspace, guardTimeout, "inherit").catch(() => undefined) : undefined}
      />
      <PolicySelectField
        label="Timeline"
        description="Keep recoverable checkpoints for this run."
        value={timeline}
        inheritedLabel={`Inherit from ${inheritedFrom} (${togglePolicyLabel(inheritedTimeline)})`}
        disabled={!idle}
        options={[{ value: "enabled", label: "Enabled" }, { value: "disabled", label: "Disabled" }]}
        onChange={(value) => void save(verify, value as TogglePolicyDraft, workspace).catch(() => undefined)}
      />
    </section>

    <section className="policy-group" aria-labelledby="policy-environment-title">
      <header><strong id="policy-environment-title">Environment</strong><small>Session changes apply immediately when possible.</small></header>
      <PolicySelectField
        label="Workspace"
        description="Choose where this scope works by default."
        value={workspace}
        inheritedLabel={`Inherit from ${inheritedFrom} (${workspaceLabels[inheritedWorkspace]})`}
        disabled={!idle}
        options={Object.entries(workspaceLabels).map(([value, label]) => ({ value, label }))}
        onChange={(value) => void save(verify, timeline, value as WorkspacePolicyMode | "inherit").catch(() => undefined)}
      />
    </section>

    {error && <p className="policy-error" role="alert">{error}</p>}
    {busy && <small className="policy-saving" role="status">Saving…</small>}
  </InspectorSection>;
}

function PolicySelectField({ label, description, value, inheritedLabel, stateLabel, disabled, options, onChange }: {
  label: string;
  description: string;
  value: string;
  inheritedLabel: string;
  stateLabel?: string;
  disabled: boolean;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const descriptionId = useId();
  const stateId = useId();
  return <div className="policy-field">
    <div><strong>{label}</strong><small id={descriptionId}>{description}</small></div>
    <div className="policy-field-control">
      <select value={value} disabled={disabled} aria-label={`${label} policy`} aria-describedby={`${descriptionId} ${stateId}`} onChange={(event) => onChange(event.target.value)}>
        <option value="inherit">{inheritedLabel}</option>
        {options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
      </select>
      <small id={stateId}>{stateLabel ?? (value === "inherit" ? inheritedLabel.replace("Inherit from ", "From ") : "Override")}</small>
    </div>
  </div>;
}

function Memory({ live, memoryEnabled, papercutEnabled, reviewerConfigured, onOpenReviewerSettings }: {
  live: RuntimeStoreSnapshot;
  memoryEnabled: boolean;
  papercutEnabled: boolean;
  reviewerConfigured?: boolean;
  onOpenReviewerSettings: () => void;
}) {
  const [view, setView] = useState<"memory" | "papercuts">(memoryEnabled ? "memory" : "papercuts");
  const continuity = live.runtime?.operational.continuity;
  const memoryCount = continuity ? continuity.memory.length + continuity.globalMemory.length : undefined;
  const papercutCount = live.runtime?.operational.papercuts.counts.total;
  useEffect(() => {
    if (view === "memory" && !memoryEnabled && papercutEnabled) setView("papercuts");
    if (view === "papercuts" && !papercutEnabled && memoryEnabled) setView("memory");
  }, [memoryEnabled, papercutEnabled, view]);
  return <div className="memory-page">
    {memoryEnabled && papercutEnabled && <nav className="memory-archive-nav" aria-label="Memory view">
      <button type="button" aria-pressed={view === "memory"} onClick={() => setView("memory")}>
        <span><strong>Memory</strong><span className="mono">{memoryCount ?? "–"}</span></span><small>Guidance retained across sessions</small>
      </button>
      <button type="button" aria-pressed={view === "papercuts"} onClick={() => setView("papercuts")}>
        <span><strong>Papercuts</strong><span className="mono">{papercutCount ?? "–"}</span></span><small>Workflow friction to resolve</small>
      </button>
    </nav>}
    {view === "memory" && memoryEnabled && <ContinuityMemory live={live} reviewerConfigured={reviewerConfigured} onOpenReviewerSettings={onOpenReviewerSettings} />}
    {view === "papercuts" && papercutEnabled && <Papercuts live={live} />}
  </div>;
}

function Papercuts({ live }: { live: RuntimeStoreSnapshot }) {
  const summary = live.runtime?.operational.papercuts;
  const [status, setStatus] = useState<PapercutStatusReadModel | "all">("open");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<PapercutListPage>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState("");
  const [deleting, setDeleting] = useState<PapercutRecordReadModel>();
  const [mutationError, setMutationError] = useState("");
  const generation = live.runtime?.sessionGeneration;
  const requestVersion = useRef(0);

  useEffect(() => {
    const timeout = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timeout);
  }, [search]);
  useEffect(() => {
    const request = ++requestVersion.current;
    if (live.connection !== "connected" || !live.runtime?.ready) { setPage(undefined); setLoading(false); return; }
    const controller = new AbortController();
    setPage(undefined); setLoading(true); setLoadingMore(false); setError("");
    void runtimeStore.papercuts(status, query, 0, 25, controller.signal)
      .then((result) => { if (requestVersion.current === request) setPage(result); })
      .catch((cause) => { if (!controller.signal.aborted && requestVersion.current === request) setError(cause instanceof Error ? cause.message : "Unable to load papercuts"); })
      .finally(() => { if (!controller.signal.aborted && requestVersion.current === request) setLoading(false); });
    return () => controller.abort();
  }, [generation, live.connection, live.runtime?.ready, query, refresh, status, summary?.revision]);

  const loadMore = async () => {
    if (page?.nextOffset === null || page?.nextOffset === undefined || loadingMore) return;
    setLoadingMore(true); setError("");
    const request = requestVersion.current;
    try {
      const next = await runtimeStore.papercuts(status, query, page.nextOffset, page.limit);
      if (requestVersion.current !== request) return;
      if (next.revision !== page.revision) { setRefresh((value) => value + 1); return; }
      setPage({ ...next, offset: 0, records: [...page.records, ...next.records] });
    } catch (cause) { if (requestVersion.current === request) setError(cause instanceof Error ? cause.message : "Unable to load more papercuts"); }
    finally { setLoadingMore(false); }
  };
  const count = (value: PapercutStatusReadModel | "all") => value === "all" ? summary?.counts.total : summary?.counts[value];
  const outcome = (record: PapercutRecordReadModel) => record.status === "resolved" ? record.resolution : record.status === "dismissed" ? record.dismissal : undefined;
  const canMutate = live.connection === "connected" && live.runtime?.ready === true && !busy;
  const beginEdit = (record: PapercutRecordReadModel) => { setEditing(record.id); setDraft(record.message); setMutationError(""); };
  const save = async (record: PapercutRecordReadModel) => {
    if (!canMutate || !draft.trim()) return;
    setBusy(record.id); setMutationError("");
    try {
      await runtimeStore.updatePapercut(record, draft.trim());
      setEditing("");
      setRefresh((value) => value + 1);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to update papercut";
      setMutationError(message);
      if (/changed or was removed/i.test(message)) setRefresh((value) => value + 1);
    } finally { setBusy(""); }
  };
  const remove = async (record: PapercutRecordReadModel) => {
    if (!canMutate) return;
    setBusy(record.id); setMutationError("");
    try {
      await runtimeStore.deletePapercut(record);
      setEditing(""); setDeleting(undefined);
      setRefresh((value) => value + 1);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to delete papercut";
      setMutationError(message); setDeleting(undefined);
      if (/changed or was removed/i.test(message)) setRefresh((value) => value + 1);
    } finally { setBusy(""); }
  };

  return <div className="memory-ledger papercut-ledger">
    <div className="papercut-toolbar">
      <div className="papercut-status" role="group" aria-label="Papercut status">
        {(["open", "resolved", "dismissed", "all"] as const).map((value) => <button type="button" aria-pressed={status === value} className={status === value ? "is-active" : ""} key={value} onClick={() => setStatus(value)}>
          {value}<span className="mono">{count(value) ?? "–"}</span>
        </button>)}
      </div>
      <button className="icon-button" type="button" aria-label="Refresh papercuts" disabled={loading} onClick={() => setRefresh((value) => value + 1)}><IconRefresh size={14} /></button>
    </div>
    <label className="memory-ledger-search">
      <IconSearch size={13} /><span className="sr-only">Search papercuts</span>
      <input type="search" value={search} maxLength={200} placeholder="Search papercuts" onChange={(event) => setSearch(event.target.value)} />
      <span className="mono">{page?.total ?? 0}</span>
    </label>
    {loading && !page && <div className="memory-ledger-no-results"><IconLoader2 className="spin" size={18} /><strong>Loading papercuts</strong></div>}
    {!loading && error && !page && <div className="memory-ledger-no-results"><IconAlertTriangle size={18} /><strong>Papercuts unavailable</strong><span>{error}</span></div>}
    {!loading && !error && page?.records.length === 0 && <div className="memory-ledger-empty"><strong>{query ? "No matching papercuts" : `No ${status === "all" ? "stored" : status} papercuts`}</strong><span>{query ? "Try a different search." : "Captured workflow friction will appear here."}</span></div>}
    {page && page.records.length > 0 && <div className="memory-ledger-list">{page.records.map((record) => {
      const isEditing = editing === record.id;
      return <details className="memory-ledger-row papercut-row" key={record.id} open={isEditing || undefined}>
        <summary>
          <span className="memory-archive-kind">{record.status}{record.occurrences > 1 ? ` · ${record.occurrences}×` : ""}</span>
          <div className="memory-archive-copy"><strong>{record.message}</strong><p>{outcome(record) ?? `Last seen ${displayTime(record.lastSeenAt)}`}</p></div>
          <IconChevronDown className="memory-ledger-chevron" size={13} />
        </summary>
        <div className="memory-ledger-detail">{isEditing ? <div className="memory-editor">
          <label>Message<textarea value={draft} maxLength={500} rows={4} disabled={Boolean(busy)} onChange={(event) => setDraft(event.target.value)} /></label>
          <div><button className="primary-button" type="button" disabled={!canMutate || !draft.trim()} onClick={() => void save(record)}>{busy === record.id ? "Saving…" : "Save"}</button><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => setEditing("")}>Cancel</button></div>
        </div> : <>
          <dl>
            <div><dt>ID</dt><dd title={record.id}>{record.id.slice(0, 8)}</dd></div>
            <div><dt>Created</dt><dd><time dateTime={record.createdAt}>{displayTime(record.createdAt)}</time></dd></div>
            <div><dt>Last seen</dt><dd><time dateTime={record.lastSeenAt}>{displayTime(record.lastSeenAt)}</time></dd></div>
            <div><dt>Occurrences</dt><dd>{record.occurrences}</dd></div>
            {outcome(record) && <div><dt>{record.status === "resolved" ? "Resolution" : "Dismissal"}</dt><dd title={outcome(record)}>{outcome(record)}</dd></div>}
          </dl>
          <footer><button className="text-button" type="button" disabled={!canMutate} onClick={() => beginEdit(record)}>Edit</button><button className="text-button danger" type="button" disabled={!canMutate} onClick={() => { setMutationError(""); setDeleting(record); }}><IconTrash size={13} />Delete</button></footer>
        </>}</div>
      </details>;
    })}</div>}
    {page?.nextOffset !== null && page?.nextOffset !== undefined && <button className="session-usage-expand" type="button" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : `Load more · ${page.records.length}/${page.total}`}</button>}
    {error && page && <p className="ui-request-error" role="alert">{error}</p>}
    {mutationError && <p className="ui-request-error" role="alert">{mutationError}</p>}
    {deleting && <ActionDialog
      title="Delete papercut?"
      description="This papercut will be permanently removed from the project backlog."
      confirmLabel="Delete papercut" busyLabel="Deleting…" busy={busy === deleting.id} danger
      onCancel={() => setDeleting(undefined)} onConfirm={() => void remove(deleting)}
    />}
  </div>;
}


function ContinuityMemory({ live, reviewerConfigured, onOpenReviewerSettings }: { live: RuntimeStoreSnapshot; reviewerConfigured?: boolean; onOpenReviewerSettings: () => void }) {
  const continuity = live.runtime?.operational.continuity;
  const memory = continuity?.memory ?? [];
  const globalMemory = live.runtime?.operational.continuity.globalMemory ?? [];
  const [editing, setEditing] = useState("");
  const [trigger, setTrigger] = useState("");
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState("");
  const [deleting, setDeleting] = useState<ContinuityMemoryNoteReadModel>();
  const [confirmingMigration, setConfirmingMigration] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const noteKey = (note: ContinuityMemoryNoteReadModel) => `${note.scope}:${note.id}`;
  const query = search.trim().toLowerCase();
  const matches = (note: ContinuityMemoryNoteReadModel) => !query || [note.trigger, note.guidance, note.authority, note.origin, ...(note.relatedPaths ?? [])]
    .some((value) => value.toLowerCase().includes(query));
  const visibleGlobalMemory = globalMemory.filter(matches);
  const visibleMemory = memory.filter(matches);
  const total = globalMemory.length + memory.length;
  const shown = visibleGlobalMemory.length + visibleMemory.length;
  const idle = live.connection === "connected" && live.runtime?.ready === true
    && live.runtime.conversation.streaming === false && !live.pendingUi && !busy;
  const edit = (note: ContinuityMemoryNoteReadModel) => {
    setEditing(noteKey(note)); setTrigger(note.trigger); setGuidance(note.guidance); setError("");
  };
  const save = async (note: ContinuityMemoryNoteReadModel) => {
    if (!idle || !trigger.trim() || !guidance.trim()) return;
    setBusy(noteKey(note)); setError("");
    try {
      await runtimeStore.updateContinuityMemory(note, trigger.trim(), guidance.trim());
      setEditing("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update memory");
      if (cause instanceof Error && /\b(?:stale|changed|revision)\b/i.test(cause.message)) setEditing("");
    } finally { setBusy(""); }
  };
  const remove = async (note: ContinuityMemoryNoteReadModel) => {
    if (!idle) return;
    setBusy(noteKey(note)); setError("");
    try {
      await runtimeStore.deleteContinuityMemory(note);
      setEditing("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete memory");
    } finally { setBusy(""); setDeleting(undefined); }
  };
  const migrate = async () => {
    if (!idle || reviewerConfigured !== true) return;
    setBusy("migration"); setError("");
    try { await runtimeStore.migrateContinuityMemory(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to migrate V4 memory"); }
    finally { setBusy(""); setConfirmingMigration(false); }
  };
  const rows = (notes: ContinuityMemoryNoteReadModel[]) => notes.map((note) => {
    const key = noteKey(note);
    const isEditing = editing === key;
    return <details className="memory-ledger-row" key={key} open={isEditing || undefined}>
      <summary>
        <span className="memory-archive-kind">{note.scope === "user" ? "Global" : "Project"}</span>
        <div className="memory-archive-copy"><strong>{note.trigger}</strong><p>{note.guidance}</p></div>
        <IconChevronDown className="memory-ledger-chevron" size={13} />
      </summary>
      <div className="memory-ledger-detail">
        {isEditing ? <div className="memory-editor">
          <label>Trigger<input value={trigger} maxLength={240} disabled={Boolean(busy)} onChange={(event) => setTrigger(event.target.value)} /></label>
          <label>Guidance<textarea value={guidance} maxLength={800} rows={5} disabled={Boolean(busy)} onChange={(event) => setGuidance(event.target.value)} /></label>
          <div><button className="primary-button" type="button" disabled={!idle || !trigger.trim() || !guidance.trim() || trigger.trim().length + guidance.trim().length > 1_000} onClick={() => void save(note)}>{busy === key ? "Saving…" : "Save"}</button><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => setEditing("")}>Cancel</button></div>
        </div> : <>
          <dl>
            <div><dt>Authority</dt><dd>{note.authority.replaceAll("_", " ")}</dd></div>
            <div><dt>Origin</dt><dd>{note.origin}</dd></div>
            <div><dt>Updated</dt><dd><time dateTime={note.updatedAt}>{displayTime(note.updatedAt)}</time></dd></div>
            <div><dt>Source summary</dt><dd title={note.sourceSummary}>{note.sourceSummary}</dd></div>
            <div><dt>Related paths</dt><dd title={(note.relatedPaths ?? []).join("\n")}>{note.relatedPaths?.length ? note.relatedPaths.join(", ") : "None"}</dd></div>
          </dl>
          <footer><button className="text-button" type="button" disabled={!idle} onClick={() => edit(note)}>Edit</button><button className="text-button danger" type="button" disabled={!idle} onClick={() => { setError(""); setDeleting(note); }}><IconTrash size={13} />Delete</button></footer>
        </>}
      </div>
    </details>;
  });
  if (live.runtime?.operational.continuity.availability === "unavailable") return <FeatureUnavailable name="Continuity memory" />;
  return <div className="memory-ledger">
    {reviewerConfigured === false && <div className="memory-reviewer-warning" role="status">
      <IconAlertTriangle size={15} />
      <span><strong>Memory Reviewer is not configured.</strong> New memories proposed by the model will not be stored.</span>
    </div>}
    {continuity?.v4MigrationAvailable && <div className="memory-migration-banner" role="status">
      <div><IconRestore size={16} /><span><strong>Previous memory found</strong><small>Review and migrate preserved V4 notes into the V5 notebook.</small></span></div>
      <button className="secondary-button" type="button" disabled={!idle || reviewerConfigured === undefined}
        onClick={() => reviewerConfigured === false ? onOpenReviewerSettings() : setConfirmingMigration(true)}>
        {reviewerConfigured === false ? "Select Memory Reviewer" : reviewerConfigured === undefined ? "Loading settings…" : "Migrate memory"}
      </button>
    </div>}
    <label className="memory-ledger-search">
      <IconSearch size={13} /><span className="sr-only">Search memory</span>
      <input type="search" value={search} placeholder={`Search ${total} note${total === 1 ? "" : "s"}`} onChange={(event) => setSearch(event.target.value)} />
      <span className="mono">{query ? `${shown}/${total}` : total}</span>
    </label>
    {shown > 0 && <section className="memory-ledger-list" aria-label="Memory archive">{rows([...visibleMemory, ...visibleGlobalMemory])}</section>}
    {!query && total === 0 && <div className="memory-ledger-empty"><strong>No saved memory</strong><span>Continuity has not saved durable guidance for this project or user.</span></div>}
    {query && shown === 0 && <div className="memory-ledger-no-results"><IconSearch size={18} /><strong>No matching memory</strong><span>Try a trigger, guidance, authority, origin, or related path.</span></div>}
    {!idle && total > 0 && <p className="settings-note" role="status">Memory changes are available when the session is idle.</p>}
    {error && <p className="ui-request-error" role="alert">{error}</p>}
    {deleting && <ActionDialog
      title={`Delete ${deleting.scope === "user" ? "global" : "project"} memory?`}
      description={deleting.scope === "user" ? "This rule will be removed from every project." : "This rule will be removed from this project."}
      confirmLabel="Delete memory" busyLabel="Deleting…" busy={busy === noteKey(deleting)} danger
      onCancel={() => setDeleting(undefined)} onConfirm={() => void remove(deleting)}
    />}
    {confirmingMigration && <ActionDialog
      title="Migrate previous memory?"
      description="The configured Memory Reviewer will keep, revise, or reject each V4 note. Backups remain available for rollback until the next V5 write."
      confirmLabel="Migrate memory" busyLabel="Migrating…" busy={busy === "migration"}
      onCancel={() => setConfirmingMigration(false)} onConfirm={() => void migrate()}
    />}
  </div>;
}

export function StateQLWorkspace({ live, onClose }: { live: RuntimeStoreSnapshot; onClose: () => void }) {
  const snapshotScope = `${live.connection}:${live.runtime?.ready ?? false}:${live.runtime?.sessionGeneration ?? "none"}:${live.runtime?.sessionId ?? "none"}`;
  const [snapshotState, setSnapshotState] = useState<{ scope: string; value: StateQLSnapshot }>();
  const snapshot = snapshotState?.scope === snapshotScope ? snapshotState.value : undefined;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [activityFilter, setActivityFilter] = useState<StateQLActivityFilter>("all");
  const [expandedActivity, setExpandedActivity] = useState<Set<string>>(new Set());
  const toolRevision = useMemo(() => (live.runtime?.conversation.tools ?? [])
    .filter((tool) => tool.name === "stateql" && tool.status !== "running")
    .map((tool) => `${tool.id}:${tool.status}`)
    .join("|"), [live.runtime?.conversation.tools]);

  useEffect(() => {
    setLoading(true);
    setError("");
    if (live.connection !== "connected" || !live.runtime?.ready) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    void runtimeStore.stateqlSnapshot(50, controller.signal)
      .then((value) => {
        if (!active) return;
        setSnapshotState({ scope: snapshotScope, value });
        const first = buildStateQLActivity(value)[0];
        setExpandedActivity(first ? new Set([first.id]) : new Set());
      })
      .catch((cause) => {
        if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "StateQL status failed to load");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [live.connection, live.runtime?.ready, live.runtime?.sessionId, live.runtime?.sessionGeneration, refresh, toolRevision]);

  const activity = useMemo(() => snapshot ? buildStateQLActivity(snapshot) : [], [snapshot]);
  const visibleActivity = useMemo(() => filterStateQLActivity(activity, activityFilter), [activity, activityFilter]);
  const visibleHistory = visibleActivity.filter((item) => item.source === "history");
  const visibleMetadata = visibleActivity.filter((item) => item.source === "metadata");
  const historyCount = activity.filter((item) => item.source === "history").length;
  const metadataCount = activity.length - historyCount;
  const allVisibleExpanded = visibleActivity.length > 0 && visibleActivity.every((item) => expandedActivity.has(item.id));
  const rowsScope = `${live.runtime?.sessionGeneration ?? "none"}:${live.runtime?.sessionId ?? "none"}`;
  const header = <header className="stateql-ledger-header">
    <div><h1 id="database-panel-title">Database</h1><span>{snapshot?.session.name ?? "Command ledger"}</span></div>
    <span className="stateql-ledger-header-spacer" />
    <button className="text-button" type="button" disabled={loading || !snapshot} aria-live="polite" onClick={() => setRefresh((value) => value + 1)}>
      {loading ? <IconLoader2 className="spin" size={14} /> : <IconRefresh size={14} />}{loading ? "Refreshing" : "Refresh"}
    </button>
    <button className="icon-button" type="button" onClick={onClose} aria-label="Close database"><IconX size={17} /></button>
  </header>;

  if (!snapshot) return <div className="stateql-workspace">
    {header}
    <div className="stateql-ledger-empty">
      {loading ? <IconLoader2 className="spin" size={20} /> : <IconDatabase size={20} />}
      <strong>{loading ? "Loading StateQL" : "StateQL unavailable"}</strong>
      <span>{loading ? "Reading bounded local status and history." : error || "No StateQL snapshot is available for this actor."}</span>
    </div>
  </div>;

  const connection = snapshot.connection;
  const mode = connection ? `${connection.driver} / ${connection.read_only ? "read-only" : "read-write"}` : "disconnected";
  const toggleAll = () => setExpandedActivity((current) => {
    if (allVisibleExpanded) return new Set([...current].filter((id) => !visibleActivity.some((item) => item.id === id)));
    return new Set([...current, ...visibleActivity.map((item) => item.id)]);
  });
  const setExpanded = (item: StateQLActivityItem, open: boolean) => setExpandedActivity((current) => {
    const next = new Set(current);
    if (open) next.add(item.id); else next.delete(item.id);
    return next;
  });

  return <div className="stateql-workspace">
    {header}
    <section className="stateql-connection-strip" aria-label="Database context">
      <div className="stateql-connection-primary">
        <strong className="mono" title={connection?.name}>{connection?.name ?? "No active connection"}</strong>
        <span className={connection ? "is-connected" : ""}>{mode}</span>
      </div>
      <dl>
        <div><dt>Database</dt><dd className="mono" title={connection?.database}>{connection?.database ?? "Unavailable"}</dd></div>
        <div><dt>Transaction</dt><dd>{snapshot.transaction?.state ?? "None"}</dd></div>
        <div><dt>State</dt><dd className="mono">{snapshot.state_version ?? "Unavailable"}</dd></div>
        <div><dt>Confidence</dt><dd>{snapshot.state_confidence ?? "Unavailable"}</dd></div>
      </dl>
      <span className="stateql-ledger-actor mono" title={snapshot.actor_id}>Actor {snapshot.actor_id}</span>
    </section>
    {error && <p className="stateql-ledger-error" role="alert">Refresh failed. Showing the last available snapshot. {error}</p>}
    <section className="stateql-ledger-body" aria-labelledby="stateql-activity-title">
      <header className="stateql-ledger-toolbar">
        <h2 id="stateql-activity-title">Session activity</h2>
        <span className="mono">{historyCount} / {metadataCount} history / retained</span>
        <div className="stateql-ledger-filters" role="group" aria-label="Filter database activity">
          {(["all", "read", "write", "error"] as const).map((filter) => {
            const count = filterStateQLActivity(activity, filter).length;
            return <button type="button" aria-pressed={activityFilter === filter} key={filter} onClick={() => setActivityFilter(filter)}>
              {filter === "all" ? "All" : filter === "read" ? "Reads" : filter === "write" ? "Writes" : "Errors"}<span>{count}</span>
            </button>;
          })}
        </div>
        <button className="text-button stateql-expand-all" type="button" disabled={visibleActivity.length === 0} onClick={toggleAll}>{allVisibleExpanded ? "Collapse all" : "Expand all"}</button>
      </header>
      {visibleActivity.length > 0 ? <div className="stateql-ledger-scroll" role="region" aria-label="Scrollable database activity ledger" tabIndex={0}>
        <table className="stateql-ledger-table">
          <caption className="sr-only">Bounded StateQL session history and retained metadata</caption>
          <colgroup><col className="toggle" /><col className="command" /><col className="handle" /><col className="actor" /><col className="status" /><col className="time" /></colgroup>
          <thead><tr><th aria-label="Expand activity" /><th>Command</th><th>Handle</th><th>Actor</th><th>Status</th><th>Time</th></tr></thead>
          <tbody>
            {visibleHistory.map((item) => <StateQLLedgerItem item={item} expanded={expandedActivity.has(item.id)} key={item.id} rowsScope={rowsScope} onExpandedChange={(open) => setExpanded(item, open)} />)}
            {visibleMetadata.length > 0 && <tr className="stateql-ledger-metadata"><td colSpan={6}>Recent metadata without timestamp</td></tr>}
            {visibleMetadata.map((item) => <StateQLLedgerItem item={item} expanded={expandedActivity.has(item.id)} key={item.id} rowsScope={rowsScope} onExpandedChange={(open) => setExpanded(item, open)} />)}
          </tbody>
        </table>
      </div> : <div className="stateql-ledger-empty">
        <IconClock size={20} /><strong>No matching activity</strong><span>{activity.length === 0 ? "Commands run in this shared workspace will appear here." : `No ${activityFilter} activity is available in the bounded snapshot.`}</span>
      </div>}
    </section>
  </div>;
}

function stateqlExecution(item: StateQLActivityItem): string {
  return item.source === "metadata" ? "History unavailable" : item.cached ? "cache hit" : item.executed ? "database executed" : item.success ? "completed" : "failed";
}

function StateQLLedgerItem({ item, expanded, rowsScope, onExpandedChange }: { item: StateQLActivityItem; expanded: boolean; rowsScope: string; onExpandedChange: (open: boolean) => void }) {
  const status = stateqlActivityStatus(item);
  const kind = item.tags.includes("error") ? "error" : item.tags.includes("write") ? "write" : item.tags.includes("read") ? "read" : "other";
  const marker = kind === "error" ? "!" : kind === "write" ? "W" : kind === "read" ? "Q" : "M";
  const detailId = `stateql-detail-${encodeURIComponent(item.id)}`;
  return <>
    <tr className={`stateql-ledger-row is-${kind} ${expanded ? "is-expanded" : ""}`} onClick={() => onExpandedChange(!expanded)}>
      <td><button type="button" aria-expanded={expanded} aria-controls={detailId} aria-label={`${expanded ? "Collapse" : "Expand"} ${item.command}`} onClick={(event) => { event.stopPropagation(); onExpandedChange(!expanded); }}><IconChevronDown size={15} /></button></td>
      <th scope="row"><span className="stateql-ledger-command"><span className="stateql-ledger-marker" aria-hidden="true">{marker}</span><span>{item.command}</span></span></th>
      <td className="mono" title={item.result?.alias ?? item.handle}>{item.result?.alias ?? item.handle ?? "N/A"}</td>
      <td className="mono" title={item.actorId}>{item.actorId ?? "N/A"}</td>
      <td><Status tone={status.tone}>{status.label}</Status></td>
      <td className="mono">{item.timestamp ? <time dateTime={item.timestamp}>{displayTime(item.timestamp)}</time> : "No time"}</td>
    </tr>
    {expanded && <tr className="stateql-ledger-detail" id={detailId}><td colSpan={6}><StateQLLedgerDetail item={item} rowsScope={rowsScope} /></td></tr>}
  </>;
}

function StateQLLedgerDetail({ item, rowsScope }: { item: StateQLActivityItem; rowsScope: string }) {
  return <div className="stateql-ledger-detail-grid">
    <section className="stateql-ledger-sql" aria-label="SQL statement">
      <header><strong>SQL statement</strong><span>{stateqlExecution(item)}</span></header>
      <p>SQL may contain inline literals or comments. Parameters are not included in activity history.</p>
      {item.sql !== undefined ? <pre dir="ltr"><code>{item.sql}</code></pre> : <span className="stateql-ledger-unavailable">SQL was not retained for this activity.</span>}
    </section>
    <section className="stateql-ledger-receipts" aria-label="Database receipt">
      <header><strong>{item.result ? "Result receipt" : item.operation ? "Operation receipt" : "Activity receipt"}</strong><span>{item.source === "metadata" ? "retained metadata" : "session history"}</span></header>
      {item.result && <div className="stateql-ledger-receipt">
        <div><small>Result handle</small><strong className="mono" title={item.result.handle}>{item.result.handle}</strong></div>
        <div><small>Alias</small><strong>{item.result.alias ?? "No alias"}</strong></div>
        <div><small>Rows</small><strong className="mono">{item.result.rows}</strong></div>
      </div>}
      {item.operation && <div className="stateql-ledger-receipt">
        <div><small>Operation handle</small><strong className="mono" title={item.operation.handle}>{item.operation.handle}</strong></div>
        <div><small>Affected</small><strong>{item.operation.affected_rows === null ? "Unavailable" : `${item.operation.affected_rows} rows`}</strong></div>
        <div><small>State</small><strong>{item.operation.status}</strong></div>
      </div>}
      {!item.result && !item.operation && <span className="stateql-ledger-unavailable">No retained receipt is available.</span>}
      {item.handle && <p className="mono" title={item.handle}>{item.handle}</p>}
      {item.result && item.operation && <p className="stateql-ledger-warning">This handle matches both result and operation metadata.</p>}
    </section>
    {item.result && <StateQLMaterializedRows active handle={item.result.handle} key={`${rowsScope}:${item.result.handle}`} total={item.result.rows} />}
  </div>;
}

const STATEQL_ROWS_PAGE_SIZE = 25;

function stateqlCellText(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function stateqlColumns(page: StateQLRowsPage | undefined): string[] {
  const columns = new Set<string>();
  for (const row of page?.rows ?? []) for (const key of Object.keys(row)) columns.add(key);
  return [...columns];
}

function StateQLMaterializedRows({ active, handle, total }: { active: boolean; handle: string; total: number }) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<StateQLRowsPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const columns = useMemo(() => stateqlColumns(page), [page]);

  useEffect(() => {
    if (!active || !open) return;
    const controller = new AbortController();
    let current = true;
    setLoading(true);
    setError("");
    void runtimeStore.stateqlRows(handle, offset, STATEQL_ROWS_PAGE_SIZE, controller.signal)
      .then((value) => { if (current) setPage(value); })
      .catch((cause) => {
        if (current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Materialized rows failed to load");
      })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [active, handle, offset, open, retry]);

  const move = (nextOffset: number) => {
    if (loading) return;
    setPage(undefined);
    setOffset(nextOffset);
  };
  const start = page && page.returned > 0 ? page.offset + 1 : 0;
  const end = page && page.returned > 0 ? page.offset + page.returned : 0;

  return <details className="stateql-rows" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>
      <span><strong>Materialized rows</strong><small>Loaded on demand from this result handle.</small></span>
      <span className="mono">{total.toLocaleString()} rows</span>
      <IconChevronDown size={15} aria-hidden="true" />
    </summary>
    <div className="stateql-rows-content">
      <p className="stateql-rows-note">Rows can contain sensitive database content. Only this bounded page is loaded.</p>
      {loading && !page && <div className="stateql-rows-state" role="status"><IconLoader2 className="spin" size={15} />Loading rows</div>}
      {error && <div className="stateql-rows-state is-error" role="alert"><span>{error}</span><button className="text-button" type="button" onClick={() => setRetry((value) => value + 1)}>Retry</button></div>}
      {page && page.rows.length === 0 && <div className="stateql-rows-state"><span>No rows are available on this page.</span></div>}
      {page && page.rows.length > 0 && <div className="stateql-rows-scroll" role="region" aria-label={`Rows for ${handle}`} tabIndex={0}>
        <table>
          <thead><tr>{columns.map((column) => <th scope="col" key={column}>{column}</th>)}</tr></thead>
          <tbody>{page.rows.map((row, rowIndex) => <tr key={`${page.offset}:${rowIndex}`}>
            {columns.map((column) => {
              const text = Object.hasOwn(row, column) ? stateqlCellText(row[column]) : "N/A";
              return <td className="mono" title={text} key={column}>{text}</td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>}
      {page && <footer className="stateql-rows-footer">
        <span className="mono">{start}-{end} of {page.total.toLocaleString()}</span>
        <div>
          <button className="text-button" type="button" disabled={loading || page.offset === 0} onClick={() => move(Math.max(0, page.offset - page.limit))}>Previous</button>
          <button className="text-button" type="button" disabled={loading || page.next_offset === null} onClick={() => page.next_offset !== null && move(page.next_offset)}>Next</button>
        </div>
      </footer>}
    </div>
  </details>;
}

function Timeline({ live, enabled: packageEnabled }: { live: RuntimeStoreSnapshot; enabled: boolean }) {
  const timeline = live.runtime?.operational.timeline;
  const checkpoints = timeline?.checkpoints ?? [];
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [files, setFiles] = useState<TimelineCheckpointFiles>();
  const [selectedPath, setSelectedPath] = useState<string>();
  const [diff, setDiff] = useState<TimelineCheckpointDiff>();
  const active = checkpoints.find((checkpoint) => checkpoint.id === selected);
  const enabled = live.connection === "connected" && live.runtime?.ready === true && !busy;
  const act = async (action: "restore" | "fork" | "clear", checkpointId?: string) => {
    if (!enabled) return;
    const operation = checkpointId ? `${action}:${checkpointId}` : action;
    setBusy(operation); setError("");
    try { await runtimeStore.timeline(action, checkpointId); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Timeline action failed"); }
    finally { setBusy(""); }
  };
  useEffect(() => {
    let cancelled = false;
    setFiles(undefined);
    setSelectedPath(undefined);
    setDiff(undefined);
    if (!active) return;
    void runtimeStore.timelineCheckpointFiles(active.id)
      .then((value) => { if (!cancelled) setFiles(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Timeline files failed to load"); });
    return () => { cancelled = true; };
  }, [active?.id, live.runtime?.sessionGeneration]);
  const openDiff = async (path: string) => {
    if (!active) return;
    setSelectedPath(path);
    setDiff(undefined);
    try { setDiff(await runtimeStore.timelineCheckpointDiff(active.id, path)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Timeline diff failed to load"); }
  };
  if (timeline?.availability !== "available") {
    return packageEnabled
      ? <div className="empty-state"><IconTimeline size={20} /><strong>Initializing Timeline</strong><span>Waiting for the first Timeline state.</span></div>
      : <FeatureUnavailable name="Timeline" />;
  }
  return (
    <div className="timeline-layout">
      <InspectorSection title="Checkpoints" meta={`${checkpoints.length}`} className="timeline-list">
        <div className="timeline-toolbar"><span>{checkpoints.length} checkpoints</span><button className="text-button danger" type="button" disabled={!enabled || checkpoints.length === 0} onClick={() => void act("clear")}><IconTrash size={13} />{busy === "clear" ? "Clearing…" : "Clear timeline"}</button></div>
        {checkpoints.map((checkpoint) => (
          <div
            className={`checkpoint-item ${active?.id === checkpoint.id ? "is-expanded" : ""}`}
            key={checkpoint.id}
          >
            <div className="checkpoint-row">
            <button className="checkpoint-copy" type="button" aria-expanded={active?.id === checkpoint.id} onClick={() => setSelected((current) => current === checkpoint.id ? undefined : checkpoint.id)}>
              <span><strong title={checkpoint.title}>{oneLine(checkpoint.title)}</strong></span>
              <span className="checkpoint-meta">{checkpoint.branch && <span><IconGitBranch size={12} />{checkpoint.branch}</span>}{checkpoint.verified && <span className="verified"><IconCheck size={12} />Verified</span>}{checkpoint.changes && <span>{checkpoint.changes.fileCount} files</span>}{checkpoint.changes && <span className="checkpoint-diff-count"><ins>+{checkpoint.changes.additions}</ins><del>−{checkpoint.changes.deletions}</del></span>}<time dateTime={checkpoint.createdAt}>{displayTimelineTime(checkpoint.createdAt)}</time></span>
            </button>
            <span className="checkpoint-row-actions">
              <button type="button" title="Fork from checkpoint" aria-label="Fork from checkpoint" aria-busy={busy === `fork:${checkpoint.id}`} disabled={!enabled} onClick={() => void act("fork", checkpoint.id)}>
                {busy === `fork:${checkpoint.id}` ? <IconLoader2 className="spin" size={15} /> : <IconGitFork size={15} />}
              </button>
              <button type="button" title="Restore checkpoint" aria-label="Restore checkpoint" aria-busy={busy === `restore:${checkpoint.id}`} disabled={!enabled} onClick={() => void act("restore", checkpoint.id)}>
                {busy === `restore:${checkpoint.id}` ? <IconLoader2 className="spin" size={15} /> : <IconRestore size={15} />}
              </button>
            </span>
            </div>
            {active?.id === checkpoint.id && <CheckpointDetail files={files} selectedPath={selectedPath} diff={diff} error={error} onOpenDiff={openDiff} />}
          </div>
        ))}
        {checkpoints.length === 0 && <div className="empty-state"><IconTimeline size={20} /><strong>No checkpoints</strong><span>Timeline has not captured this run.</span></div>}
      </InspectorSection>
    </div>
  );
}

function CheckpointDetail({
  files,
  selectedPath,
  diff,
  error,
  onOpenDiff,
}: {
  files?: TimelineCheckpointFiles;
  selectedPath?: string;
  diff?: TimelineCheckpointDiff;
  error: string;
  onOpenDiff(path: string): void;
}) {
  return <div className="checkpoint-inline-detail">
    <div className="checkpoint-files" aria-label="Checkpoint changed files">
      {files?.files.map((file) => <button type="button" className={selectedPath === file.path ? "is-active" : ""} key={file.path} onClick={() => onOpenDiff(file.path)}>
        <IconFile size={13} />
        <span title={file.path}>{file.path}</span>
        {file.binary ? <small>binary</small> : <small><ins>+{file.additions}</ins><del>−{file.deletions}</del></small>}
      </button>)}
      {!files && <span className="settings-note">Loading changes…</span>}
      {files && files.files.length === 0 && <span className="settings-note">No file changes</span>}
    </div>
    {selectedPath && <TimelineDiff value={diff} />}
    {error && <p className="ui-request-error" role="alert">{error}</p>}
  </div>;
}

function TimelineDiff({ value }: { value?: TimelineCheckpointDiff }) {
  if (!value) return <div className="timeline-diff-empty">Loading diff…</div>;
  if (value.state !== "text" || !value.text)
    return <div className="timeline-diff-empty">{value.state === "binary" ? "Binary file" : value.state === "oversized" ? "Diff is too large to display" : "Diff unavailable"}</div>;
  const highlighted = DOMPurify.sanitize(highlightSource(value.text, value.path, true));
  return <pre className="file-code timeline-diff"><code dangerouslySetInnerHTML={{ __html: highlighted }} />{value.truncated && <small>Output truncated</small>}</pre>;
}

function oneLine(value: string, max = 120): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trimEnd()}…` : normalized;
}

function SessionUsage({ metrics }: { metrics?: SessionMetricsReadModel }) {
  const [expanded, setExpanded] = useState(false);
  const toolUsage = [...(metrics?.toolUsage ?? [])]
    .sort((left, right) => right.tokens - left.tokens || right.calls - left.calls || left.name.localeCompare(right.name));
  const inputTokens = metrics?.inputTokens ?? 0;
  const outputTokens = metrics?.outputTokens ?? 0;
  const cacheReadTokens = metrics?.cacheReadTokens ?? 0;
  const cacheWriteTokens = metrics?.cacheWriteTokens ?? 0;
  const inputOutputTokens = inputTokens + outputTokens;
  const inputPercent = inputOutputTokens > 0 ? inputTokens / inputOutputTokens * 100 : 50;
  const cacheHitRate = formatCacheHitRate(inputTokens, cacheReadTokens, cacheWriteTokens);
  const visibleUsage = expanded ? toolUsage : toolUsage.slice(0, 5);
  return <InspectorSection title="Session Usage" className="session-tool-usage">
    <div className="session-tool-summary">
      <div className="session-tool-call-total"><small>Tool calls</small><strong className="mono">{formatCompactNumber(metrics?.toolCalls ?? 0)}</strong><span>{toolUsage.length === 200 ? "200 tools shown" : `${toolUsage.length} tools used`}</span></div>
      <div className="session-token-composition">
        <div><small>Input + output</small><strong className="mono">{formatCompactNumber(inputOutputTokens)}</strong></div>
        <div className="session-token-stack" aria-label={`${formatCompactNumber(inputTokens)} input tokens and ${formatCompactNumber(outputTokens)} output tokens`}><span className="input" style={{ width: `${inputPercent}%` }} /><span className="output" style={{ width: `${100 - inputPercent}%` }} /></div>
        <div className="session-token-key"><span><strong>Input</strong> {formatCompactNumber(inputTokens)}</span><span><strong>Output</strong> {formatCompactNumber(outputTokens)}</span></div>
        <div className="session-token-key"><span title="Share of prompt tokens served from cache" aria-label={`Cache input: ${cacheHitRate}. Share of prompt tokens served from cache`}><strong>Cache input</strong> {cacheHitRate}</span></div>
      </div>
    </div>
    <div className="session-tool-usage-heading"><strong>Usage by tool</strong><span title="Estimated from serialized tool arguments and text results">Tokens / calls</span></div>
    {visibleUsage.length ? <div className="session-tool-usage-list">{visibleUsage.map((usage) => <div className="session-tool-usage-row" key={usage.name}>
      <div><strong>{usage.name}</strong><span aria-label={`${formatCompactNumber(usage.inputTokens)} input tokens and ${formatCompactNumber(usage.outputTokens)} output tokens`}><i className="input" style={{ width: `${usage.tokens > 0 ? usage.inputTokens / usage.tokens * 100 : 0}%` }} /><i className="output" style={{ width: `${usage.tokens > 0 ? usage.outputTokens / usage.tokens * 100 : 0}%` }} /></span></div>
      <span className="mono">~{formatCompactNumber(usage.tokens)}<small>tok</small></span><span className="mono">{formatCompactNumber(usage.calls)}<small>calls</small></span>
    </div>)}</div> : <div className="session-tool-usage-empty">No completed tool calls in this session.</div>}
    {toolUsage.length > 5 && <button className="session-usage-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? "Show less" : `Show ${toolUsage.length - 5} more`} <IconChevronDown size={14} /></button>}
  </InspectorSection>;
}

function Tools({ live }: { live: RuntimeStoreSnapshot }) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"project" | "session">("project");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const runtime = live.runtime;
  const policies = runtime?.operational.tools.policies ?? [];
  const normalized = query.trim().toLowerCase();
  const claimed = new Set<string>();
  const policyGroups = policies.map((policy) => ({
    owner: policy.owner,
    policy,
    tools: policy.managedTools.filter((tool) => {
      if (claimed.has(tool)) return false;
      claimed.add(tool);
      return true;
    }),
  }));
  const groups = [
    ...policyGroups,
    { owner: "Pi built-ins", policy: undefined, tools: (runtime?.availableTools ?? []).filter((tool) => !claimed.has(tool)) },
  ].map((group) => ({ ...group, tools: group.tools.filter((tool) => !normalized || tool.toLowerCase().includes(normalized)) }))
    .filter((group) => group.tools.length);
  const directOverrides = scope === "project" ? runtime?.runtimePolicy.project.toolOverrides : runtime?.runtimePolicy.session.toolOverrides;
  const effectiveOverrides = runtime?.runtimePolicy.effective.toolOverrides ?? {};
  const disabled = live.connection !== "connected" || !runtime?.ready || Boolean(live.pendingUi);
  return <div className="tools-page">
    <InspectorSection title="Tool Overrides" meta={`${runtime?.availableTools.length ?? 0}`} className="tool-overrides-panel">
      <div className="tool-override-toolbar">
        <div className="policy-scope" role="tablist" aria-label="Tool override scope"><button type="button" role="tab" aria-selected={scope === "project"} className={scope === "project" ? "is-active" : ""} onClick={() => setScope("project")}>Project</button><button type="button" role="tab" aria-selected={scope === "session"} className={scope === "session" ? "is-active" : ""} onClick={() => setScope("session")}>This session</button></div>
        <label className="table-search"><IconSearch size={15} /><span className="sr-only">Filter tools</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter tools" /></label>
      </div>
      <p className="tool-override-note">Inherited tools follow global Settings. Package capability and safety gates remain authoritative.</p>
      <div className="tool-override-groups">{groups.map((group) => <section className="tool-override-group" key={group.owner}>
        <header><strong>{group.owner}</strong><span>{group.tools.length}</span></header>
        {group.tools.map((tool) => {
          const capable = group.policy ? group.policy.enabledTools.includes(tool) : true;
          const packageDefault: ToolExposureMode = group.policy?.deferredTools.includes(tool)
            ? "deferred"
            : group.policy ? capable ? "active" : "disabled" : runtime?.activeTools.includes(tool) ? "active" : "disabled";
          const effective = capable ? effectiveOverrides[tool] ?? packageDefault : "disabled";
          const locked = tool === "search_tools";
          const directOverride = directOverrides?.[tool];
          return <label className="tool-override-row" data-effective={effective} key={tool}>
            <span className="tool-override-name"><strong>{tool}</strong></span>
            <span className="tool-override-effective" aria-label={`Current setting: ${effective}`}><i aria-hidden="true" /><strong>{effective}</strong></span>
            <select aria-label={`${scope === "project" ? "Project" : "Session"} override for ${tool}`} value={directOverride ?? "inherit"} disabled={disabled || locked || busy === tool || (!capable && !directOverride)} onChange={(event) => {
              if (!runtime) return;
              const mode = event.target.value as ToolExposureMode | "inherit";
              setBusy(tool); setError("");
              void runtimeStore.updateToolPolicy(scope, tool, mode, runtime.runtimePolicy.revision).catch((cause) => setError(cause instanceof Error ? cause.message : "Tool policy could not be saved")).finally(() => setBusy(""));
            }}><option value="inherit">Inherit</option><option value="active" disabled={!capable}>Active</option><option value="deferred" disabled={!capable}>Deferred</option><option value="disabled" disabled={!capable}>Disabled</option></select>
          </label>;
        })}
      </section>)}</div>
      {!groups.length && <div className="empty-state"><IconSearch size={20} /><strong>No matching tools</strong><span>Try another tool name.</span></div>}
      {error && <p className="policy-error" role="alert">{error}</p>}
    </InspectorSection>
    <SieveStatus live={live} />
  </div>;
}

function SieveStatus({ live }: { live: RuntimeStoreSnapshot }) {
  const sieve = live.runtime?.operational.sieve;
  if (!sieve || sieve.availability !== "available" || !sieve.latest
    || !sieve.cumulativeActual || !sieve.cumulativeProjected) {
    return <InspectorSection title="Context Pruning">
      <FeatureUnavailable name="Pi Sieve" />
    </InspectorSection>;
  }
  const saved = sieve.cumulativeActual.netCharsSaved;
  const projected = sieve.cumulativeProjected.netCharsSaved;
  const observing = sieve.mode === "observe";
  const latestProjected = sieve.latestMode === "observe";
  const topTools = Object.entries(observing ? sieve.cumulativeProjected.byTool : sieve.cumulativeActual.byTool)
    .filter(([, usage]) => usage.netCharsSaved > 0)
    .sort((left, right) => right[1].netCharsSaved - left[1].netCharsSaved)
    .slice(0, 3)
    .map(([name, usage]) => `${name} ${formatCompactNumber(usage.netCharsSaved)}`)
    .join(", ") || "None yet";
  const prefixChurn = sieve.stability?.prefixChurnViolations ?? 0;
  const softExceedances = sieve.stability?.softBudgetExceedances ?? 0;
  const healthy = prefixChurn === 0 && softExceedances === 0;
  const epochReason = sieve.epoch?.reason?.replaceAll("-", " ") ?? "not started";

  return <InspectorSection title="Context Pruning" meta={sieve.mode}>
    <div className="sieve-summary" aria-label="Context pruning summary">
      <div><small>{observing ? "Would save" : "Saved"}</small><strong>{formatCompactNumber(observing ? projected : saved)}</strong><span>characters</span></div>
      <div><small>Threshold</small><strong>{formatCompactNumber(sieve.threshold ?? 0)}</strong><span>characters</span></div>
      <div><small>Recalls</small><strong>{formatCompactNumber(sieve.recalls ?? 0)}</strong><span>{formatCompactNumber(sieve.recalledChars ?? 0)} restored</span></div>
    </div>

    <section className="sieve-group" aria-labelledby="sieve-latest-heading">
      <header className="sieve-group-heading"><h3 id="sieve-latest-heading">Latest activity</h3></header>
      <div className="sieve-activity-stats">
        <div><strong>{formatCompactNumber(sieve.latest.scanned)}</strong><span>scanned</span></div>
        <div><strong>{formatCompactNumber(sieve.latest.transformed)}</strong><span>pruned</span></div>
        <div><strong>{formatCompactNumber(sieve.latest.netCharsSaved)}</strong><span>{latestProjected ? "potential chars" : "chars saved"}</span></div>
      </div>
    </section>

    {sieve.projectionMode === "stable" && <>
      <section className="sieve-group" aria-labelledby="sieve-projection-heading">
        <header className="sieve-group-heading">
          <h3 id="sieve-projection-heading">Projection</h3>
          <span>Stable projection (experimental)</span>
        </header>
        <p className="sieve-pruning-state">Active pruning {sieve.activePruning ? "enabled" : "disabled"}</p>
        <div className="sieve-inline-metrics">
          <span><strong>{formatCompactNumber(sieve.epoch?.frozenResultCount ?? 0)}</strong> frozen</span>
          <span><strong>{formatCompactNumber(sieve.epoch?.frozenRetainedChars ?? 0)}</strong> chars retained</span>
          <span><strong>{formatCompactNumber(sieve.epoch?.rolloverEligibleRetainedChars ?? 0)}</strong> rollover eligible</span>
        </div>
        <p className="sieve-epoch-reason">Epoch started: {epochReason}</p>
      </section>

      <section className="sieve-group" aria-labelledby="sieve-health-heading">
        <header className="sieve-group-heading"><h3 id="sieve-health-heading">Health</h3></header>
        <p className="sieve-health-count"><strong>{formatCompactNumber(sieve.stability?.projectionCacheHits ?? 0)}</strong> projection reuses</p>
        <p className={`sieve-health-note ${healthy ? "is-healthy" : "has-warning"}`}>
          {healthy && <IconCheck size={13} aria-hidden="true" />}
          {healthy ? "No prefix churn or budget exceedances" : `${formatCompactNumber(prefixChurn)} prefix churn, ${formatCompactNumber(softExceedances)} budget exceedances`}
        </p>
      </section>
    </>}

    {sieve.projectionMode === "standard-v2" && <>
      <section className="sieve-group" aria-labelledby="sieve-standard-v2-heading">
        <header className="sieve-group-heading"><h3 id="sieve-standard-v2-heading">Standard V2</h3></header>
        <div className="sieve-inline-metrics">
          <span><strong>{formatCompactNumber(sieve.stability?.standardComparisons ?? 0)}</strong> comparisons</span>
          <span><strong>{formatCompactNumber(sieve.stability?.standardPrefixChurn ?? 0)}</strong> prefix changes</span>
          <span><strong>{formatCompactNumber(sieve.stability?.standardEstimatedInvalidatedChars ?? 0)}</strong> chars invalidated</span>
        </div>
        {sieve.stability?.standardEarliestChangedPriorMessageIndex !== undefined
          && <p className="sieve-epoch-reason">Earliest changed prior message: {sieve.stability.standardEarliestChangedPriorMessageIndex}</p>}
      </section>
      <section className="sieve-group" aria-labelledby="sieve-standard-v2-churn-heading">
        <header className="sieve-group-heading"><h3 id="sieve-standard-v2-churn-heading">Churn causes</h3></header>
        <div className="sieve-inline-metrics">
          {([
            ["activeThreshold", "active threshold"], ["ageThreshold", "age threshold"], ["budget", "budget"],
            ["staleRead", "stale read"], ["duplicate", "duplicate"], ["errorCap", "error cap"], ["history", "history"],
          ] as const).map(([kind, label]) => <span key={kind}><strong>{formatCompactNumber(sieve.stability?.standardChangesByKind?.[kind] ?? 0)}</strong> {label}</span>)}
        </div>
      </section>
    </>}

    <details className="sieve-more">
      <summary>
        <span>Context <strong>{sieve.contextUsagePercent === undefined ? "unavailable" : `${Math.round(sieve.contextUsagePercent)}%`}</strong></span>
        <span>More details <IconChevronDown size={13} aria-hidden="true" /></span>
      </summary>
      <dl>
        <div><dt>Top savings</dt><dd>{topTools}</dd></div>
        <div><dt>Epoch ID</dt><dd className="mono" title={sieve.epoch?.id}>{sieve.epoch?.id ?? "Unavailable"}</dd></div>
        <div><dt>Updated</dt><dd>{sieve.updatedAt ? displayTime(sieve.updatedAt) : "Unavailable"}</dd></div>
      </dl>
    </details>
    {sieve.error && <p className="inline-alert" role="alert">{sieve.error}</p>}
  </InspectorSection>;
}

function HeartbeatJobs({ jobs }: { jobs: JobReadModel[] }) {
  const active = jobs
    .filter((job) => job.state === "running" || job.state === "cancelling")
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  const settled = jobs
    .filter((job) => job.state !== "running" && job.state !== "cancelling")
    .sort((left, right) => Date.parse(right.finishedAt ?? right.startedAt) - Date.parse(left.finishedAt ?? left.startedAt))
    .slice(0, 6);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active.length) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active.length]);
  const visible = [...active, ...settled];
  return <InspectorSection title="Heartbeat Jobs" meta={`${active.length} running`} className="heartbeat-panel">
    <div className="heartbeat-list">
      {visible.map((job) => {
        const startedAt = Date.parse(job.startedAt);
        const finishedAt = job.finishedAt ? Date.parse(job.finishedAt) : now;
        const duration = Math.max(0, finishedAt - startedAt);
        const tone: Tone = job.state === "completed"
          ? "success"
          : job.state === "failed" || job.state === "timed_out"
            ? "danger"
            : job.state === "running" || job.state === "cancelling"
              ? "active"
              : "neutral";
        return <article className="heartbeat-row" key={job.id}>
          <span className="heartbeat-icon"><IconActivityHeartbeat size={16} /></span>
          <div>
            <strong title={job.label}>{job.label}</strong>
            <span>{job.purpose ?? "other"} · {displayTime(job.startedAt)} · {formatDuration(duration)}</span>
          </div>
          <div>
            <Status tone={tone}>{job.state}</Status>
            {job.exitCode !== undefined && <small>exit {job.exitCode ?? "signal"}</small>}
          </div>
        </article>;
      })}
      {visible.length === 0 && <div className="empty-state"><IconActivityHeartbeat size={20} /><strong>No background jobs</strong><span>Heartbeat has not started work in this session.</span></div>}
    </div>
  </InspectorSection>;
}

function InspectorSection({
  title,
  meta,
  className = "",
  defaultOpen = true,
  children,
}: {
  title: string;
  meta?: string;
  className?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return <details
    className={`inspector-section ${className}`}
    open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}
  >
    <summary>
      <span><strong>{title}</strong>{meta && <small>{meta}</small>}</span>
      <IconChevronDown size={15} aria-hidden="true" />
    </summary>
    <div className="inspector-section-content">{children}</div>
  </details>;
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

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status status-${tone}`}><span aria-hidden="true" />{children}</span>;
}
