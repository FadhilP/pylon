import { WorkspaceEditor } from "./workspace-editor";
import { WorkspaceFileActions, type WorkspaceActionRequest, type WorkspaceTreeAction } from "./workspace-file-actions";
import { workspaceDrafts } from "./workspace-edit-state";
import { WorkspaceMoveHistory, type MovePlan } from "./workspace-move-history";
import { topLevelPaths } from "./workspace-selection";
import type { WorkspaceEntry, WorkspaceMutation } from "../../shared/workspace/workspace-mutations";
import { reconcileExplorerPaths, revealExplorerPath, setExplorerChangesOnly } from "./use-explorer-state";
import { IconFiles, IconList, IconSearch } from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import type { FileReference } from "./file-reference";
import type { WorkspaceFileContent, WorkspaceFileDiff, WorkspaceFileReadModel } from "../../shared/protocol/snapshots";
import { FileContent, type FileView } from "./files-panel";
import { FileHistoryViewer } from "./file-history";
import { FileTypeIcon } from "../rendering/file-icons";
import { WorkspaceTree } from "./workspace-tree";
import { ExplorerSearch } from "./workspace-search";
import { copyText } from "../ui/clipboard";
import {
  closeChangedFileTabs,
  closeFileTab,
  openFileTab,
  selectFileTab,
  reconcileFileTabs,
  setFileTabView,
  workspaceStateForSession,
  type FileWorkspaceState,
} from "./file-workspace-state";
import { runtimeStore, type RuntimeStoreSnapshot } from "../runtime/event-store";

export interface FileWorkspaceContentCacheEntry {
  generation: number;
  revision?: string;
  value: WorkspaceFileContent | WorkspaceFileDiff;
}

export type FileWorkspaceContentStore = Map<string, Map<string, FileWorkspaceContentCacheEntry>>;

type WorkspaceClipboardEntry = {
  mode: "copy" | "cut";
  path: string;
  directory: boolean;
  entry: WorkspaceEntry;
  sessionId: string;
  generation: number;
};

