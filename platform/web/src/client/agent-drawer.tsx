import { IconArrowLeft, IconBotId, IconTool, IconX } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { formatWorkDuration, modelLabel } from "../shared/format";
import type { DelegatedAgentActivityReadModel, DelegatedAgentKind, DelegatedAgentRunReadModel, ModelOptionReadModel } from "../shared/protocol/events";
import { MarkdownContent } from "./conversation-panel";
import { thinkingLabel } from "./format";
import { agentColor } from "./agent-color";
import { AnimatedDetails } from "./animated-details";

export function AgentPanel({ runs, models, selectedId, onSelect, onClose }: {
  runs: DelegatedAgentRunReadModel[];
  models: ModelOptionReadModel[];
  selectedId?: string;
  onSelect: (id?: string) => void;
  onClose: () => void;
}) {
  const ordered = useMemo(() => [...runs].reverse(), [runs]);
  const selected = ordered.find((run) => run.id === selectedId);
  const threadRuns = selected && isSpawned(selected)
    ? runs.filter((run) => run.kind === selected.kind && (selected.threadId ? run.threadId === selected.threadId : run.id === selected.id))
    : selected ? [selected] : [];

  return (
    <aside id="agents-panel" className={`inspector agents-panel is-open${selected ? " has-selection" : ""}`} aria-labelledby="agents-title" style={selected ? agentColor(selected) : undefined}>
      <header>
        <div>
          {selected && <button className="icon-button" type="button" onClick={() => onSelect(undefined)} aria-label="Back to agents"><IconArrowLeft size={17} /></button>}
          <IconBotId size={18} />
          <strong id="agents-title">{selected ? <AgentIdentity run={selected} /> : "Agents"}</strong>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close agents"><IconX size={17} /></button>
      </header>
      {selected
        ? <AgentDetails run={selected} threadRuns={threadRuns} models={models} />
        : <AgentList runs={ordered} models={models} onSelect={onSelect} />}
    </aside>
  );
}

function AgentList({ runs, models, onSelect }: { runs: DelegatedAgentRunReadModel[]; models: ModelOptionReadModel[]; onSelect: (id: string) => void }) {
  if (!runs.length) return <div className="agents-empty"><IconBotId size={24} /><strong>No delegated runs</strong><span>Advisor, Grunt, Scout, and spawned child activity will appear here.</span></div>;
  const turns = new Map<number, DelegatedAgentRunReadModel[]>();
  for (const run of runs) turns.set(run.turn, [...(turns.get(run.turn) ?? []), run]);
  return <div className="agents-list">
    {[...turns].map(([turn, items]) => <section key={turn}>
      <h2>{turn > 0 ? `Turn ${turn}` : "Earlier turn"}</h2>
      {items.map((run) => <button type="button" key={run.id} style={agentColor(run)} onClick={() => onSelect(run.id)}>
        <span className="agent-run-copy">
          <strong className="agent-run-heading">
            <AgentIdentity run={run} />
            <span className={`agent-state is-${stateName(run.status)}`} aria-hidden="true" />
            <span className="sr-only">{stateName(run.status)}</span>
          </strong>
          <small>{run.request || (run.action ? `${run.action} child` : "Delegated run")}</small>
          <span className="agent-run-facts">
            <span>{run.modelName ? modelLabel(run.modelName, models) : "Model pending"}</span>
            <span>{run.usage ? `$${run.usage.cost.toFixed(4)}` : "Cost pending"}</span>
            {(run.startedAt || run.durationMs !== undefined) && <time className="agent-run-duration"><AgentDuration run={run} /></time>}
          </span>
        </span>
      </button>)}
    </section>)}
  </div>;
}

function AgentDetails({ run, threadRuns, models }: { run: DelegatedAgentRunReadModel; threadRuns: DelegatedAgentRunReadModel[]; models: ModelOptionReadModel[] }) {
  if (isSpawned(run)) return <SpawnedAgentDetails run={run} runs={threadRuns} models={models} />;
  return <SpecialistDetails run={run} models={models} />;
}

function SpawnedAgentDetails({ run, runs, models }: { run: DelegatedAgentRunReadModel; runs: DelegatedAgentRunReadModel[]; models: ModelOptionReadModel[] }) {
  return <div className="agent-details agent-conversation-details">
    <div className="agent-metadata">
      <span className={`agent-status is-${run.status}`}>{run.status}</span>
      {run.threadId && <span className="mono" title={run.threadId}>{run.threadId.slice(0, 8)}</span>}
      {run.modelName && <span>{modelLabel(run.modelName, models)}</span>}
      {run.thinkingLevel && <span>{thinkingLabel(run.thinkingLevel)}</span>}
      {(run.startedAt || run.durationMs !== undefined) && <AgentDuration key={run.id} run={run} />}
    </div>
    <AgentUsage run={run} />
    <section className="agent-conversation" aria-label={`${agentLabel(run.kind)} conversation`}>
      {runs.map((turn) => <div className="agent-chat-turn" key={turn.id}>
        {turn.request && <article className="agent-chat-message role-user">
          <MarkdownContent text={turn.request} />
          <footer><span>Turn {turn.turn}</span></footer>
        </article>}
        <AgentActivity run={turn} childRuntime />
        {(turn.response || turn.status === "running") && <article className={`agent-chat-message role-assistant is-${turn.status}`}>
          {turn.response ? <MarkdownContent text={spawnResponse(turn)} /> : <p>Child is working…</p>}
          <footer>
            {turn.status === "running" && <AgentDuration key={turn.id} run={turn} />}
            {turn.status !== "running" && turn.durationMs !== undefined && <span>Worked for {formatWorkDuration(turn.durationMs)}</span>}
          </footer>
        </article>}
      </div>)}
    </section>
  </div>;
}

