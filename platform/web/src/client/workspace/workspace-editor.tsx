import { IconDeviceFloppy, IconArrowBackUp } from "@tabler/icons-react";
import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { workspaceDrafts } from "./workspace-edit-state";
import { runtimeStore } from "../runtime/event-store";
import { MAX_EDIT_BYTES } from "../../shared/workspace/workspace-mutations";
import type { WorkspaceFileContent } from "../../shared/protocol/snapshots";
import "./workspace-editor.css";

const WorkspaceCodeEditor = lazy(() => import("./workspace-code-editor"));

// This listener has page lifetime, like the in-memory drafts, including while Files is unmounted.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", event => {
    if (!workspaceDrafts.dirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

export function WorkspaceEditor({ sessionId, generation, path, revision, ready, disabled, targetLine, children }: {
  sessionId: string; generation: number; path: string; revision: string; ready: boolean;
  disabled: boolean; targetLine?: number; children: (value?: WorkspaceFileContent) => ReactNode;
}) {
  const subscribe = useCallback((listener: () => void) => workspaceDrafts.subscribeFile(sessionId, path, listener), [sessionId, path]);
  const draft = useSyncExternalStore(subscribe, () => workspaceDrafts.get(sessionId, path));
  const moveLocked = useSyncExternalStore(subscribe, () => workspaceDrafts.locked(sessionId, path));
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [readOnlyReason, setReadOnlyReason] = useState("");
  const [reload, setReload] = useState(0);
  const [fallback, setFallback] = useState<WorkspaceFileContent>();
  const comparisonKey = JSON.stringify([sessionId, generation, path, revision]);
  const [gitIndex, setGitIndex] = useState<{ key: string; text?: string }>();
  const pending = loading || busy || Boolean(draft?.saving) || moveLocked;
  const dirty = Boolean(draft && draft.text !== draft.original);

  useEffect(() => {
    if (!ready || moveLocked) { setLoading(false); return; }
    let active = true;
    let inFlight = false;
    let indexInFlight = false;
    const loadIndex = async () => {
      if (indexInFlight) return;
      indexInFlight = true;
      try {
        const index = await runtimeStore.workspaceGitIndex(path, sessionId, generation);
        if (active) setGitIndex({ key: comparisonKey, text: index.text });
      } catch { if (active) setGitIndex(undefined); }
      finally { indexInFlight = false; }
    };
    const loadFallback = async () => {
      // Unsupported/live inspection retains the existing read-only viewer and confinement rules.
      try {
        const value = await runtimeStore.workspaceFile(path, "current");
        if (active) setFallback(value);
      } catch (error) { if (active) setError((error as Error).message); }
    };
    const load = async (background = false) => {
      const before = workspaceDrafts.get(sessionId, path);
      if (inFlight || before?.saving) return;
      inFlight = true;
      if (!background) { setError(""); setReadOnlyReason(""); setLoading(!before); }
      try {
        // Editable bytes are independent of optional index comparison and repository snapshots.
        const entry = await runtimeStore.workspaceEntry(path, sessionId, generation, undefined, false);
        if (!active) return;
        if (entry.text === undefined) {
          if (workspaceDrafts.get(sessionId, path) === before && !workspaceDrafts.dirty(sessionId, path)) workspaceDrafts.remove(sessionId, path);
          setReadOnlyReason(entry.readOnlyReason ?? "This file is read-only.");
          if (!workspaceDrafts.get(sessionId, path)) void loadFallback();
        } else {
          // A save/keystroke since this request began makes its entry an obsolete observation.
          if (workspaceDrafts.get(sessionId, path) === before) workspaceDrafts.open(entry, true);
          setReadOnlyReason("");
          void loadIndex();
        }
      } catch (error) {
        if (active && !background) {
          setError((error as Error).message);
          if (!workspaceDrafts.get(sessionId, path)) void loadFallback();
        }
      } finally { inFlight = false; if (active) setLoading(false); }
    };
    setFallback(undefined);
    void load();
    const refresh = () => { if (!document.hidden) void load(true); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [sessionId, generation, path, revision, ready, reload, moveLocked]);

  const save = async () => {
    const submitted = workspaceDrafts.get(sessionId, path);
    if (!submitted || submitted.text === submitted.original || submitted.saving || pending || disabled || workspaceDrafts.locked(sessionId, path)) return;
    workspaceDrafts.saving(sessionId, path, true);
    setBusy(true); setError("");
    try {
      const receipt = await runtimeStore.mutateWorkspace({ action: "save", path, expectedVersion: submitted.version, text: submitted.text }, sessionId, generation);
      if (receipt.sessionGeneration !== generation || !receipt.savedVersion || !/^[a-f0-9]{64}$/.test(receipt.savedVersion))
        throw new Error("The save was not confirmed. Your draft is retained; inspect the working copy before retrying.");
      workspaceDrafts.acceptSave(sessionId, path, receipt.savedVersion, submitted);
    } catch (error) { setError((error as Error).message); }
    finally { workspaceDrafts.saving(sessionId, path, false); setBusy(false); }
  };
  const discard = () => {
    if (pending || !dirty || !window.confirm(`Discard unsaved edits to ${path}?`)) return;
    workspaceDrafts.remove(sessionId, path);
    setError(""); setReload(value => value + 1);
  };
  const renderToolbar = (noteActions?: ReactNode) => (
    <div className="workspace-edit-toolbar">
      <div className="workspace-edit-actions">
        <button className="primary-button" disabled={!draft || disabled || pending || !dirty} title="Save (Ctrl/Cmd+S)" onClick={() => void save()}>
          <IconDeviceFloppy size={14} />Save
        </button>
        <button className="secondary-button" disabled={pending || !dirty} onClick={discard}>
          <IconArrowBackUp size={14} />Discard
        </button>
      </div>
      <span className="workspace-edit-status" role="status">
        {busy || draft?.saving ? "Saving…" : loading ? "Loading working copy…" : dirty ? "Unsaved changes" : draft ? "Saved" : "Read-only"}
      </span>
      {disabled && draft && <span className="workspace-edit-hint">Connect to a ready session to save</span>}
      {noteActions}
    </div>
  );
  return <div className="workspace-text-editor">
    {!draft && renderToolbar()}
    {readOnlyReason && <p className="workspace-edit-hint workspace-edit-notice">{readOnlyReason}</p>}
    {error && <div className="workspace-edit-error" role="alert"><span>{error}</span>
      {!dirty && <button className="secondary-button" disabled={!ready || pending} onClick={() => setReload(value => value + 1)}>Retry</button>}
    </div>}
    {draft ? <Suspense fallback={<div className="files-empty large">Rendering…</div>}>
      <WorkspaceCodeEditor path={path} text={draft.text} revision={draft.version} targetLine={targetLine}
        renderToolbar={renderToolbar}
        editing={{ readOnly: pending, maxLength: MAX_EDIT_BYTES,
          gitIndexText: ready && gitIndex?.key === comparisonKey ? gitIndex.text : undefined,
          onChange: text => workspaceDrafts.change(sessionId, path, text), onSave: () => void save() }} />
    </Suspense> : children(fallback)}
  </div>;
}