export function FileWorkspace({
  live,
  projectId,
  requestedPath,
  stateStore,
  contentStore,
  header,
  workspaceRef,
  sidePanel,
  rightPanelOpen,
  inspectorWidth,
  showExplorer,
  navigationOpen,
  mobile,
  onCloseNavigation,
  onSessions,
  onError,
}: {
  live: RuntimeStoreSnapshot;
  projectId?: string;
  requestedPath?: FileReference & { requestId: number; sessionId?: string; view?: FileView };
  stateStore: MutableRefObject<Map<string, FileWorkspaceState>>;
  contentStore: MutableRefObject<FileWorkspaceContentStore>;
  header: ReactNode;
  workspaceRef: RefObject<HTMLDivElement | null>;
  sidePanel: ReactNode;
  rightPanelOpen: boolean;
  inspectorWidth: number;
  showExplorer: boolean;
  navigationOpen: boolean;
  mobile: boolean;
  onCloseNavigation: () => void;
  onSessions: () => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const runtime = live.runtime;
  useSyncExternalStore(workspaceDrafts.subscribe, workspaceDrafts.snapshot);
  const workspaceRevision = `${runtime?.workspace?.revision ?? ""}:${runtime?.workspace?.fileRevision ?? 0}`;
  const mutationDisabled = live.connection !== "connected" || !runtime?.ready;
  const [fileAction, setFileAction] = useState<WorkspaceActionRequest>();
  const [moving, setMoving] = useState(false);
  const [clipboard, setClipboard] = useState<WorkspaceClipboardEntry>();
  const [announcement, setAnnouncement] = useState("");
  const canCompare =
    runtime?.workspace?.mode === "worktree" ||
    runtime?.workspace?.mode === "checkout" ||
    runtime?.workspace?.mode === "local";
  const sessionId = runtime?.sessionId ?? "";
  const histories = useRef(new Map<string, WorkspaceMoveHistory>());
  const history = useMemo(() => {
    let current = histories.current.get(sessionId);
    if (!current) {
      current = new WorkspaceMoveHistory(runtimeStore);
      histories.current.set(sessionId, current);
      if (histories.current.size > 10) histories.current.delete(histories.current.keys().next().value!);
    }
    return current;
  }, [sessionId]);
  const [ui, setUi] = useState<FileWorkspaceState>(() => workspaceStateForSession(stateStore.current, sessionId));
  const currentUi = ui.sessionId === sessionId ? ui : workspaceStateForSession(stateStore.current, sessionId);
  const [files, setFiles] = useState<WorkspaceFileReadModel[]>([]);
  const [inventorySessionId, setInventorySessionId] = useState(sessionId);
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
    setFileAction(undefined);
    return () => {
      const stored = stateStore.current.get(sessionId);
      if (stored) stateStore.current.set(sessionId, closeChangedFileTabs(stored));
    };
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
          setInventorySessionId(sessionId);
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
  }, [live.connection, runtime?.ready, runtime?.sessionId, runtime?.sessionGeneration, workspaceRevision]);

  useEffect(() => {
    if (!requestedPath || !sessionId || (requestedPath.sessionId && requestedPath.sessionId !== sessionId)) return;
    updateUi(current => openFileTab(current, requestedPath.path, requestedPath.view ?? "current", requestedPath.line));
  }, [requestedPath?.requestId, sessionId]);

  const contentKey = currentUi.selectedPath ? `${currentUi.view}\u0000${currentUi.selectedPath}` : undefined;
  const cachedContent = contentKey ? contentStore.current.get(sessionId)?.get(contentKey) : undefined;
  const validCachedContent =
    cachedContent &&
    cachedContent.generation === runtime?.sessionGeneration &&
    cachedContent.revision === workspaceRevision
      ? cachedContent.value
      : undefined;
  const visibleContent = loadedContent && loadedContent.key === contentKey ? loadedContent.value : validCachedContent;

  useEffect(() => {
    const { selectedPath, view } = currentUi;
    // Working-copy content belongs to WorkspaceEditor; do not snapshot Git just to open a text buffer.
    if (!selectedPath || !contentKey || view === "current") {
      setLoadedContent(undefined);
      setViewerLoading(false);
      return;
    }
    const cached = contentStore.current.get(sessionId)?.get(contentKey);
    if (
      cached &&
      cached.generation === runtime?.sessionGeneration &&
      cached.revision === workspaceRevision
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
    const revision = workspaceRevision;
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
    workspaceRevision,
  ]);

  const currentFiles = useMemo(
    () => (inventorySessionId === sessionId ? files : []),
    [files, inventorySessionId, sessionId],
  );

  const selectFile = (path: string) => updateUi(current => openFileTab(current, path));
  const selectOpenFile = (path: string) => updateUi(current => selectFileTab(current, path));
  const setSelectedView = (view: FileView) =>
    updateUi(current => {
      if (!current.selectedPath) return current;
      const next = setFileTabView(current, current.selectedPath, view);
      return view === "current" ? { ...next, changedPaths: next.changedPaths.filter(path => path !== current.selectedPath) } : next;
    });
  const closeFile = (path: string) => {
    if (workspaceDrafts.get(sessionId, path)?.saving) { onError(new Error("Wait for the file save to finish."), "Unable to close file"); return; }
    if (workspaceDrafts.dirty(sessionId, path) && !window.confirm(`Discard unsaved edits to ${path} and close it?`)) return;
    workspaceDrafts.remove(sessionId, path);
    updateUi(current => closeFileTab(current, path));
  };
  const preparingAction = useRef(false);
  const beginFileAction = async (action: WorkspaceTreeAction, path: string, directory: boolean, paths?: string[]) => {
    if (!runtime || mutationDisabled || preparingAction.current) return;
    preparingAction.current = true;
    setAnnouncement("");
    try {
      const generation = runtime.sessionGeneration;
      if (action === "move") {
        const sources = topLevelPaths(paths ?? [path]);
        if (!sources.length || sources.length > 100) throw new Error("Select between 1 and 100 entries per move.");
        const entries: WorkspaceEntry[] = [];
        for (const source of sources) {
          if (workspaceDrafts.dirty(sessionId, source)) throw new Error("Save or discard affected drafts first.");
          entries.push(await runtimeStore.workspaceEntry(source, sessionId, generation));
        }
        setFileAction({ action, path: sources[0], directory, entry: entries[0], entries, sessionId, generation });
        return;
      }
      if (action === "copyRelativePath") {
        if (!await copyText(path)) throw new Error("Browser clipboard access was denied.");
        setAnnouncement("Relative path copied");
        return;
      }
      if (action === "paste") {
        const source = clipboard;
        if (!source || source.sessionId !== sessionId || source.generation !== generation)
          throw new Error("Copy or cut an entry from this workspace first.");
        if (!directory) throw new Error("Files can only be pasted into folders.");
        if (workspaceDrafts.dirty(sessionId, source.path)) throw new Error("Save or discard affected drafts before pasting.");
        const name = source.path.split("/").at(-1)!;
        const destination = path ? `${path}/${name}` : name;
        if (workspaceDrafts.dirty(sessionId, destination)) throw new Error("Save or discard destination drafts before pasting.");
        let mutation: WorkspaceMutation;
        if (source.mode === "copy") {
          mutation = { action: "copy", path: source.path, destination, expectedVersion: source.entry.version };
          await runtimeStore.mutateWorkspace(mutation, sessionId, generation);
        } else {
          await applyMoves([{ path: source.path, destination, expectedVersion: source.entry.version }], sessionId, generation);
          setClipboard(current => current === source ? undefined : current);
          return;
        }
        afterMutation(mutation, sessionId);
        setAnnouncement(`${source.directory ? "Folder" : "File"} ${source.mode === "copy" ? "copied" : "moved"}`);
        return;
      }
      if (["rename", "move", "delete", "copy", "cut"].includes(action) && workspaceDrafts.dirty(sessionId, path))
        throw new Error("Save or discard affected drafts before changing this entry.");
      const entry = ["rename", "move", "delete", "copy", "cut", "copyFullPath"].includes(action)
        ? await runtimeStore.workspaceEntry(path, sessionId, generation) : undefined;
      const current = runtimeStore.getSnapshot().runtime;
      if (current?.sessionId !== sessionId || current.sessionGeneration !== generation)
        throw new Error("Session changed while preparing the file operation.");
      if (action === "copyFullPath") {
        if (!entry?.absolutePath || !await copyText(entry.absolutePath)) throw new Error("Browser clipboard access was denied.");
        setAnnouncement("Full path copied");
        return;
      }
      if (action === "copy" || action === "cut") {
        if (!entry) throw new Error("Workspace entry is unavailable.");
        setClipboard({ mode: action, path, directory, entry, sessionId, generation });
        setAnnouncement(`${directory ? "Folder" : "File"} ${action === "copy" ? "copied" : "cut"}`);
        return;
      }
      setFileAction({ action, path, directory, entry, sessionId, generation });
    } catch (error) { onError(error, "Unable to perform file operation"); }
    finally { preparingAction.current = false; }
  };
  const applyMoves = async (plans: MovePlan[], targetSession: string, generation: number) => {
    if (mutationDisabled || targetSession !== sessionId || generation !== runtime?.sessionGeneration)
      throw new Error("Session changed; reopen the move action.");
    setMoving(true); setAnnouncement("Moving entries…");
    try {
      const result = await history.move(plans, targetSession, generation, afterMutation);
      setAnnouncement(result.error ?? `${result.completed} entries moved`);
      if (result.error) throw new Error(result.error);
    } finally { setMoving(false); }
  };
  const dropMove = async (plans: MovePlan[]) => {
    if (!runtime || mutationDisabled || fileAction || preparingAction.current) return;
    preparingAction.current = true;
    try { await applyMoves(plans, sessionId, runtime.sessionGeneration); }
    catch (error) { onError(error, "Unable to move entries"); }
    finally { preparingAction.current = false; }
  };
  const replayMove = async (direction: "undo" | "redo") => {
    if (!runtime || mutationDisabled || fileAction || preparingAction.current) return;
    preparingAction.current = true; setMoving(true);
    try {
      const result = await history.replay(direction, sessionId, runtime.sessionGeneration, afterMutation);
      setAnnouncement(result.error ?? `${direction === "undo" ? "Undid" : "Redid"} ${result.completed} moves`);
      if (result.error) throw new Error(result.error);
    } catch (error) { onError(error, "Unable to replay moves"); }
    finally { preparingAction.current = false; setMoving(false); }
  };
  const afterMutation = (mutation: WorkspaceMutation, targetSession: string) => {
    if (mutation.action !== "move") history.clear();
    // The server's file revision invalidates contents, even if its event precedes this response.
    let next = workspaceStateForSession(stateStore.current, targetSession);
    if (mutation.action === "move" || mutation.action === "delete") {
      const destination = mutation.action === "move" ? mutation.destination : undefined;
      workspaceDrafts.removeUnder(targetSession, mutation.path);
      next = reconcileFileTabs(next, mutation.path, destination);
      reconcileExplorerPaths(projectId, mutation.path, destination);
      if (destination) {
        setExplorerChangesOnly(projectId, false);
        revealExplorerPath(projectId, destination);
        next = { ...next, query: "" };
      }
    } else if (mutation.action === "createFile") {
      next = openFileTab(next, mutation.path, "current");
    }
    if (mutation.action === "createFile" || mutation.action === "createDirectory" || mutation.action === "copy") {
      const revealed = mutation.action === "copy" ? mutation.destination : mutation.path;
      setExplorerChangesOnly(projectId, false);
      revealExplorerPath(projectId, revealed);
      next = { ...next, query: "" };
    }
    stateStore.current.set(targetSession, next);
    if (runtimeStore.getSnapshot().runtime?.sessionId === targetSession) {
      setUi(next);
    }
  };
  return (
    <section className={`file-workspace-shell${showExplorer ? "" : " has-session-navigation"}`}>
      {showExplorer && (
        <aside
          className={`file-workspace-explorer${navigationOpen ? " is-open" : ""}`}
          aria-label="Workspace explorer"
          aria-hidden={mobile && !navigationOpen}
          inert={mobile && !navigationOpen}>
          <header className="panel-header">
            <span>
              <strong>Explorer</strong>
              {/* the session list's count has a counterpart here, but only once
                  the inventory has actually arrived — 0 files while indexing is
                  a wrong answer, not an empty one */}
              {currentFiles.length ? <small>{currentFiles.filter(file => !file.kind).length.toLocaleString()} files</small> : undefined}
            </span>
            <button className="panel-swap" type="button" onClick={onSessions}>
              <IconList size={14} />
              Sessions
            </button>
          </header>
          <ExplorerSearch scope={`${sessionId}:${runtime?.sessionGeneration}`} query={currentUi.query}
            onQuery={query => updateUi(current => ({ ...current, query }))}
            onOpen={(path, line) => updateUi(current => openFileTab(current, path, "current", line))}>
          <WorkspaceTree
            files={currentFiles}
            selectedPath={currentUi.selectedPath}
            query={currentUi.query}
            projectId={projectId}
            onClearQuery={() => updateUi(current => ({ ...current, query: "" }))}
            canPaste={clipboard?.sessionId === sessionId && clipboard.generation === runtime?.sessionGeneration}
            onFileAction={mutationDisabled || moving ? undefined : (action, path, directory, paths) => void beginFileAction(action, path, directory, paths)}
            moveScope={`${sessionId}:${runtime?.sessionGeneration}`}
            onMove={mutationDisabled || moving || fileAction ? undefined : plans => void dropMove(plans)}
            onUndo={!mutationDisabled && !moving && !fileAction && history.canUndo ? () => void replayMove("undo") : undefined}
            onRedo={!mutationDisabled && !moving && !fileAction && history.canRedo ? () => void replayMove("redo") : undefined}
            onClearHistory={!moving && !fileAction && history.hasHistory ? () => { history.clear(); setAnnouncement("Move history cleared; files unchanged."); } : undefined}
            onSelect={selectFile}>
            {inventoryLoading && !currentFiles.length && (
              <span className={inventoryProgress ? "files-progress" : "files-empty"}>
                {inventoryProgress
                  ? `Loading ${inventoryProgress.loaded.toLocaleString()} of ${inventoryProgress.total.toLocaleString()} files…`
                  : "Indexing workspace…"}
              </span>
            )}
            {!inventoryLoading && !currentFiles.length && <span className="files-empty">No files found</span>}
            {inventorySessionId === sessionId && truncated && (
              <span className="files-truncated">Showing first 10,000 files</span>
            )}
          </WorkspaceTree>
          <span className="sr-only" aria-live="polite">{announcement}</span>
          </ExplorerSearch>
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
                    <span>{path.split("/").at(-1) ?? path}{workspaceDrafts.dirty(sessionId, path) ? " •" : ""}</span>
                  </button>
                  <button type="button" onClick={() => closeFile(path)} aria-label={`Close ${path}`}>
                    ×
                  </button>
                </div>
              ))}
            </div>
            <section className="file-workspace-editor" aria-label="Open file">
              {currentUi.selectedPath ? (
                <FileHistoryViewer
                  key={`${sessionId}:${runtime?.sessionGeneration}:${currentUi.selectedPath}:${requestedPath?.requestId ?? ""}`}
                  path={currentUi.selectedPath}
                  live={live}
                  canCompare={canCompare}
                  view={currentUi.view}
                  onView={setSelectedView}
                  value={viewerLoading && !visibleContent ? undefined : visibleContent}
                  targetLine={currentUi.selectedLine}
                  onClose={() => closeFile(currentUi.selectedPath!)}
                  onError={onError}
                  liveEditor={<WorkspaceEditor sessionId={sessionId} generation={runtime!.sessionGeneration}
                    path={currentUi.selectedPath} revision={workspaceRevision} targetLine={currentUi.selectedLine}
                    ready={!mutationDisabled} disabled={mutationDisabled}>
                    {value => <FileContent value={value} view="current" targetLine={currentUi.selectedLine} onError={onError} />}
                  </WorkspaceEditor>}
                />
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
      {fileAction && <WorkspaceFileActions key={`${fileAction.sessionId}:${fileAction.action}:${fileAction.path}`}
        request={fileAction} files={currentFiles} onClose={() => setFileAction(undefined)} onMutation={afterMutation} onMove={applyMoves} />}
    </section>
  );
}
