import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("web typography never declares a font below 12px", async () => {
  const css = await readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const sizes = [...css.matchAll(/\bfont(?:-size)?:[^;{}]*?(\d+(?:\.\d+)?)px/g)]
    .map((match) => Number(match[1]));

  assert.ok(sizes.length > 0);
  assert.deepEqual(sizes.filter((size) => size < 12), []);
});

test("runtime policy, overview, and Files keep their compact native layout", async () => {
  const [css, inspector, files] = await Promise.all([
    readFile(new URL("../src/client/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/client/inspector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/files-panel.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(css, /\.project-list\s*\{[^}]*scrollbar-width:\s*none/s);
  assert.match(css, /\.project-list::?-webkit-scrollbar\s*\{\s*display:\s*none/);
  assert.match(css, /\.policy-checks label\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\)/s);
  assert.doesNotMatch(inspector, /Apply policy|Selected checks<\/option>|Automatic detection<\/option>/);

  const overview = inspector.slice(inspector.indexOf("function Overview"), inspector.indexOf("function RuntimePolicy"));
  const sections = ["Usage", "Current run", "Verification", "HeartbeatJobs"];
  for (let index = 1; index < sections.length; index++) {
    assert.ok(
      overview.indexOf(sections[index - 1]!) < overview.indexOf(sections[index]!),
      `${sections[index - 1]} should render before ${sections[index]}`,
    );
  }
  assert.doesNotMatch(overview, /RuntimePolicy|DiscoverIndex|File index/);

  const tabs = ['id: "overview"', 'id: "policy"', 'id: "timeline"', 'id: "memory"', 'id: "tools"'];
  for (let index = 1; index < tabs.length; index++) {
    assert.ok(inspector.indexOf(tabs[index - 1]!) < inspector.indexOf(tabs[index]!));
  }
  assert.match(files, /runtime\?\.discoverIndex && <DiscoverIndexBar live=\{live\}/);
  assert.match(files, /aria-label="Discover index"/);
  assert.match(css, /\.files-index-bar\s*\{[^}]*grid-template-columns:/s);
});
