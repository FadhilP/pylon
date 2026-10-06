import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

// Exercise the actual app handler without mounting the unrelated application UI.
const appSource = readFileSync(new URL("../src/client/app/app.tsx", import.meta.url), "utf8");
const handler = appSource.slice(appSource.indexOf("  const newSession ="), appSource.indexOf("  const deleteSession ="));
const handlerSource = stripTypeScriptTypes(`${handler}\nnewSession;`);

function setup(failCreation = false) {
  const savedDraft = { sessionId: "existing", projectId: "project", text: "unfinished work", updatedAt: 1 };
  const calls: string[] = [];
  const state = {
    Error,
    pendingSessionInFlight: { current: false },
    pendingSessionRequest: { current: 0 },
    pendingSessionDraft: { current: "" },
    pendingSessionSelection: { current: undefined },
    pendingSession: undefined as any,
    sessionBusy: "",
    sessionDeleting: "",
    projectBusy: "",
    mobile: false,
    live: { runtime: { sessionId: "current" } },
    composerDrafts: { latestForProject: () => savedDraft },
    runtimeStore: {
      switchSession: async (id: string) => {
        calls.push(`switch:${id}`);
      },
      newSession: async (id: string) => {
        calls.push(`create:${id}`);
        if (failCreation) throw new Error("creation failed");
        return 2;
      },
    },
    setWorkspaceView: () => {},
    setComposerFocusTarget: () => {},
    setSessionTransition: () => {},
    setSidebarOpen: () => {},
    setSessionBusy: (value: string) => {
      state.sessionBusy = value;
    },
    setPendingSession: (value: any) => {
      state.pendingSession = typeof value === "function" ? value(state.pendingSession) : value;
    },
  };
  const create = runInNewContext(handlerSource, state) as (project: { id: string }, retry?: boolean) => Promise<void>;
  return { state, calls, savedDraft, create };
}

test("New Session creates a fresh session even when the project has an existing draft", async () => {
  const { state, calls, savedDraft, create } = setup();
  await create({ id: "project" });

  assert.deepEqual(calls, ["create:project"]);
  assert.equal(state.pendingSessionDraft.current, "");
  assert.equal(savedDraft.text, "unfinished work");
  assert.equal(state.pendingSession.previousSessionId, "current");
  assert.equal(state.pendingSession.expectedGeneration, 2);
  assert.equal(state.pendingSessionInFlight.current, false);
});

test("retrying creation keeps text authored for the new session without opening an existing draft", async () => {
  const { state, calls, create } = setup(true);
  await create({ id: "project" });
  const requestId = state.pendingSession.requestId;
  assert.equal(state.pendingSession.phase, "failed");
  assert.equal(state.pendingSession.error, "creation failed");
  assert.equal(state.sessionBusy, "");

  state.pendingSessionDraft.current = "new work";
  state.runtimeStore.newSession = async (id: string) => {
    calls.push(`create:${id}`);
    return 3;
  };
  await create({ id: "project" }, true);

  assert.deepEqual(calls, ["create:project", "create:project"]);
  assert.equal(state.pendingSessionDraft.current, "new work");
  assert.equal(state.pendingSession.requestId, requestId);
  assert.equal(state.pendingSession.expectedGeneration, 3);
});
