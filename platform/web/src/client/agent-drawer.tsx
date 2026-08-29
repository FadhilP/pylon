import { IconArrowLeft, IconBotId, IconTool, IconX } from "@tabler/icons-react";
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  formatCacheHitRate,
  formatCompactNumber,
  formatToolDuration,
  formatWorkDuration,
  modelLabel,
} from "../shared/format";
import type { DelegatedAgentKind, DelegatedAgentRunReadModel, ModelOptionReadModel } from "../shared/protocol/events";
import { MarkdownContent, WorkTimer } from "./conversation-panel";
import { thinkingLabel } from "./format";
import { agentColor, type AgentColorMap } from "./agent-color";
import { AnimatedDetails } from "./animated-details";
import { LedBar, OverviewOrb, useResponsiveUsageLedCells, type OverviewState } from "./overview-primitives";
import {
  aggregatePairedAgentTiming,
  pairAgentActivity,
  pairedAgentToolDuration,
  pairedAgentToolStatus,
} from "../shared/agent-activity";

type AgentRunStatus = DelegatedAgentRunReadModel["status"];

const ORB_STATE: Record<AgentRunStatus, OverviewState> = { running: "running", completed: "done", failed: "failed" };

const FILTERS: { status: AgentRunStatus; label: string }[] = [
  { status: "running", label: "live" },
  { status: "completed", label: "done" },
  { status: "failed", label: "failed" },
];

