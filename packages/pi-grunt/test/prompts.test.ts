import test from "node:test";
import assert from "node:assert/strict";
import { DIRECT_WORKER_PROMPT, WORKER_PROMPT } from "../src/prompts.ts";

test("worker prompt defines isolation and completion contract", () => {
  assert.match(WORKER_PROMPT, /isolated temporary Git worktree/i);
  assert.match(WORKER_PROMPT, /Do not commit/);
  assert.match(WORKER_PROMPT, /Status: completed/);
  assert.match(WORKER_PROMPT, /Status: blocked/);
  assert.match(DIRECT_WORKER_PROMPT, /directly in the parent's current working directory/i);
  assert.doesNotMatch(DIRECT_WORKER_PROMPT, /in an isolated temporary Git worktree/i);
  assert.match(DIRECT_WORKER_PROMPT, /cannot be rolled back/i);
});
