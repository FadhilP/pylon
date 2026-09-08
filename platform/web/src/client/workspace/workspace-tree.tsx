import { dispatchShortcut } from "../ui/keyboard-shortcuts";
import { useAnnotations } from "./annotations";
import { createPortal } from "react-dom";
import { pathWithin, validWorkspacePath } from "../../shared/workspace/workspace-mutations";
import type { WorkspaceTreeAction } from "./workspace-file-actions";
import { IconChevronsDown, IconChevronsUp, IconCrosshair, IconDots, IconPlus } from "@tabler/icons-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type ReactNode,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { WORKSPACE_FILE_DRAG_TYPE } from "../conversation/composer-input";
import type { WorkspaceFileReadModel } from "../../shared/protocol/snapshots";
import {
  ancestors,
  buildWorkspaceTree,
  subsequenceMatch,
  type WorkspaceTreeNode,
} from "./workspace-tree-model";
import { setExplorerChangesOnly, setExplorerOpen, useExplorerState } from "./use-explorer-state";
import { FileTypeIcon, FolderTypeIcon } from "../rendering/file-icons";
import { WORKSPACE_ENTRY_DRAG_TYPE, workspaceDropDestination, workspaceMoveInventory, type WorkspaceDragSource } from "./workspace-move";
import { selectWorkspacePaths, topLevelPaths } from "./workspace-selection";
import { planFolderMove } from "./workspace-move";
import type { MovePlan } from "./workspace-move-history";

/** Two fixed cells, so a row with only additions still lines up with one that
    has both. The empty half is present and invisible, never collapsed. */
function ChangeCount({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <em className="files-stat">
      <ins className={additions ? undefined : "is-blank"}>+{additions}</ins>
      <del className={deletions ? undefined : "is-blank"}>−{deletions}</del>
    </em>
  );
}