export function AgentPanel({
  runs,
  models,
  colors,
  selectedId,
  onSelect,
  onClose,
}: {
  runs: DelegatedAgentRunReadModel[];
  models: ModelOptionReadModel[];
  colors: AgentColorMap;
  selectedId?: string;
  onSelect: (id?: string) => void;
  onClose: () => void;
}) {
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
      className={`inspector agents-panel is-open${selected ? " has-selection" : ""}`}
      aria-labelledby="agents-title"
      style={selected ? agentColor(selected, colors) : undefined}>
      <header>
        <div>
          {selected && (
            <button
              className="icon-button"
              type="button"
              onClick={() => onSelect(undefined)}
              aria-label="Back to agents">
              <IconArrowLeft size={17} />
            </button>
          )}
          <IconBotId size={18} />
          <strong id="agents-title">{selected ? <AgentIdentity run={selected} /> : "Agents"}</strong>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close agents">
          <IconX size={17} />
        </button>
      </header>
      {selected ? (
        <AgentDetails run={selected} threadRuns={threadRuns} models={models} />
      ) : (
        <AgentList runs={ordered} models={models} colors={colors} onSelect={onSelect} />
      )}
    </aside>
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

  const counts = { running: 0, completed: 0, failed: 0 };
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
  const toolCount = pairAgentActivity(run.activity).length;
  const request = run.request || (run.action ? `${run.action} child` : "Delegated run");
  const hasDuration = Boolean(run.startedAt) || run.durationMs !== undefined;
  return (
    <button
      className={`agent-run-row is-${run.status}`}
      type="button"
      style={agentColor(run, colors)}
      onClick={() => onSelect(run.id)}>
      <OverviewOrb state={ORB_STATE[run.status]} label={run.status} />
      <div className="agent-run-copy">
        <span className="agent-run-name">
          <AgentIdentity run={run} />
        </span>
        <b className="agent-run-cost">{run.usage ? `$${run.usage.cost.toFixed(4)}` : "—"}</b>
        <span className="agent-run-task" title={request}>
          {request}
        </span>
        <span className="agent-run-meta">
          <span>{run.modelName ? modelLabel(run.modelName, models) : "Model pending"}</span>
          {toolCount > 0 && (
            <span>
              {toolCount} {toolCount === 1 ? "tool" : "tools"}
            </span>
          )}
        </span>
        <span className="agent-run-duration">{hasDuration ? <AgentDuration run={run} /> : <time>—</time>}</span>
      </div>
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
      <div className="agent-body agent-conversation-details">
        <section className="agent-conversation" aria-label={`${agentLabel(run.kind)} conversation`}>
          {runs.map(turn => (
            <div className="agent-chat-turn" key={turn.id}>
              {turn.request && (
                <article className="agent-chat-message role-user">
                  <MarkdownContent text={turn.request} />
                </article>
              )}
              <AgentActivity run={turn} childRuntime now={toolNow} />
              {(turn.response || turn.status === "running") && (
                <article className={`agent-chat-message role-assistant is-${turn.status}`}>
                  {turn.response && <MarkdownContent text={spawnResponse(turn)} />}
                  <footer>
                    {(turn.startedAt || turn.durationMs !== undefined) && (
                      <WorkTimer
                        key={turn.id}
                        startedAt={turn.status === "running" ? turn.startedAt : undefined}
                        durationMs={turn.status === "running" ? undefined : turn.durationMs}
                        modelName={turn.modelName ? modelLabel(turn.modelName, models) : undefined}
                        thinkingLevel={turn.thinkingLevel}
                      />
                    )}
                  </footer>
                </article>
              )}
            </div>
          ))}
        </section>
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
        {run.request && (
          <section className="agent-section">
            <h2>Request</h2>
            <pre>{run.request}</pre>
          </section>
        )}
        <AgentActivity run={run} now={toolNow} />
        {run.response && (
          <section className="agent-section agent-response">
            <h2>Response</h2>
            <MarkdownContent text={run.response} />
          </section>
        )}
      </div>
    </div>
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
  const toolNames = [...new Set(tools.map(tool => tool.tool))];
  const runRunning = run.status === "running";
  const timing = aggregatePairedAgentTiming(tools, runRunning, now);
  const toolStatus = runRunning ? "running" : tools.some(tool => tool.failed) ? "failed" : "completed";
  if (!tools.length)
    return childRuntime ? null : (
      <div className="agent-activity-empty">
        <IconTool size={16} />
        <span>No tool activity recorded.</span>
      </div>
    );
  return (
    <AnimatedDetails
      className={`agent-tool-group is-${toolStatus}`}
      summary={
        <>
          <IconTool size={15} />
          <strong>
            {tools.length} tool {tools.length === 1 ? "call" : "calls"}
          </strong>
          <span>
            {toolNames.slice(0, 3).join(", ")}
            {toolNames.length > 3 ? "…" : ""}
          </span>
          {timing && (
            <time
              className={`tool-group-duration is-${timing.status}`}
              dateTime={`PT${timing.durationMs / 1_000}S`}
              aria-label={`${timing.status} tool duration ${formatToolDuration(timing.durationMs)}`}>
              {formatToolDuration(timing.durationMs)}
            </time>
          )}
        </>
      }>
      <div className="agent-tools">
        {tools.map((tool, index) => {
          const status = pairedAgentToolStatus(tool, runRunning);
          const durationMs = pairedAgentToolDuration(tool, runRunning, now);
          return (
            <details className={`tool-disclosure is-${status}`} key={tool.id ?? `${tool.tool}-${index}`}>
              <summary>
                <IconTool size={15} />
                <span className="tool-summary-copy">
                  <strong>{tool.tool}</strong>
                  {tool.input && <code>{tool.input.replace(/\s+/g, " ").trim()}</code>}
                </span>
                <span className="tool-status">
                  {durationMs === undefined ? (
                    status
                  ) : (
                    <>
                      <span className="sr-only">{status}, </span>
                      <time dateTime={`PT${durationMs / 1_000}S`}>{formatToolDuration(durationMs)}</time>
                    </>
                  )}
                </span>
              </summary>
              <div className="tool-details">
                <section>
                  <small>Input</small>
                  <pre>{tool.input || "No input"}</pre>
                </section>
                <section>
                  <small>Output</small>
                  <pre>{tool.output || (status === "running" ? "Waiting for output…" : "No output")}</pre>
                </section>
              </div>
            </details>
          );
        })}
      </div>
    </AnimatedDetails>
  );
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

function AgentIdentity({ run }: { run: DelegatedAgentRunReadModel }) {
  return (
    <span className="agent-identity">
      {run.agentName && (
        <>
          <span className="agent-instance-name">{run.agentName}</span> ·{" "}
        </>
      )}
      {agentLabel(run.kind)}
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
