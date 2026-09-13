import { useEffect, useRef } from "react";
import { latestProjectDraft, readComposerDrafts, writeComposerDrafts, type ComposerDraft } from "./composer-drafts";
import type { SessionSummary } from "../../shared/protocol/snapshots";
import { runtimeStore } from "../runtime/event-store";
import { ApiHttpError } from "../runtime/api-client";
import { isComposerWebStateEvent } from "../../shared/settings/web-state";

function initialComposerDrafts(): Map<string, ComposerDraft> {
  try {
    return readComposerDrafts(localStorage);
  } catch {
    return new Map();
  }
}

/** Ref-backed drafts avoid application-wide renders while typing. Dirty authored
 * text remains in browser recovery storage until the host acknowledges it. */
export function useComposerDrafts() {
  const drafts = useRef(initialComposerDrafts());
  const projects = useRef(
    new Map(
      [...drafts.current.values()]
        .filter(draft => Boolean(draft.projectId))
        .map(draft => [draft.sessionId, draft.projectId]),
    ),
  );
  const revisions = useRef(new Map<string, number>());
  const changes = useRef(new Map<string, number>());
  const dirty = useRef(new Set<string>());
  const blocked = useRef(new Set<string>());
  const writing = useRef(new Set<string>());
  const timers = useRef(new Map<string, number>());
  const loadedProjects = useRef(new Set<string>());

  const persistRecovery = () => {
    const recovery = new Map(
      [...drafts.current].filter(([id]) => dirty.current.has(id) || !projects.current.has(id)),
    );
    try {
      writeComposerDrafts(localStorage, recovery);
    } catch {
      runtimeStore.reportError("Draft recovery storage is unavailable; keep this tab open until the draft is saved.");
    }
  };

  const receive = (value: unknown) => {
    if (!isComposerWebStateEvent(value) || dirty.current.has(value.sessionId)) return;
    const currentRevision = revisions.current.get(value.sessionId) ?? -1;
    if (!value.draft) {
      revisions.current.delete(value.sessionId);
      drafts.current.delete(value.sessionId);
      return;
    }
    if (value.draft.revision <= currentRevision) return;
    revisions.current.set(value.sessionId, value.draft.revision);
    drafts.current.set(value.sessionId, value.draft);
    projects.current.set(value.sessionId, value.draft.projectId);
  };
  useEffect(() => runtimeStore.subscribeWebState("composer", receive), []);

  const schedule = (sessionId: string) => {
    if (blocked.current.has(sessionId)) return;
    const old = timers.current.get(sessionId);
    if (old !== undefined) window.clearTimeout(old);
    timers.current.set(
      sessionId,
      window.setTimeout(() => {
        timers.current.delete(sessionId);
        void flush(sessionId);
      }, 400),
    );
  };

  const flush = async (sessionId: string) => {
    const projectId = projects.current.get(sessionId);
    if (!projectId || writing.current.has(sessionId) || blocked.current.has(sessionId)) return;
    const change = changes.current.get(sessionId) ?? 0;
    const text = drafts.current.get(sessionId)?.text ?? "";
    writing.current.add(sessionId);
    try {
      const response = await runtimeStore.saveComposerDraft(revisions.current.get(sessionId) ?? null, {
        sessionId,
        projectId,
        text,
      });
      if (response.draft) revisions.current.set(sessionId, response.draft.revision);
      else revisions.current.delete(sessionId);
      if ((changes.current.get(sessionId) ?? 0) === change) {
        dirty.current.delete(sessionId);
        persistRecovery();
      } else {
        schedule(sessionId);
      }
    } catch (error) {
      if (error instanceof ApiHttpError && error.status === 409) {
        const response = await runtimeStore.composerDraft(sessionId).catch(() => undefined);
        if (response?.draft) revisions.current.set(sessionId, response.draft.revision);
        else revisions.current.delete(sessionId);
      }
      blocked.current.add(sessionId);
      persistRecovery();
      runtimeStore.reportError(
        error instanceof ApiHttpError && error.status === 409
          ? "This draft changed in another browser. Your local text was preserved; edit again to retry against the latest version."
          : "Draft could not be saved. Your text remains in browser recovery storage.",
      );
    } finally {
      writing.current.delete(sessionId);
    }
  };

  const save = (sessionId: string, projectId: string | undefined, text: string) => {
    const resolved = projectId ?? projects.current.get(sessionId) ?? drafts.current.get(sessionId)?.projectId ?? "";
    if (resolved) projects.current.set(sessionId, resolved);
    if (text) drafts.current.set(sessionId, { sessionId, projectId: resolved, text, updatedAt: Date.now() });
    else drafts.current.delete(sessionId);
    changes.current.set(sessionId, (changes.current.get(sessionId) ?? 0) + 1);
    dirty.current.add(sessionId);
    blocked.current.delete(sessionId);
    persistRecovery();
    if (resolved) schedule(sessionId);
  };

  const loadProject = (projectId: string) => {
    if (loadedProjects.current.has(projectId)) return;
    loadedProjects.current.add(projectId);
    void runtimeStore
      .composerDrafts(projectId)
      .then(response => {
        for (const draft of response.drafts) receive({ sessionId: draft.sessionId, draft });
      })
      .catch(() => loadedProjects.current.delete(projectId));
  };

  const adopt = (sessionId: string, projectId: string, text: string, recoveredSessionId?: string) => {
    if (recoveredSessionId && recoveredSessionId !== sessionId) {
      const recoveredProject = projects.current.get(recoveredSessionId);
      if (recoveredProject) save(recoveredSessionId, recoveredProject, "");
      else drafts.current.delete(recoveredSessionId);
    }
    projects.current.set(sessionId, projectId);
    if (text) save(sessionId, projectId, text);
    persistRecovery();
  };

  const rememberProject = (session: SessionSummary): boolean => {
    projects.current.set(session.id, session.projectId);
    loadProject(session.projectId);
    const draft = drafts.current.get(session.id);
    if (!draft || draft.projectId === session.projectId) return false;
    drafts.current.set(session.id, { ...draft, projectId: session.projectId });
    changes.current.set(session.id, (changes.current.get(session.id) ?? 0) + 1);
    dirty.current.add(session.id);
    persistRecovery();
    schedule(session.id);
    return true;
  };

  const forget = (sessionId: string) => {
    const timer = timers.current.get(sessionId);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(sessionId);
    drafts.current.delete(sessionId);
    projects.current.delete(sessionId);
    revisions.current.delete(sessionId);
    changes.current.delete(sessionId);
    dirty.current.delete(sessionId);
    blocked.current.delete(sessionId);
  };
  const dropProject = (projectId: string) => {
    for (const [sessionId, draft] of drafts.current) if (draft.projectId === projectId) forget(sessionId);
    persistRecovery();
  };

  return {
    textFor: (id: string) => drafts.current.get(id)?.text,
    latestForProject: (id: string) => latestProjectDraft(drafts.current, id),
    save,
    adopt,
    rememberProject,
    dropSession: (id: string) => {
      forget(id);
      persistRecovery();
    },
    dropProject,
    persist: persistRecovery,
    /** Archive retains the host copy and any already-written browser recovery copy. */
    forgetInMemory: forget,
  };
}