function AgentUsage({ run }: { run: DelegatedAgentRunReadModel }) {
  const usage = run.usage ?? (run.status === "failed"
    ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    : undefined);
  return <dl className={`agent-usage${usage ? "" : " is-pending"}`}>
    <div><dt>Input</dt><dd>{usage ? usage.input.toLocaleString() : "—"}</dd></div>
    <div><dt>Output</dt><dd>{usage ? usage.output.toLocaleString() : "—"}</dd></div>
    <div><dt>Cache</dt><dd>{usage ? usage.cacheRead.toLocaleString() : "—"}</dd></div>
    <div><dt>Cost</dt><dd>{usage ? `$${usage.cost.toFixed(4)}` : "—"}</dd></div>
  </dl>;
}

function SpecialistDetails({ run, models }: { run: DelegatedAgentRunReadModel; models: ModelOptionReadModel[] }) {
  return <div className="agent-details">
    <div className="agent-metadata">
      <span className={`agent-status is-${run.status}`}>{run.status}</span>
      {run.modelName && <span>{modelLabel(run.modelName, models)}</span>}
      {run.thinkingLevel && <span>{thinkingLabel(run.thinkingLevel)}</span>}
      {(run.startedAt || run.durationMs !== undefined) && <AgentDuration key={run.id} run={run} />}
    </div>
    <AgentUsage run={run} />
    {run.request && <section className="agent-section"><h2>Request</h2><pre>{run.request}</pre></section>}
    <AgentActivity run={run} />
    {run.response && <section className="agent-section agent-response"><h2>Response</h2><MarkdownContent text={run.response} /></section>}
  </div>;
}

function AgentActivity({ run, childRuntime = false }: { run: DelegatedAgentRunReadModel; childRuntime?: boolean }) {
  const tools = useMemo(() => pairActivity(run.activity), [run.activity]);
  const toolNames = [...new Set(tools.map((tool) => tool.tool))];
  const toolStatus = tools.some((tool) => tool.failed) ? "failed" : run.status === "running" ? "running" : "completed";
  if (!tools.length) return childRuntime ? null : <div className="agent-activity-empty"><IconTool size={16} /><span>No tool activity recorded.</span></div>;
  return <AnimatedDetails
    className={`agent-tool-group is-${toolStatus}`}
    summary={<><IconTool size={15} /><strong>{tools.length} tool {tools.length === 1 ? "call" : "calls"}</strong><span>{toolNames.slice(0, 3).join(", ")}{toolNames.length > 3 ? "…" : ""}</span></>}
  ><div className="agent-tools">
    {tools.map((tool, index) => <details className={`tool-disclosure ${tool.failed ? "is-failed" : run.status === "running" && !tool.output ? "is-running" : ""}`} key={`${tool.tool}-${index}`}>
      <summary>
        <IconTool size={15} />
        <span className="tool-summary-copy"><strong>{tool.tool}</strong>{tool.input && <code>{tool.input.replace(/\s+/g, " ").trim()}</code>}</span>
        <span className="tool-status">{tool.failed ? "failed" : tool.output ? "completed" : "running"}</span>
      </summary>
      <div className="tool-details">
        <section><small>Input</small><pre>{tool.input || "No input"}</pre></section>
        <section><small>Output</small><pre>{tool.output || (run.status === "running" ? "Waiting for output…" : "No output")}</pre></section>
      </div>
    </details>)}
  </div></AnimatedDetails>;
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
  const elapsed = run.status === "running" && !Number.isNaN(started)
    ? Math.max(0, now - started)
    : run.durationMs;
  return elapsed === undefined ? null : <span>{formatWorkDuration(elapsed)}</span>;
}

function AgentIdentity({ run }: { run: DelegatedAgentRunReadModel }) {
  return <span className="agent-identity">{run.agentName && <><span className="agent-instance-name">{run.agentName}</span> · </>}{agentLabel(run.kind)}</span>;
}

function stateName(status: DelegatedAgentRunReadModel["status"]): "working" | "completed" | "failed" {
  return status === "running" ? "working" : status;
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

function pairActivity(activity: DelegatedAgentActivityReadModel[]) {
  const tools: Array<{ tool: string; input?: string; output?: string; failed?: boolean }> = [];
  for (const item of activity) {
    if (item.kind === "call") {
      tools.push({ tool: item.tool, input: item.text });
      continue;
    }
    const target = [...tools].reverse().find((tool) => tool.tool === item.tool && tool.output === undefined);
    if (target) {
      target.output = item.text;
      target.failed = item.isError;
    } else {
      tools.push({ tool: item.tool, output: item.text, failed: item.isError });
    }
  }
  return tools;
}
