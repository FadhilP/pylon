import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { IconLayoutList, IconListTree } from "@tabler/icons-react";
import type {
  WorkspaceSearchFile,
  WorkspaceSearchMatch,
  WorkspaceSearchQuery,
  WorkspaceSearchResult,
} from "../../shared/workspace/workspace-search";
import { ancestors, buildWorkspaceTree, type WorkspaceTreeNode } from "./workspace-tree-model";
import { FileTypeIcon, FolderTypeIcon } from "../rendering/file-icons";
import { runtimeStore } from "../runtime/event-store";
import "./workspace-search.css";

export function openSearch(
  tab: "all" | "files" | "text" | "symbols" | "actions" = "all",
  prefill?: WorkspaceSearchQuery,
) {
  window.dispatchEvent(new CustomEvent("pylon:search", { detail: prefill ? { tab, query: prefill } : tab }));
}

/** Both entry points own their query, but share cancellation, errors and partial-result semantics. */
export function useTextSearch(scope: string) {
  const [result, setResult] = useState<WorkspaceSearchResult>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [stopped, setStopped] = useState(false);
  const [submitted, setSubmitted] = useState<WorkspaceSearchQuery>();
  const current = useRef<AbortController | undefined>(undefined);
  const cancel = useCallback(() => {
    current.current?.abort();
    current.current = undefined;
    setRunning(false);
  }, []);
  const reset = useCallback(() => {
    cancel();
    setResult(undefined);
    setSubmitted(undefined);
    setError("");
    setStopped(false);
  }, [cancel]);
  useEffect(() => {
    reset();
    return cancel;
  }, [scope, cancel, reset]);
  const run = useCallback(
    async (input: WorkspaceSearchQuery) => {
      cancel();
      setError("");
      setStopped(false);
      setResult(undefined);
      setSubmitted(input.query ? { ...input } : undefined);
      if (!input.query) return;
      const controller = new AbortController();
      current.current = controller;
      setRunning(true);
      const update = (value: WorkspaceSearchResult) => {
        if (current.current === controller) setResult(value);
      };
      try {
        update(await runtimeStore.workspaceSearch(input, controller.signal, update));
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Search failed");
      } finally {
        if (current.current === controller) {
          current.current = undefined;
          setRunning(false);
        }
      }
    },
    [cancel],
  );
  return {
    result,
    running,
    error,
    stopped,
    submitted,
    run,
    cancel,
    reset,
    stop: () => {
      cancel();
      setStopped(true);
    },
  };
}
export type TextSearch = ReturnType<typeof useTextSearch>;

export function SearchOptions({
  value,
  onChange,
}: {
  value: WorkspaceSearchQuery;
  onChange: (value: WorkspaceSearchQuery) => void;
}) {
  const flags = [
    ["caseSensitive", "Aa", "Match case"],
    ["wholeWord", "|ab|", "Whole word"],
    ["regex", ".*", "Regular expression"],
  ] as const;
  return (
    <div className="workspace-search-options">
      {flags.map(([key, label, title]) => (
        <button
          type="button"
          key={key}
          aria-label={title}
          title={title}
          aria-pressed={!!value[key]}
          onClick={() => onChange({ ...value, [key]: !value[key] })}>
          {label}
        </button>
      ))}
      <button
        type="button"
        aria-pressed={!!value.touched}
        title="Only files changed since this session's baseline"
        onClick={() => onChange({ ...value, touched: !value.touched })}>
        Changed
      </button>
      <input
        aria-label="Include globs"
        placeholder="*.ts, src/**"
        maxLength={500}
        value={value.glob ?? ""}
        onChange={event => onChange({ ...value, glob: event.target.value })}
      />
    </div>
  );
}

