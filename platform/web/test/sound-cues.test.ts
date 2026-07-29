import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { appendWebAudioCue, soundPattern } from "../src/shared/sound-cues.ts";

test("live completion and approval events queue distinct sound cues without collapsing", () => {
  const completed = appendWebAudioCue([], { eventId: "end-1", type: "agent.end", payload: {} });
  const queued = appendWebAudioCue(completed, { eventId: "request-1", type: "ui.request", payload: { method: "confirm" } });

  assert.deepEqual(queued, [
    { id: "end-1", kind: "turn-complete" },
    { id: "request-1", kind: "attention" },
  ]);
});

test("stopped and retrying turns stay silent", () => {
  const cues = [{ id: "existing", kind: "attention" as const }];
  assert.equal(appendWebAudioCue(cues, { eventId: "stopped", type: "agent.end", payload: { stopped: true } }), cues);
  assert.equal(appendWebAudioCue(cues, { eventId: "retry", type: "agent.end", payload: { willRetry: true } }), cues);
  assert.equal(appendWebAudioCue(cues, { eventId: "start", type: "agent.start", payload: {} }), cues);
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
  assert.match(source, /function flush\(\): void \{\s*if \(!context\) return;\s*if \(context\.state !== "running"\)/);
  assert.doesNotMatch(source, /if \(!context \|\| !pending\.length\) return/);
});

test("live cues drain by ID while bootstrap and reset clear stale cues", async () => {
  const [store, app] = await Promise.all([
    readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(store, /const audioCues = appendWebAudioCue\(current\.audioCues, event\)/);
  assert.match(store, /pendingUi: boot\.pendingUi[^\n]*audioCues: \[\]/);
  assert.match(store, /pendingUi: undefined,[^}]*audioCues: \[\]/s);
  assert.match(app, /enqueueWebAudioCues\(live\.audioCues\.map[^\n]*\n\s*runtimeStore\.consumeAudioCues/);
});
