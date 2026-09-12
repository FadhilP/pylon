import { IconArrowLeft, IconBotId, IconSettings, IconTool, IconX } from "@tabler/icons-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { formatCacheHitRate, formatCompactNumber, formatWorkDuration, modelLabel } from "../ui/session-format";
import type {
  DelegatedAgentKind,
  DelegatedAgentRunReadModel,
  ModelOptionReadModel,
  ThinkingLevelReadModel,
} from "../../shared/protocol/events";
import type {
  PackageSummary,
  ProjectAgentModelsReadModel,
  RuntimePolicyReadModel,
} from "../../shared/protocol/snapshots";
import { modelKey, selectableModels, useHiddenModels } from "../settings/model-visibility";
import { CopyMessageButton, MarkdownContent, WorkTimer } from "../conversation/conversation-panel";
import { agentRequestLabel, thinkingLabel } from "../ui/display-format";
import { agentColor, type AgentColorMap } from "./agent-color";
import { referenceDefinition } from "../app/navigation";
import { ToolCallGroup, ToolCallTrack } from "../conversation/tool-calls";
import { LedBar, OverviewOrb, useResponsiveUsageLedCells, type OverviewState } from "../ui/overview-primitives";
import { pairAgentActivity } from "./agent-activity";
import { pairedToolCallViews } from "../conversation/tool-call-model";

type AgentRunStatus = DelegatedAgentRunReadModel["status"];

const ORB_STATE: Record<AgentRunStatus, OverviewState> = {
  running: "running",
  completed: "done",
  failed: "failed",
  attention: "attention",
};

const FILTERS: { status: AgentRunStatus; label: string }[] = [
  { status: "running", label: "live" },
  { status: "completed", label: "done" },
  { status: "attention", label: "attention" },
  { status: "failed", label: "failed" },
];

