import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { IconArrowBackUp, IconFile, IconGitCompare, IconX } from "@tabler/icons-react";
import type { FileHistoryResult } from "pylon-core/src/file-history.ts";
import type { WorkspaceFileContent, WorkspaceFileDiff } from "../shared/protocol/snapshots";
import { historyColor, type CodeAttribution } from "../shared/code-viewer-model";
import { FileContent, type FileView } from "./files-panel";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";
import "./file-history.css";

const CodeViewer = lazy(() => import("./code-viewer"));

export function FileHistoryViewer({
  path,
  live,
  view,
  onView,
  value,
  targetLine,
  canCompare,
  onClose,
  onError,
  liveEditor,
}: {
  path: string;
  live: RuntimeStoreSnapshot;
  view: FileView;
  onView: (view: FileView) => void;
  value?: WorkspaceFileContent | WorkspaceFileDiff;
  targetLine?: number;
  canCompare: boolean;
  onClose: () => void;
  onError: (error: unknown, fallback: string) => void;
  liveEditor?: ReactNode;
}) {
  const [scope, setScope] = useState<"session" | "all">("session");
  const [limit, setLimit] = useState(40);
  const [selected, setSelected] = useState(view === "base" && canCompare ? "baseline" : "live");
  const [preview, setPreview] = useState(false);
  const [metadata, setMetadata] = useState<{ key: string; result: FileHistoryResult }>();
  const [loaded, setLoaded] = useState<{ key: string; result: FileHistoryResult }>();
  const [error, setError] = useState<string>();
  const [listError, setListError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const scopeChosen = useRef(false);
  const track = useRef<HTMLDivElement>(null);
  const selection = useRef(selected);
  selection.current = selected;
  const runtime = live.runtime;
  const ready = live.connection === "connected" && runtime?.ready && canCompare;
  const contextKey = JSON.stringify([
    runtime?.sessionId,
    runtime?.sessionGeneration,
    path,
    scope,
    limit,
    runtime?.operational.timeline?.revision,
    ready,
  ]);
  const history = metadata?.key === contextKey ? metadata.result : undefined;
  const historical = selected !== "live";
  const historyView = preview ? "change" : view === "diff" ? "diff" : "file";
  const mutableAnchor =
    history?.baselineLabel === "HEAD" &&
    (selected === "baseline" || (historyView === "diff" && !selected.startsWith("git:")));
  const selectionKey = `${contextKey}:${selected}:${historyView}:${mutableAnchor ? runtime?.workspace?.revision : ""}`;
  const result = loaded?.key === selectionKey ? loaded.result : undefined;
  const content = result?.content;

  useEffect(() => {
    // File references can request a view without going through this toolbar.
    if (view === "base" && selected === "live" && canCompare) setSelected("baseline");
    else if (view === "current" && selected === "baseline") setSelected("live");
  }, [view, canCompare]);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    setListError(undefined);
    // Coalesce rapidly changing workspace revisions while an agent is working.
    const timer = window.setTimeout(() => {
      void runtimeStore
        .workspaceHistory({ path, scope, limit }, controller.signal)
        .then(response => {
          if (controller.signal.aborted) return;
          setMetadata({ key: contextKey, result: response });
          if (scope === "session" && !scopeChosen.current && !response.stops.some(stop => stop.kind === "checkpoint")) {
            setScope("all");
            return;
          }
          if (
            selection.current !== "live" &&
            selection.current !== "baseline" &&
            !response.stops.some(stop => stop.id === selection.current)
          ) {
            setSelected("live");
            setPreview(false);
          }
        })
        .catch(reason => {
          if (!controller.signal.aborted)
            setListError(reason instanceof Error ? reason.message : "History is unavailable");
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [contextKey, runtime?.workspace?.revision, retry]);

  useEffect(() => {
    if (!ready || !historical) return;
    const controller = new AbortController();
    setError(undefined);
    const timer = window.setTimeout(() => {
      void runtimeStore
        .workspaceHistory({ path, scope, limit, selected, view: historyView }, controller.signal)
        .then(response => {
          if (!controller.signal.aborted) setLoaded({ key: selectionKey, result: response });
        })
        .catch(reason => {
          if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Version is unavailable");
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [selectionKey, retry]);

  const stops = history?.stops ?? [];
  const checkpoints = stops.filter(stop => stop.kind === "checkpoint");
  const commits = stops.filter(stop => stop.kind === "commit");
  const current = stops.find(stop => stop.id === selected);
  const selectable = useMemo(() => new Set(stops.map(stop => stop.id)), [history]);
  const attribution = useMemo<CodeAttribution | undefined>(
    () =>
      content
        ? {
            oldOwners: content.oldOwners,
            newOwners: content.newOwners,
            owners: new Map(content.owners.map(owner => [owner.id, owner])),
            selected,
            selectable,
          }
        : undefined,
    [content, selected, selectable],
  );
  const loadDiffFiles = useMemo(
    () =>
      content?.before !== undefined && content.after !== undefined
        ? async () => ({ oldFile: { contents: content.before! }, newFile: { contents: content.after! } })
        : undefined,
    [content],
  );

  const pick = (id: string) => {
    setSelected(id);
    if (id === "live" || id === "baseline") setPreview(false);
    if (view !== "diff") onView(id === "baseline" ? "base" : "current");
  };
  useEffect(() => {
    const button = track.current?.querySelector<HTMLButtonElement>("[aria-pressed=true]");
    if (!button || !track.current) return;
    const parent = track.current.getBoundingClientRect();
    const child = button.getBoundingClientRect();
    if (child.left < parent.left) track.current.scrollLeft -= parent.left - child.left + 12;
    else if (child.right > parent.right) track.current.scrollLeft += child.right - parent.right + 12;
  }, [selected, history]);

  const dot = (id: string, title: string, neutral = false) => (
    <button
      key={id}
      type="button"
      className={`file-history-stop${neutral ? " is-neutral" : ""}`}
      style={{ "--history-color": neutral ? "var(--text-muted)" : historyColor(id) } as CSSProperties}
      aria-label={title}
      title={title}
      aria-pressed={selected === id}
      tabIndex={selected === id ? 0 : -1}
      onClick={() => pick(id)}>
      <span />
    </button>
  );

  return (
    <>
      <div className="file-viewer-toolbar">
        <code title={path}>{path}</code>
        <span>
          {canCompare && (
            <button
              className={!preview && view === "base" ? "is-active" : ""}
              disabled={history?.baselineAvailable === false}
              onClick={() => {
                setPreview(false);
                setSelected("baseline");
                onView("base");
              }}>
              <IconArrowBackUp size={14} />
              {history?.baselineLabel === "HEAD" ? "HEAD" : "Baseline"}
            </button>
          )}
          <button
            className={!preview && view === "current" ? "is-active" : ""}
            onClick={() => {
              setPreview(false);
              if (selected === "baseline") setSelected("live");
              onView("current");
            }}>
            <IconFile size={14} />
            {historical && selected !== "baseline"
              ? current?.kind === "commit"
                ? "At this commit"
                : "At this turn"
              : "Working copy"}
          </button>
          <button
            className={!preview && view === "diff" ? "is-active" : ""}
            onClick={() => {
              setPreview(false);
              onView("diff");
            }}>
            <IconGitCompare size={14} />
            Diff
          </button>
          <button className="icon-button" onClick={onClose} aria-label="Close file">
            <IconX size={14} />
          </button>
        </span>
      </div>
      {canCompare && (
        <section className="file-history" aria-label="File history" aria-busy={!history && !listError && !!ready}>
          <div className="file-history-axis">
            <div className="file-history-scopes" role="group" aria-label="History scope">
              <button
                aria-pressed={scope === "session"}
                disabled={!!history && !checkpoints.length}
                onClick={() => {
                  scopeChosen.current = true;
                  setScope("session");
                  if (selected.startsWith("git:")) pick("live");
                }}>
                Session
              </button>
              <button
                aria-pressed={scope === "all"}
                onClick={() => {
                  scopeChosen.current = true;
                  setScope("all");
                }}>
                All history
              </button>
            </div>
            <button
              className="file-history-edge"
              aria-label="Scroll to earlier versions"
              onClick={() => track.current?.scrollBy({ left: -250 })}>
              ‹
            </button>
            <div
              className="file-history-track"
              ref={track}
              role="group"
              aria-label="Saved versions, oldest first"
              onKeyDown={event => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
                const index = buttons.indexOf(event.target as HTMLButtonElement);
                if (index < 0) return;
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)));
                buttons[next]?.click();
                buttons[next]?.focus();
              }}>
              {commits.map(stop => dot(stop.id, `${stop.title} · ${stop.author ?? ""} · ${stop.createdAt}`))}
              {history?.baselineAvailable && (
                <>
                  <span className="file-history-boundary">
                    {history.baselineLabel === "HEAD" ? "HEAD" : "Baseline"}
                  </span>
                  {dot("baseline", history.baselineLabel ?? "Session baseline", true)}
                </>
              )}
              {checkpoints.map(stop => dot(stop.id, `${stop.title} · ${stop.createdAt}`))}
              <span className="file-history-boundary">Live</span>
              {dot("live", "Live working copy — may differ from the last checkpoint", true)}
            </div>
            <button
              className="file-history-edge"
              aria-label="Scroll to later versions"
              onClick={() => track.current?.scrollBy({ left: 250 })}>
              ›
            </button>
          </div>
          <div className="file-history-info">
            <label className="file-history-picker">
              <span className="sr-only">Selected file version</span>
              <select
                value={selected}
                onChange={event => pick(event.target.value)}
                aria-label="Selected file version"
                disabled={!history}>
                <option value="live">Working copy · live</option>
                {[...checkpoints].reverse().map(stop => (
                  <option key={stop.id} value={stop.id}>
                    {stop.title} · {stop.createdAt}
                  </option>
                ))}
                {history?.baselineAvailable && (
                  <option value="baseline">{history.baselineLabel ?? "Session baseline"}</option>
                )}
                {[...commits].reverse().map(stop => (
                  <option key={stop.id} value={stop.id}>
                    {stop.id.slice(4, 11)} · {stop.title} · {stop.author}
                  </option>
                ))}
              </select>
            </label>
            {current?.kind === "checkpoint" && (
              <span
                className={`overview-state-label${current.verification === "passed" ? " is-done" : current.verification === "failed" ? " is-failed" : ""}`}>
                {current.verification === "passed"
                  ? "Verified"
                  : current.verification === "failed"
                    ? "Failed"
                    : "Unverified"}
              </span>
            )}
            {current?.kind === "commit" && (
              <span className="file-history-author" title={current.author}>
                {current.id.slice(4, 11)} · {current.author}
              </span>
            )}
            {current && (
              <button className="secondary-button" onClick={() => setPreview(!preview)}>
                {preview ? "Back to file" : "Show this change"}
              </button>
            )}
            {history?.hasMore && (
              <button className="secondary-button" onClick={() => setLimit(Math.min(200, limit + 40))}>
                Earlier commits
              </button>
            )}
          </div>
          {(listError || history?.partial || (history && !checkpoints.length)) && (
            <div className="file-history-notice" role="status">
              {listError ??
                (history?.partial
                  ? "Showing bounded history; earlier versions or attribution may be unavailable."
                  : "No saved session changes for this path.")}
              {listError && <button onClick={() => setRetry(value => value + 1)}>Retry</button>}
            </div>
          )}
          <details className="file-history-policy">
            <summary>About this history</summary>
            <p>{history?.notice ?? "History is read-only. Live edits are not attributed to a saved turn."}</p>
          </details>
        </section>
      )}
      {!historical ? (
        view === "current" && liveEditor ? liveEditor : <FileContent value={value} view={view} targetLine={targetLine} onError={onError} />
      ) : (
        <>
          {preview && (
            <div className="file-history-notice">
              Showing only this {current?.kind === "commit" ? "commit’s" : "turn’s"} change.
            </div>
          )}
          {content && !content.attributionComplete && (
            <div className="file-history-notice" role="status">
              Some line attribution is unavailable; unassigned lines are left blank.
            </div>
          )}
          {error ? (
            <div className="files-empty large" role="alert">
              {error}
              <button onClick={() => setRetry(value => value + 1)}>Retry</button>
            </div>
          ) : !content ? (
            <div className="files-empty large" role="status">
              Loading version…
            </div>
          ) : content.state !== "available" ? (
            <div className="files-empty large">
              {content.state === "deleted"
                ? "File absent at this version"
                : content.state === "binary"
                  ? "Binary file"
                  : content.state === "oversized"
                    ? "Version exceeds the display limit"
                    : "Version unavailable"}
            </div>
          ) : historyView !== "file" && !content.text ? (
            <div className="files-empty large">No changes</div>
          ) : (
            <Suspense fallback={<div className="files-empty large">Rendering…</div>}>
              <CodeViewer
                key={result!.revision}
                mode={historyView === "file" ? "file" : "diff"}
                path={current?.path ?? path}
                text={content.text ?? ""}
                revision={result!.revision}
                annotationSource={{ kind: "historical", revision: `${selected}: ${result!.revision}` }}
                loadDiffFiles={loadDiffFiles}
                attribution={attribution}
                onSelectOwner={pick}
              />
            </Suspense>
          )}
        </>
      )}
    </>
  );
}
