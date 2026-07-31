import {
  IconActivityHeartbeat,
  IconAdjustmentsHorizontal,
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
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { formatCompactNumber, formatWorkDuration } from "../shared/format";
import { highlightSource } from "../shared/markdown";
import type { JobReadModel, VerificationReadModel } from "../shared/protocol/events";
import type { DialogTimeoutSeconds, StateQLSnapshot, TimelineCheckpointDiff, TimelineCheckpointFiles, VerifyPolicyReadModel, WorkspacePolicyMode } from "../shared/protocol/snapshots";
import { displayTime, displayTimelineTime, formatDuration } from "./format";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";

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
  policy: "Project and session behavior for Verify and Timeline.",
  timeline: "Recoverable checkpoints across the current run.",
  memory: "Durable facts Continuity keeps for this project.",
  tools: "Package policies and tool availability.",
};

interface InspectorProps {
  current: ViewId;
  live: RuntimeStoreSnapshot;
  availableViews: Set<ViewId>;
  timelineEnabled: boolean;
  isOpen: boolean;
  overlay: boolean;
  onClose: () => void;
  onNavigate: (view: ViewId) => void;
}

export function Inspector({ current, live, availableViews, timelineEnabled, isOpen, overlay, onClose, onNavigate }: InspectorProps) {
  const items = navigation.filter((item) => availableViews.has(item.id));
  return (
    <aside id="session-inspector" className={`inspector ${isOpen ? "is-open" : ""}`} aria-label="Session inspector" aria-hidden={!isOpen} inert={!isOpen}>
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
        {current === "policy" && live.runtime && <RuntimePolicy live={live} />}
        {current === "timeline" && <Timeline live={live} enabled={timelineEnabled} />}
        {current === "memory" && <Memory live={live} />}
        {current === "tools" && <Tools live={live} pylonPolicies={live.runtime?.operational.tools.availability === "available"} />}
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
      <InspectorSection title="Usage">
        <div className="usage-strip" aria-label="Session usage">
        <div><small>Input</small><strong>{runtime ? formatCompactNumber(runtime.metrics.inputTokens) : "—"}</strong><span>tokens</span></div>
        <div><small>Output</small><strong>{runtime ? formatCompactNumber(runtime.metrics.outputTokens) : "—"}</strong><span>tokens</span></div>
        <div><small>Cache reads</small><strong>{runtime ? formatCompactNumber(runtime.metrics.cacheReadTokens) : "—"}</strong><span>tokens</span></div>
        <div><small>Tool calls</small><strong>{runtime ? formatCompactNumber(runtime.metrics.toolCalls) : "—"}</strong><span>session total</span></div>
        </div>
      </InspectorSection>
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

function RuntimePolicy({ live }: { live: RuntimeStoreSnapshot }) {
  const runtime = live.runtime!;
  const policy = runtime.runtimePolicy;
  const [scope, setScope] = useState<"global" | "project" | "session">("project");
  const [verify, setVerify] = useState<VerifyPolicyReadModel | "inherit">({ mode: "auto" });
  const [timeline, setTimeline] = useState<"inherit" | "enabled" | "disabled">("enabled");
  const [workspace, setWorkspace] = useState<WorkspacePolicyMode | "inherit">("local");
  const [guardTimeout, setGuardTimeout] = useState<DialogTimeoutSeconds | "inherit">(60);
  const [clarifyTimeout, setClarifyTimeout] = useState<DialogTimeoutSeconds | "inherit">(60);
  const [busy, setBusy] = useState(false);

  const resetDraft = () => {
    const value = scope === "global" ? undefined : scope === "project" ? policy.project.verify : policy.session.verify;
    setVerify(value ?? "inherit");
    setTimeline(scope === "global"
      ? policy.global.timelineEnabled ? "enabled" : "disabled"
      : scope === "project"
        ? policy.project.timelineEnabled === undefined ? "inherit" : policy.project.timelineEnabled ? "enabled" : "disabled"
      : policy.session.timelineEnabled === undefined
        ? "inherit"
        : policy.session.timelineEnabled ? "enabled" : "disabled");
    setWorkspace(scope === "global"
      ? policy.global.workspace
      : scope === "project"
        ? policy.project.workspace ?? "inherit"
      : policy.session.workspace ?? "inherit");
    setGuardTimeout(scope === "global"
      ? policy.global.guardTimeoutSeconds
      : scope === "project"
        ? policy.project.guardTimeoutSeconds === undefined ? "inherit" : policy.project.guardTimeoutSeconds
      : policy.session.guardTimeoutSeconds === undefined ? "inherit" : policy.session.guardTimeoutSeconds);
    setClarifyTimeout(scope === "global"
      ? policy.global.clarifyTimeoutSeconds
      : scope === "project"
        ? policy.project.clarifyTimeoutSeconds === undefined ? "inherit" : policy.project.clarifyTimeoutSeconds
      : policy.session.clarifyTimeoutSeconds === undefined ? "inherit" : policy.session.clarifyTimeoutSeconds);
  };
  useEffect(() => {
    resetDraft();
  }, [policy.revision, scope]);

  const idle = live.connection === "connected"
    && runtime.ready
    && !runtime.conversation.workStartedAt
    && !live.pendingUi
    && !busy;
  const displayedVerify = verify === "inherit" ? policy.effective.verify : verify;
  const checks = displayedVerify.mode === "selected"
    ? displayedVerify.checks
    : policy.availableVerifyChecks.slice(0, 6).map((check) => check.id);
  const save = async (
    nextVerify: VerifyPolicyReadModel | "inherit",
    nextTimeline: "inherit" | "enabled" | "disabled",
    nextWorkspace: WorkspacePolicyMode | "inherit" = workspace,
    nextGuardTimeout: DialogTimeoutSeconds | "inherit" = guardTimeout,
    nextClarifyTimeout: DialogTimeoutSeconds | "inherit" = clarifyTimeout,
  ) => {
    setVerify(nextVerify);
    setTimeline(nextTimeline);
    setWorkspace(nextWorkspace);
    setGuardTimeout(nextGuardTimeout);
    setClarifyTimeout(nextClarifyTimeout);
    setBusy(true);
    try {
      await runtimeStore.updateRuntimePolicy(
        scope,
        nextVerify,
        nextTimeline === "inherit" ? "inherit" : nextTimeline === "enabled",
        nextWorkspace,
        nextGuardTimeout,
        nextClarifyTimeout,
        policy.revision,
      );
    } catch (error) {
      resetDraft();
      throw error;
    } finally {
      setBusy(false);
    }
  };
  const toggleCheck = (id: string) => {
    const next = checks.includes(id)
      ? checks.filter((item) => item !== id)
      : checks.length < 6 ? [...checks, id] : checks;
    if (next === checks) return;
    void save({ mode: "selected", checks: next }, timeline, workspace).catch(() => undefined);
  };
  const canResetVerify = scope === "project"
    ? verify !== "inherit" && verify.mode !== "auto"
    : scope === "session" && verify !== "inherit";

  return <InspectorSection title="Runtime Policy" className="runtime-policy">
    <div className="policy-scope" role="group" aria-label="Policy scope">
      <button type="button" disabled={busy} className={scope === "global" ? "is-active" : ""} onClick={() => setScope("global")}>Global</button>
      <button type="button" disabled={busy} className={scope === "project" ? "is-active" : ""} onClick={() => setScope("project")}>Project</button>
      <button type="button" disabled={busy} className={scope === "session" ? "is-active" : ""} onClick={() => setScope("session")}>This session</button>
    </div>
    {scope !== "global" && <><div className="policy-label-row">
      <span>Verify</span>
      {canResetVerify && <button
        className="text-button"
        type="button"
        disabled={!idle}
        onClick={() => void save(scope === "project" ? { mode: "auto" } : "inherit", timeline, workspace).catch(() => undefined)}
      >{scope === "project" ? "Use automatic detection" : "Use project defaults"}</button>}
    </div>
    <div className="policy-checks">
      {policy.availableVerifyChecks.map((check) => <label key={check.id} title={check.command}>
        <input
          type="checkbox"
          checked={checks.includes(check.id)}
          disabled={!idle || !checks.includes(check.id) && checks.length >= 6}
          onChange={() => toggleCheck(check.id)}
        />
        <span className="mono">{check.label}</span>
      </label>)}
      {checks.filter((id) => !policy.availableVerifyChecks.some((check) => check.id === id))
        .map((id) => <label className="is-missing" key={id}><input type="checkbox" checked disabled={!idle} onChange={() => toggleCheck(id)} /><span>Unknown: {id}</span></label>)}
      {policy.availableVerifyChecks.length === 0 && checks.length === 0 && <small>No declared checks detected. Changed-set hygiene will still run.</small>}
    </div></>}
    <label>Timeline
      <select
        value={timeline}
        disabled={!idle}
        onChange={(event) => void save(verify, event.target.value as typeof timeline, workspace).catch(() => undefined)}
      >
        {scope !== "global" && <option value="inherit">{scope === "project" ? "Inherit global" : "Inherit project"}</option>}
        <option value="enabled">Enabled</option>
        <option value="disabled">Disabled</option>
      </select>
    </label>
    <label>Workspace
      <select
        value={workspace}
        disabled={!idle}
        onChange={(event) => void save(verify, timeline, event.target.value as typeof workspace).catch(() => undefined)}
      >
        {scope !== "global" && <option value="inherit">{scope === "project" ? "Inherit global" : "Inherit project"}</option>}
        <option value="local">Local</option>
        <option value="checkout">Project folder</option>
        <option value="worktree">Session worktree</option>
      </select>
      <small>{scope !== "session"
        ? "Applies to new sessions. Local does not create a branch or worktree."
        : "Changing this session moves it immediately when possible."}</small>
    </label>
    <TimeoutPolicyControl
      label="Guard timeout"
      value={guardTimeout === "inherit" ? policy.effective.guardTimeoutSeconds : guardTimeout}
      inherited={guardTimeout === "inherit"}
      disabled={!idle}
      onChange={(value) => void save(verify, timeline, workspace, value, clarifyTimeout).catch(() => undefined)}
      onReset={scope !== "global" && guardTimeout !== "inherit"
        ? () => void save(verify, timeline, workspace, "inherit", clarifyTimeout).catch(() => undefined)
        : undefined}
    />
    <TimeoutPolicyControl
      label="Clarify timeout"
      value={clarifyTimeout === "inherit" ? policy.effective.clarifyTimeoutSeconds : clarifyTimeout}
      inherited={clarifyTimeout === "inherit"}
      disabled={!idle}
      onChange={(value) => void save(verify, timeline, workspace, guardTimeout, value).catch(() => undefined)}
      onReset={scope !== "global" && clarifyTimeout !== "inherit"
        ? () => void save(verify, timeline, workspace, guardTimeout, "inherit").catch(() => undefined)
        : undefined}
    />
    {busy && <small className="policy-saving" role="status">Saving…</small>}
  </InspectorSection>;
}

type TimeoutUnit = "seconds" | "minutes" | "hours";
const timeoutUnitSeconds: Record<TimeoutUnit, number> = { seconds: 1, minutes: 60, hours: 3_600 };

function timeoutParts(value: number): { amount: number; unit: TimeoutUnit } {
  if (value % 3_600 === 0) return { amount: value / 3_600, unit: "hours" };
  if (value % 60 === 0) return { amount: value / 60, unit: "minutes" };
  return { amount: value, unit: "seconds" };
}

function TimeoutPolicyControl({
  label,
  value,
  inherited,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  value: DialogTimeoutSeconds;
  inherited: boolean;
  disabled: boolean;
  onChange(value: DialogTimeoutSeconds): void;
  onReset?: () => void;
}) {
  const initial = timeoutParts(value ?? 60);
  const [amount, setAmount] = useState(String(initial.amount));
  const [unit, setUnit] = useState<TimeoutUnit>(initial.unit);
  useEffect(() => {
    const next = timeoutParts(value ?? 60);
    setAmount(String(next.amount));
    setUnit(next.unit);
  }, [value]);
  const commit = (nextAmount = amount, nextUnit = unit) => {
    const seconds = Number(nextAmount) * timeoutUnitSeconds[nextUnit];
    if (!Number.isInteger(seconds) || seconds < 15 || seconds > 86_400) {
      const previous = timeoutParts(value ?? 60);
      setAmount(String(previous.amount));
      setUnit(previous.unit);
      return;
    }
    onChange(seconds);
  };

  return <div className="policy-timeout">
    <div className="policy-label-row">
      <span>{label}{inherited ? " · Project default" : ""}</span>
      {onReset && <button className="text-button" type="button" disabled={disabled} onClick={onReset}>Use project default</button>}
    </div>
    <div className="policy-timeout-controls">
      {value === null
        ? <span className="policy-timeout-never">Never</span>
        : <>
          <input
            type="number"
            min={unit === "seconds" ? 15 : 1}
            max={unit === "hours" ? 24 : unit === "minutes" ? 1_440 : 86_400}
            step="1"
            value={amount}
            disabled={disabled}
            aria-label={`${label} duration`}
            onChange={(event) => setAmount(event.target.value)}
            onBlur={() => commit()}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              commit();
              event.currentTarget.blur();
            }}
          />
          <select
            value={unit}
            disabled={disabled}
            aria-label={`${label} unit`}
            onChange={(event) => {
              const next = event.target.value as TimeoutUnit;
              setUnit(next);
              commit(amount, next);
            }}
          >
            <option value="seconds">Seconds</option>
            <option value="minutes">Minutes</option>
            <option value="hours">Hours</option>
          </select>
        </>}
      <button className="text-button" type="button" disabled={disabled} onClick={() => onChange(value === null ? 60 : null)}>
        {value === null ? "Use timeout" : "Never"}
      </button>
    </div>
    <small>Paused while the response tab is visible and focused.</small>
  </div>;
}

