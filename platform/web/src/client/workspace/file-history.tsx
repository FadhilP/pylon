import { createPortal } from "react-dom";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { IconArrowBackUp, IconFile, IconGitCompare, IconX } from "@tabler/icons-react";
import type { FileHistoryResult } from "pylon-core/src/file-history.ts";
import type { WorkspaceFileContent, WorkspaceFileDiff } from "../../shared/protocol/snapshots";
import { historyColor, type CodeAttribution } from "../../shared/workspace/code-viewer-model";
import { FileContent, type FileView } from "./files-panel";
import { runtimeStore, type RuntimeStoreSnapshot } from "../runtime/event-store";
import { displayDate, displayTimelineTime } from "../ui/display-format";
import { AboutPopover } from "../ui/about-popover";
import "./file-history.css";

const CodeViewer = lazy(() => import("../rendering/code-viewer"));

type HistoryScope = "session" | "all";
type ChangeCounts = { added: number; removed: number };

const CODE_SKELETON = [62, 45, 78, 34, 70, 52, 84, 40, 66, 30, 74, 48];
function initials(name?: string) {
  return name
    ?.split(/\s+/)
    .filter(Boolean)
    .map(part => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

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
  const [scope, setScope] = useState<HistoryScope>("session");
  const [limit, setLimit] = useState(40);
  const [selected, setSelected] = useState(view === "base" && canCompare ? "baseline" : "live");
  const [metadata, setMetadata] = useState<{ key: string; result: FileHistoryResult }>();
  const [loaded, setLoaded] = useState<{ key: string; result: FileHistoryResult }>();
  const [error, setError] = useState<string>();
  const [listError, setListError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const [listActive, setListActive] = useState(0);
  const [popupPosition, setPopupPosition] = useState({ left: 12, top: 12 });
  const [edgeState, setEdgeState] = useState({ before: true, after: true });
  const [, setCountEpoch] = useState(0);
  const scopeChosen = useRef(false);
  const track = useRef<HTMLDivElement>(null);
  const selection = useRef(selected);
  const titleButton = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const optionButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const restoreTitleFocus = useRef(false);
  const wasListOpen = useRef(false);
  const countCache = useRef(new Map<string, ChangeCounts>());
  selection.current = selected;
  const runtime = live.runtime;
  const ready = live.connection === "connected" && runtime?.ready && canCompare;
  const historyKey = JSON.stringify([runtime?.sessionId, runtime?.workspace?.mode, runtime?.cwdLabel, path, scope, limit]);
  const contextKey = JSON.stringify([historyKey, runtime?.sessionGeneration, runtime?.operational.timeline?.revision, ready]);
  const history = metadata?.key === historyKey ? metadata.result : undefined;
  const historical = selected !== "live";
  const historyView = view === "diff" ? "diff" : "file";
  const mutableAnchor =
    history?.baselineLabel === "HEAD" &&
    (selected === "baseline" || (historyView === "diff" && !selected.startsWith("git:")));
  const selectionKey = `${contextKey}:${selected}:${historyView}:${mutableAnchor ? runtime?.workspace?.revision : ""}`;
  const displayKey = `${historyKey}:${selected}:${historyView}`;
  const result = loaded?.key === displayKey ? loaded.result : undefined;
  const content = result?.content;
  useEffect(() => { countCache.current.clear(); }, [contextKey]);

  useEffect(() => {
    if (view === "base" && selected === "live" && canCompare) setSelected("baseline");
    else if (view === "current" && selected === "baseline") setSelected("live");
  }, [view, canCompare]);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    setListError(undefined);
    const timer = window.setTimeout(() => {
      void runtimeStore
        .workspaceHistory({ path, scope, limit }, controller.signal)
        .then(response => {
          if (controller.signal.aborted) return;
          setMetadata({ key: historyKey, result: response });
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
          if (controller.signal.aborted) return;
          setLoaded({ key: displayKey, result: response });
          if (response.content?.changes) {
            countCache.current.set(`${contextKey}:${selected}`, response.content.changes);
            setCountEpoch(value => value + 1);
          }
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

  const stops = useMemo(() => history?.stops ?? [], [history]);
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

  const baselineTitle = history?.baselineLabel ?? "Baseline";
  const selectedTitle = selected === "live" ? "Live working copy" : selected === "baseline" ? baselineTitle : current?.title ?? "Version unavailable";
  const selectedNeutral = selected === "live" || selected === "baseline";
  const selectedColor = selectedNeutral ? "var(--text-muted)" : historyColor(selected);
  const countFor = (id: string) => countCache.current.get(`${contextKey}:${id}`);
  const selectedCounts = countFor(selected);

  const pick = (id: string) => {
    setSelected(id);
    if (view !== "diff") onView(id === "baseline" ? "base" : "current");
  };
  const closeVersionList = (restoreFocus = true) => {
    restoreTitleFocus.current = restoreFocus;
    setListOpen(false);
  };

  const updateEdges = () => {
    const node = track.current;
    if (!node) return;
    const room = node.scrollWidth - node.clientWidth;
    setEdgeState({ before: node.scrollLeft <= 1, after: node.scrollLeft >= room - 1 });
  };
  const scrollTrack = (direction: -1 | 1) => {
    const node = track.current;
    if (!node) return;
    node.scrollBy({
      left: direction * node.clientWidth * 0.8,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  useEffect(() => {
    const button = track.current?.querySelector<HTMLButtonElement>("[aria-pressed=true]");
    if (!button || !track.current) return;
    const parent = track.current.getBoundingClientRect();
    const child = button.getBoundingClientRect();
    if (child.left < parent.left) track.current.scrollLeft -= parent.left - child.left + 12;
    else if (child.right > parent.right) track.current.scrollLeft += child.right - parent.right + 12;
    updateEdges();
  }, [selected, history]);

  const listVersions = useMemo(
    () => [
      { id: "live", title: "Live working copy", neutral: true },
      ...[...checkpoints].reverse().map(stop => ({ ...stop, neutral: false })),
      { id: "baseline", title: baselineTitle, neutral: true },
      ...[...commits].reverse().map(stop => ({ ...stop, neutral: false })),
    ],
    [history, baselineTitle],
  );

  useEffect(() => {
    if (!listOpen) {
      if (wasListOpen.current && restoreTitleFocus.current) titleButton.current?.focus();
      wasListOpen.current = false;
      return;
    }
    wasListOpen.current = true;
    const selectedIndex = Math.max(0, listVersions.findIndex(item => item.id === selected));
    setListActive(selectedIndex);
    const position = () => {
      const anchor = titleButton.current?.getBoundingClientRect();
      const menu = popup.current?.getBoundingClientRect();
      if (!anchor || !menu) return;
      const left = Math.max(12, Math.min(anchor.left, window.innerWidth - menu.width - 12));
      const below = anchor.bottom + 6;
      const top = below + menu.height <= window.innerHeight - 12 ? below : Math.max(12, anchor.top - menu.height - 6);
      setPopupPosition({ left, top });
    };
    const timer = window.requestAnimationFrame(position);
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !titleButton.current?.contains(event.target as Node)) closeVersionList();
    };
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.cancelAnimationFrame(timer);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [listOpen, listVersions, selected]);

  useEffect(() => {
    if (listOpen) optionButtons.current[listActive]?.focus();
  }, [listOpen, listActive]);

  const moveListFocus = (next: number) => setListActive(Math.max(0, Math.min(listVersions.length - 1, next)));
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      titleButton.current?.focus({ preventScroll: true });
      closeVersionList(false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeVersionList();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveListFocus(listActive + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveListFocus(listActive - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveListFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveListFocus(listVersions.length - 1);
    }
  };

  const dot = (id: string, title: string, neutral = false, edge?: "first" | "last") => (
    <button
      key={id}
      type="button"
      className={`file-history-stop${neutral ? " is-neutral" : ""}${edge ? ` is-${edge}` : ""}`}
      style={{ "--history-color": neutral ? "var(--text-muted)" : historyColor(id) } as CSSProperties}
      aria-label={title}
      title={title}
      aria-pressed={selected === id}
      tabIndex={selected === id ? 0 : -1}
      onClick={() => pick(id)}>
      <span />
    </button>
  );
  const gap = (value: number | null | undefined, kind: "commit" | "checkpoint") => {
    if (value === undefined) return null;
    const text = value === null ? "other commits" : `${value} ${kind === "checkpoint" ? "turn" : "commit"}${value === 1 ? "" : "s"}`;
    return (
      <span className="file-history-gap" title={text}>
        <span>{text}</span>
      </span>
    );
  };

  const popupMenu = listOpen
    ? createPortal(
        <div
          ref={popup}
          className="file-history-version-list"
          role="listbox"
          aria-label="File versions, newest first"
          onKeyDown={onListKeyDown}
          style={{ left: popupPosition.left, top: popupPosition.top }}>
          {listVersions.map((item, index) => {
            const itemCounts = countFor(item.id);
            const isCommit = "kind" in item && item.kind === "commit";
            const verification = "verification" in item ? item.verification : undefined;
            return (
              <button
                key={item.id}
                ref={node => {
                  optionButtons.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={selected === item.id}
                tabIndex={index === listActive ? 0 : -1}
                className={selected === item.id ? "is-selected" : ""}
                style={{ "--history-color": item.neutral ? "var(--text-muted)" : historyColor(item.id) } as CSSProperties}
                onClick={() => {
                  pick(item.id);
                  closeVersionList();
                }}>
                <i className={`file-history-version-dot${item.neutral ? " is-neutral" : ""}`} />
                <span className="file-history-version-title">{item.title}</span>
                {"createdAt" in item && <time className="file-history-version-time" dateTime={item.createdAt} title={displayTimelineTime(item.createdAt)}>{displayDate(item.createdAt)}</time>}
                {itemCounts && (
                  <span className="file-history-counts">
                    <b>+{itemCounts.added}</b> <i>−{itemCounts.removed}</i>
                  </span>
                )}
                {isCommit && <code className="file-history-sha">{item.id.slice(4, 11)}</code>}
                {verification && (
                  <span className={`overview-state-label${verification === "passed" ? " is-done" : verification === "failed" ? " is-failed" : ""}`}>
                    {verification === "passed" ? "Verified" : verification === "failed" ? "Failed" : "Unverified"}
                  </span>
                )}
              </button>
            );
          })}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <div className="file-viewer-toolbar">
        <code title={path}><bdi dir="ltr">{path}</bdi></code>
        <span>
          {canCompare && (
            <button
              className={view === "base" ? "is-active" : ""}
              disabled={history?.baselineAvailable === false}
              onClick={() => {
                setSelected("baseline");
                onView("base");
              }}>
              <IconArrowBackUp size={14} />
              {history?.baselineLabel === "HEAD" ? "HEAD" : "Baseline"}
            </button>
          )}
          <button
            className={view === "current" ? "is-active" : ""}
            onClick={() => {
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
          <button className={view === "diff" ? "is-active" : ""} onClick={() => onView("diff")}>
            <IconGitCompare size={14} />
            Diff
          </button>
          <button className="icon-button" onClick={onClose} aria-label="Close file"><IconX size={14} /></button>
        </span>
      </div>
      {canCompare && (
        <section className="file-history" aria-label="File history" aria-busy={!history && !listError && !!ready} style={{ "--history-color": selectedColor } as CSSProperties}>
          <div className="file-history-axis">
            <div className="file-history-pick">
              <button
                ref={titleButton}
                type="button"
                className="file-history-selected-title"
                aria-haspopup="listbox"
                aria-expanded={listOpen}
                onClick={() => listOpen ? closeVersionList(false) : setListOpen(true)}
                title={`${selectedTitle} — show every version of this file`}>
                <i className={selectedNeutral ? "is-neutral" : ""} />
                <span>{selectedTitle}</span><em>▾</em>
              </button>
            </div>
            <div className="file-history-scopes" role="group" aria-label="History scope">
              <button aria-pressed={scope === "session"} disabled={!!history && !checkpoints.length} onClick={() => {
                scopeChosen.current = true;
                setScope("session");
                if (selected.startsWith("git:")) pick("live");
              }}>Session</button>
              <button aria-pressed={scope === "all"} onClick={() => { scopeChosen.current = true; setScope("all"); }}>All history</button>
            </div>
            <button className="file-history-edge" aria-label="Scroll to earlier versions" disabled={edgeState.before} onClick={() => scrollTrack(-1)}>‹</button>
            <div
              className="file-history-track"
              ref={track}
              role="group"
              aria-label="Saved versions, oldest first"
              onScroll={updateEdges}
              onKeyDown={event => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".file-history-stop")];
                const index = buttons.indexOf(event.target as HTMLButtonElement);
                if (index < 0) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)));
                buttons[next]?.click();
                buttons[next]?.focus();
              }}>
              {!history && !listError && ready && [0, 1, 2, 3, 4].map(index => (
                <span className="file-history-stop-skeleton" key={index} aria-hidden="true"><span className="sk" /></span>
              ))}
              {scope === "all" && history?.hasMore && <span className="file-history-gap is-unknown"><span>Older commits not loaded</span></span>}
              {scope === "all" && commits.map((stop, index) => (
                <span className="file-history-track-item" key={stop.id}>
                  {gap(stop.skippedBefore, "commit")}
                  {dot(stop.id, `${stop.title} · ${stop.author ?? ""} · ${stop.createdAt}`, false, index === 0 ? "first" : undefined)}
                </span>
              ))}
              {scope === "all" && commits.length > 0 && <span className="file-history-git-boundary"><span>{history?.baselineLabel === "HEAD" ? "HEAD" : "Git history"}</span></span>}
              {dot("baseline", baselineTitle, true, scope !== "all" || !commits.length ? "first" : undefined)}
              {checkpoints.map(stop => (
                <span className="file-history-track-item" key={stop.id}>
                  {gap(stop.skippedBefore, "checkpoint")}
                  {dot(stop.id, `${stop.title} · ${stop.createdAt}`)}
                </span>
              ))}
              {history?.skippedSessionTail !== undefined && gap(history.skippedSessionTail, "checkpoint")}
              {dot("live", "Live working copy — may differ from the last checkpoint", true, "last")}
            </div>
            <button className="file-history-edge" aria-label="Scroll to later versions" disabled={edgeState.after} onClick={() => scrollTrack(1)}>›</button>
            {history?.hasMore && <button className="secondary-button file-history-earlier" onClick={() => setLimit(value => Math.min(200, value + 40))}>Earlier commits</button>}
            <div className="file-history-meta">
              {current?.kind === "checkpoint" && (
                <span className={`overview-state-label${current.verification === "passed" ? " is-done" : current.verification === "failed" ? " is-failed" : ""}`}>
                  {current.verification === "passed" ? "Verified" : current.verification === "failed" ? "Failed" : "Unverified"}
                </span>
              )}
              {current?.kind === "commit" && <span className="file-history-author" title={current.author}><i>{initials(current.author)}</i><span>{current.author}</span></span>}
              {current?.kind === "commit" && <code className="file-history-sha">{current.id.slice(4, 11)}</code>}
              {current?.createdAt
                ? <time className="file-history-time" dateTime={current.createdAt}>{displayTimelineTime(current.createdAt)}</time>
                : <span className="file-history-time">{selected === "live" ? "unsaved" : selected === "baseline" ? "session start" : ""}</span>}
              {selectedCounts && <span className="file-history-counts"><b>+{selectedCounts.added}</b> <i>−{selectedCounts.removed}</i></span>}
            </div>
            <AboutPopover label="About this history">
              <p>{history?.notice ?? "History is read-only. Live edits are not attributed to a saved turn."}</p>
              <p>Select a timeline stop to inspect that version. Diff shows a selected checkpoint against the baseline, and a selected commit against its parent.</p>
            </AboutPopover>
          </div>
          {(listError || history?.partial) && (
            <div className="file-history-notice" role="status">
              {listError ?? "Showing bounded history; earlier versions or attribution may be unavailable."}
              {listError && <button onClick={() => setRetry(value => value + 1)}>Retry</button>}
            </div>
          )}
        </section>
      )}
      {popupMenu}
      {!historical ? (
        view === "current" && liveEditor ? liveEditor : <FileContent value={value} view={view} targetLine={targetLine} onError={onError} />
      ) : (
        <>
          {content && !content.attributionComplete && <div className="file-history-notice" role="status">Some line attribution is unavailable; unassigned lines are left blank.</div>}
          {error && <div className="file-history-notice" role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
          {!content ? selected === "baseline" && view === "base" && value
            ? <FileContent value={value} view="base" targetLine={targetLine} onError={onError} />
            : !error && <div className="sk-lines" role="status" aria-busy="true" aria-label="Loading version">{CODE_SKELETON.map((width, index) => <span className="sk" style={{ "--sk-w": `${width}%` } as CSSProperties} key={index} />)}</div>
          : content.state !== "available" ? <div className="files-empty large">{content.state === "deleted" ? "File absent at this version" : content.state === "binary" ? "Binary file" : content.state === "oversized" ? "Version exceeds the display limit" : "Version unavailable"}</div>
          : historyView !== "file" && !content.text ? <div className="files-empty large">No changes</div>
          : <Suspense fallback={<div className="files-empty large">Rendering…</div>}><CodeViewer wrap key={result!.revision} mode={historyView === "file" ? "file" : "diff"} path={current?.path ?? path} text={content.text ?? ""} revision={result!.revision} annotationSource={{ kind: "historical", revision: `${selected}: ${result!.revision}` }} loadDiffFiles={loadDiffFiles} attribution={attribution} onSelectOwner={pick} /></Suspense>}
        </>
      )}
    </>
  );
}