export function AgentPanel({
  runs,
  models,
  colors,
  selectedId,
  agentPackages,
  projectId,
  runtimePolicy,
  settingsDisabled,
  onSelect,
  onUpdateSessionAgentModels,
  onClose,
}: {
  runs: DelegatedAgentRunReadModel[];
  models: ModelOptionReadModel[];
  colors: AgentColorMap;
  selectedId?: string;
  agentPackages: PackageSummary[];
  projectId?: string;
  runtimePolicy?: RuntimePolicyReadModel;
  settingsDisabled: boolean;
  onSelect: (id?: string) => void;
  onUpdateSessionAgentModels: (
    projectId: string,
    agentModels: ProjectAgentModelsReadModel,
    expectedRevision: number,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ordered = useMemo(() => [...runs].reverse(), [runs]);
  const selected = ordered.find(run => run.id === selectedId);
  const threadRuns =
    selected && isSpawned(selected)
      ? runs.filter(
          run =>
            run.kind === selected.kind &&
            (selected.threadId ? run.threadId === selected.threadId : run.id === selected.id),
        )
      : selected
        ? [selected]
        : [];

  return (
    <aside
      id="agents-panel"
      className={`inspector agents-panel is-open${selected && !settingsOpen ? " has-selection" : ""}`}
      aria-labelledby="agents-title"
      style={selected && !settingsOpen ? agentColor(selected, colors) : undefined}>
      <header className="inspector-header">
        <div>
          {(selected || settingsOpen) && (
            <button
              className="icon-button"
              type="button"
              onClick={() => settingsOpen ? setSettingsOpen(false) : onSelect(undefined)}
              aria-label="Back to agents">
              <IconArrowLeft size={17} />
            </button>
          )}
          {settingsOpen ? <IconSettings size={18} /> : <IconBotId size={18} />}
          <strong id="agents-title">
            {settingsOpen ? "Session agent defaults" : selected ? <AgentIdentity run={selected} /> : "Agents"}
          </strong>
        </div>
        <div>
          {!settingsOpen && (
            <button
              className="icon-button"
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Configure session agent defaults">
              <IconSettings size={17} />
            </button>
          )}
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close agents">
            <IconX size={17} />
          </button>
        </div>
      </header>
      <p className="inspector-description">
        {settingsOpen
          ? "Override agent models for this session. Changes apply to the next agent operation."
          : referenceDefinition("agents")?.description}
      </p>
      {settingsOpen ? (
        <SessionAgentModelSettings
          packages={agentPackages}
          projectId={projectId}
          policy={runtimePolicy}
          models={models}
          disabled={settingsDisabled}
          onUpdate={onUpdateSessionAgentModels}
        />
      ) : selected ? (
        <AgentDetails run={selected} threadRuns={threadRuns} models={models} />
      ) : (
        <AgentList runs={ordered} models={models} colors={colors} onSelect={onSelect} />
      )}
    </aside>
  );
}

type SessionAgentRole = "planner" | "executor" | "memoryReviewer" | "compactionReviewer";
type SessionAgentProfile = { model: string; thinking?: ThinkingLevelReadModel };
const AGENT_THINKING_LEVELS: ThinkingLevelReadModel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function SessionAgentModelSettings({
  packages,
  projectId,
  policy,
  models,
  disabled,
  onUpdate,
}: {
  packages: PackageSummary[];
  projectId?: string;
  policy?: RuntimePolicyReadModel;
  models: ModelOptionReadModel[];
  disabled: boolean;
  onUpdate: (
    projectId: string,
    agentModels: ProjectAgentModelsReadModel,
    expectedRevision: number,
  ) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const value = policy?.session.agentModels ?? {};
  const inherited = policy?.project.agentModels ?? {};
  const continuityEnabled = packages.some(item => item.enabled && item.settings?.kind === "continuity");
  const advisorEnabled = packages.some(item => item.enabled && item.settings?.kind === "advisor");
  const setHere =
    Object.keys(value.continuity ?? {}).length +
    (value.advisor?.model !== undefined || value.advisor?.useMainModel !== undefined ? 1 : 0) +
    (value.advisor?.thinking !== undefined ? 1 : 0);

  useEffect(() => setError(""), [projectId, policy?.revision]);

  const save = async (next: ProjectAgentModelsReadModel) => {
    if (!projectId || !policy || saving) return;
    setSaving(true);
    setError("");
    try {
      await onUpdate(projectId, next, policy.revision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (!projectId || !policy) {
    return (
      <div className="settings-empty">
        <strong>No active session</strong>
        <span>Open a project session to configure session agent defaults.</span>
      </div>
    );
  }
  if (!continuityEnabled && !advisorEnabled) {
    return (
      <div className="settings-empty">
        <strong>No session-scoped agent models</strong>
        <span>Enable Continuity or Advisor first.</span>
      </div>
    );
  }

  return (
    <div className="runtime-policy session-agent-settings">
      <div className="policy-toolbar">
        <div className="policy-scope" role="tablist" aria-label="Agent model scope">
          <button type="button" role="tab" aria-selected="true" className="is-active" disabled>
            This session
          </button>
        </div>
        <span className="policy-set-count">{setHere} set here</span>
        {setHere > 0 && (
          <button className="policy-global-link" type="button" disabled={disabled || saving} onClick={() => void save({})}>
            Reset all to Project
          </button>
        )}
      </div>
      <div className="agent-model-groups">
        {continuityEnabled && (
          <section className="agent-model-group">
            <header><h3>Continuity</h3></header>
            <div className="package-list">
              {([
                ["planner", "Planner", "Breaks a goal into the task list."],
                ["executor", "Executor", "Carries out each task in the list."],
                ["memoryReviewer", "Memory reviewer", "Approves memories before they are stored."],
                ["compactionReviewer", "Compaction reviewer", "Checks summaries before history is dropped."],
              ] as const).map(([role, label, description]) => (
                <SessionProfileRow
                  key={role}
                  label={label}
                  description={description}
                  profile={value.continuity?.[role]}
                  inherited={inherited.continuity?.[role]}
                  models={models}
                  disabled={disabled || saving}
                  onChange={profile => void save(updateSessionProfile(value, role, profile))}
                />
              ))}
            </div>
          </section>
        )}
        {advisorEnabled && (
          <SessionAdvisorSettings
            value={value}
            inherited={inherited.advisor}
            models={models}
            disabled={disabled || saving}
            onChange={next => void save(next)}
          />
        )}
      </div>
      {error && <p className="settings-inline-error" role="alert">{error}</p>}
    </div>
  );
}

function updateSessionProfile(
  value: ProjectAgentModelsReadModel,
  role: SessionAgentRole,
  profile: SessionAgentProfile | undefined,
): ProjectAgentModelsReadModel {
  const next = { ...value };
  const continuity = { ...(value.continuity ?? {}) };
  if (profile) continuity[role] = profile;
  else delete continuity[role];
  if (Object.keys(continuity).length) next.continuity = continuity;
  else delete next.continuity;
  return next;
}

function updateSessionAdvisor(
  value: ProjectAgentModelsReadModel,
  advisor: ProjectAgentModelsReadModel["advisor"],
): ProjectAgentModelsReadModel {
  const next = { ...value };
  if (advisor && Object.keys(advisor).length) next.advisor = advisor;
  else delete next.advisor;
  return next;
}

function SessionProfileRow({
  label,
  description,
  profile,
  inherited,
  models,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  profile?: SessionAgentProfile;
  inherited?: SessionAgentProfile;
  models: ModelOptionReadModel[];
  disabled: boolean;
  onChange: (profile?: SessionAgentProfile) => void;
}) {
  return (
    <div className="package-row">
      <OverviewOrb state={profile ? "done" : "neutral"} label={profile ? "set for session" : "inherited"} />
      <span className="package-row-copy"><strong>{label}</strong><small>{description}</small></span>
      <span className="package-row-control is-pair">
        <SessionModelSelect
          label={`${label} session model`}
          value={profile?.model}
          inheritLabel={inherited ? `Inherit from Project (${inherited.model})` : "Inherit from Project / Global"}
          models={models}
          disabled={disabled}
          onChange={model => onChange(model ? { model } : undefined)}
        />
        <SessionThinkingSelect
          label={`${label} session thinking`}
          value={profile?.thinking}
          inheritLabel={inherited?.thinking ? `Inherit from Project (${thinkingLabel(inherited.thinking)})` : "Inherit from Project / Global"}
          modelRef={profile?.model}
          models={models}
          disabled={disabled || !profile}
          onChange={thinking => profile && onChange({ ...profile, thinking })}
        />
      </span>
    </div>
  );
}

function SessionAdvisorSettings({
  value,
  inherited,
  models,
  disabled,
  onChange,
}: {
  value: ProjectAgentModelsReadModel;
  inherited?: ProjectAgentModelsReadModel["advisor"];
  models: ModelOptionReadModel[];
  disabled: boolean;
  onChange: (value: ProjectAgentModelsReadModel) => void;
}) {
  const advisor = value.advisor;
  const mode = advisor?.model
    ? advisor.model
    : advisor?.useMainModel === true
      ? "session"
      : advisor?.useMainModel === false
        ? "disabled"
        : "inherit";
  const inheritedLabel = inherited?.model
    ? `Project (${inherited.model})`
    : inherited?.useMainModel === true
      ? "Project (session model)"
      : inherited?.useMainModel === false
        ? "Project (disabled)"
        : "Project / Global";
  const setMode = (nextMode: string) => {
    const thinking = advisor?.thinking;
    const next =
      nextMode === "inherit"
        ? thinking ? { thinking } : undefined
        : nextMode === "session"
          ? { useMainModel: true, ...(thinking ? { thinking } : {}) }
          : nextMode === "disabled"
            ? { useMainModel: false }
            : { model: nextMode, ...(thinking ? { thinking } : {}) };
    onChange(updateSessionAdvisor(value, next));
  };
  return (
    <section className="agent-model-group">
      <header><h3>Advisor</h3></header>
      <div className="package-list">
        <div className="package-row">
          <OverviewOrb state={advisor ? "done" : "neutral"} label={advisor ? "set for session" : "inherited"} />
          <span className="package-row-copy"><strong>Model</strong><small>Choose a model, use the session model, or disable Advisor for this session.</small></span>
          <span className="package-row-control">
            <SessionAdvisorModelSelect
              value={mode}
              inheritLabel={`Inherit from ${inheritedLabel}`}
              models={models}
              disabled={disabled}
              onChange={setMode}
            />
          </span>
        </div>
        <div className="package-row">
          <OverviewOrb state={advisor?.thinking ? "done" : "neutral"} label={advisor?.thinking ? "set for session" : "inherited"} />
          <span className="package-row-copy"><strong>Thinking</strong><small>Override only the Advisor thinking level for this session.</small></span>
          <span className="package-row-control">
            <SessionThinkingSelect
              label="Advisor session thinking"
              value={advisor?.thinking}
              inheritLabel={inherited?.thinking ? `Inherit from Project (${thinkingLabel(inherited.thinking)})` : "Inherit from Project / Global"}
              modelRef={advisor?.model}
              models={models}
              disabled={disabled || mode === "disabled"}
              onChange={thinking => {
                const next = { ...(advisor ?? {}) };
                if (thinking) next.thinking = thinking;
                else delete next.thinking;
                onChange(updateSessionAdvisor(value, next));
              }}
            />
          </span>
        </div>
      </div>
    </section>
  );
}

function SessionModelSelect({
  label,
  value,
  inheritLabel,
  models,
  disabled,
  onChange,
}: {
  label: string;
  value?: string;
  inheritLabel: string;
  models: ModelOptionReadModel[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const hiddenModels = useHiddenModels();
  const options = selectableModels(models, hiddenModels, value ? [value] : []);
  const missing = value && !options.some(model => modelKey(model) === value);
  return (
    <select aria-label={label} value={value ?? ""} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="">{inheritLabel}</option>
      {missing && <option value={value}>{value}</option>}
      {options.map(model => <option value={modelKey(model)} key={modelKey(model)}>{model.name}</option>)}
    </select>
  );
}

function SessionAdvisorModelSelect({
  value,
  inheritLabel,
  models,
  disabled,
  onChange,
}: {
  value: string;
  inheritLabel: string;
  models: ModelOptionReadModel[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const hiddenModels = useHiddenModels();
  const options = selectableModels(models, hiddenModels, value.includes("/") ? [value] : []);
  const missing = value.includes("/") && !options.some(model => modelKey(model) === value);
  return (
    <select aria-label="Advisor session model" value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
      <option value="inherit">{inheritLabel}</option>
      <option value="disabled">Disabled</option>
      <option value="session">Use session model</option>
      {missing && <option value={value}>{value}</option>}
      {options.map(model => <option value={modelKey(model)} key={modelKey(model)}>{model.name}</option>)}
    </select>
  );
}

function SessionThinkingSelect({
  label,
  value,
  inheritLabel,
  modelRef,
  models,
  disabled,
  onChange,
}: {
  label: string;
  value?: ThinkingLevelReadModel;
  inheritLabel: string;
  modelRef?: string;
  models: ModelOptionReadModel[];
  disabled: boolean;
  onChange: (value?: ThinkingLevelReadModel) => void;
}) {
  const levels = modelRef
    ? models.find(model => modelKey(model) === modelRef)?.thinkingLevels ?? []
    : AGENT_THINKING_LEVELS;
  return (
    <select
      aria-label={label}
      value={value ?? ""}
      disabled={disabled}
      onChange={event => onChange(event.target.value ? event.target.value as ThinkingLevelReadModel : undefined)}>
      <option value="">{inheritLabel}</option>
      {levels.map(level => <option value={level} key={level}>{thinkingLabel(level)}</option>)}
    </select>
  );
}

function AgentList({
  runs,
  models,
  colors,
  onSelect,
}: {
  runs: DelegatedAgentRunReadModel[];
  models: ModelOptionReadModel[];
  colors: AgentColorMap;
  onSelect: (id: string) => void;
}) {
  // Pills are independent toggles: an empty set means no filter, so everything shows.
  const [shown, setShown] = useState<ReadonlySet<AgentRunStatus>>(() => new Set());
  if (!runs.length)
    return (
      <div className="agents-empty">
        <IconBotId size={24} />
        <strong>No delegated runs</strong>
        <span>Advisor, Grunt, Scout, and spawned child activity will appear here.</span>
      </div>
    );

  const counts: Record<AgentRunStatus, number> = { running: 0, completed: 0, attention: 0, failed: 0 };
  let totalCost = 0;
  for (const run of runs) {
    counts[run.status] += 1;
    totalCost += run.usage?.cost ?? 0;
  }
  const toggle = (status: AgentRunStatus) =>
    setShown(current => {
      const next = new Set(current);
      if (!next.delete(status)) next.add(status);
      return next;
    });
  const visibleRuns = shown.size ? runs.filter(run => shown.has(run.status)) : runs;
  const turns = new Map<number, DelegatedAgentRunReadModel[]>();
  for (const run of visibleRuns) turns.set(run.turn, [...(turns.get(run.turn) ?? []), run]);

  return (
    <div className="agents-list">
      <div className="agents-filterbar">
        <div className="agents-filter-pills" role="group" aria-label="Filter agent runs">
          {FILTERS.filter(({ status }) => counts[status] > 0).map(({ status, label }) => (
            <button key={status} type="button" aria-pressed={shown.has(status)} onClick={() => toggle(status)}>
              <OverviewOrb state={ORB_STATE[status]} label={label} />
              {counts[status]} {label}
            </button>
          ))}
        </div>
        <span className="mono">${totalCost.toFixed(4)}</span>
      </div>
      <div className="agents-table-body">
        {[...turns].map(([turn, items]) => (
          <section className="agent-turn-group" key={turn}>
            <header>
              <strong>{turn > 0 ? `Turn ${turn}` : "Earlier turn"}</strong>
              <span>
                {items.length} {items.length === 1 ? "run" : "runs"}
              </span>
            </header>
            {items.map(run => (
              <AgentRunRow key={run.id} run={run} models={models} colors={colors} onSelect={onSelect} />
            ))}
          </section>
        ))}
        {!visibleRuns.length && <div className="agents-filter-empty">No runs match this filter.</div>}
      </div>
    </div>
  );
}

/** One lane: colour on the edge, cost on the identity line, and the run's
    track along the bottom rule with its call count and time riding on it. */
function AgentRunRow({
  run,
  models,
  colors,
  onSelect,
}: {
  run: DelegatedAgentRunReadModel;
  models: ModelOptionReadModel[];
  colors: AgentColorMap;
  onSelect: (id: string) => void;
}) {
  const tools = pairAgentActivity(run.activity);
  const calls = pairedToolCallViews(tools, run.status === "running");
  const request = agentRequestLabel(run);
  const hasDuration = Boolean(run.startedAt) || run.durationMs !== undefined;
  return (
    <button
      className={`agent-run-row agent-lane is-${run.status}`}
      type="button"
      style={agentColor(run, colors)}
      onClick={() => onSelect(run.id)}>
      <span className="agent-run-name">
        <OverviewOrb state={ORB_STATE[run.status]} label={run.status} />
        <AgentIdentity run={run} />
        <em>{run.modelName ? modelLabel(run.modelName, models) : "Model pending"}</em>
      </span>
      <b className="agent-run-cost mono">{run.usage ? `$${run.usage.cost.toFixed(4)}` : "—"}</b>
      <span className="agent-run-task" title={request}>
        {request}
      </span>
      <span className="agent-lane-base">
        <ToolCallTrack calls={calls} slots="auto" variant="lane" />
        <small className="mono">
          {calls.length} {calls.length === 1 ? "call" : "calls"} · {hasDuration ? <AgentDuration run={run} /> : "—"}
        </small>
      </span>
    </button>
  );
}

function AgentDetails({
  run,
  threadRuns,
  models,
}: {
  run: DelegatedAgentRunReadModel;
  threadRuns: DelegatedAgentRunReadModel[];
  models: ModelOptionReadModel[];
}) {
  if (isSpawned(run)) return <SpawnedAgentDetails run={run} runs={threadRuns} models={models} />;
  return <SpecialistDetails run={run} models={models} />;
}

function useAgentToolNow(runs: DelegatedAgentRunReadModel[]): number {
  const [now, setNow] = useState(Date.now);
  const hasRunningTools = runs.some(
    run => run.status === "running" && pairAgentActivity(run.activity).some(tool => !tool.completed),
  );
  useEffect(() => {
    if (!hasRunningTools) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [hasRunningTools]);
  return now;
}

function SpawnedAgentDetails({
  run,
  runs,
  models,
}: {
  run: DelegatedAgentRunReadModel;
  runs: DelegatedAgentRunReadModel[];
  models: ModelOptionReadModel[];
}) {
  const toolNow = useAgentToolNow(runs);
  const toolCount = runs.reduce((total, turn) => total + pairAgentActivity(turn.activity).length, 0);
  return (
    <div className="agent-details">
      <AgentStat
        run={run}
        models={models}
        detail={
          run.threadId ? (
            <>
              thread <span className="mono">{run.threadId.slice(0, 8)}</span>
            </>
          ) : undefined
        }
      />
      <AgentUsage
        run={run}
        callsLabel={`${runs.length} ${runs.length === 1 ? "turn" : "turns"} · ${toolCount} ${toolCount === 1 ? "tool" : "tools"}`}
      />
      <div className="agent-body" aria-label={`${agentLabel(run.kind)} conversation`}>
        {runs.map(turn => (
          <AgentExchange key={turn.id} turn={turn} models={models} now={toolNow} childRuntime />
        ))}
      </div>
    </div>
  );
}

function SpecialistDetails({ run, models }: { run: DelegatedAgentRunReadModel; models: ModelOptionReadModel[] }) {
  const toolNow = useAgentToolNow([run]);
  const toolCount = pairAgentActivity(run.activity).length;
  return (
    <div className="agent-details">
      <AgentStat run={run} models={models} detail={run.startedAt ? `started ${clockTime(run.startedAt)}` : undefined} />
      <AgentUsage run={run} callsLabel={`${toolCount} tool ${toolCount === 1 ? "call" : "calls"}`} />
      <div className="agent-body">
        <AgentExchange turn={run} models={models} now={toolNow} />
      </div>
    </div>
  );
}

/** One handoff, read down a single rail: the brief that went out, the work it
    took, and the outcome that came back — only the outcome is raised. */
function AgentExchange({
  turn,
  models,
  now,
  childRuntime = false,
}: {
  turn: DelegatedAgentRunReadModel;
  models: ModelOptionReadModel[];
  now?: number;
  childRuntime?: boolean;
}) {
  const running = turn.status === "running";
  const response = childRuntime ? spawnResponse(turn) : turn.response;
  // A specialist runs once, so its turn number says nothing the panel does not
  // already say; a thread's turns are what the reader is counting.
  const note = childRuntime ? `turn ${turn.turn}` : undefined;
  const cost = turn.usage?.cost;
  return (
    <>
      {turn.request && (
        <article className="exchange-node">
          <span className="exchange-rail">
            <OverviewOrb state="neutral" label="request" />
          </span>
          <div className="exchange-card">
            <header>
              <span className="section-kicker">Request</span>
              {note && <span className="exchange-note">{note}</span>}
            </header>
            <pre className="exchange-request">{turn.request}</pre>
          </div>
        </article>
      )}
      {(turn.activity.length > 0 || !childRuntime) && (
        <article className="exchange-node">
          <span className="exchange-rail">
            <OverviewOrb state="step" label="tool activity" />
          </span>
          <AgentActivity run={turn} childRuntime={childRuntime} now={now} />
        </article>
      )}
      {(response || running) && (
        <article className="exchange-node is-outcome">
          <span className="exchange-rail">
            <OverviewOrb state={ORB_STATE[turn.status]} label={turn.status} />
          </span>
          <div className={`exchange-card is-${turn.status}`}>
            <header>
              <span className={`section-kicker is-${turn.status}`}>
                {turn.status === "failed" ? "Failed" : "Response"}
              </span>
              {note && <span className="exchange-note">{note}</span>}
              {response && !childRuntime && <CopyMessageButton text={response} label="Copy response" />}
            </header>
            {response && (
              <div className={`exchange-body${running ? " is-running" : ""}`}>
                <MarkdownContent text={response} />
              </div>
            )}
            {(turn.startedAt || turn.durationMs !== undefined || cost !== undefined) && (
              <div className="exchange-foot">
                {(turn.startedAt || turn.durationMs !== undefined) && (
                  <WorkTimer
                    key={turn.id}
                    startedAt={running ? turn.startedAt : undefined}
                    durationMs={running ? undefined : turn.durationMs}
                    modelName={turn.modelName ? modelLabel(turn.modelName, models) : undefined}
                    thinkingLevel={turn.thinkingLevel}
                  />
                )}
                {cost !== undefined && <span className="mono push">${cost.toFixed(4)}</span>}
              </div>
            )}
          </div>
        </article>
      )}
    </>
  );
}

/** Status is a state, so it takes the orb rail; model and thinking level are attributes and drop to the sub-line. */
function AgentStat({
  run,
  models,
  detail,
}: {
  run: DelegatedAgentRunReadModel;
  models: ModelOptionReadModel[];
  detail?: ReactNode;
}) {
  const parts: ReactNode[] = [];
  if (run.modelName) parts.push(modelLabel(run.modelName, models));
  if (run.thinkingLevel) parts.push(`${thinkingLabel(run.thinkingLevel)} thinking`);
  if (detail) parts.push(detail);
  return (
    <div className="agent-stat">
      <OverviewOrb state={ORB_STATE[run.status]} label={run.status} />
      <div>
        <strong className={`is-${run.status}`}>{run.status}</strong>
        <small>
          {parts.map((part, index) => (
            <Fragment key={index}>
              {index > 0 && " · "}
              {part}
            </Fragment>
          ))}
        </small>
      </div>
      <AgentDuration run={run} />
    </div>
  );
}

/** Cost leads because it is what the run list column and the audit both ask for. */
function AgentUsage({ run, callsLabel }: { run: DelegatedAgentRunReadModel; callsLabel: string }) {
  const [usageRef, ledCells] = useResponsiveUsageLedCells();
  const usage =
    (isSpawned(run) ? run.sessionUsage : undefined) ??
    run.usage ??
    (run.status === "failed" ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } : undefined);
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const total = input + output;
  const inputPercent = total > 0 ? (input / total) * 100 : 50;
  const outputPercent = total > 0 ? (output / total) * 100 : 50;
  const contextTokens = run.contextTokens;
  const contextLimit = run.contextLimit;
  const hasContext = contextTokens !== undefined && contextTokens !== null && contextLimit !== undefined;
  const contextLabel = hasContext ? `${Math.round((contextTokens / contextLimit) * 100)}%` : "—";
  return (
    <div className={`session-tool-summary agent-usage${usage ? "" : " is-pending"}`} ref={usageRef}>
      <div className="session-tool-call-total is-cost">
        <small>Cost</small>
        <strong className="mono">{usage ? `$${usage.cost.toFixed(4)}` : "—"}</strong>
        <span>{callsLabel}</span>
      </div>
      <div className="session-token-composition">
        <div>
          <small>Input + output</small>
          <strong className="mono">{usage ? formatCompactNumber(total) : "—"}</strong>
        </div>
        <LedBar
          a={inputPercent}
          b={outputPercent}
          cells={ledCells}
          label={`${formatCompactNumber(input)} input tokens and ${formatCompactNumber(output)} output tokens`}
        />
        <div className="session-token-key">
          <span>
            <strong>Input</strong> {formatCompactNumber(input)}
          </span>
          <span>
            <strong>Output</strong> {formatCompactNumber(output)}
          </span>
        </div>
        <div className="session-token-key">
          <span title="Share of prompt tokens served from cache">
            <strong>Cache input</strong> {formatCacheHitRate(input, usage?.cacheRead ?? 0, usage?.cacheWrite ?? 0)}
          </span>
          <span
            title={
              hasContext
                ? `${contextTokens.toLocaleString()} of ${contextLimit.toLocaleString()} tokens (${Math.round((contextTokens / contextLimit) * 100)}%)`
                : "Current context occupancy unavailable"
            }>
            <strong>Context</strong> {contextLabel}
          </span>
        </div>
      </div>
    </div>
  );
}

function AgentActivity({
  run,
  childRuntime = false,
  now,
}: {
  run: DelegatedAgentRunReadModel;
  childRuntime?: boolean;
  now?: number;
}) {
  const tools = useMemo(() => pairAgentActivity(run.activity), [run.activity]);
  const runRunning = run.status === "running";
  const calls = pairedToolCallViews(tools, runRunning, now);
  if (!calls.length)
    return childRuntime ? null : (
      <div className="tool-call-empty">
        <IconTool size={16} />
        <span>No tool activity recorded.</span>
      </div>
    );
  return <ToolCallGroup calls={calls} running={runRunning} />;
}

function AgentDuration({ run }: { run: DelegatedAgentRunReadModel }) {
  const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (run.status !== "running" || Number.isNaN(started)) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [run.id, run.status, started]);
  const elapsed = run.status === "running" && !Number.isNaN(started) ? Math.max(0, now - started) : run.durationMs;
  return elapsed === undefined ? null : <time dateTime={`PT${elapsed / 1_000}S`}>{formatWorkDuration(elapsed)}</time>;
}

/** The name reads as a name; the kind is a chip in the agent's colour. A run
    without a name has only its kind, so the kind takes the name's place. */
function AgentIdentity({ run }: { run: DelegatedAgentRunReadModel }) {
  if (!run.agentName) return <span className="agent-identity">{agentLabel(run.kind)}</span>;
  return (
    <span className="agent-identity">
      <span className="agent-name">{run.agentName}</span>
      <span className="agent-kind-chip">{agentLabel(run.kind)}</span>
    </span>
  );
}

function clockTime(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time) ? "unknown" : new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function isSpawned(run: DelegatedAgentRunReadModel): boolean {
  return run.kind === "spawn_agent" || run.kind === "spawn_session";
}

function spawnResponse(run: DelegatedAgentRunReadModel): string {
  if (run.status === "failed") return run.response ?? "";
  return (run.response ?? "").replace(/^(?:Subagent|Session) [^\n]+:\n?/, "");
}

function agentLabel(kind: DelegatedAgentKind): string {
  if (kind === "repo_scout") return "Repo Scout";
  if (kind === "web_scout") return "Web Scout";
  if (kind === "spawn_agent") return "Private Agent";
  if (kind === "spawn_session") return "Spawned Session";
  return kind === "advisor" ? "Advisor" : "Grunt";
}
