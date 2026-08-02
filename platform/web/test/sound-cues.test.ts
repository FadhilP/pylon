import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { appendWebAudioCue, soundPattern } from "../src/shared/sound-cues.ts";

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

test("completion and attention sounds use distinct short patterns", () => {
  const completion = soundPattern("turn-complete");
  const attention = soundPattern("attention");

  assert.notDeepEqual(completion, attention);
  assert.ok(completion.every((tone) => tone.offset + tone.duration <= .5));
  assert.ok(attention.every((tone) => tone.offset + tone.duration <= .5));
});

test("first user gesture resumes audio even before a cue is pending", async () => {
  const source = await readFile(new URL("../src/client/web-audio.ts", import.meta.url), "utf8");
  assert.match(source, /function flush\(\): void \{\s*const audio = context;\s*if \(!audio\) return;[\s\S]*?if \(audio\.state !== "running"\)/);
  assert.doesNotMatch(source, /if \(!context \|\| !pending\.length\) return/);
});

test("closed audio contexts and scheduling failures remain recoverable", async () => {
  const source = await readFile(new URL("../src/client/web-audio.ts", import.meta.url), "utf8");
  assert.match(source, /if \(context && isClosed\(context\)\) resetContext\(context\)/);
  assert.match(source, /try \{ schedule\(audio, pending\[0\]!\); \}[\s\S]*?pending\.shift\(\)/);
  assert.match(source, /function isClosed\(audio: AudioContext\): boolean \{\s*return audio\.state === "closed"/);
  assert.match(source, /if \(isClosed\(audio\)\) resetContext\(audio\)/);
  assert.doesNotMatch(source, /unavailable/);
});

test("finished audio nodes disconnect after playback", async () => {
  const source = await readFile(new URL("../src/client/web-audio.ts", import.meta.url), "utf8");
  assert.match(source, /oscillator\.addEventListener\("ended", \(\) => \{\s*oscillator\.disconnect\(\);\s*gain\.disconnect\(\);\s*\}, \{ once: true \}\)/);
});

test("live cues drain by ID while bootstrap and reset clear stale cues", async () => {
  const [store, app] = await Promise.all([
    readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(store, /event\.type === "session\.status"[\s\S]*?audioCues: appendWebAudioCue\(current\.audioCues, event\)/);
  assert.match(store, /pendingUi: boot\.pendingUi[\s\S]*?audioCues: \[\]/);
  assert.match(store, /pendingUi: undefined,[^}]*audioCues: \[\]/s);
  assert.match(app, /enqueueWebAudioCues\(live\.audioCues\.map[^\n]*\n\s*runtimeStore\.consumeAudioCues/);
});