export function SearchStatus({
  search,
  summary = true,
}: {
  search: Pick<TextSearch, "result" | "running" | "error" | "stopped" | "submitted">;
  summary?: boolean;
}) {
  const { result, running, error, stopped, submitted } = search;
  const total = result?.files.reduce((sum, file) => sum + file.matches.length, 0) ?? 0;
  return (
    <div className="workspace-search-status" role="status">
      {error ? (
        <span className="search-warning">{error}</span>
      ) : summary ? (
        <span>
          {running ? "Searching… " : stopped ? "Stopped · partial results · " : ""}
          {result
            ? `${total} matching lines in ${result.files.length} files · ${(result.elapsedMs / 1000).toFixed(1)}s`
            : submitted
              ? "No results returned yet"
              : "Search the working copy"}
        </span>
      ) : null}
      {submitted?.query && <span title={submitted.query}>Query: {submitted.query}</span>}
      {result?.engine === "grep" && <span>ripgrep is not installed; using grep. Regex syntax follows grep.</span>}
      {result?.timedOut && <span className="search-warning">Search timed out; results are incomplete.</span>}
      {(result?.truncated || result?.files.some(file => file.capped)) && (
        <span className="search-warning">
          Results limited: up to 100 files, 20 matching lines per file, bounded snippets.
        </span>
      )}
      {result?.inventoryTruncated && (
        <span className="search-warning">Workspace inventory is limited to 10,000 files.</span>
      )}
      {!!result?.skipped && <span>{result.skipped} entries skipped (oversized, unavailable, or unsupported).</span>}
      {result && !running && !error && !total && <span>No matching lines returned.</span>}
    </div>
  );
}

export function MatchText({ match }: { match: WorkspaceSearchMatch }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const range of match.ranges) {
    if (range.start < at || range.end > match.text.length || range.end <= range.start) continue;
    parts.push(
      match.text.slice(at, range.start),
      <mark key={`${range.start}:${range.end}`}>{match.text.slice(range.start, range.end)}</mark>,
    );
    at = range.end;
  }
  parts.push(match.text.slice(at));
  return <>{parts}</>;
}

export function SearchResults({
  files,
  layout = "grouped",
  query,
  onOpen,
  onPreview,
  selected,
  controls = true,
}: {
  files: WorkspaceSearchFile[];
  layout?: "tree" | "grouped";
  /** The submitted query that produced files, never the currently edited input. */
  query?: WorkspaceSearchQuery;
  onOpen: (path: string, line?: number, query?: WorkspaceSearchQuery) => void;
  onPreview?: (path: string, line?: number) => void;
  selected?: string;
  controls?: boolean;
}) {
  const [closed, setClosed] = useState(new Set<string>());
  const host = useRef<HTMLDivElement>(null);
  const toggle = (path: string) =>
    setClosed(previous => {
      const next = new Set(previous);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const byPath = new Map(files.map(file => [file.path, file]));
  const folderHits = new Map<string, number>();
  for (const file of files)
    for (const path of ancestors(file.path)) folderHits.set(path, (folderHits.get(path) ?? 0) + file.matches.length);
  const fileRows = (file: WorkspaceSearchFile, depth: number) => (
    <div key={file.path}>
      <button
        type="button"
        className={`workspace-search-file${file.changed ? " is-changed" : ""}`}
        style={{ paddingLeft: 10 + depth * 12 }}
        title={file.path}
        aria-expanded={!closed.has(file.path)}
        onClick={() => (controls ? toggle(file.path) : onPreview?.(file.path, file.matches[0]?.line))}
        onDoubleClick={() => onOpen(file.path, undefined, query)}>
        <FileTypeIcon path={file.path} size={15} />
        <span>{layout === "tree" ? file.path.split("/").at(-1) : file.path}</span>
        <small>
          {file.matches.length}
          {file.capped ? "+" : ""}
        </small>
      </button>
      {!closed.has(file.path) &&
        file.matches.map(match => (
          <button
            type="button"
            key={match.line}
            className={`workspace-search-match${selected === `${file.path}:${match.line}` ? " is-selected" : ""}`}
            data-search-hit={`${file.path}:${match.line}`}
            style={{ paddingLeft: 10 + depth * 12 }}
            title={`${file.path}:${match.line}`}
            onClick={() => (onPreview ?? ((path: string, line?: number) => onOpen(path, line, query)))(file.path, match.line)}
            onDoubleClick={() => onOpen(file.path, match.line, query)}
            onKeyDown={event => {
              if (event.key === "Enter") {
                event.preventDefault();
                onOpen(file.path, match.line, query);
              }
            }}>
            <span>{match.line}</span>
            <code>
              <MatchText match={match} />
            </code>
          </button>
        ))}
      {!closed.has(file.path) && file.capped && (
        <small className="search-warning workspace-search-tail">
          More matching lines in this file; results limited.
        </small>
      )}
    </div>
  );
  const treeRows = (node: WorkspaceTreeNode, depth = 0): ReactNode =>
    node.children.map(child => {
      if (!child.directory) {
        const file = byPath.get(child.path);
        return file && fileRows(file, depth);
      }
      let tail = child;
      const names = [child.name];
      while (tail.children.length === 1 && tail.children[0].directory) {
        tail = tail.children[0];
        names.push(tail.name);
      }
      return (
        <div key={child.path}>
          <button
            type="button"
            className="workspace-search-file"
            style={{ paddingLeft: 10 + depth * 12 }}
            aria-expanded={!closed.has(child.path)}
            onClick={() => toggle(child.path)}>
            <FolderTypeIcon name={tail.name} open={!closed.has(child.path)} size={15} />
            <span>{names.join("/")}</span>
            <small>{folderHits.get(child.path)}</small>
          </button>
          {!closed.has(child.path) && treeRows(tail, depth + 1)}
        </div>
      );
    });
  return (
    <div className="workspace-search-results-shell">
      {controls && !!files.length && (
        <div className="workspace-search-fold">
          <button
            type="button"
            onClick={() => setClosed(closed.size ? new Set() : new Set([...byPath.keys(), ...folderHits.keys()]))}>
            {closed.size ? "Expand all" : "Collapse all"}
          </button>
        </div>
      )}
      <div
        className="workspace-search-results"
        ref={host}
        aria-label="Search results"
        onKeyDown={event => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const buttons = [...(host.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
          const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)))];
          if (next) {
            event.preventDefault();
            next.focus();
          }
        }}>
        {layout === "tree"
          ? treeRows(buildWorkspaceTree(files.map(file => ({ path: file.path }))))
          : files.map(file => fileRows(file, 0))}
      </div>
    </div>
  );
}

