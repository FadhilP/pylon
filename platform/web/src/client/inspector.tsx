import {
  IconCheck,
  IconCircle,
  IconClock,
  IconDatabase,
  IconFile,
  IconGitBranch,
  IconLayoutDashboard,
  IconListCheck,
  IconSearch,
  IconShieldCheck,
  IconTimeline,
  IconTool,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import DOMPurify from "dompurify";
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from "react";
import { formatCompactNumber } from "../shared/format";
import { highlightSource } from "../shared/markdown";
import type { TimelineCheckpointDiff, TimelineCheckpointFiles } from "../shared/protocol/snapshots";
import { displayTime, displayTimelineTime, formatDuration } from "./format";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";

export type ViewId = "overview" | "timeline" | "memory" | "tools";
type Tone = "success" | "warning" | "danger" | "neutral" | "active";
type IconComponent = ComponentType<{ size?: number; stroke?: number; className?: string }>;

const navigation: Array<{ label: string; items: Array<{ id: ViewId; label: string; icon: IconComponent; hint: string }> }> = [
  {
    label: "Workspace",
    items: [
      { id: "overview", label: "Overview", icon: IconLayoutDashboard, hint: "Run summary" },
      { id: "timeline", label: "Timeline", icon: IconTimeline, hint: "Checkpoints" },
      { id: "memory", label: "Memory", icon: IconDatabase, hint: "Continuity facts" },
    ],
  },
  {
    label: "System",
    items: [
      { id: "tools", label: "Tools", icon: IconTool, hint: "Policies and availability" },
    ],
  },
];

const viewCopy: Record<ViewId, { title: string; description: string }> = {
  overview: { title: "Workspace overview", description: "Live state for the active Pylon session." },
  timeline: { title: "Timeline", description: "Recoverable checkpoints across the current run." },
  memory: { title: "Project memory", description: "Durable facts Continuity keeps for this project." },
  tools: { title: "Tools", description: "Package policies and tool availability." },
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
  const copy = viewCopy[current];
  const items = navigation.flatMap((group) => group.items).filter((item) => availableViews.has(item.id));
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
        {current === "overview" && <Overview live={live} />}
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
  return (
    <div className="page-grid">
      <section className="usage-strip" aria-label="Session usage">
        <div><small>Input</small><strong>{runtime ? formatCompactNumber(runtime.metrics.inputTokens) : "—"}</strong><span>tokens</span></div>
        <div><small>Output</small><strong>{runtime ? formatCompactNumber(runtime.metrics.outputTokens) : "—"}</strong><span>tokens</span></div>
        <div><small>Cache reads</small><strong>{runtime ? formatCompactNumber(runtime.metrics.cacheReadTokens) : "—"}</strong><span>tokens</span></div>
        <div><small>Tool calls</small><strong>{runtime ? formatCompactNumber(runtime.metrics.toolCalls) : "—"}</strong><span>session total</span></div>
      </section>
      <div className="overview-columns">
        {operational?.continuity.availability === "available" && <section className="panel run-panel">
          <PanelHeader title="Current run" meta={work ? displayTime(work.updatedAt) : undefined} />
          {work ? <>
            <div className="run-title-row">
              <div className="run-icon"><IconListCheck size={20} /></div>
              <div><h2 className="run-goal" title={work.goal}>{oneLine(work.goal)}</h2><p className="mono">{work.runId || "Current session"}</p></div>
            </div>
            <div className="run-meta-row">
              <Status tone={work.mode === "executing" ? "active" : work.mode === "completed" ? "success" : "neutral"}>{work.mode}</Status>
              <span>{work.todos.filter((todo) => todo.status === "done").length} of {work.todos.length} complete</span>
            </div>
            <TodoList work={work} />
          </> : <div className="empty-state"><IconListCheck size={20} /><strong>No active work</strong><span>Continuity has no plan for this session.</span></div>}
        </section>}

        {runtime?.discoverIndex && <DiscoverIndex live={live} />}
      </div>

      <div className="overview-lower">
        {operational?.verification.availability === "available" && <section className="panel verification-panel">
          <PanelHeader title="Verification" meta={operational?.verification.scope || "No run"} />
          <div className="check-list">
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
          </div>
        </section>}

      </div>
    </div>
  );
}

function DiscoverIndex({ live }: { live: RuntimeStoreSnapshot }) {
  const [busy, setBusy] = useState(false);
  const index = live.runtime!.discoverIndex!;
  const idle = live.connection === "connected"
    && live.runtime?.ready === true
    && !live.runtime.conversation.workStartedAt
    && !live.pendingUi
    && !busy
    && index.state !== "indexing";
  return <section className="panel index-panel">
    <PanelHeader title="File index" meta={index.state === "indexing" ? "Rebuilding…" : index.state} />
    <dl className="index-metrics">
      <div><dt>Files</dt><dd>{index.files === undefined ? "—" : formatCompactNumber(index.files)}</dd></div>
      <div><dt>Symbols</dt><dd>{index.symbols === undefined ? "—" : formatCompactNumber(index.symbols)}</dd></div>
      <div><dt>Updated</dt><dd>{index.indexedAt ? displayTime(index.indexedAt) : "Not indexed"}</dd></div>
    </dl>
    {index.error && <p className="index-error" role="alert">{index.error}</p>}
    <button className="secondary-button" type="button" disabled={!idle} onClick={() => {
      setBusy(true);
      void runtimeStore.rebuildDiscoverIndex().catch(() => undefined).finally(() => setBusy(false));
    }}>{busy || index.state === "indexing" ? "Rebuilding…" : "Rebuild index"}</button>
  </section>;
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
    <section className="panel memory-panel">
      <PanelHeader title="Saved facts" meta={`${memory.length} project facts`} />
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
      {memory.length === 0 && <div className="empty-state"><IconDatabase size={20} /><strong>No project memory</strong><span>Continuity has not saved durable facts for this project.</span></div>}
      {!idle && memory.length > 0 && <p className="settings-note" role="status">Memory changes are available when the session is idle.</p>}
      {error && <p className="ui-request-error" role="alert">{error}</p>}
    </section>
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
  const active = checkpoints.find((checkpoint) => checkpoint.id === selected) ?? checkpoints[0];
  const enabled = live.connection === "connected" && live.runtime?.ready === true && !busy;
  const act = async (action: "restore" | "fork" | "clear", checkpointId?: string) => {
    if (!enabled) return;
    setBusy(action); setError("");
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
      <section className="timeline-list" aria-label="Checkpoints">
        <div className="timeline-toolbar"><span>{checkpoints.length} checkpoints</span><button className="text-button danger" type="button" disabled={!enabled || checkpoints.length === 0} onClick={() => void act("clear")}><IconTrash size={13} />{busy === "clear" ? "Clearing…" : "Clear timeline"}</button></div>
        {checkpoints.map((checkpoint) => (
          <button
            className={`checkpoint-row ${active?.id === checkpoint.id ? "is-selected" : ""}`}
            key={checkpoint.id}
            aria-pressed={active?.id === checkpoint.id}
            onClick={() => setSelected(checkpoint.id)}
          >
            <span className="checkpoint-copy">
              <span><strong title={checkpoint.title}>{oneLine(checkpoint.title)}</strong><time dateTime={checkpoint.createdAt}>{displayTimelineTime(checkpoint.createdAt)}</time></span>
              <span className="checkpoint-meta">{checkpoint.branch && <span><IconGitBranch size={12} />{checkpoint.branch}</span>}{checkpoint.verified && <span className="verified"><IconCheck size={12} />Verified</span>}{checkpoint.changes && <span>{checkpoint.changes.fileCount} files</span>}{checkpoint.changes && <span className="checkpoint-diff-count"><ins>+{checkpoint.changes.additions}</ins><del>−{checkpoint.changes.deletions}</del></span>}</span>
            </span>
          </button>
        ))}
        {checkpoints.length === 0 && <div className="empty-state"><IconTimeline size={20} /><strong>No checkpoints</strong><span>Timeline has not captured this run.</span></div>}
      </section>
      {active && <aside className="panel checkpoint-detail">
        <span className="section-kicker">Selected checkpoint</span>
        <h2 title={active.title}>{active.title}</h2>
        <dl className="checkpoint-summary">
          <div><dt>Branch</dt><dd>{active.branch || "Detached or unavailable"}</dd></div>
          <div><dt>Verification</dt><dd>{active.verified ? "Passed" : "Not attached"}</dd></div>
          <div><dt>Changes</dt><dd>{active.changes ? `${active.changes.fileCount} files · +${active.changes.additions} −${active.changes.deletions}` : "Calculating…"}</dd></div>
        </dl>
        <div className="checkpoint-actions">
          <button className="primary-button" type="button" disabled={!enabled} onClick={() => void act("fork", active.id)}>{busy === "fork" ? "Forking…" : "Fork & continue"}</button>
          <button className="secondary-button" type="button" disabled={!enabled} onClick={() => void act("restore", active.id)}>{busy === "restore" ? "Restoring…" : "Restore checkpoint"}</button>
        </div>
        <div className="checkpoint-files" aria-label="Checkpoint changed files">
          {files?.files.map((file) => <button type="button" className={selectedPath === file.path ? "is-active" : ""} key={file.path} onClick={() => void openDiff(file.path)}>
            <IconFile size={13} />
            <span title={file.path}>{file.path}</span>
            {file.binary ? <small>binary</small> : <small><ins>+{file.additions}</ins><del>−{file.deletions}</del></small>}
          </button>)}
          {!files && <span className="settings-note">Loading changes…</span>}
          {files && files.files.length === 0 && <span className="settings-note">No file changes</span>}
        </div>
        {selectedPath && <TimelineDiff value={diff} />}
        <div className="runtime-note"><IconShieldCheck size={15} /><span>Timeline confirms every restore, fork, and clear through its remote safety dialog.</span></div>
        {error && <p className="ui-request-error" role="alert">{error}</p>}
      </aside>}
    </div>
  );
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

function PanelHeader({ title, meta }: { title: string; meta?: string }) {
  return <header className="panel-header"><div><h2>{title}</h2>{meta && <span>{meta}</span>}</div></header>;
}

function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status status-${tone}`}><span aria-hidden="true" />{children}</span>;
}
