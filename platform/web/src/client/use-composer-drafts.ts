import { useRef } from "react";
import {
  latestProjectDraft,
  readComposerDrafts,
  writeComposerDrafts,
  type ComposerDraft,
} from "../shared/composer-drafts";
import type { SessionSummary } from "../shared/protocol/snapshots";

function initialComposerDrafts(): Map<string, ComposerDraft> {
  try {
    return readComposerDrafts(localStorage);
  } catch {
    return new Map();
  }
}

/**
 * Unsent composer text, kept per session and mirrored to localStorage.
 *
 * Drafts live in refs rather than state: typing must not re-render the whole app,
 * and every reader already re-renders for its own reasons.
 *
 * A second map remembers each session's project so a draft written before the
 * session's project is known can still be filed correctly later.
 */
export function useComposerDrafts() {
  const drafts = useRef(initialComposerDrafts());
  const projects = useRef(
    new Map(
      [...drafts.current.values()].map((draft) => [
        draft.sessionId,
        draft.projectId,
      ]),
    ),
  );

  const persist = () => {
    try {
      writeComposerDrafts(localStorage, drafts.current);
    } catch {
      /* Drafts still survive for the current page when storage is unavailable or full. */
    }
  };

  const save = (
    sessionId: string,
    projectId: string | undefined,
    text: string,
  ) => {
    const resolved =
      projectId ??
      projects.current.get(sessionId) ??
      drafts.current.get(sessionId)?.projectId ??
      "";
    if (text) {
      if (resolved) projects.current.set(sessionId, resolved);
      drafts.current.set(sessionId, {
        sessionId,
        projectId: resolved,
        text,
        updatedAt: Date.now(),
      });
    } else {
      drafts.current.delete(sessionId);
    }
    persist();
  };

  /**
   * Moves a draft written against a pending session onto the session the runtime
   * actually created, dropping the placeholder it was recovered from.
   */
  const adopt = (
    sessionId: string,
    projectId: string,
    text: string,
    recoveredSessionId?: string,
  ) => {
    projects.current.set(sessionId, projectId);
    if (recoveredSessionId) drafts.current.delete(recoveredSessionId);
    if (text)
      drafts.current.set(sessionId, {
        sessionId,
        projectId,
        text,
        updatedAt: Date.now(),
      });
    persist();
  };

  /** Files a session's draft under its current project. Returns whether anything moved. */
  const rememberProject = (session: SessionSummary): boolean => {
    projects.current.set(session.id, session.projectId);
    const draft = drafts.current.get(session.id);
    if (!draft || draft.projectId === session.projectId) return false;
    drafts.current.set(session.id, { ...draft, projectId: session.projectId });
    return true;
  };

  const dropSession = (sessionId: string) => {
    drafts.current.delete(sessionId);
    projects.current.delete(sessionId);
    persist();
  };

  const dropProject = (projectId: string) => {
    for (const [sessionId, draft] of drafts.current) {
      if (draft.projectId !== projectId) continue;
      drafts.current.delete(sessionId);
      projects.current.delete(sessionId);
    }
    persist();
  };

  return {
    textFor: (sessionId: string) => drafts.current.get(sessionId)?.text,
    latestForProject: (projectId: string) =>
      latestProjectDraft(drafts.current, projectId),
    save,
    adopt,
    rememberProject,
    dropSession,
    dropProject,
    persist,
    /** Archiving hides a session without deleting it, so the stored copy is left alone. */
    forgetInMemory: (sessionId: string) => {
      drafts.current.delete(sessionId);
    },
  };
}