function Memory({ live }: { live: RuntimeStoreSnapshot }) {
  const memory = live.runtime?.operational.continuity.memory ?? [];
  const [editing, setEditing] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<(typeof memory)[number]["kind"]>("workflow");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const idle = live.connection === "connected"
    && live.runtime?.ready === true
    && live.runtime.conversation.streaming === false
    && !live.pendingUi
    && !busy;
  const edit = (fact: (typeof memory)[number]) => {
    setEditing(fact.key);
    setText(fact.text);
    setKind(fact.kind);
    setError("");
  };
  const save = async (fact: (typeof memory)[number]) => {
    if (!idle || !text.trim()) return;
    setBusy(fact.key);
    setError("");
    try {
      await runtimeStore.updateContinuityMemory(fact, text.trim(), kind);
      setEditing("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update memory");
    } finally {
      setBusy("");
    }
  };
  const remove = async (fact: (typeof memory)[number]) => {
    if (!idle || !window.confirm(`Delete project memory "${fact.key}"?`)) return;
    setBusy(fact.key);
    setError("");
    try {
      await runtimeStore.deleteContinuityMemory(fact);
      setEditing("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete memory");
    } finally {
      setBusy("");
    }
  };
  if (live.runtime?.operational.continuity.availability === "unavailable") return <FeatureUnavailable name="Continuity memory" />;
  return <div className="memory-page">
    <InspectorSection title="Saved Facts" meta={`${memory.length} project facts`} className="memory-panel">
      {memory.map((fact) => <article className="memory-fact" key={fact.key}>
        <header>
          <div><strong>{fact.key}</strong><span>{fact.kind}</span></div>
          <time dateTime={fact.updatedAt}>{displayTime(fact.updatedAt)}</time>
        </header>
        {editing === fact.key ? <div className="memory-editor">
          <label>Kind<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
            {["workflow", "structure", "architecture", "warning", "preference"].map((value) => <option value={value} key={value}>{value}</option>)}
          </select></label>
          <label>Fact<textarea value={text} maxLength={1_000} rows={5} onChange={(event) => setText(event.target.value)} /></label>
          <div><button className="primary-button" type="button" disabled={!idle || !text.trim()} onClick={() => void save(fact)}>{busy === fact.key ? "Saving…" : "Save"}</button><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => setEditing("")}>Cancel</button></div>
        </div> : <>
          <p>{fact.text}</p>
          <dl>
            <div><dt>Confidence</dt><dd>{Math.round(fact.confidence * 100)}%</dd></div>
            <div><dt>Source</dt><dd>{fact.source}</dd></div>
            <div><dt>Evidence</dt><dd>{fact.evidencePaths?.length ?? 0} files</dd></div>
          </dl>
          <footer><button className="text-button" type="button" disabled={!idle} onClick={() => edit(fact)}>Edit</button><button className="text-button danger" type="button" disabled={!idle} onClick={() => void remove(fact)}><IconTrash size={13} />Delete</button></footer>
        </>}
      </article>)}
      {memory.length === 0 && <div className="empty-state"><IconThinkingMedium size={20} /><strong>No project memory</strong><span>Continuity has not saved durable facts for this project.</span></div>}
      {!idle && memory.length > 0 && <p className="settings-note" role="status">Memory changes are available when the session is idle.</p>}
      {error && <p className="ui-request-error" role="alert">{error}</p>}
    </InspectorSection>
  </div>;
}

