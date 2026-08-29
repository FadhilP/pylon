import {
  IconChevronLeft,
  IconFiles,
  IconFolder,
  IconSearch,
  IconSettings,
  IconTerminal2,
  IconX,
} from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import type { FileReference } from "../shared/file-reference";
import type { WorkspaceFileContent, WorkspaceFileDiff, WorkspaceFileReadModel } from "../shared/protocol/snapshots";
import { FileContent, FileRow, FileTree, FileTypeIcon, type FileView } from "./files-panel";
import {
  closeFileTab,
  openFileTab,
  selectFileTab,
  setFileTabView,
  workspaceStateForSession,
  type FileWorkspaceState,
} from "../shared/file-workspace-state";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";

export interface FileWorkspaceContentCacheEntry {
  generation: number;
  revision?: string;
  value: WorkspaceFileContent | WorkspaceFileDiff;
}

export type FileWorkspaceContentStore = Map<string, Map<string, FileWorkspaceContentCacheEntry>>;

export function FileWorkspace({
  live,
  requestedPath,
  stateStore,
  contentStore,
  header,
  workspaceRef,
  sidePanel,
  terminalOpen,
  terminalAvailable,
  rightPanelOpen,
  inspectorWidth,
  showExplorer,
  navigationOpen,
  mobile,
  onCloseNavigation,
  onSessions,
  onToggleTerminal,
  onOpenSettings,
  onError,
}: {
  live: RuntimeStoreSnapshot;
  requestedPath?: FileReference & { requestId: number; sessionId?: string; view?: FileView };
  stateStore: MutableRefObject<Map<string, FileWorkspaceState>>;
  contentStore: MutableRefObject<FileWorkspaceContentStore>;
  header: ReactNode;
  workspaceRef: RefObject<HTMLDivElement | null>;
  sidePanel: ReactNode;
  terminalOpen: boolean;
  terminalAvailable: boolean;
  rightPanelOpen: boolean;
  inspectorWidth: number;
  showExplorer: boolean;
  navigationOpen: boolean;
  mobile: boolean;
  onCloseNavigation: () => void;
  onSessions: () => void;
  onToggleTerminal: () => void;
  onOpenSettings: () => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const runtime = live.runtime;
  const sessionId = runtime?.sessionId ?? "";
  const [ui, setUi] = useState<FileWorkspaceState>(() => workspaceStateForSession(stateStore.current, sessionId));
  const currentUi = ui.sessionId === sessionId ? ui : workspaceStateForSession(stateStore.current, sessionId);
  const [files, setFiles] = useState<WorkspaceFileReadModel[]>([]);
  const [loadedContent, setLoadedContent] = useState<{
    key: string;
    value: WorkspaceFileContent | WorkspaceFileDiff;
  }>();
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [inventoryProgress, setInventoryProgress] = useState<{ loaded: number; total: number }>();
  const requestRevision = useRef(0);

  const updateUi = (update: (current: FileWorkspaceState) => FileWorkspaceState) => {
    setUi(current => {
      const base = current.sessionId === sessionId ? current : workspaceStateForSession(stateStore.current, sessionId);
      const next = update(base);
      if (sessionId) stateStore.current.set(sessionId, next);
      return next;
    });
  };

  useEffect(() => {
    setUi(workspaceStateForSession(stateStore.current, sessionId));
    setLoadedContent(undefined);
  }, [sessionId]);

  useEffect(() => {
    if (live.connection !== "connected" || !runtime?.ready) {
      setInventoryLoading(false);
      return;
    }
    const controller = new AbortController();
    const revision = ++requestRevision.current;
    setInventoryProgress(undefined);
    setInventoryLoading(true);
    void runtimeStore
      .workspaceInventory(
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
      )
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
    if (!requestedPath || !sessionId || (requestedPath.sessionId && requestedPath.sessionId !== sessionId)) return;
    updateUi(current => openFileTab(current, requestedPath.path, requestedPath.view ?? "current", requestedPath.line));
  }, [requestedPath?.requestId, sessionId]);

  const contentKey = currentUi.selectedPath ? `${currentUi.view}\u0000${currentUi.selectedPath}` : undefined;
  const cachedContent = contentKey ? contentStore.current.get(sessionId)?.get(contentKey) : undefined;
  const validCachedContent =
    cachedContent &&
    cachedContent.generation === runtime?.sessionGeneration &&
    cachedContent.revision === runtime?.workspace?.revision
      ? cachedContent.value
      : undefined;
  const visibleContent = loadedContent && loadedContent.key === contentKey ? loadedContent.value : validCachedContent;

  useEffect(() => {
    const { selectedPath, view } = currentUi;
    if (!selectedPath || !contentKey) {
      setLoadedContent(undefined);
      setViewerLoading(false);
      return;
    }
    const cached = contentStore.current.get(sessionId)?.get(contentKey);
    if (
      cached &&
      cached.generation === runtime?.sessionGeneration &&
      cached.revision === runtime?.workspace?.revision
    ) {
      setLoadedContent({ key: contentKey, value: cached.value });
      setViewerLoading(false);
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
      setLoadedContent(undefined);
      setViewerLoading(false);
      return;
    }
    const selectedSessionId = runtime.sessionId;
    const generation = runtime.sessionGeneration;
    const revision = runtime.workspace?.revision;
    let active = true;
    setLoadedContent(undefined);
    setViewerLoading(true);
    const request =
      view === "diff" ? runtimeStore.workspaceDiff(selectedPath) : runtimeStore.workspaceFile(selectedPath, view);
    void request
      .then(value => {
        const snapshot = runtimeStore.getSnapshot();
        if (
          !active ||
          snapshot.connection !== "connected" ||
          snapshot.runtime?.sessionId !== selectedSessionId ||
          snapshot.runtime.sessionGeneration !== generation
        )
          return;
        let sessionCache = contentStore.current.get(selectedSessionId);
        if (!sessionCache) {
          sessionCache = new Map();
          contentStore.current.set(selectedSessionId, sessionCache);
        }
        sessionCache.set(contentKey, { generation, revision, value });
        while (sessionCache.size > 40) sessionCache.delete(sessionCache.keys().next().value!);
        while (contentStore.current.size > 12) contentStore.current.delete(contentStore.current.keys().next().value!);
        setLoadedContent({ key: contentKey, value });
      })
      .catch(error => {
        if (!active) return;
        setLoadedContent(undefined);
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
    contentKey,
    runtime?.ready,
    runtime?.sessionId,
    runtime?.sessionGeneration,
    runtime?.workspace?.revision,
  ]);

  const matchingFiles = useMemo(() => {
    const normalized = currentUi.query.trim().toLocaleLowerCase();
    return normalized ? files.filter(file => file.path.toLocaleLowerCase().includes(normalized)) : files;
  }, [files, currentUi.query]);
  const visibleFiles = currentUi.tab === "changes" ? matchingFiles.filter(file => file.status) : matchingFiles;

  const selectFile = (path: string, view: FileView) => updateUi(current => openFileTab(current, path, view));
  const selectOpenFile = (path: string) => updateUi(current => selectFileTab(current, path));
  const setSelectedView = (view: FileView) =>
    updateUi(current => (current.selectedPath ? setFileTabView(current, current.selectedPath, view) : current));
  const closeFile = (path: string) => updateUi(current => closeFileTab(current, path));
  return (
    <section className={`file-workspace-shell${showExplorer ? "" : " has-session-navigation"}`}>
      {showExplorer && (
        <aside
          className={`file-workspace-explorer${navigationOpen ? " is-open" : ""}`}
          aria-label="Workspace explorer"
          aria-hidden={mobile && !navigationOpen}
          inert={mobile && !navigationOpen}>
          <header>
            <strong>
              <IconFolder size={16} />
              Explorer
            </strong>
            <button type="button" onClick={onSessions}>
              <IconChevronLeft size={14} />
              Sessions
            </button>
          </header>
          <label className="files-search">
            <IconSearch size={15} />
            <input
              value={currentUi.query}
              onChange={event => updateUi(current => ({ ...current, query: event.target.value }))}
              placeholder="Filter files"
            />
          </label>
          <nav className="files-tabs" aria-label="Explorer view">
            <button
              className={currentUi.tab === "changes" ? "is-active" : ""}
              onClick={() => updateUi(current => ({ ...current, tab: "changes" }))}>
              Changes <span>{runtime?.workspace?.changedCount ?? 0}</span>
            </button>
            <button
              className={currentUi.tab === "files" ? "is-active" : ""}
              onClick={() => updateUi(current => ({ ...current, tab: "files" }))}>
              Files
            </button>
          </nav>
          <div className="files-list">
            {inventoryLoading && !files.length && !inventoryProgress && (
              <span className="files-empty">Indexing workspace…</span>
            )}
            {inventoryLoading && !files.length && inventoryProgress && (
              <span className="files-progress">
                Loading {inventoryProgress.loaded.toLocaleString()} of {inventoryProgress.total.toLocaleString()} files…
              </span>
            )}
            {!inventoryLoading && !visibleFiles.length && (
              <span className="files-empty">
                {currentUi.tab === "changes" ? "No session changes" : "No files found"}
              </span>
            )}
            {currentUi.tab === "changes" || currentUi.query.trim() ? (
              visibleFiles.map(file => (
                <FileRow
                  key={file.path}
                  file={file}
                  fullPath={Boolean(currentUi.query.trim())}
                  selectedPath={currentUi.selectedPath}
                  onSelect={path => selectFile(path, currentUi.tab === "changes" ? "diff" : "current")}
                />
              ))
            ) : (
              <FileTree
                files={visibleFiles}
                selectedPath={currentUi.selectedPath}
                onSelect={path => selectFile(path, "current")}
              />
            )}
            {truncated && <span className="files-truncated">Showing first 10,000 files</span>}
          </div>
          <div className="sidebar-foot file-workspace-foot">
            <button className="sidebar-action" type="button" onClick={onOpenSettings}>
              <IconSettings size={16} />
              Settings
            </button>
            <button
              className={`sidebar-action${terminalOpen ? " is-active" : ""}`}
              type="button"
              disabled={!terminalAvailable}
              aria-pressed={terminalOpen}
              onClick={onToggleTerminal}>
              <IconTerminal2 size={16} />
              Terminal
            </button>
          </div>
        </aside>
      )}

      {showExplorer && mobile && navigationOpen && (
        <button className="sidebar-scrim" aria-label="Close explorer" onClick={onCloseNavigation} />
      )}

      <main className="content-card file-workspace-content" id="main-content">
        {header}
        <div
          ref={workspaceRef}
          className={`workspace-layout file-workspace-layout${rightPanelOpen ? " has-inspector" : ""}`}
          style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}>
          <div className="file-workspace-main">
            <div className="file-workspace-editor-tabs" role="tablist" aria-label="Open files">
              {currentUi.openPaths.map(path => (
                <div key={path} className={currentUi.selectedPath === path ? "is-active" : ""}>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={currentUi.selectedPath === path}
                    onClick={() => selectOpenFile(path)}>
                    <FileTypeIcon path={path} size={13} />
                    <span>{path.split("/").at(-1) ?? path}</span>
                  </button>
                  <button type="button" onClick={() => closeFile(path)} aria-label={`Close ${path}`}>
                    ×
                  </button>
                </div>
              ))}
            </div>
            <section className="file-workspace-editor" aria-label="Open file">
              {currentUi.selectedPath ? (
                <>
                  <div className="file-viewer-toolbar">
                    <code title={currentUi.selectedPath}>{currentUi.selectedPath}</code>
                    <span>
                      <button
                        className={currentUi.view === "diff" ? "is-active" : ""}
                        onClick={() => setSelectedView("diff")}>
                        Diff
                      </button>
                      <button
                        className={currentUi.view === "current" ? "is-active" : ""}
                        onClick={() => setSelectedView("current")}>
                        Working copy
                      </button>
                      {runtime?.workspace?.mode === "worktree" && (
                        <button
                          className={currentUi.view === "base" ? "is-active" : ""}
                          onClick={() => setSelectedView("base")}>
                          Baseline
                        </button>
                      )}
                      <button
                        className="icon-button"
                        onClick={() => closeFile(currentUi.selectedPath!)}
                        aria-label="Close file">
                        <IconX size={14} />
                      </button>
                    </span>
                  </div>
                  <FileContent
                    value={viewerLoading && !visibleContent ? undefined : visibleContent}
                    view={currentUi.view}
                    targetLine={currentUi.selectedLine}
                    onError={onError}
                  />
                </>
              ) : (
                <div className="file-workspace-empty">
                  <IconFiles size={26} />
                  <strong>No file selected</strong>
                  <span>Choose a file from the explorer to open it here.</span>
                  <small>Open files stay available for this session.</small>
                </div>
              )}
            </section>
          </div>
          {sidePanel}
        </div>
      </main>
    </section>
  );
}
