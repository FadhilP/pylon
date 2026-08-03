import test from "node:test";
import assert from "node:assert/strict";
import { formatCacheHitRate, formatCompactNumber, formatRelativeTime, formatSessionActivity, formatWorkDuration, modelLabel } from "../src/shared/format.ts";
import { highlightSource, renderMarkdown } from "../src/shared/markdown.ts";

test("work duration uses compact Codex-style units", () => {
  assert.equal(formatWorkDuration(999), "0s");
  assert.equal(formatWorkDuration(15_900), "15s");
  assert.equal(formatWorkDuration(15 * 60_000 + 9_000), "15m 9s");
  assert.equal(formatWorkDuration(2 * 60 * 60_000 + 7 * 60_000), "2h 7m");
});

test("session activity uses compact relative units", () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  assert.equal(formatRelativeTime("2026-07-26T11:59:45.000Z", now), "<1m");
  assert.equal(formatRelativeTime("2026-07-26T11:45:00.000Z", now), "15m");
  assert.equal(formatRelativeTime("2026-07-26T08:00:00.000Z", now), "4h");
  assert.equal(formatRelativeTime("2026-07-21T12:00:00.000Z", now), "5d");
  assert.equal(formatRelativeTime("2026-06-26T12:00:00.000Z", now), "1mo");
  assert.equal(formatRelativeTime("invalid", now), "Unknown");
});

test("session activity shows current work before falling back to last activity", () => {
  const now = Date.parse("2026-07-26T12:00:00.000Z");
  assert.equal(formatSessionActivity("2026-07-26T11:45:00.000Z", "2026-07-26T11:57:51.000Z", now), "Working for 2m 9s");
  assert.equal(formatSessionActivity("2026-07-26T11:45:00.000Z", undefined, now), "15m ago");
  assert.equal(formatSessionActivity("invalid", "invalid", now), "Unknown");
});

test("usage counters use compact readable units", () => {
  assert.equal(formatCompactNumber(999), "999");
  assert.equal(formatCompactNumber(1_000), "1K");
  assert.equal(formatCompactNumber(1_250_000), "1.3M");
  assert.equal(formatCompactNumber(3_000_000_000), "3B");
  assert.equal(formatCompactNumber(Number.NaN), "—");
});

test("cache hit rate includes cache writes and handles empty usage", () => {
  assert.equal(formatCacheHitRate(120, 240, 60), "57.14%");
  assert.equal(formatCacheHitRate(0, 0, 0), "—");
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

test("file source highlighting uses extensions and explicit diff grammar", () => {
  assert.match(highlightSource("const value: number = 1;", "src/app.ts"), /hljs-keyword/);
  assert.match(highlightSource('{"ok": true}', "config.json"), /hljs-literal/);
  assert.match(highlightSource("class App { final int count = 1; }", "lib/app.dart"), /hljs-keyword/);
  assert.match(highlightSource("public class App { private int count = 1; }", "src/App.java"), /hljs-keyword/);
  assert.match(highlightSource("+added\n-removed", "src/app.ts", true), /hljs-addition/);
  assert.match(highlightSource("<script>", "unknown.custom"), /&lt;script&gt;/);
});

test("delegated model references use authenticated labels or readable fallbacks", () => {
  const models = [{ provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }];
  assert.equal(modelLabel("openai-codex/gpt-5.6-luna", models), "GPT-5.6 Luna");
  assert.equal(modelLabel("other/gpt-5.6-sol", []), "GPT-5.6 Sol");
});
