import type { FileDiffContentsLoader } from "@pierre/diffs";
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconBrandDocker,
  IconBrandGolang,
  IconBrandNpm,
  IconBrandPython,
  IconCheck,
  IconCopy,
  IconDatabase,
  IconExternalLink,
  IconFile,
  IconFileCode,
  IconFiles,
  IconFileSettings,
  IconFileText,
  IconFileTypeCss,
  IconFileTypeHtml,
  IconFileTypeJs,
  IconFileTypeJsx,
  IconFileTypePdf,
  IconFileTypeRs,
  IconFileTypeSql,
  IconFileTypeSvg,
  IconFileTypeTs,
  IconFileTypeTsx,
  IconFileTypeZip,
  IconFolder,
  IconGitCompare,
  IconGitMerge,
  IconJson,
  IconLoader2,
  IconMarkdown,
  IconPhoto,
  IconRefresh,
  IconSearch,
  IconTerminal2,
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
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { WORKSPACE_FILE_DRAG_TYPE } from "../shared/composer-input";
import type { FileReference } from "../shared/file-reference";
import { fileIconKind } from "../shared/file-icon";
import { formatCompactNumber } from "../shared/format";
import { highlightSource } from "../shared/markdown";
import { createPierreLoadedDiffFiles } from "../shared/pierre-code-viewer-model";
import type {
  WorkspaceFileContent,
  WorkspaceFileDiff,
  WorkspaceFileReadModel,
  WorkspaceReadModel,
} from "../shared/protocol/snapshots";
import { displayTime } from "./format";
import { referenceDefinition } from "./navigation";
import { copyText } from "./clipboard";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";
import { useSyntaxHighlightingRevision } from "./use-chrome";

export type FileView = "current" | "base" | "diff";
const PierreCodeViewer = lazy(() => import("./pierre-code-viewer"));

export function FileTypeIcon({ path, size = 14 }: { path: string; size?: number }) {
  const kind = fileIconKind(path);
  const props = { className: `file-type-icon is-${kind}`, size, "aria-hidden": true } as const;
  switch (kind) {
    case "typescript":
      return <IconFileTypeTs {...props} />;
    case "tsx":
      return <IconFileTypeTsx {...props} />;
    case "javascript":
      return <IconFileTypeJs {...props} />;
    case "jsx":
      return <IconFileTypeJsx {...props} />;
    case "html":
      return <IconFileTypeHtml {...props} />;
    case "css":
      return <IconFileTypeCss {...props} />;
    case "json":
      return <IconJson {...props} />;
    case "markdown":
      return <IconMarkdown {...props} />;
    case "python":
      return <IconBrandPython {...props} />;
    case "go":
      return <IconBrandGolang {...props} />;
    case "rust":
      return <IconFileTypeRs {...props} />;
    case "sql":
      return <IconFileTypeSql {...props} />;
    case "svg":
      return <IconFileTypeSvg {...props} />;
    case "image":
      return <IconPhoto {...props} />;
    case "pdf":
      return <IconFileTypePdf {...props} />;
    case "archive":
      return <IconFileTypeZip {...props} />;
    case "config":
      return <IconFileSettings {...props} />;
    case "shell":
      return <IconTerminal2 {...props} />;
    case "code":
      return <IconFileCode {...props} />;
    case "text":
      return <IconFileText {...props} />;
    case "npm":
      return <IconBrandNpm {...props} />;
    case "docker":
      return <IconBrandDocker {...props} />;
    default:
      return <IconFile {...props} />;
  }
}

