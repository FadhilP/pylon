import assert from "node:assert/strict";
import test from "node:test";
import { highlightSource, renderMarkdown } from "../src/shared/markdown.ts";
import {
  getSyntaxHighlightingRevision,
  setSyntaxTheme,
  startSyntaxHighlighting,
} from "../src/shared/syntax-highlighting.ts";

test("renders safe plain code before deferred highlighting loads, then upgrades it", async () => {
  const source = 'const tag = "<script>";';
  const before = renderMarkdown(`\`\`\`ts\n${source}\n\`\`\``);
  const sourceBefore = highlightSource(source, "example.ts");
  const revision = getSyntaxHighlightingRevision();

  assert.match(before, /&lt;script&gt;/);
  assert.doesNotMatch(before, /shiki-token-/);
  assert.match(sourceBefore, /&lt;script&gt;/);
  assert.doesNotMatch(sourceBefore, /shiki-token-/);

  await startSyntaxHighlighting();
  const after = renderMarkdown(`\`\`\`ts\n${source}\n\`\`\``);

  assert.ok(getSyntaxHighlightingRevision() > revision);
  assert.match(after, /<code class="language-ts" data-language="ts">/);
  assert.match(after, /class="shiki-token-[a-f0-9]+"/);
  assert.match(after, /&lt;script&gt;/);
  assert.doesNotMatch(after, /<script>/);
});

test("changes token output when the active syntax theme changes", () => {
  setSyntaxTheme("one-dark-pro");
  const dark = highlightSource("const value = 1", "example.ts");
  const revision = getSyntaxHighlightingRevision();
  setSyntaxTheme("github-light");
  const light = highlightSource("const value = 1", "example.ts");

  assert.match(dark, /shiki-token-/);
  assert.match(light, /shiki-token-/);
  assert.notEqual(light, dark);
  assert.ok(getSyntaxHighlightingRevision() > revision);
});

test("safely renders unsupported fenced and source languages without highlighting", () => {
  const markdown = renderMarkdown("```unknown\n<script>&\n```");
  const source = highlightSource("<script>\n&", "example.unknown");

  assert.match(markdown, /&lt;script&gt;&amp;/);
  assert.doesNotMatch(markdown, /shiki-token-/);
  assert.equal(source, "&lt;script&gt;\n&amp;");
});

test("preserves source lines and applies diff grammar when requested", () => {
  const html = highlightSource("+added\n-removed", "example.ts", true);

  assert.equal(html.split("\n").length, 2);
  assert.match(html, /^<span class="shiki-token-[a-f0-9]+">\+added<\/span>\n/);
  assert.match(html, /-removed<\/span>$/);
});

test("renders inline and display math across model and dollar delimiters", () => {
  const html = renderMarkdown(String.raw`\[
\text{rate}=\frac{\text{cacheRead}}{\text{uncachedInput}+\text{cacheRead}+\text{cacheWrite}}
\]

Inline \(x^2\) and $y_1$.

$$
z^3
$$`);

  assert.equal(html.match(/<math\b/g)?.length, 4);
  assert.equal(html.match(/display="block"/g)?.length, 2);
  assert.match(html, /<mfrac><mtext>cacheRead<\/mtext>/);
  assert.match(html, /<msup><mi>x<\/mi><mn>2<\/mn><\/msup>/);
  assert.match(html, /<msub><mi>y<\/mi><mn>1<\/mn><\/msub>/);
});

test("leaves currency, escaped delimiters, and code literal while preserving citations", () => {
  const html = renderMarkdown(
    [
      "Costs $5 and $10.",
      "Escaped \\$x\\$ and code `$y$`.",
      "",
      "```tex",
      "\\[z\\]",
      "```",
      "",
      "`src/file.ts:12` and \\(a+b\\).",
    ].join("\n"),
  );

  assert.equal(html.match(/<math\b/g)?.length, 1);
  assert.match(html, /Costs \$5 and \$10\./);
  assert.match(html, /Escaped \$x\$ and code <code>\$y\$<\/code>/);
  assert.match(html, /<pre><code class="language-tex" data-language="tex">\\\[z\\\]<\/code><\/pre>/);
  assert.match(html, /<a href="src\/file\.ts:12"><code>src\/file\.ts:12<\/code><\/a>/);
});

test("keeps incomplete math renderable and treats untrusted TeX commands as text", () => {
  const incomplete = renderMarkdown("\\[\n\\frac{a}{b}");
  const untrusted = renderMarkdown(String.raw`$\href{javascript:alert(1)}{x}$`);

  assert.doesNotMatch(incomplete, /<math\b/);
  assert.match(incomplete, /\\frac\{a\}\{b\}/);
  assert.match(untrusted, /<math\b/);
  assert.doesNotMatch(untrusted, /<a\b|href\s*=/);
});
