import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconCheck,
  IconCopy,
  IconDatabase,
  IconExternalLink,
  IconFile,
  IconFiles,
  IconGitCompare,
  IconGitMerge,
  IconLoader2,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import DOMPurify from "dompurify";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { openRequestedFile, workspaceStateForSession, type FileWorkspaceRequest, type FileWorkspaceState } from "./file-workspace-state";
import { formatCompactNumber } from "../ui/session-format";
import { highlightSource } from "../rendering/markdown";
import { loadDiffContents, type DiffContentsLoader } from "../../shared/workspace/code-viewer-model";
import type { WorkspaceSearchQuery } from "../../shared/workspace/workspace-search";
import type {
  WorkspaceFileContent,
  WorkspaceFileDiff,
  WorkspaceFileReadModel,
  WorkspaceReadModel,
} from "../../shared/protocol/snapshots";
import { FileTypeIcon } from "../rendering/file-icons";
import { WorkspaceIndexing, WorkspaceTree } from "./workspace-tree";
import { ExplorerSearch } from "./workspace-search";
import { displayTime } from "../ui/display-format";
import { referenceDefinition } from "../app/navigation";
import { copyText } from "../ui/clipboard";
import { runtimeStore, type RuntimeStoreSnapshot } from "../runtime/event-store";
import { useSyntaxHighlightingRevision } from "../app/use-chrome";

export type FileView = "current" | "base" | "diff";
const CodeViewer = lazy(() => import("../rendering/code-viewer"));

