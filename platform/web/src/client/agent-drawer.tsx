import { IconArrowLeft, IconBotId, IconTool, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { formatToolDuration, formatWorkDuration, modelLabel } from "../shared/format";
import type { DelegatedAgentKind, DelegatedAgentRunReadModel, ModelOptionReadModel } from "../shared/protocol/events";
import { MarkdownContent, WorkTimer } from "./conversation-panel";
import { thinkingLabel } from "./format";
import { agentColor, type AgentColorMap } from "./agent-color";
import { AnimatedDetails } from "./animated-details";
import {
  aggregatePairedAgentTiming,
  pairAgentActivity,
  pairedAgentToolDuration,
  pairedAgentToolStatus,
} from "../shared/agent-activity";

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
          {!selected && (
            <span className="agents-run-count">
              {ordered.length} {ordered.length === 1 ? "run" : "runs"}
            </span>
          )}
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

type AgentRunFilter = "all" | "running" | "failed";

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
  const [filter, setFilter] = useState<AgentRunFilter>("all");
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
  const visibleRuns = filter === "all" ? runs : runs.filter(run => run.status === filter);
  const turns = new Map<number, DelegatedAgentRunReadModel[]>();
  for (const run of visibleRuns) turns.set(run.turn, [...(turns.get(run.turn) ?? []), run]);

  return (
    <div className="agents-list">
      <div className="agents-filterbar" role="group" aria-label="Filter agent runs">
        <AgentFilterButton active={filter === "all"} onClick={() => setFilter("all")}>
          All
        </AgentFilterButton>
        <AgentFilterButton active={filter === "running"} onClick={() => setFilter("running")}>
          Live
        </AgentFilterButton>
        <AgentFilterButton active={filter === "failed"} onClick={() => setFilter("failed")}>
          Errors
        </AgentFilterButton>
        <span>Newest first</span>
      </div>
      <div className="agents-table-summary">
        <span>
          <strong>{counts.running}</strong> working · <strong>{counts.completed}</strong> completed ·{" "}
          <strong>{counts.failed}</strong> failed
        </span>
        <span>${totalCost.toFixed(4)}</span>
      </div>
      <div className="agents-table-head" aria-hidden="true">
        <span>Agent / task</span>
        <span>Status</span>
        <span>Cost</span>
        <span>Time</span>
      </div>
      <div className="agents-table-body">
        {[...turns].map(([turn, items]) => (
          <section key={turn}>
            <h2>{turn > 0 ? `Turn ${turn}` : "Earlier turn"}</h2>
            {items.map(run => (
              <AgentRunRow key={run.id} run={run} models={models} colors={colors} onSelect={onSelect} />
            ))}
          </section>
        ))}
        {!visibleRuns.length && (
          <div className="agents-filter-empty">No {filter === "running" ? "working" : "failed"} runs.</div>
        )}
      </div>
    </div>
  );
}

function AgentFilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" className={active ? "is-active" : undefined} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
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
      className={`agent-table-row is-${run.status}`}
      type="button"
      style={agentColor(run, colors)}
      onClick={() => onSelect(run.id)}>
      <span className="agent-table-main">
        <strong>
          <AgentIdentity run={run} />
        </strong>
        <small title={request}>{request}</small>
        <span className="agent-table-meta">
          <span>{run.modelName ? modelLabel(run.modelName, models) : "Model pending"}</span>
          {toolCount > 0 && (
            <span>
              {toolCount} {toolCount === 1 ? "tool" : "tools"}
            </span>
          )}
        </span>
      </span>
      <span className={`agent-table-state is-${run.status}`}>
        <span aria-hidden="true" />
        {run.status === "running" ? "Live" : run.status === "completed" ? "Done" : "Failed"}
      </span>
      <span className="agent-table-value">{run.usage ? `$${run.usage.cost.toFixed(4)}` : "—"}</span>
      <time className="agent-table-value agent-table-time">{hasDuration ? <AgentDuration run={run} /> : "—"}</time>
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
  return (
    <div className="agent-details agent-conversation-details">
      <div className="agent-metadata">
        <span className={`agent-status is-${run.status}`}>{run.status}</span>
        {run.threadId && (
          <span className="mono" title={run.threadId}>
            {run.threadId.slice(0, 8)}
          </span>
        )}
      </div>
      <AgentUsage run={run} />
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
  );
}

function AgentUsage({ run }: { run: DelegatedAgentRunReadModel }) {
  const usage =
    (isSpawned(run) ? run.sessionUsage : undefined) ??
    run.usage ??
    (run.status === "failed" ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } : undefined);
  return (
    <dl className={`agent-usage${usage ? "" : " is-pending"}`}>
      <div>
        <dt>Input</dt>
        <dd>{usage ? usage.input.toLocaleString() : "—"}</dd>
      </div>
      <div>
        <dt>Output</dt>
        <dd>{usage ? usage.output.toLocaleString() : "—"}</dd>
      </div>
      <div>
        <dt>Cache</dt>
        <dd>{usage ? usage.cacheRead.toLocaleString() : "—"}</dd>
      </div>
      <div>
        <dt>Cost</dt>
        <dd>{usage ? `$${usage.cost.toFixed(4)}` : "—"}</dd>
      </div>
    </dl>
  );
}

function SpecialistDetails({ run, models }: { run: DelegatedAgentRunReadModel; models: ModelOptionReadModel[] }) {
  const toolNow = useAgentToolNow([run]);
  return (
    <div className="agent-details">
      <div className="agent-metadata">
        <span className={`agent-status is-${run.status}`}>{run.status}</span>
        {run.modelName && <span>{modelLabel(run.modelName, models)}</span>}
        {run.thinkingLevel && <span>{thinkingLabel(run.thinkingLevel)}</span>}
        {(run.startedAt || run.durationMs !== undefined) && <AgentDuration key={run.id} run={run} />}
      </div>
      <AgentUsage run={run} />
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
  return elapsed === undefined ? null : <span>{formatWorkDuration(elapsed)}</span>;
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
