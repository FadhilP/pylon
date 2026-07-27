import assert from "node:assert/strict";
import test from "node:test";
import { PROTOCOL_VERSION } from "../src/shared/protocol/envelope.ts";
import type { WorkspaceFilePage } from "../src/shared/protocol/snapshots.ts";
import { drainWorkspaceFiles } from "../src/shared/workspace-file-pages.ts";

test("workspace file pages drain, deduplicate, batch, and report truncation", async () => {
  const pages: WorkspaceFilePage[] = Array.from({ length: 6 }, (_, page) => ({
    protocolVersion: PROTOCOL_VERSION,
    sessionGeneration: 1,
    revision: "revision",
    files: Array.from({ length: 200 }, (_, index) => ({ path: `src/${page * 200 + index}.ts` })),
    totalCount: 1_200,
    truncated: page === 5,
    ...(page < 5 ? { nextCursor: String(page + 1) } : {}),
  }));
  pages[5]!.files[0] = pages[0]!.files[0]!;
  const batches: number[] = [];
  const progress: Array<[number, number]> = [];
  let truncated = false;
  const files = await drainWorkspaceFiles(
    (cursor) => Promise.resolve(pages[Number(cursor ?? 0)]!),
    new AbortController().signal,
    (items, value) => {
      batches.push(items.length);
      truncated = value;
    },
    (loaded, total) => progress.push([loaded, total]),
  );
  assert.deepEqual(batches, [1_000, 1_199]);
  assert.equal(files.length, 1_199);
  assert.equal(truncated, true);
  assert.deepEqual(progress.at(-1), [1_199, 1_200]);
});

test("workspace file page draining stops when its request is stale", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    drainWorkspaceFiles(() => Promise.reject(new Error("should not fetch")), controller.signal, () => {}),
    { name: "AbortError" },
  );
});