export function ExplorerSearch({
  scope,
  query,
  onQuery,
  onOpen,
  children,
}: {
  scope: string;
  query: string;
  onQuery: (query: string) => void;
  onOpen: (path: string, line?: number, query?: WorkspaceSearchQuery) => void;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<"path" | "text">("path");
  const [input, setInput] = useState<WorkspaceSearchQuery>({ query: "" });
  const [layout, setLayout] = useState<"tree" | "grouped">("tree");
  const search = useTextSearch(scope);
  const { run } = search;
  useEffect(() => {
    setInput({ query: "" });
    setMode("path");
  }, [scope]);
  useEffect(() => {
    if (mode !== "text") return;
    const timer = setTimeout(() => void run(input), 250);
    return () => clearTimeout(timer);
  }, [mode, input, run]);
  const matched = search.result?.files.reduce((sum, file) => sum + file.matches.length, 0) ?? 0;
  const summary = search.running
    ? "Searching…"
    : !search.submitted
      ? "Search the working copy"
      : matched
        ? `${matched} lines in ${search.result?.files.length} files`
        : "No matching lines";
  return (
    <div className="workspace-search-explorer">
      <form className="files-search" onSubmit={event => event.preventDefault()}>
        <button
          type="button"
          aria-label="Open search popup"
          title="Open search popup"
          onClick={() => openSearch(mode === "path" ? "files" : "text")}>
          ⌕
        </button>
        <input
          aria-label={mode === "path" ? "Filter files" : "Search file contents"}
          value={mode === "path" ? query : input.query}
          maxLength={mode === "path" ? 500 : 2000}
          placeholder={mode === "path" ? "Filter files" : "Search text"}
          onChange={event =>
            mode === "path" ? onQuery(event.target.value) : setInput({ ...input, query: event.target.value })
          }
        />
        {search.running && <i className="search-busy" aria-hidden="true" />}
        {(["path", "text"] as const).map(value => (
          <button
            type="button"
            key={value}
            aria-pressed={mode === value}
            onClick={() => {
              if (value !== mode && search.running) search.stop();
              setMode(value);
            }}>
            {value}
          </button>
        ))}
      </form>
      {mode === "path" ? (
        children
      ) : (
        <>
          <SearchOptions value={input} onChange={setInput} />
          <div className="workspace-search-summary">
            <span role="status">{summary}</span>
            <div className="workspace-search-layout">
              {([["tree", "Show in tree", IconListTree], ["grouped", "Group by file", IconLayoutList]] as const).map(
                ([value, title, Icon]) => (
                  <button
                    type="button"
                    key={value}
                    title={title}
                    aria-label={title}
                    aria-pressed={layout === value}
                    onClick={() => setLayout(value)}>
                    <Icon size={17} />
                  </button>
                ),
              )}
            </div>
          </div>
          <SearchResults
            key={JSON.stringify(search.submitted)}
            files={search.result?.files ?? []}
            layout={layout}
            query={search.submitted}
            onOpen={onOpen}
          />
          <SearchStatus search={search} summary={false} />
        </>
      )}
    </div>
  );
}
