import { useRef, useState } from "react";
import { ActionDialog } from "./action-dialog";
import { runtimeStore } from "./runtime/event-store";
import { validWorkspacePath, type WorkspaceEntry, type WorkspaceMutation } from "../shared/workspace-mutations";
import { workspaceDrafts } from "../shared/workspace-edit-state";

export type WorkspaceTreeAction = "createFile" | "createDirectory" | "rename" | "move" | "delete";
export interface WorkspaceActionRequest {
  action: WorkspaceTreeAction;
  path: string;
  directory: boolean;
  entry?: WorkspaceEntry;
  sessionId: string;
  generation: number;
}

export function WorkspaceFileActions({ request, onClose, onMutation }: {
  request: WorkspaceActionRequest;
  onClose: () => void;
  onMutation: (mutation: WorkspaceMutation, sessionId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState("");
  const { action, path, sessionId, generation } = request;
  const create = action === "createFile" || action === "createDirectory";
  const title = { createFile: "New file", createDirectory: "New folder", rename: "Rename", move: "Move", delete: "Delete" }[action];
  const perform = async (value: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      if (!create && workspaceDrafts.dirty(sessionId, path)) throw new Error("Save or discard affected drafts first.");
      const name = value.trim();
      if (action !== "delete" && (!validWorkspacePath(name) || (action !== "move" && name.includes("/"))))
        throw new Error(action === "move" ? "Enter a valid workspace-relative destination path." : "Enter a single valid file or folder name.");
      const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const at = (folder: string, name: string) => folder ? `${folder}/${name}` : name;
      const expectedVersion = request.entry?.version ?? "";
      const mutation: WorkspaceMutation = create
        ? { action, path: at(path, name) }
        : action === "delete" ? { action, path, expectedVersion, confirmed: true }
        : { action: "move", path, expectedVersion, destination: action === "rename" ? at(parent, name) : name };
      if (mutation.action === "move" && workspaceDrafts.dirty(sessionId, mutation.destination))
        throw new Error("Save or discard destination drafts first.");
      await runtimeStore.mutateWorkspace(mutation, sessionId, generation);
      onMutation(mutation, sessionId);
      onClose();
    } catch (error) { setError((error as Error).message); }
    finally { lock.current = false; setBusy(false); }
  };
  const description = action === "delete"
    ? `Permanently delete ${path}${request.directory ? ` and its contents (${request.entry?.entries ?? 0} entries)` : ""}? This does not use the Recycle Bin. Untracked files may be unrecoverable.`
    : create ? `Create in ${path || "workspace root"}. Parent folders must already exist.`
    : `Change ${path} in this session's workspace. Existing destinations are never intentionally replaced. Keep external writers idle.`;
  return <ActionDialog title={title} description={description} error={error}
    confirmLabel={title} busyLabel="Applying…" busy={busy} danger={action === "delete"}
    inputLabel={action === "delete" ? undefined : action === "move" ? "New workspace-relative path" : "Name"}
    initialValue={action === "rename" ? path.split("/").at(-1) : action === "move" ? path : ""}
    maxLength={500} onCancel={onClose} onConfirm={value => void perform(value)} />;
}
