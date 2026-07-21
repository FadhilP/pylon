import test from "node:test";
import assert from "node:assert/strict";
import { REPO_SCOUT_PROMPT, WEB_SCOUT_PROMPT } from "../src/prompts.ts";
import { capReport, mergeEvidenceAnchors, SCOUT_REPORT_MAX_BYTES, structuredClaims } from "../src/result.ts";

test("repo scout prompt preserves core contracts", () => {
  assert.match(REPO_SCOUT_PROMPT, /path:start-end/);
  assert.match(REPO_SCOUT_PROMPT, /search_excerpt/i);
  assert.match(REPO_SCOUT_PROMPT, /at most 8 lines/i);
  assert.match(REPO_SCOUT_PROMPT, /Keep the report compact/i);
  assert.match(REPO_SCOUT_PROMPT, /retained or omitted whole/i);
  assert.match(REPO_SCOUT_PROMPT, /Stop immediately when the task is evidenced/i);
  assert.match(REPO_SCOUT_PROMPT, /every additional tool call must resolve a named evidence gap/i);
  assert.doesNotMatch(REPO_SCOUT_PROMPT, /KiB|hard cap|soft target/i);
  assert.match(REPO_SCOUT_PROMPT, /Do not edit/i);
  assert.match(REPO_SCOUT_PROMPT, /parent model decides/i);
  assert.match(REPO_SCOUT_PROMPT, /do not repeat evidence/i);
  assert.doesNotMatch(REPO_SCOUT_PROMPT, /no fixed turn cap/i);
});

test("Scout report cap keeps complete blocks and reports omission", () => {
  const first = `## Findings\n\n- first complete finding\n  path.ts:1-2\n  excerpt`;
  const oversized = `- oversized finding\n  packages/core/src/large.ts:40-55\n${"x".repeat(SCOUT_REPORT_MAX_BYTES)}`;
  const later = `## Gaps\n\n- later complete gap`;
  const result = capReport(`${first}\n\n${oversized}\n\n${later}`, SCOUT_REPORT_MAX_BYTES);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text) <= SCOUT_REPORT_MAX_BYTES);
  assert.match(result.text, /first complete finding/);
  assert.match(result.text, /later complete gap/);
  assert.doesNotMatch(result.text, /oversized finding/);
  assert.match(result.text, /Omitted content: 1 complete report block/i);
  assert.match(result.text, /packages\/core\/src\/large\.ts:40-55/);
  assert.deepEqual(result.omittedEvidence, [{ path: "packages/core/src/large.ts", start: 40, end: 55 }]);
});

test("Scout removes exact duplicate report blocks before capping", () => {
  const block = "- repeated finding\n  src/a.ts:1-2";
  const result = capReport(`${block}\n\n${block}`, SCOUT_REPORT_MAX_BYTES);
  assert.equal(result.text, block);
  assert.equal(result.deduplicatedBlocks, 1);
  assert.ok(result.deduplicatedBytes > 0);
});

test("Scout report cap respects tiny and UTF-8 byte budgets", () => {
  for (const maxBytes of [0, 1, 8, 64])
    assert.ok(Buffer.byteLength(capReport("é".repeat(100), maxBytes).text, "utf8") <= maxBytes);
});

test("Scout merges overlapping citations and exposes deduplicated lightweight claims", () => {
  assert.deepEqual(mergeEvidenceAnchors([
    { path: "src/a.ts", start: 10, end: 20 },
    { path: "src/b.ts", start: 1, end: 2 },
    { path: "src/a.ts", start: 21, end: 30 },
    { path: "src/a.ts", start: 5, end: 12 },
    { path: "src/a.ts", start: 300, end: 399 },
    { path: "src/a.ts", start: 400, end: 499 },
  ]), [
    { path: "src/a.ts", start: 5, end: 30 },
    { path: "src/a.ts", start: 300, end: 499 },
    { path: "src/b.ts", start: 1, end: 2 },
  ]);
  const oversizedChain = [
    { path: "src/a.ts", start: 150, end: 250 },
    { path: "src/a.ts", start: 1, end: 100 },
    { path: "src/a.ts", start: 90, end: 160 },
  ];
  const expectedChunks = [
    { path: "src/a.ts", start: 1, end: 200 },
    { path: "src/a.ts", start: 201, end: 250 },
  ];
  assert.deepEqual(mergeEvidenceAnchors(oversizedChain), expectedChunks);
  assert.deepEqual(mergeEvidenceAnchors([...oversizedChain].reverse()), expectedChunks);
  assert.deepEqual(structuredClaims("## Findings\n\n- Auth check is shared. `src/a.ts:10-20`\n\n- Auth check is shared. `src/a.ts:10-20`\n\n```ts\nconst ignored = true;\n```\n\n## Gaps\n\n- Caller remains unknown."), [
    { section: "findings", claim: "Auth check is shared. `src/a.ts:10-20`", citations: [{ path: "src/a.ts", start: 10, end: 20 }] },
    { section: "gaps", claim: "Caller remains unknown.", citations: [] },
  ]);
});

test("Scout omission anchors reject unsafe and malformed paths", () => {
  const oversized = [
    "- omitted",
    "  ../secret.ts:1-2",
    "  C:\\secret.ts:3-4",
    "  https://example.com:5-6",
    "  safe/file.ts:9-7",
    "  safe/file.ts:10-12",
    "  " + "x".repeat(SCOUT_REPORT_MAX_BYTES),
  ].join("\n");
  const result = capReport(`kept\n\n${oversized}`, SCOUT_REPORT_MAX_BYTES);
  assert.deepEqual(result.omittedEvidence, [{ path: "safe/file.ts", start: 10, end: 12 }]);
});

test("web scout prompt preserves public read-only evidence contract", () => {
  assert.match(WEB_SCOUT_PROMPT, /scout_browser only/);
  assert.match(WEB_SCOUT_PROMPT, /navigate, snapshot, follow, and back/);
  assert.match(WEB_SCOUT_PROMPT, /Never attempt login/);
  assert.match(WEB_SCOUT_PROMPT, /source URL/);
  assert.match(WEB_SCOUT_PROMPT, /untrusted data/);
});