export function WorkspaceTree({
  files,
  selectedPath,
  onSelect,
  query,
  projectId,
  onClearQuery,
  children,
  onFileAction,
  canPaste,
  moveScope,
  onMove,
  onUndo, onRedo, onClearHistory,
}: {
  files: WorkspaceFileReadModel[];
  selectedPath?: string;
  onSelect: (path: string, changed: boolean) => void;
  query: string;
  /** Which project's remembered open folders and change filter to use. */
  projectId?: string;
  /** Empties the caller's filter box, so revealing a file can clear what hides it. */
  onClearQuery: () => void;
  /** Inventory notices — loading, empty, truncated — rendered under the rows. */
  children?: ReactNode;
  onFileAction?: (action: WorkspaceTreeAction, path: string, directory: boolean, paths?: string[]) => void;
  canPaste?: boolean;
  moveScope?: string;
  onMove?: (plans: MovePlan[]) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onClearHistory?: () => void;
}) {
  const annotations = useAnnotations();
  const noteCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of annotations?.notes ?? []) counts.set(note.path, (counts.get(note.path) ?? 0) + 1);
    return counts;
  }, [annotations?.notes]);
  const root = useMemo(() => buildWorkspaceTree(files), [files]);
  const moveInventory = useMemo(() => workspaceMoveInventory(files), [files]);
  const dragSource = useRef<WorkspaceDragSource | undefined>(undefined);
  const [dropFolder, setDropFolder] = useState<string>();
  const clearDrag = () => { dragSource.current = undefined; setDropFolder(undefined); };
  useEffect(clearDrag, [moveScope]);
  const [storedSelection, storeSelection] = useState<{ paths: string[]; anchor?: string; scope?: string }>({ paths: [] });
  const selection = storedSelection.scope === moveScope ? storedSelection : { paths: [], anchor: undefined };
  const setSelection = (next: { paths: string[]; anchor?: string }) => storeSelection({ ...next, scope: moveScope });
  useEffect(() => { setSelection({ paths: selectedPath ? [selectedPath] : [], anchor: selectedPath }); }, [selectedPath, moveScope]);
  const canMove = (node: WorkspaceTreeNode) => Boolean(onMove && moveScope && validWorkspacePath(node.path) &&
    moveInventory.occupied.has(node.path) && !moveInventory.submodules.some(module => pathWithin(node.path, module) || pathWithin(module, node.path)));
  const startDrag = (node: WorkspaceTreeNode, event: ReactDragEvent<HTMLButtonElement>) => {
    clearDrag();
    event.dataTransfer.effectAllowed = "copy";
    // Preserve file-to-composer mentions; folders only carry the tree-move payload.
    if (!node.directory) event.dataTransfer.setData(WORKSPACE_FILE_DRAG_TYPE, node.path);
    if (!canMove(node)) return;
    const paths = topLevelPaths(selected.includes(node.path) ? selected : [node.path]);
    if (!paths.every(path => canMove(rowByPath.get(path)!))) return;
    setSelection({ paths, anchor: node.path });
    dragSource.current = { path: node.path, paths, scope: moveScope! };
    event.dataTransfer.effectAllowed = node.directory ? "move" : "copyMove";
    event.dataTransfer.setData(WORKSPACE_ENTRY_DRAG_TYPE, node.path);
  };
  const dropTarget = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!onMove || !event.dataTransfer.types.includes(WORKSPACE_ENTRY_DRAG_TYPE)) return;
    const folder = (event.target as HTMLElement).closest<HTMLElement>("[data-move-folder]")?.dataset.moveFolder;
    const source = dragSource.current;
    if (!source || !(source.paths ?? [source.path]).every(path => workspaceDropDestination({ path, scope: source.scope }, moveScope, folder, moveInventory))) return;
    try { return { folder: folder!, plans: planFolderMove(source.paths ?? [source.path], folder!, moveInventory) }; }
    catch { return; }
  };
  // Nothing expands on its own: the tree is exactly where this project last left it.
  const stored = useExplorerState(projectId);
  const open = useMemo(() => new Set(stored.open), [stored.open]);
  const changesOnly = stored.changesOnly;
  const [focusPath, setFocusPath] = useState<string>();
  // Counts presses rather than tracking the path, so revealing the same file
  // twice still scrolls the second time.
  const [revealAt, setRevealAt] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ path: string; directory: boolean; x: number; y: number }>();
  const openMenu = (path: string, x: number, y: number) => {
    if (!onFileAction) return;
    const row = rows.find(row => row.node.path === path)?.node;
    if (path && (!validWorkspacePath(path) || row?.file?.status === "deleted" || files.some(file => file.kind === "submodule" && file.path === path))) return;
    setFocusPath(path);
    if (!selected.includes(path)) setSelection({ paths: path ? [path] : [], anchor: path || undefined });
    setMenu({ path, directory: !path || Boolean(row?.directory), x, y });
  };
  const scrollToPath = (path: string) =>
    listRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "nearest" });
  // The ancestor rows only exist after the expand has rendered, so the scroll waits for it.
  useEffect(() => {
    if (revealAt && selectedPath) scrollToPath(selectedPath);
  }, [revealAt]);

  const trimmed = query.trim();
  const passes = (node: WorkspaceTreeNode) =>
    (!changesOnly || Boolean(node.file?.status)) && subsequenceMatch(trimmed, node.path);
  // A childless directory is a registered submodule: it has no file to match on,
  // so it stands or falls on its own path.
  const anyVisible = (node: WorkspaceTreeNode): boolean =>
    node.children.length
      ? node.children.some(child => (child.directory ? anyVisible(child) : passes(child)))
      : !changesOnly && subsequenceMatch(trimmed, node.path);

  // Expand-all is bounded by the filter: only folders with something visible in
  // them open, so a query or the change filter keeps it small.
  const expandable = (node: WorkspaceTreeNode, into = new Set<string>()) => {
    for (const child of node.children) {
      if (!child.directory || !anyVisible(child)) continue;
      into.add(child.path);
      expandable(child, into);
    }
    return into;
  };

  const rows: { node: WorkspaceTreeNode; depth: number }[] = [];
  const walk = (node: WorkspaceTreeNode, depth: number) => {
    for (const child of node.children) {
      if (!(child.directory ? anyVisible(child) : passes(child))) continue;
      rows.push({ node: child, depth });
      if (child.directory && open.has(child.path)) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  const visiblePaths = rows.map(row => row.node.path);
  const rowByPath = new Map(rows.map(row => [row.node.path, row.node]));
  const selected = selection.paths.filter(path => rowByPath.has(path));
  const selectedSet = new Set(selected);
  const selectPaths = (path: string, toggle = false, range = false) => {
    setSelection(selectWorkspacePaths(selected, selection.anchor, path, visiblePaths, { toggle, range }));
    setFocusPath(path);
  };
  const activate = (node: WorkspaceTreeNode, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    selectPaths(node.path, event.ctrlKey || event.metaKey, event.shiftKey);
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (node.directory) toggle(node.path);
    else onSelect(node.path, Boolean(node.file?.status));
  };

  const visibleFiles = files.filter(file => (!changesOnly || file.status) && subsequenceMatch(trimmed, file.path));
  const totals = visibleFiles.reduce(
    (accumulated, file) => ({
      additions: accumulated.additions + (file.additions ?? 0),
      deletions: accumulated.deletions + (file.deletions ?? 0),
      changed: accumulated.changed + (file.status ? 1 : 0),
    }),
    { additions: 0, deletions: 0, changed: 0 },
  );

  const toggle = (path: string) => {
    const next = new Set(open);
    if (!next.delete(path)) next.add(path);
    setExplorerOpen(projectId, next);
  };

  const focused = focusPath ?? selectedPath;
  const focusedRow = rows.find(row => row.node.path === focused)?.node;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault(); setSelection({ paths: visiblePaths, anchor: visiblePaths[0] }); return;
    }
    if (dispatchShortcut(event.nativeEvent, "explorer", {
      reveal: () => { if (!selectedPath) return false; reveal(); },
      collapse: () => { if (!open.size) return false; setExplorerOpen(projectId, new Set()); },
      "undo-move": () => { onUndo?.(); },
      "redo-move": () => { onRedo?.(); },
      "copy-entry": () => {
        if (!onFileAction || !focusedRow || selected.length > 1) return false;
        onFileAction("copy", focusedRow.path, focusedRow.directory);
      },
      "cut-entry": () => {
        if (!onFileAction || !focusedRow || selected.length > 1) return false;
        onFileAction("cut", focusedRow.path, focusedRow.directory);
      },
      "paste-entry": () => {
        if (!onFileAction || !canPaste || (focusedRow && !focusedRow.directory)) return false;
        onFileAction("paste", focusedRow?.path ?? "", true);
      },
    })) return;
    const at = rows.findIndex(row => row.node.path === focused);
    if (onFileAction && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      openMenu(focused ?? "", bounds.left + 24, bounds.top + 24);
      return;
    }
    const move = (to: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, to))];
      if (!row) return;
      event.preventDefault();
      setFocusPath(row.node.path);
      if (event.shiftKey || !(event.ctrlKey || event.metaKey)) selectPaths(row.node.path, false, event.shiftKey);
      scrollToPath(row.node.path);
    };
    if (event.key === "ArrowDown") return move(at + 1);
    if (event.key === "ArrowUp") return move(at - 1);
    const row = rows[at];
    if (!row) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      if (!row.node.directory) return;
      event.preventDefault();
      toggle(row.node.path);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (event.key === " ") selectPaths(row.node.path, !event.shiftKey, event.shiftKey);
      else activate(row.node, event);
    }
  };

  const anyOpen = open.size > 0;
  const hasFolders = rows.some(row => row.node.directory);

  /** Opens the way down to the file on screen, clearing whatever was hiding it. */
  const reveal = () => {
    if (!selectedPath) return;
    setExplorerOpen(projectId, new Set([...open, ...ancestors(selectedPath)]));
    const selected = files.find(file => file.path === selectedPath);
    if (changesOnly && !selected?.status) setExplorerChangesOnly(projectId, false);
    if (trimmed && !subsequenceMatch(trimmed, selectedPath)) onClearQuery();
    setRevealAt(at => at + 1);
  };

  return (
    <div className="files-tree" onContextMenu={event => {
      if (!onFileAction) return;
      event.preventDefault();
      const path = (event.target as HTMLElement).closest<HTMLElement>("[data-path]")?.dataset.path ?? "";
      openMenu(path, event.clientX, event.clientY);
    }} onDragOver={event => {
      const target = dropTarget(event);
      setDropFolder(target?.folder);
      if (!target) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    }} onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropFolder(undefined);
    }} onDragEnd={clearDrag} onDrop={event => {
      const target = dropTarget(event);
      const source = dragSource.current;
      clearDrag();
      if (!target || !source || event.dataTransfer.getData(WORKSPACE_ENTRY_DRAG_TYPE) !== source.path) return;
      event.preventDefault();
      event.stopPropagation();
      onMove?.(target.plans);
    }}>
      {(hasFolders || onFileAction) && (
        <div className="files-toolbar">
          <button
            type="button"
            className="files-fold"
            onClick={() => setExplorerOpen(projectId, anyOpen ? new Set() : expandable(root, new Set(open)))}>
            {anyOpen ? <IconChevronsUp size={14} /> : <IconChevronsDown size={14} />}
            {anyOpen ? "Collapse all" : "Expand all"}
          </button>
          {onFileAction && <>
            <button className="files-action" type="button" aria-label="New file or folder at workspace root" title="New file or folder" onClick={event => {
              const bounds = event.currentTarget.getBoundingClientRect(); openMenu("", bounds.left, bounds.bottom);
            }}><IconPlus size={14} /></button>
            <button className="files-action" type="button" aria-label={`Actions for ${focused || "workspace root"}`} title={`Actions for ${focused || "workspace root"}`} onClick={event => {
              const bounds = event.currentTarget.getBoundingClientRect(); openMenu(focused ?? "", bounds.left, bounds.bottom);
            }}><IconDots size={14} /></button>
          </>}
          <button
            type="button"
            className="files-reveal"
            disabled={!selectedPath}
            aria-label="Show open file in tree"
            title={selectedPath ? `Show ${selectedPath} in tree` : "No file open"}
            onClick={reveal}>
            <IconCrosshair size={14} />
          </button>
        </div>
      )}
      {(onUndo || onRedo || onClearHistory) && <div className="files-toolbar">
        <button type="button" className="files-fold" disabled={!onUndo} title="Undo move (Ctrl/Cmd+Z in explorer)" onClick={onUndo}>Undo move</button>
        <button type="button" className="files-fold" disabled={!onRedo} title="Redo move (Ctrl/Cmd+Shift+Z in explorer)" onClick={onRedo}>Redo move</button>
        <button type="button" className="files-fold" disabled={!onClearHistory} title="Forget move history without changing files" onClick={onClearHistory}>Clear history</button>
      </div>}
      {onMove && <div data-move-folder="" className={`files-drop-root${dropFolder === "" ? " is-drop-target" : ""}`}
        title="Drop a file or folder here to move it to workspace root">Workspace root</div>}
      <div
        ref={listRef}
        className="files-list"
        role="tree"
        aria-multiselectable="true"
        tabIndex={0}
        aria-label={changesOnly ? "Changed files" : "Project files"}
        onKeyDown={onKeyDown}>
        {rows.map(({ node, depth }) => (
          <TreeRow
            key={node.path}
            node={node}
            depth={depth}
            noteCount={noteCounts.get(node.path) ?? 0}
            open={open.has(node.path)}
            selected={selectedSet.has(node.path)}
            focused={node.path === focused}
            movable={canMove(node)}
            dropTarget={dropFolder === node.path}
            onDragStart={event => startDrag(node, event)}
            onActivate={event => activate(node, event)}
          />
        ))}
        {children}
      </div>
      <div className="files-foot">
        <span>
          <ins>+{totals.additions}</ins>
          <del>−{totals.deletions}</del>
        </span>
        {selected.length > 1 && <span role="status">{selected.length} selected</span>}
        <button
          type="button"
          className="files-only"
          aria-pressed={changesOnly}
          title={changesOnly ? "Show every file" : "Show only files this session changed"}
          onClick={() => setExplorerChangesOnly(projectId, !changesOnly)}>
          {totals.changed} changed
        </button>
      </div>
      {menu && onFileAction && <TreeActionMenu target={menu} multiple={Boolean(menu.path && selected.length > 1)} canPaste={canPaste} onClose={() => setMenu(undefined)}
        onAction={action => { setMenu(undefined); onFileAction(action, menu.path, menu.directory, action === "move" && selected.includes(menu.path) ? topLevelPaths(selected) : undefined); }} />}
    </div>
  );
}

