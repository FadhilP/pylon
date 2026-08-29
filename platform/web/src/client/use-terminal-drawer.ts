import { useEffect, useState } from "react";
import { runtimeStore, type RuntimeStoreSnapshot } from "./runtime/event-store";

export type RetainedTerminal = {
  sessionId: string;
  generation: number;
  cwdLabel?: string;
};

const MAX_RETAINED_TERMINALS = 8;

/**
 * The terminal drawer: which session's terminal is showing, and the terminals
 * kept mounted behind it so switching sessions does not lose scrollback.
 *
 * A terminal is dropped when its session sleeps or is no longer selected, since
 * its PTY is gone by then.
 */
export function useTerminalDrawer(
  live: RuntimeStoreSnapshot,
  initialHeight: () => number,
) {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalSessionId, setTerminalSessionId] = useState<string>();
  const [retainedTerminals, setRetainedTerminals] = useState<
    RetainedTerminal[]
  >([]);
  const [terminalDrawerHeight, setTerminalDrawerHeight] =
    useState(initialHeight);

  const close = () => {
    setTerminalOpen(false);
    setTerminalSessionId(undefined);
  };

  // The drawer only ever shows the selected session's terminal.
  const selectedSessionId = live.runtime?.sessionId;
  useEffect(() => {
    if (!terminalSessionId || terminalSessionId === selectedSessionId) return;
    close();
  }, [selectedSessionId, terminalSessionId]);

  useEffect(() => {
    const sleeping = new Set(
      Object.entries(live.sessionStatuses ?? {})
        .filter(([, state]) => state === "sleeping")
        .map(([sessionId]) => sessionId),
    );
    if (!sleeping.size) return;
    setRetainedTerminals((current) =>
      current.filter((terminal) => !sleeping.has(terminal.sessionId)),
    );
    if (terminalSessionId && sleeping.has(terminalSessionId)) close();
  }, [live.sessionStatuses, terminalSessionId]);

  const toggleTerminal = () => {
    if (terminalOpen) {
      setTerminalOpen(false);
      return;
    }
    if (!live.runtime?.ready) return;
    const terminal: RetainedTerminal = {
      sessionId: live.runtime.sessionId,
      generation: live.runtime.sessionGeneration,
      cwdLabel: live.runtime.cwdLabel,
    };
    setRetainedTerminals((current) => {
      // Reuse the existing entry so an already-attached terminal keeps its PTY.
      const existing = current.find(
        (item) => item.sessionId === terminal.sessionId,
      );
      return [
        ...current.filter((item) => item.sessionId !== terminal.sessionId),
        existing ?? terminal,
      ].slice(-MAX_RETAINED_TERMINALS);
    });
    setTerminalSessionId(terminal.sessionId);
    setTerminalOpen(true);
  };

  const releaseTerminal = (sessionId: string) => {
    setRetainedTerminals((current) =>
      current.filter((item) => item.sessionId !== sessionId),
    );
  };

  return {
    terminalOpen,
    setTerminalOpen,
    closeTerminal: close,
    terminalSessionId,
    retainedTerminals,
    releaseTerminal,
    terminalDrawerHeight,
    setTerminalDrawerHeight,
    toggleTerminal,
  };
}

/** Marks the selected session as seen so its unread completion cue clears. */
export function useMarkSessionSeen(live: RuntimeStoreSnapshot): void {
  const sessionId = live.runtime?.sessionId;
  useEffect(() => {
    if (sessionId) runtimeStore.markSessionSeen(sessionId);
  }, [sessionId]);
}
