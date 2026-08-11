import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { showSessionRuntimeState } from "../src/shared/session-completions.ts";
import { listSessionsPreservingPages, SESSION_LIST_INITIAL_LIMIT } from "../src/shared/session-list.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { SessionListQuery, SessionListSnapshot, SessionProjectPage, SessionSummary } from "../src/shared/protocol/snapshots.ts";

function session(id: string, projectId: string): SessionSummary {
  return {
    id,
    projectId,
    cwdLabel: projectId,
    createdAt: "2025-01-01T00:00:00.000Z",
    modifiedAt: "2025-01-01T00:00:00.000Z",
    userMessageCount: 0,
    preview: id,
    active: false,
    pinned: false,
    runtimeState: "sleeping",
  };
}

function page(id: string, count: number, returned = count): SessionProjectPage {
  return {
    id,
    label: id,
    cwd: `/projects/${id}`,
    totalCount: count,
    sessions: Array.from({ length: returned }, (_, index) => session(`${id}-${index + 1}`, id)),
    ...(returned < count ? { nextCursor: String(returned) } : {}),
  };
}

function snapshot(projects: SessionProjectPage[]): SessionListSnapshot {
  return { protocolVersion: PROTOCOL_VERSION, sessionGeneration: 1, activeSessions: [], projects };
}

test("session list refresh preserves each loaded project page", async () => {
  const requests: SessionListQuery[] = [];
  const result = await listSessionsPreservingPages(async (input) => {
    requests.push(input);
    if (input.projectId === "expanded") return snapshot([page("expanded", 12, input.limit)]);
    return snapshot([page("expanded", 12, SESSION_LIST_INITIAL_LIMIT), page("initial", 9, SESSION_LIST_INITIAL_LIMIT)]);
  }, [page("expanded", 12, 8), page("initial", 9, SESSION_LIST_INITIAL_LIMIT)], "needle");

  assert.deepEqual(requests, [
    { query: "needle", limit: SESSION_LIST_INITIAL_LIMIT },
    { query: "needle", projectId: "expanded", limit: 8 },
  ]);
  assert.equal(result.projects[0]?.sessions.length, 8);
  assert.equal(result.projects[0]?.nextCursor, "8");
  assert.equal(result.projects[1]?.sessions.length, SESSION_LIST_INITIAL_LIMIT);
  assert.equal(result.projects[1]?.nextCursor, String(SESSION_LIST_INITIAL_LIMIT));
});

test("session list refresh drops expanded pages missing from fresh project list", async () => {
  const result = await listSessionsPreservingPages(async (input) => input.projectId
    ? snapshot([page("removed", 8, 8)])
    : snapshot([page("remaining", 2, 2)]), [page("removed", 8, 8)], "");

  assert.deepEqual(result.projects.map((project) => project.id), ["remaining"]);
});

test("expanded project sessions can collapse to the initial three", async () => {
  const [app, sidebar] = await Promise.all([
    readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/session-sidebar.tsx", import.meta.url), "utf8"),
  ]);
  const collapse = app.slice(app.indexOf("const showLessSessions"), app.indexOf("const archiveProject"));

  assert.match(collapse, /limit: SESSION_LIST_INITIAL_LIMIT/);
  assert.match(sidebar, /page\.sessions\.length > SESSION_LIST_INITIAL_LIMIT/);
  assert.match(sidebar, /onShowLess\(project\)/);
  assert.match(sidebar, /working \? 1_000 : 60_000/);
  assert.match(sidebar, /formatSessionActivity\(session\.modifiedAt, session\.workStartedAt, now\)/);
});

test("a completed sleeping session renders the new-response orb", async () => {
  const sidebar = await readFile(new URL("../src/client/session-sidebar.tsx", import.meta.url), "utf8");

  assert.equal(showSessionRuntimeState("sleeping", true), true);
  assert.equal(showSessionRuntimeState("sleeping", false), false);
  assert.match(sidebar, /showSessionRuntimeState\(session\.runtimeState, completed\) && <span/);
  assert.match(sidebar, /completed \? "is-complete"/);
  assert.match(sidebar, /completed \? "New response"/);
});


test("pin and activation updates do not show a current-session transition", async () => {
  const app = await readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const activation = app.slice(app.indexOf("const setSessionActive"), app.indexOf("const setSessionPinned"));
  const pinning = app.slice(app.indexOf("const setSessionPinned"), app.indexOf("const loadMoreSessions"));
  const switching = app.slice(app.indexOf("const switchSession"), app.indexOf("const deleteSession"));

  assert.doesNotMatch(activation, /setSessionTransition/);
  assert.doesNotMatch(pinning, /setSessionTransition/);
  assert.match(switching, /setSessionTransition\(!listedParentId \|\| live\.runtime\?\.sessionId !== listedParentId\)/);
  assert.match(app, /\{\(sessionTransition \|\| packageBusy\) && <div className="session-transition"/);
});
