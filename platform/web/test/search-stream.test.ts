import assert from "node:assert/strict";
import test from "node:test";
import { readSearchStream } from "../src/shared/workspace-search-stream.ts";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";

const result = {
  protocolVersion: PROTOCOL_VERSION,
  sessionGeneration: 3,
  engine: "rg",
  files: [
    {
      path: "a.ts",
      changed: false,
      capped: false,
      matches: [{ line: 1, text: "é😀hit", ranges: [{ start: 3, end: 6 }] }],
    },
  ],
  truncated: false,
  inventoryTruncated: false,
  skipped: 0,
  elapsedMs: 1,
  timedOut: false,
};

test("search stream handles split UTF8/JSON frames and closes its reader on completion", async () => {
  const wire = new TextEncoder().encode(
    `${JSON.stringify({ event: "update", result })}\n${JSON.stringify({ event: "done", result })}\n`,
  );
  let at = 0,
    cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at < wire.length) {
        controller.enqueue(wire.slice(at, at + 7));
        at += 7;
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  const updates: unknown[] = [];
  const actual = await readSearchStream(stream, 3, value => updates.push(value));
  assert.deepEqual(actual, result);
  assert.deepEqual(updates, [result]);
  assert.equal(cancelled, true);
});

test("stale results never reach callbacks and abandoned consumers cancel the search stream", async () => {
  let cancelled = 0;
  const stream = (generation: number) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({ event: "update", result: { ...result, sessionGeneration: generation } })}\n`,
          ),
        );
      },
      cancel() {
        cancelled++;
      },
    });
  let updates = 0;
  await assert.rejects(
    readSearchStream(stream(4), 3, () => {
      updates++;
    }),
    /stale/,
  );
  assert.equal(updates, 0);
  await assert.rejects(
    readSearchStream(stream(3), 3, () => {
      throw new Error("session changed");
    }),
    /session changed/,
  );
  assert.equal(cancelled, 2);
});