function TreeRow({
  node,
  depth,
  open,
  selected,
  focused,
  onActivate,
  noteCount,
  movable,
  dropTarget,
  onDragStart,
}: {
  node: WorkspaceTreeNode;
  depth: number;
  open: boolean;
  selected: boolean;
  focused: boolean;
  onActivate: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  noteCount: number;
  movable: boolean;
  dropTarget: boolean;
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void;
}) {
  const status = node.file?.status;
  // The rail sits at the panel's left edge, not in the indent, so it stacks into
  // one fixed column and consecutive changes merge into a run.
  const rail = node.directory ? (node.changedCount && !open ? "is-rolled" : undefined) : status && `is-${status}`;
  const showCount = node.directory ? Boolean(node.changedCount) && !open : Boolean(status);
  return (
    <button
      type="button"
      role="treeitem"
      data-path={node.path}
      data-move-folder={node.directory ? node.path : undefined}
      draggable={!node.directory || movable}
      aria-expanded={node.directory ? open : undefined}
      aria-selected={selected}
      tabIndex={-1}
      className={`files-row${selected ? " is-active" : ""}${focused ? " is-focused" : ""}${
        node.directory ? " is-directory" : ""
      }${status === "deleted" ? " is-gone" : ""}${dropTarget ? " is-drop-target" : ""}`}
      style={{ paddingLeft: `min(${13 + depth * 13}px, 25%)` }}
      title={node.path + (status ? ` — ${status}` : "")}
      onDragStart={onDragStart}
      onClick={onActivate}>
      {node.directory ? (
        <FolderTypeIcon name={node.name} open={open} size={15} />
      ) : (
        <FileTypeIcon path={node.path} size={15} />
      )}
      <span className="files-row-name">{node.name}</span>
      <span className="files-row-meta">
        {noteCount > 0 && <em className="annotation-file-count" title={`${noteCount} saved notes`} aria-label={`${noteCount} saved notes`}>{noteCount}</em>}
        {node.file?.binary ? (
          <em className="files-stat is-binary">binary</em>
        ) : showCount ? (
          <ChangeCount additions={node.additions} deletions={node.deletions} />
        ) : (
          <em className="files-stat" />
        )}
      </span>
      {rail && <i className={`files-rail ${rail}`} aria-hidden="true" />}
    </button>
  );
}

