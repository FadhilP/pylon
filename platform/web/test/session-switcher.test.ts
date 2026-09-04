import test from "node:test";
import assert from "node:assert/strict";
import { groupSessionSwitcherSessions } from "../src/shared/session-list.ts";
import type { SessionSummary } from "../src/shared/protocol/snapshots.ts";

function session(id: string, projectId: string, name: string, modifiedAt = "2026-01-01T00:00:00.000Z"): SessionSummary {
  return {
    id,
    projectId,
    name,
    cwdLabel: projectId,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt,
    userMessageCount: 1,
    preview: name,
    active: id === "current",
    pinned: false,
    runtimeState: "idle",
  };
}

test("composer session groups preserve catalog order, deduplicate active rows, and cap inactive rows", () => {
  const current = session("current", "pylon", "Current work");
  const running = session("running", "other", "Background work");
  const inactive = Array.from({ length: 6 }, (_, index) => session(`idle-${index}`, "pylon", `Idle ${index}`));

  const groups = groupSessionSwitcherSessions({
    activeSessions: [running, current],
    projects: [
      {
        id: "pylon",
        label: "Pylon",
        cwd: "/pylon",
        totalCount: 7,
        sessions: [current, ...inactive],
        nextCursor: "more",
      },
      {
        id: "other",
        label: "Other",
        cwd: "/other",
        totalCount: 1,
        sessions: [running],
      },
    ],
  });

  assert.deepEqual(groups.active.map(item => item.id), ["running", "current"]);
  assert.deepEqual(groups.inactive.map(item => item.id), inactive.slice(0, 5).map(item => item.id));
  assert.equal(groups.inactiveLimited, true);
});

test("composer session search prioritizes the current project, then sorts every other project by latest", () => {
  const alpha = session("alpha", "pylon", "Composer redesign");
  const beta = session("beta", "helios", "Browser retry", "2026-01-02T00:00:00.000Z");
  const gamma = session("gamma", "helios", "Capture retry", "2026-01-01T00:00:00.000Z");
  const currentProject = session("current-project", "pylon", "Policy retry", "2025-12-01T00:00:00.000Z");
  const newestOtherProject = session("newest-other", "atlas", "Index retry", "2026-01-03T00:00:00.000Z");
  const catalog = {
    activeSessions: [alpha],
    projects: [
      { id: "helios", label: "Helios", cwd: "/helios", totalCount: 2, sessions: [beta, gamma] },
      { id: "pylon", label: "Pylon", cwd: "/pylon", totalCount: 2, sessions: [alpha, currentProject] },
      { id: "atlas", label: "Atlas", cwd: "/atlas", totalCount: 1, sessions: [newestOtherProject] },
    ],
  };

  assert.deepEqual(groupSessionSwitcherSessions(catalog, "composer", "pylon").active.map(item => item.id), ["alpha"]);
  assert.deepEqual(groupSessionSwitcherSessions(catalog, "helios", "pylon").inactive.map(item => item.id), ["beta", "gamma"]);
  assert.deepEqual(groupSessionSwitcherSessions(catalog, "retry", "pylon").inactive.map(item => item.id), [
    "current-project",
    "newest-other",
    "beta",
    "gamma",
  ]);
  assert.equal(groupSessionSwitcherSessions(catalog, "retry", "pylon").inactiveLimited, false);
});
