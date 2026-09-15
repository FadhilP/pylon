import { useEffect, useRef, useState } from "react";
import { runtimeStore, type RuntimeStoreSnapshot } from "../runtime/event-store";
import type { TerminalProject } from "./terminal-project";
export type RetainedTerminal = {
  terminalId: string;
  projectId: string;
  title: string;
  sequence: number;
  launchLabel: string;
};

const MAX_RETAINED_TERMINALS = 8;

/**
 * Browser-page terminal state. Terminals stay mounted across project and session
 * navigation; only explicit shutdown removes one and tears down its PTY.
 */
export function useTerminalDrawer(initialHeight: () => number) {
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [activeTerminalId, setActiveTerminalId] = useState<string>();
  const [retainedTerminals, setRetainedTerminals] = useState<RetainedTerminal[]>([]);
  const terminalsRef = useRef<RetainedTerminal[]>([]);
  const activeTerminalRef = useRef<string | undefined>(undefined);
  const activateTerminal = (terminalId?: string) => {
    activeTerminalRef.current = terminalId;
    setActiveTerminalId(terminalId);
  };
  const [terminalDrawerHeight, setTerminalDrawerHeight] = useState(initialHeight);

  const createTerminal = (project: TerminalProject): boolean => {
    const current = terminalsRef.current;
    if (current.length >= MAX_RETAINED_TERMINALS) return false;
    const sequence = Math.max(0, ...current.filter(terminal => terminal.projectId === project.id).map(terminal => terminal.sequence)) + 1;
    const terminal: RetainedTerminal = {
      terminalId: crypto.randomUUID(),
      projectId: project.id,
      title: sequence === 1 ? project.label : `${project.label} ${sequence}`,
      sequence,
      launchLabel: project.cwd,
    };
    terminalsRef.current = [...current, terminal];
    setRetainedTerminals(terminalsRef.current);
    activateTerminal(terminal.terminalId);
    setTerminalOpen(true);
    return true;
  };

  const toggleTerminal = (project?: TerminalProject): boolean => {
    if (terminalOpen) {
      setTerminalOpen(false);
      return true;
    }
    const current = terminalsRef.current;
    const projectTerminal = project
      ? [...current].reverse().find(terminal => terminal.projectId === project.id)
      : undefined;
    const terminal = projectTerminal ?? current.find(item => item.terminalId === activeTerminalRef.current);
    if (terminal) {
      activateTerminal(terminal.terminalId);
      setTerminalOpen(true);
      return true;
    }
    if (project) return createTerminal(project);
    const fallback = current.at(-1);
    if (!fallback) return false;
    activateTerminal(fallback.terminalId);
    setTerminalOpen(true);
    return true;
  };

  const selectTerminal = (terminalId: string) => {
    if (!terminalsRef.current.some(terminal => terminal.terminalId === terminalId)) return;
    activateTerminal(terminalId);
    setTerminalOpen(true);
  };

  const releaseTerminal = (terminalId: string) => {
    const current = terminalsRef.current;
    const index = current.findIndex(terminal => terminal.terminalId === terminalId);
    if (index < 0) return;
    const next = current.filter(terminal => terminal.terminalId !== terminalId);
    terminalsRef.current = next;
    setRetainedTerminals(next);
    if (activeTerminalRef.current === terminalId) {
      const replacement = next[Math.min(index, next.length - 1)];
      activateTerminal(replacement?.terminalId);
      if (!replacement) setTerminalOpen(false);
    }
  };

  const releaseProject = (projectId: string) => {
    const current = terminalsRef.current;
    const active = current.find(terminal => terminal.terminalId === activeTerminalRef.current);
    const next = current.filter(terminal => terminal.projectId !== projectId);
    terminalsRef.current = next;
    setRetainedTerminals(next);
    if (active?.projectId === projectId) {
      const replacement = next.at(-1);
      activateTerminal(replacement?.terminalId);
      if (!replacement) setTerminalOpen(false);
    }
  };

  return {
    terminalOpen,
    setTerminalOpen,
    activeTerminalId,
    retainedTerminals,
    createTerminal,
    selectTerminal,
    releaseTerminal,
    releaseProject,
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