export function FilesPanel({
  live,
  projectId,
  requestedPath,
  stateStore,
  applyRequest,
  onApplyRequestHandled,
  onClose,
  onExpand,
  onError,
}: {
  live: RuntimeStoreSnapshot;
  projectId?: string;
  requestedPath?: FileWorkspaceRequest;
  stateStore: MutableRefObject<Map<string, FileWorkspaceState>>;
  applyRequest?: { sessionId: string; revision: string };
  onApplyRequestHandled?: () => void;
  onClose: () => void;
  onExpand?: (selectedPath?: string, view?: FileView) => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const runtime = live.runtime;
  const sessionId = runtime?.sessionId ?? "";
  const workspaceRevision = `${runtime?.workspace?.revision ?? ""}:${runtime?.workspace?.fileRevision ?? 0}`;
  const inventoryScope = JSON.stringify([sessionId, runtime?.workspace?.mode, runtime?.cwdLabel]);
  const cachedInventory = runtime ? runtimeStore.cachedWorkspaceInventory(runtime) : undefined;
  const [files, setFiles] = useState<WorkspaceFileReadModel[]>(() => cachedInventory?.files ?? []);
  const [loadedInventoryScope, setLoadedInventoryScope] = useState(inventoryScope);
  const currentFiles = loadedInventoryScope === inventoryScope ? files : cachedInventory?.files ?? [];
  const [ui, setUi] = useState(() => workspaceStateForSession(stateStore.current, sessionId));
  const currentUi = ui.sessionId === sessionId ? ui : workspaceStateForSession(stateStore.current, sessionId);
  const { query, selectedPath, selectedLine, view } = currentUi;
  const updateUi = (update: (state: FileWorkspaceState) => FileWorkspaceState) => setUi(current => {
    const next = update(current.sessionId === sessionId ? current : workspaceStateForSession(stateStore.current, sessionId));
    if (sessionId) {
      stateStore.current.delete(sessionId);
      stateStore.current.set(sessionId, next);
      while (stateStore.current.size > 12) stateStore.current.delete(stateStore.current.keys().next().value!);
    }
    return next;
  });
  const setQuery = (query: string) => updateUi(current => ({ ...current, query }));
  const setSelectedPath = (selectedPath?: string) => updateUi(current => ({ ...current, selectedPath }));
  const setSelectedLine = (selectedLine?: number) => updateUi(current => ({ ...current, selectedLine }));
  const setView = (view: FileView | ((current: FileView) => FileView)) =>
    updateUi(current => ({ ...current, view: typeof view === "function" ? view(current.view) : view }));
  const content = runtime && selectedPath ? runtimeStore.cachedWorkspacePreview(selectedPath, view, runtime)?.value : undefined;
  const [inventoryLoading, setInventoryLoading] = useState(!cachedInventory);
  const [viewer, setViewer] = useState<{ loading: boolean; failed?: boolean }>({ loading: false });
  const [truncated, setTruncated] = useState(cachedInventory?.truncated ?? false);
  const [inventoryProgress, setInventoryProgress] = useState<{ loaded: number; total: number }>();
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{ path: string; state: "copied" | "error" }>();
  const copyReset = useRef<number | undefined>(undefined);
  const copyRevision = useRef(0);
  const requestRevision = useRef(0);

  useEffect(() => {
    if (!applyRequest) return;
    if (applyRequest.sessionId === runtime?.sessionId && applyRequest.revision === runtime.workspace?.revision && runtime.workspace.canApplyChanges) setApplyOpen(true);
    else onError(new Error("Workspace changed; review the latest changes before applying"), "Unable to open apply confirmation");
    onApplyRequestHandled?.();
  }, [applyRequest, runtime?.sessionId, runtime?.workspace?.revision, runtime?.workspace?.canApplyChanges]);

  useEffect(
    () => () => {
      copyRevision.current++;
      if (copyReset.current !== undefined) window.clearTimeout(copyReset.current);
    },
    [],
  );
  useEffect(() => {
    copyRevision.current++;
    setCopyFeedback(undefined);
    if (copyReset.current !== undefined) {
      window.clearTimeout(copyReset.current);
      copyReset.current = undefined;
    }
  }, [selectedPath]);

  useEffect(() => {
    if (live.connection !== "connected" || !runtime?.ready) {
      setInventoryLoading(false);
      return;
    }
    const controller = new AbortController();
    const revision = ++requestRevision.current;
    setInventoryProgress(undefined);
    setInventoryLoading(true);
    void (async () => {
      await runtimeStore.workspaceInventory(
        false,
        controller.signal,
        (next, wasTruncated) => {
          if (revision !== requestRevision.current) return;
          setLoadedInventoryScope(inventoryScope);
          setFiles(next);
          setTruncated(wasTruncated);
        },
        (loaded, total) => {
          if (revision === requestRevision.current) setInventoryProgress({ loaded, total });
        },
        runtime,
      );
    })()
      .catch(error => {
        if (!controller.signal.aborted) onError(error, "Unable to list workspace files");
      })
      .finally(() => {
        if (revision === requestRevision.current) setInventoryLoading(false);
      });
    return () => {
      controller.abort();
      requestRevision.current++;
    };
  }, [live.connection, runtime?.ready, runtime?.sessionGeneration, workspaceRevision, inventoryScope]);
  useEffect(() => {
    updateUi(current => openRequestedFile(current, requestedPath));
  }, [requestedPath?.requestId, sessionId]);
  useEffect(() => {
    if (!selectedPath || live.connection !== "connected" || !runtime?.ready) {
      setViewer({ loading: false });
      return;
    }
    const controller = new AbortController();
    setViewer({ loading: true });
    void runtimeStore.workspacePreview(selectedPath, view, controller.signal, runtime)
      .then(() => {
        if (!controller.signal.aborted) setViewer({ loading: false });
      })
      .catch(error => {
        if (!controller.signal.aborted) {
          setViewer({ loading: false, failed: true });
          onError(error, "Unable to refresh workspace file");
        }
      });
    return () => controller.abort();
  }, [live.connection, selectedPath, view, runtime?.ready, runtime?.sessionGeneration, workspaceRevision, inventoryScope]);

  const copySelectedPath = async () => {
    if (!selectedPath) return;
    const path = selectedPath;
    const revision = ++copyRevision.current;
    if (copyReset.current !== undefined) window.clearTimeout(copyReset.current);
    copyReset.current = undefined;
    const state = (await copyText(path)) ? "copied" : "error";
    if (revision !== copyRevision.current) return;
    setCopyFeedback({ path, state });
    copyReset.current = window.setTimeout(() => {
      if (revision !== copyRevision.current) return;
      setCopyFeedback(undefined);
      copyReset.current = undefined;
    }, 1_500);
  };

  const fileCopyState = copyFeedback?.path === selectedPath ? (copyFeedback?.state ?? "idle") : "idle";
  const workspace = runtime?.workspace;
  const canCompare = workspace?.mode === "worktree" || workspace?.mode === "checkout" || workspace?.mode === "local";
  return (
    <>
      <aside id="changes-panel" className="inspector files-panel is-open" aria-labelledby="changes-title">
        <header className="inspector-header">
          <div>
            <IconFiles size={18} />
            <strong id="changes-title">Changes</strong>
          </div>
          <span>
            {onExpand && (
              <button className="files-expand-button" type="button" onClick={() => onExpand(selectedPath, view)}>
                <IconExternalLink size={14} />
                Open workspace
              </button>
            )}
            <button className="icon-button" type="button" onClick={onClose} aria-label="Close files">
              <IconX size={17} />
            </button>
          </span>
        </header>
        <p className="inspector-description">{referenceDefinition("changes")?.description}</p>
        <div className="files-workspace-bar">
          <span
            title={
              workspace?.mode === "worktree"
                ? "This session is working in its own isolated Git worktree."
                : workspace?.mode === "checkout"
                  ? "This session is working directly in the registered project folder."
                  : workspace?.mode === "local"
                    ? "This session uses the project folder without Pylon worktree or branch isolation."
                    : "This folder is available without Git history."
            }>
            {workspace?.mode === "worktree"
              ? "Session worktree"
              : workspace?.mode === "checkout"
                ? "Project folder"
                : workspace?.mode === "local"
                  ? "Local (unmanaged)"
                  : "Files only"}
          </span>
          {workspace?.mode === "worktree" && (
            <button
              type="button"
              disabled={!workspace.canMoveToCheckout}
              title={workspace.handoffUnavailableReason}
              onClick={() =>
                void runtimeStore.handoffSession("checkout").catch(error => onError(error, "Unable to move session"))
              }>
              Move to project checkout
            </button>
          )}
          {workspace?.mode === "checkout" && workspace.canMoveToWorktree && (
            <button
              type="button"
              onClick={() =>
                void runtimeStore.handoffSession("worktree").catch(error => onError(error, "Unable to move session"))
              }>
              Move to worktree
            </button>
          )}
        </div>
        {runtime?.discoverIndex && <DiscoverIndexBar live={live} />}
        {(workspace?.mode === "checkout" || workspace?.mode === "worktree") && (
          <nav className="files-tabs" aria-label="File actions">
            <button
              className="files-apply-button"
              type="button"
              disabled={!workspace.canApplyChanges}
              title={workspace.applyUnavailableReason ?? `Apply session changes to ${workspace.applyTargetBranch}`}
              onClick={() => setApplyOpen(true)}>
              {workspace.applyState === "applying" ? (
                <IconLoader2 className="spin" size={14} />
              ) : (
                <IconGitMerge size={14} />
              )}
              Apply to {workspace.applyTargetBranch ?? "project branch"}
            </button>
          </nav>
        )}
        {workspace?.lastApply && (
          <div
            className={`files-apply-status is-${workspace.lastApply.state}`}
            role={workspace.lastApply.state === "error" ? "alert" : "status"}>
            <span>{workspace.lastApply.message}</span>
            {workspace.lastApply.conflicts?.length ? (
              <ul>
                {workspace.lastApply.conflicts.map(path => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        <div className={`files-panel-body${selectedPath ? "" : " is-list-only"}`}>
          <ExplorerSearch
            scope={`${live.runtime?.sessionId}:${live.runtime?.sessionGeneration}`}
            query={query}
            onQuery={setQuery}
            onOpen={(path, line) => {
              setSelectedPath(path);
              setSelectedLine(line);
              setView("current");
            }}>
            <WorkspaceTree
              files={currentFiles}
              selectedPath={selectedPath}
              query={query}
              projectId={projectId}
              onClearQuery={() => setQuery("")}
              onSelect={(path, changed) => {
                setSelectedPath(path);
                setSelectedLine(undefined);
                setView(changed ? "diff" : "current");
              }}>
              {inventoryLoading && !currentFiles.length && <WorkspaceIndexing progress={inventoryProgress} />}
              {!inventoryLoading && !currentFiles.length && <span className="files-empty">No files found</span>}
              {loadedInventoryScope === inventoryScope && truncated && <span className="files-truncated">Showing first 10,000 files</span>}
            </WorkspaceTree>
          </ExplorerSearch>
          {selectedPath && (
            <div className="file-viewer">
              <>
                <div className="file-viewer-toolbar">
                  <code title={selectedPath}>{selectedPath}</code>
                  <span>
                    {canCompare && (
                      <button
                        className={view === "base" ? "is-active" : ""}
                        title={
                          workspace?.mode === "local"
                            ? "Show the file from HEAD"
                            : "Show the file from the session baseline"
                        }
                        onClick={() => setView("base")}>
                        <IconArrowBackUp size={14} />
                        Baseline
                      </button>
                    )}
                    <button
                      className={view === "current" ? "is-active" : ""}
                      title="Show the current file on disk"
                      onClick={() => setView(current => (current === "current" && canCompare ? "diff" : "current"))}>
                      <IconFile size={14} />
                      Working copy
                    </button>
                    {canCompare && (
                      <button className={view === "diff" ? "is-active" : ""} onClick={() => setView("diff")}>
                        <IconGitCompare size={14} />
                        Diff
                      </button>
                    )}
                    <button
                      className={`icon-button copy-feedback${fileCopyState === "idle" ? "" : ` is-${fileCopyState}`}`}
                      onClick={() => void copySelectedPath()}
                      aria-label="Copy file path"
                      title={
                        fileCopyState === "copied"
                          ? "Copied"
                          : fileCopyState === "error"
                            ? "Copy failed"
                            : "Copy file path"
                      }>
                      {fileCopyState === "copied" ? (
                        <IconCheck size={14} />
                      ) : fileCopyState === "error" ? (
                        <IconAlertTriangle size={14} />
                      ) : (
                        <IconCopy size={14} />
                      )}
                    </button>
                    <span className="sr-only" aria-live="polite">
                      {fileCopyState === "copied"
                        ? "File path copied"
                        : fileCopyState === "error"
                          ? "Copying file path failed"
                          : ""}
                    </span>
                    <button
                      className="icon-button"
                      onClick={() => {
                        setSelectedPath(undefined);
                        setSelectedLine(undefined);
                      }}
                      aria-label="Close file">
                      <IconX size={14} />
                    </button>
                  </span>
                </div>
                {viewer.loading && content && <span className="files-empty" role="status">Refreshing preview…</span>}
                {viewer.failed && <span className="files-empty" role="status">{content ? "Refresh failed; showing the last loaded version." : "Unable to load the file preview."}</span>}
                <FileContent
                  value={content}
                  view={view}
                  targetLine={selectedLine}
                  onError={onError}
                />
              </>
            </div>
          )}
        </div>
      </aside>
      {applyOpen && workspace?.revision && workspace.applyTargetBranch && (
        <ApplyChangesDialog
          workspace={workspace}
          busy={applyBusy}
          onCancel={() => setApplyOpen(false)}
          onConfirm={() => {
            setApplyBusy(true);
            void runtimeStore
              .applySessionChanges(workspace.revision!)
              .then(() => setApplyOpen(false))
              .catch(error => {
                setApplyOpen(false);
                onError(error, "Unable to apply session changes");
              })
              .finally(() => setApplyBusy(false));
          }}
        />
      )}
    </>
  );
}

function ApplyChangesDialog({
  workspace,
  busy,
  onCancel,
  onConfirm,
}: {
  workspace: WorkspaceReadModel;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
    if (!focusable?.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return (
    <div
      className="edit-confirm-backdrop"
      onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}>
      <div
        ref={dialogRef}
        className="edit-confirm-dialog apply-changes-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-dialog-title"
        onKeyDown={onKeyDown}>
        <header>
          <strong id="apply-dialog-title">Apply session changes?</strong>
          <button className="icon-button" type="button" onClick={onCancel} disabled={busy} aria-label="Close">
            <IconX size={16} />
          </button>
        </header>
        <div>
          <p>
            Apply <strong>{workspace?.changedCount ?? 0}</strong> changed files to{" "}
            <code>{workspace?.applyTargetBranch}</code> as uncommitted working-tree changes.
          </p>
          <p>
            The target currently has <strong>{workspace?.applyTargetChangedCount ?? 0}</strong> local changes.
            Non-conflicting changes and its staging state will be preserved.
          </p>
          <p>
            {workspace?.mode === "checkout"
              ? "This session will continue locally on the original branch after applying."
              : "This session will remain isolated in its worktree after applying."}
          </p>
        </div>
        <footer>
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            data-autofocus
            className="primary-button"
            type="button"
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy}>
            {busy && <IconLoader2 className="feedback-spinner" size={14} />}
            {busy ? "Applying…" : "Apply changes"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function DiscoverIndexBar({ live }: { live: RuntimeStoreSnapshot }) {
  const [busy, setBusy] = useState(false);
  const index = live.runtime!.discoverIndex!;
  const rebuilding = busy || index.state === "indexing";
  const idle =
    live.connection === "connected" &&
    live.runtime?.ready === true &&
    !live.runtime.conversation.workStartedAt &&
    !live.pendingUi &&
    !busy &&
    index.state !== "indexing";
  return (
    <section className="files-index-bar" aria-label="Discover index">
      <div className="files-index-title">
        <IconDatabase size={14} />
        <strong>Discover index</strong>
        <span>{index.state === "indexing" ? "Rebuilding…" : index.state}</span>
      </div>
      <div className="files-index-metrics">
        <span>{index.files === undefined ? "—" : formatCompactNumber(index.files)} files</span>
        <span>{index.symbols === undefined ? "—" : formatCompactNumber(index.symbols)} symbols</span>
        <span>{index.indexedAt ? displayTime(index.indexedAt) : "Not indexed"}</span>
      </div>
      <button
        className="icon-button"
        type="button"
        disabled={!idle}
        aria-busy={rebuilding}
        aria-label={rebuilding ? "Rebuilding Discover index" : "Rebuild Discover index"}
        title={rebuilding ? "Rebuilding Discover index" : "Rebuild Discover index"}
        onClick={() => {
          setBusy(true);
          void runtimeStore
            .rebuildDiscoverIndex()
            .catch(() => undefined)
            .finally(() => setBusy(false));
        }}>
        <IconRefresh className={rebuilding ? "feedback-spinner" : undefined} size={15} />
      </button>
      {index.error && <p role="alert">{index.error}</p>}
    </section>
  );
}

export function FileContent({
  value,
  view,
  targetLine,
  searchQuery,
  onError,
}: {
  value?: WorkspaceFileContent | WorkspaceFileDiff;
  view: FileView;
  targetLine?: number;
  searchQuery?: WorkspaceSearchQuery;
  onError: (error: unknown, fallback: string) => void;
}) {
  const loadDiffFiles = useMemo<DiffContentsLoader | undefined>(() => {
    if (!value || view !== "diff") return undefined;
    const { path, revision } = value;
    return async () => {
      try {
        // Each read snapshots the workspace revision; keep them sequential so two
        // read-only expansions never contend for Git's index lock.
        const base = await runtimeStore.workspaceFile(path, "base");
        const current = await runtimeStore.workspaceFile(path, "current");
        return loadDiffContents({ revision, base, current });
      } catch (error) {
        onError(error, "Unable to load full diff context");
        throw error;
      }
    };
  }, [onError, value?.path, value?.revision, view]);
  if (!value) return <div className="files-empty large">Loading…</div>;
  if (value.state !== "available" && !value.text) {
    return (
      <div className="files-empty large">
        {value.state === "deleted"
          ? "File deleted"
          : value.state === "binary"
            ? "Binary file"
            : "File is too large to display"}
      </div>
    );
  }
  const text = value.text ?? "";
  if (view === "diff" && !text) return <div className="files-empty large">No changes</div>;
  if (value.truncated)
    return <RawFileContent text={text} path={value.path} diff={view === "diff"} targetLine={targetLine} truncated />;
  return (
    <Suspense fallback={<div className="files-empty large">Rendering…</div>}>
      <CodeViewer
        mode={view === "diff" ? "diff" : "file"}
        path={value.path}
        text={text}
        revision={value.revision}
        annotationSource={value.state === "available" ? { kind: view === "base" ? "historical" : "current", revision: `${view === "base" ? "Baseline" : "Working copy"}: ${value.revision}` } : undefined}
        targetLine={targetLine}
        searchQuery={view === "current" ? searchQuery : undefined}
        loadDiffFiles={loadDiffFiles}
      />
    </Suspense>
  );
}

function RawFileContent({
  text,
  path,
  diff,
  targetLine,
  truncated = false,
}: {
  text: string;
  path: string;
  diff: boolean;
  targetLine?: number;
  truncated?: boolean;
}) {
  const targetRef = useRef<HTMLElement>(null);
  const syntaxRevision = useSyntaxHighlightingRevision();
  useEffect(() => {
    if (!targetLine) return;
    const frame = requestAnimationFrame(() => targetRef.current?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(frame);
  }, [targetLine, text]);
  const rendered = useMemo(
    () => ({ lines: text.split("\n"), highlighted: DOMPurify.sanitize(highlightSource(text, path, diff)) }),
    [diff, path, syntaxRevision, text],
  );
  return (
    <pre className={`file-code${diff ? " is-diff" : ""}`}>
      <span className="file-line-numbers" aria-hidden="true">
        {rendered.lines.map((_, index) => {
          const line = index + 1;
          return (
            <i
              key={line}
              ref={line === targetLine ? targetRef : undefined}
              className={line === targetLine ? "is-target" : undefined}>
              {line}
            </i>
          );
        })}
      </span>
      <code dangerouslySetInnerHTML={{ __html: rendered.highlighted }} />
      {truncated && <small>Output truncated; find is unavailable for truncated output.</small>}
    </pre>
  );
}
