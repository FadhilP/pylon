import test from "node:test";
import assert from "node:assert/strict";
import { activeProjectId, buildSessionProjects, filterSessionProjects } from "../src/session-navigation.ts";
import type { SessionSummary } from "../src/shared/protocol/snapshots.ts";

function session(overrides: Partial<SessionSummary> & Pick<SessionSummary, "id" | "projectId" | "cwdLabel">): SessionSummary {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    userMessageCount: 1,
    preview: "",
    active: false,
    runtimeState: "sleeping",
    ...overrides,
  };
}

test("session navigation groups, orders, disambiguates, filters, and locates the active project", () => {
  const projects = buildSessionProjects([
    session({ id: "older", projectId: "project-a", cwdLabel: "Repo", name: "Older task" }),
    session({ id: "active", projectId: "project-b", cwdLabel: "Repo", preview: "Fix transport", active: true, modifiedAt: "2026-01-03T00:00:00.000Z" }),
    session({ id: "newer", projectId: "project-a", cwdLabel: "Repo", name: "Newer task", modifiedAt: "2026-01-02T00:00:00.000Z" }),
  ]);

  assert.deepEqual(projects.map((project) => project.label), ["Repo (1)", "Repo (2)"]);
  assert.deepEqual(projects[1]?.sessions.map((item) => item.id), ["newer", "older"]);
  assert.equal(activeProjectId(projects), "project-b");
  assert.deepEqual(filterSessionProjects(projects, "transport").map((project) => project.id), ["project-b"]);
  assert.deepEqual(filterSessionProjects(projects, "Repo (2)")[0]?.sessions.map((item) => item.id), ["newer", "older"]);
});
