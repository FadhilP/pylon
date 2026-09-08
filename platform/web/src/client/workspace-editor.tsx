import { useState, useSyncExternalStore, type ReactNode } from "react";
import { workspaceDrafts } from "../shared/workspace-edit-state";
import { runtimeStore } from "./runtime/event-store";
import { MAX_EDIT_BYTES } from "../shared/workspace-mutations";
import "./workspace-editor.css";

// This listener has page lifetime, like the in-memory drafts, including while Files is unmounted.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", event => {
    if (!workspaceDrafts.dirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

export function WorkspaceEditor({ sessionId, generation, path, disabled, children }: {
  sessionId: string; generation: number; path: string; disabled: boolean; children: ReactNode;
}) {
  useSyncExternalStore(workspaceDrafts.subscribe, workspaceDrafts.snapshot);
  const draft = workspaceDrafts.get(sessionId, path);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = busy || Boolean(draft?.saving);
  const edit = async () => {
    setBusy(true); setError("");
    try { workspaceDrafts.open(await runtimeStore.workspaceEntry(path, sessionId, generation)); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    if (!draft || busy || disabled || workspaceDrafts.get(sessionId, path)?.saving) return;
    workspaceDrafts.saving(sessionId, path, true);
    setBusy(true); setError("");
    try {
      await runtimeStore.mutateWorkspace({ action: "save", path, expectedVersion: draft.version, text: draft.text }, sessionId, generation);
      workspaceDrafts.saving(sessionId, path, false);
      workspaceDrafts.remove(sessionId, path);
    } catch (error) { setError((error as Error).message); }
    finally { workspaceDrafts.saving(sessionId, path, false); setBusy(false); }
  };
  const discard = () => {
    if (workspaceDrafts.get(sessionId, path)?.saving) return;
    if (draft && draft.text !== draft.original && !window.confirm(`Discard unsaved edits to ${path}?`)) return;
    workspaceDrafts.remove(sessionId, path); setError("");
  };
  return <div className="workspace-text-editor">
    <div className="workspace-edit-toolbar">
      {draft ? <>
        <button className="primary-button" disabled={disabled || pending || draft.text === draft.original} onClick={() => void save()}>Save</button>
        <button className="secondary-button" disabled={pending} onClick={discard}>{draft.text === draft.original ? "Close editor" : "Discard"}</button>
        <small>{pending ? "Saving…" : draft.text !== draft.original ? "Unsaved · Ctrl/Cmd+S" : "No unsaved changes"}</small>
      </> : <button className="secondary-button" disabled={disabled || busy} onClick={() => void edit()}>{busy ? "Opening…" : "Edit file"}</button>}
      {disabled && <small>Connect to an idle session to save changes.</small>}
    </div>
    {error && <p className="workspace-edit-error" role="alert">{error}</p>}
    {draft ? <textarea className="workspace-text-input" aria-label={`Edit ${path}`} value={draft.text}
      readOnly={pending} spellCheck={false} autoCapitalize="off" autoCorrect="off" wrap="off" maxLength={MAX_EDIT_BYTES}
      onChange={event => workspaceDrafts.change(sessionId, path, event.target.value)}
      onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && !event.nativeEvent.isComposing) {
          event.preventDefault(); void save();
        }
      }} /> : children}
  </div>;
}
