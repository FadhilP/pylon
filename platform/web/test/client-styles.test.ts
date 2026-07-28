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
  const [css, inspector, files, sidebar, conversation, app, eventStore] = await Promise.all([
    readFile(new URL("../src/client/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/client/inspector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/files-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/session-sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8"),
  ]);

  assert.match(css, /\.project-list\s*\{[^}]*scrollbar-width:\s*none/s);
  assert.match(css, /\.project-list::?-webkit-scrollbar\s*\{\s*display:\s*none/);
  assert.match(css, /\.project-toggle small\s*\{[^}]*opacity:\s*0/s);
  assert.match(css, /\.session-menu\.project-menu > summary\s*\{\s*opacity:\s*0/);
  assert.match(css, /\.project-row:focus-within \.project-menu > summary/);
  assert.match(css, /:root\[data-theme="dark"\] \.session-link strong\s*\{\s*color:\s*var\(--text-soft\)/);
  assert.match(css, /:root\[data-theme="dark"\] \.session-link\.is-active strong\s*\{\s*color:\s*var\(--text\)/);
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
  assert.match(files, /aria-label="Rebuild Discover index"/);
  assert.doesNotMatch(files, /aria-label="Refresh files"/);
  assert.match(files, /Session worktree/);
  assert.match(files, /Project folder/);
  assert.match(files, /Working copy/);
  assert.match(files, /Baseline/);
  assert.match(css, /\.files-index-bar\s*\{[^}]*grid-template-columns:/s);
  assert.doesNotMatch(css, /\.nav-label\s*\{[^}]*text-transform:\s*uppercase/s);
  assert.match(sidebar, /expanded \? <IconFolderOpen/);
  assert.doesNotMatch(sidebar, /IconStack2/);
  assert.match(inspector, /No verification run yet/);
  assert.match(inspector, /Verify is unavailable for this runtime/);
  assert.match(inspector, /className="mono">\{check\.label\}/);
  assert.match(inspector, /label="Guard timeout"/);
  assert.match(inspector, /label="Clarify timeout"/);
  assert.match(inspector, /Paused while the response tab is visible and focused/);
  assert.doesNotMatch(inspector, /<option value="automatic">/);
  assert.match(inspector, /<option value="local">Local<\/option>/);
  assert.match(conversation, /<IconPaperclip size=\{16\}/);
  assert.match(conversation, /<IconBulb size=\{16\}/);
  assert.match(conversation, /<IconLoader2 className="prompt-send-spinner"/);
  assert.match(conversation, /sending \? "Sending message"/);
  assert.match(conversation, /aria-label=\{stopping \? "Stopping response" : "Stop response"\}/);
  assert.match(conversation, /aria-busy=\{stopping\}/);
  assert.doesNotMatch(conversation, />Stopping…<\/span>/);
  assert.match(css, /\.prompt-send-spinner\s*\{\s*animation:\s*spin/);
  assert.match(css, /\.conversation-panel > \.ui-request-motion\s*\{/);
  assert.match(css, /\.ui-request-motion \+ \.prompt-form\s*\{\s*border-radius:/);
  assert.doesNotMatch(eventStore, /Unsupported runtime protocol/);
  assert.match(eventStore, /scheduleBootstrapRetry/);
  assert.match(app, /<RecoveryToast recovery=\{live\.recovery\}/);
});

test("inline runtime requests hide timers and manual ownership release", async () => {
  const [dialog, css] = await Promise.all([
    readFile(new URL("../src/client/ui-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/client/styles.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(dialog, /Let another tab respond|expiresAt|countdown/);
  assert.doesNotMatch(css, /ui-request-expiry|ui-transfer/);
  assert.match(dialog, /setInterval\(renew,\s*5_000\)/);
  assert.match(dialog, /document\.visibilityState !== "visible" \|\| !document\.hasFocus\(\)/);
});
