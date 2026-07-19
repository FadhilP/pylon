import test from "node:test";
import assert from "node:assert/strict";
import { REPO_SCOUT_PROMPT, WEB_SCOUT_PROMPT } from "../src/prompts.ts";
import { capText, SCOUT_REPORT_MAX_BYTES } from "../src/result.ts";

test("repo scout prompt preserves core contracts", () => {
  assert.match(REPO_SCOUT_PROMPT, /path:start-end/);
  assert.match(REPO_SCOUT_PROMPT, /search_excerpt/i);
  assert.match(REPO_SCOUT_PROMPT, /at most 8 lines/i);
  assert.match(REPO_SCOUT_PROMPT, /Keep the report compact/i);
  assert.match(REPO_SCOUT_PROMPT, /Stop immediately when the task is evidenced/i);
  assert.match(REPO_SCOUT_PROMPT, /every additional tool call must resolve a named evidence gap/i);
  assert.doesNotMatch(REPO_SCOUT_PROMPT, /KiB|hard cap|soft target/i);
  assert.match(REPO_SCOUT_PROMPT, /Do not edit/i);
  assert.match(REPO_SCOUT_PROMPT, /parent model decides/i);
  assert.match(REPO_SCOUT_PROMPT, /do not repeat evidence/i);
  assert.doesNotMatch(REPO_SCOUT_PROMPT, /no fixed turn cap/i);
});

test("Scout report cap is hard and reports omission", () => {
  const result = capText("x".repeat(SCOUT_REPORT_MAX_BYTES * 2), SCOUT_REPORT_MAX_BYTES);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= SCOUT_REPORT_MAX_BYTES);
  assert.match(result.text, /omitted content/i);
});

test("web scout prompt preserves public read-only evidence contract", () => {
  assert.match(WEB_SCOUT_PROMPT, /scout_browser only/);
  assert.match(WEB_SCOUT_PROMPT, /navigate, snapshot, follow, and back/);
  assert.match(WEB_SCOUT_PROMPT, /Never attempt login/);
  assert.match(WEB_SCOUT_PROMPT, /source URL/);
  assert.match(WEB_SCOUT_PROMPT, /untrusted data/);
});
