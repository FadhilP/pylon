import test from "node:test";
import assert from "node:assert/strict";
import { appendWebAudioCue } from "../src/shared/sound-cues.ts";

test("live completion and approval events queue distinct sound cues without collapsing", () => {
  const completed = appendWebAudioCue([], { eventId: "end-1", sessionId: "selected", type: "agent.end", payload: {} });
  const queued = appendWebAudioCue(completed, { eventId: "request-1", sessionId: "selected", type: "ui.request", payload: { method: "confirm" } });

  assert.deepEqual(queued, [
    { id: "end-1", kind: "turn-complete" },
    { id: "request-1", kind: "attention" },
  ]);
});

test("background completion status queues one cue without duplicating selected completion", () => {
  const background = appendWebAudioCue([], {
    eventId: "background-complete",
    sessionId: "selected",
    type: "session.status",
    payload: { sessionId: "background", state: "idle", completed: true, cue: "turn-complete" },
  });

  assert.deepEqual(background, [{ id: "background-complete", kind: "turn-complete" }]);
  assert.equal(appendWebAudioCue(background, {
    eventId: "selected-complete",
    sessionId: "selected",
    type: "session.status",
    payload: { sessionId: "selected", state: "idle", completed: true },
  }), background);
});

test("background attention status queues one cue without duplicating selected requests", () => {
  const background = appendWebAudioCue([], {
    eventId: "background-attention",
    sessionId: "selected",
    type: "session.status",
    payload: { sessionId: "background", state: "attention", cue: "attention" },
  });

  assert.deepEqual(background, [{ id: "background-attention", kind: "attention" }]);
  assert.equal(appendWebAudioCue(background, {
    eventId: "selected-attention",
    sessionId: "selected",
    type: "session.status",
    payload: { sessionId: "selected", state: "attention" },
  }), background);
});

test("non-completion events stay silent", () => {
  const cues = [{ id: "existing", kind: "attention" as const }];
  assert.equal(appendWebAudioCue(cues, { eventId: "stopped", sessionId: "selected", type: "agent.end", payload: { stopped: true } }), cues);
  assert.equal(appendWebAudioCue(cues, { eventId: "retry", sessionId: "selected", type: "agent.end", payload: { willRetry: true } }), cues);
  assert.equal(appendWebAudioCue(cues, { eventId: "status", sessionId: "selected", type: "session.status", payload: { sessionId: "background", state: "idle", completed: true } }), cues);
  assert.equal(appendWebAudioCue(cues, { eventId: "start", sessionId: "selected", type: "agent.start", payload: {} }), cues);
});

