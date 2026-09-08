import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { GitActionInput, GitDetail, GitDetailQuery, GitState } from "../../shared/workspace/git";
import { runtimeStore, type RuntimeStoreSnapshot } from "../runtime/event-store";
import { workspaceDrafts } from "./workspace-edit-state";
import type { ConflictChoice } from "./git-review-model";

export interface GitConfirmation {
  title: string;
  description: string;
  label: string;
  danger?: boolean;
  inputLabel?: string;
  initialValue?: string;
  allowEmpty?: boolean;
  action: (value: string) => GitActionInput;
}

/** One controller owns both surfaces; confirmations retain the revision the user reviewed. */
export function useGitWorkspace(live: RuntimeStoreSnapshot, enabled: boolean) {
  const sessionId = live.runtime?.sessionId ?? "";
  const generation = live.runtime?.sessionGeneration ?? 0;
  const identity = `${sessionId}:${generation}`;
  const current = useRef(identity);
  current.current = identity;
  const [state, setState] = useState<GitState>();
  const latest = useRef<GitState>(undefined);
  const [selection, setSelection] = useState<GitDetailQuery>();
  const [detail, setDetail] = useState<GitDetail>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const statusEpoch = useRef(0);
  const [conflictChoices, setConflictChoices] = useState<Record<string, Record<number, ConflictChoice>>>({});
  const [reload, setReload] = useState(0);
  const [detailReload, setDetailReload] = useState(0);
  const [confirmation, setConfirmation] = useState<GitConfirmation>();
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  useSyncExternalStore(workspaceDrafts.subscribe, workspaceDrafts.snapshot);
  const dirty = workspaceDrafts.dirty(sessionId);
  const ready = enabled && !!sessionId && live.connection === "connected" && !!live.runtime?.ready;
  const workspaceRevision = `${live.runtime?.workspace?.revision ?? ""}:${live.runtime?.workspace?.fileRevision ?? 0}`;
  const refresh = useCallback(() => setReload(value => value + 1), []);
  const select = useCallback((query?: GitDetailQuery) => {
    setSelection(query);
    setDetail(undefined);
    setDetailReload(value => value + 1);
  }, []);
  const selectPath = useCallback((path: string) => {
    setSelection(previous =>
      previous && (previous.kind === "commit" || previous.kind === "range" || previous.kind === "stash")
        ? { ...previous, path }
        : previous,
    );
  }, []);

  useEffect(() => {
    latest.current = undefined;
    setState(undefined);
    setSelection(undefined);
    setDetail(undefined);
    setError(undefined);
    setResult(undefined);
    setConfirmation(undefined);
    setMessage("");
    setAmend(false);
    setBusy(false);
    setConflictChoices({});
  }, [identity]);

  useEffect(() => {
    if (!ready || lock.current) return;
    const abort = new AbortController();
    const epoch = ++statusEpoch.current;
    void runtimeStore
      .workspaceGitState(abort.signal)
      .then(next => {
        if (abort.signal.aborted || current.current !== identity || epoch !== statusEpoch.current) return;
        latest.current = next;
        setState(next);
      })
      .catch(reason => {
        if (!abort.signal.aborted && current.current === identity && epoch === statusEpoch.current)
          setError(String(reason.message ?? reason));
      });
    return () => abort.abort();
  }, [ready, identity, workspaceRevision, reload]);

  const selectionKey = JSON.stringify(selection);
  // Conflict snapshots are deliberately frozen until explicit reload. A refreshed status must
  // never silently discard choices or lend them a newer revision for a different operation.
  const detailRevision =
    selection?.kind === "conflict"
      ? "conflict"
      : selection?.kind === "file"
        ? state?.revision
        : JSON.stringify([state?.branches, state?.stashes]);
  const historicalReload = selection?.kind === "file" || selection?.kind === "conflict" ? 0 : reload;
  useEffect(() => {
    if (!ready || !selection) return;
    const abort = new AbortController();
    void runtimeStore
      .workspaceGitDetail(selection, abort.signal)
      .then(next => {
        if (!abort.signal.aborted && current.current === identity) setDetail(next);
      })
      .catch(reason => {
        if (!abort.signal.aborted && current.current === identity) setError(String(reason.message ?? reason));
      });
    return () => abort.abort();
  }, [ready, identity, selectionKey, detailRevision, detailReload, historicalReload]);

  useEffect(() => {
    if (!ready) return;
    const update = () => {
      if (!document.hidden) refresh();
    };
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [ready, refresh]);

  const action = useCallback(
    async (input: GitActionInput): Promise<boolean> => {
      if (!ready || lock.current) return false;
      if (workspaceDrafts.dirty(sessionId)) {
        setError(
          "Save or discard this session’s unsaved drafts before changing Git state. Git acts on saved files, not editor buffers.",
        );
        return false;
      }
      lock.current = true;
      statusEpoch.current++;
      setBusy(true);
      setError(undefined);
      setResult(undefined);
      let succeeded = false;
      try {
        await runtimeStore.gitAction(input, sessionId, generation);
        succeeded = true;
        if (current.current === identity)
          setResult(`${input.action === "resolve" ? "File saved and staged" : "Git action completed"}.`);
      } catch (reason) {
        if (current.current === identity) setError((reason as Error).message);
      } finally {
        try {
          if (current.current === identity) {
            const next = await runtimeStore.workspaceGitState();
            if (current.current === identity) {
              latest.current = next;
              setState(next);
            }
          }
        } catch (reason) {
          if (current.current === identity)
            setError(previous => `${previous ? `${previous} ` : ""}Refresh failed: ${(reason as Error).message}`);
        }
        lock.current = false;
        if (current.current === identity) {
          setBusy(false);
        }
      }
      return succeeded && current.current === identity;
    },
    [ready, sessionId, generation, identity],
  );

  const confirm = async (value: string) => {
    if (!confirmation) return;
    const input = confirmation.action(value);
    if (await action(input)) {
      setConfirmation(undefined);
      if (input.action === "commit") {
        setMessage("");
        setAmend(false);
      }
    }
  };
  const commit = async (push = false) => {
    const before = latest.current;
    if (!before?.revision || !message.trim()) return;
    const input: GitActionInput = {
      action: "commit",
      expectedRevision: before.revision,
      message,
      amend,
      ...(amend ? { confirmed: true } : {}),
    };
    if (amend) {
      setConfirmation({
        title: "Amend the last commit?",
        description: `Rewrite ${before.head ?? "HEAD"} using the staged index and this message. Published history may be affected.`,
        label: "Amend commit",
        danger: true,
        action: () => input,
      });
      return;
    }
    if (!(await action(input))) return;
    setMessage("");
    const after = latest.current;
    if (push && after?.revision)
      setConfirmation({
        title: "Push committed work?",
        description: `Push ${after.branch} to ${after.upstream ?? "its configured upstream"}. A failed push does not undo the commit.`,
        label: "Push",
        action: () => ({ action: "push", expectedRevision: after.revision!, confirmed: true }),
      });
  };
  return {
    state,
    selection,
    detail,
    error,
    result,
    busy,
    ready,
    dirty,
    refresh,
    select,
    selectPath,
    action,
    confirmation,
    ask: setConfirmation,
    confirm,
    message,
    setMessage,
    amend,
    setAmend,
    commit,
    conflictChoices,
    setConflictChoices,
  };
}
export type GitWorkspaceController = ReturnType<typeof useGitWorkspace>;
