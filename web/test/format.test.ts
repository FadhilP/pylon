import test from "node:test";
import assert from "node:assert/strict";
import { formatCompactNumber, formatRelativeTime, formatWorkDuration } from "../src/shared/format.ts";
import { renderMarkdown } from "../src/shared/markdown.ts";

test("work duration uses compact Codex-style units", () => {
  assert.equal(formatWorkDuration(999), "0s");
  assert.equal(formatWorkDuration(15_900), "15s");
  assert.equal(formatWorkDuration(15 * 60_000 + 9_000), "15m 9s");
  assert.equal(formatWorkDuration(2 * 60 * 60_000 + 7 * 60_000), "2h 7m");
});

test("session activity uses compact relative units", () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-07-26T11:59:45.000Z", now), "now");
  assert.equal(formatRelativeTime("2026-07-26T11:45:00.000Z", now), "15m");
  assert.equal(formatRelativeTime("2026-07-26T08:00:00.000Z", now), "4h");
  assert.equal(formatRelativeTime("2026-07-21T12:00:00.000Z", now), "5d");
  assert.equal(formatRelativeTime("2026-06-26T12:00:00.000Z", now), "1mo");
  assert.equal(formatRelativeTime("invalid", now), "Unknown");
});

test("usage counters use compact readable units", () => {
  assert.equal(formatCompactNumber(999), "999");
  assert.equal(formatCompactNumber(1_000), "1K");
  assert.equal(formatCompactNumber(1_250_000), "1.3M");
  assert.equal(formatCompactNumber(3_000_000_000), "3B");
  assert.equal(formatCompactNumber(Number.NaN), "—");
});

test("Markdown code fences preserve and highlight supported languages", () => {
  const typescript = renderMarkdown("```ts\nconst answer: number = 42;\n```");
  assert.match(typescript, /data-language="ts"/);
  assert.match(typescript, /hljs-keyword/);
  assert.match(typescript, /hljs-number/);

  const unknown = renderMarkdown("```custom\n<script>alert('safe')</script>\n```");
  assert.match(unknown, /data-language="custom"/);
  assert.match(unknown, /&lt;script&gt;/);
});