export function FilesPanel({
  live,
  requestedPath,
  onClose,
  onExpand,
  onError,
}: {
  live: RuntimeStoreSnapshot;
  requestedPath?: FileReference & { requestId: number; view?: FileView };
  onClose: () => void;
  onExpand?: (selectedPath?: string, view?: FileView) => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const runtime = live.runtime;
  const [tab, setTab] = useState<"changes" | "files">("changes");
  const [files, setFiles] = useState<WorkspaceFileReadModel[]>([]);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [selectedLine, setSelectedLine] = useState<number>();
  const [view, setView] = useState<FileView>("diff");
  const [content, setContent] = useState<WorkspaceFileContent | WorkspaceFileDiff>();
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [inventoryProgress, setInventoryProgress] = useState<{ loaded: number; total: number }>();
  const [applyOpen, setApplyOpen] = useState(false);
  const [applyBusy, setApplyBusy] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<{ path: string; state: "copied" | "error" }>();
  const copyReset = useRef<number | undefined>(undefined);
  const copyRevision = useRef(0);
  const requestRevision = useRef(0);

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
          setFiles(next);
          setTruncated(wasTruncated);
        },
        (loaded, total) => {
          if (revision === requestRevision.current) setInventoryProgress({ loaded, total });
        },
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
  }, [live.connection, runtime?.ready, runtime?.sessionId, runtime?.sessionGeneration, runtime?.workspace?.revision]);
  useEffect(() => {
    if (!requestedPath) return;
    setSelectedPath(requestedPath.path);
    setSelectedLine(requestedPath.line);
    setView(requestedPath.view ?? "current");
  }, [requestedPath]);
  useEffect(() => {
    if (!selectedPath) {
      setContent(undefined);
      return;
    }
    const current = runtimeStore.getSnapshot();
    if (
      !runtime?.ready ||
      current.connection !== "connected" ||
      !current.runtime?.ready ||
      current.runtime.sessionId !== runtime.sessionId ||
      current.runtime.sessionGeneration !== runtime.sessionGeneration
    ) {
      setContent(undefined);
      setViewerLoading(false);
      return;
    }
    const sessionId = runtime.sessionId;
    const generation = runtime.sessionGeneration;
    const stillCurrent = () => {
      const snapshot = runtimeStore.getSnapshot();
      return (
        snapshot.connection === "connected" &&
        snapshot.runtime?.ready === true &&
        snapshot.runtime.sessionId === sessionId &&
        snapshot.runtime.sessionGeneration === generation
      );
    };
    let active = true;
    setViewerLoading(true);
    const request =
      view === "diff" ? runtimeStore.workspaceDiff(selectedPath) : runtimeStore.workspaceFile(selectedPath, view);
    void request
      .then(value => {
        if (active && stillCurrent()) setContent(value);
      })
      .catch(error => {
        if (!active || !stillCurrent()) return;
        setContent(undefined);
        onError(error, "Unable to read workspace file");
      })
      .finally(() => {
        if (active) setViewerLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    live.connection,
    selectedPath,
    view,
    runtime?.ready,
    runtime?.sessionId,
    runtime?.sessionGeneration,
    runtime?.workspace?.revision,
  ]);

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

  const matchingFiles = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized ? files.filter(file => file.path.toLocaleLowerCase().includes(normalized)) : files;
  }, [files, query]);
  const visible = tab === "changes" ? matchingFiles.filter(file => file.status) : matchingFiles;
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
        <nav className="files-tabs" aria-label="File views">
          <button className={tab === "changes" ? "is-active" : ""} onClick={() => setTab("changes")}>
            Changes <span>{workspace?.changedCount ?? 0}</span>
          </button>
          <button className={tab === "files" ? "is-active" : ""} onClick={() => setTab("files")}>
            Files
          </button>
          {(workspace?.mode === "checkout" || workspace?.mode === "worktree") && (
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
          )}
        </nav>
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
        <label className="files-search">
          <IconSearch size={15} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search files" />
        </label>
        <div className={`files-panel-body${selectedPath ? "" : " is-list-only"}`}>
          <div className="files-list" aria-label={tab === "changes" ? "Changed files" : "Project files"}>
            {inventoryLoading && !files.length && !inventoryProgress && (
              <span className="files-empty">Indexing workspace…</span>
            )}
            {inventoryLoading && !files.length && inventoryProgress && (
              <span className="files-progress">
                Loading {inventoryProgress.loaded.toLocaleString()} of {inventoryProgress.total.toLocaleString()} files…
              </span>
            )}
            {!inventoryLoading && !visible.length && (
              <span className="files-empty">{tab === "changes" ? "No session changes" : "No files found"}</span>
            )}
            {tab === "changes" ? (
              visible.map(file => (
                <FileRow
                  key={file.path}
                  file={file}
                  selectedPath={selectedPath}
                  onSelect={path => {
                    setSelectedPath(path);
                    setSelectedLine(undefined);
                    setView("diff");
                  }}
                />
              ))
            ) : query.trim() ? (
              visible.map(file => (
                <FileRow
                  key={file.path}
                  file={file}
                  fullPath
                  selectedPath={selectedPath}
                  onSelect={path => {
                    setSelectedPath(path);
                    setSelectedLine(undefined);
                    setView("current");
                  }}
                />
              ))
            ) : (
              <FileTree
                files={visible}
                selectedPath={selectedPath}
                onSelect={path => {
                  setSelectedPath(path);
                  setSelectedLine(undefined);
                  setView("current");
                }}
              />
            )}
            {truncated && <span className="files-truncated">Showing first 10,000 files</span>}
          </div>
          {selectedPath && (
            <div className="file-viewer">
              <>
                <div className="file-viewer-toolbar">
                  <code title={selectedPath}>{selectedPath}</code>
                  <span>
                    {canCompare && (
                      <>
                        <button className={view === "diff" ? "is-active" : ""} onClick={() => setView("diff")}>
                          <IconGitCompare size={14} />
                          Diff
                        </button>
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
                      </>
                    )}
                    <button
                      className={view === "current" ? "is-active" : ""}
                      title="Show the current file on disk"
                      onClick={() => setView(current => (current === "current" && canCompare ? "diff" : "current"))}>
                      Working copy
                    </button>
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
                <FileContent
                  value={viewerLoading ? undefined : content}
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

interface FileTreeNode {
  files: WorkspaceFileReadModel[];
  directories: Map<string, FileTreeNode>;
}

export function FileTree({
  files,
  selectedPath,
  onSelect,
}: {
  files: WorkspaceFileReadModel[];
  selectedPath?: string;
  onSelect: (path: string) => void;
}) {
  const root = useMemo(() => {
    const value: FileTreeNode = { files: [], directories: new Map() };
    for (const file of files) {
      const parts = file.path.split("/");
      let node = value;
      // Registered submodule folders render as non-selectable directory chains, never as selectable rows.
      if (file.kind === "submodule") {
        for (const part of parts) {
          let child = node.directories.get(part);
          if (!child) {
            child = { files: [], directories: new Map() };
            node.directories.set(part, child);
          }
          node = child;
        }
        continue;
      }
      for (const directory of parts.slice(0, -1)) {
        let child = node.directories.get(directory);
        if (!child) {
          child = { files: [], directories: new Map() };
          node.directories.set(directory, child);
        }
        node = child;
      }
      node.files.push(file);
    }
    return value;
  }, [files]);
  return <TreeNode node={root} selectedPath={selectedPath} onSelect={onSelect} />;
}

function TreeNode({
  node,
  selectedPath,
  onSelect,
}: {
  node: FileTreeNode;
  selectedPath?: string;
  onSelect: (path: string) => void;
}) {
  return (
    <>
      {[...node.directories]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, child]) => (
          <details className="files-directory" key={name}>
            <summary>
              <IconFolder size={14} />
              {name}
            </summary>
            <TreeNode node={child} selectedPath={selectedPath} onSelect={onSelect} />
          </details>
        ))}
      {node.files
        .sort((left, right) => left.path.localeCompare(right.path))
        .map(file => (
          <FileRow key={file.path} file={file} selectedPath={selectedPath} onSelect={onSelect} />
        ))}
    </>
  );
}

