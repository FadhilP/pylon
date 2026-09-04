import test from "node:test";
import assert from "node:assert/strict";
import { CheckpointBrowser, type CheckpointBrowserResult } from "../src/checkpoint-browser.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;

const items = [
  {
    id: "first",
    title: "Initial checkpoint",
    createdAt: "2026-02-18T10:00:00Z",
    status: "[branch:main]",
    branch: "main",
  },
  {
    id: "second",
    title: "Retry budget",
    createdAt: "2026-02-18T11:04:22Z",
    status: "[branch:main]",
    branch: "main",
    changes: { fileCount: 3, additions: 48, deletions: 11 },
  },
];

test("checkpoint browser filters before returning the selected restore action", () => {
  let result: CheckpointBrowserResult | undefined;
  let renders = 0;
  const browser = new CheckpointBrowser(
    items,
    theme,
    () => renders++,
    value => {
      result = value;
    },
  );

  browser.handleInput("/");
  for (const character of "retry") browser.handleInput(character);
  browser.handleInput("\r");
  browser.handleInput("f");

  assert.deepEqual(result, { id: "second", mode: "fork" });
  assert.ok(renders >= 2, "filter input requests immediate rerenders");
});

test("checkpoint browser cancellation never selects a checkpoint", () => {
  let completed = false;
  let result: CheckpointBrowserResult | undefined = { id: "first", mode: "jump" };
  const browser = new CheckpointBrowser(
    items,
    theme,
    () => {},
    value => {
      completed = true;
      result = value;
    },
  );

  browser.handleInput("\x1b");

  assert.equal(completed, true);
  assert.equal(result, undefined);
});
