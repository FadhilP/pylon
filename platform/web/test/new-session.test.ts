import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

// Exercise the actual app handler without mounting the unrelated application UI.
const appSource = readFileSync(new URL("../src/client/app/app.tsx", import.meta.url), "utf8");
const handler = appSource.slice(appSource.indexOf("  const newSession ="), appSource.indexOf("  const deleteSession ="));
const handlerSource = stripTypeScriptTypes(`${handler}\nnewSession;`);
const handoffStart = appSource.lastIndexOf("  useEffect(() => {", appSource.indexOf("if (!pendingSession || pendingSession.phase"));
const handoffEnd = appSource.indexOf("\n  }, [", handoffStart);
const handoffSource = stripTypeScriptTypes(`(() => {${appSource.slice(handoffStart + "  useEffect(() => {".length, handoffEnd)}})()`);

function setup(failCreation = false) {
  const savedDraft = { sessionId: "existing", projectId: "project", text: "unfinished work", updatedAt: 1 };
  const calls: string[] = [];
  const adoptedDrafts: { sessionId: string; text: string }[] = [];
  const state = {
    Error,
    document: { activeElement: null },
    HTMLTextAreaElement: class {},
    pendingSessionInFlight: { current: false },
    pendingSessionRequest: { current: 0 },
    pendingSessionDraft: { current: "" },
    pendingSessionSelection: { current: undefined },
    pendingSession: undefined as any,
    sessionBusy: "",
    sessionDeleting: "",
    projectBusy: "",
    mobile: false,
    live: { connection: "connected", runtime: { sessionId: "current", ready: true, sessionGeneration: 2 } },
    composerDrafts: {
      loadProject: async (_id: string) => {},
      textFor: (id: string) => id === savedDraft.sessionId ? savedDraft.text : undefined,
      adopt: (sessionId: string, _projectId: string, text: string) => { adoptedDrafts.push({ sessionId, text }); },
    },
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
  const handoff = () => runInNewContext(handoffSource, state);
  return { state, calls, savedDraft, adoptedDrafts, create, handoff };
}

test("New Session prepares a request without clearing an existing draft", async () => {
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

test("reusing the selected draft completes the transition and keeps its text", async () => {
  const { state, savedDraft, adoptedDrafts, create, handoff } = setup();
  state.live.runtime.sessionId = savedDraft.sessionId;
  await create({ id: "project" });
  handoff();

  assert.deepEqual(adoptedDrafts, [{ sessionId: savedDraft.sessionId, text: "unfinished work" }]);
  assert.equal(state.pendingSession, undefined);
  assert.equal(state.sessionBusy, "");
});

test("draft recovery finishes before creation and preserves text typed while preparing", async () => {
  const { state, calls, savedDraft, adoptedDrafts, create, handoff } = setup();
  let finish!: () => void;
  state.composerDrafts.loadProject = () => new Promise<void>(resolve => { finish = resolve; });
  const creating = create({ id: "project" });
  assert.deepEqual(calls, []);
  state.pendingSessionDraft.current = "new work";
  finish();
  await creating;
  state.live.runtime.sessionId = savedDraft.sessionId;
  handoff();

  assert.deepEqual(adoptedDrafts, [{ sessionId: savedDraft.sessionId, text: "unfinished work\n\nnew work" }]);
  assert.equal(state.pendingSession, undefined);
});

test("failed draft recovery does not create a session or clear pending text on retry", async () => {
  const { state, calls, create } = setup();
  state.composerDrafts.loadProject = async () => { throw new Error("recovery unavailable"); };
  await create({ id: "project" });
  assert.deepEqual(calls, []);
  assert.equal(state.pendingSession.error, "recovery unavailable");
  state.pendingSessionDraft.current = "keep this";
  state.composerDrafts.loadProject = async () => {};
  await create({ id: "project" }, true);
  assert.equal(state.pendingSessionDraft.current, "keep this");
  assert.deepEqual(calls, ["create:project"]);
});