export function FileRow({
  file,
  selectedPath,
  onSelect,
  fullPath = false,
}: {
  file: WorkspaceFileReadModel;
  selectedPath?: string;
  onSelect: (path: string) => void;
  fullPath?: boolean;
}) {
  const name = file.path.split("/").at(-1) ?? file.path;
  const startDrag = (event: ReactDragEvent<HTMLButtonElement>) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, file.path);
  };
  return (
    <button
      type="button"
      draggable
      className={selectedPath === file.path ? "is-active" : ""}
      onDragStart={startDrag}
      onClick={() => onSelect(file.path)}>
      <FileTypeIcon path={file.path} size={14} />
      <span title={file.path}>{fullPath ? file.path : name}</span>
      {file.status && <small className={`is-${file.status}`}>{file.status[0].toUpperCase()}</small>}
      {file.binary ? (
        <em>binary</em>
      ) : (
        file.status && (
          <em>
            <ins>+{file.additions ?? 0}</ins>
            <del>-{file.deletions ?? 0}</del>
          </em>
        )
      )}
    </button>
  );
}

export function FileContent({
  value,
  view,
  targetLine,
  onError,
}: {
  value?: WorkspaceFileContent | WorkspaceFileDiff;
  view: FileView;
  targetLine?: number;
  onError: (error: unknown, fallback: string) => void;
}) {
  const loadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    if (!value || view !== "diff") return undefined;
    const { path, revision } = value;
    return async () => {
      try {
        // Each read snapshots the workspace revision; keep them sequential so two
        // read-only expansions never contend for Git's index lock.
        const base = await runtimeStore.workspaceFile(path, "base");
        const current = await runtimeStore.workspaceFile(path, "current");
        return createPierreLoadedDiffFiles({ path, revision, base, current });
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
      <PierreCodeViewer
        mode={view === "diff" ? "diff" : "file"}
        path={value.path}
        text={text}
        revision={value.revision}
        targetLine={targetLine}
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
      {truncated && <small>Output truncated</small>}
    </pre>
  );
}
