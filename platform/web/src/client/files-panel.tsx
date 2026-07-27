import {
  IconArrowBackUp,
  IconCopy,
  IconFile,
  IconFiles,
  IconFolder,
  IconGitCompare,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import { highlightSource } from "../shared/markdown";
import { drainWorkspaceFiles } from "../shared/workspace-file-pages";
import type {
  RuntimeSnapshot,
  WorkspaceFileContent,
  WorkspaceFileDiff,
  WorkspaceFileReadModel,
} from "../shared/protocol/snapshots";
import { runtimeStore } from "./runtime/event-store";

type FileView = "current" | "base" | "diff";

export function FilesPanel({ runtime, requestedPath, onClose, onError }: {
  runtime?: RuntimeSnapshot;
  requestedPath?: string;
  onClose: () => void;
  onError: (error: unknown, fallback: string) => void;
}) {
  const [tab, setTab] = useState<"changes" | "files">("changes");
  const [files, setFiles] = useState<WorkspaceFileReadModel[]>([]);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [view, setView] = useState<FileView>("diff");
  const [content, setContent] = useState<WorkspaceFileContent | WorkspaceFileDiff>();
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const requestRevision = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const revision = ++requestRevision.current;
    setFiles([]);
    setTruncated(false);
    setInventoryLoading(true);
    void (async () => {
      const loaded = await drainWorkspaceFiles(
        (cursor) => runtimeStore.workspaceFiles(query, cursor, controller.signal),
        controller.signal,
        (next, wasTruncated) => {
          if (revision !== requestRevision.current) return;
          setFiles(next);
          setTruncated(wasTruncated);
        },
      );
      if (requestedPath && loaded.some((file) => file.path === requestedPath)) {
        setSelectedPath(requestedPath);
      }
    })().catch((error) => {
      if (!controller.signal.aborted) onError(error, "Unable to list workspace files");
    }).finally(() => {
      if (revision === requestRevision.current) setInventoryLoading(false);
    });
    return () => {
      controller.abort();
      requestRevision.current++;
    };
  }, [runtime?.sessionId, runtime?.workspace?.revision, query, refreshRevision]);
  useEffect(() => {
    if (!requestedPath) return;
    setSelectedPath(requestedPath);
    setView(runtime?.workspace?.mode === "worktree" ? "diff" : "current");
  }, [requestedPath, runtime?.workspace?.mode]);
  useEffect(() => {
    if (!selectedPath) {
      setContent(undefined);
      return;
    }
    let active = true;
    setViewerLoading(true);
    const request = view === "diff"
      ? runtimeStore.workspaceDiff(selectedPath)
      : runtimeStore.workspaceFile(selectedPath, view);
    void request.then((value) => {
      if (active) setContent(value);
    })
      .catch((error) => {
        if (!active) return;
        setContent(undefined);
        onError(error, "Unable to read workspace file");
      })
      .finally(() => {
        if (active) setViewerLoading(false);
      });
    return () => { active = false; };
  }, [selectedPath, view, runtime?.workspace?.revision]);

  const visible = tab === "changes" ? files.filter((file) => file.status) : files;
  const workspace = runtime?.workspace;
  return <aside id="files-panel" className="inspector files-panel is-open" aria-labelledby="files-title">
    <header>
      <div><IconFiles size={18} /><strong id="files-title">Files</strong></div>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close files"><IconX size={17} /></button>
    </header>
    <div className="files-workspace-bar">
      <span>{workspace?.mode === "worktree" ? "Isolated worktree" : workspace?.mode === "checkout" ? "Project checkout" : "Files only"}</span>
      {workspace?.mode === "worktree" && <button type="button" disabled={!workspace.canMoveToCheckout} onClick={() =>
        void runtimeStore.handoffSession("checkout").catch((error) => onError(error, "Unable to move session"))}>
        Move to project checkout
      </button>}
      {workspace?.mode === "checkout" && workspace.canMoveToWorktree && <button type="button" onClick={() =>
        void runtimeStore.handoffSession("worktree").catch((error) => onError(error, "Unable to move session"))}>
        Move to worktree
      </button>}
      <button className="icon-button" type="button" onClick={() => setRefreshRevision((current) => current + 1)} aria-label="Refresh files"><IconRefresh size={15} /></button>
    </div>
    <nav className="files-tabs" aria-label="File views">
      <button className={tab === "changes" ? "is-active" : ""} onClick={() => setTab("changes")}>Changes <span>{workspace?.changedCount ?? 0}</span></button>
      <button className={tab === "files" ? "is-active" : ""} onClick={() => setTab("files")}>Files</button>
    </nav>
    <label className="files-search"><IconSearch size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files" /></label>
    <div className="files-panel-body">
      <div className="files-list" aria-label={tab === "changes" ? "Changed files" : "Project files"}>
        {inventoryLoading && !files.length && <span className="files-empty">Loading…</span>}
        {!inventoryLoading && !visible.length && <span className="files-empty">{tab === "changes" ? "No session changes" : "No files found"}</span>}
        {tab === "changes"
          ? visible.map((file) => <FileRow key={file.path} file={file} selectedPath={selectedPath} onSelect={(path) => {
              setSelectedPath(path);
              setView("diff");
            }} />)
          : <FileTree files={visible} selectedPath={selectedPath} onSelect={(path) => {
              setSelectedPath(path);
              setView("current");
            }} />}
        {truncated && <span className="files-truncated">Showing first 10,000 files</span>}
      </div>
      <div className="file-viewer">
        {!selectedPath && <div className="files-empty large"><IconFiles size={24} />Select a file to inspect</div>}
        {selectedPath && <>
          <div className="file-viewer-toolbar">
            <code title={selectedPath}>{selectedPath}</code>
            <span>
              {workspace?.mode === "worktree" && <>
                <button className={view === "diff" ? "is-active" : ""} onClick={() => setView("diff")}><IconGitCompare size={14} />Diff</button>
                <button className={view === "base" ? "is-active" : ""} onClick={() => setView("base")}><IconArrowBackUp size={14} />Base</button>
              </>}
              <button className={view === "current" ? "is-active" : ""} onClick={() => setView("current")}>Current</button>
              <button className="icon-button" onClick={() => void navigator.clipboard.writeText(selectedPath)} aria-label="Copy file path"><IconCopy size={14} /></button>
            </span>
          </div>
          <FileContent value={viewerLoading ? undefined : content} view={view} />
        </>}
      </div>
    </div>
  </aside>;
}

