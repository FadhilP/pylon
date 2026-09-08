import { useMemo, useRef, useState } from "react";
import { ActionDialog } from "../ui/action-dialog";
import { runtimeStore } from "../runtime/event-store";
import { validWorkspacePath, type WorkspaceEntry, type WorkspaceMutation } from "../../shared/workspace/workspace-mutations";
import { workspaceDrafts } from "./workspace-edit-state";
import type { WorkspaceFileReadModel } from "../../shared/protocol/snapshots";
import { moveDestination, moveFolderSuggestions, planFolderMove, workspaceMoveInventory } from "./workspace-move";
import type { MovePlan } from "./workspace-move-history";

export type WorkspaceDialogAction = "createFile" | "createDirectory" | "rename" | "move" | "delete";
export type WorkspaceTreeAction = WorkspaceDialogAction | "copy" | "cut" | "paste" | "copyRelativePath" | "copyFullPath";
export interface WorkspaceActionRequest {
  action: WorkspaceDialogAction;
  path: string;
  directory: boolean;
  entry?: WorkspaceEntry;
  entries?: WorkspaceEntry[];
  sessionId: string;
  generation: number;
}

export function WorkspaceFileActions({ request, files, onClose, onMutation, onMove }: {
  request: WorkspaceActionRequest;
  files: WorkspaceFileReadModel[];
  onClose: () => void;
  onMutation: (mutation: WorkspaceMutation, sessionId: string) => void;
  onMove: (plans: MovePlan[], sessionId: string, generation: number) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const { action, path, sessionId, generation } = request;
  const create = action === "createFile" || action === "createDirectory";
  const title = { createFile: "New file", createDirectory: "New folder", rename: "Rename", move: "Move", delete: "Delete" }[action];
  const inventory = useMemo(() => workspaceMoveInventory(files), [files]);
  const folderValue = (value: string) => value === "/" ? "" : value.replace(/\/$/, "");
  const paths = request.entries?.map(entry => entry.path) ?? [path];
  const suggestions = useMemo(() => {
    const candidates = paths.map(source => new Set(moveFolderSuggestions(source, inventory)));
    return [...(candidates[0] ?? [])].filter(folder => candidates.every(folders => folders.has(folder)))
      .map(folder => ({ value: folder || "/", label: folder || "Workspace root" }));
  }, [request, inventory]);
  const validateFolder = (value: string) => {
    try { planFolderMove(paths, folderValue(value), inventory); return undefined; }
    catch (error) { return (error as Error).message; }
  };
  const perform = async (value: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      if (!create && workspaceDrafts.dirty(sessionId, path)) throw new Error("Save or discard affected drafts first.");
      const name = value.trim();
      if (action === "move") {
        const plans = planFolderMove(paths, folderValue(value), inventory).map(plan => ({ ...plan,
          expectedVersion: (request.entries?.find(entry => entry.path === plan.path) ?? request.entry)?.version,
        }));
        await onMove(plans, sessionId, generation);
        onClose(); return;
      } else if (action !== "delete" && (!validWorkspacePath(name) || name.includes("/")))
        throw new Error("Enter a single valid file or folder name.");
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const at = (folder: string, name: string) => folder ? `${folder}/${name}` : name;
      const expectedVersion = request.entry?.version ?? "";
      const mutation: WorkspaceMutation = create
        ? { action, path: at(path, name) }
        : action === "delete" ? { action, path, expectedVersion, confirmed: true }
        : { action: "move", path, expectedVersion, destination: at(parent, name) };
      if (mutation.action === "move") {
        await onMove([mutation], sessionId, generation);
      } else {
        await runtimeStore.mutateWorkspace(mutation, sessionId, generation);
        onMutation(mutation, sessionId);
      }
      onClose();
    } catch (error) { setError((error as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  const description = action === "delete"
    ? `Permanently delete ${path}${request.directory ? ` and its contents (${request.entry?.entries ?? 0} entries)` : ""}? This does not use the Recycle Bin. Untracked files may be unrecoverable.`
    : create ? `Create in ${path || "workspace root"}. Parent folders must already exist.`
    : `Change ${paths.length > 1 ? `${paths.length} selected entries` : path} in this session's workspace. Existing destinations are never intentionally replaced. Keep external writers idle.`;
  return <ActionDialog title={title} description={description} error={error}
    confirmLabel={title} busyLabel="Applying…" busy={busy} danger={action === "delete"}
    inputLabel={action === "delete" ? undefined : action === "move" ? "Destination folder (/ for workspace root)" : "Name"}
    initialValue={action === "rename" ? path.split("/").at(-1) : ""}
    suggestions={action === "move" ? suggestions : undefined}
    validateInput={action === "move" ? validateFolder : undefined}
    inputHint={action === "move" ? value => <>
      {value && paths.slice(0, 5).map(source => <p key={source}>New path: <code>{moveDestination(source, folderValue(value))}</code></p>)}
      {paths.length > 5 && <p>…and {paths.length - 5} more entries.</p>}
      <small>Choose an existing folder or type its workspace-relative path. The name stays unchanged; use Rename to change it.</small>
    </> : undefined}
    maxLength={500} onCancel={onClose} onConfirm={value => void perform(value)} />;
}
