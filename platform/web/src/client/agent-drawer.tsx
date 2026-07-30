import { IconArrowLeft, IconBotId, IconTool, IconX } from "@tabler/icons-react";
import { useMemo } from "react";
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

  return (
    <aside id="agents-panel" className="inspector agents-panel is-open" aria-labelledby="agents-title" style={selected ? agentColor(selected.id) : undefined}>
      <header>
        <div>
          {selected && <button className="icon-button" type="button" onClick={() => onSelect(undefined)} aria-label="Back to agents"><IconArrowLeft size={17} /></button>}
          <IconBotId size={18} />
          <strong id="agents-title">{selected ? `${selected.agentName ? `${selected.agentName} · ` : ""}${agentLabel(selected.kind)}` : "Agents"}</strong>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close agents"><IconX size={17} /></button>
      </header>
      {selected ? <AgentDetails run={selected} models={models} /> : <AgentList runs={ordered} onSelect={onSelect} />}
    </aside>
  );
}

function AgentList({ runs, onSelect }: { runs: DelegatedAgentRunReadModel[]; onSelect: (id: string) => void }) {
  if (!runs.length) return <div className="agents-empty"><IconBotId size={24} /><strong>No delegated runs</strong><span>Advisor, Grunt, and Scout activity will appear here.</span></div>;
  const turns = new Map<number, DelegatedAgentRunReadModel[]>();
  for (const run of runs) turns.set(run.turn, [...(turns.get(run.turn) ?? []), run]);
  return <div className="agents-list">
    {[...turns].map(([turn, items]) => <section key={turn}>
      <h2>{turn > 0 ? `Turn ${turn}` : "Earlier turn"}</h2>
      {items.map((run) => <button type="button" key={run.id} style={agentColor(run.id)} onClick={() => onSelect(run.id)}>
        <span className={`agent-state is-${run.status}`} aria-hidden="true" />
        <span><strong>{run.agentName ? `${run.agentName} · ` : ""}{agentLabel(run.kind)}</strong><small>{run.request || "Delegated run"}</small></span>
        <span className={`agent-status is-${run.status}`}>{run.status}</span>
      </button>)}
    </section>)}
  </div>;
}

function AgentDetails({ run, models }: { run: DelegatedAgentRunReadModel; models: ModelOptionReadModel[] }) {
  const tools = useMemo(() => pairActivity(run.activity), [run.activity]);
  const toolNames = [...new Set(tools.map((tool) => tool.tool))];
  const toolStatus = tools.some((tool) => tool.failed) ? "failed" : run.status === "running" ? "running" : "completed";
  const usage = run.usage ?? (run.status === "failed"
    ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }
    : undefined);
  const scout = run.kind === "repo_scout" || run.kind === "web_scout";
  return <div className="agent-details">
    <div className="agent-metadata">
      <span className={`agent-status is-${run.status}`}>{run.status}</span>
      {run.modelName && <span>{modelLabel(run.modelName, models)}</span>}
      {run.thinkingLevel && <span>{thinkingLabel(run.thinkingLevel)}</span>}
      {run.durationMs !== undefined && <span>{formatWorkDuration(run.durationMs)}</span>}
    </div>
    <dl className={`agent-usage${usage ? "" : " is-pending"}`}>
      <div><dt>Input</dt><dd>{usage ? usage.input.toLocaleString() : "—"}</dd></div>
      <div><dt>Output</dt><dd>{usage ? usage.output.toLocaleString() : "—"}</dd></div>
      <div><dt>Cache</dt><dd>{usage ? usage.cacheRead.toLocaleString() : "—"}</dd></div>
      <div><dt>Cost</dt><dd>{usage ? `$${usage.cost.toFixed(4)}` : "—"}</dd></div>
    </dl>
    {run.request && <section className="agent-section"><h2>Request</h2><pre>{run.request}</pre></section>}
    {tools.length > 0 && <AnimatedDetails
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
    </div></AnimatedDetails>}
    {scout && tools.length === 0 && <div className="agent-activity-empty">
      <IconTool size={16} />
      <span>{run.status === "running" ? "Waiting for child tool activity…" : "No child tool activity recorded."}</span>
    </div>}
    {run.response && <section className="agent-section agent-response"><h2>Response</h2><MarkdownContent text={run.response} /></section>}
  </div>;
}

function agentLabel(kind: DelegatedAgentKind): string {
  if (kind === "repo_scout") return "Repo Scout";
  if (kind === "web_scout") return "Web Scout";
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