function TreeActionMenu({ target, multiple, canPaste, onClose, onAction }: {
  target: { path: string; directory: boolean; x: number; y: number };
  canPaste?: boolean;
  multiple: boolean;
  onClose: () => void;
  onAction: (action: WorkspaceTreeAction) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("pointerdown", outside); if (previous?.isConnected) previous.focus(); };
  }, []);
  const actions: [WorkspaceTreeAction, string][] = multiple ? [["move", "Move selected…"]] : [
    ...(target.directory ? [["createFile", "New File"], ["createDirectory", "New Folder"]] as [WorkspaceTreeAction, string][] : []),
    ...(target.path ? [["copy", "Copy"], ["cut", "Cut"]] as [WorkspaceTreeAction, string][] : []),
    ...(target.directory && canPaste ? [["paste", "Paste"]] as [WorkspaceTreeAction, string][] : []),
    ...(target.path ? [["copyRelativePath", "Copy Relative Path"], ["copyFullPath", "Copy Full Path"],
      ["rename", "Rename"], ["move", "Move"], ["delete", "Delete"]] as [WorkspaceTreeAction, string][] : []),
  ];
  return createPortal(<div ref={ref} role="menu" aria-label={`Actions for ${target.path || "workspace root"}`}
    className="workspace-tree-menu" style={{ left: Math.max(4, Math.min(target.x, window.innerWidth - 200)), top: Math.max(4, Math.min(target.y, window.innerHeight - 230)) }}
    onKeyDown={event => {
      if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); onClose(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
    {actions.map(([action, label]) => <button key={action} type="button" role="menuitem" onClick={() => onAction(action)}>{label}</button>)}
  </div>, document.body);
}
