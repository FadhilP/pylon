export type TerminalProject = { id: string; label: string; cwd: string };

export function terminalProjectForSession(
  sessionId: string | undefined,
  sessions: readonly { id: string; projectId: string }[],
  projects: readonly TerminalProject[],
): TerminalProject | undefined {
  if (!sessionId) return;
  const projectId = sessions.find(session => session.id === sessionId)?.projectId;
  return projectId ? projects.find(project => project.id === projectId) : undefined;
}

export function terminalProjectForSelection(
  sessionId: string | undefined,
  sessions: readonly { id: string; projectId: string }[],
  projects: readonly TerminalProject[],
  pendingProject?: TerminalProject,
  rememberedProject?: TerminalProject,
): TerminalProject | undefined {
  return pendingProject ?? terminalProjectForSession(sessionId, sessions, projects) ?? rememberedProject;
}
