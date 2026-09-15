import test from "node:test";
import assert from "node:assert/strict";
import { terminalProjectForSelection, terminalProjectForSession } from "../src/client/terminal/terminal-project.ts";

const projects = [
  { id: "project-first", label: "First", cwd: "/projects/first" },
  { id: "project-selected", label: "Selected", cwd: "/projects/selected" },
];

const sessions = [
  { id: "session-first", projectId: "project-first" },
  { id: "session-selected", projectId: "project-selected" },
];

test("terminal launch follows the selected or fresh session project without falling back to the first project", () => {
  assert.equal(terminalProjectForSession("session-selected", sessions, projects), projects[1]);
  assert.equal(terminalProjectForSession("session-missing", sessions, projects), undefined);
  assert.equal(terminalProjectForSelection("fresh-session", sessions, projects, projects[1]), projects[1]);
  assert.equal(terminalProjectForSelection("fresh-session", sessions, projects, undefined, projects[1]), projects[1]);
  assert.equal(terminalProjectForSelection(undefined, sessions, projects), undefined);
});
