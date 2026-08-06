import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("earlier history preserves a stable transcript anchor", async () => {
  const source = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");

  assert.match(source, /!element\.classList\.contains\("history-loader"\)[\s\S]*?element\.getBoundingClientRect\(\)\.bottom > viewportTop/);
  assert.match(source, /function setTranscriptScrollTop[\s\S]*?scrollBehavior = "auto"[\s\S]*?stream\.scrollTop = scrollTop/);
  assert.match(source, /requestAnimationFrame\(\(\) => \{[\s\S]*?if \(preserveAnchor\)[\s\S]*?setTranscriptScrollTop[\s\S]*?finally \{\s*setHistoryLoading\(undefined\)/);
});

test("compaction history renders a dedicated collapsed disclosure", async () => {
  const source = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");

  assert.match(source, /if \(block\.compaction\) return <CompactionDisclosure/);
  assert.match(source, /<details className="compaction-disclosure">[\s\S]*?compaction-disclosure-chevron[\s\S]*?<strong>Context compacted<\/strong>/);
  assert.match(source, /when-closed">View compaction summary[\s\S]*?when-open">Hide compaction summary/);
  assert.match(source, /<dt>Context after<\/dt>[\s\S]*?contextAfterTokens/);
  assert.match(source, /sourceEntryCount !== undefined[\s\S]*?<dt>Source entries<\/dt>/);
  assert.match(source, /<MarkdownContent text=\{message\.text\} \/>/);
  assert.doesNotMatch(source, /<dt>Context before<\/dt>|<dt>Reduction<\/dt>|<dt>Reason<\/dt>/);
});

test("new sessions show an isolated drafting shell until the authoritative runtime is ready", async () => {
  const app = await readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");
  const store = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(app, /conversation:pending:\$\{pendingSession\.requestId\}/);
  assert.match(app, /pendingSessionInFlight\.current \|\| sessionBusy[\s\S]*?pendingSessionInFlight\.current = true/);
  assert.match(app, /runtime\.sessionGeneration !== pendingSession\.expectedGeneration[\s\S]*?composerDrafts\.current\.set\(runtime\.sessionId, draft\)[\s\S]*?document\.activeElement instanceof HTMLTextAreaElement[\s\S]*?selectionStart[\s\S]*?selectionEnd[\s\S]*?selectionDirection[\s\S]*?setComposerFocusTarget\(runtime\.sessionId\)[\s\S]*?setPendingSession[\s\S]*?setSessionBusy\(""\)/);
  assert.match(app, /restoreComposerFocus=\{composerFocusTarget === live\.runtime\?\.sessionId\}/);
  assert.match(app, /restoreComposerSelection=\{composerFocusTarget === live\.runtime\?\.sessionId \? pendingSessionSelection\.current : undefined\}/);
  assert.match(app, /onComposerFocusRestored=\{\(\) => \{[\s\S]*?pendingSessionSelection\.current = undefined;[\s\S]*?setComposerFocusTarget/);
  assert.match(app, /pendingSession\.expectedGeneration !== undefined[\s\S]*?composerDrafts\.current\.set\(runtime\.sessionId, draft\)/);
  assert.match(app, /phase: "failed", error/);
  assert.match(panel, /const runtime = draftingOnly \? undefined : live\.runtime/);
  assert.match(panel, /if \(!restoreComposerFocus\) return;[\s\S]*?if \(!prompt\) return;[\s\S]*?prompt\.focus\(\)[\s\S]*?Math\.min\(restoreComposerSelection\.start, prompt\.value\.length\)[\s\S]*?setSelectionRange\(start, end, restoreComposerSelection\.direction\)[\s\S]*?onComposerFocusRestored\?\.\(\)/);
  assert.match(panel, /<PendingSessionShell pending=\{pendingSession\}/);
  assert.match(panel, /if \(draftingOnly\) return;[\s\S]*?const activeSuggestions/);
  assert.match(panel, /if \(draftingOnly \|\| \(!value/);
  assert.match(panel, /placeholder=\{draftingOnly \? "Write your first prompt"/);
  assert.match(panel, /disabled=\{\(!connected && !draftingOnly\) \|\| submitting \|\| composerBlocked\}/);
  assert.match(panel, /onPaste=\{draftingOnly \? undefined/);
  assert.match(panel, /disabled=\{!connected \|\| composerBlocked \|\| submitting \|\| !hasDraft \|\| !controls\?\.model\}/);
  assert.match(panel, /Workspace setup failed[\s\S]*?Retry setup/);
  assert.match(store, /async newSession\([\s\S]*?Promise<number>[\s\S]*?return accepted\.sessionGeneration/);
  assert.match(styles, /\.pending-session-shell[\s\S]*?\.pending-session-progress[\s\S]*?\.pending-session-draft-note/);
  const newSession = app.slice(app.indexOf("const newSession"), app.indexOf("const deleteSession"));
  assert.doesNotMatch(newSession, /setRightPanel\(null\)/);
  assert.match(app, /workspace-layout[\s\S]*?pendingSession \? " is-session-pending"/);
  assert.match(app, /querySelector<HTMLElement>\(":scope > \.inspector"\)[\s\S]*?drawer\.inert = Boolean\(pendingSession\)/);
  assert.match(styles, /\.workspace-layout\.is-session-pending > \.inspector[\s\S]*?filter: blur\(1\.5px\)[\s\S]*?pointer-events: none/);
});

test("pending user messages use the approved unsent treatment and queue controls", async () => {
  const panel = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(panel, /pending\?\.state === "queued" \? " - pending"/);
  assert.match(panel, /className="pending-message-footer"[\s\S]*?Waiting to send[\s\S]*?Sending/);
  assert.match(panel, /pending-message-actions[\s\S]*?restoreQueued\(queued\)[\s\S]*?steerQueued\(queued\)/);
  assert.match(styles, /\.message-block\.is-queued \.conversation-message[\s\S]*?border: 1px dashed[\s\S]*?box-shadow: inset 3px 0 0/);
  assert.match(styles, /\.message-block\.is-sending \.conversation-message \{ opacity: \.72; \}/);
  assert.match(styles, /\.pending-message-footer[\s\S]*?\.pending-message-actions button/);
});

test("retry and compaction use the prominent shared transcript activity rail", async () => {
  const source = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");

  assert.match(source, /runtime\.conversation\.retry\.active && <TranscriptActivity[\s\S]*?kind="retry"[\s\S]*?maxAttempts=/);
  assert.match(source, /runtime\.conversation\.compaction\.active && <TranscriptActivity kind="compaction"/);
  assert.match(source, /className=\{`transcript-activity is-\$\{kind\}`\}[\s\S]*?role="status" aria-live="polite"/);
  assert.match(source, /Retrying model request[\s\S]*?The previous request failed temporarily/);
  assert.match(source, /Compacting context[\s\S]*?The conversation will continue automatically/);
  assert.doesNotMatch(source, /conversation-note transcript-note/);
});

test("spawned conversations reuse main-chat timing metadata without a child-working placeholder", async () => {
  const panel = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");
  const agents = await readFile(new URL("../src/client/agent-drawer.tsx", import.meta.url), "utf8");

  assert.match(panel, /export function WorkTimer/);
  assert.match(panel, /\{modelName && <> · \{modelName\}<\/>\}/);
  assert.match(panel, /\{thinkingLevel && <> · \{thinkingLabel\(thinkingLevel\)\}<\/>\}/);
  assert.match(agents, /import \{ MarkdownContent, WorkTimer \}/);
  assert.match(agents, /startedAt=\{turn\.status === "running" \? turn\.startedAt : undefined\}/);
  assert.match(agents, /modelName=\{turn\.modelName \? modelLabel\(turn\.modelName, models\) : undefined\}/);
  assert.doesNotMatch(agents, /Child is working/);
});

test("main and agent aggregate tool groups keep their icon and share the running scan", async () => {
  const panel = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");
  const agents = await readFile(new URL("../src/client/agent-drawer.tsx", import.meta.url), "utf8");
  const activity = await readFile(new URL("../src/shared/agent-activity.ts", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/client/styles.css", import.meta.url), "utf8");

  assert.match(panel, /const activeToolGroupId = running[\s\S]*?reverse\(\)\.find\(\(block\) => "tools" in block && !toolBlocksBeforeLaterPrompt\.has\(block\.id\)\)\?\.id/);
  assert.match(panel, /<ToolTurnGroup[^\n]*?running=\{block\.id === activeToolGroupId\}/);
  assert.match(panel, /function ToolTurnGroup\(\{ tools, running, onExpand \}/);
  assert.match(panel, /className=\{`tool-turn-group\$\{running \? " is-running" : ""\}`\}/);
  assert.match(panel, /summary=\{<>\s*<IconTool size=\{15\} \/>/);
  assert.match(agents, /className=\{`agent-tool-group is-\$\{toolStatus\}`\}/);
  assert.match(agents, /const toolStatus = run\.status === "running"\s*\? "running"/);
  assert.doesNotMatch(agents, /run\.status === "running" && tools\.some\(\(tool\) => !tool\.completed\)/);
  assert.match(activity, /tool\.id === item\.id/);
  assert.match(activity, /target\.completed = true/);
  assert.match(agents, /summary=\{<>\s*<IconTool size=\{15\} \/>/);
  assert.match(styles, /\.tool-turn-group\.is-running::before,[\s\S]*?\.agent-tool-group\.is-running::before/);
  assert.match(styles, /\.tool-turn-group\.is-running::after,[\s\S]*?\.agent-tool-group\.is-running::after/);
  assert.match(styles, /\.agent-tool-group > summary \{[^\n]*color: var\(--text-muted\)/);
  assert.match(styles, /\.agent-tool-group > summary strong \{ color: var\(--text-soft\)/);
  assert.match(styles, /animation: transcript-activity-scan 1\.5s/);
  assert.match(styles, /@keyframes transcript-activity-scan \{ from \{ transform: translateX\(0\); \} to \{ transform: translateX\(300%\); \} \}/);
  assert.match(styles, /prefers-reduced-motion: reduce[\s\S]*?\.agent-tool-group\.is-running::after[\s\S]*?animation: none !important/);
});
