import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("earlier history preserves a stable transcript anchor", async () => {
  const source = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");

  assert.match(source, /!element\.classList\.contains\("history-loader"\)[\s\S]*?element\.getBoundingClientRect\(\)\.bottom > viewportTop/);
  assert.match(source, /function setTranscriptScrollTop[\s\S]*?scrollBehavior = "auto"[\s\S]*?stream\.scrollTop = scrollTop/);
  assert.match(source, /requestAnimationFrame\(\(\) => \{[\s\S]*?if \(preserveAnchor\)[\s\S]*?setTranscriptScrollTop[\s\S]*?finally \{\s*setHistoryLoading\(undefined\)/);
});

test("compaction history opens summary-first details in the right panel", async () => {
  const source = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../src/client/compaction-panel.tsx", import.meta.url), "utf8");

  assert.match(source, /if \(block\.compaction\) return <CompactionDisclosure[\s\S]*?onOpen=\{onOpenCompaction\}/);
  assert.match(source, /<button className="compaction-disclosure" type="button" onClick=\{\(\) => onOpen\(message\)\}>[\s\S]*?<strong>Context compacted<\/strong>[\s\S]*?View details/);
  assert.doesNotMatch(source.slice(source.indexOf("function CompactionDisclosure"), source.indexOf("function SystemDisclosure")), /<details|compaction\.display|MarkdownContent/);

  assert.match(app, /RightPanel = [^;]*"compaction"/);
  assert.match(app, /onOpenCompaction=\{\(message\) => \{[\s\S]*?setSelectedCompaction\(\{ sessionId, message \}\)[\s\S]*?setRightPanel\("compaction"\)/);
  assert.match(app, /rightPanel === "compaction"[\s\S]*?<CompactionPanel[\s\S]*?message=\{selectedCompaction\.message\}/);
  assert.match(app, /setSelectedCompaction\(undefined\)[\s\S]*?current === "compaction" \? null : current/);

  assert.match(panel, /<aside id="compaction-panel" className="inspector compaction-panel is-open"[\s\S]*?Compaction details/);
  assert.match(panel, /contextBeforeTokens !== undefined[\s\S]*?<dt>Context before<\/dt>/);
  assert.match(panel, /<dt>Context after<\/dt>[\s\S]*?contextAfterTokens/);
  assert.match(panel, /sourceEntryCount !== undefined[\s\S]*?<dt>Source entries<\/dt>/);
  const summary = panel.indexOf("<MarkdownContent text={message.text} />");
  const sources = panel.indexOf("<h2 id=\"compaction-sources-title\">Available source details</h2>");
  assert.ok(summary >= 0 && sources > summary);
  assert.match(panel, /display\.records\.map\(\(record, index\)[\s\S]*?<pre>\{record\.text\}<\/pre>/);
  assert.match(panel, /title="Failed tool calls" records=\{display\.failedTools\} failed/);
  assert.match(panel, /title="Tool results" records=\{display\.toolResults\}/);
  assert.match(panel, /history\.modified[\s\S]*?history\.read[\s\S]*?Observed file activity/);
  assert.match(panel, /hasSourceDetails[\s\S]*?hasMetadata/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML|Raw JSON/);
});

test("new sessions show an isolated drafting shell until the authoritative runtime is ready", async () => {
  const app = await readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");
  const store = await readFile(new URL("../src/client/runtime/event-store.ts", import.meta.url), "utf8");

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
  const newSession = app.slice(app.indexOf("const newSession"), app.indexOf("const deleteSession"));
  assert.doesNotMatch(newSession, /setRightPanel\(null\)/);
  assert.match(app, /workspace-layout[\s\S]*?pendingSession \? " is-session-pending"/);
  assert.match(app, /querySelector<HTMLElement>\(":scope > \.inspector"\)[\s\S]*?drawer\.inert = Boolean\(pendingSession\)/);
});

test("active Continuity planning remains visible after the one-shot composer mode resets", async () => {
  const panel = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");

  assert.match(panel, /continuityPlanning = runtime\?\.operational\.continuity\.work\?\.mode === "planning"/);
  assert.match(panel, /continuityPlanning && <span className="continuity-planning-indicator" role="status" aria-live="polite">[\s\S]*?Planning<\/span>/);
  assert.match(panel, /setPlanMode\(false\)/);
});

test("pending user messages expose queue controls", async () => {
  const panel = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");

  assert.match(panel, /pending\?\.state === "queued" \? " - pending"/);
  assert.match(panel, /className="pending-message-footer"[\s\S]*?Waiting to send[\s\S]*?Sending/);
  assert.match(panel, /pending-message-actions[\s\S]*?restoreQueued\(queued\)[\s\S]*?steerQueued\(queued\)/);
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

test("main and agent aggregate tool groups keep their icon and running state", async () => {
  const panel = await readFile(new URL("../src/client/conversation-panel.tsx", import.meta.url), "utf8");
  const agents = await readFile(new URL("../src/client/agent-drawer.tsx", import.meta.url), "utf8");
  const activity = await readFile(new URL("../src/shared/agent-activity.ts", import.meta.url), "utf8");

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
});