export function StateQLWorkspace({ live }: { live: RuntimeStoreSnapshot }) {
  const [snapshot, setSnapshot] = useState<StateQLSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const toolRevision = useMemo(() => (live.runtime?.conversation.tools ?? [])
    .filter((tool) => tool.name === "stateql" && tool.status !== "running")
    .map((tool) => `${tool.id}:${tool.status}`)
    .join("|"), [live.runtime?.conversation.tools]);

  useEffect(() => {
    setLoading(true);
    setError("");
    if (live.connection !== "connected" || !live.runtime?.ready) return;
    const controller = new AbortController();
    let active = true;
    void runtimeStore.stateqlSnapshot(50, controller.signal)
      .then((value) => { if (active) setSnapshot(value); })
      .catch((cause) => {
        if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "StateQL status failed to load");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [live.connection, live.runtime?.ready, live.runtime?.sessionId, live.runtime?.sessionGeneration, refresh, toolRevision]);

  if (!snapshot && loading) return <div className="empty-state"><IconLoader2 className="spin" size={20} /><strong>Loading StateQL</strong><span>Reading bounded local status and history.</span></div>;
  if (!snapshot) return <div className="empty-state"><IconDatabase size={20} /><strong>StateQL unavailable</strong><span>{error || "No StateQL snapshot is available for this actor."}</span></div>;
  const connection = snapshot.connection;
  return <div className="page-grid">
    <InspectorSection title="Database status" meta={snapshot.session.status}>
      <div className="table-toolbar">
        <div><p className="mono">{snapshot.session.name}</p><small className="mono">Actor {oneLine(snapshot.actor_id, 24)}</small></div>
        <button className="text-button" type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          {loading ? <IconLoader2 className="spin" size={13} /> : <IconRefresh size={13} />}Refresh
        </button>
      </div>
      <div className="usage-strip" aria-label="StateQL database status">
        <div><small>Connection</small><strong>{connection?.driver ?? "None"}</strong><span>{connection ? connection.read_only ? "read-only" : "read-write" : "disconnected"}</span></div>
        <div><small>Database</small><strong title={connection?.database}>{connection ? oneLine(connection.database, 24) : "—"}</strong><span>{connection?.name ?? "No active connection"}</span></div>
        <div><small>Transaction</small><strong>{snapshot.transaction?.state ?? "None"}</strong><span>{snapshot.transaction ? `owner ${oneLine(snapshot.transaction.owner_actor_id, 18)}` : "no staged writes"}</span></div>
        <div><small>State</small><strong>{snapshot.state_version ?? "—"}</strong><span>{snapshot.state_confidence ?? "unavailable"}</span></div>
      </div>
      {error && <p className="ui-request-error" role="alert">{error}</p>}
    </InspectorSection>

    <InspectorSection title="Recent results" meta={`${snapshot.recent_results.length}`} className="tool-table-panel">
      <div className="tool-table" role="table" aria-label="Recent StateQL results">
        <div className="tool-table-head" role="row"><span role="columnheader">Handle</span><span role="columnheader">Alias</span><span role="columnheader">Rows</span><span role="columnheader">State</span></div>
        {snapshot.recent_results.map((result) => <div className="tool-table-row" role="row" key={result.handle}>
          <span className="tool-name mono" role="cell">{result.handle}</span>
          <span role="cell">{result.alias ?? "—"}</span>
          <span className="mono" role="cell">{result.rows}</span>
          <span role="cell"><Status tone="neutral">materialized</Status></span>
        </div>)}
        {snapshot.recent_results.length === 0 && <div className="empty-state"><IconDatabase size={20} /><strong>No result handles</strong><span>StateQL queries will appear here.</span></div>}
      </div>
    </InspectorSection>

    <InspectorSection title="Recent operations" meta={`${snapshot.recent_operations.length}`} className="tool-table-panel">
      <div className="tool-table" role="table" aria-label="Recent StateQL operations">
        <div className="tool-table-head" role="row"><span role="columnheader">Handle</span><span role="columnheader">Type</span><span role="columnheader">Rows</span><span role="columnheader">State</span></div>
        {snapshot.recent_operations.map((operation) => <div className="tool-table-row" role="row" key={operation.handle}>
          <span className="tool-name mono" role="cell">{operation.handle}</span>
          <span className="tool-name" role="cell"><span><strong>{operation.type}</strong><small className="mono">{oneLine(operation.actor_id, 18)}</small></span></span>
          <span className="mono" role="cell">{operation.affected_rows ?? "—"}</span>
          <span role="cell"><Status tone={operation.status === "committed" ? "success" : operation.status === "failed" || operation.status === "outcome_unknown" ? "danger" : "active"}>{operation.status}</Status></span>
        </div>)}
        {snapshot.recent_operations.length === 0 && <div className="empty-state"><IconDatabase size={20} /><strong>No database writes</strong><span>Confirmed write operations will appear here.</span></div>}
      </div>
    </InspectorSection>

    <InspectorSection title="Command history" meta={`${snapshot.history.length}`} className="tool-table-panel">
      <div className="tool-table" role="table" aria-label="StateQL command history">
        <div className="tool-table-head" role="row"><span role="columnheader">Command</span><span role="columnheader">Handle</span><span role="columnheader">Result</span><span role="columnheader">Time</span></div>
        {snapshot.history.map((entry) => <div className="tool-table-row" role="row" key={entry.command_id}>
          <span className="tool-name" role="cell"><span><strong>{entry.command}</strong><small className="mono">{oneLine(entry.actor_id, 18)}</small></span></span>
          <span className="mono" role="cell">{entry.handle ?? "—"}</span>
          <span role="cell"><Status tone={!entry.success ? "danger" : entry.cached ? "neutral" : "success"}>{entry.success ? entry.cached ? "cached" : entry.executed ? "executed" : "ok" : entry.error_code ?? "failed"}</Status></span>
          <time role="cell" dateTime={entry.timestamp}>{displayTime(entry.timestamp)}</time>
        </div>)}
        {snapshot.history.length === 0 && <div className="empty-state"><IconClock size={20} /><strong>No StateQL history</strong><span>Commands run in this shared workspace will appear here.</span></div>}
      </div>
    </InspectorSection>
  </div>;
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
  return (
    <div className="tools-page">
      <SieveStatus live={live} />
      <InspectorSection title="Available Tools" meta={`${visibleTools.length}`} className="tool-table-panel">
        <div className="table-toolbar">
          <div><p>Effective state for this session.</p></div>
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
      </InspectorSection>
      {pylonPolicies && <InspectorSection title="Package Policies" meta={`${policies.length}`} className="tool-table-panel">
        <div className="table-toolbar"><div><p>Pylon coordination state.</p></div></div>
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
      </InspectorSection>}
    </div>
  );
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
  return <InspectorSection title="Context Pruning" meta={sieve.mode}>
    <div className="usage-strip">
      <div><small>Threshold</small><strong>{formatCompactNumber(sieve.threshold ?? 0)}</strong><span>characters</span></div>
      <div><small>Saved</small><strong>{formatCompactNumber(saved)}</strong><span>characters</span></div>
      <div><small>Projected</small><strong>{formatCompactNumber(projected)}</strong><span>characters</span></div>
      <div><small>Recalls</small><strong>{formatCompactNumber(sieve.recalls ?? 0)}</strong><span>{formatCompactNumber(sieve.recalledChars ?? 0)} restored</span></div>
    </div>
    <dl className="sieve-details">
      <div><dt>Latest scan</dt><dd>{formatCompactNumber(sieve.latest.scanned)} results</dd></div>
      <div><dt>Pruned</dt><dd>{formatCompactNumber(sieve.latest.transformed)} results</dd></div>
      <div><dt>Active pruning</dt><dd>{sieve.activePruning ? "Enabled" : "Disabled"}</dd></div>
      <div><dt>Updated</dt><dd>{sieve.updatedAt ? displayTime(sieve.updatedAt) : "—"}</dd></div>
    </dl>
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
  children,
}: {
  title: string;
  meta?: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
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
