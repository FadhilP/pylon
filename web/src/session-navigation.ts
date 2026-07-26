import type { SessionSummary } from "./shared/protocol/snapshots.ts";

export interface SessionProject {
  id: string;
  label: string;
  sessions: SessionSummary[];
  active: boolean;
}

export function sessionTitle(session: SessionSummary): string {
  return session.name || session.preview || "Untitled session";
}

export function buildSessionProjects(sessions: SessionSummary[]): SessionProject[] {
  const grouped = new Map<string, SessionProject>();
  const orderedSessions = [...sessions].sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));

  for (const session of orderedSessions) {
    const project = grouped.get(session.projectId);
    if (project) {
      project.sessions.push(session);
      project.active ||= session.active;
      continue;
    }
    grouped.set(session.projectId, {
      id: session.projectId,
      label: session.cwdLabel || "Workspace",
      sessions: [session],
      active: session.active,
    });
  }

  const projects = [...grouped.values()];
  const labelCounts = new Map<string, number>();
  for (const project of projects) labelCounts.set(project.label, (labelCounts.get(project.label) ?? 0) + 1);

  const labelIndexes = new Map<string, number>();
  return projects.map((project) => {
    if ((labelCounts.get(project.label) ?? 0) === 1) return project;
    const index = (labelIndexes.get(project.label) ?? 0) + 1;
    labelIndexes.set(project.label, index);
    return { ...project, label: `${project.label} (${index})` };
  });
}

export function filterSessionProjects(projects: SessionProject[], query: string): SessionProject[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return projects;

  return projects.flatMap((project) => {
    if (project.label.toLowerCase().includes(normalized)) return [project];
    const sessions = project.sessions.filter((session) =>
      `${sessionTitle(session)} ${session.preview}`.toLowerCase().includes(normalized));
    return sessions.length ? [{ ...project, sessions }] : [];
  });
}

export function activeProjectId(projects: SessionProject[]): string | undefined {
  return projects.find((project) => project.active)?.id;
}