interface FileTreeNode {
  files: WorkspaceFileReadModel[];
  directories: Map<string, FileTreeNode>;
}

function FileTree({ files, selectedPath, onSelect }: {
  files: WorkspaceFileReadModel[];
  selectedPath?: string;
  onSelect: (path: string) => void;
}) {
  const root: FileTreeNode = { files: [], directories: new Map() };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
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
  return <TreeNode node={root} selectedPath={selectedPath} onSelect={onSelect} />;
}

function TreeNode({ node, selectedPath, onSelect }: {
  node: FileTreeNode;
  selectedPath?: string;
  onSelect: (path: string) => void;
}) {
  return <>
    {[...node.directories].sort(([left], [right]) => left.localeCompare(right)).map(([name, child]) =>
      <details className="files-directory" key={name}>
        <summary><IconFolder size={14} />{name}</summary>
        <TreeNode node={child} selectedPath={selectedPath} onSelect={onSelect} />
      </details>)}
    {node.files.sort((left, right) => left.path.localeCompare(right.path)).map((file) =>
      <FileRow key={file.path} file={file} selectedPath={selectedPath} onSelect={onSelect} />)}
  </>;
}

function FileRow({ file, selectedPath, onSelect }: {
  file: WorkspaceFileReadModel;
  selectedPath?: string;
  onSelect: (path: string) => void;
}) {
  const name = file.path.split("/").at(-1) ?? file.path;
  return <button type="button" className={selectedPath === file.path ? "is-active" : ""} onClick={() => onSelect(file.path)}>
    <IconFile size={14} />
    <span title={file.path}>{name}</span>
    {file.status && <small className={`is-${file.status}`}>{file.status[0].toUpperCase()}</small>}
    {file.binary ? <em>binary</em> : file.status && <em><ins>+{file.additions ?? 0}</ins><del>-{file.deletions ?? 0}</del></em>}
  </button>;
}

function FileContent({ value, view }: { value?: WorkspaceFileContent | WorkspaceFileDiff; view: FileView }) {
  if (!value) return <div className="files-empty large">Loading…</div>;
  if (value.state !== "available" && !value.text) {
    return <div className="files-empty large">{value.state === "deleted" ? "File deleted" : value.state === "binary" ? "Binary file" : "File is too large to display"}</div>;
  }
  const lines = (value.text ?? "").split("\n");
  const highlighted = DOMPurify.sanitize(highlightSource(value.text ?? "", value.path, view === "diff"));
  return <pre className={`file-code${view === "diff" ? " is-diff" : ""}`}>
    <span className="file-line-numbers" aria-hidden="true">{lines.map((_, index) => <i key={index}>{index + 1}</i>)}</span>
    <code dangerouslySetInnerHTML={{ __html: highlighted }} />
    {value.truncated && <small>Output truncated</small>}
  </pre>;
}
